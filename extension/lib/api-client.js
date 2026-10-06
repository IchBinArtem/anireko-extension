(function initApiClient(global) {
  const STATUS_VALUES = new Set(['watching', 'completed']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const TOKEN = /^[0-9a-f]{64}$/;
  const historyInt = (value, max = 2147483647, min = 1) => Number.isSafeInteger(value) && value >= min && value <= max;
  function historyFields(input, required, optional = []) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || required.some((key) => !Object.hasOwn(input, key))
      || Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))) {
      throw new Error('payload_invalid');
    }
  }
  function historyPayload(action, input) {
    const owner = ['expected_user_id'];
    if (action === 'history-initialize') {
      historyFields(input, owner);
      if (!historyInt(input.expected_user_id)) throw new Error('payload_invalid');
      return { operation: 'initialize', ...input };
    }
    const identity = [...owner, 'history_id', 'anime_id', 'expected_effective_anime_id', 'command_id'];
    if (action === 'history-select') {
      historyFields(input, [...identity, 'cycle_id', 'reconciliation_token'], ['choices']);
      if (!TOKEN.test(input.reconciliation_token) || typeof input.reconciliation_token !== 'string'
        || (input.cycle_id !== null && (typeof input.cycle_id !== 'string' || !UUID.test(input.cycle_id)))) throw new Error('payload_invalid');
      if (Object.hasOwn(input, 'choices')) {
        if (!Array.isArray(input.choices)) throw new Error('payload_invalid');
        for (const choice of input.choices) {
          historyFields(choice, ['history_id', 'anime_id', 'cycle_id']);
          if (!historyInt(choice.anime_id) || typeof choice.history_id !== 'string' || !UUID.test(choice.history_id)
            || typeof choice.cycle_id !== 'string' || !UUID.test(choice.cycle_id)) throw new Error('payload_invalid');
        }
      }
    } else {
      const kind = input?.command;
      if (!['start', 'progress', 'complete', 'cancel', 'pause', 'resume'].includes(kind)) throw new Error('payload_invalid');
      const fields = [...identity, 'expected_foreground_generation', 'expected_version', 'command'];
      if (kind !== 'start') fields.push('cycle_id');
      if (kind === 'progress' || kind === 'complete') fields.push('episode', 'position_sec', 'duration_sec', 'voice');
      historyFields(input, fields);
      if (!historyInt(input.expected_version, 9007199254740990, 0)
        || !historyInt(input.expected_foreground_generation, 9007199254740990, 0)
        || (kind !== 'start' && (typeof input.cycle_id !== 'string' || !UUID.test(input.cycle_id)))) throw new Error('payload_invalid');
      if (kind === 'progress' || kind === 'complete') {
        if ((input.episode !== null && !historyInt(input.episode, 5000))
          || !historyInt(input.position_sec, 259200, 0)
          || (input.duration_sec !== null && !historyInt(input.duration_sec, 259200))
          || (input.voice !== null && (typeof input.voice !== 'string' || Array.from(input.voice).length > 100))) throw new Error('payload_invalid');
      }
    }
    if (!historyInt(input.expected_user_id) || !historyInt(input.anime_id) || !historyInt(input.expected_effective_anime_id)
      || typeof input.history_id !== 'string' || !UUID.test(input.history_id)
      || typeof input.command_id !== 'string' || !UUID.test(input.command_id)) throw new Error('payload_invalid');
    return { operation: action === 'history-select' ? 'select' : 'command', ...input };
  }
  function historyPage(page) {
    historyFields(page, [], ['limit', 'after_anime_id', 'after_history_id', 'snapshot_token', 'selected_cycle_id', 'after_evidence', 'after_legacy', 'after_cycle', 'after_choice']);
    const has = (key) => Object.hasOwn(page, key);
    if ((has('limit') && !historyInt(page.limit, 100))
      || (has('snapshot_token') && (typeof page.snapshot_token !== 'string' || !TOKEN.test(page.snapshot_token)))
      || (has('selected_cycle_id') && (typeof page.selected_cycle_id !== 'string' || !UUID.test(page.selected_cycle_id)))) throw new Error('payload_invalid');
    if (has('after_anime_id') || has('after_history_id')) {
      if (!historyInt(page.after_anime_id) || typeof page.after_history_id !== 'string'
        || !UUID.test(page.after_history_id) || !has('snapshot_token')) throw new Error('payload_invalid');
    }
    const result = {};
    for (const key of ['limit', 'after_anime_id', 'after_history_id', 'snapshot_token', 'selected_cycle_id']) {
      if (has(key)) result[key] = page[key];
    }
    for (const key of ['after_cycle', 'after_evidence', 'after_legacy', 'after_choice']) {
      if (!has(key)) continue;
      if (!has('snapshot_token')) throw new Error('payload_invalid');
      const fields = key === 'after_choice' ? ['effective_anime_id', 'anime_id', 'history_id', 'cycle_id']
        : key === 'after_cycle' ? ['anime_id', 'history_id', 'cycle_id']
        : key === 'after_evidence' ? ['anime_id', 'history_id', 'evidence_kind'] : ['anime_id', 'evidence_kind'];
      const cursor = page[key];
      historyFields(cursor, fields);
      if (!historyInt(cursor.anime_id)
        || (fields.includes('effective_anime_id') && !historyInt(cursor.effective_anime_id))
        || (fields.includes('history_id') && (typeof cursor.history_id !== 'string' || !UUID.test(cursor.history_id)))
        || (fields.includes('cycle_id') && (typeof cursor.cycle_id !== 'string' || !UUID.test(cursor.cycle_id)))
        || (fields.includes('evidence_kind') && !['watchlist', 'legacy_rating'].includes(cursor.evidence_kind))) throw new Error('payload_invalid');
      result[key] = Object.fromEntries(fields.map((field) => [field, cursor[field]]));
    }
    return result;
  }

  function positiveInt(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function safeBase(value) {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('invalid_api_base');
    }
    return url.origin;
  }

  function create(options) {
    const base = safeBase(options?.baseUrl);
    const fetchImpl = options?.fetchImpl || global.fetch.bind(global);

    async function request(action, input = {}) {
      let path;
      let init = { credentials: 'include', cache: 'no-store' };
      switch (action) {
        case 'history-read': {
          historyFields(input, ['anime_id', 'expected_user_id'], ['page']);
          if (!historyInt(input.anime_id) || !historyInt(input.expected_user_id)) throw new Error('payload_invalid');
          const query = new URLSearchParams({ anime_id: String(input.anime_id), expected_user_id: String(input.expected_user_id) });
          if (Object.hasOwn(input, 'page')) {
            const page = JSON.stringify(historyPage(input.page));
            if (new TextEncoder().encode(page).length > 4096) throw new Error('payload_invalid');
            query.set('page', page);
          }
          path = `/api/extension/history.php?${query}`;
          break;
        }
        case 'history-initialize':
        case 'history-command':
        case 'history-select': {
          const body = JSON.stringify(historyPayload(action, input));
          if (new TextEncoder().encode(body).length > 65536) throw new Error('payload_invalid');
          path = '/api/extension/history.php';
          init = { ...init, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Anireko-Watch-History': '1' }, body };
          break;
        }
        case 'history-settle': {
          historyFields(input, ['action', 'request', 'current_user_id']);
          if (!['history-command', 'history-select'].includes(input.action)
            || !historyInt(input.current_user_id)) throw new Error('payload_invalid');
          // Keep the original owner, UUID, CAS and field order. Only the operation
          // changes; the cookie-authorized current owner is a separate header.
          const payload = historyPayload(input.action, input.request);
          payload.operation = 'settle';
          const body = JSON.stringify(payload);
          if (new TextEncoder().encode(body).length > 65536) throw new Error('payload_invalid');
          path = '/api/extension/history.php';
          init = { ...init, method: 'POST', headers: {
            'Content-Type': 'application/json',
            'X-Anireko-Watch-History': '1',
            'X-Anireko-Watch-Expected-User': String(input.current_user_id),
          }, body };
          break;
        }
        case 'session-info':
          path = '/api/auth/session-info.php';
          break;
        case 'search': {
          const query = String(input.query || '').trim();
          if (query.length < 2 || query.length > 180) throw new Error('payload_invalid');
          const limit = Math.max(1, Math.min(20, Number(input.limit) || 5));
          path = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&exact_alias=1`;
          init.headers = { 'Accept-Language': 'ru' };
          init.credentials = 'omit';
          break;
        }
        case 'taste-match': {
          const animeId = positiveInt(input.animeId);
          if (animeId === null) throw new Error('payload_invalid');
          path = `/api/anime/${animeId}/match`;
          init.headers = { 'Accept-Language': 'ru' };
          break;
        }
        case 'status-get': {
          const animeId = positiveInt(input.animeId);
          if (animeId === null) throw new Error('payload_invalid');
          path = `/api/anime/status.php?anime_id=${animeId}`;
          break;
        }
        case 'status-write': {
          const animeId = positiveInt(input.animeId);
          const expectedUserId = positiveInt(input.expectedUserId);
          if (animeId === null || expectedUserId === null || !STATUS_VALUES.has(input.status)) {
            throw new Error('payload_invalid');
          }
          path = '/api/anime/status.php';
          init = {
            ...init,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              anime_id: animeId,
              status: input.status,
              expected_user_id: expectedUserId,
            }),
          };
          break;
        }
        case 'progress-write': {
          const animeId = positiveInt(input.animeId);
          const expectedUserId = positiveInt(input.expectedUserId);
          const episode = input.episode == null ? null : positiveInt(input.episode);
          const position = Number(input.positionSec);
          const duration = Number(input.durationSec);
          const voice = String(input.voice || '').trim().slice(0, 100);
          if (animeId === null || expectedUserId === null
            || (input.episode != null && episode === null)
            || !Number.isFinite(position) || position < 0
            || !Number.isFinite(duration) || duration < 300) {
            throw new Error('payload_invalid');
          }
          path = '/api/extension/progress.php';
          init = {
            ...init,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              anime_id: animeId,
              episode,
              position_sec: Math.round(position),
              duration_sec: Math.round(duration),
              voice,
              expected_user_id: expectedUserId,
            }),
          };
          break;
        }
        case 'progress-all': {
          const expectedUserId = positiveInt(input.expectedUserId);
          if (expectedUserId === null) throw new Error('payload_invalid');
          path = `/api/extension/progress.php?all=1&expected_user_id=${expectedUserId}`;
          break;
        }
        case 'diagnostic': {
          const payload = input.payload;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || JSON.stringify(payload).length > 20_000) {
            throw new Error('payload_invalid');
          }
          path = '/api/extension/diagnostic.php';
          init = {
            ...init,
            credentials: 'omit',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          };
          break;
        }
        default:
          throw new Error('endpoint_not_allowed');
      }
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(action === 'session-info' ? 5000 : 10000),
      });
      const payload = response.status === 204 ? null : await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, payload };
    }

    return Object.freeze({ base, request });
  }

  // Pure admission uses exactly the wire validator, before any storage/network await.
  function historyIntent(action, input) {
    if (!['history-command', 'history-select'].includes(action)) throw new Error('payload_invalid');
    const payload = historyPayload(action, input);
    const encoded = JSON.stringify(payload);
    if (new TextEncoder().encode(encoded).length > 65536) throw new Error('payload_invalid');
    const copy = JSON.parse(encoded);
    delete copy.operation;
    return copy;
  }
  global.AniRekoApiClient = { create, historyIntent };
})(typeof globalThis !== 'undefined' ? globalThis : self);
