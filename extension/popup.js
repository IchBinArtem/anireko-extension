(async function renderPopup() {
  const requestBackground = (type, input = {}) => chrome.runtime.sendMessage({ type, ...input });
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
  const sessionStored = key ? await chrome.storage.session.get(key) : {};
  const state = sessionStored[key];
  const displayFingerprint = (value) => JSON.stringify([
    value?.recognition?.title || null,
    value?.match || null,
    value?.player || null,
    value?.episode || null,
    value?.voice || null,
  ]);
  const initialDisplayFingerprint = displayFingerprint(state);
  let pauseSessionStateReload = false;
  if (key) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'session' || !changes[key]?.newValue) return;
      if (pauseSessionStateReload) return;
      if (displayFingerprint(changes[key].newValue) !== initialDisplayFingerprint) location.reload();
    });
  }

  const privacyHref = `${siteBase}/${siteLocale}/privacy#browser-extension`;
  document.getElementById('privacy-policy').href = privacyHref;
  document.getElementById('privacy-link').href = privacyHref;
  const disclosure = document.getElementById('privacy-disclosure');
  disclosure.hidden = consentAccepted;
  document.getElementById('diagnostics-consent').checked = consent?.diagnostics === true;
  document.getElementById('privacy-accept').addEventListener('click', async () => {
    await chrome.storage.local.set({
      [PRIVACY_CONSENT_KEY]: {
        version: PRIVACY_CONSENT_VERSION,
        acceptedAt: Date.now(),
        diagnostics: document.getElementById('diagnostics-consent').checked,
      },
    });
    if (Number.isInteger(tab?.id)) await chrome.tabs.reload(tab.id).catch(() => {});
    window.close();
  });
  document.getElementById('privacy-decline').addEventListener('click', async () => {
    await chrome.storage.local.set({
      [PRIVACY_CONSENT_KEY]: { version: PRIVACY_CONSENT_VERSION, declinedAt: Date.now() },
    });
    window.close();
  });

  const deleteLocalDataButton = document.getElementById('delete-local-data');
  deleteLocalDataButton.addEventListener('click', async () => {
    if (!confirm(t('confirmDeleteLocalData'))) return;
    await requestBackground('popup-delete-local-data');
    location.reload();
  });
  deleteLocalDataButton.dataset.ready = 'true';
  deleteLocalDataButton.disabled = false;

  // The site cookie is shared with the extension, but sync is additionally
  // pinned to one user id. Logging into a support/demo account replaces the
  // cookie for the whole Chrome profile; without this explicit binding an
  // already-enabled extension would silently change the write target.
  const autoMarkToggle = document.getElementById('auto-mark');
  autoMarkToggle.checked = false;
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
          if (!autoMarkToggle.checked) {
            await chrome.storage.local.set({ 'auto-mark': false });
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
          await chrome.storage.local.set({
            'auto-mark': true,
            [SYNC_ACCOUNT_KEY]: { id: currentUserId, name: payload.user.name || '' },
          });
          await chrome.storage.local.remove(['resume-bulk', 'resume-sync-at']);
          location.reload();
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

  function renderStats(history) {
    const now = new Date();
    const today = history?.days?.[dateKey(now)] || { watchedSeconds: 0, episodeKeys: [] };
    set('today-time', t('minutesShort', String(Math.round(today.watchedSeconds / 60))));
    set('today-episodes', countLabel('episodeCount', today.episodeKeys.length));
    const days = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(now);
      date.setDate(now.getDate() - offset);
      const value = history?.days?.[dateKey(date)]?.watchedSeconds || 0;
      days.push({ date, value, today: offset === 0 });
    }
    const max = Math.max(60, ...days.map((day) => day.value));
    const chart = document.getElementById('week-chart');
    chart.replaceChildren(...days.map((day) => {
      const column = document.createElement('div');
      column.className = `day-bar${day.today ? ' today' : ''}`;
      column.title = t('minutesShort', String(Math.round(day.value / 60)));
      const bar = document.createElement('i');
      bar.style.height = `${Math.max(2, Math.round(day.value / max * 18))}px`;
      const label = document.createElement('span');
      label.textContent = day.date.toLocaleDateString(dateLocale, { weekday: 'short' }).replace('.', '');
      column.append(bar, label);
      return column;
    }));
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

  if (!state) {
    renderAnimeNotFound(false);
    return;
  }
  const recognition = state.recognition;
  const player = state.player;
  const players = Object.values(state.players || {});
  const animeFound = Boolean(recognition?.title);
  if (!animeFound) {
    renderAnimeNotFound(Boolean(state.probe && Number.isInteger(tab?.id)));
    return;
  }
  reportSection.hidden = true;
  for (const id of animeDetailIds) document.getElementById(id).hidden = false;
  document.getElementById('account-warning').hidden = true;
  if (consentAccepted) {
    await renderAccount();
  } else {
    document.getElementById('account-label').textContent = t('syncOffUntilConsent');
    autoMarkToggle.disabled = true;
    document.getElementById('resume-sync').disabled = true;
  }
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
  const taste = state.taste;
  const tasteElement = document.getElementById('taste-match');
  if (taste?.status === 'ok' && Number.isFinite(taste.percent)) {
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
      : taste?.status === 'no-data' ? t('notEnoughTasteData')
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
      chrome.storage.local.set({ 'resume-bulk': bulk });
    } catch { /* offline — живём на локальной истории */ }
    return bulk;
  }

  async function renderResume(force) {
    if (!animeFound || player?.playing) return;
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
    if (match?.status === 'ok' && match.animeId) {
      const bulk = await loadResumeBulk(force);
      const progress = bulk.byAnime?.[match.animeId] ?? bulk.byAnime?.[String(match.animeId)];
      if (progress) {
        resume = {
          episode: progress.episode,
          position: progress.position_sec,
          voice: progress.voice || null,
          at: Date.parse(progress.watched_at),
        };
      }
    }
    if (!resume) {
      const titleKey = String(recognition.title).toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
      const records = Object.entries(stored['watch-history']?.records || {})
        .filter(([recordKey]) => recordKey.startsWith(`${titleKey}::`))
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
    if (!resume) return;
    const parts = [];
    if (resume.episode != null) parts.push(t('episodeLabel', String(resume.episode)));
    parts.push(fmtTime(resume.position));
    if (resume.voice) parts.push(resume.voice);
    const when = fmtWhen(resume.at);
    if (when) parts.push(when);
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
      const resumeSessionReload = () => setTimeout(() => { pauseSessionStateReload = false; }, 500);
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
          resumeSessionReload();
          return;
        }
        if (currentResponse.payload?.confirmationRequired === true) {
          const accepted = confirm(t('confirmLegacyHistorySync', [
            currentResponse.payload.animeTitle || match?.title || recognition?.title || '',
          ]));
          if (!accepted) {
            syncButton.textContent = t('syncButton');
            syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
            resumeSessionReload();
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
            resumeSessionReload();
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
          resumeSessionReload();
          return;
        }
        if (!wroteData) {
          syncButton.textContent = t('syncNothingToSend');
          setTimeout(() => {
            syncButton.textContent = t('syncButton');
            syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
          }, 2500);
          resumeSessionReload();
          return;
        }
        await chrome.storage.local.set({ 'resume-sync-at': Date.now() });
        try {
          await loadResumeBulk(true);
          await renderResume(false);
        } catch { /* account writes succeeded; a read refresh must not invert their result */ }
        syncButton.textContent = t('syncUpdated');
        resumeSessionReload();
      } catch {
        syncButton.textContent = t('syncFailed');
        setTimeout(() => {
          syncButton.textContent = t('syncButton');
          syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
        }, 2500);
        resumeSessionReload();
        return;
      }
      setTimeout(() => {
        syncButton.textContent = t('syncButton');
        syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
      }, SYNC_COOLDOWN_MS);
    });
  })();
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
  else set('hint', animeFound
    ? t('animeFoundPlayVideo')
    : t('openAnimeWithPlayer'));
})();
