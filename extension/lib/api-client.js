(function initApiClient(global) {
  const STATUS_VALUES = new Set(['watching', 'completed']);

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

  global.AniRekoApiClient = { create };
})(typeof globalThis !== 'undefined' ? globalThis : self);
