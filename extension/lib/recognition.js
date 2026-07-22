(function initRecognition(global) {
  // JS \b знает только [A-Za-z0-9_], для кириллицы границы слов задаём
  // lookaround'ами — иначе «сер» матчится внутри «сериал», а «ep» внутри «deep».
  const EPISODE_WORD = '(?:сери[яию]|сер\\.|эпизод(?:ы|а|у|е)?|episode|ep\\.?)';
  const EPISODE_MARKER = new RegExp(`(?<![a-zа-яё])${EPISODE_WORD}(?![a-zа-яё])`, 'iu');
  const EPISODE_PATTERNS = [
    new RegExp(`(?<![a-zа-яё])${EPISODE_WORD}[\\s:#№-]*(\\d{1,4})(?!\\d)`, 'iu'),
    new RegExp(`(?:^|[^\\d])(\\d{1,4})[\\s-]*${EPISODE_WORD}(?![a-zа-яё])`, 'iu')
  ];

  function cleanText(value) {
    return String(value || '')
      .replace(/\s+/gu, ' ')
      .replace(/\s*[|—–-]\s*(?:смотреть.*|jut\.su.*)$/iu, '')
      .trim();
  }

  function hasEpisodeMarker(value) {
    return EPISODE_MARKER.test(cleanText(value));
  }

  function parseEpisode(values) {
    for (const raw of values) {
      const value = cleanText(raw);
      for (const pattern of EPISODE_PATTERNS) {
        const match = value.match(pattern);
        if (match) return Number(match[1]);
      }
    }
    return null;
  }

  function episodeFromEventDetail(detail) {
    const candidates = detail && typeof detail === 'object'
      ? [detail.episodeNumber, detail.episode_number, detail.episode, detail.number]
      : [detail];
    for (let candidate of candidates) {
      if (candidate && typeof candidate === 'object') {
        candidate = candidate.number ?? candidate.name ?? candidate.id ?? candidate.value;
      }
      const normalized = typeof candidate === 'number'
        ? candidate
        : /^\s*(\d{1,4})\s*$/u.exec(String(candidate ?? ''))?.[1];
      const episode = Number(normalized);
      if (Number.isInteger(episode) && episode > 0 && episode <= 5000) return episode;
    }
    return null;
  }

  function episodeFromPlayerMessage(payload, currentEpisode = null) {
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return null;
      }
    }
    if (!payload || typeof payload !== 'object') return null;
    const eventType = String(payload.eventType || payload.type || payload.event || '').toLowerCase();
    const current = episodeFromEventDetail(currentEpisode);
    if (eventType === 'nextepisode') {
      return current !== null && current < 5000 ? current + 1 : null;
    }
    if (eventType === 'prevepisode') {
      return current !== null && current > 1 ? current - 1 : null;
    }
    if (!['selectepisode', 'episodechangedinfullscreen', 'episodechange'].includes(eventType)) {
      return null;
    }
    const detail = payload.data ?? payload.detail ?? payload;
    if (eventType === 'episodechangedinfullscreen' && detail && typeof detail === 'object') {
      return episodeFromEventDetail(detail.episodeName ?? detail.episodeNumber ?? detail.episode);
    }
    return episodeFromEventDetail(detail);
  }

  function episodeFromPlayerUrl(value) {
    let url;
    try {
      url = new URL(String(value || ''));
    } catch {
      return null;
    }
    const values = [];
    for (const [rawKey, rawValue] of url.searchParams.entries()) {
      const key = rawKey.toLowerCase().replace(/-/gu, '_');
      if (['episode', 'episode_number', 'episodenumber', 'ep', 'seria'].includes(key)) {
        values.push(rawValue);
      }
    }
    if (!values.length) return null;
    const episodes = values.map(episodeFromEventDetail);
    if (episodes.some((episode) => episode === null)) return null;
    const unique = [...new Set(episodes)];
    return unique.length === 1 ? unique[0] : null;
  }

  function normalizeVoiceLabel(value, requireMarker = false) {
    let label = String(value || '').replace(/\s+/gu, ' ').trim();
    const marked = label.match(
      /^(?:озвучка|озвучивание|перевод|voice|dub(?:bing)?|translation|translator)\s*:?\s+(.+)$/iu
    );
    if (requireMarker && !marked) return '';
    if (marked) label = marked[1].trim();
    label = label
      .replace(/\s*\(\s*\d{1,4}\s*(?:эп\.?|episodes?|сер(?:ия|ии|ий)?\.?)\s*\)\s*$/iu, '')
      .trim();
    if (label.length < 2 || label.length > 100) return '';
    if (/^(?:true|false|none|null|auto|default|translations?)$/iu.test(label)) return '';
    if (/^\d+$/u.test(label)) return '';
    return label;
  }

  function normalizeTitle(value) {
    return cleanText(value)
      // Site-name tail FIRST: «Тайтл [ТВ-1] | AniLiberty» — pipe-хвост
      // внешний, пока он на конце, bracket-правило ($-anchored) не матчится.
      .replace(/\s*\|\s*[^|]{2,60}$/u, '')
      // Aggregator progress blocks: «Liar Game [1-14 из 24+]», «[ТВ-2]».
      .replace(/\s*\[[^\]]*\]\s*$/u, '')
      .replace(new RegExp(`\\s+\\d{1,4}[\\s-]*${EPISODE_WORD}(?![a-zа-яё]).*$`, 'iu'), '')
      .replace(new RegExp(`\\s*(?<![a-zа-яё])${EPISODE_WORD}[\\s:#№-]*\\d{1,4}.*$`, 'iu'), '')
      .replace(/^аниме\s+/iu, '')
      .replace(/\s+смотреть(?:\s+онлайн)?.*$/iu, '')
      .replace(/\s+аниме$/iu, '')
      .trim();
  }

  function chooseTitle(candidates) {
    for (const candidate of candidates) {
      const title = normalizeTitle(candidate);
      if (title.length >= 2 && title.length <= 180) {
        // Dual-title aggregators: «Игра лжецов / Liar Game» — the RU part
        // matches our catalog search best.
        const segments = title.split(' / ');
        if (segments.length > 1 && segments[0].trim().length >= 2) {
          return segments[0].trim();
        }
        return title;
      }
    }
    return '';
  }

  global.AniRekoRecognition = {
    cleanText,
    hasEpisodeMarker,
    parseEpisode,
    episodeFromEventDetail,
    episodeFromPlayerMessage,
    episodeFromPlayerUrl,
    normalizeVoiceLabel,
    normalizeTitle,
    chooseTitle
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
