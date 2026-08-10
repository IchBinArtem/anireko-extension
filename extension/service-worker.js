importScripts(
  'lib/runtime-config.js',
  'lib/api-client.js',
  'lib/trust.js',
  'lib/auto-mark.js'
);

const apiClient = AniRekoApiClient.create({
  baseUrl: AniRekoRuntimeConfig.apiBase,
  fetchImpl: fetch.bind(globalThis),
});

const stateByTab = {};
const tabQueues = {};
const tabStateFlushAt = {};
let historyQueue = Promise.resolve();
const progressSyncQueues = new WeakMap();

// --- Server-load hardening (KAN-2695) ---
// Search mapping is cached globally: one /api/search call per unique title,
// shared across tabs/sessions. Errors trigger exponential backoff so a broken
// API is never hammered.
const SEARCH_CACHE_KEY = 'search-cache';
const SEARCH_CACHE_MAX = 200;
// v7 invalidates explicit-season misses cached while the exact-alias backend
// contract was unavailable. v6 added season matching; v5 normalized numbers.
const SEARCH_CACHE_VERSION = 7;
const SEARCH_TTL_OK_MS = 7 * 24 * 3600 * 1000;
const SEARCH_TTL_MISS_MS = 24 * 3600 * 1000;
const SEARCH_TTL_PARTIAL_MS = 5 * 60 * 1000;
const searchInFlight = new Map();
let searchFailCount = 0;
let searchBackoffUntil = 0;

// History writes are debounced: full-object rewrite of watch-history on every
// 5s tick was the hottest local path. Non-timeupdate events flush immediately.
const HISTORY_FLUSH_INTERVAL_MS = 15000;
let historyCache = null;
let historyLastFlushAt = 0;

const autoMarkedInSession = new Set();
const autoMarkInFlight = new Set();
const autoMarkRetryAt = {};
const completionMetadataRefreshedInSession = new Set();
const completionMetadataRefreshInFlight = new Set();
const completionMetadataRefreshRetryAt = {};
const SYNC_ACCOUNT_KEY = 'sync-account';
const PRIVACY_CONSENT_KEY = 'privacy-consent';
const PRIVACY_CONSENT_VERSION = 1;
const MANUAL_MATCH_BINDINGS_KEY = 'manual-match-bindings';
const MANUAL_MATCH_BINDINGS_VERSION = 2;
const MANUAL_MATCH_BINDINGS_MAX = 200;
let manualMatchBindingsQueue = Promise.resolve();

async function privacyConsentAccepted() {
  const stored = await chrome.storage.local.get(PRIVACY_CONSENT_KEY);
  const consent = stored[PRIVACY_CONSENT_KEY];
  return consent?.version === PRIVACY_CONSENT_VERSION && Number.isFinite(consent.acceptedAt);
}

async function disableTab(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'anireko-disable-detector' }); } catch { /* no script */ }
  delete stateByTab[String(tabId)];
  delete tabQueues[String(tabId)];
  delete tabStateFlushAt[String(tabId)];
  await chrome.storage.session.remove(`tab:${tabId}`);
}

async function authorizedDocument(messageContext) {
  if (!await privacyConsentAccepted()) return false;
  return /^https?:\/\//.test(messageContext.origin)
    && /^https?:\/\//.test(messageContext.topOrigin);
}

chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => {});
chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => {});

// Sync is deliberately bound to one immutable AniReko user id. A site login
// in the same Chrome profile replaces the host cookie globally; without this
// guard an enabled extension would silently start writing into the newly
// logged-in account (e.g. a support/demo account). Every mutating sync checks
// the live cookie session, and the server compares expected_user_id again to
// close the race between this check and the write.
const SESSION_INFO_TTL_MS = 60_000;
let sessionInfoCache = null;
let sessionInfoExpiresAt = 0;
let sessionInfoInFlight = null;

function sessionIdentityKey(result) {
  const userId = Number(result?.payload?.user?.id);
  return result?.ok && result?.payload?.success && Number.isInteger(userId) && userId > 0
    ? `user:${userId}`
    : 'guest';
}

function noteSessionIdentity(result) {
  const nextKey = sessionIdentityKey(result);
  const previousKey = sessionInfoCache ? sessionIdentityKey(sessionInfoCache) : null;
  sessionInfoCache = result;
  sessionInfoExpiresAt = Date.now() + SESSION_INFO_TTL_MS;
  if (previousKey !== null && previousKey !== nextKey) {
    tasteCache.clear();
    tasteInFlight.clear();
    for (const state of Object.values(stateByTab)) {
      state.taste = null;
    }
  }
  return result;
}

async function currentSessionInfo(force = false) {
  if (!force && sessionInfoCache && Date.now() < sessionInfoExpiresAt) return sessionInfoCache;
  if (sessionInfoInFlight) return sessionInfoInFlight;
  sessionInfoInFlight = apiClient.request('session-info')
    .then(noteSessionIdentity)
    .catch(() => noteSessionIdentity({ ok: false, status: 503, payload: null }))
    .finally(() => { sessionInfoInFlight = null; });
  return sessionInfoInFlight;
}

async function activeSyncAccount() {
  if (!await privacyConsentAccepted()) return null;
  const stored = await chrome.storage.local.get(['auto-mark', SYNC_ACCOUNT_KEY]);
  const bound = stored[SYNC_ACCOUNT_KEY];
  const expectedUserId = Number(bound?.id);
  if (stored['auto-mark'] !== true || !Number.isInteger(expectedUserId) || expectedUserId < 1) {
    return null;
  }
  try {
    const { ok, payload } = await currentSessionInfo(true);
    const currentUserId = Number(payload?.user?.id);
    if (!ok || !payload?.success || currentUserId !== expectedUserId) return null;
    return { userId: expectedUserId };
  } catch {
    return null;
  }
}

// Match% (KAN-2697): icon badge + popup row instead of a floating in-page
// widget. Per-anime in-memory cache; guest answers are not cached so the %
// appears right after login without waiting out the TTL.
const TASTE_TTL_MS = 15 * 60_000;
const tasteCache = new Map();
const tasteInFlight = new Map();
// Site palette --match-* (style.css) — verdict buckets from anirekoMatchLabelKey.
const MATCH_BADGE_COLORS = {
  very_likely: '#4ecdc4',
  likely: '#8bc34a',
  mixed: '#ffd93d',
  unlikely: '#ff6b6b',
};

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return value || '';
  }
}

function looseFrameKey(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/$/u, '');
  } catch {
    return normalizedUrl(value);
  }
}

// Exact match first (query string differs between two embeds of the same
// player), then origin+pathname fallback for iframes that navigated away from
// their src attribute — but only when the fallback is unambiguous.
function frameContext(state, frameUrl, documentId) {
  return AniRekoTrust.resolveFrameContext(
    state.frameReports || {},
    state.topDocumentId || null,
    frameUrl,
    documentId || null
  );
}

function hasVideoEvidence(player) {
  return Number.isFinite(player?.duration) && player.duration > 0;
}

function eligibleSignalPlayer(player) {
  return hasVideoEvidence(player)
    && AniRekoTrust.playerVisibilityConfirmed(player);
}

function activePlayerEntry(state) {
  const active = activePlayer(state);
  return Object.entries(state.players || {}).find(([, player]) => player === active) || null;
}

function playerEntryForEpisodeSignal(state, signal) {
  const entries = Object.entries(state.players || {}).filter(([, player]) => eligibleSignalPlayer(player));
  let candidates;
  if (!signal.topFrame) {
    candidates = entries.filter(([, player]) => player.documentId === signal.documentId);
  } else if (signal.sourceKind === 'player-message') {
    const exact = normalizedUrl(signal.sourceFrameUrl);
    candidates = entries.filter(([, player]) => normalizedUrl(player.frameUrl) === exact);
    if (candidates.length === 0) {
      const loose = looseFrameKey(signal.sourceFrameUrl);
      candidates = entries.filter(([, player]) => looseFrameKey(player.frameUrl) === loose);
    }
  } else {
    candidates = entries;
  }
  if (candidates.length !== 1) return null;
  const active = activePlayerEntry(state);
  return active && active[0] === candidates[0][0] ? candidates[0] : null;
}

function applyEpisodeSignal(state, signal) {
  const target = playerEntryForEpisodeSignal(state, signal);
  if (!target) return false;
  const [, player] = target;
  if (signal.authoritative || player.episode == null) {
    player.episode = signal.episode;
    player.episodeAuthoritative = Boolean(signal.authoritative);
    player.episodeSignalKind = signal.sourceKind;
  }
  return true;
}

function queueEpisodeSignal(state, signal) {
  if (applyEpisodeSignal(state, signal)) return;
  const cutoff = Date.now() - 30_000;
  state.pendingEpisodeSignals = [...(state.pendingEpisodeSignals || []), signal]
    .filter((item) => Number(item.observedAt) >= cutoff)
    .slice(-10);
}

function applyPendingEpisodeSignals(state) {
  const cutoff = Date.now() - 30_000;
  state.pendingEpisodeSignals = (state.pendingEpisodeSignals || []).filter((signal) => {
    if (Number(signal.observedAt) < cutoff) return false;
    return !applyEpisodeSignal(state, signal);
  });
}

function activePlayerHint(state) {
  const candidates = (state.frames || []).filter((frame) => frame.visible === true
    && Number.isInteger(frame.episode)
    && frame.rect?.width >= 240
    && frame.rect?.height >= 135);
  if (candidates.length !== 1) return null;
  const hint = candidates[0];
  return {
    player: 'iframe-shell',
    frameUrl: hint.src,
    episode: hint.episode,
    voice: state.topVoice || state.recognition?.voice || null,
    frameVisible: true,
    locallyVisible: true,
    playbackStarted: false,
    playing: false,
    paused: true,
    observedAt: Date.now(),
  };
}

