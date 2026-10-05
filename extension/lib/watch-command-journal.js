(function initWatchCommandJournal(global) {
  const KEY = 'watch-command-pending-v1';
  const MAX_BYTES = 70000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const id = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
  const version = (value) => Number.isSafeInteger(value) && value >= 0;
  function foreground(value) {
    return value && id(value.anime_id) && version(value.generation)
      && (value.cycle_id === null || (typeof value.cycle_id === 'string' && UUID.test(value.cycle_id)));
  }
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  function exact(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length
      || fields.some((key) => !Object.hasOwn(value, key))) throw new Error('journal_invalid');
  }
  function capture(action, request, binding) {
    exact(binding, ['document_id', 'navigation_token', 'revision']);
    for (const key of ['document_id', 'navigation_token']) {
      if (typeof binding[key] !== 'string' || !binding[key] || binding[key].length > 256)
        throw new Error('journal_invalid');
    }
    if (!Number.isSafeInteger(binding.revision) || binding.revision < 0) throw new Error('journal_invalid');
    const record = { version: 1, action,
      request: global.AniRekoApiClient.historyIntent(action, request), binding: clone(binding), acknowledged: false };
    if (new TextEncoder().encode(JSON.stringify(record)).length > MAX_BYTES) throw new Error('journal_full');
    return freeze(record);
  }
  function storedRecord(value) {
    exact(value, ['version', 'action', 'request', 'binding', 'acknowledged']);
    if (value.version !== 1 || typeof value.acknowledged !== 'boolean') throw new Error('journal_invalid');
    const normalized = capture(value.action, value.request, value.binding);
    // Reject malformed persisted bytes; never repair or evict an unresolved intent.
    if (JSON.stringify(normalized.request) !== JSON.stringify(value.request)) throw new Error('journal_invalid');
    return { ...clone(normalized), acknowledged: value.acknowledged };
  }
  function create({ storage, client, authorize }) {
    let queue = Promise.resolve();
    let epoch = 0;
    let closed = false;
    const captures = new WeakMap();
    function serial(fn) {
      const next = queue.catch(() => {}).then(fn);
      queue = next;
      return next;
    }
    function current(expectedEpoch) {
      if (closed || epoch !== expectedEpoch) throw new Error('journal_binding_changed');
    }
    async function read() {
      const data = await storage.get(KEY);
      return Object.hasOwn(data, KEY) ? storedRecord(data[KEY]) : null;
    }
    async function account(record, userId, expectedEpoch) {
      current(expectedEpoch);
      if (userId !== record.request.expected_user_id || await authorize(userId) !== true)
        throw new Error('journal_account_changed');
      current(expectedEpoch);
    }
    return Object.freeze({
      // Capture is synchronous. Caller must capture the event BEFORE any async gate.
      capture(action, request, binding) {
        const intent = capture(action, request, binding);
        captures.set(intent, epoch);
        return intent;
      },
      pending() { return serial(async () => { const value = await read(); return value && freeze(clone(value)); }); },
      admit(intent) {
        const captured = storedRecord(intent);
        if (captured.acknowledged) throw new Error('journal_invalid');
        const admittedEpoch = captures.get(intent);
        current(admittedEpoch);
        return serial(async () => {
          current(admittedEpoch);
          const existing = await read();
          current(admittedEpoch);
          if (existing) throw new Error('journal_full');
          await storage.set({ [KEY]: captured });
          current(admittedEpoch);
          return freeze(clone(captured));
        });
      },
      // Explicit retry only; UUID/body/CAS never change. No startup replay/timer.
      deliver(userId) {
        const admittedEpoch = epoch;
        return serial(async () => {
          current(admittedEpoch);
          const record = await read();
          if (!record) throw new Error('journal_empty');
          await account(record, userId, admittedEpoch);
          if (record.acknowledged) return { acknowledged: true };
          const response = await client.request(record.action, clone(record.request));
          current(admittedEpoch);
          const payload = response?.payload;
          const resultIds = record.request.command === 'start'
            ? [record.request.anime_id, record.request.expected_effective_anime_id] : [record.request.anime_id];
          if (response?.ok !== true || response.status !== 200
            || payload?.history_id !== record.request.history_id
            || !id(payload.anime_id) || !foreground(payload.foreground)
            || payload.foreground.anime_id !== record.request.expected_effective_anime_id
            || (record.action === 'history-command'
              ? !resultIds.includes(payload.anime_id) || payload.state?.anime_id !== payload.anime_id || !version(payload.state.version)
              : payload.snapshot?.user_id !== userId || !foreground(payload.snapshot.foreground))) {
            return { acknowledged: false, response };
          }
          await storage.set({ [KEY]: { ...record, acknowledged: true } });
          current(admittedEpoch);
          // The historical receipt is deliberately NOT published as current state.
          return { acknowledged: true };
        });
      },
      refresh(userId) {
        const admittedEpoch = epoch;
        return serial(async () => {
          current(admittedEpoch);
          const record = await read();
          if (!record?.acknowledged) throw new Error('journal_unresolved');
          await account(record, userId, admittedEpoch);
          const response = await client.request('history-read', {
            anime_id: record.request.anime_id, expected_user_id: userId,
          });
          current(admittedEpoch);
          const value = response?.payload;
          if (response?.ok !== true || response.status !== 200 || value?.user_id !== userId
            || value.requested_anime_id !== record.request.anime_id
            || typeof value.history_adopted !== 'boolean'
            || !id(value.effective_anime_id) || !foreground(value.foreground)
            || !['ready', 'reconciliation_required'].includes(value.readiness)) {
            return { refreshed: false, response };
          }
          await storage.remove(KEY);
          current(admittedEpoch);
          // Caller still verifies foreground/document/revision before event admission.
          return { refreshed: true, snapshot: value };
        });
      },
      invalidate() { epoch++; },
      closeAndClear() {
        closed = true;
        epoch++;
        // Drain previously started storage writes before deletion. Server COMMIT
        // may already have happened; clearing local data does not claim cancellation.
        return serial(() => storage.remove(KEY));
      },
    });
  }
  global.AniRekoWatchCommandJournal = Object.freeze({ create, capture, key: KEY });
})(typeof globalThis !== 'undefined' ? globalThis : self);
