(function initTrust(global) {
  const TOP_ONLY = new Set([
    'scout-observed', 'page-observed', 'probe-update', 'recognition', 'frame-visibility',
  ]);
  const ALLOWED_TYPES = new Set([
    ...TOP_ONLY, 'detector-handshake', 'voice-change', 'episode-observed', 'player-progress',
  ]);

  function httpOrigin(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
    } catch {
      return null;
    }
  }

  function permissionPattern(origin) {
    const normalized = httpOrigin(origin);
    return normalized ? `${normalized}/*` : null;
  }

  function validObservedAt(value) {
    const number = Number(value);
    const now = Date.now();
    return Number.isFinite(number) && number >= now - 5 * 60_000 && number < now + 60_000;
  }

  function validateSensorMessage(message, sender, runtimeId) {
    if (!message || typeof message !== 'object' || !ALLOWED_TYPES.has(message.type)) {
      return { ok: false, reason: 'payload_invalid' };
    }
    if (!sender?.tab?.id || sender.id !== runtimeId) {
      return { ok: false, reason: 'sender_invalid' };
    }
    const senderOrigin = httpOrigin(sender.url || sender.origin);
    const topOrigin = httpOrigin(sender.tab.url);
    const documentOrigin = httpOrigin(message.documentUrl);
    if (!senderOrigin || !topOrigin || senderOrigin !== documentOrigin) {
      return { ok: false, reason: 'sender_origin_mismatch' };
    }
    if (typeof message.documentToken !== 'string'
      || message.documentToken.length < 16 || message.documentToken.length > 128
      || !validObservedAt(message.observedAt)) {
      return { ok: false, reason: 'payload_invalid' };
    }
    if (TOP_ONLY.has(message.type) && Number(sender.frameId || 0) !== 0) {
      return { ok: false, reason: 'top_frame_required' };
    }
    if (message.type === 'recognition'
      && (typeof message.title !== 'string' || message.title.length < 2 || message.title.length > 180)) {
      return { ok: false, reason: 'payload_invalid' };
    }
    if (message.type === 'scout-observed'
      && (typeof message.url !== 'string' || message.url.length > 2000
        || typeof message.title !== 'string' || message.title.length > 180
        || !Array.isArray(message.frames) || message.frames.length > 40)) {
      return { ok: false, reason: 'payload_invalid' };
    }
    if (message.type === 'frame-visibility'
      && (!Array.isArray(message.frames) || message.frames.length > 50
        || message.frames.some((frame) => !frame || !httpOrigin(frame.src) || frame.src.length > 2000
          || typeof frame.visible !== 'boolean'
          || !Number.isFinite(frame.rect?.width) || frame.rect.width < 0 || frame.rect.width > 10000
          || !Number.isFinite(frame.rect?.height) || frame.rect.height < 0 || frame.rect.height > 10000
          || (frame.episode != null
            && (!Number.isInteger(frame.episode) || frame.episode < 1 || frame.episode > 5000))))) {
      return { ok: false, reason: 'payload_invalid' };
    }
    if (message.type === 'player-progress') {
      const duration = message.duration;
      const current = message.currentTime;
      if ((duration != null && (!Number.isFinite(duration) || duration < 0 || duration > 86400))
        || (current != null && (!Number.isFinite(current) || current < 0 || current > 86400))
        || (message.episode != null
          && (!Number.isInteger(message.episode) || message.episode < 1 || message.episode > 5000))
        || (message.episodeAuthoritative != null
          && typeof message.episodeAuthoritative !== 'boolean')) {
        return { ok: false, reason: 'payload_invalid' };
      }
    }
    if (message.type === 'episode-observed') {
      const sourceKinds = new Set(['top-dom', 'player-dom', 'document-event', 'player-message']);
      if (!Number.isInteger(message.episode) || message.episode < 1 || message.episode > 5000
        || typeof message.authoritative !== 'boolean'
        || !sourceKinds.has(message.sourceKind)
        || (message.sourceKind === 'player-message'
          && (!httpOrigin(message.sourceFrameUrl) || String(message.sourceFrameUrl).length > 2000))) {
        return { ok: false, reason: 'payload_invalid' };
      }
    }
    if (message.type === 'voice-change'
      && (typeof message.voice !== 'string' || message.voice.length < 1 || message.voice.length > 100)) {
      return { ok: false, reason: 'payload_invalid' };
    }
    return {
      ok: true,
      tabId: sender.tab.id,
      origin: senderOrigin,
      topOrigin,
      documentId: sender.documentId || `frame-${sender.frameId || 0}`,
      documentToken: message.documentToken,
      topFrame: Number(sender.frameId || 0) === 0,
    };
  }

  // Top-document videos are directly observable by their content script.
  // Child-frame videos need a matching top-frame visibility report; treating
  // an unknown iframe as visible would leave a short hidden-player race.
  function playerVisibilityConfirmed(player) {
    if (!player || player.locallyVisible === false) return false;
    return Number(player.frameId || 0) === 0 || player.frameVisible === true;
  }

  global.AniRekoTrust = {
    httpOrigin,
    permissionPattern,
    playerVisibilityConfirmed,
    validateSensorMessage,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