const RU_NUMBER_WORD_VALUES = Object.freeze({
  ноль: 0,
  один: 1,
  одна: 1,
  одно: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  шестьдесят: 60,
  семьдесят: 70,
  восемьдесят: 80,
  девяносто: 90,
  сто: 100,
  двести: 200,
  триста: 300,
  четыреста: 400,
  пятьсот: 500,
  шестьсот: 600,
  семьсот: 700,
  восемьсот: 800,
  девятьсот: 900,
});
const RU_NUMBER_WORD_SCALES = Object.freeze({
  тысяча: 1000,
  тысячи: 1000,
  тысяч: 1000,
  миллион: 1_000_000,
  миллиона: 1_000_000,
  миллионов: 1_000_000,
});

function normalizeRussianNumberWords(tokens) {
  const normalized = [];
  for (let index = 0; index < tokens.length;) {
    let cursor = index;
    let total = 0;
    let current = 0;
    let matched = false;
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      const nextToken = tokens[cursor + 1];
      if (/^\d+$/u.test(token)
        && (matched || Object.prototype.hasOwnProperty.call(RU_NUMBER_WORD_SCALES, nextToken))) {
        current += Number(token);
      } else if (Object.prototype.hasOwnProperty.call(RU_NUMBER_WORD_VALUES, token)) {
        current += RU_NUMBER_WORD_VALUES[token];
      } else if (Object.prototype.hasOwnProperty.call(RU_NUMBER_WORD_SCALES, token)) {
        current ||= 1;
        total += current * RU_NUMBER_WORD_SCALES[token];
        current = 0;
      } else {
        break;
      }
      matched = true;
      cursor += 1;
    }
    if (matched) {
      normalized.push(String(total + current));
      index = cursor;
    } else {
      normalized.push(tokens[index]);
      index += 1;
    }
  }
  return normalized;
}

