(function initAutoMark(global) {
  const MANUAL_STATUSES = new Set(['dropped', 'on_hold', 'completed']);

  function normalizedType(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizedReleaseStatus(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizedEpisode(value) {
    const episode = Number(value);
    return Number.isInteger(episode) && episode > 0 ? episode : null;
  }

  function desiredStatus(match, currentEpisode) {
    const type = normalizedType(match?.type);
    const releaseStatus = normalizedReleaseStatus(match?.releaseStatus);
    const totalEpisodes = normalizedEpisode(match?.totalEpisodes);
    const episode = normalizedEpisode(currentEpisode);

    // A movie is an explicit one-shot format contract from AniReko. The
    // caller invokes this only after the media itself crossed the 80% gate.
    if (type === 'MOVIE') return 'completed';

    // Catching up with an ongoing title is not completion. Unknown totals or
    // finality fail closed as well: third-party DOM cannot prove "last ep".
    if (releaseStatus !== 'FINISHED' || totalEpisodes === null || episode === null) {
      return 'watching';
    }
    return episode >= totalEpisodes ? 'completed' : 'watching';
  }

  function needsMetadataRefresh(match, currentEpisode) {
    const type = normalizedType(match?.type);
    const totalEpisodes = normalizedEpisode(match?.totalEpisodes);
    const episode = normalizedEpisode(currentEpisode);
    if (type === 'MOVIE' || episode === null) return false;
    return match?.completionMetadataReady !== true
      || totalEpisodes === null
      || episode >= totalEpisodes;
  }

  function transitionFor(existingStatus, wantedStatus) {
    const existing = existingStatus == null ? null : String(existingStatus);
    if (MANUAL_STATUSES.has(existing)) return null;
    if (wantedStatus === 'completed') {
      return existing === null || existing === 'planned' || existing === 'watching'
        ? 'completed'
        : null;
    }
    if (wantedStatus === 'watching') {
      return existing === null || existing === 'planned' ? 'watching' : null;
    }
    return null;
  }

  global.AniRekoAutoMark = { desiredStatus, needsMetadataRefresh, transitionFor };
})(typeof globalThis !== 'undefined' ? globalThis : window);
