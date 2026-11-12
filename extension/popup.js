(async function renderPopup() {
  let localWriteRevision = null;
  const requestBackground = (type, input = {}) => chrome.runtime.sendMessage({
    type, ...input, ...(localWriteRevision ? { expectedRevision: localWriteRevision } : {}),
  });
  async function updatePreferences(operation, input = {}) {
    const response = await requestBackground('popup-update-preferences', { operation, ...input });
    if (!response?.ok || !response.payload?.localWriteRevision) throw new Error('write_binding_changed');
    localWriteRevision = response.payload.localWriteRevision;
    return response;
  }
  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
  const uiLanguage = chrome.i18n.getUILanguage?.() || navigator.language || 'en';
  const siteLocale = /^ru(?:-|$)/iu.test(uiLanguage) ? 'ru' : 'en';
  const dateLocale = siteLocale === 'ru' ? 'ru-RU' : 'en-US';
  const pluralCategory = (value) => {
    if (siteLocale !== 'ru') return value === 1 ? 'One' : 'Many';
    const lastTwo = value % 100;
    if (lastTwo >= 11 && lastTwo <= 14) return 'Many';
    const last = value % 10;
    if (last === 1) return 'One';
    if (last >= 2 && last <= 4) return 'Few';
    return 'Many';
  };
  const countLabel = (base, value) => `${value} ${t(`${base}${pluralCategory(value)}`)}`;

  document.documentElement.lang = siteLocale;
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll('[data-i18n-title]')) {
    element.title = t(element.dataset.i18nTitle);
  }
  for (const element of document.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  }
  let siteBase = 'https://anireko.com';
  try {
    const runtimeInfo = await requestBackground('popup-runtime-info');
    if (runtimeInfo?.ok && runtimeInfo.payload?.siteBase) {
      siteBase = runtimeInfo.payload.siteBase;
      localWriteRevision = runtimeInfo.payload.localWriteRevision || null;
    }
  } catch { /* keep the fixed production link if the worker is restarting */ }
  const requestedTabId = Number(new URLSearchParams(location.search).get('tabId'));
  let tab = null;
  if (Number.isInteger(requestedTabId) && requestedTabId > 0) {
    try {
      tab = await chrome.tabs.get(requestedTabId);
    } catch { /* tab may close between opening and rendering the popup */ }
  }
  if (!tab) {
    try {
      tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
    } catch { /* browser window may be closing */ }
  }
  const key = tab?.id ? `tab:${tab.id}` : '';
  const SYNC_ACCOUNT_KEY = 'sync-account';
  const PRIVACY_CONSENT_KEY = 'privacy-consent';
  const PRIVACY_CONSENT_VERSION = 1;
  const stored = await chrome.storage.local.get([
    'watch-history', 'auto-mark', SYNC_ACCOUNT_KEY,
    PRIVACY_CONSENT_KEY,
  ]);
  const set = (id, value) => { document.getElementById(id).textContent = value ?? '—'; };
  const consent = stored[PRIVACY_CONSENT_KEY];
  const consentAccepted = consent?.version === PRIVACY_CONSENT_VERSION
    && Number.isFinite(consent.acceptedAt);
  // Persisted tab state can outlive the detector after an extension update.
  // Check the top document itself, not an arbitrary responding player frame.
  let detectorConnected = false;
  let detectorDocumentToken = null;
  const pageSupported = /^https?:\/\//iu.test(tab?.url || '');
  if (consentAccepted && pageSupported && Number.isInteger(tab?.id)) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id,
        { type: 'anireko-detector-status' }, { frameId: 0 });
      detectorConnected = reply?.ok === true && reply.documentUrl === tab.url
        && typeof reply.documentToken === 'string' && reply.documentToken.length > 0;
      if (detectorConnected) detectorDocumentToken = reply.documentToken;
    } catch { /* no receiver, revoked access, or an invalidated old context */ }
  }
  const sessionStored = key ? await chrome.storage.session.get(key) : {};
  const state = sessionStored[key];
  const displayFingerprint = (value) => JSON.stringify([
    Boolean(value),
    Boolean(value?.probe),
    value?.navigationToken || null,
    value?.pageUrl || null,
    value?.recognition?.title || null,
    value?.match || null,
    value?.player ? {
      player: value.player.player || null,
      playbackStarted: value.player.playbackStarted === true,
      playing: value.player.playing === true,
      watched: value.player.watched === true,
      duration: Number.isFinite(value.player.duration) ? value.player.duration : null,
      episode: value.player.episode ?? null,
      playbackRate: Number.isFinite(value.player.playbackRate) ? value.player.playbackRate : 1,
    } : null,
    value?.episode || null,
    value?.voice || null,
  ]);
  const initialDisplayFingerprint = displayFingerprint(state);
  let pauseSessionStateReload = false;
  if (key) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'session' || !changes[key]?.newValue) return;
      if (pauseSessionStateReload) return;
      const nextState = changes[key].newValue;
      if (displayFingerprint(nextState) !== initialDisplayFingerprint) {
        location.reload();
        return;
      }
      const progressElement = document.getElementById('progress');
      if (progressElement) {
        progressElement.textContent = nextState.player?.progress == null
          ? '—'
          : `${(nextState.player.progress * 100).toFixed(1)}%`;
      }
    });
  }

  const privacyHref = `${siteBase}/${siteLocale}/privacy#browser-extension`;
  document.getElementById('privacy-policy').href = privacyHref;
  document.getElementById('privacy-link').href = privacyHref;
  const disclosure = document.getElementById('privacy-disclosure');
  disclosure.hidden = consentAccepted;
  document.getElementById('diagnostics-consent').checked = consent?.diagnostics === true;
  document.getElementById('privacy-accept').addEventListener('click', async () => {
    try {
      await updatePreferences('accept-consent', { diagnostics: document.getElementById('diagnostics-consent').checked });
      if (Number.isInteger(tab?.id)) await chrome.tabs.reload(tab.id).catch(() => {});
      window.close();
    } catch { document.getElementById('privacy-accept').textContent = t('syncFailed'); }
  });
  document.getElementById('privacy-decline').addEventListener('click', async () => {
    try {
      await updatePreferences('decline-consent');
      window.close();
    } catch { document.getElementById('privacy-decline').textContent = t('syncFailed'); }
  });

  const deleteLocalDataButton = document.getElementById('delete-local-data');
  deleteLocalDataButton.addEventListener('click', async () => {
    if (!confirm(t('confirmDeleteLocalData'))) return;
    deleteLocalDataButton.disabled = true;
    try {
      const response = await requestBackground('popup-delete-local-data');
      if (!response?.ok) throw new Error('local_clear_failed');
      location.reload();
    } catch {
      deleteLocalDataButton.textContent = t('syncFailed');
      deleteLocalDataButton.disabled = false;
    }
  });
  deleteLocalDataButton.dataset.ready = 'true';
  deleteLocalDataButton.disabled = false;

  // The site cookie is shared with the extension, but sync is additionally
  // pinned to one user id. Logging into a support/demo account replaces the
  // cookie for the whole Chrome profile; without this explicit binding an
  // already-enabled extension would silently change the write target.
  const autoMarkToggle = document.getElementById('auto-mark');
  autoMarkToggle.checked = false;
  document.getElementById('resume-sync').disabled = true;
  let syncAccountActive = false;
  let currentUserId = null;

  async function renderAccount() {
    const label = document.getElementById('account-label');
    const login = document.getElementById('account-login');
    const warning = document.getElementById('account-warning');
    const syncButton = document.getElementById('resume-sync');
    login.href = siteBase;
    try {
      const response = await requestBackground('popup-session-info');
      const payload = response?.payload;
      // This background-owned capability also covers local controls for guests;
      // a 401 account response must not strand clear behind the old account epoch.
      if (typeof payload?.localWriteRevision === 'string') {
        localWriteRevision = payload.localWriteRevision;
      }
      if (response?.ok && payload?.success && payload.user) {
        currentUserId = Number(payload.user.id);
        const bound = stored[SYNC_ACCOUNT_KEY];
        const boundUserId = Number(bound?.id);
        const sameAccount = Number.isInteger(boundUserId) && boundUserId === currentUserId;
        syncAccountActive = sameAccount && stored['auto-mark'] === true;
        const profile = document.createElement('a');
        profile.className = 'profile-link';
        profile.href = `${siteBase}/${siteLocale}/profile`;
        profile.target = '_blank';
        profile.rel = 'noopener';
        profile.textContent = payload.user.name || t('profileFallback');
        label.replaceChildren(`${t('accountOnSite')} `, profile);
        autoMarkToggle.disabled = false;
        autoMarkToggle.checked = syncAccountActive;
        if (!sameAccount) {
          const boundName = bound?.name ? t('quotedName', bound.name) : t('otherAccount');
          warning.hidden = false;
          warning.textContent = bound?.id
            ? t('syncPausedBoundAccount', [boundName, payload.user.name || t('currentAccount')])
            : t('syncNotBound');
          syncButton.disabled = true;
        }
        autoMarkToggle.addEventListener('change', async () => {
          const previouslyActive = syncAccountActive;
          autoMarkToggle.disabled = true;
          try {
          if (!autoMarkToggle.checked) {
            await updatePreferences('disable-sync');
            syncAccountActive = false;
            syncButton.disabled = true;
            return;
          }
          if (bound?.id && !sameAccount) {
            const accepted = confirm(
              t('confirmSwitchSync', [bound.name || String(bound.id), payload.user.name || String(payload.user.id)])
            );
            if (!accepted) {
              autoMarkToggle.checked = false;
              return;
            }
          }
          await updatePreferences('enable-sync', { expectedUserId: currentUserId });
          location.reload();
          } catch {
            autoMarkToggle.checked = previouslyActive;
            warning.hidden = false;
            warning.textContent = t('syncFailed');
          } finally { autoMarkToggle.disabled = false; }
        });
        return;
      }
    } catch { /* offline / API error — treat as not connected */ }
    label.textContent = t('authorizationViaSite');
    login.hidden = false;
    autoMarkToggle.disabled = true;
    autoMarkToggle.checked = false;
    autoMarkToggle.title = t('loginRequiredTitle');
    syncButton.disabled = true;
    syncButton.title = t('loginRequiredSyncTitle');
  }
  function setCheck(id, kind, icon, title, detail) {
    const card = document.getElementById(id);
    card.classList.remove('pending', 'success', 'waiting');
    card.classList.add(kind);
    card.querySelector('.check-icon').textContent = icon;
    set(`${id}-title`, title);
    set(`${id}-detail`, detail);
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  let selectedActivityDate = null;
  function activityTime(seconds) {
    const value = Math.floor(seconds);
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  }
  function renderStats(history) {
    const now = new Date();
    const today = history?.days?.[dateKey(now)];
    set('today-time', typeof today?.watchedSeconds === 'number' && Number.isFinite(today.watchedSeconds) && today.watchedSeconds >= 0
      ? t('minutesShort', String(Math.floor(today.watchedSeconds / 60))) : t('activityUnknown'));
    set('today-episodes', countLabel('episodeCount', Array.isArray(today?.episodeKeys) ? today.episodeKeys.length : 0));
    document.getElementById('today-episodes').title = t('activityEpisodesDetail');
    const days = AniRekoActivity.calendar(history, now);
    const chart = document.getElementById('week-chart');
    if (!days.some(day => dateKey(day.date) === selectedActivityDate)) selectedActivityDate = dateKey(now);
    const showDay = (day, label) => {
      selectedActivityDate = dateKey(day.date);
      set('activity-detail', label);
      const entries = document.getElementById('activity-entries');
      entries.replaceChildren();
      const storedDay = history?.days?.[selectedActivityDate];
      if (!Array.isArray(storedDay?.details)) {
        const note = document.createElement('p');
        note.textContent = t('activityDetailsUnavailable');
        entries.append(note);
      } else {
        if (storedDay.detailsPartial) {
          const note = document.createElement('p');
          note.textContent = t('activityDetailsPartial');
          entries.append(note);
        }
        for (const detail of storedDay.details) {
          if (!detail || typeof detail.title !== 'string') continue;
          const row = document.createElement('div');
          row.className = 'activity-entry';
          const title = document.createElement('strong');
          title.textContent = detail.title;
          row.append(title);
          const metadata = document.createElement('p');
          const parts = [detail.episode == null ? t('activityFull') : t('episodeLabel', String(detail.episode))];
          if (detail.voice) parts.push(detail.voice);
          if (Number.isFinite(detail.watchedSeconds) && detail.watchedSeconds >= 0) parts.push(detail.watchedSeconds === 0
            ? t('activityObservedNoTime') : detail.watchedSeconds < 60
              ? t('activityWatchedSeconds', String(detail.watchedSeconds))
              : t('activityWatched', String(Math.floor(detail.watchedSeconds / 60))));
          metadata.textContent = parts.join(' · ');
          row.append(metadata);
          if (Number.isFinite(detail.position) && detail.position >= 0) {
            const position = activityTime(detail.position);
            const duration = Number.isFinite(detail.duration) && detail.duration > 0 ? activityTime(detail.duration) : null;
            const positionLine = document.createElement('p');
            positionLine.textContent = duration === null ? t('activityLastPosition', position)
              : t('activityPositionWithDuration', [position, duration]);
            row.append(positionLine);
          }
          entries.append(row);
        }
      }
      for (const cell of chart.children) cell.setAttribute('aria-pressed', String(cell.activityDate === selectedActivityDate));
    };
    chart.replaceChildren(...days.map((day, index) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `activity-cell level-${day.level ?? 'unknown'}${day.today ? ' today' : ''}`;
      const label = `${day.date.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })} · ${day.seconds === null
        ? t('activityUnknown') : t('minutesShort', String(Math.floor(day.seconds / 60)))}`;
      cell.title = label;
      cell.setAttribute('aria-label', label);
      cell.activityDate = dateKey(day.date);
      cell.setAttribute('aria-pressed', String(cell.activityDate === selectedActivityDate));
      cell.tabIndex = cell.activityDate === selectedActivityDate ? 0 : -1;
      const showDetail = () => showDay(day, label);
      cell.addEventListener('focus', () => {
        for (const item of chart.children) item.tabIndex = item === cell ? 0 : -1;
        showDetail();
      });
      cell.addEventListener('keydown', (event) => {
        const moves = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1
          : Object.hasOwn(moves, event.key) ? Math.max(0, Math.min(days.length - 1, index + moves[event.key])) : null;
        if (target !== null) {
          event.preventDefault();
          chart.children[target].focus();
        }
      });
      cell.addEventListener('click', showDetail);
      return cell;
    }));
    const selected = days.find(day => dateKey(day.date) === selectedActivityDate);
    if (selected) {
      const label = `${selected.date.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })} · ${selected.seconds === null
        ? t('activityUnknown') : t('minutesShort', String(Math.floor(selected.seconds / 60)))}`;
      showDay(selected, label);
    }
  }

  const reportSection = document.getElementById('not-found-report');
  const reportButton = document.getElementById('report-anime-miss');
  const reportDetail = document.getElementById('report-anime-miss-detail');
  const animeDetailIds = [
    'player-check', 'stats-card', 'anime-fields', 'hint', 'account',
    'account-warning', 'automark',
  ];

  function renderAnimeNotFound(canReport) {
    setCheck('anime-check', 'pending', '·', t('animeNotFoundTitle'), t('animeNotFoundDetail'));
    for (const id of animeDetailIds) document.getElementById(id).hidden = true;
    reportSection.hidden = false;
    reportButton.disabled = !canReport;
    if (!canReport) {
      reportDetail.textContent = t('reloadBeforeReport');
    }
  }

  function renderPageUnavailable(title, detail, canReload = false) {
    setCheck('anime-check', 'pending', '·', t(title), t(detail));
    for (const id of animeDetailIds) document.getElementById(id).hidden = true;
    reportSection.hidden = true;
    reportButton.disabled = true;
    const recovery = document.getElementById('page-recovery');
    recovery.hidden = !canReload;
    document.getElementById('reload-page').addEventListener('click', async () => {
      if (!confirm(t('confirmReloadPage'))) return;
      try {
        await chrome.tabs.reload(tab.id);
        window.close();
      } catch {
        document.getElementById('page-recovery-detail').textContent = t('reloadPageFailed');
      }
    });
  }

  reportButton.addEventListener('click', async () => {
    if (reportButton.disabled || !Number.isInteger(tab?.id)) return;
    reportButton.disabled = true;
    reportButton.textContent = t('sending');
    reportDetail.className = '';
    try {
      const response = await requestBackground('popup-report-recognition-miss', { tabId: tab.id });
      if (!response?.ok) throw new Error('report_failed');
      if (response.payload?.pending) {
        reportButton.textContent = t('reportAlreadySending');
        reportDetail.textContent = t('waitForCurrentReport');
        return;
      }
      reportButton.textContent = response.payload?.duplicate ? t('reportAlreadySent') : t('reportSent');
      reportDetail.textContent = response.payload?.duplicate
        ? t('reportDuplicateDetail')
        : t('reportSuccessDetail');
      reportDetail.className = 'ok';
    } catch {
      reportButton.disabled = false;
      reportButton.textContent = t('retrySend');
      reportDetail.textContent = t('reportFailedDetail');
      reportDetail.className = 'warn';
    }
  });

  if (!consentAccepted) {
    renderPageUnavailable('consentRequiredTitle', 'syncOffUntilConsent');
    return;
  }
  if (!pageSupported) {
    renderPageUnavailable('unsupportedPageTitle', 'unsupportedPageDetail');
    return;
  }
  if (!detectorConnected) {
    renderPageUnavailable('detectorDisconnectedTitle', 'detectorDisconnectedDetail', true);
    return;
  }
  if (!state || state.navigationToken !== detectorDocumentToken || state.pageUrl !== tab.url) {
    renderPageUnavailable('findingAnimePage', 'checkingPageMetadata');
    return;
  }
  const recognition = state.recognition;
  const player = state.player;
  const players = Object.values(state.players || {});
  const animeFound = Boolean(recognition?.title);
  if (!animeFound && !state.probe) {
    renderPageUnavailable('findingAnimePage', 'checkingPageMetadata');
    return;
  }
  if (!animeFound) {
    renderAnimeNotFound(Boolean(state.probe && Number.isInteger(tab?.id)));
    return;
  }
  reportSection.hidden = true;
  for (const id of animeDetailIds) document.getElementById(id).hidden = false;
  document.getElementById('account-warning').hidden = true;
  renderStats(stored['watch-history']);
  const playerFound = Boolean(player);
  // Episode is optional — movies and unmarked players are still fully tracked.
  const playerReady = playerFound
    && player.playbackStarted === true
    && Number.isFinite(player.currentTime)
    && Number.isFinite(player.duration)
    && player.duration > 0;
  const match = state.match;
  const matchConfirmed = match?.status === 'ok' && (match.exact === true || match.manual === true);

  setCheck(
    'anime-check',
    matchConfirmed ? 'success' : animeFound ? 'waiting' : 'pending',
    matchConfirmed ? '✓' : animeFound ? '?' : '·',
    matchConfirmed ? t('animeFoundTitle') : animeFound ? t('catalogMatchRequiredTitle') : t('animeNotConfirmedTitle'),
    animeFound ? recognition.title : t('metadataTitleMissing')
  );
  setCheck(
    'player-check',
    playerReady ? 'success' : playerFound ? 'waiting' : 'pending',
    playerReady ? '✓' : playerFound ? '▶' : '·',
    playerReady ? t('playerReadyTitle') : playerFound ? t('playerWaitingTitle') : t('playerMissingTitle'),
    playerReady
      ? `${player.episode != null ? t('episodeLabel', String(player.episode)) : t('movieUnmarked')} · ${t('minutesShort', String(Math.round(player.duration / 60)))} · ${t('timingReadable')}`
      : playerFound ? t('playToReadTiming') : t('checkingHtml5Frames')
  );
  // Unreadable-player diagnostics are auto-reported by the service worker
  // (KAN-2715) — no user action needed, so no UI for it here.
  set('title', recognition?.title);
  const primaryAction = document.getElementById('anime-primary-action');
  if (match?.status === 'ok' && match.slug) {
    primaryAction.href = `${siteBase}/${siteLocale}/anime/${match.slug}-${match.animeId}`;
    primaryAction.hidden = false;
    set('anireko-match', `${t('catalogPrefix')} ${match.title}${match.year ? ` (${match.year})` : ''}${match.manual ? ` · ${t('manualMatchMark')}` : ''}`);
  } else {
    primaryAction.hidden = true;
    set('anireko-match', match?.status === 'ambiguous'
      ? t('catalogMatchNotConfirmed')
      : match?.status === 'none' ? t('catalogNotFoundForTitle', recognition.title)
        : match?.status === 'error' ? t('searchError') : null);
  }

  const resolution = document.getElementById('match-resolution');
  const resolutionTitle = document.getElementById('match-resolution-title');
  const resolutionDetail = document.getElementById('match-resolution-detail');
  const candidatesElement = document.getElementById('match-candidates');
  const searchForm = document.getElementById('match-search');
  const searchInput = document.getElementById('match-search-query');
  const searchButton = searchForm.querySelector('button');
  const changeButton = document.getElementById('match-change');
  const resetButton = document.getElementById('match-reset');
  const feedback = document.getElementById('match-feedback');
  searchInput.placeholder = t('searchAniRekoPlaceholder');
  searchInput.value = recognition.title;

  function candidateMeta(candidate) {
    return [candidate.subtitle, candidate.year, candidate.type]
      .filter(Boolean)
      .join(' · ');
  }

  async function bindCandidate(candidate, query) {
    for (const button of resolution.querySelectorAll('button')) button.disabled = true;
    feedback.textContent = t('bindingAnime');
    try {
      const response = await requestBackground('popup-bind-anime', {
        tabId: tab?.id,
        animeId: candidate.animeId,
        query,
      });
      if (!response?.ok) throw new Error(response?.payload?.error || 'bind_failed');
      feedback.textContent = t('animeBound');
      location.reload();
    } catch {
      feedback.textContent = t('animeBindFailed');
      for (const button of resolution.querySelectorAll('button')) button.disabled = false;
    }
  }

  function renderCandidates(candidates, query) {
    candidatesElement.replaceChildren(...(candidates || []).map((candidate) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'match-candidate';
      const copy = document.createElement('span');
      copy.className = 'match-candidate-copy';
      const title = document.createElement('strong');
      title.textContent = candidate.title;
      const meta = document.createElement('span');
      meta.textContent = candidateMeta(candidate);
      copy.append(title, meta);
      const action = document.createElement('span');
      action.className = 'match-candidate-action';
      action.textContent = t('chooseThisAnime');
      button.append(copy, action);
      button.addEventListener('click', () => bindCandidate(candidate, query));
      return button;
    }));
  }

  function openCorrection() {
    resolution.hidden = false;
    resolutionTitle.textContent = t('changeAnimeTitle');
    resolutionDetail.textContent = t('changeAnimeDetail', match.title);
    resetButton.hidden = !match.manual;
    searchInput.focus();
  }

  if (matchConfirmed) {
    changeButton.hidden = false;
    changeButton.addEventListener('click', openCorrection);
  } else {
    resolution.hidden = false;
    if (match?.status === 'ambiguous') {
      resolutionTitle.textContent = t('chooseAnimeTitle');
      resolutionDetail.textContent = t('chooseAnimeDetail', recognition.title);
      renderCandidates(match.candidates, match.query || recognition.title);
    } else {
      resolutionTitle.textContent = t('findAnimeManuallyTitle');
      resolutionDetail.textContent = t('findAnimeManuallyDetail', recognition.title);
    }
  }

  searchForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (query.length < 2) return;
    searchButton.disabled = true;
    feedback.textContent = t('searchingAniReko');
    try {
      const response = await requestBackground('popup-search-anime', { query });
      if (!response?.ok) throw new Error('search_failed');
      const candidates = response.payload?.candidates || [];
      renderCandidates(candidates, query);
      feedback.textContent = candidates.length ? '' : t('manualSearchEmpty', query);
    } catch {
      feedback.textContent = t('searchError');
    } finally {
      searchButton.disabled = false;
    }
  });

  resetButton.addEventListener('click', async () => {
    resetButton.disabled = true;
    feedback.textContent = t('resettingManualMatch');
    try {
      const response = await requestBackground('popup-unbind-anime', { tabId: tab?.id });
      if (!response?.ok) throw new Error('unbind_failed');
      location.reload();
    } catch {
      feedback.textContent = t('animeBindFailed');
      resetButton.disabled = false;
    }
  });
  // Compatibility is supporting context here; the anime page is the popup's
  // single primary destination, so we deliberately avoid a competing link.
  // Publish validated local fields before any account/history network wait.
  const episode = player?.episode ?? recognition?.episode;
  set('episode', episode != null ? t('episodeLabel', String(episode)) : t('episodeUnknown'));
  set('voice', state.voice || recognition?.voice);
  set('player', player?.player);
  const playerCount = players.length || (player?.player === 'iframe-shell' ? 1 : null);
  set('player-count', playerCount);
  document.getElementById('player-count-label').textContent = playerCount
    ? ` ${t(`playerCount${pluralCategory(playerCount)}`)}`
    : '';
  const rate = Number.isFinite(player?.playbackRate) ? player.playbackRate : 1;
  const rateSuffix = rate !== 1 ? ` ×${rate}` : '';
  set('status', player?.watched ? t('statusWatched')
    : player?.playing ? `${t('statusWatching')}${rateSuffix}`
      : player?.playbackStarted ? `${t('statusPaused')}${rateSuffix}` : playerFound ? t('statusWaiting') : null);
  document.getElementById('status').className = `status-chip${player?.watched ? ' ok' : ''}`;
  set('progress', player?.progress == null ? null : `${(player.progress * 100).toFixed(1)}%`);
  const hint = document.getElementById('hint');
  if (playerReady) hint.hidden = true;
  else set('hint', matchConfirmed
    ? t('animeFoundPlayVideo')
    : t('catalogMatchNotConfirmed'));

  await renderAccount();
  const taste = state.taste;
  const tasteAccountCurrent = Number.isInteger(currentUserId) && currentUserId > 0
    && taste?.userKey === `user:${currentUserId}`
    && Number(taste.animeId) === Number(match?.animeId);
  const tasteElement = document.getElementById('taste-match');
  if (tasteAccountCurrent && taste.status === 'ok' && Number.isFinite(taste.percent)) {
    const verdicts = {
      very_likely: t('verdictVeryLikely'),
      likely: t('verdictLikely'),
      mixed: t('verdictMixed'),
      unlikely: t('verdictUnlikely'),
    };
    const colors = {
      very_likely: '#4ecdc4',
      likely: '#8bc34a',
      mixed: '#ffd93d',
      unlikely: '#ff6b6b',
    };
    const percent = document.createElement('strong');
    percent.style.color = colors[taste.labelKey] || colors.mixed;
    percent.textContent = `${taste.percent}%`;
    tasteElement.replaceChildren(percent, ` · ${verdicts[taste.labelKey] || verdicts.mixed}`);
  } else {
    set('taste-match', taste?.status === 'guest' ? t('loginForMatch')
      : tasteAccountCurrent && taste.status === 'no-data' ? t('notEnoughTasteData')
        : null);
  }
  // «Где остановился» (KAN-2725): открыл это аниме на любом сайте → сразу видно
  // серию/позицию/озвучку. Источники по приоритету (щадим сервер):
  // 1) resume-bulk кэш (весь прогресс юзера одной картой: bulk-GET `?all=1`
  //    не чаще раза в 30 мин + обновляется нашими же POST-ами);
  // 2) локальная история браузера (гость/оффлайн).
  // Пока видео активно играет — строка не нужна (инфа живёт в «Прогресс») и
  // сеть не дёргаем вовсе. Кнопка «Синхронизировать» форсит bulk-GET с
  // кулдауном 60с (кейс: только что смотрел с другого устройства).
  const RESUME_BULK_TTL_MS = 30 * 60 * 1000;
  const SYNC_COOLDOWN_MS = 60 * 1000;
  // Unknown/adopted history must never borrow a previous cycle's legacy resume.
  let watchProjection = null;
  const watchCard = document.getElementById('watch-cycle-card');
  const watchFeedback = document.getElementById('watch-feedback');
  const watchActions = document.getElementById('watch-actions');
  async function renderWatchCycle() {
    if (!matchConfirmed || !syncAccountActive) return;
    watchProjection = null;
    await renderResume(false);
    watchCard.hidden = false;
    for (const node of [...Array.from(watchActions.children), ...watchActions.querySelectorAll('details')]) {
      if (node.tagName === 'DETAILS' && node.watchDisclosure) {
        watchActions[node.watchDisclosure] = node.open;
      }
    }
    watchActions.replaceChildren();
    try {
      const response = await requestBackground('popup-watch-history', { tabId: tab?.id });
      if (!response?.ok || !response.payload?.snapshot) throw new Error('history_unavailable');
      watchProjection = response.payload;
      const snapshot = watchProjection.snapshot;
      if (snapshot.history_adopted !== false) {
        document.getElementById('resume-label').hidden = true;
        const legacyResume = document.getElementById('resume');
        legacyResume.hidden = true;
        legacyResume.textContent = '';
      }
      const origins = [...(snapshot.origins || []), ...(snapshot.selected_origin ? [snapshot.selected_origin] : [])];
      const currentOrigin = origins.find((origin) => origin.state?.current?.cycle_id === snapshot.foreground?.cycle_id);
      let completion = snapshot.previously_completed ? t('watchPreviouslyCompleted') : '';
      // Component totals are tracked completions, not an invented lifetime total.
      const count = snapshot.totals?.completed;
      if (Number.isSafeInteger(count) && count > 0) {
        completion += `${completion ? ' · ' : ''}${t('watchTrackedCompletions', String(count))}`;
      }
      set('watch-completion', completion);
      const current = currentOrigin?.state?.current;
      const parts = [];
      if (snapshot.readiness !== 'ready') parts.push(t('watchReconciliation'));
      else if (current) {
        parts.push(t(current.kind === 'rewatching' ? 'watchRewatching' : 'statusWatching'));
        if (current.episode != null) parts.push(t('episodeLabel', String(current.episode)));
        if (currentOrigin.anime_id !== snapshot.requested_anime_id) parts.push(t('watchOtherTitle'));
      } else {
        parts.push(t('watchNoActiveCycle'));
        const paused = origins.filter((origin) => origin.state?.current?.status === 'paused');
        const seenPaused = new Set();
        for (const origin of paused) {
          const cycle = origin.state.current;
          if (seenPaused.has(cycle.cycle_id)) continue;
          seenPaused.add(cycle.cycle_id);
          parts.push(t('watchPaused')
            + (cycle.episode == null ? '' : ` · ${t('episodeLabel', String(cycle.episode))}`));
        }
      }
      set('watch-current', parts.join(' · '));
      watchFeedback.textContent = '';
      const run = async (type, input) => {
        for (const button of watchActions.querySelectorAll('button')) button.disabled = true;
        pauseSessionStateReload = true;
        watchFeedback.textContent = t('syncUpdating');
        watchProjection = null;
        await renderResume(false);
        let failed = false;
        try {
          const result = await requestBackground(type, input);
          if (!result?.ok) throw new Error('command_unresolved');
          watchFeedback.textContent = '';
        } catch { failed = true; }
        finally {
          await renderWatchCycle();
          await renderResume(false);
          if (failed && !watchProjection?.pending) {
            watchFeedback.textContent = [watchFeedback.textContent, t('watchActionFailed')].filter(Boolean).join(' · ');
          }
          pauseSessionStateReload = false;
        }
      };
      if (watchProjection.pending) {
        watchFeedback.textContent = t('watchCommandUnresolved');
        const original = watchProjection.pendingIntent;
        if (!original) watchFeedback.textContent += ` · ${t('watchPendingOtherAccount')}`;
        if (original || watchProjection.settlementCapabilityId) {
          const details = document.createElement('details');
          details.watchDisclosure = 'pendingDetailsOpen';
          details.open = !!watchActions.pendingDetailsOpen;
          const summary = document.createElement('summary');
          summary.textContent = t('watchPendingDetails');
          details.append(summary);
          if (watchProjection.settlementCapabilityId) {
            const hint = document.createElement('p');
            hint.className = 'watch-choice-hint';
            hint.textContent = t('watchSettlementHint');
            const check = document.createElement('button');
            check.type = 'button';
            check.textContent = t('watchSettleOriginal');
            const capabilityId = watchProjection.settlementCapabilityId;
            check.addEventListener('click', () => run('popup-watch-settle', { capabilityId }));
            details.append(hint); details.append(check);
          }
          if (original) {
            const target = document.createElement('p');
            target.textContent = `${t('watchOriginalTarget', String(original.animeId))} · ${t(`watchAction_${original.action}`)}`;
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.textContent = t('watchRetryOriginal');
            retry.addEventListener('click', () => run('popup-watch-retry', { commandId: original.commandId }));
            details.append(target); details.append(retry);
          }
          watchActions.append(details);
        }
      } else {
        if (watchProjection.repairComplete === false) watchFeedback.textContent = t('watchChoicesIncomplete');
        let manualActions = null;
        for (const action of watchProjection.actions || []) {
          if (action.command === 'reconcile') {
            const selected = new Map();
            const groups = action.groups || [];
            const hint = document.createElement('p');
            hint.className = 'watch-choice-hint';
            hint.textContent = t('watchChoicesHint');
            watchActions.append(hint);
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.textContent = t('watchAction_reconcile');
            apply.disabled = groups.length > 0;
            groups.forEach((group, index) => {
              const fieldset = document.createElement('fieldset');
              fieldset.className = 'watch-choice-group';
              const legend = document.createElement('legend');
            legend.textContent = group.catalog?.title_ru || group.catalog?.title
                || group.catalog?.title_en || t('watchChoiceGroup', String(index + 1));
              fieldset.append(legend);
              for (const [optionIndex, option] of group.options.entries()) {
                const label = document.createElement('label');
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = `watch-choice-${index}`;
                radio.value = option.cycleId;
                radio.checked = false;
                const detail = document.createElement('span');
                detail.textContent = [t(option.kind === 'rewatching' ? 'watchRewatching' : 'statusWatching'),
                  t('watchChoiceOption', String(optionIndex + 1)),
                  t('watchTrackedCycle', String(option.ordinal)),
                  ...(option.episode == null ? [] : [t('episodeLabel', String(option.episode))])].join(' · ');
                radio.addEventListener('change', () => {
                  if (!radio.checked) return;
                  selected.set(index, option.cycleId);
                  apply.disabled = selected.size !== groups.length;
                });
                label.append(radio);
                label.append(detail);
                fieldset.append(label);
                const identity = document.createElement('details');
                identity.watchDisclosure = `choice:${option.cycleId}`;
                identity.open = !!watchActions[identity.watchDisclosure];
                const identitySummary = document.createElement('summary');
                identitySummary.textContent = t('watchChoiceDetails', String(optionIndex + 1));
                const identityText = document.createElement('p');
                identityText.textContent = [t('watchOriginalTarget', String(option.animeId)),
                  t('watchHistoryIdentity', String(option.historyId))].join(' · ');
                identity.append(identitySummary); identity.append(identityText);
                fieldset.append(identity);
              }
              watchActions.append(fieldset);
            });
            apply.addEventListener('click', () => {
              if (apply.disabled || selected.size !== groups.length) return;
              run('popup-watch-command', { capabilityId: action.capabilityId,
                choiceCycleIds: groups.map((_, index) => selected.get(index)) });
            });
            watchActions.append(apply);
            continue;
          }
          const label = t(`watchAction_${action.command}`);
          const suffix = action.ordinal == null ? '' : ` · ${t('watchTrackedCycle', String(action.ordinal))}`;
          if (!manualActions) {
            manualActions = document.createElement('details');
            manualActions.watchDisclosure = 'manualControlsOpen';
            manualActions.open = !!watchActions.manualControlsOpen;
            const summary = document.createElement('summary');
            summary.textContent = t('watchManualControls');
            manualActions.append(summary);
            watchActions.append(manualActions);
          }
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label + suffix;
          button.addEventListener('click', () => run('popup-watch-command', { capabilityId: action.capabilityId }));
          manualActions.append(button);
        }
      }
    } catch {
      watchProjection = null;
      document.getElementById('resume-label').hidden = true;
      document.getElementById('resume').hidden = true;
      document.getElementById('resume').textContent = '';
      set('watch-completion', t('watchHistoryUnavailable'));
      set('watch-current', t('watchNoLegacyFallback'));
    }
  }
  await renderWatchCycle();

  async function loadResumeBulk(force) {
    if (!syncAccountActive || !Number.isInteger(currentUserId)) {
      return { userId: null, byAnime: {}, fetchedAt: 0 };
    }
    const cacheStored = await chrome.storage.local.get('resume-bulk');
    const cached = cacheStored['resume-bulk'];
    const bulk = cached?.userId === currentUserId
      ? cached
      : { userId: currentUserId, byAnime: {}, fetchedAt: 0 };
    if (!force && Date.now() - (bulk.fetchedAt || 0) < RESUME_BULK_TTL_MS) return bulk;
    try {
      const response = await requestBackground('popup-progress-all', {
        expectedUserId: currentUserId,
      });
      if (response?.ok) {
        const payload = response.payload;
        bulk.byAnime = payload?.progress_all || {};
        bulk.fetchedAt = Date.now();
      } else if (response?.status === 401 || response?.status === 409) {
        // Гость: помечаем «спрошено», чтобы не долбить 401 на каждый попап.
        bulk.fetchedAt = Date.now();
      }
      // The SW owns cache persistence and fences late network callbacks.
    } catch { /* offline — живём на локальной истории */ }
    return bulk;
  }

  async function renderResume(force) {
    document.getElementById('resume-label').hidden = true;
    document.getElementById('resume').hidden = true;
    document.getElementById('resume').textContent = '';
    if (!animeFound || player?.playing) return;
    const confirmedAnimeId = match?.status === 'ok'
      ? (typeof match.animeId === 'number' || typeof match.animeId === 'string' ? Number(match.animeId) : NaN)
      : null;
    if (confirmedAnimeId !== null && (!Number.isSafeInteger(confirmedAnimeId) || confirmedAnimeId < 1)) return;
    const fmtTime = (sec) => {
      const s = Math.max(0, Math.round(sec));
      return s >= 3600
        ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
        : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const fmtWhen = (ts) => {
      if (!Number.isFinite(ts)) return null;
      const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);
      if (days <= 0) return t('todayLower');
      if (days === 1) return t('yesterday');
      if (days < 7) return t('daysAgo', String(days));
      return new Date(ts).toLocaleDateString(dateLocale);
    };
    let resume = null;
    const cycleOwned = syncAccountActive && watchProjection?.snapshot?.history_adopted !== false;
    if (cycleOwned) {
      const snapshot = watchProjection?.snapshot;
      if (confirmedAnimeId === null || snapshot?.history_adopted !== true
        || snapshot.readiness !== 'ready' || watchProjection.pending
        || snapshot.user_id !== currentUserId || snapshot.requested_anime_id !== confirmedAnimeId
        || !Number.isSafeInteger(currentUserId) || currentUserId < 1
        || !Array.isArray(snapshot.origins)) return;
      const uuid = (value) => typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
      const origins = new Map();
      for (const origin of [...snapshot.origins, ...(snapshot.selected_origin ? [snapshot.selected_origin] : [])]) {
        if (!uuid(origin?.history_id) || !Number.isSafeInteger(origin.anime_id) || origin.anime_id < 1
          || origin.state?.anime_id !== origin.anime_id || !Number.isSafeInteger(origin.state.version)
          || origin.state.version < 0) return;
        const current = origin.state.current;
        if (current !== null && (!current || !uuid(current.cycle_id)
          || !['active', 'paused'].includes(current.status)
          || !['watching', 'rewatching'].includes(current.kind)
          || !Number.isSafeInteger(current.position_sec) || current.position_sec < 0 || current.position_sec > 259200
          || (current.episode !== null && (!Number.isSafeInteger(current.episode) || current.episode < 1 || current.episode > 5000))
          || (current.voice !== null && (typeof current.voice !== 'string' || Array.from(current.voice).length > 100)))) return;
        const key = origin.history_id + ':' + origin.anime_id;
        const signature = JSON.stringify([origin.state.version, current && [
          current.cycle_id, current.status, current.kind, current.tracked_start_ordinal,
          current.episode, current.position_sec, current.duration_sec, current.voice]]);
        if (origins.has(key) && origins.get(key).signature !== signature) return;
        origins.set(key, { origin, signature });
      }
      const open = [...origins.values()].map(({ origin }) => origin).filter(origin => origin.state.current);
      const foreground = snapshot.foreground?.cycle_id;
      let selected = null;
      if (uuid(foreground)) {
        const matches = open.filter(origin => origin.anime_id === confirmedAnimeId
          && origin.state.current.status === 'active' && origin.state.current.cycle_id === foreground);
        if (matches.length !== 1) return;
        selected = matches[0];
      } else if (foreground === null) {
        const page = snapshot.page;
        if (page?.has_more !== false || page.next !== null || !Number.isSafeInteger(page.origins_total)
          || page.origins_total !== origins.size || open.length !== 1
          || open[0].anime_id !== confirmedAnimeId || open[0].state.current.status !== 'paused') return;
        selected = open[0];
      } else return;
      const current = selected.state.current;
      if (current.position_sec <= 0) return;
      resume = { episode: current.episode, position: current.position_sec, voice: current.voice,
        at: NaN, cycle: true };
      // Historical pagination can omit this row. Its update time is not watch time.
      const rows = (Array.isArray(snapshot.cycles) ? snapshot.cycles : []).filter(row =>
        row?.history_id === selected.history_id && row.cycle?.anime_id === selected.anime_id
        && row.cycle.cycle_id === current.cycle_id && row.cycle.status === current.status
        && ['episode', 'position_sec', 'duration_sec', 'voice'].every(field => row.cycle[field] === current[field]));
      const updatedAt = rows.length === 1 ? rows[0].cycle.updated_at : null;
      if (typeof updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(updatedAt)) {
        const timestamp = Date.parse(updatedAt);
        if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().replace('.000Z', 'Z') === updatedAt) {
          resume.at = timestamp;
        }
      }
    }
    if (!cycleOwned && confirmedAnimeId !== null) {
      const bulk = await loadResumeBulk(force);
      const progress = bulk.byAnime?.[confirmedAnimeId];
      if (progress) {
        resume = {
          episode: progress.episode,
          position: progress.position_sec,
          voice: progress.voice || null,
          at: Date.parse(progress.watched_at),
        };
      }
    }
    if (!cycleOwned && !resume) {
      const titleKey = String(recognition.title).toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
      const records = Object.entries(stored['watch-history']?.records || {})
        .filter(([recordKey, record]) => confirmedAnimeId !== null
          ? (typeof record?.animeId === 'number' || typeof record?.animeId === 'string')
            && Number(record.animeId) === confirmedAnimeId
          : recordKey.startsWith(`${titleKey}::`))
        .map(([, record]) => record)
        .filter((record) => Number.isFinite(record.position) && record.position > 0);
      const last = records.sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0))[0];
      if (last) {
        resume = {
          episode: last.episode,
          position: last.position,
          voice: last.voice || null,
          at: last.lastWatchedAt,
        };
      }
    }
    // A Start/adoption read can finish while the older bulk read awaits.
    if (!cycleOwned && syncAccountActive && watchProjection?.snapshot?.history_adopted !== false) return;
    if (!resume) return;
    const parts = [];
    if (resume.episode != null) parts.push(t('episodeLabel', String(resume.episode)));
    parts.push(fmtTime(resume.position));
    if (resume.voice) parts.push(resume.voice);
    const when = fmtWhen(resume.at);
    if (when) parts.push(resume.cycle ? t('resumeCycleUpdated', when) : when);
    document.getElementById('resume-label').hidden = false;
    const resumeElement = document.getElementById('resume');
    resumeElement.hidden = false;
    resumeElement.textContent = parts.join(' · ');
  }
  renderResume(false);

  // Кнопка ручного синка: force bulk-GET, кулдаун 60с переживает переоткрытие
  // попапа (timestamp в storage) — защита от закликивания.
  (async function bindSyncButton() {
    const syncButton = document.getElementById('resume-sync');
    syncButton.dataset.accountAllowed = syncAccountActive ? '1' : '0';
    if (!syncAccountActive) syncButton.disabled = true;
    const lastAt = (await chrome.storage.local.get('resume-sync-at'))['resume-sync-at'] || 0;
    const remaining = SYNC_COOLDOWN_MS - (Date.now() - lastAt);
    syncButton.disabled = !syncAccountActive || remaining > 0;
    if (remaining > 0) {
      syncButton.disabled = true;
      syncButton.title = t('syncRecently', String(Math.ceil(remaining / 1000)));
      setTimeout(() => {
        syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
        syncButton.title = '';
      }, remaining);
    }
    syncButton.addEventListener('click', async () => {
      if (syncButton.disabled) return;
      pauseSessionStateReload = true;
      syncButton.disabled = true;
      syncButton.textContent = t('syncUpdating');
      watchProjection = null;
      await renderResume(false);
      const resumeSessionReload = () => setTimeout(() => { pauseSessionStateReload = false; }, 500);
      let refreshLegacyBulk = false;
      try {
        let currentResponse = await requestBackground('popup-sync-current', {
          tabId: tab?.id,
          expectedUserId: currentUserId,
        });
        if (!currentResponse?.ok) {
          syncButton.textContent = currentResponse?.payload?.error === 'anime_match_required'
            ? t('chooseAnimeBeforeSync')
            : t('syncFailed');
          setTimeout(() => {
            syncButton.textContent = t('syncButton');
            syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
          }, 2500);
          return;
        }
        if (currentResponse.payload?.confirmationRequired === true) {
          const accepted = confirm(t('confirmLegacyHistorySync', [
            currentResponse.payload.animeTitle || match?.title || recognition?.title || '',
          ]));
          if (!accepted) {
            syncButton.textContent = t('syncButton');
            syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
            return;
          }
          currentResponse = await requestBackground('popup-sync-current', {
            tabId: tab?.id,
            expectedUserId: currentUserId,
            confirmLegacyHistory: true,
          });
          if (!currentResponse?.ok) {
            syncButton.textContent = t('syncFailed');
            setTimeout(() => {
              syncButton.textContent = t('syncButton');
              syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
            }, 2500);
            return;
          }
        }
        const wroteData = currentResponse.payload?.progressSynced === true
          || currentResponse.payload?.statusSynced === true;
        if (currentResponse.payload?.writeFailed === true) {
          syncButton.textContent = t('syncFailed');
          setTimeout(() => {
            syncButton.textContent = t('syncButton');
            syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
          }, 2500);
          return;
        }
        if (!wroteData) {
          syncButton.textContent = t('syncNothingToSend');
          setTimeout(() => {
            syncButton.textContent = t('syncButton');
            syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
          }, 2500);
          return;
        }
        await updatePreferences('mark-resume-sync', { expectedUserId: currentUserId });
        refreshLegacyBulk = true;
        syncButton.textContent = t('syncUpdated');
      } catch {
        syncButton.textContent = t('syncFailed');
        setTimeout(() => {
          syncButton.textContent = t('syncButton');
          syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
        }, 2500);
        return;
      } finally {
        try {
          // Every terminal command result needs a fresh fenced projection, including no-op/cancel/error.
          await renderWatchCycle();
          if (refreshLegacyBulk && watchProjection?.snapshot?.history_adopted === false) await loadResumeBulk(true);
          await renderResume(false);
        } catch { /* Read failures keep resume cleared without changing the command outcome. */ }
        resumeSessionReload();
      }
      setTimeout(() => {
        syncButton.textContent = t('syncButton');
        syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
      }, SYNC_COOLDOWN_MS);
    });
  })();
})();