function titleSearchKey(value) {
  const tokens = String(value || '')
    .toLocaleLowerCase('ru')
    .replace(/ё/gu, 'е')
    .replace(/[^a-zа-я0-9]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  return normalizeRussianNumberWords(tokens).join(' ');
}

function titleExactKeys(value) {
  const source = String(value || '');
  const compactIntrawordHyphens = source.replace(
    /([a-zа-я])[-‐‑‒–—―]+([a-zа-я])/giu,
    '$1$2',
  );
  return new Set([
    titleSearchKey(source),
    titleSearchKey(compactIntrawordHyphens),
  ].filter(Boolean));
}

function lexicallyExactTitle(left, right) {
  const rightKeys = titleExactKeys(right);
  return Array.from(titleExactKeys(left)).some((key) => rightKeys.has(key));
}

function titleNumberTokens(value) {
  return titleSearchKey(value).split(' ').filter((token) => /^\d+$/u.test(token));
}

function numericallyCompatibleCandidate(query, candidate) {
  const wantedNumbers = titleNumberTokens(query);
  if (!wantedNumbers.length) return true;
  const candidateNumbers = new Set([
    ...titleNumberTokens(candidate?.title),
    ...titleNumberTokens(candidate?.subtitle),
  ]);
  // A translation may legitimately omit a number, but an explicit different
  // number is a strong contradiction (3000 years is not 100000 years).
  if (!candidateNumbers.size) return true;
  return wantedNumbers.every((number) => candidateNumbers.has(number));
}

function explicitSeasonRequest(value) {
  const title = String(value || '').trim();
  const patterns = [
    /^(.*?)(?:\s+|[-:])([0-9]{1,2})(?:-?(?:й|ый|ий))?\s*сезон(?:а)?$/iu,
    /^(.*?)(?:\s+|[-:])сезон\s*([0-9]{1,2})$/iu,
    /^(.*?)(?:\s+|[-:])([0-9]{1,2})(?:st|nd|rd|th)?\s*season$/iu,
    /^(.*?)(?:\s+|[-:])season\s*([0-9]{1,2})$/iu,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    const seasonNumber = Number(match?.[2]);
    const baseTitle = String(match?.[1] || '').trim();
    if (baseTitle.length >= 2 && Number.isInteger(seasonNumber)
      && seasonNumber >= 2 && seasonNumber <= 99) {
      return { baseTitle, seasonNumber };
    }
  }
  return null;
}

function englishOrdinal(value) {
  const number = Number(value);
  const lastTwo = number % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${number}th`;
  return `${number}${({ 1: 'st', 2: 'nd', 3: 'rd' })[number % 10] || 'th'}`;
}

function serialSeasonCandidate(candidate) {
  return ['TV', 'ONA'].includes(String(candidate?.type || '').toUpperCase());
}

function catalogCandidate(row) {
  const animeId = Number(row?.id ?? row?.animeId);
  if (!Number.isInteger(animeId) || animeId < 1) return null;
  const title = String(row?.title || '').trim();
  if (!title) return null;
  const yearRaw = row?.year;
  const year = yearRaw == null ? null : Number(yearRaw);
  const totalEpisodesRaw = row?.episodes ?? row?.totalEpisodes;
  const totalEpisodes = totalEpisodesRaw == null ? null : Number(totalEpisodesRaw);
  const completionMetadataReady = ['type', 'episodes', 'release_status']
    .every((key) => Object.prototype.hasOwnProperty.call(row, key))
    || row?.completionMetadataReady === true;
  return {
    animeId,
    title,
    subtitle: String(row?.subtitle || '').trim() || null,
    slug: String(row?.slug || '').trim() || null,
    year: Number.isInteger(year) && year > 0 ? year : null,
    type: String(row?.type || '').trim() || null,
    totalEpisodes: Number.isInteger(totalEpisodes) && totalEpisodes > 0 ? totalEpisodes : null,
    releaseStatus: String(row?.release_status ?? row?.releaseStatus ?? '').trim() || null,
    completionMetadataReady,
    exactAliasMatch: row?.exact_alias_match === true || row?.exactAliasMatch === true,
  };
}

async function manualMatchBinding(wanted) {
  const stored = await chrome.storage.local.get(MANUAL_MATCH_BINDINGS_KEY);
  const container = stored[MANUAL_MATCH_BINDINGS_KEY];
  if (container?.version !== MANUAL_MATCH_BINDINGS_VERSION) return null;
  const binding = container.items?.[wanted];
  const candidate = catalogCandidate(binding);
  if (!candidate) return null;
  return candidate;
}

async function saveManualMatchBinding(wanted, candidate) {
  const mutation = manualMatchBindingsQueue.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get(MANUAL_MATCH_BINDINGS_KEY);
    const current = stored[MANUAL_MATCH_BINDINGS_KEY];
    const items = current?.version === MANUAL_MATCH_BINDINGS_VERSION
      ? { ...(current.items || {}) }
      : {};
    items[wanted] = {
      ...candidate,
      boundAt: Date.now(),
    };
    const ordered = Object.entries(items)
      .sort(([, left], [, right]) => Number(right.boundAt || 0) - Number(left.boundAt || 0))
      .slice(0, MANUAL_MATCH_BINDINGS_MAX);
    await chrome.storage.local.set({
      [MANUAL_MATCH_BINDINGS_KEY]: {
        version: MANUAL_MATCH_BINDINGS_VERSION,
        items: Object.fromEntries(ordered),
      },
    });
  });
  manualMatchBindingsQueue = mutation.catch(() => {});
  return mutation;
}

async function removeManualMatchBinding(wanted) {
  const mutation = manualMatchBindingsQueue.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get(MANUAL_MATCH_BINDINGS_KEY);
    const current = stored[MANUAL_MATCH_BINDINGS_KEY];
    if (current?.version !== MANUAL_MATCH_BINDINGS_VERSION || !current.items?.[wanted]) return;
    const items = { ...current.items };
    delete items[wanted];
    await chrome.storage.local.set({
      [MANUAL_MATCH_BINDINGS_KEY]: { version: MANUAL_MATCH_BINDINGS_VERSION, items },
    });
  });
  manualMatchBindingsQueue = mutation.catch(() => {});
  return mutation;
}

function confirmedAnimeMatch(match) {
  return match?.status === 'ok' && Boolean(match.animeId) && (match.exact === true || match.manual === true);
}

async function searchCatalogCandidates(query) {
  if (!await privacyConsentAccepted()) throw new Error('privacy consent required');
  const { ok, status, payload } = await apiClient.request('search', { query, limit: 20 });
  if (!ok) throw new Error(`HTTP ${status}`);
  return (Array.isArray(payload?.data) ? payload.data : [])
    .map(catalogCandidate)
    .filter((candidate) => candidate && numericallyCompatibleCandidate(query, candidate));
}

async function resolveSeasonAliasCandidate(title, primaryCandidates) {
  const request = explicitSeasonRequest(title);
  if (!request) return null;
  const roots = primaryCandidates.filter((candidate) => serialSeasonCandidate(candidate)
    && (lexicallyExactTitle(candidate.title, request.baseTitle)
      || lexicallyExactTitle(candidate.subtitle, request.baseTitle)));
  if (roots.length !== 1) return null;
  const aliasBase = String(roots[0].subtitle || roots[0].title || '').trim();
  if (!aliasBase) return null;

  const probe = `${aliasBase} ${englishOrdinal(request.seasonNumber)} Season`;
  if (probe.length > 180) return null;
  const primaryIds = new Set(primaryCandidates.map((candidate) => candidate.animeId));
  const confirmed = (await searchCatalogCandidates(probe))
    .filter((candidate) => serialSeasonCandidate(candidate)
      && candidate.exactAliasMatch === true
      && primaryIds.has(candidate.animeId));
  return confirmed.length === 1 ? confirmed[0] : null;
}

// KAN-2054 acceptance: map the recognized title to our anime_id via the
// existing public search API. Only the cleaned title string is sent.
// KAN-2695: global persistent cache + in-flight dedup + error backoff. Most
// titles use one search request; an explicit ambiguous season may use one
// additional bounded alias probe before it is cached.
function resolveAnimeMatch(title, { forceRefresh = false } = {}) {
  const wanted = titleSearchKey(title);
  if (!wanted) return Promise.resolve({ status: 'none', query: title, resolvedAt: Date.now() });
  const requestKey = `${wanted}:${forceRefresh ? 'fresh' : 'cached'}`;
  let pending = searchInFlight.get(requestKey);
  if (!pending) {
    pending = resolveAnimeMatchWithBinding(title, wanted, forceRefresh)
      .finally(() => searchInFlight.delete(requestKey));
    searchInFlight.set(requestKey, pending);
  }
  return pending;
}

async function resolveAnimeMatchWithBinding(title, wanted, forceRefresh) {
  const binding = await manualMatchBinding(wanted);
  if (!binding) return resolveAnimeMatchUncached(title, wanted, forceRefresh);
  if (!forceRefresh) {
    return { status: 'ok', query: title, ...binding, exact: false, manual: true, resolvedAt: Date.now() };
  }
  try {
    const candidates = await searchCatalogCandidates(binding.title);
    const refreshed = candidates.find((candidate) => candidate.animeId === binding.animeId);
    if (!refreshed) {
      return { status: 'error', query: title, error: 'manual match not found', resolvedAt: Date.now() };
    }
    await saveManualMatchBinding(wanted, refreshed);
    return { status: 'ok', query: title, ...refreshed, exact: false, manual: true, resolvedAt: Date.now() };
  } catch (error) {
    return { status: 'error', query: title, error: String(error), resolvedAt: Date.now() };
  }
}

async function resolveAnimeMatchUncached(title, wanted, forceRefresh = false) {
  const now = Date.now();
  const stored = await chrome.storage.local.get([SEARCH_CACHE_KEY, 'search-cache-version']);
  const cacheVersion = SEARCH_CACHE_VERSION;
  const cache = stored['search-cache-version'] === cacheVersion
    ? (stored[SEARCH_CACHE_KEY] || {})
    : {};
  const cached = cache[wanted];
  if (!forceRefresh && cached?.match && now < cached.expiresAt) {
    const onlyCandidate = cached.match.status === 'ambiguous'
      && Array.isArray(cached.match.candidates)
      && cached.match.candidates.length === 1
      ? catalogCandidate(cached.match.candidates[0])
      : null;
    if (onlyCandidate && (lexicallyExactTitle(onlyCandidate.title, title)
      || lexicallyExactTitle(onlyCandidate.subtitle, title))) {
      const promoted = {
        status: 'ok', query: title, ...onlyCandidate, exact: true, manual: false,
        seasonAlias: false, resolvedAt: now,
      };
      cache[wanted] = { match: promoted, expiresAt: now + SEARCH_TTL_PARTIAL_MS };
      await chrome.storage.local.set({
        [SEARCH_CACHE_KEY]: cache,
        'search-cache-version': cacheVersion,
      });
      return promoted;
    }
    return cached.match;
  }
  if (now < searchBackoffUntil) {
    const fallback = { status: 'error', query: title, error: 'search backoff', resolvedAt: now };
    if (forceRefresh) return fallback;
    return cached?.match || fallback;
  }
  try {
    const results = await searchCatalogCandidates(title);
    let match = { status: 'none', query: title, resolvedAt: now };
    let seasonProbeUnavailable = false;
    if (results.length) {
      const exact = results.filter((candidate) => lexicallyExactTitle(candidate.title, title)
        || lexicallyExactTitle(candidate.subtitle, title));
      let seasonAlias = null;
      if (exact.length === 0) {
        try {
          seasonAlias = await resolveSeasonAliasCandidate(title, results);
        } catch {
          // The primary result is still useful. Keep the title ambiguous and
          // retry soon without poisoning the global search backoff.
          seasonProbeUnavailable = true;
        }
      }
      match = exact.length === 1 || seasonAlias
        ? {
          status: 'ok', query: title, ...(exact[0] || seasonAlias), exact: true,
          manual: false, seasonAlias: Boolean(seasonAlias), resolvedAt: now,
        }
        : { status: 'ambiguous', query: title, candidates: exact.length ? exact : results, resolvedAt: now };
    }
    searchFailCount = 0;
    searchBackoffUntil = 0;
    const retryAmbiguousSeason = match.status === 'ambiguous'
      && Boolean(explicitSeasonRequest(title));
    cache[wanted] = {
      match,
      expiresAt: now + (match.status !== 'ok'
        ? seasonProbeUnavailable || retryAmbiguousSeason
          ? SEARCH_TTL_PARTIAL_MS : SEARCH_TTL_MISS_MS
        : match.completionMetadataReady ? SEARCH_TTL_OK_MS : SEARCH_TTL_PARTIAL_MS),
    };
    const keys = Object.keys(cache);
    if (keys.length > SEARCH_CACHE_MAX) {
      keys.sort((left, right) => cache[left].expiresAt - cache[right].expiresAt)
        .slice(0, keys.length - SEARCH_CACHE_MAX)
        .forEach((key) => delete cache[key]);
    }
    await chrome.storage.local.set({
      [SEARCH_CACHE_KEY]: cache,
      'search-cache-version': cacheVersion,
    });
    return match;
  } catch (error) {
    searchFailCount += 1;
    searchBackoffUntil = now + Math.min(30 * 60_000, 30_000 * 2 ** (searchFailCount - 1));
    const fallback = { status: 'error', query: title, error: String(error), resolvedAt: now };
    if (forceRefresh) return fallback;
    return cached?.match || fallback;
  }
}

// Taste match% for the recognized anime (KAN-2697). Uses the shared cookie
// session; guests get {status:'guest'} and no badge.
function resolveTasteMatch(animeId, userKey) {
  const cacheKey = `${userKey}:${animeId}`;
  const cached = tasteCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.taste);
  let pending = tasteInFlight.get(cacheKey);
  if (!pending) {
    pending = resolveTasteMatchUncached(animeId, userKey, cacheKey)
      .finally(() => tasteInFlight.delete(cacheKey));
    tasteInFlight.set(cacheKey, pending);
  }
  return pending;
}

async function resolveTasteMatchUncached(animeId, userKey, cacheKey) {
  const now = Date.now();
  try {
    const { ok, status, payload } = await apiClient.request('taste-match', { animeId });
    if (!ok) throw new Error(`HTTP ${status}`);
    const data = payload?.data || {};
    let taste;
    if (!data.has_profile) {
      taste = { status: 'guest', animeId, userKey, resolvedAt: now };
    } else if (data.suppressed || data.match_percent == null
      || data.confidence_label_key === 'low') {
      // Low-confidence/suppressed % must not be presented as calibrated
      // (compatibility-ux-guard invariant 7).
      taste = { status: 'no-data', animeId, userKey, resolvedAt: now };
    } else {
      taste = {
        status: 'ok',
        animeId,
        userKey,
        percent: Number(data.match_percent),
        labelKey: String(data.label_key || 'mixed'),
        confidence: String(data.confidence_label_key || 'medium'),
        resolvedAt: now,
      };
    }
    if (taste.status !== 'guest') {
      tasteCache.set(cacheKey, { taste, expiresAt: now + TASTE_TTL_MS });
      if (tasteCache.size > 100) {
        tasteCache.delete(tasteCache.keys().next().value);
      }
    }
    return taste;
  } catch (error) {
    return { status: 'error', animeId, userKey, error: String(error), resolvedAt: now };
  }
}

async function updateMatchBadge(tabId, state) {
  const taste = state.taste;
  const actionRequired = Boolean(state.recognition?.title)
    && ['ambiguous', 'none'].includes(state.match?.status);
  const showBadge = taste?.status === 'ok' && Number.isFinite(taste.percent);
  try {
    await chrome.action.setBadgeText({
      tabId,
      text: actionRequired ? '!' : showBadge ? String(taste.percent) : ''
    });
    if (actionRequired || showBadge) {
      const color = actionRequired
        ? '#ffa502'
        : MATCH_BADGE_COLORS[taste.labelKey] || MATCH_BADGE_COLORS.mixed;
      await chrome.action.setBadgeBackgroundColor({ tabId, color });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ tabId, color: '#0a0a0f' });
      }
    }
    if (chrome.action.setTitle) {
      const title = actionRequired
        ? chrome.i18n?.getMessage('actionRequiredTitle') || 'AniReko — требуется выбрать аниме'
        : chrome.i18n?.getMessage('extensionName') || 'AniReko';
      await chrome.action.setTitle({ tabId, title });
    }
  } catch { /* tab gone */ }
}

// Auto-report unreadable players (KAN-2715): anime recognized, the page has
// player-ish structure, but no readable <video> appeared within the grace
// period. Anonymous by design — fetch WITHOUT credentials, hostname only
// (no path/query), structural probe only. Server stores 1 report/host/day;
// client dedups per host for 7 days.
const DIAG_DEDUP_MS = 7 * 24 * 3600 * 1000;
const diagInFlight = new Set();
const diagTimers = new Set();

function diagnosticProbe(probe) {
  const iframeHosts = [...new Set((probe?.iframes || []).map((frame) => {
    try {
      return new URL(frame.src).hostname;
    } catch {
      return null;
    }
  }).filter(Boolean))].slice(0, 10);
  return {
    videos: probe?.videos ?? 0,
    shadowHosts: probe?.shadowHosts ?? 0,
    episodeAttrElements: probe?.episodeAttrElements ?? 0,
    episodeParsed: probe?.episodeParsed ?? null,
    readyState: probe?.readyState ?? '',
    customTags: probe?.customTags ?? [],
    iframeHosts,
  };
}

// One delayed check per tab: fires after the grace period so late-initializing
// players (click-to-load) don't produce false reports. If the service worker
// dies before the timer fires, the report simply happens on a later visit.
function scheduleDiagTimer(tabId, delay, attempt, retryMs) {
  diagTimers.add(tabId);
  setTimeout(async () => {
    diagTimers.delete(tabId);
    const latest = stateByTab[tabId];
    if (!latest || latest.diagSentAt || latest.diagDone) return;
    await maybeSendDiagnostic(latest).catch(() => {});
    // Проба могла дозреть позже грейса (медленный SPA) — ограниченные
    // ретраи вместо пересоздания таймера на каждом сообщении.
    if (!latest.diagSentAt && !latest.diagDone && attempt < 3) {
      scheduleDiagTimer(tabId, retryMs, attempt + 1, retryMs);
    }
  }, delay);
}

// In-memory (сознательно НЕ в persisted-state): рестарт SW должен уметь
// начать цикл заново — diagSentAt/diagDone в состоянии защищают от дублей.
const diagCycles = new Set();

async function maybeScheduleDiagnostic(tabId) {
  const current = stateByTab[tabId];
  if (!current?.recognition?.title || current.diagSentAt || current.diagDone
    || diagTimers.has(tabId)) return;
  const stored = await chrome.storage.local.get(['diag-grace-ms', PRIVACY_CONSENT_KEY]);
  if (stored[PRIVACY_CONSENT_KEY]?.diagnostics !== true) return;
  const cycleKey = `${tabId}:${current.pageUrl || current.recognition.url}`;
  if (diagCycles.has(cycleKey)) return;
  if (diagCycles.size > 500) diagCycles.clear();
  diagCycles.add(cycleKey);
  const graceMs = Number.isFinite(stored['diag-grace-ms']) ? stored['diag-grace-ms'] : 15000;
  const delay = Math.max(500, current.recognition.observedAt + graceMs + 250 - Date.now());
  scheduleDiagTimer(tabId, delay, 1, Math.max(graceMs, 5000));
}

async function maybeSendDiagnostic(current) {
  const recognition = current.recognition;
  const probe = current.probe;
  if (!recognition?.title || !probe || current.diagSentAt) return;
  const readablePlayer = Object.values(current.players || {})
    .some((player) => Number.isFinite(player.duration) && player.duration > 0);
  if (readablePlayer) {
    // Плеер читается — репорт по этой странице не понадобится никогда.
    current.diagDone = true;
    return;
  }
  const playerSignal = (probe.iframes?.length || 0) > 0
    || (probe.shadowHosts || 0) > 0
    || (probe.customTags?.length || 0) > 0
    || (probe.videos || 0) > 0;
  if (!playerSignal) return;
  const stored = await chrome.storage.local.get(['diag-grace-ms', 'diag-sent']);
  const graceMs = Number.isFinite(stored['diag-grace-ms']) ? stored['diag-grace-ms'] : 15000;
  if (Date.now() - recognition.observedAt < graceMs) return;

  let host;
  try {
    host = new URL(current.pageUrl || recognition.url).hostname;
  } catch {
    return;
  }
  const inFlightKey = `player_unreadable:${host}`;
  if (!host || diagInFlight.has(inFlightKey)) return;
  const sent = stored['diag-sent'] || {};
  if ((sent[host] || 0) > Date.now() - DIAG_DEDUP_MS) return;
  diagInFlight.add(inFlightKey);
  try {
    const { ok, status } = await apiClient.request('diagnostic', {
      payload: {
        report_kind: 'player_unreadable',
        host,
        ext_version: chrome.runtime.getManifest().version,
        probe: diagnosticProbe(probe),
      },
    });
    if (ok || status === 204) {
      current.diagSentAt = Date.now();
      const pruned = Object.fromEntries(Object.entries({ ...sent, [host]: Date.now() })
        .sort(([, left], [, right]) => right - left)
        .slice(0, 50));
      await chrome.storage.local.set({ 'diag-sent': pruned });
    }
  } catch { /* transient — retried on a later visit */ } finally {
    diagInFlight.delete(inFlightKey);
  }
}

// Explicit false-negative report from the popup. Unlike automatic unsupported-
// player telemetry, this does not require the diagnostics toggle: the click is
// the per-report consent. The worker derives the host from trusted tab state and
// sends the same structural allowlist — never the URL, path, page title/content,
// cookies, account identity, or watch history.
async function reportRecognitionMiss(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, status: 400, payload: { error: 'invalid_tab' } };
  }
  let current = stateByTab[String(tabId)];
  if (!current) {
    current = (await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`];
  }
  if (!current?.probe || current.recognition?.title) {
    return { ok: false, status: 409, payload: { error: 'recognition_state_changed' } };
  }
  let host;
  try {
    const url = new URL(current.pageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
    host = url.hostname;
  } catch {
    return { ok: false, status: 400, payload: { error: 'invalid_page' } };
  }
  const storageKey = 'recognition-miss-sent';
  const stored = await chrome.storage.local.get(storageKey);
  const sent = stored[storageKey] || {};
  if ((sent[host] || 0) > Date.now() - DIAG_DEDUP_MS) {
    return { ok: true, status: 200, payload: { duplicate: true } };
  }
  const inFlightKey = `recognition_miss:${host}`;
  if (diagInFlight.has(inFlightKey)) {
    return { ok: true, status: 202, payload: { pending: true } };
  }
  // `storage.local.get` yielded control: recognition or SPA navigation may
  // have completed while dedup state was loading. Re-read the live tab object
  // immediately before egress so a now-recognized or changed page cannot emit
  // a stale false-negative report.
  const latest = stateByTab[String(tabId)] || current;
  if (latest.recognition?.title || latest.pageUrl !== current.pageUrl) {
    return { ok: false, status: 409, payload: { error: 'recognition_state_changed' } };
  }
  current = latest;
  diagInFlight.add(inFlightKey);
  try {
    const response = await apiClient.request('diagnostic', {
      payload: {
        report_kind: 'recognition_miss',
        host,
        ext_version: chrome.runtime.getManifest().version,
        probe: diagnosticProbe(current.probe),
      },
    });
    if (!response.ok && response.status !== 204) return response;
    const pruned = Object.fromEntries(Object.entries({ ...sent, [host]: Date.now() })
      .sort(([, left], [, right]) => right - left)
      .slice(0, 50));
    await chrome.storage.local.set({ [storageKey]: pruned });
    return { ok: true, status: 204, payload: { duplicate: false } };
  } finally {
    diagInFlight.delete(inFlightKey);
  }
}

