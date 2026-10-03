(function initActivity(global) {
  function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // Missing browser observations are unknown, not proof of inactivity.
  function calendar(history, now = new Date(), weeks = 12) {
    const length = Math.max(1, Math.min(12, Math.trunc(weeks) || 12)) * 7;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    return Array.from({ length }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - length + 1 + index);
      const key = dateKey(date);
      const raw = history?.days?.[key]?.watchedSeconds;
      const seconds = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
      return {
        key, date, seconds, today: index === length - 1,
        level: seconds === null ? null : seconds === 0 ? 0
          : seconds < 900 ? 1 : seconds < 1800 ? 2 : seconds < 3600 ? 3 : 4,
      };
    });
  }

  global.AniRekoActivity = Object.freeze({ calendar, dateKey });
})(typeof globalThis !== 'undefined' ? globalThis : window);
