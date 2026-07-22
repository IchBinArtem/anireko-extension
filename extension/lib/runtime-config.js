(function initRuntimeConfig(global) {
  // Store builds always talk to AniReko production. The extension E2E suite
  // copies the source to a temporary directory and replaces this file there;
  // no user-writable storage key can redirect production traffic.
  global.AniRekoRuntimeConfig = Object.freeze({
    apiBase: 'https://anireko.com',
    testMode: false,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