// Auto-mark «watching» on the site (KAN-2695/KAN-2743). Storage key
// `auto-mark` is enabled only after explicit account binding in the popup.
// Работает только при совпадении live cookie-сессии с bound user id и exact
// catalog match. Only anime_id + expected user id leave the browser; the
// server still derives the target from the cookie and never overwrites
// watching/completed/dropped.
// Trigger threshold: ≥2 просмотренных серий ИЛИ полностью просмотренная
// серия №2+. Последнее важно для поздней установки расширения: если оно впервые
// увидело пользователя уже на 3-й серии, требовать ещё одну локальную запись
// нелогично — сам номер серии уже подтверждает, что тайтл смотрят. Серия №1
// остаётся сценарием «попробовал»; фильм без разметки серий — один полный просмотр.
const AUTO_MARK_MIN_EPISODES = 2;

function historyTitleKey(title) {
  return String(title || '').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function countWatchedForTitle(history, titleKey, animeId) {
  let episodes = 0;
  let fullWatch = false;
  for (const [key, record] of Object.entries(history?.records || {})) {
    if (!record?.completed || !key.startsWith(`${titleKey}::`)
      || Number(record.animeId) !== Number(animeId)) continue;
    if (key.endsWith('::full')) fullWatch = true;
    else episodes += 1;
  }
  return { episodes, fullWatch };
}

async function trustedWriteContext(state) {
  const origin = AniRekoTrust.httpOrigin(state?.sourceOrigin);
  if (!origin) return { ok: false, reason: 'origin_not_trusted' };
  // The static content script can only exist where Chrome's native site-access
  // control currently allows it. Account mutation is independently guarded by
  // explicit sync opt-in, immutable user binding, and the server user check.
  return { ok: true, origin };
}

async function maybeAutoMark(state) {
  let match = state.match;
  const player = state.player;
  if (!player?.watched || !confirmedAnimeMatch(match)) return;
  const history = await loadHistory();
  const { episodes, fullWatch } = countWatchedForTitle(
    history, historyTitleKey(state.recognition?.title), match.animeId
  );
  const currentEpisode = Number(player.episode);
  const reachedLaterEpisode = Number.isInteger(currentEpisode) && currentEpisode >= 2;
  if (!fullWatch && episodes < AUTO_MARK_MIN_EPISODES && !reachedLaterEpisode) return;
  if (AniRekoAutoMark.needsMetadataRefresh(match, player.episode)) {
    const refreshKey = `${match.animeId}:${player.episode ?? 'unknown'}`;
    const now = Date.now();
    if (completionMetadataRefreshInFlight.has(refreshKey)
      || (completionMetadataRefreshRetryAt[refreshKey] || 0) > now) return;
    if (!completionMetadataRefreshedInSession.has(refreshKey)) {
      completionMetadataRefreshInFlight.add(refreshKey);
      try {
        const refreshed = await resolveAnimeMatch(state.recognition?.title, { forceRefresh: true });
        if (!confirmedAnimeMatch(refreshed)
          || Number(refreshed.animeId) !== Number(match.animeId)) {
          completionMetadataRefreshRetryAt[refreshKey] = now + 120_000;
          return;
        }
        match = refreshed;
        state.match = refreshed;
        completionMetadataRefreshedInSession.add(refreshKey);
        delete completionMetadataRefreshRetryAt[refreshKey];
      } catch {
        completionMetadataRefreshRetryAt[refreshKey] = now + 120_000;
        return;
      } finally {
        completionMetadataRefreshInFlight.delete(refreshKey);
      }
    }
  }
  const wantedStatus = AniRekoAutoMark.desiredStatus(match, player.episode);
  const markKey = `${match.animeId}:${player.episode ?? 'unknown'}:${wantedStatus}`;
  const now = Date.now();
  // This cheap local gate intentionally precedes activeSyncAccount(), whose
  // live-cookie verification performs /session-info. Watched timeupdate ticks
  // must collapse into a single transition attempt.
  if (autoMarkedInSession.has(markKey) || autoMarkInFlight.has(markKey)
    || (autoMarkRetryAt[markKey] || 0) > now) return;
  const trust = await trustedWriteContext(state);
  if (!trust.ok) {
    state.syncDeniedReason = trust.reason;
    return;
  }
  state.syncDeniedReason = null;
  autoMarkInFlight.add(markKey);
  try {
    const syncAccount = await activeSyncAccount();
    if (!syncAccount) {
      autoMarkRetryAt[markKey] = now + 120_000;
      return;
    }
    const statusResult = await apiClient.request('status-get', { animeId: match.animeId });
    if (!statusResult.ok || !statusResult.payload?.success) {
      state.syncWriteFailed = true;
      autoMarkRetryAt[markKey] = now + (statusResult.status >= 500 ? 120_000 : 6 * 3600_000);
      return;
    }
    const existingStatus = statusResult.payload.data?.status ?? null;
    const nextStatus = AniRekoAutoMark.transitionFor(existingStatus, wantedStatus);
    if (!nextStatus) {
      autoMarkedInSession.add(markKey);
      return;
    }
    const postResult = await apiClient.request('status-write', {
      animeId: match.animeId,
      status: nextStatus,
      expectedUserId: syncAccount.userId,
    });
    if (postResult.ok && postResult.payload?.success) {
      autoMarkedInSession.add(markKey);
      state.autoMark = {
        animeId: match.animeId,
        episode: player.episode ?? null,
        status: nextStatus,
        at: now,
      };
    } else {
      state.syncWriteFailed = true;
      autoMarkRetryAt[markKey] = now + (postResult.status >= 500 ? 120_000 : 6 * 3600_000);
    }
  } catch {
    state.syncWriteFailed = true;
    autoMarkRetryAt[markKey] = now + 120_000;
  } finally {
    autoMarkInFlight.delete(markKey);
  }
}

// Resume-прогресс на сайт (KAN-2725): серия/позиция/озвучка → «Мой список».
// То же согласие, что и auto-mark (один sync-тогл). Наружу уходит только
// anime_id + episode + position + voice — без URL/домена источника.
// Отправка: pause/ended/смена серии/80%-переход/закрытие таба — urgent;
// периодика при непрерывном плейбэке — раз в 5 минут (это только страховка от
// крэша браузера: штатные точки покрыты urgent-триггерами, чаще слать незачем).
const PROGRESS_MIN_INTERVAL_MS = 300_000;
// Кэш «где остановился» для попапа: карта anime_id → progress, заполняется
// (а) bulk-GET `?all=1` из попапа (1 запрос / 30 мин на юзера, все аниме сразу)
// и (б) нашими же POST-ами — после них серверный GET не нужен вовсе.
const RESUME_BULK_KEY = 'resume-bulk';

async function updateResumeCache(userId, animeId, progress) {
  try {
    const stored = await chrome.storage.local.get(RESUME_BULK_KEY);
    const cached = stored[RESUME_BULK_KEY];
    const bulk = cached?.userId === userId
      ? cached
      : { userId, byAnime: {}, fetchedAt: 0 };
    bulk.byAnime[animeId] = progress;
    await chrome.storage.local.set({ [RESUME_BULK_KEY]: bulk });
  } catch { /* кэш — best effort */ }
}

async function syncProgressOnce(state, urgent) {
  const match = state.match;
  const player = state.player;
  if (!confirmedAnimeMatch(match)) return;
  if (!player?.playbackStarted || !Number.isFinite(player.currentTime)
    || !Number.isFinite(player.duration) || player.duration < 300) return;
  const now = Date.now();
  const sync = state.progressSync || {};
  const key = `${match.animeId}:${player.episode ?? 'full'}`;
  if (!urgent && sync.key === key && now - (sync.at || 0) < PROGRESS_MIN_INTERVAL_MS) return;
  const position = Math.round(player.currentTime);
  // Дребезг pause/seeked с той же позицией — не дублировать.
  if (sync.key === key && sync.position === position && now - (sync.at || 0) < 10_000) return;
  const trust = await trustedWriteContext(state);
  if (!trust.ok) {
    state.syncDeniedReason = trust.reason;
    return;
  }
  state.syncDeniedReason = null;
  const syncAccount = await activeSyncAccount();
  if (!syncAccount) return;
  state.progressSync = { key, at: now, position };
  const payload = {
    anime_id: match.animeId,
    episode: player.episode ?? null,
    position_sec: position,
    duration_sec: Math.round(player.duration),
    voice: player.voice || state.topVoice || state.recognition?.voice || '',
    expected_user_id: syncAccount.userId,
  };
  try {
    const result = await apiClient.request('progress-write', {
      animeId: payload.anime_id,
      episode: payload.episode,
      positionSec: payload.position_sec,
      durationSec: payload.duration_sec,
      voice: payload.voice,
      expectedUserId: payload.expected_user_id,
    });
    if (!result.ok && result.status !== 204) {
      state.progressSync = sync;
      state.syncWriteFailed = true;
      return;
    }
    // Мы сами — источник правды на этом девайсе: попап читает кэш, не сервер.
    await updateResumeCache(syncAccount.userId, match.animeId, {
      episode: payload.episode,
      position_sec: payload.position_sec,
      duration_sec: payload.duration_sec,
      voice: payload.voice,
      watched_at: new Date(now).toISOString(),
    });
  } catch {
    state.progressSync = sync; // транзиент — уйдёт со следующим триггером
    state.syncWriteFailed = true;
  }
}

function maybeSyncProgress(state, urgent) {
  const previous = progressSyncQueues.get(state) || Promise.resolve();
  let queued;
  queued = previous
    .catch(() => {})
    .then(() => syncProgressOnce(state, urgent))
    .finally(() => {
      if (progressSyncQueues.get(state) === queued) progressSyncQueues.delete(state);
    });
  progressSyncQueues.set(state, queued);
  return queued;
}

function activePlayer(state) {
  const now = Date.now();
  const players = Object.values(state.players || {});
  return players.sort((left, right) => {
    const score = (player) => {
      const ageSeconds = Math.max(0, (now - player.observedAt) / 1000);
      return (player.playing ? 1000 : 0)
        + (player.frameVisible === true ? 250 : player.frameVisible === false ? -2000 : 0)
        + (player.locallyVisible ? 150 : -500)
        + (player.episode != null ? 350 : 0)
        + (player.duration >= 300 ? 150 : player.duration > 0 && player.duration < 120 ? -250 : 0)
        + (player.lastAdvancedAt && now - player.lastAdvancedAt < 15000 ? 300 : 0)
        + (player.muted ? -25 : 0)
        + (player.progress > 0 ? 20 : 0)
        - Math.min(ageSeconds, 300);
    };
    return score(right) - score(left);
  })[0] || null;
}

function statusIcon(size, state) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d');
  const scale = size / 32;
  context.scale(scale, scale);

  const animeFound = Boolean(state.recognition?.title);
  const actionRequired = animeFound && ['ambiguous', 'none'].includes(state.match?.status);
  const player = state.player;
  const watched = Boolean(player?.watched);
  const playing = Boolean(player?.playing);
  const paused = Boolean(player?.playbackStarted) && !playing;

  // Base: centered brand "A" in a circle. Dimmed gray until an anime page is
  // recognized, bright brand gradient after.
  context.globalAlpha = animeFound ? 1 : 0.5;
  context.fillStyle = '#0a0a0f';
  context.beginPath();
  context.arc(16, 16, 15, 0, Math.PI * 2);
  context.fill();
  let brand = '#9ca3af';
  if (actionRequired) {
    brand = '#ffa502';
  } else if (animeFound) {
    brand = context.createLinearGradient(2, 2, 30, 30);
    brand.addColorStop(0, '#ff4757');
    brand.addColorStop(1, '#ff6b81');
  }
  context.strokeStyle = brand;
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = brand;
  context.beginPath();
  context.moveTo(15, 4.5);
  context.lineTo(7, 27);
  context.lineTo(11.5, 27);
  context.lineTo(13.5, 20.5);
  context.lineTo(18.5, 20.5);
  context.lineTo(20.7, 27);
  context.lineTo(25, 27);
  context.closePath();
  context.fill();
  context.fillStyle = '#0a0a0f';
  context.beginPath();
  context.moveTo(15.9, 10.5);
  context.lineTo(17.7, 17);
  context.lineTo(14.2, 17);
  context.closePath();
  context.fill();
  context.globalAlpha = 1;

  // Player state badge, top-right overlay (bottom is reserved for the
  // chrome match% badge text): ✓ watched / ▶ playing / ⏸ paused.
  if (actionRequired || watched || playing || paused) {
    const cx = 24;
    const cy = 8;
    context.fillStyle = actionRequired ? '#ffa502' : watched || playing ? '#2ed573' : '#ffa502';
    context.beginPath();
    context.arc(cx, cy, 7, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#0a0a0f';
    context.lineWidth = 1.5;
    context.stroke();
    context.fillStyle = '#ffffff';
    if (actionRequired) {
      context.fillStyle = '#0a0a0f';
      context.font = 'bold 11px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText('!', cx, cy + 0.5);
    } else if (watched) {
      context.strokeStyle = '#ffffff';
      context.lineWidth = 2;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(cx - 3.2, cy);
      context.lineTo(cx - 0.8, cy + 2.4);
      context.lineTo(cx + 3.2, cy - 2.4);
      context.stroke();
    } else if (playing) {
      context.beginPath();
      context.moveTo(cx - 2.2, cy - 3.8);
      context.lineTo(cx + 4, cy);
      context.lineTo(cx - 2.2, cy + 3.8);
      context.closePath();
      context.fill();
    } else {
      context.fillRect(cx - 2.4, cy - 3.2, 1.9, 6.4);
      context.fillRect(cx + 0.9, cy - 3.2, 1.9, 6.4);
    }
  }
  return context.getImageData(0, 0, size, size);
}

async function updateActionIcon(tabId, state) {
  try {
    await chrome.action.setIcon({
      tabId,
      imageData: {
        16: statusIcon(16, state),
        32: statusIcon(32, state),
      },
    });
  } catch (error) {
    console.warn('[AniReko] dynamic icon unavailable', error);
  }
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function loadHistory() {
  if (!historyCache) {
    const stored = await chrome.storage.local.get('watch-history');
    historyCache = stored['watch-history'] || { records: {}, days: {} };
    for (const record of Object.values(historyCache.records || {})) {
      delete record.mediaSeconds;
      delete record.playbackRate;
      delete record.skips;
    }
  }
  return historyCache;
}

function legacyCurrentHistoryRecord(state, history) {
  if (!confirmedAnimeMatch(state?.match)) return null;
  const titleKey = historyTitleKey(state?.recognition?.title);
  if (!titleKey || !state?.player) return null;
  const episode = Number(state.player.episode ?? state.recognition?.episode);
  const episodeKey = Number.isInteger(episode) && episode > 0 ? episode : 'full';
  const record = history?.records?.[`${titleKey}::${episodeKey}`];
  if (!record || Number.isInteger(Number(record.animeId))
    || Number(record.position) <= 0
    || !Number.isFinite(Number(record.duration))
    || Number(record.duration) < 300) return null;
  return record;
}

async function bindLegacyCurrentHistoryRecord(state, history, record) {
  // A separate popup confirmation names the resolved catalog anime before a
  // legacy title-only record is upgraded. Background writes never guess.
  record.animeId = Number(state.match.animeId);
  history.updatedAt = Date.now();
  await chrome.storage.local.set({ 'watch-history': history });
}

function historyPlayerForManualSync(state, history) {
  const titleKey = historyTitleKey(state?.recognition?.title);
  if (!titleKey) return null;
  const currentEpisode = Number(state?.player?.episode ?? state?.recognition?.episode);
  const candidates = Object.entries(history?.records || {})
    .filter(([key, record]) => key.startsWith(`${titleKey}::`)
      && Number.isInteger(Number(record?.animeId))
      && Number(record.animeId) === Number(state?.match?.animeId)
      && Number(record?.position) > 0
      && Number.isFinite(Number(record?.duration))
      && Number(record.duration) >= 300)
    .map(([key, record]) => {
      const suffix = key.slice(titleKey.length + 2);
      const storedEpisode = Number(record.episode);
      const suffixEpisode = Number(suffix);
      const episode = Number.isInteger(storedEpisode) && storedEpisode > 0
        ? storedEpisode
        : Number.isInteger(suffixEpisode) && suffixEpisode > 0 ? suffixEpisode : null;
      return { record, episode };
    })
    .sort((left, right) => {
      const leftCurrent = Number.isInteger(currentEpisode) && left.episode === currentEpisode ? 1 : 0;
      const rightCurrent = Number.isInteger(currentEpisode) && right.episode === currentEpisode ? 1 : 0;
      if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
      const lastWatchedDelta = Number(right.record.lastWatchedAt || 0)
        - Number(left.record.lastWatchedAt || 0);
      if (lastWatchedDelta !== 0) return lastWatchedDelta;
      if (Boolean(left.record.completed) !== Boolean(right.record.completed)) {
        return Number(Boolean(right.record.completed)) - Number(Boolean(left.record.completed));
      }
      return 0;
    });
  const selected = candidates[0];
  if (!selected) return null;
  const position = Number(selected.record.position);
  const duration = Number(selected.record.duration);
  return {
    ...(state.player || {}),
    player: state.player?.player || 'local-history',
    episode: selected.episode,
    currentTime: position,
    duration,
    progress: Math.max(0, Math.min(1, position / duration)),
    watched: selected.record.completed === true,
    playbackStarted: true,
    playing: false,
    paused: true,
    ended: selected.record.completed === true,
    voice: selected.record.voice || state.player?.voice || state.voice || null,
    reason: 'manual-history-sync',
    observedAt: Number(selected.record.lastWatchedAt) || Date.now(),
  };
}

async function syncCurrentOrHistoryFromPopup(state, options = {}) {
  state.syncWriteFailed = false;
  const history = await loadHistory();
  const livePlayer = state.player;
  const liveUsable = Boolean(livePlayer?.playbackStarted)
    && Number.isFinite(livePlayer.currentTime)
    && Number.isFinite(livePlayer.duration)
    && livePlayer.duration >= 300;
  if (!liveUsable) {
    const legacyRecord = legacyCurrentHistoryRecord(state, history);
    if (legacyRecord && options.confirmLegacyHistory !== true) {
      return {
        writeFailed: false,
        confirmationRequired: true,
        animeTitle: state.match.title || state.recognition?.title || '',
      };
    }
    if (legacyRecord) await bindLegacyCurrentHistoryRecord(state, history, legacyRecord);
  }
  const historyPlayer = historyPlayerForManualSync(state, history);
  const player = liveUsable ? livePlayer : historyPlayer;
  const syncState = player && player !== livePlayer ? { ...state, player } : state;
  await maybeSyncProgress(syncState, true);
  if (syncState.player?.watched) await maybeAutoMark(syncState);
  if (syncState !== state) {
    state.match = syncState.match;
    state.progressSync = syncState.progressSync;
    state.autoMark = syncState.autoMark;
    state.syncDeniedReason = syncState.syncDeniedReason;
    state.syncWriteFailed = syncState.syncWriteFailed;
  }
  return { writeFailed: state.syncWriteFailed === true, confirmationRequired: false };
}

// Timeupdate ticks only mutate the in-memory history; the full-object storage
// write happens at most every 15s. Meaningful events (pause/ended/seeked/
// watched transition) flush immediately, so at most ~15s of counters are at
// risk if the service worker dies mid-session.
async function flushHistory(player, watchedTransition = false) {
  const now = Date.now();
  // Только ПЕРЕХОД через 80% форсирует flush; устоявшееся watched-состояние
  // (тики после порога до конца серии) живёт под обычным 15с-дебаунсом.
  if (player.reason === 'timeupdate' && !watchedTransition
    && now - historyLastFlushAt < HISTORY_FLUSH_INTERVAL_MS) {
    return;
  }
  historyLastFlushAt = now;
  const history = historyCache;
  history.records = Object.fromEntries(Object.entries(history.records)
    .sort(([, left], [, right]) => right.lastWatchedAt - left.lastWatchedAt)
    .slice(0, 500));
  history.days = Object.fromEntries(Object.entries(history.days)
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, 90));
  history.updatedAt = now;
  await chrome.storage.local.set({ 'watch-history': history });
}

function queueHistoryUpdate(state, player, previousPlayer) {
  const recognition = state.recognition;
  if (!recognition?.title || !Number.isFinite(player?.currentTime)) {
    return Promise.resolve();
  }
  // Episode is optional (movies / players without episode markup) — but an
  // episode-less record requires an episode-length duration (5+ min), so
  // short clips and ads never pollute the history.
  if (player.episode == null && !(Number.isFinite(player.duration) && player.duration >= 300)) {
    return Promise.resolve();
  }
  historyQueue = historyQueue.catch(() => {}).then(async () => {
    const history = await loadHistory();
    const titleKey = historyTitleKey(recognition.title);
    const recordKey = `${titleKey}::${player.episode ?? 'full'}`;
    const previousObservedAt = Number(previousPlayer?.observedAt);
    const wallDelta = (player.observedAt - previousObservedAt) / 1000;
    const mediaDelta = player.currentTime - Number(previousPlayer?.currentTime);
    const isSeek = /seek|episode-change/iu.test(player.reason || '');
    const watchedDelta = !isSeek
      && previousPlayer?.playbackStarted
      && wallDelta > 0 && wallDelta <= 15
      && mediaDelta > 0 && mediaDelta <= 20
      ? Math.min(wallDelta, mediaDelta)
      : 0;
    const matchedAnimeId = confirmedAnimeMatch(state.match) ? Number(state.match.animeId) : null;
    const storedRecord = history.records[recordKey];
    if (storedRecord?.animeId && matchedAnimeId == null) return;
    const existing = storedRecord?.animeId && Number(storedRecord.animeId) !== matchedAnimeId
      ? {
        title: recognition.title,
        episode: player.episode,
        watchedSeconds: 0,
        firstWatchedAt: player.observedAt,
      }
      : storedRecord || {
        title: recognition.title,
        episode: player.episode,
        watchedSeconds: 0,
        firstWatchedAt: player.observedAt,
      };
    const watchedTransition = Boolean(player.watched && !existing.completed);
    history.records[recordKey] = {
      ...existing,
      title: recognition.title,
      episode: player.episode,
      animeId: matchedAnimeId,
      voice: player.voice || state.topVoice || recognition.voice || existing.voice || null,
      watchedSeconds: Math.round((existing.watchedSeconds + watchedDelta) * 10) / 10,
      position: player.currentTime,
      duration: player.duration,
      progress: player.progress,
      completed: Boolean(existing.completed || player.watched),
      lastWatchedAt: player.observedAt,
    };
    const dateKey = localDateKey(player.observedAt);
    const day = history.days[dateKey] || { watchedSeconds: 0, episodeKeys: [] };
    day.watchedSeconds = Math.round((day.watchedSeconds + watchedDelta) * 10) / 10;
    if (!day.episodeKeys.includes(recordKey)) day.episodeKeys.push(recordKey);
    history.days[dateKey] = day;

    await flushHistory(player, watchedTransition);
  });
  return historyQueue;
}

async function updateTabState(message, sender, messageContext) {
  const tabId = String(sender.tab.id);
  const storageKey = `tab:${tabId}`;
  let current = stateByTab[tabId];
  if (!current) {
    const stored = await chrome.storage.session.get(storageKey);
    current = stored[storageKey] || { players: {}, frames: [], frameReports: {} };
  }
  current.documents ||= {};
  if (messageContext.topFrame) {
    const changedDocument = current.navigationToken
      && current.navigationToken !== messageContext.documentToken;
    if (changedDocument && message.type !== 'page-observed') {
      current.lastRejectReason = 'stale_navigation';
      return;
    }
    if (message.type === 'page-observed'
      && (changedDocument || (current.pageUrl && current.pageUrl !== message.url))) {
      current = { players: {}, frames: [], frameReports: {}, documents: {} };
    }
    current.navigationToken = messageContext.documentToken;
    current.sourceOrigin = messageContext.topOrigin;
    current.topDocumentId = messageContext.documentId;
  } else {
    if (!current.navigationToken || current.sourceOrigin !== messageContext.topOrigin) {
      current.lastRejectReason = 'stale_navigation';
      return;
    }
    const knownDocument = current.documents[messageContext.documentId];
    if (knownDocument && knownDocument.token !== messageContext.documentToken) {
      current.lastRejectReason = 'stale_navigation';
      return;
    }
    current.documents[messageContext.documentId] = {
      token: messageContext.documentToken,
      origin: messageContext.origin,
    };
  }
  current.lastRejectReason = null;
  if (message.type === 'page-observed') {
    current.pageUrl = message.url;
    if (message.probe) current.probe = message.probe;
  }
  if (message.type === 'probe-update') {
    current.probe = message.probe;
    current.pageUrl ||= message.url;
  }
  if (message.type === 'recognition') {
    if (current.recognition?.url && current.recognition.url !== message.url) {
      // SPA-переход, который не поймал page-observed (напр. только hash):
      // сбрасываем всё контекстное старой страницы, иначе players нового URL
      // получат stale-эпизод/пробу.
      current.players = {};
      current.frames = [];
      current.frameReports = {};
      current.player = null;
      current.pendingEpisodeSignals = [];
      current.pendingVoiceByDocument = {};
      current.topVoice = null;
      current.voice = null;
      current.probe = null;
      delete current.diagSentAt;
      delete current.diagDone;
    }
    current.recognition = message;
    current.pageUrl = message.url;
    if (titleSearchKey(current.match?.query) !== titleSearchKey(message.title)) {
      current.match = await resolveAnimeMatch(message.title);
    }
  }
  if (message.type === 'voice-change') {
    if (messageContext.topFrame) {
      current.topVoice = message.voice;
      if (current.recognition) current.recognition.voice = message.voice;
    } else {
      current.pendingVoiceByDocument ||= {};
      current.pendingVoiceByDocument[messageContext.documentId] = message.voice;
      for (const player of Object.values(current.players || {})) {
        if (player.documentId === messageContext.documentId) player.voice = message.voice;
      }
    }
  }
  // Shadow-DOM/web-component players (KAN-2713): the top page knows the
  // episode (playlist/player attributes) while the <video> lives in a
  // cross-origin frame that reports episode=null — join the two here.
  if (message.type === 'episode-observed') {
    queueEpisodeSignal(current, {
      episode: message.episode,
      authoritative: Boolean(message.authoritative),
      sourceKind: message.sourceKind,
      sourceFrameUrl: message.sourceFrameUrl || null,
      documentId: messageContext.documentId,
      topFrame: messageContext.topFrame,
      observedAt: message.observedAt,
    });
  }
  if (message.type === 'frame-visibility') {
    current.frameReports ||= {};
    for (const [documentId, report] of Object.entries(current.frameReports)) {
      if (documentId !== messageContext.documentId && report.frameId === messageContext.frameId) {
        delete current.frameReports[documentId];
      }
    }
    current.frameReports[messageContext.documentId] = {
      documentUrl: messageContext.documentUrl,
      frameId: messageContext.frameId,
      frames: message.frames || [],
      observedAt: message.observedAt,
    };
    if (messageContext.topFrame) current.frames = message.frames || [];
    for (const player of Object.values(current.players || {})) {
      const resolvedFrame = frameContext(current, player.frameUrl, player.documentId);
      player.frameVisible = resolvedFrame?.visible ?? null;
      if (player.episodeAuthoritative !== true
        && (player.episode == null || player.episodeSignalKind === 'iframe-chain')) {
        player.episode = resolvedFrame?.episode ?? null;
        player.episodeSignalKind = Number.isInteger(resolvedFrame?.episode)
          ? 'iframe-chain'
          : null;
      }
    }
    applyPendingEpisodeSignals(current);
  }
  let updatedPlayerKey = null;
  let previousPlayer = null;
  if (message.type === 'player-progress') {
    const frameKey = sender.documentId || `frame-${sender.frameId ?? 0}`;
    const playerKey = `${frameKey}:${message.playerInstanceId || 'video'}`;
    current.players ||= {};
    const previous = current.players[playerKey];
    updatedPlayerKey = playerKey;
    previousPlayer = previous || null;
    const advanced = Number.isFinite(message.currentTime)
      && Number.isFinite(previous?.currentTime)
      && message.currentTime > previous.currentTime + 0.2;
    const frameNavigated = Boolean(previous?.frameUrl)
      && normalizedUrl(previous.frameUrl) !== normalizedUrl(message.frameUrl);
    const messageAuthoritative = message.episodeAuthoritative === true;
    const documentVoice = current.pendingVoiceByDocument?.[messageContext.documentId] || null;
    const resolvedFrame = frameContext(current, message.frameUrl, messageContext.documentId);
    const episodeResolution = AniRekoTrust.resolvePlayerEpisode(
      message.episode,
      messageAuthoritative,
      previous,
      resolvedFrame?.episode,
      frameNavigated,
    );
    current.players[playerKey] = {
      ...previous,
      ...message,
      episode: episodeResolution.episode,
      episodeAuthoritative: episodeResolution.authoritative,
      episodeSignalKind: episodeResolution.signalKind,
      voice: documentVoice || (frameNavigated ? null : previous?.voice) || null,
      frameId: sender.frameId ?? 0,
      documentId: sender.documentId || null,
      frameVisible: resolvedFrame?.visible ?? null,
      playbackStarted: Boolean(previous?.playbackStarted || message.playbackStarted),
      lastAdvancedAt: advanced ? message.observedAt : previous?.lastAdvancedAt || null
    };
    const entries = Object.entries(current.players)
      .sort(([, left], [, right]) => right.observedAt - left.observedAt)
      .slice(0, 20);
    current.players = Object.fromEntries(entries);
    applyPendingEpisodeSignals(current);
  }
  // A transient error or a match cached before completion metadata existed
  // must not freeze the mapping for the whole tab lifetime.
  const matchAge = Date.now() - (current.match?.resolvedAt || 0);
  const retryMatch = current.match?.status === 'error' && matchAge > 60_000;
  const retryCompletionMetadata = current.match?.status === 'ok'
    && current.match.completionMetadataReady !== true
    && matchAge > SEARCH_TTL_PARTIAL_MS;
  if (current.recognition?.title && (retryMatch || retryCompletionMetadata)) {
    current.match = await resolveAnimeMatch(current.recognition.title);
  }
  // Taste match% for the badge/popup. Guest/error answers re-checked every
  // 5 min (login can happen anytime); ok/no-data served from cache (15 min).
  if (current.match?.status === 'ok' && current.match.animeId) {
    const now = Date.now();
    const userKey = sessionIdentityKey(await currentSessionInfo());
    const taste = current.taste;
    const stale = !taste
      || taste.animeId !== current.match.animeId
      || taste.userKey !== userKey
      || (taste.status === 'ok' && now - taste.resolvedAt > TASTE_TTL_MS)
      || (taste.status !== 'ok' && now - taste.resolvedAt > 5 * 60_000);
    if (stale) current.taste = await resolveTasteMatch(current.match.animeId, userKey);
  } else {
    current.taste = null;
  }
  const detectedPlayer = activePlayer(current);
  current.player = detectedPlayer
    && AniRekoTrust.playerVisibilityConfirmed(detectedPlayer)
    ? detectedPlayer
    : activePlayerHint(current);
  current.voice = current.player?.voice
    || current.topVoice
    || current.recognition?.voice
    || null;
  if (updatedPlayerKey && current.player === current.players[updatedPlayerKey]) {
    await queueHistoryUpdate(current, current.player, previousPlayer);
    // Fire-and-forget: не блокируем очередь сообщений таба.
    const urgentSync = message.reason === 'pause' || message.reason === 'ended'
      || Boolean(message.watched && !previousPlayer?.watched)
      || (previousPlayer?.episode != null && message.episode != null
        && message.episode !== previousPlayer.episode);
    maybeSyncProgress(current, urgentSync).catch(() => {});
  }
  // Fire-and-forget: auto-mark must never block the per-tab message queue.
  if (current.player?.watched) maybeAutoMark(current).catch(() => {});
  const now = Date.now();
  current.updatedAt = now;
  stateByTab[tabId] = current;
  // Full-state storage write on every 5s tick was the hottest local path
  // (players + frames + probe serialize). Pure timeupdate ticks flush at most
  // every 10s; events/recognition/watched-transition flush immediately. The
  // popup reads storage, so worst case it shows progress ≤10s stale.
  const routineTick = message.type === 'player-progress'
    && message.reason === 'timeupdate'
    && !(message.watched && !previousPlayer?.watched);
  if (!routineTick || now - (tabStateFlushAt[tabId] || 0) >= 10000) {
    tabStateFlushAt[tabId] = now;
    await chrome.storage.session.set({ [storageKey]: current });
  }
  maybeScheduleDiagnostic(tabId).catch(() => {});
  await Promise.all([
    updateActionIcon(sender.tab.id, current),
    updateMatchBadge(sender.tab.id, current),
  ]);
}

function isPopupSender(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(sender.url || '');
    return url.protocol === 'chrome-extension:'
      && url.host === chrome.runtime.id
      && url.pathname === '/popup.html';
  } catch {
    return false;
  }
}

