# Network boundary

All production requests are built by `lib/api-client.js` from the immutable `https://anireko.com` base and an action allowlist. Content scripts and the popup have no direct `fetch` egress. User-writable storage cannot redirect the API.

| Action | Data sent | Condition |
|---|---|---|
| Catalog match | Cleaned anime title or a manual catalog-search query | After first-run disclosure, when Chrome allows AniReko on a page that looks like anime; manual search requires an explicit popup action |
| Taste match | AniReko anime ID | Signed-in user on a recognized title |
| Account check | AniReko session cookie | Popup on a recognized anime page / account-bound sync and progress-read checks |
| Status sync | Anime ID, status, expected bound user ID | Explicit account sync + trusted top origin |
| Progress sync | Anime ID, episode, position, duration, voice, expected bound user ID | Explicit account sync + trusted top origin |
| Unsupported-player diagnostic | Hostname and compact structural probe | Separate diagnostics opt-in |
| Recognition-miss report | Hostname and compact structural probe | Explicit click on “Здесь есть аниме” |

Full third-party URLs, paths, queries, iframe URLs, page titles/content, and video content are never sent to AniReko. Search and diagnostic requests omit credentials; account-scoped actions use the AniReko cookie.
The local watch-history candidate wires the service worker and popup to fixed
`history-read`, `history-initialize`, `history-command`, `history-select` and
`history-settle` actions; local source wiring does not prove installed/Store/public
server availability. Reads carry strict integer
anime/account IDs; writes additionally carry immutable command/history/cycle identities
and exact state expectations. POST uses JSON and `X-Anireko-Watch-History: 1`, not a
client-supplied credential. Inputs reject unknown fields/coercion; POST bodies are bounded
at 64 KiB without truncating selection choices. GET cannot initialize a history.
Automatic and manual diagnostics contain no anime ID or title; the backend also discards those legacy fields from older clients.
The `watch-command-journal` stores at most one unresolved immutable
history command globally (70,000 UTF-8 bytes maximum), without source URLs or cookies.
Admission uses the actual wire validator synchronously; persistence precedes delivery.
Retry is explicit, preserves UUID/body/CAS, and never starts on extension startup.
An acknowledged historical receipt does not release the slot until a fresh authorized
history read succeeds. Explicit settlement sends the original immutable intent with
`operation=settle`; a separate `X-Anireko-Watch-Expected-User` header binds the current
authenticated account, without rewriting the original owner expectation. Only an exact
typed outcome/hash proof is persisted before the fresh original-root GET can release
pending. Another login alone receives no old title/intent descriptor; transferred
ownership is checked server-side. Unknown/corrupt receipts remain unresolved. Settlement
and Retry never start automatically on restart or login change.
Account/navigation invalidation fences callbacks; the service worker fences legacy
status/progress writers while the history namespace owns the mutation. Complete related
cycle choices require explicit selection without defaults; incomplete pagination cannot
authorize POST. Local Chromium reload/lost-ACK fixtures are evidence only for their
loopback environment, not installed or real browser-to-backend acceptance.
When automatic catalog matching is not unique, the selected catalog ID and metadata are stored locally against the normalized recognized title. The binding contains no source URL or hostname and is revalidated through catalog search before it can authorize sync.
An explicit season with an empty initial result may use one base-title search, followed by one catalog-alias search. Automatic selection requires a unique exact alias for the requested season that is also present among the base-title candidates; the first season is never selected merely because its base title matches.
