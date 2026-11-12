(function initActivity(global) {
  function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || (Object.getPrototypeOf(prototype) === null &&
      Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name === 'Object');
  }

  function ownValue(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  }

  function timestamp(value) {
    if (typeof value !== 'string' || value.length > 40) return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return false;
    const [, year, month, day, hour, minute, second, zone] = match;
    const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 ||
        +minute > 59 || +second > 59 || (zone !== 'Z' &&
        (+zone.slice(1, 3) > 23 || +zone.slice(4, 6) > 59))) return false;
    const time = Date.parse(value);
    return Number.isFinite(time);
  }

  // A bad or incomplete snapshot must never replace a known-good cache.
  function normalizeProgressMap(input) {
    try {
      if (!plain(input)) return null;
      const result = {};
      let count = 0;
      for (const key in input) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
        if (++count > 500 || !/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key))) return null;
        const row = ownValue(input, key);
        if (!plain(row)) return null;
        const episode = ownValue(row, 'episode');
        const position = ownValue(row, 'position_sec');
        const duration = ownValue(row, 'duration_sec');
        const voice = ownValue(row, 'voice');
        const watchedAt = ownValue(row, 'watched_at');
        if (!(episode === null || (Number.isInteger(episode) && episode >= 1 && episode <= 5000)) ||
            !(typeof position === 'number' && Number.isFinite(position) && position >= 0 && position <= 259200) ||
            !(duration === null || (typeof duration === 'number' && Number.isFinite(duration) && duration >= 1 && duration <= 259200)) ||
            !(voice === null || (typeof voice === 'string' && voice.length <= 200 && Array.from(voice).length <= 100)) ||
            !timestamp(watchedAt)) return null;
        const normalized = { episode, position_sec: position, duration_sec: duration, voice, watched_at: watchedAt };
        for (const field of ['title', 'title_ru']) {
          const descriptor = Object.getOwnPropertyDescriptor(row, field);
          if (descriptor) {
            if (!('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value.length > 600 || Array.from(descriptor.value).length > 300) return null;
            normalized[field] = descriptor.value;
          }
        }
        result[key] = normalized;
      }
      return result;
    } catch (_) { return null; }
  }

  function accountDays(cache, expectedUserId, now = new Date(), locale = 'ru') {
    void locale;
    try {
      if (!plain(cache) || expectedUserId == null || ownValue(cache, 'userId') !== expectedUserId ||
          !(now instanceof Date) || !Number.isFinite(now.getTime())) return {};
      if (ownValue(cache, 'authRejectedUserId') === expectedUserId &&
          [401, 409].includes(ownValue(cache, 'authRejectedStatus'))) return {};
      const progress = normalizeProgressMap(ownValue(cache, 'byAnime'));
      if (!progress) return {};
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
      const first = new Date(today);
      first.setDate(today.getDate() - 83);
      const firstKey = dateKey(first);
      const todayKey = dateKey(today);
      const days = {};
      for (const [id, row] of Object.entries(progress)) {
        if (Date.parse(row.watched_at) > now.getTime()) continue;
        const key = dateKey(new Date(row.watched_at));
        if (key < firstKey || key > todayKey) continue;
        const bucket = days[key] || (days[key] = { records: [], count: 0, partial: false });
        bucket.count++;
        if (bucket.records.length < 32) bucket.records.push({
          animeId: Number(id), savedAt: row.watched_at, episode: row.episode,
          position: row.position_sec, duration: row.duration_sec, voice: row.voice,
          ...(row.title === undefined ? {} : { title: row.title }),
          ...(row.title_ru === undefined ? {} : { title_ru: row.title_ru }),
        });
        else bucket.partial = true;
      }
      return days;
    } catch (_) { return {}; }
  }

  // Missing browser observations are unknown, not proof of inactivity.
  function calendar(history, now = new Date(), weeks = 12, accountDays = {}) {
    const length = Math.max(1, Math.min(12, Math.trunc(weeks) || 12)) * 7;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    return Array.from({ length }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - length + 1 + index);
      const key = dateKey(date);
      const raw = history?.days?.[key]?.watchedSeconds;
      const seconds = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
      const bucket = accountDays?.[key];
      return {
        key, date, seconds, today: index === length - 1,
        accountRecords: Array.isArray(bucket?.records) ? bucket.records : [],
        accountCount: Number.isSafeInteger(bucket?.count) && bucket.count >= 0 ? bucket.count : 0,
        accountPartial: bucket?.partial === true,
        level: seconds === null ? null : seconds === 0 ? 0
          : seconds < 900 ? 1 : seconds < 1800 ? 2 : seconds < 3600 ? 3 : 4,
      };
    });
  }

  global.AniRekoActivity = Object.freeze({ calendar, dateKey, normalizeProgressMap, accountDays });
})(typeof globalThis !== 'undefined' ? globalThis : window);