async function popupTabState(tabId) {
  if (!Number.isInteger(tabId) || tabId < 1) return null;
  const memoryState = stateByTab[String(tabId)];
  if (memoryState) return memoryState;
  const storageKey = `tab:${tabId}`;
  const stored = await chrome.storage.session.get(storageKey);
  return stored[storageKey] || null;
}

async function popupTabExists(tabId) {
  try {
    return Boolean(await chrome.tabs.get(tabId));
  } catch {
    return false;
  }
}

async function persistPopupTabState(tabId, state) {
  if (!await popupTabExists(tabId)) {
    delete stateByTab[String(tabId)];
    await chrome.storage.session.remove(`tab:${tabId}`);
    return false;
  }
  state.updatedAt = Date.now();
  stateByTab[String(tabId)] = state;
  await chrome.storage.session.set({ [`tab:${tabId}`]: state });
  await Promise.all([
    updateActionIcon(tabId, state),
    updateMatchBadge(tabId, state),
  ]);
  return true;
}

async function popupSearchAnime(query) {
  if (!await privacyConsentAccepted()) {
    return { ok: false, status: 403, payload: { error: 'privacy_consent_required' } };
  }
  const cleaned = String(query || '').trim();
  if (cleaned.length < 2 || cleaned.length > 180) {
    return { ok: false, status: 400, payload: { error: 'invalid_query' } };
  }
  try {
    const candidates = await searchCatalogCandidates(cleaned);
    const exact = candidates.filter((candidate) => lexicallyExactTitle(candidate.title, cleaned)
      || lexicallyExactTitle(candidate.subtitle, cleaned));
    const seasonAlias = exact.length === 0
      ? await resolveSeasonAliasCandidate(cleaned, candidates).catch(() => null)
      : null;
    const ordered = seasonAlias
      ? [seasonAlias, ...candidates.filter((candidate) => candidate.animeId !== seasonAlias.animeId)]
      : candidates;
    return { ok: true, status: 200, payload: { query: cleaned, candidates: ordered } };
  } catch {
    return { ok: false, status: 503, payload: { error: 'search_unavailable' } };
  }
}

