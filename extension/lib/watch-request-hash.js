(function initWatchRequestHash(global) {
  /** Match the existing PHP producer bytes, not wire operation or account expectation. */
  function canonical(action, request) {
    const input = global.AniRekoApiClient.historyIntent(action, request);
    if (action === 'history-command') {
      const command = { command: input.command, command_id: input.command_id, expected_version: input.expected_version };
      if (input.command !== 'start') command.cycle_id = input.cycle_id;
      if (input.command === 'progress' || input.command === 'complete') {
        // PHP /usD includes dotall: LF is valid. Reject only invalid UTF-8
        // equivalents (unpaired surrogates), never repair the original voice.
        if (input.voice !== null && Array.from(input.voice).some((character) => {
            const point = character.codePointAt(0);
            return point >= 0xd800 && point <= 0xdfff;
          })) throw new Error('history_hash_invalid');
        Object.assign(command, { episode: input.episode, position_sec: input.position_sec,
          duration_sec: input.duration_sec, voice: input.voice });
      }
      return JSON.stringify({ history_id: input.history_id, anime_id: input.anime_id,
        expected_effective_anime_id: input.expected_effective_anime_id,
        expected_foreground_generation: input.expected_foreground_generation, command })
        // PHP UNESCAPED_UNICODE without UNESCAPED_LINE_TERMINATORS still escapes these.
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    }
    const intent = {};
    for (const field of ['history_id', 'anime_id', 'expected_effective_anime_id', 'cycle_id', 'command_id', 'reconciliation_token']) {
      intent[field] = input[field];
    }
    if (Object.hasOwn(input, 'choices')) {
      intent.choices = input.choices.map((row) => ({ history_id: row.history_id, anime_id: row.anime_id, cycle_id: row.cycle_id }));
    }
    // This grammar contains only ASCII UUID/token strings, integers and null.
    return JSON.stringify({ command: 'reconcile', intent });
  }
  async function hash(action, request) {
    const bytes = new TextEncoder().encode(canonical(action, request));
    if (!global.crypto?.subtle) throw new Error('history_hash_unavailable');
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  }
  global.AniRekoWatchRequestHash = Object.freeze({ canonical, hash });
})(typeof globalThis !== 'undefined' ? globalThis : self);
