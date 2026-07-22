(function initProgress(global) {
  function calculateProgress(currentTime, duration) {
    const current = Number(currentTime);
    const total = Number(duration);
    if (!Number.isFinite(current) || !Number.isFinite(total) || current < 0 || total <= 0) {
      return null;
    }
    return Math.max(0, Math.min(1, current / total));
  }

  function isWatched(currentTime, duration, threshold = 0.8) {
    const progress = calculateProgress(currentTime, duration);
    return progress !== null && progress >= threshold;
  }

  global.AniRekoProgress = { calculateProgress, isWatched };
})(typeof globalThis !== 'undefined' ? globalThis : window);