async function bindPopupAnime(message) {
  const tabId = Number(message.tabId);
  const animeId = Number(message.animeId);
  const query = String(message.query || '').trim();
  if (!Number.isInteger(tabId) || tabId < 1 || !Number.isInteger(animeId) || animeId < 1
    || query.length < 2 || query.length > 180) {
    return { ok: false, status: 400, payload: { error: 'invalid_binding' } };
  }
  if (!await privacyConsentAccepted()) {
    return { ok: false, status: 403, payload: { error: 'privacy_consent_required' } };
  }
  const state = await popupTabState(tabId);
  const recognizedTitle = String(state?.recognition?.title || '').trim();
  const wanted = titleSearchKey(recognizedTitle);
  if (!state || !wanted) {
    return { ok: false, status: 409, payload: { error: 'recognition_state_changed' } };
  }
  if (!await popupTabExists(tabId)) {
    return { ok: false, status: 404, payload: { error: 'tab_not_found' } };
  }
  let candidate;
  try {
    candidate = (await searchCatalogCandidates(query))
      .find((item) => item.animeId === animeId);
  } catch {
    return { ok: false, status: 503, payload: { error: 'search_unavailable' } };
  }
  if (!candidate) {
    return { ok: false, status: 409, payload: { error: 'candidate_not_confirmed' } };
  }
  if (!await popupTabExists(tabId)) {
    return { ok: false, status: 404, payload: { error: 'tab_not_found' } };
  }
  await saveManualMatchBinding(wanted, candidate);
  state.match = {
    status: 'ok',
    query: recognizedTitle,
    ...candidate,
    exact: false,
    manual: true,
    resolvedAt: Date.now(),
  };
  const userKey = sessionIdentityKey(await currentSessionInfo());
  state.taste = await resolveTasteMatch(candidate.animeId, userKey);
  if (await popupTabExists(tabId)) {
    await syncCurrentOrHistoryFromPopup(state, { confirmLegacyHistory: true });
  }
  await persistPopupTabState(tabId, state);
  return { ok: true, status: 200, payload: { match: state.match } };
}

