(() => {
  'use strict';
  if (location.hostname !== 'dreamerscast.com' || !/^\/home\/release\/\d+-[^/]+\/?$/.test(location.pathname)) return;
  const initialUrl = location.href;
  let dash = null;
  let activation = null;
  let generation = 0;
  let lastVideo = null;
  let lastEpisode = undefined;
  let lastGeneration = -1;
  let lastAccepted = null;
  function emit(video, episode) {
    const value = Number.isInteger(episode) && episode > 0 && episode <= 5000 ? episode : null;
    if (video === lastVideo && value === lastEpisode && generation === lastGeneration) return;
    lastVideo = video; lastEpisode = value; lastGeneration = generation;
    document.dispatchEvent(new CustomEvent('anireko-dreamcast-prototype', {detail: JSON.stringify({episode: value})}));
  }
  function current() {
    try {
      if (location.href !== initialUrl) return null;
      const videos = [...document.querySelectorAll('#player video')];
      const player = window.pjs;
      const d = player?.api?.('dash');
      if (videos.length !== 1 || !d || d.getVideoElement?.() !== videos[0]) return null;
      const video = videos[0];
      const active = d.getActiveStream?.();
      const info = active?.getStreamInfo?.();
      const manifest = d.getDashAdapter?.()?.getMpd?.()?.manifest;
      if (active?.getIsActive?.() !== true || !info?.manifestInfo?.loadedTime
        || info.manifestInfo.loadedTime !== manifest?.loadedTime) return null;
      return {d, video, info, manifest};
    } catch { return null; }
  }
  function selected(c) {
    try {
      const player = window.pjs;
      const id = player.api('playlist_id');
      const key = /^playlist_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(id || '')?.[1];
      const title = /^\s*Серия\s+(\d{1,4})\s*$/iu.exec(player.api('playlist_title') || '');
      const labels = [...document.querySelectorAll('#player .pjs-player-active-pl')].map(n => /^\s*Серия\s+(\d{1,4})\s*$/iu.exec(n.textContent || '')?.[1]);
      const sourceKey = new URL(c.manifest?.url || c.manifest?.originalUrl || '').pathname.split('/').find(x => x === key);
      if (!key || !title || !labels.length || labels.some(x => x !== title[1]) || !sourceKey) return null;
      return Number(title[1]);
    } catch { return null; }
  }
  function attach() {
    let d; try { d = window.pjs?.api?.('dash'); } catch { return; }
    if (!d || d === dash || typeof d.on !== 'function') return;
    if (dash && dash !== d) emit(lastVideo, null);
    dash = d; activation = null; generation++;
    try { d.on('streamActivated', event => {
      if (d !== dash) return;
      const c = current();
      if (!c || c.d !== d) { activation = null; emit(lastVideo, null); return; }
      if (event?.streamInfo !== c.info) return;
      if (!c.video.currentSrc) { activation = null; emit(c.video, null); return; }
      if (c.video.src !== c.video.currentSrc) { activation = null; emit(c.video, null); return; }
      activation = {...c, src: c.video.currentSrc, ready: false}; generation++;
      emit(c.video, null);
    }); } catch { dash = null; activation = null; emit(lastVideo, null); }
  }
  function check(event) {
    attach();
    const c = current();
    if (!c) { activation = null; emit(lastVideo || event?.target, null); return; }
    if (!activation || c.video !== activation.video || c.d !== activation.d
      || c.info !== activation.info || c.manifest !== activation.manifest
      || c.video.currentSrc !== activation.src || c.video.src !== activation.src || !c.video.isConnected) {
      emit(lastVideo || event?.target, null); return;
    }
    if (event && event.target === c.video && event.isTrusted && ['loadeddata','playing'].includes(event.type)
      && c.video.readyState >= 2 && (!lastAccepted || lastAccepted.src !== activation.src
        || (lastAccepted.video === c.video && lastAccepted.info === c.info && lastAccepted.manifest === c.manifest))) {
      activation.ready = true;
    }
    const episode = selected(c);
    if (!activation.ready || episode === null) { emit(c.video, null); return; }
    lastAccepted = {video:c.video,src:activation.src,info:c.info,manifest:c.manifest};
    emit(c.video, episode);
  }
  for (const name of ['loadstart','emptied','loadeddata','playing','timeupdate','error']) document.addEventListener(name, event => {
    if (event.target?.tagName !== 'VIDEO' || !event.isTrusted) return;
    const videos = [...document.querySelectorAll('#player video')];
    if (event.target !== activation?.video && !(videos.length === 1 && event.target === videos[0])) return;
    if (name === 'loadstart' || name === 'emptied' || name === 'error') { activation = null; emit(event.target, null); attach(); }
    else check(event);
  }, true);
  for (const name of ['popstate','hashchange']) window.addEventListener(name, () => check());
  window.navigation?.addEventListener('currententrychange', () => check());
  const start = () => new MutationObserver(records => {
    attach();
    if (records.some(r => (r.target?.nodeType === 3 ? r.target.parentElement : r.target)?.closest?.('#player')
      || [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && (n.matches?.('#player,video') || n.querySelector?.('#player,video'))))) check();
  }).observe(document.documentElement, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['class','src']});
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, {once:true});
})();
