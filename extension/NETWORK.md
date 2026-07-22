# Network boundary

All production requests are built by `lib/api-client.js` from the immutable `https://anireko.com` base and an action allowlist. Content scripts and the popup have no direct `fetch` egress. User-writable storage cannot redirect the API.

| Action | Data sent | Condition |
|---|---|---|
| Catalog match | Cleaned anime title | After first-run disclosure, when Chrome allows AniReko on a page that looks like anime |
| Taste match | AniReko anime ID | Signed-in user on a recognized title |
| Account check | AniReko session cookie | Popup on a recognized anime page / account-bound sync and progress-read checks |
| Status sync | Anime ID, status, expected bound user ID | Explicit account sync + trusted top origin |
| Progress sync | Anime ID, episode, position, duration, voice, expected bound user ID | Explicit account sync + trusted top origin |
| Unsupported-player diagnostic | Hostname and compact structural probe | Separate diagnostics opt-in |
| Recognition-miss report | Hostname and compact structural probe | Explicit click on “Здесь есть аниме” |

Full third-party URLs, paths, queries, iframe URLs, page titles/content, and video content are never sent to AniReko. Search and diagnostic requests omit credentials; account-scoped actions use the AniReko cookie.
Automatic and manual diagnostics contain no anime ID or title; the backend also discards those legacy fields from older clients.
