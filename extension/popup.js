(async function renderPopup() {
  const requestBackground = (type, input = {}) => chrome.runtime.sendMessage({ type, ...input });
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
  if (key) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'session' || !changes[key]?.newValue) return;
      if (displayFingerprint(changes[key].newValue) !== initialDisplayFingerprint) location.reload();
    });
  }

  const privacyHref = `${siteBase}/ru/privacy#browser-extension`;
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
    if (!confirm('Удалить локальную историю, кэши, настройки и привязку аккаунта? Данные в аккаунте AniReko не удаляются.')) return;
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
        profile.href = `${siteBase}/ru/profile`;
        profile.target = '_blank';
        profile.rel = 'noopener';
        profile.textContent = payload.user.name || 'профиль';
        label.replaceChildren('Аккаунт на сайте: ', profile);
        autoMarkToggle.disabled = false;
        autoMarkToggle.checked = syncAccountActive;
        if (!sameAccount) {
          const boundName = bound?.name ? `«${bound.name}»` : 'другому аккаунту';
          warning.hidden = false;
          warning.textContent = bound?.id
            ? `Синхронизация приостановлена: расширение привязано к ${boundName}. Включите переключатель, чтобы явно перепривязать его к «${payload.user.name || 'текущему аккаунту'}».`
            : 'Синхронизация ещё не привязана. Включите переключатель, чтобы разрешить запись в этот аккаунт.';
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
              `Переключить синхронизацию с «${bound.name || bound.id}» на «${payload.user.name || payload.user.id}»?`
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
    label.textContent = 'Авторизация — через сайт AniReko';
    login.hidden = false;
    autoMarkToggle.disabled = true;
    autoMarkToggle.checked = false;
    autoMarkToggle.title = 'Сначала войдите на anireko.com — расширение использует ту же сессию';
    syncButton.disabled = true;
    syncButton.title = 'Войдите на anireko.com, чтобы синхронизировать прогресс';
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
    set('today-time', `${Math.round(today.watchedSeconds / 60)} мин`);
    set('today-episodes', String(today.episodeKeys.length));
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
      column.title = `${Math.round(day.value / 60)} мин`;
      const bar = document.createElement('i');
      bar.style.height = `${Math.max(2, Math.round(day.value / max * 18))}px`;
      const label = document.createElement('span');
      label.textContent = day.date.toLocaleDateString('ru-RU', { weekday: 'short' }).replace('.', '');
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
    setCheck('anime-check', 'pending', '·', 'Аниме не найдено', 'Название не удалось определить на этой странице');
    for (const id of animeDetailIds) document.getElementById(id).hidden = true;
    reportSection.hidden = false;
    reportButton.disabled = !canReport;
    if (!canReport) {
      reportDetail.textContent = 'Обновите страницу после установки расширения — затем отчёт можно будет отправить.';
    }
  }

  reportButton.addEventListener('click', async () => {
    if (reportButton.disabled || !Number.isInteger(tab?.id)) return;
    reportButton.disabled = true;
    reportButton.textContent = 'Отправляем…';
    reportDetail.className = '';
    try {
      const response = await requestBackground('popup-report-recognition-miss', { tabId: tab.id });
      if (!response?.ok) throw new Error('report_failed');
      if (response.payload?.pending) {
        reportButton.textContent = 'Отчёт уже отправляется…';
        reportDetail.textContent = 'Дождитесь завершения текущей отправки.';
        return;
      }
      reportButton.textContent = response.payload?.duplicate ? 'Уже отправлено, спасибо' : 'Отправлено, спасибо';
      reportDetail.textContent = response.payload?.duplicate
        ? 'Отчёт с этого сайта уже есть у разработчика.'
        : 'Разработчик увидит обезличенный технический отчёт.';
      reportDetail.className = 'ok';
    } catch {
      reportButton.disabled = false;
      reportButton.textContent = 'Повторить отправку';
      reportDetail.textContent = 'Не удалось отправить отчёт. Проверьте интернет и попробуйте ещё раз.';
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
    document.getElementById('account-label').textContent = 'Синхронизация выключена до согласия';
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

  setCheck(
    'anime-check',
    animeFound ? 'success' : 'pending',
    animeFound ? '✓' : '·',
    animeFound ? 'Аниме найдено' : 'Не удалось подтвердить аниме',
    animeFound ? recognition.title : 'Название не извлечено из метаданных'
  );
  setCheck(
    'player-check',
    playerReady ? 'success' : playerFound ? 'waiting' : 'pending',
    playerReady ? '✓' : playerFound ? '▶' : '·',
    playerReady ? 'Плеер полностью подключён' : playerFound ? 'Плеер найден — ждём видео' : 'Плеер пока не найден',
    playerReady
      ? `${player.episode != null ? `Серия ${player.episode}` : 'Фильм / серия не размечена'} · ${Math.round(player.duration / 60)} мин · тайминг читается`
      : playerFound ? 'Запустите воспроизведение, чтобы получить тайминг' : 'Проверяем HTML5-видео во всех доступных фреймах'
  );
  // Unreadable-player diagnostics are auto-reported by the service worker
  // (KAN-2715) — no user action needed, so no UI for it here.
  set('title', recognition?.title);
  const match = state.match;
  const matchElement = document.getElementById('anireko-match');
  const primaryAction = document.getElementById('anime-primary-action');
  if (match?.status === 'ok' && match.slug) {
    primaryAction.href = `${siteBase}/ru/anime/${match.slug}-${match.animeId}`;
    primaryAction.hidden = false;
    set('anireko-match', `В каталоге: ${match.title}${match.year ? ` (${match.year})` : ''}${match.exact ? '' : ' · совпадение неточное'}`);
  } else {
    primaryAction.hidden = true;
    set('anireko-match', match?.status === 'ok'
      ? `${match.title}${match.year ? ` (${match.year})` : ''}`
      : match?.status === 'none' ? 'не найдено в каталоге'
        : match?.status === 'error' ? 'ошибка поиска' : null);
  }
  // Compatibility is supporting context here; the anime page is the popup's
  // single primary destination, so we deliberately avoid a competing link.
  const taste = state.taste;
  const tasteElement = document.getElementById('taste-match');
  if (taste?.status === 'ok' && Number.isFinite(taste.percent)) {
    const verdicts = {
      very_likely: 'очень подходит',
      likely: 'может понравиться',
      mixed: 'есть спорные моменты',
      unlikely: 'скорее не твоё',
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
    set('taste-match', taste?.status === 'guest' ? 'войди на сайте, чтобы увидеть %'
      : taste?.status === 'no-data' ? 'мало данных о вкусе'
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
      if (days <= 0) return 'сегодня';
      if (days === 1) return 'вчера';
      if (days < 7) return `${days} дн. назад`;
      return new Date(ts).toLocaleDateString('ru-RU');
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
    if (resume.episode != null) parts.push(`Серия ${resume.episode}`);
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
      syncButton.title = `Недавно синхронизировано — повтор через ${Math.ceil(remaining / 1000)}с`;
      setTimeout(() => {
        syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
        syncButton.title = '';
      }, remaining);
    }
    syncButton.addEventListener('click', async () => {
      if (syncButton.disabled) return;
      syncButton.disabled = true;
      syncButton.textContent = '⟳ обновляем…';
      await chrome.storage.local.set({ 'resume-sync-at': Date.now() });
      await loadResumeBulk(true);
      await renderResume(false);
      syncButton.textContent = '✓ обновлено';
      setTimeout(() => {
        syncButton.textContent = '⟳ синхронизировать';
        syncButton.disabled = syncButton.dataset.accountAllowed !== '1';
      }, SYNC_COOLDOWN_MS);
    });
  })();
  const episode = player?.episode ?? recognition?.episode;
  set('episode', episode != null ? `Серия ${episode}` : 'Серия не определена');
  set('voice', state.voice || recognition?.voice);
  set('player', player?.player);
  set('player-count', players.length || (player?.player === 'iframe-shell' ? 1 : null));
  const rate = Number.isFinite(player?.playbackRate) ? player.playbackRate : 1;
  const rateSuffix = rate !== 1 ? ` ×${rate}` : '';
  set('status', player?.watched ? 'просмотрено'
    : player?.playing ? `смотрю${rateSuffix}`
      : player?.playbackStarted ? `пауза${rateSuffix}` : playerFound ? 'ждём запуск' : null);
  document.getElementById('status').className = `status-chip${player?.watched ? ' ok' : ''}`;
  set('progress', player?.progress == null ? null : `${(player.progress * 100).toFixed(1)}%`);
  const hint = document.getElementById('hint');
  if (playerReady) hint.hidden = true;
  else set('hint', animeFound
    ? 'Аниме найдено. Запустите видео для полной проверки плеера.'
    : 'Откройте страницу аниме с видеоплеером.');
})();
