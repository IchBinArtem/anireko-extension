const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let sessionUser = null;
let watchStatus = null;
let sessionInfoRequests = 0;
let searchRequests = 0;
const statusPosts = [];
const diagnosticPosts = [];
const progressPosts = [];
let progressPostsInFlight = 0;
let maxProgressPostsInFlight = 0;
let resetGeneration = 0;

const pages = {
  '/health': ['text/plain', 'ok'],
  '/anime.html': ['text/html; charset=utf-8', `<!doctype html>
    <html lang="ru"><head>
      <meta charset="utf-8">
      <meta name="description" content="Смотреть аниме онлайн, 2 серия">
      <meta property="og:title" content="Расхититель гробниц — смотреть аниме онлайн">
      <title>Расхититель гробниц — аниме</title>
    </head><body>
      <main><h1>Расхититель гробниц аниме</h1></main>
      <ul class="b-translators__list"><li class="b-translator__item active">AniTime Voice</li></ul>
      <iframe id="main-player" src="http://localhost:4178/player.html" width="800" height="450"></iframe>
      <iframe id="hidden-player" src="http://localhost:4178/hidden-player.html" style="display:none"></iframe>
    </body></html>`],
  '/player.html': ['text/html; charset=utf-8', `<!doctype html>
    <html><body>
      <div class="serial-panel"><select><option>1 сезон</option></select><select id="episode-select"><option>1 серия</option><option selected>2 серия</option><option>3 серия</option><option>11 серия</option><option>12 серия</option></select></div>
      <video id="main-video" src="/episode.mp4" muted style="display:block;width:800px;height:450px"></video>
    </body></html>`],
  '/hidden-player.html': ['text/html; charset=utf-8', `<!doctype html>
    <html><body>
      <select aria-label="Voice"><option selected>FakeDub</option></select>
      <video id="hidden-video" src="/ad.mp4" muted style="display:block;width:640px;height:360px"></video>
    </body></html>`],
  // Generic media page: several real HTML5 players, but no anime metadata.
  // The popup must not present those players as a successful anime result.
  '/generic-video.html': ['text/html; charset=utf-8', `<!doctype html>
    <html><head><meta charset="utf-8"><title>Kimi WebBridge product page</title></head><body>
      <main><h1>Browse the web with a local agent</h1></main>
      <video src="/ad.mp4" muted></video><video src="/ad.mp4" muted></video>
      <video src="/ad.mp4" muted></video><video src="/ad.mp4" muted></video>
    </body></html>`],
  // Mimics VK VideoHub on animesss.com: web component with an open shadow
  // root hiding the player iframe; episode is only an attribute on the host.
  '/shadow-anime.html': ['text/html; charset=utf-8', `<!doctype html>
    <html lang="ru"><head>
      <meta charset="utf-8">
      <meta property="og:title" content="Расхититель гробниц — смотреть аниме онлайн">
      <title>Расхититель гробниц — аниме</title>
    </head><body>
      <main><h1>Расхититель гробниц аниме</h1></main>
      <div id="mount"></div>
      <script>
        class FakePlayer extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'open' });
            const frame = document.createElement('iframe');
            frame.src = 'http://localhost:4178/shadow-player.html';
            frame.width = 800; frame.height = 450;
            root.appendChild(frame);
          }
        }
        customElements.define('fake-player', FakePlayer);
        const player = document.createElement('fake-player');
        player.setAttribute('episode', '3');
        player.setAttribute('season', '1');
        document.getElementById('mount').appendChild(player);
      </script>
    </body></html>`],
  '/shadow-player.html': ['text/html; charset=utf-8', `<!doctype html>
    <html><body>
      <video id="shadow-video" src="/episode.mp4" muted style="display:block;width:800px;height:450px"></video>
    </body></html>`],
  // Recognized anime but the player iframe never yields a <video> —
  // the popup must offer the diagnostic report (KAN-2714).
  '/broken-anime.html': ['text/html; charset=utf-8', `<!doctype html>
    <html lang="ru"><head>
      <meta charset="utf-8">
      <meta property="og:title" content="Расхититель гробниц — смотреть аниме онлайн">
      <title>Расхититель гробниц — аниме</title>
    </head><body>
      <main><h1>Расхититель гробниц аниме</h1></main>
      <iframe id="opaque-player" src="http://localhost:4178/empty-player.html" width="800" height="450"></iframe>
    </body></html>`],
  '/empty-player.html': ['text/html; charset=utf-8', `<!doctype html>
    <html><body><div id="proprietary-player">no html5 video here</div></body></html>`],
  '/shell-player.html?episode=6&translations=false': ['text/html; charset=utf-8', `<!doctype html>
    <html><body><div id="proprietary-player">video starts only after user interaction</div></body></html>`],
  // Movie page: full-length video, no episode markup anywhere (KAN-2714).
  '/movie-anime.html': ['text/html; charset=utf-8', `<!doctype html>
    <html lang="ru"><head>
      <meta charset="utf-8">
      <meta property="og:title" content="Расхититель гробниц — смотреть аниме онлайн">
      <title>Расхититель гробниц — аниме</title>
    </head><body>
      <main><h1>Расхититель гробниц аниме</h1></main>
      <iframe id="movie-player" src="http://localhost:4178/movie-player.html" width="800" height="450"></iframe>
    </body></html>`],
  '/movie-player.html': ['text/html; charset=utf-8', `<!doctype html>
    <html><body>
      <video id="movie-video" src="/episode.mp4" muted style="display:block;width:800px;height:450px"></video>
    </body></html>`],
  '/url-player.html?episode=8&translations=false': ['text/html; charset=utf-8', `<!doctype html>
    <html><body>
      <video id="url-video" src="/episode.mp4" muted style="display:block;width:800px;height:450px"></video>
    </body></html>`],
  '/url-player.html?episode=9&translations=false': ['text/html; charset=utf-8', `<!doctype html>
    <html><body>
      <video id="url-video" src="/episode.mp4" muted style="display:block;width:800px;height:450px"></video>
    </body></html>`],
};