async function unbindPopupAnime(message) {
  const tabId = Number(message.tabId);
  const state = await popupTabState(tabId);
  const recognizedTitle = String(state?.recognition?.title || '').trim();
  const wanted = titleSearchKey(recognizedTitle);
  if (!state || !wanted) {
    return { ok: false, status: 409, payload: { error: 'recognition_state_changed' } };
  }
  if (!await privacyConsentAccepted()) {
    return { ok: false, status: 403, payload: { error: 'privacy_consent_required' } };
  }
  if (!await popupTabExists(tabId)) {
    return { ok: false, status: 404, payload: { error: 'tab_not_found' } };
  }
  await removeManualMatchBinding(wanted);
  state.match = await resolveAnimeMatch(recognizedTitle, { forceRefresh: true });
  state.taste = confirmedAnimeMatch(state.match)
    ? await resolveTasteMatch(state.match.animeId, sessionIdentityKey(await currentSessionInfo()))
    : null;
  await persistPopupTabState(tabId, state);
  return { ok: true, status: 200, payload: { match: state.match } };
}

async function syncPopupCurrent(message) {
  const tabId = Number(message.tabId);
  const expectedUserId = Number(message.expectedUserId);
  const state = await popupTabState(tabId);
  if (!state) return { ok: false, status: 404, payload: { error: 'tab_state_not_found' } };
  if (!await popupTabExists(tabId)) {
    return { ok: false, status: 404, payload: { error: 'tab_not_found' } };
  }
  if (!confirmedAnimeMatch(state.match)) {
    return { ok: false, status: 409, payload: { error: 'anime_match_required' } };
  }
  const syncAccount = await activeSyncAccount();
  if (!syncAccount || syncAccount.userId !== expectedUserId) {
    return { ok: false, status: 409, payload: { error: 'sync_account_mismatch' } };
  }
  const progressAt = Number(state.progressSync?.at || 0);
  const autoMarkAt = Number(state.autoMark?.at || 0);
  const syncOutcome = await syncCurrentOrHistoryFromPopup(state, {
    confirmLegacyHistory: message.confirmLegacyHistory === true,
  });
  await persistPopupTabState(tabId, state);
  return {
    ok: true,
    status: 200,
    payload: {
      progressSynced: Number(state.progressSync?.at || 0) > progressAt,
      statusSynced: Number(state.autoMark?.at || 0) > autoMarkAt,
      writeFailed: syncOutcome.writeFailed,
      confirmationRequired: syncOutcome.confirmationRequired === true,
      animeTitle: syncOutcome.animeTitle || null,
    },
  };
}

