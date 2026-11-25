(function initWatchCommandJournal(global) {
  const KEY = 'watch-command-pending-v1';
  const MAX_BYTES = 70000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const HASH = /^[0-9a-f]{64}$/;
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
    const hasLineage = binding && Object.hasOwn(binding, 'media_lineage');
    const hasContext = binding && Object.hasOwn(binding, 'top_context');
    exact(binding, ['document_id', 'navigation_token', 'revision',
      ...(hasLineage ? ['media_lineage'] : []), ...(hasContext ? ['top_context'] : [])]);
    for (const key of ['document_id', 'navigation_token']) {
      if (typeof binding[key] !== 'string' || !binding[key] || binding[key].length > 256)
        throw new Error('journal_invalid');
    }
    if (!Number.isSafeInteger(binding.revision) || binding.revision < 0) throw new Error('journal_invalid');
    const record = { version: 1, action,
      request: global.AniRekoApiClient.historyIntent(action, request), binding: clone(binding), acknowledged: false };
    if (hasLineage && (typeof binding.media_lineage !== 'string' || !HASH.test(binding.media_lineage)
      || action !== 'history-command' || record.request.command !== 'complete')) throw new Error('journal_invalid');
    if (hasContext && (typeof binding.top_context !== 'string' || !HASH.test(binding.top_context)
      || action !== 'history-command' || record.request.command !== 'complete')) throw new Error('journal_invalid');
    if (new TextEncoder().encode(JSON.stringify(record)).length > MAX_BYTES) throw new Error('journal_full');
    return freeze(record);
  }
  function storedRecord(value) {
    exact(value, value?.version === 2
      ? ['version', 'action', 'request', 'binding', 'acknowledged', 'terminalOutcome']
      : ['version', 'action', 'request', 'binding', 'acknowledged']);
    if (![1, 2].includes(value.version) || typeof value.acknowledged !== 'boolean') throw new Error('journal_invalid');
    const normalized = capture(value.action, value.request, value.binding);
    // Reject malformed persisted bytes; never repair or evict an unresolved intent.
    if (JSON.stringify(normalized.request) !== JSON.stringify(value.request)) throw new Error('journal_invalid');
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) throw new Error('journal_full');
    if (value.version === 2 && !proofShape(value.terminalOutcome, normalized)) throw new Error('journal_invalid');
    return { ...clone(normalized), version: value.version, acknowledged: value.acknowledged,
      ...(value.version === 2 ? { terminalOutcome: clone(value.terminalOutcome) } : {}) };
  }
  function proofShape(proof, record) {
    try {
      exact(proof, ['settlement_version', 'outcome', 'current_user_id', 'history_id', 'anime_id',
        'command_id', 'original_operation', 'command_kind', 'request_hash']);
    } catch { return false; }
    const request = record.request;
    return proof.settlement_version === 1 && ['accepted', 'not_applied'].includes(proof.outcome)
      && id(proof.current_user_id) && proof.history_id === request.history_id
      && proof.anime_id === request.anime_id && proof.command_id === request.command_id
      && proof.original_operation === (record.action === 'history-command' ? 'command' : 'select')
      && proof.command_kind === (record.action === 'history-command' ? request.command : 'select')
      && typeof proof.request_hash === 'string' && HASH.test(proof.request_hash);
  }
  async function proofMatches(proof, record) {
    if (!proofShape(proof, record)) return false;
    if (typeof global.AniRekoWatchRequestHash?.hash !== 'function') throw new Error('history_hash_unavailable');
    return proof.request_hash === await global.AniRekoWatchRequestHash.hash(record.action, record.request);
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
    async function authorizedAccount(userId, expectedEpoch) {
      current(expectedEpoch);
      if (!id(userId) || await authorize(userId) !== true)
        throw new Error('journal_account_changed');
      current(expectedEpoch);
    }
    async function account(record, userId, expectedEpoch) {
      if (userId !== record.request.expected_user_id) throw new Error('journal_account_changed');
      await authorizedAccount(userId, expectedEpoch);
    }
    async function terminalAccount(record, userId, expectedEpoch) {
      if (record.terminalOutcome.current_user_id !== userId) throw new Error('journal_account_changed');
      if (!await proofMatches(record.terminalOutcome, record)) throw new Error('journal_invalid');
      current(expectedEpoch);
      await authorizedAccount(userId, expectedEpoch);
    }
    return Object.freeze({
      // Capture is synchronous. Caller must capture the event BEFORE any async gate.
      capture(action, request, binding) {
        const intent = capture(action, request, binding);
        captures.set(intent, epoch);
        return intent;
      },
      pending() { return serial(async () => { const value = await read(); return value && freeze(clone(value)); }); },
      admit(intent, mediaLineage, topContext) {
        const captured = storedRecord(intent);
        if (captured.version !== 1 || captured.acknowledged) throw new Error('journal_invalid');
        if (mediaLineage !== undefined) {
          captured.binding.media_lineage = mediaLineage;
        }
        if (topContext !== undefined) captured.binding.top_context = topContext;
        storedRecord(captured);
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
      // UUID/body/CAS never change, including event-driven recovery.
      deliver(userId) {
        const admittedEpoch = epoch;
        return serial(async () => {
          current(admittedEpoch);
          const record = await read();
          if (!record) throw new Error('journal_empty');
          if (record.version === 2) {
            await terminalAccount(record, userId, admittedEpoch);
            return { acknowledged: record.acknowledged, settled: true };
          }
          await account(record, userId, admittedEpoch);
          if (record.acknowledged) return { acknowledged: true };
          const response = await client.request(record.action, clone(record.request), clone(record.binding));
          current(admittedEpoch);
          const payload = response?.payload;
          // A lost prior settlement ACK can make exact replay return the
          // already-stored not-applied fence. Only an exact hashed fence may
          // request the owner-bound settlement proof; never infer it from 409.
          if (response?.ok === true && response.status === 200 && payload?.outcome === 'not_applied') {
            const fenceFields = ['settlement_version', 'outcome', 'history_id', 'anime_id',
              'command_id', 'original_operation', 'command_kind', 'request_hash'];
            try { exact(payload, fenceFields); } catch { return { acknowledged: false, response }; }
            if (await proofMatches({ ...payload, current_user_id: userId }, record)) return { fenced: true };
            return { acknowledged: false, response };
          }
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
      // Proves the original outcome; it neither retries the writer nor publishes history.
      settle(userId) {
        const admittedEpoch = epoch;
        return serial(async () => {
          current(admittedEpoch);
          const record = await read();
          if (!record) throw new Error('journal_empty');
          await authorizedAccount(userId, admittedEpoch);
          if (record.version === 2 && !await proofMatches(record.terminalOutcome, record)) {
            throw new Error('journal_invalid');
          }
          current(admittedEpoch);
          if (record.version === 2 && record.terminalOutcome.current_user_id === userId) {
            await terminalAccount(record, userId, admittedEpoch);
            return { settled: true, outcome: record.terminalOutcome.outcome };
          }
          // Validate that this exact original intent is hashable before egress.
          if (typeof global.AniRekoWatchRequestHash?.hash !== 'function') throw new Error('history_hash_unavailable');
          const requestHash = await global.AniRekoWatchRequestHash.hash(record.action, record.request);
          current(admittedEpoch);
          const response = await client.request('history-settle', {
            action: record.action, request: clone(record.request), current_user_id: userId,
          });
          current(admittedEpoch);
          const proof = response?.payload;
          if (response?.ok !== true || response.status !== 200 || !proofShape(proof, record)
            || proof.current_user_id !== userId || proof.request_hash !== requestHash) {
            return { settled: false, response };
          }
          const updated = storedRecord({ ...record, version: 2, terminalOutcome: clone(proof) });
          await storage.set({ [KEY]: updated });
          current(admittedEpoch);
          return { settled: true, outcome: proof.outcome };
        });
      },
      refresh(userId, beforeRelease) {
        const admittedEpoch = epoch;
        return serial(async () => {
          current(admittedEpoch);
          const record = await read();
          if (!record || (!record.acknowledged && record.version !== 2)) throw new Error('journal_unresolved');
          if (record.version === 2) await terminalAccount(record, userId, admittedEpoch);
          else await account(record, userId, admittedEpoch);
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
          if (beforeRelease) await beforeRelease(freeze(clone(record)));
          current(admittedEpoch);
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
