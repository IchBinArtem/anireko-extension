const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function load(file, extras = {}) {
  const context = vm.createContext({ console, URL, ...extras });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return context;
}

test('store manifest uses Chrome native host controls with one static all-frame detector', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['<all_urls>'],
    js: ['lib/recognition.js', 'lib/progress.js', 'content/media-detector.js'],
    all_frames: true,
    match_origin_as_fallback: true,
    run_at: 'document_start',
  }]);
});

test('sensor messages require the real sender origin, top frame and fresh document token', () => {
  let now = 1_800_000_000_000;
  const trust = load('lib/trust.js', { Date: { now: () => now } }).AniRekoTrust;
  const sender = {
    id: 'extension-id', frameId: 0, documentId: 'doc-1',
    url: 'https://anime.example/watch', origin: 'https://anime.example',
    tab: { id: 7, url: 'https://anime.example/watch' },
  };
  const message = {
    type: 'recognition', title: 'Anime title', observedAt: now,
    documentToken: '1234567890abcdef', documentUrl: 'https://anime.example/watch',
  };
  assert.equal(trust.validateSensorMessage(message, sender, 'extension-id').ok, true);
  assert.equal(trust.validateSensorMessage({ ...message, documentUrl: 'https://evil.example' }, sender, 'extension-id').ok, false);
  assert.equal(trust.validateSensorMessage(message, { ...sender, frameId: 2 }, 'extension-id').reason, 'top_frame_required');
  assert.equal(trust.validateSensorMessage({ ...message, observedAt: now - 300_001 }, sender, 'extension-id').ok, false);
});

test('episode and voice signals reject malformed cross-frame payloads', () => {
  const now = 1_800_000_000_000;
  const trust = load('lib/trust.js', { Date: { now: () => now } }).AniRekoTrust;
  const sender = {
    id: 'extension-id', frameId: 2, documentId: 'player-doc',
    url: 'https://player.example/embed', origin: 'https://player.example',
    tab: { id: 7, url: 'https://anime.example/watch' },
  };
  const envelope = {
    observedAt: now,
    documentToken: '1234567890abcdef',
    documentUrl: 'https://player.example/embed',
  };
  assert.equal(trust.validateSensorMessage({
    ...envelope, type: 'episode-observed', episode: 8,
    authoritative: false, sourceKind: 'player-dom',
  }, sender, 'extension-id').ok, true);
  assert.equal(trust.validateSensorMessage({
    ...envelope, type: 'episode-observed', episode: 77,
    authoritative: true, sourceKind: 'player-message', sourceFrameUrl: 'javascript:alert(1)',
  }, sender, 'extension-id').reason, 'payload_invalid');
  assert.equal(trust.validateSensorMessage({
    ...envelope, type: 'voice-change', voice: 'x'.repeat(101),
  }, sender, 'extension-id').reason, 'payload_invalid');
});

test('top-frame player hints require bounded HTTP iframe geometry and episode', () => {
  const now = 1_800_000_000_000;
  const trust = load('lib/trust.js', { Date: { now: () => now } }).AniRekoTrust;
  const sender = {
    id: 'extension-id', frameId: 0, documentId: 'top-doc',
    url: 'https://anime.example/watch', origin: 'https://anime.example',
    tab: { id: 7, url: 'https://anime.example/watch' },
  };
  const envelope = {
    type: 'frame-visibility', observedAt: now,
    documentToken: '1234567890abcdef', documentUrl: 'https://anime.example/watch',
  };
  assert.equal(trust.validateSensorMessage({
    ...envelope,
    frames: [{
      src: 'https://player.example/embed?episode=6', visible: true,
      episode: 6, rect: { width: 800, height: 450 },
    }],
  }, sender, 'extension-id').ok, true);
  assert.equal(trust.validateSensorMessage({
    ...envelope,
    frames: [{
      src: 'javascript:alert(1)', visible: true,
      episode: 6, rect: { width: 800, height: 450 },
    }],
  }, sender, 'extension-id').reason, 'payload_invalid');
});

test('child-frame player visibility fails closed until the top frame confirms it', () => {
  const trust = load('lib/trust.js').AniRekoTrust;
  assert.equal(trust.playerVisibilityConfirmed({
    frameId: 0, locallyVisible: true, frameVisible: null,
  }), true);
  assert.equal(trust.playerVisibilityConfirmed({
    frameId: 2, locallyVisible: true, frameVisible: null,
  }), false);
  assert.equal(trust.playerVisibilityConfirmed({
    frameId: 2, locallyVisible: true, frameVisible: false,
  }), false);
  assert.equal(trust.playerVisibilityConfirmed({
    frameId: 2, locallyVisible: true, frameVisible: true,
  }), true);
});