// Generic fallback fixture: no episode DOM inside the player. The episode is
// an explicit query parameter on the document that owns the real <video>, and
// the voice is the selected value of a regular combobox on the anime page.
pages['/url-metadata-anime.html'] = [
  pages['/anime.html'][0],
  pages['/anime.html'][1]
    .replace(
      /<ul class="b-translators__list">.*?<\/ul>/u,
      '<div class="selectors"><div class="select-control"><div class="css-singleValue">Озвучка AniDUB (10 эп.)</div><input role="combobox" aria-expanded="false"></div></div>'
    )
    .replace(
      'src="http://localhost:4178/player.html"',
      'src="http://localhost:4178/url-player.html?episode=8&amp;translations=false"'
    ),
];

pages['/shell-anime.html'] = [
  pages['/anime.html'][0],
  pages['/anime.html'][1]
    .replace(
      'src="http://localhost:4178/player.html"',
      'src="http://localhost:4178/shell-player.html?episode=6&amp;translations=false"'
    ),
];

const server = http.createServer((request, response) => {
  if (request.url.startsWith('/api/search')) {
    searchRequests += 1;
    const query = new URL(request.url, 'http://localhost').searchParams.get('q') || '';
    const data = /расхититель/iu.test(query)
      ? [{
        id: 4242,
        title: 'Расхититель гробниц',
        subtitle: 'Tomb Raider',
        slug: 'tomb-raider',
        year: 2024,
        type: 'TV',
        episodes: 12,
        release_status: 'FINISHED',
      }]
      : [];
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify({ success: true, data }));
    return;
  }
  if (request.url.startsWith('/api/auth/session-info.php')) {
    sessionInfoRequests += 1;
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(sessionUser
      ? { success: true, user: { ...sessionUser, avatar: '', provider: 'test', nsfw_show: false } }
      : { success: false, error: 'No session' }));
    return;
  }
  if (/^\/api\/anime\/\d+\/match/u.test(request.url)) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(sessionUser
      ? {
        success: true,
        data: {
          has_profile: true,
          match_percent: sessionUser.id === 953 ? 12 : 87,
          label_key: sessionUser.id === 953 ? 'unlikely' : 'very_likely',
          confidence_label_key: 'high',
        },
      }
      : { success: true, data: { has_profile: false, reason: 'guest' } }));
    return;
  }
  if (request.url.startsWith('/api/anime/status.php')) {
    if (request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch { payload = { raw: body }; }
        if (!sessionUser || payload.expected_user_id !== sessionUser.id) {
          response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ success: false, error: 'sync_account_changed' }));
          return;
        }
        statusPosts.push(payload);
        watchStatus = payload.status;
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ success: true, data: { status: watchStatus } }));
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ success: true, data: { status: watchStatus } }));
    return;
  }
  if (request.url.startsWith('/api/extension/diagnostic.php')) {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try { diagnosticPosts.push(JSON.parse(body)); } catch { diagnosticPosts.push({ raw: body }); }
      response.writeHead(204);
      response.end();
    });
    return;
  }
  if (request.url.startsWith('/__test/diagnostics')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(diagnosticPosts));
    return;
  }
  if (request.url.startsWith('/api/extension/progress.php')) {
    if (request.method === 'GET') {
      const query = new URL(request.url, 'http://localhost').searchParams;
      if (!sessionUser || Number(query.get('expected_user_id')) !== sessionUser.id) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'sync_account_changed' }));
        return;
      }
      const shape = (p) => ({
        episode: p.episode ?? null,
        position_sec: p.position_sec,
        duration_sec: p.duration_sec ?? null,
        voice: p.voice || '',
        watched_at: new Date().toISOString(),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      if (query.get('all')) {
        const map = {};
        for (const p of progressPosts) map[String(p.anime_id)] = shape(p);
        response.end(JSON.stringify({ progress_all: map }));
        return;
      }
      const animeId = Number(query.get('anime_id'));
      const last = [...progressPosts].reverse().find((p) => p.anime_id === animeId);
      response.end(JSON.stringify({ progress: last ? shape(last) : null }));
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { raw: body }; }
      if (!sessionUser || payload.expected_user_id !== sessionUser.id) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'sync_account_changed' }));
        return;
      }
      progressPostsInFlight += 1;
      maxProgressPostsInFlight = Math.max(maxProgressPostsInFlight, progressPostsInFlight);
      const generation = resetGeneration;
      setTimeout(() => {
        if (generation === resetGeneration) {
          progressPosts.push(payload);
          progressPostsInFlight -= 1;
        }
        response.writeHead(204);
        response.end();
      }, 250);
    });
    return;
  }
  if (request.url.startsWith('/__test/progress')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(progressPosts));
    return;
  }
  // Test-only control endpoints for the e2e spec.
  if (request.url.startsWith('/__test/session')) {
    const query = new URL(request.url, 'http://localhost').searchParams;
    const on = query.get('on') === '1';
    const userId = Number(query.get('user') || 18);
    sessionUser = on ? { id: userId, name: userId === 953 ? 'Demo YooKassa' : 'TestUser' } : null;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, sessionUser }));
    return;
  }
  if (request.url.startsWith('/__test/reset')) {
    sessionUser = null;
    watchStatus = null;
    sessionInfoRequests = 0;
    searchRequests = 0;
    statusPosts.length = 0;
    diagnosticPosts.length = 0;
    progressPosts.length = 0;
    resetGeneration += 1;
    progressPostsInFlight = 0;
    maxProgressPostsInFlight = 0;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.url.startsWith('/__test/status-posts')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(statusPosts));
    return;
  }
  if (request.url.startsWith('/__test/watch-status')) {
    const value = new URL(request.url, 'http://localhost').searchParams.get('value');
    watchStatus = value === 'null' ? null : value;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, watchStatus }));
    return;
  }
  if (request.url.startsWith('/__test/request-counts')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      search: searchRequests,
      sessionInfo: sessionInfoRequests,
      statusPosts: statusPosts.length,
      diagnostics: diagnosticPosts.length,
      maxProgressPostsInFlight,
    }));
    return;
  }
  if (request.url === '/episode.mp4' || request.url === '/ad.mp4') {
    const file = path.join(__dirname, request.url.slice(1));
    const size = fs.statSync(file).size;
    const range = request.headers.range;
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/u);
      const start = Number(match?.[1] || 0);
      const end = match?.[2] ? Number(match[2]) : size - 1;
      response.writeHead(206, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
        'cache-control': 'no-store',
      });
      fs.createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(response);
    return;
  }
  const [contentType, body] = pages[request.url] || ['text/plain', 'not found'];
  response.writeHead(pages[request.url] ? 200 : 404, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  response.end(body);
});

function startFixtureServer() {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(4178, '0.0.0.0');
  });
}

function stopFixtureServer() {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

if (require.main === module) {
  void startFixtureServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void stopFixtureServer().then(() => process.exit(0)));
  }
}

module.exports = { startFixtureServer, stopFixtureServer };
