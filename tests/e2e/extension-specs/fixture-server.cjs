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
let failProgressPosts = false;

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
  '/ambiguous-anime.html': ['text/html; charset=utf-8', `<!doctype html>
    <html lang="ru"><head>
      <meta charset="utf-8">
      <meta name="description" content="Смотреть аниме онлайн, 2 серия">
      <meta property="og:title" content="3000 лет практики ци — смотреть аниме онлайн">
      <title>3000 лет практики ци — аниме</title>
    </head><body>
      <main><h1>3000 лет практики ци аниме</h1></main>
      <ul class="b-translators__list"><li class="b-translator__item active">АниСтар</li></ul>
      <iframe id="main-player" src="http://localhost:4178/player.html" width="800" height="450"></iframe>
    </body></html>`],
  '/missing-catalog-anime.html': ['text/html; charset=utf-8', `<!doctype html>
    <html lang="ru"><head>
      <meta charset="utf-8">
      <meta property="og:title" content="Совсем неизвестное аниме — смотреть онлайн">
      <title>Совсем неизвестное аниме</title>
    </head><body>
      <main><h1>Совсем неизвестное аниме</h1></main>
      <iframe id="main-player" src="http://localhost:4178/player.html" width="800" height="450"></iframe>
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

pages['/shell-terminal-anime.html'] = [
  pages['/anime.html'][0],
  pages['/anime.html'][1]
    .replace(
      'src="http://localhost:4178/player.html"',
      'src="http://localhost:4178/shell-player.html?episode=12&amp;translations=false"'
    ),
];

// Keep the original numeric-title fixture: the detector sees digits while the
// catalog uses Russian number words. It must resolve to 3000, never 100000.
pages['/numeric-title-anime.html'] = [...pages['/ambiguous-anime.html']];

// A real ambiguous title with two lexically exact catalog rows still requires
// an explicit choice after numeric equivalence became exact.
pages['/ambiguous-anime.html'] = [
  'text/html; charset=utf-8',
  `<!doctype html>
    <html lang="ru"><head>
      <meta charset="utf-8">
      <meta name="description" content="Смотреть аниме онлайн, 2 серия">
      <meta property="og:title" content="Одинаковое имя — смотреть аниме онлайн">
      <title>Одинаковое имя — аниме</title>
    </head><body>
      <main><h1>Одинаковое имя аниме</h1></main>
      <iframe id="main-player" src="http://localhost:4178/player.html" width="800" height="450"></iframe>
    </body></html>`,
];

pages['/bookworm-season-4.html'] = [
  'text/html; charset=utf-8',
  `<!doctype html>
    <html lang="ru"><head>
      <meta charset="utf-8">
      <meta name="description" content="Смотреть аниме онлайн, 15 серия">
      <meta property="og:title" content="Власть книжного червя 4 сезон — смотреть аниме онлайн">
      <title>Власть книжного червя 4 сезон — аниме</title>
    </head><body>
      <main><h1>Власть книжного червя 4 сезон</h1></main>
      <iframe id="main-player" src="http://localhost:4178/player.html" width="800" height="450"></iframe>
    </body></html>`,
];

// Hentaimama shape: duplicated site-brand H1 precedes the actual episode H1.
pages['/site-brand-before-episode.html'] = [
  'text/html; charset=utf-8',
  `<!doctype html>
    <html><head>
      <meta charset="utf-8">
      <meta name="description" content="Watch anime episode online">
      <meta property="og:title" content="Saimin Jutsu 2 Episode 1">
      <title>Stream Saimin Jutsu 2 Episode 1 with English subs – Hentaimama</title>
    </head><body>
      <header><h1>Hentaimama</h1><h1>Hentaimama</h1></header>
      <div id="info"><h1 class="epih1">Saimin Jutsu 2 - Episode 1</h1></div>
      <iframe id="main-player" src="http://localhost:4178/player.html" width="800" height="450"></iframe>
    </body></html>`,
];

// A recommendation H1 with an episode marker must not outrank the trusted
// main title/metadata and silently bind the neighboring anime.
pages['/primary-title-with-decoy-episode.html'] = [
  'text/html; charset=utf-8',
  `<!doctype html>
    <html><head>
      <meta charset="utf-8">
      <meta name="description" content="Watch anime online">
      <meta property="og:title" content="Saimin Jutsu The Animation">
      <title>Saimin Jutsu The Animation</title>
    </head><body>
      <main><h1>Saimin Jutsu The Animation</h1></main>
      <aside><h1>Jitaku Keibiin 2 - Episode 3</h1></aside>
      <iframe id="main-player" src="http://localhost:4178/player.html" width="800" height="450"></iframe>
    </body></html>`,
];

pages['/secondary-episode-only.html'] = [
  'text/html; charset=utf-8',
  `<!doctype html>
    <html><head>
      <meta charset="utf-8">
      <meta name="description" content="Watch anime online">
    </head><body>
      <aside><h1>Jitaku Keibiin 2 - Episode 3</h1></aside>
      <iframe id="main-player" src="http://localhost:4178/player.html" width="800" height="450"></iframe>
    </body></html>`,
];

// old.yummyani-style player topology: the anime page embeds a neutral wrapper,
// and only that wrapper embeds the cross-origin document that owns <video>.
pages['/nested-anime.html'] = [
  pages['/anime.html'][0],
  pages['/anime.html'][1]
    .replace(
      'src="http://localhost:4178/player.html"',
      'src="http://localhost:4178/iframeCVH.html?episode=2"'
    )
    .replace('id="main-player"', 'id="outer-player"')
    .replace(/\s*<iframe id="hidden-player"[\s\S]*?<\/iframe>/u, ''),
];
pages['/iframeCVH.html?episode=2'] = ['text/html; charset=utf-8', `<!doctype html>
  <html><body>
    <iframe id="nested-video-frame" src="http://127.0.0.1:4178/nested-video.html" width="800" height="450"></iframe>
  </body></html>`];
pages['/nested-video.html'] = ['text/html; charset=utf-8', `<!doctype html>
  <html><body>
    <video id="nested-video" src="/episode.mp4" muted style="display:block;width:800px;height:450px"></video>
  </body></html>`];
pages['/lazy-nested-anime.html'] = [
  pages['/nested-anime.html'][0],
  pages['/nested-anime.html'][1].replace(
    'src="http://localhost:4178/iframeCVH.html?episode=2"',
    'src="http://localhost:4178/lazy-iframeCVH.html?episode=2"'
  ),
];
pages['/lazy-iframeCVH.html?episode=2'] = ['text/html; charset=utf-8', `<!doctype html>
  <html><body>
    <div id="mount"></div>
    <script>
      setTimeout(() => {
        const frame = document.createElement('iframe');
        frame.id = 'nested-video-frame';
        frame.src = 'http://127.0.0.1:4178/nested-video.html';
        frame.width = 800; frame.height = 450;
        document.getElementById('mount').appendChild(frame);
      }, 10500);
    </script>
  </body></html>`];

const server = http.createServer((request, response) => {
  if (request.url.startsWith('/api/search')) {
    searchRequests += 1;
    const query = new URL(request.url, 'http://localhost').searchParams.get('q') || '';
    const bookwormFourth = {
      id: 13124,
      title: 'Власть книжного червя: Приёмная дочь лорда',
      subtitle: 'Honzuki no Gekokujou: Shisho ni Naru Tame ni wa Shudan wo Erandeiraremasen - Ryoushu no Youjo',
      slug: 'honzuki-no-gekokujou-ryoushu-no-youjo',
      year: 2026,
      type: 'TV',
      episodes: 24,
      release_status: 'ONGOING',
      exact_alias_match: true,
    };
    const data = /Honzuki no Gekokujou:.*4th Season$/iu.test(query)
      ? [bookwormFourth]
      : /власть книжного червя/iu.test(query)
        ? [
          { id: 13126, title: 'Власть книжного червя 3', subtitle: 'Honzuki no Gekokujou 3rd Season', year: 2022, type: 'TV' },
          { id: 13123, title: 'Власть книжного червя', subtitle: 'Honzuki no Gekokujou: Shisho ni Naru Tame ni wa Shudan wo Erandeiraremasen', year: 2019, type: 'TV' },
          { id: 13125, title: 'Власть книжного червя 2', subtitle: 'Honzuki no Gekokujou 2nd Season', year: 2020, type: 'TV' },
          { id: 13127, title: 'Власть книжного червя OVA', year: 2020, type: 'OVA' },
          { id: 13128, title: 'Власть книжного червя: Рекапы', year: 2022, type: 'SPECIAL' },
          { ...bookwormFourth, exact_alias_match: false },
        ]
        : /расхититель/iu.test(query)
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
        : /одинаковое имя/iu.test(query)
        ? [
          {
            id: 19119,
            title: 'Одинаковое имя',
            subtitle: 'Same Name A',
            slug: 'same-name-a',
            year: 2022,
            type: 'ONA',
            episodes: 16,
            release_status: 'FINISHED',
          },
          {
            id: 19120,
            title: 'Одинаковое имя',
            subtitle: 'Same Name B',
            slug: 'same-name-b',
            year: 2024,
            type: 'TV',
            episodes: 12,
            release_status: 'FINISHED',
          },
        ]
        : /(?:3000|три тысячи)/iu.test(query)
          ? [
            {
              id: 19119,
              title: 'Три тысячи лет практики ци',
              subtitle: 'Lian Qi Lianle 3000 Nian',
              slug: 'lian-qi-lianle-3000-nian',
              year: 2022,
              type: 'ONA',
              episodes: 16,
              release_status: 'FINISHED',
            },
            {
              id: 19120,
              title: 'Практикуя ци сто тысяч лет',
              subtitle: 'Lian Qi Shi Wan Nian',
              slug: 'lian-qi-shi-wan-nian',
              year: 2023,
              type: 'ONA',
              episodes: 360,
              release_status: 'ONGOING',
            },
          ]
          : /saimin jutsu 2/iu.test(query)
            ? [{
              id: 23001,
              title: 'Saimin Jutsu 2',
              subtitle: 'Saimin Jutsu The Animation 2nd',
              slug: 'saimin-jutsu-2',
              year: 2014,
              type: 'OVA',
              episodes: 2,
              release_status: 'FINISHED',
            }]
            : /jitaku keibiin 2/iu.test(query)
              ? [{
                id: 23002,
                title: 'Jitaku Keibiin 2',
                subtitle: 'Jitaku Keibiin 2',
                slug: 'jitaku-keibiin-2',
                year: 2018,
                type: 'OVA',
                episodes: 4,
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
      if (failProgressPosts) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'temporary_test_failure' }));
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
  if (request.url.startsWith('/__test/fail-progress-writes')) {
    failProgressPosts = new URL(request.url, 'http://localhost').searchParams.get('on') === '1';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, failProgressPosts }));
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
    failProgressPosts = false;
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
