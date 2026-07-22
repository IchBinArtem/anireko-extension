(function runMediaDetector() {
  if (globalThis.__anirekoMediaDetectorStarted) return;
  globalThis.__anirekoMediaDetectorStarted = true;
  const progressApi = globalThis.AniRekoProgress;
  const recognitionApi = globalThis.AniRekoRecognition;
  const boundVideos = new WeakSet();
  const videoIds = new WeakMap();
  const videoRuntime = new WeakMap();
  const observedShadowRoots = new WeakSet();
  let mediaObserver = null;
  let nextVideoId = 1;
  let lastEpisode = null;
  let eventEpisode = null;
  let lastVoice = '';
  let metadataUrl = '';
  let observedUrl = '';
  let lastShadowScanAt = 0;
  let extensionContextAlive = true;
  const documentToken = globalThis.__anirekoDocumentToken ||= globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'anireko-disable-detector') return;
    extensionContextAlive = false;
    mediaObserver?.disconnect();
  });

  // Reloading an unpacked extension invalidates the content-script context in
  // every already-open tab. Page observers and timers survive there until the
  // tab is refreshed, so a raw chrome.runtime.sendMessage() would keep throwing
  // "Extension context invalidated" on unrelated pages. Fail closed once and
  // make all subsequent reports no-ops; a refreshed tab receives a fresh script.
  function safeSendMessage(message) {
    if (!extensionContextAlive) return Promise.resolve(null);
    try {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.id || typeof runtime.sendMessage !== 'function') {
        extensionContextAlive = false;
        return Promise.resolve(null);
      }
      const envelope = {
        ...message,
        documentToken,
        documentUrl: location.href,
      };
      return Promise.resolve(runtime.sendMessage(envelope)).catch((error) => {
        if (/extension context invalidated/iu.test(String(error?.message || error))) {
          extensionContextAlive = false;
        }
        return null;
      });
    } catch (error) {
      extensionContextAlive = false;
      return Promise.resolve(null);
    }
  }

  // Web-component players may hide their iframe inside an open shadow root —
  // plain document queries and a MutationObserver
  // on the document see nothing there. We deep-scan shadow roots and attach
  // the same observer to each one, so late-added <video>/<iframe> inside
  // shadow DOM are caught like regular ones. chrome.dom.openOrClosedShadowRoot
  // is the only way for a content script to reach CLOSED roots too.
  function shadowRootOf(element) {
    if (element.shadowRoot) return element.shadowRoot;
    try {
      return chrome.dom?.openOrClosedShadowRoot?.(element) || null;
    } catch {
      return null;
    }
  }

  function forEachShadowRoot(callback) {
    const queue = [document];
    let scanned = 0;
    while (queue.length) {
      const root = queue.shift();
      for (const element of root.querySelectorAll('*')) {
        if (++scanned > 4000) return; // perf cap on huge pages
        const shadow = shadowRootOf(element);
        if (shadow) {
          callback(shadow);
          queue.push(shadow);
        }
      }
    }
  }

  function deepQueryAll(selector) {
    const out = Array.from(document.querySelectorAll(selector));
    forEachShadowRoot((root) => out.push(...root.querySelectorAll(selector)));
    return out;
  }

  function deepScanForMedia(force = false) {
    const now = Date.now();
    if (!force && now - lastShadowScanAt < 1000) return;
    lastShadowScanAt = now;
    forEachShadowRoot((root) => {
      if (mediaObserver && !observedShadowRoots.has(root)) {
        observedShadowRoots.add(root);
        mediaObserver.observe(root, { childList: true, subtree: true });
      }
      root.querySelectorAll('video').forEach(bindVideo);
    });
  }

  function hasPlayerElement() {
    // Player containers count too: animevost-style pages ship empty
    // `<div id="player">` shells and build the actual video/iframe with JS
    // much later (or on click) — recognition must not wait for that.
    if (document.querySelector(
      'video, iframe, [id*="player" i], [class*="player" i]'
    )) return true;
    let scanned = 0;
    for (const element of document.querySelectorAll('*')) {
      if (++scanned > 4000) break;
      if (element.tagName.includes('-') && /player|video/iu.test(element.tagName)) return true;
      const shadow = shadowRootOf(element);
      if (shadow && shadow.querySelector('video, iframe')) return true;
    }
    return false;
  }

  // Diagnostic DOM probe (KAN-2714): a compact structural summary of the top
  // page so the "anime recognized but player unreadable" popup state can
  // export a useful report. Stays local — the user shares it manually.
  function collectDomProbe() {
    const customTags = new Set();
    let shadowHosts = 0;
    let scanned = 0;
    for (const element of document.querySelectorAll('*')) {
      if (++scanned > 4000) break;
      if (element.tagName.includes('-')) customTags.add(element.tagName.toLowerCase());
      if (shadowRootOf(element)) shadowHosts += 1;
    }
    return {
      videos: deepQueryAll('video').length,
      iframes: deepQueryAll('iframe').slice(0, 10).map((frame) => ({
        src: (frame.src || '').slice(0, 120),
        visible: isLocallyVisible(frame)
      })),
      shadowHosts,
      customTags: [...customTags].slice(0, 10),
      selectSamples: Array.from(document.querySelectorAll('select')).slice(0, 5)
        .map((select) => select.selectedOptions?.[0]?.textContent?.trim().slice(0, 60) || ''),
      episodeAttrElements: deepQueryAll('[episode], [data-episode]').length,
      episodeParsed: readEpisode(),
      readyState: document.readyState
    };
  }

  // Memoized (2s TTL): this runs a deep shadow-DOM walk and is on the
  // timeupdate path via readEpisode(). Attribute mutations invalidate the
  // cache immediately (invalidateEpisodeAttrCache in the observer).
  let episodeAttrCache = { value: null, at: 0 };

  function invalidateEpisodeAttrCache() {
    episodeAttrCache = { value: null, at: 0 };
  }

  function episodeFromPlayerAttributes() {
    const now = Date.now();
    if (now - episodeAttrCache.at < 2000) return episodeAttrCache.value;
    const candidates = deepQueryAll('[episode], [data-episode]');
    let value = null;
    if (candidates.length) {
      // Prefer the active playlist item, then player-looking elements
      // (custom tags / *player*) — a bare list of data-episode items would
      // otherwise always yield episode 1.
      const picked = candidates.find((el) => el.matches('.active, .selected, [aria-current]'))
        || candidates.find((el) => el.tagName.includes('-')
          || /player/iu.test(`${el.tagName} ${el.id} ${String(el.className)}`));
      if (picked) {
        const raw = picked.getAttribute('episode') ?? picked.getAttribute('data-episode');
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 5000) value = parsed;
      }
    }
    episodeAttrCache = { value, at: now };
    return value;
  }

  function readEpisode(allowPlayerUrl = false) {
    // Some web-component players keep the host's `episode` attribute at the
    // initial value forever, but emit a composed episodeChange event whenever
    // the user switches the episode. Once observed, that live signal is more
    // authoritative than stale DOM attributes.
    if (eventEpisode !== null) return eventEpisode;
    const attrEpisode = episodeFromPlayerAttributes();
    if (attrEpisode !== null) return attrEpisode;
    const selects = Array.from(document.querySelectorAll('select'));
    for (const select of selects) {
      const selected = select.selectedOptions?.[0]?.textContent || '';
      if (recognitionApi.hasEpisodeMarker(selected)) {
        return recognitionApi.parseEpisode([selected]);
      }
    }
    const selectedLabels = document.querySelectorAll(
      '[class*="series"] .selected, [class*="episode"] .selected, ' +
      '[class*="series"] [class*="select-button"], [class*="episode"] [class*="select-button"]'
    );
    for (const label of selectedLabels) {
      if (recognitionApi.hasEpisodeMarker(label.textContent || '')) {
        return recognitionApi.parseEpisode([label.textContent]);
      }
    }
    // Some cross-origin HTML5 players expose the selected episode only in
    // their own document URL. This fallback is enabled exclusively while an
    // actual <video> is reporting state; top-page query strings never count.
    if (allowPlayerUrl) return recognitionApi.episodeFromPlayerUrl(location.href);
    return null;
  }

  function playerKind() {
    if (document.querySelector('.serial-panel, [class*="serial-series"]')) return 'serial-html5';
    return 'html5';
  }

  function readVoiceLabel() {
    const selectors = [
      '.b-translators__list .active',
      '[data-this-translator].active',
      '[class*="translation"] .selected',
      '[class*="translator"] .selected',
      'select[name*="translation"] option:checked',
      'select[class*="translation"] option:checked'
    ];
    for (const selector of selectors) {
      const value = recognitionApi.normalizeVoiceLabel(
        document.querySelector(selector)?.textContent || ''
      );
      if (value) return value;
    }
    // React Select and similar controls keep the chosen value next to a
    // role=combobox input. Accept it only when the text explicitly says that
    // it is a voice/dub/translation label, so unrelated selectors are ignored.
    const labeledValues = Array.from(document.querySelectorAll(
      '[class*="singleValue"], [class*="single-value" i]'
    ));
    for (const valueNode of labeledValues) {
      const value = recognitionApi.normalizeVoiceLabel(valueNode.textContent || '', true);
      if (value) return value;
    }
    for (const input of document.querySelectorAll('[role="combobox"]')) {
      let container = input.parentElement;
      for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
        const value = recognitionApi.normalizeVoiceLabel(container.textContent || '', true);
        if (value) return value;
      }
    }
    return '';
  }

  function reportVoiceIfChanged() {
    handleUrlChangeIfAny();
    const voice = readVoiceLabel();
    if (!voice || voice === lastVoice) return;
    lastVoice = voice;
    safeSendMessage({
      type: 'voice-change',
      voice,
      frameUrl: location.href,
      observedAt: Date.now()
    }).catch(() => {});
  }

  function videoId(video) {
    if (!videoIds.has(video)) videoIds.set(video, `video-${nextVideoId++}`);
    return videoIds.get(video);
  }

  function isLocallyVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return !element.hidden
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0
      && rect.width >= 16
      && rect.height >= 16;
  }

  function reportPlayerState(video, reason, seek = null) {
    handleUrlChangeIfAny();
    const now = Date.now();
    const runtime = videoRuntime.get(video) || { lastReportAt: 0, watchedEpisode: null };
    const watched = progressApi.isWatched(video.currentTime, video.duration);
    // Cheap pre-throttle BEFORE the episode scan: readEpisode() walks the DOM
    // (incl. shadow roots) and must not run on every discarded tick.
    if (reason === 'timeupdate' && !watched && now - runtime.lastReportAt < 5000) return;
    const episode = readEpisode(true);
    const episodeKey = episode === null ? 'unknown' : String(episode);
    // The 80% transition is reported immediately; everything else (including
    // post-80% progress) keeps flowing under the regular 5s throttle.
    const watchedTransition = watched && runtime.watchedEpisode !== episodeKey;
    if (reason === 'timeupdate' && !watchedTransition && now - runtime.lastReportAt < 5000) return;
    runtime.lastReportAt = now;
    if (watched) runtime.watchedEpisode = episodeKey;
    videoRuntime.set(video, runtime);
    safeSendMessage({
      type: 'player-progress',
      playerInstanceId: videoId(video),
      player: playerKind(),
      frameUrl: location.href,
      episode,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      progress: progressApi.calculateProgress(video.currentTime, video.duration),
      watched,
      playbackStarted: video.currentTime > 0 || !video.paused,
      playing: !video.paused && !video.ended,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      volume: video.volume,
      playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
      readyState: video.readyState,
      locallyVisible: isLocallyVisible(video),
      seek,
      reason,
      observedAt: now
    }).catch(() => {});
  }

  function videoRuntimeOf(video) {
    let runtime = videoRuntime.get(video);
    if (!runtime) {
      runtime = { lastReportAt: 0, watchedEpisode: null, lastMediaTime: null, seekFrom: null };
      videoRuntime.set(video, runtime);
    }
    return runtime;
  }

  function bindVideo(video) {
    if (boundVideos.has(video)) return;
    boundVideos.add(video);
    ['loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'ratechange'].forEach((eventName) => {
      video.addEventListener(eventName, () => reportPlayerState(video, eventName), { passive: true });
    });
    // Seek tracking: remember where playback was BEFORE the jump so the
    // background can log the skipped segment (from → to).
    video.addEventListener('seeking', () => {
      const runtime = videoRuntimeOf(video);
      runtime.seekFrom ??= runtime.lastMediaTime ?? 0;
      reportPlayerState(video, 'seeking');
    }, { passive: true });
    video.addEventListener('seeked', () => {
      const runtime = videoRuntimeOf(video);
      const from = Number.isFinite(runtime.seekFrom) ? runtime.seekFrom : null;
      runtime.seekFrom = null;
      runtime.lastMediaTime = video.currentTime;
      reportPlayerState(video, 'seeked', from === null ? null : { from, to: video.currentTime });
    }, { passive: true });
    video.addEventListener('timeupdate', () => {
      if (!video.seeking) videoRuntimeOf(video).lastMediaTime = video.currentTime;
      reportPlayerState(video, 'timeupdate');
    }, { passive: true });
    reportPlayerState(video, 'discovered');
  }

  const MEDIA_SELECTOR = 'video, iframe';
  const EPISODE_UI_SELECTOR = 'select, [class*="series"], [class*="episode"], [episode], [data-episode]';

  function isCustomPlayerTag(node) {
    return node.tagName.includes('-') && /player|video/iu.test(node.tagName);
  }

  function inspectAddedNode(node) {
    if (!(node instanceof Element)) return { media: false, episodeUi: false };
    if (node.matches('video')) bindVideo(node);
    // Leaf fast-path: most mutations on busy pages append childless nodes —
    // don't run subtree selectors over them.
    if (!node.firstElementChild && !node.shadowRoot) {
      return {
        media: node.matches(MEDIA_SELECTOR) || isCustomPlayerTag(node),
        episodeUi: node.matches(EPISODE_UI_SELECTOR)
      };
    }
    node.querySelectorAll('video').forEach(bindVideo);
    return {
      media: node.matches(MEDIA_SELECTOR) || isCustomPlayerTag(node)
        || Boolean(node.querySelector(MEDIA_SELECTOR)),
      episodeUi: node.matches(EPISODE_UI_SELECTOR)
        || Boolean(node.querySelector(EPISODE_UI_SELECTOR))
    };
  }

  function reportEpisodeIfChanged(
    authoritative = false,
    sourceKind = window === window.top ? 'top-dom' : 'player-dom'
  ) {
    const episode = readEpisode();
    if (episode === null || (episode === lastEpisode && !authoritative)) return;
    lastEpisode = episode;
    const video = document.querySelector('video');
    if (!video) {
      // Shadow-DOM/web-component players: the actual <video> lives in a
      // cross-origin frame that does not know the episode number. The top
      // page does (playlist / player attributes) — ship it separately so the
      // background can backfill players reporting episode=null.
      if (window === window.top) {
        safeSendMessage({
          type: 'episode-observed',
          episode,
          authoritative,
          sourceKind,
          url: location.href,
          observedAt: Date.now()
        }).catch(() => {});
      }
      return;
    }
    const runtime = videoRuntime.get(video) || { lastReportAt: 0, watchedEpisode: null };
    runtime.watchedEpisode = null;
    videoRuntime.set(video, runtime);
    safeSendMessage({
      type: 'player-progress',
      playerInstanceId: videoId(video),
      player: playerKind(),
      frameUrl: location.href,
      episode,
      currentTime: null,
      duration: null,
      progress: null,
      watched: false,
      playbackStarted: false,
      playing: false,
      paused: true,
      ended: false,
      muted: video.muted,
      volume: video.volume,
      playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
      readyState: video.readyState,
      locallyVisible: isLocallyVisible(video),
      reason: 'episode-change',
      episodeAuthoritative: authoritative,
      observedAt: Date.now()
    }).catch(() => {});
  }

  function reportEpisodeEvent(event) {
    handleUrlChangeIfAny();
    const episode = recognitionApi.episodeFromEventDetail(event?.detail);
    if (episode === null) return;
    eventEpisode = episode;
    invalidateEpisodeAttrCache();
    reportEpisodeIfChanged(true, 'document-event');
  }

  function reportEpisodeMessage(event) {
    if (window !== window.top || !event?.source) return;
    let payload = event.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    const eventType = String(payload?.eventType || payload?.type || payload?.event || '').toLowerCase();
    if (![
      'selectepisode', 'episodechangedinfullscreen', 'episodechange',
      'nextepisode', 'prevepisode'
    ].includes(eventType)) return;
    // Accept the protocol only from an iframe that belongs to the detected
    // player tree. A same-page script must not be able to forge episode state
    // with window.postMessage().
    const fromPlayerFrame = deepQueryAll('iframe')
      .find((frame) => frame.contentWindow === event.source);
    if (!fromPlayerFrame) return;
    const currentEpisode = eventEpisode ?? episodeFromPlayerAttributes();
    const episode = recognitionApi.episodeFromPlayerMessage(payload, currentEpisode);
    if (episode === null) return;
    eventEpisode = episode;
    lastEpisode = episode;
    invalidateEpisodeAttrCache();
    safeSendMessage({
      type: 'episode-observed',
      episode,
      authoritative: true,
      sourceKind: 'player-message',
      sourceFrameUrl: fromPlayerFrame.src,
      url: location.href,
      observedAt: Date.now()
    }).catch(() => {});
  }

  function likelyAnimePage(title) {
    // location.href в haystack: SPA-сайты (anilibria) не пишут «аниме» в
    // метаданные, но путь содержит /anime/ — лукараунды матчат по границе '/'.
    const haystack = [
      title,
      document.title,
      location.href,
      document.querySelector('meta[name="description"]')?.content || '',
      document.querySelector('meta[name="keywords"]')?.content || '',
      document.querySelector('meta[property="og:site_name"]')?.content || '',
      document.querySelector('meta[property="og:type"]')?.content || ''
    ].join(' ');
    const hasAnimeSignal = /(?<![a-zа-яё])(?:аниме|anime)(?![a-zа-яё])/iu.test(haystack)
      || recognitionApi.hasEpisodeMarker(haystack);
    return hasAnimeSignal && hasPlayerElement();
  }

  function reportTopMetadata() {
    if (window !== window.top || metadataUrl === location.href) return;
    const h1 = document.querySelector('main h1, article h1, h1')?.textContent || '';
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
    const title = recognitionApi.chooseTitle([h1, ogTitle, document.title]);
    if (!title || !likelyAnimePage(title)) return;
    metadataUrl = location.href;
    safeSendMessage({
      type: 'recognition',
      site: location.hostname,
      url: location.href,
      title,
      episode: readEpisode(),
      confidence: 'candidate',
      voice: readVoiceLabel() || null,
      observedAt: Date.now()
    }).catch(() => {});
  }

  function reportFrameVisibility() {
    if (window !== window.top) return;
    const frames = deepQueryAll('iframe')
      .filter((frame) => /^https?:/iu.test(frame.src || '') && frame.src.length <= 2000)
      .slice(0, 50).map((frame) => ({
        src: frame.src,
        visible: isLocallyVisible(frame),
        episode: recognitionApi.episodeFromPlayerUrl(frame.src || ''),
        rect: {
          width: Math.round(frame.getBoundingClientRect().width),
          height: Math.round(frame.getBoundingClientRect().height)
        }
      }));
    safeSendMessage({
      type: 'frame-visibility',
      pageUrl: location.href,
      frames,
      observedAt: Date.now()
    }).catch(() => {});
  }

  function reportPageObserved() {
    if (window !== window.top) return;
    observedUrl = location.href;
    safeSendMessage({
      type: 'page-observed',
      url: location.href,
      probe: collectDomProbe(),
      observedAt: Date.now()
    }).catch(() => {});
  }

  // Settled rescans: the document_start snapshot is nearly empty. SPA
  // frontends (anilibria) render title/h1 late WITHOUT media mutations, so
  // the mutation-driven retry never fires — re-evaluate everything on a
  // couple of timers and refresh the diagnostic probe.
  function scheduleSettledRescans() {
    if (window !== window.top) return;
    for (const delay of [4000, 10000]) {
      setTimeout(() => {
        reportTopMetadata();
        reportEpisodeIfChanged();
        reportVoiceIfChanged();
        reportFrameVisibility();
        safeSendMessage({
          type: 'probe-update',
          url: location.href,
          probe: collectDomProbe(),
          observedAt: Date.now()
        }).catch(() => {});
      }, delay);
    }
  }

  // SPA navigation: content scripts don't reload on pushState, so re-evaluate
  // recognition whenever the top URL changed since the last report.
  function handleUrlChangeIfAny() {
    if (location.href === observedUrl) return;
    lastEpisode = null;
    eventEpisode = null;
    lastVoice = '';
    observedUrl = location.href;
    if (window === window.top) {
      reportPageObserved();
      reportTopMetadata();
      reportEpisodeIfChanged();
      reportVoiceIfChanged();
      reportFrameVisibility();
      return;
    }
    document.querySelectorAll('video').forEach((video) => reportPlayerState(video, 'frame-navigation'));
    reportEpisodeIfChanged();
    reportVoiceIfChanged();
  }

  function activateObserver(isTop) {
    if (mediaObserver) return;
    mediaObserver = new MutationObserver((records) => {
      handleUrlChangeIfAny();
      let mediaAdded = false;
      let episodeUiAdded = false;
      for (const record of records) {
        if (record.type === 'attributes') {
          invalidateEpisodeAttrCache();
          episodeUiAdded = true;
          continue;
        }
        for (const node of record.addedNodes) {
          const result = inspectAddedNode(node);
          mediaAdded ||= result.media;
          episodeUiAdded ||= result.episodeUi;
        }
      }
      // Shadow hosts may have been attached by any mutation batch — rescan
      // (throttled to 1/s) and hook the observer onto new shadow roots.
      deepScanForMedia();
      // Добавленный узел с [episode]-атрибутом (web-component плеер) обязан
      // сбрасывать мемоизацию так же, как мутация атрибута.
      if (episodeUiAdded) invalidateEpisodeAttrCache();
      if (episodeUiAdded) reportEpisodeIfChanged();
      if (episodeUiAdded) reportVoiceIfChanged();
      if (isTop && (mediaAdded || episodeUiAdded)) {
        reportTopMetadata();
        reportFrameVisibility();
      }
    });
    mediaObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['episode', 'data-episode']
    });
  }

  function start() {
    const isTop = window === window.top;
    const looksLikePlayerDocument = Boolean(document.querySelector(
      'video, .serial-panel, [class*="player"], [class*="episode"], [class*="series"]'
    )) || /(?:player|embed|video|stream|serial)/iu.test(`${location.hostname}${location.pathname}`);

    observedUrl = location.href;
    document.querySelectorAll('video').forEach(bindVideo);
    if (isTop) {
      reportPageObserved();
      scheduleSettledRescans();
    }
    if (isTop || looksLikePlayerDocument) reportEpisodeIfChanged();
    reportVoiceIfChanged();
    reportTopMetadata();
    if (isTop) reportFrameVisibility();
    if (!isTop && !looksLikePlayerDocument) {
      // Neutral-named frames (widgets or player mirrors without "player" in URL):
      // observer на каждый из десятков таких фреймов — дорого. Вместо этого
      // два отложенных чека: появился <video> (в т.ч. в shadow DOM) — значит
      // это всё-таки плеер, включаем полный детект.
      for (const delay of [3000, 9000]) {
        setTimeout(() => {
          if (mediaObserver) return;
          if (document.querySelector('video') || deepQueryAll('video').length) {
            activateObserver(false);
            document.querySelectorAll('video').forEach(bindVideo);
            deepScanForMedia(true);
          }
        }, delay);
      }
      return;
    }

    activateObserver(isTop);
    deepScanForMedia(true);
    if (isTop || looksLikePlayerDocument) {
      // The custom player may be mounted after document_start, so top pages
      // must listen before the initial DOM already looks player-like.
      document.addEventListener('episodeChange', reportEpisodeEvent, { capture: true, passive: true });
      document.addEventListener('episodechange', reportEpisodeEvent, { capture: true, passive: true });
      window.addEventListener('message', reportEpisodeMessage, { capture: true, passive: true });
    }
    if (looksLikePlayerDocument) {
      document.addEventListener('change', () => {
        handleUrlChangeIfAny();
        reportEpisodeIfChanged();
      }, { capture: true, passive: true });
      document.addEventListener('click', () => queueMicrotask(() => {
        handleUrlChangeIfAny();
        reportEpisodeIfChanged();
      }), {
        capture: true,
        passive: true
      });
      document.addEventListener('click', () => queueMicrotask(reportVoiceIfChanged), {
        capture: true,
        passive: true
      });
    }
    window.addEventListener('popstate', () => queueMicrotask(handleUrlChangeIfAny), { passive: true });
    window.addEventListener('hashchange', () => queueMicrotask(handleUrlChangeIfAny), { passive: true });
    if (isTop) {
      document.addEventListener('click', () => queueMicrotask(() => {
        handleUrlChangeIfAny();
        reportFrameVisibility();
      }), { capture: true, passive: true });
      document.addEventListener('change', reportFrameVisibility, { capture: true, passive: true });
      window.addEventListener('resize', reportFrameVisibility, { passive: true });
    }
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