test('only the background allowlist owns network egress', () => {
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const detector = fs.readFileSync(path.join(__dirname, '..', 'content', 'media-detector.js'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  assert.equal(/\bfetch\s*\(/u.test(popup), false);
  assert.equal(/\bfetch\s*\(/u.test(detector), false);
  assert.equal(worker.includes("fetch.bind(globalThis)"), true);
  assert.equal(worker.includes("'api-base'"), false);
  assert.equal(/storage\.local\.(?:get|set|remove)\([^\n]*tab:/u.test(worker), false);
  assert.equal(worker.includes('chrome.storage.session.set({ [storageKey]: current })'), true);
  assert.equal(worker.includes('mediaSeconds: Math.round'), false);
  assert.equal(worker.includes('skips,'), false);
});

test('runtime has no duplicate permission manager or provider-specific player origins', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  const detector = fs.readFileSync(path.join(__dirname, '..', 'content', 'media-detector.js'), 'utf8');
  const recognition = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recognition.js'), 'utf8');
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  assert.equal(worker.includes('chrome.permissions'), false);
  assert.equal(worker.includes('chrome.scripting'), false);
  assert.equal(popup.includes('chrome.permissions'), false);
  assert.equal(popup.includes('site-access-toggle'), false);
  assert.equal(worker.includes('const tabState = stateByTab'), false);
  assert.equal(detector.includes('detector-handshake'), false);
  assert.equal(/kodik|yummyani/iu.test(`${detector}\n${recognition}`), false);
});

test('search cache invalidates pre-completion metadata and retries partial matches', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  assert.equal(worker.includes('const SEARCH_CACHE_VERSION = 3;'), true);
  assert.equal(worker.includes("['type', 'episodes', 'release_status']"), true);
  assert.equal(worker.includes('match.completionMetadataReady ? SEARCH_TTL_OK_MS : SEARCH_TTL_PARTIAL_MS'), true);
  assert.equal(worker.includes('current.match.completionMetadataReady !== true'), true);
  assert.equal(worker.includes("{ forceRefresh: true }"), true);
  assert.equal(worker.includes('completionMetadataRefreshedInSession.add(refreshKey)'), true);
});

test('public API contract and client action allowlist stay aligned', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api-contract.json'), 'utf8'));
  const client = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-client.js'), 'utf8');
  for (const action of Object.keys(contract.actions)) {
    assert.equal(client.includes(`case '${action}'`), true, `missing client action ${action}`);
  }
  assert.deepEqual(Object.keys(contract.actions).sort(), [
    'diagnostic', 'progress-all', 'progress-write', 'search', 'session-info',
    'status-get', 'status-write', 'taste-match',
  ]);
});

test('public export contains every source and fixture used by release verification', () => {
  const repo = path.join(__dirname, '..', '..');
  const listed = new Set(fs.readFileSync(path.join(__dirname, '..', 'public-files.txt'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')));
  const required = [
    '.github/workflows/extension-release.yml',
    'extension/api-contract.json',
    'extension/tests/search-resolve.test.js',
    'tests/e2e/extension-specs/global-setup.cjs',
    'tests/e2e/extension-specs/ad.mp4',
    'tests/e2e/extension-specs/episode.mp4',
  ];
  for (const relative of required) {
    assert.equal(listed.has(relative), true, `public export misses ${relative}`);
    assert.equal(fs.existsSync(path.join(repo, relative)), true, `public source misses ${relative}`);
  }

  assert.equal(listed.size, 42, 'public export allowlist changed without an explicit review');
  const exactSupportFiles = new Set(['.github/workflows/extension-release.yml']);
  for (const relative of listed) {
    assert.equal(
      relative.startsWith('extension/') || relative.startsWith('tests/e2e/') || exactSupportFiles.has(relative),
      true,
      `public export contains an unclassified path: ${relative}`,
    );
    assert.equal(relative.toLowerCase().endsWith('.php'), false,
      `public export contains server-side PHP: ${relative}`);
  }

  const rationaleByDoc = {
    'README.md': ['никогда не подключается к базе данных напрямую', 'Серверная реализация API, PHP-код, SQL, схема и хранилище данных'],
    'SECURITY.md': ['never connects directly to the database', 'Server implementation, PHP, SQL, storage, database schema'],
  };
  for (const [doc, rationale] of Object.entries(rationaleByDoc)) {
    const text = fs.readFileSync(path.join(__dirname, '..', doc), 'utf8');
    for (const phrase of rationale) {
      assert.equal(text.includes(phrase), true, `${doc} lost the public-boundary rationale: ${phrase}`);
    }
  }

  const allowlistText = fs.readFileSync(path.join(__dirname, '..', 'public-files.txt'), 'utf8');
  const exporterText = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'export_public.py'), 'utf8');
  assert.equal(allowlistText.includes('Public boundary is client-only.'), true);
  assert.equal(exporterText.includes('server-side guards are never exported.'), true);
});