async function handlePopupRequest(message) {
  switch (message?.type) {
    case 'popup-runtime-info':
      return {
        ok: true,
        status: 200,
        payload: { siteBase: apiClient.base, testMode: AniRekoRuntimeConfig.testMode === true },
      };
    case 'popup-session-info':
      return currentSessionInfo(true);
    case 'popup-search-anime':
      return popupSearchAnime(message.query);
    case 'popup-bind-anime':
      return bindPopupAnime(message);
    case 'popup-unbind-anime':
      return unbindPopupAnime(message);
    case 'popup-sync-current':
      return syncPopupCurrent(message);
    case 'popup-progress-all': {
      const expectedUserId = Number(message.expectedUserId);
      const syncAccount = await activeSyncAccount();
      if (!syncAccount || syncAccount.userId !== expectedUserId) {
        return { ok: false, status: 409, payload: { error: 'sync_account_mismatch' } };
      }
      return apiClient.request('progress-all', { expectedUserId });
    }
    case 'popup-report-recognition-miss':
      return reportRecognitionMiss(Number(message.tabId));
    case 'popup-delete-local-data': {
      const tabIds = Object.keys(stateByTab).map(Number);
      await Promise.all(tabIds.map(disableTab));
      await chrome.storage.session.clear();
      await chrome.storage.local.clear();
      historyCache = null;
      historyLastFlushAt = 0;
      searchInFlight.clear();
      tasteCache.clear();
      tasteInFlight.clear();
      sessionInfoCache = null;
      sessionInfoExpiresAt = 0;
      sessionInfoInFlight = null;
      autoMarkedInSession.clear();
      autoMarkInFlight.clear();
      return { ok: true, status: 200, payload: null };
    }
    default:
      return { ok: false, status: 400, payload: { error: 'request_not_allowed' } };
  }
}

function queueSensorMessage(message, sender, messageContext) {
  const tabId = String(sender.tab.id);
  const previous = tabQueues[tabId] || Promise.resolve();
  let queue;
  queue = previous
    .catch(() => {})
    .then(() => updateTabState(message, sender, messageContext))
    .catch((error) => console.error('[AniReko] state update failed', error))
    .finally(() => {
      if (tabQueues[tabId] === queue) delete tabQueues[tabId];
    });
  tabQueues[tabId] = queue;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isPopupSender(sender)) {
    handlePopupRequest(message)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, status: 503, payload: null }));
    return true;
  }
  const messageContext = AniRekoTrust.validateSensorMessage(message, sender, chrome.runtime.id);
  if (!messageContext.ok) return;
  authorizedDocument(messageContext)
    .then((allowed) => { if (allowed) queueSensorMessage(message, sender, messageContext); })
    .catch(() => {});
});

async function finalizeRemovedTab(tabId) {
  const id = String(tabId);
  const storageKey = `tab:${tabId}`;
  try {
    await tabQueues[id]?.catch(() => {});
    let state = stateByTab[id];
    if (!state) {
      const stored = await chrome.storage.session.get(storageKey);
      state = stored[storageKey];
    }
  // Закрыл вкладку посреди серии — финальная точка прогресса.
    if (state?.player?.playbackStarted) await maybeSyncProgress(state, true);
  } finally {
    delete stateByTab[id];
    delete tabQueues[id];
    delete tabStateFlushAt[id];
    await chrome.storage.session.remove(storageKey);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  finalizeRemovedTab(tabId).catch(() => {});
});

if (AniRekoRuntimeConfig.testMode === true) {
  globalThis.AniRekoTestHooks = Object.freeze({
    resetVolatileCaches() {
      historyCache = null;
      historyLastFlushAt = 0;
      sessionInfoCache = null;
      sessionInfoExpiresAt = 0;
      sessionInfoInFlight = null;
      tasteCache.clear();
      tasteInFlight.clear();
      autoMarkedInSession.clear();
      autoMarkInFlight.clear();
      completionMetadataRefreshedInSession.clear();
      completionMetadataRefreshInFlight.clear();
      for (const key of Object.keys(autoMarkRetryAt)) delete autoMarkRetryAt[key];
      for (const key of Object.keys(completionMetadataRefreshRetryAt)) {
        delete completionMetadataRefreshRetryAt[key];
      }
    },
    syncProgress: maybeSyncProgress,
    finalizeRemovedTab,
    stateForTab(tabId) {
      return stateByTab[String(tabId)] || null;
    },
    async manualHistoryPlayerForTab(tabId) {
      const state = stateByTab[String(tabId)] || null;
      return state ? historyPlayerForManualSync(state, await loadHistory()) : null;
    },
    dropTabState(tabId) {
      delete stateByTab[String(tabId)];
    },
  });
}
