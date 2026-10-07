# Network boundary

All production requests are built by `lib/api-client.js` from the immutable `https://anireko.com` base and an action allowlist. Content scripts and the popup have no direct `fetch` egress. User-writable storage cannot redirect the API.

| Action | Data sent | Condition |
|---|---|---|
| Catalog match | Cleaned current anime title, up to four adjacent alternative titles, or a manual catalog-search query | After first-run disclosure, when Chrome allows AniReko on a page that looks like anime; manual search requires an explicit popup action |
| Taste match | AniReko anime ID | Signed-in user on a recognized title |
| Account check | AniReko session cookie | Popup on a recognized anime page / account-bound sync and progress-read checks |
| Status sync | Anime ID, status, expected bound user ID | Explicit account sync + trusted top origin |
| Progress sync | Anime ID, episode, position, duration, voice, expected bound user ID | Explicit account sync + trusted top origin |
| Unsupported-player diagnostic | Hostname and compact structural probe | Separate diagnostics opt-in |
| Recognition-miss report | Hostname and compact structural probe | Explicit click on “Здесь есть аниме” |

Full third-party URLs, paths, queries, iframe URLs, full page text and video content are never sent to AniReko. Catalog search sends only the bounded current-title strings above. Search and diagnostic requests omit credentials; account-scoped actions use the AniReko cookie.
Alternative titles come only from the plain direct LI text of the list immediately
adjacent to a unique current H1 in its title block. Linked/nested items, comments
and recommendations are excluded. Only an unresolved primary title triggers this
bounded fallback; manual bindings and exact primary matches need no alias requests.
All planned responses must complete and exact evidence must converge to one catalog
ID, preserving the original numeric/season restrictions. The query tuple is cached
and deduplicated, including Unicode; unchanged rescans/media ticks do not search.
Late insertion, removal or ambiguous title blocks replace the same-document tuple.
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
New Complete admission retains strict, separately domain-separated SHA-256 proofs
of its original native media and top document/navigation context in
the immutable local journal binding. The hash is not a wire field, request hash,
credential, or playback sample. Original Retry may restore only that saved binding;
missing legacy provenance is not backfilled from the current/replacement player.
An acknowledged historical receipt does not release the slot until a fresh authorized
history read succeeds. Explicit settlement sends the original immutable intent with
`operation=settle`; a separate `X-Anireko-Watch-Expected-User` header binds the current
authenticated account, without rewriting the original owner expectation. Only an exact
typed outcome/hash proof is persisted before the fresh original-root GET can release
pending. Another login alone receives no old title/intent descriptor; transferred
ownership is checked server-side. Unknown/corrupt receipts remain unresolved. Settlement
and Retry never start automatically on restart or login change.
With account sync enabled, two current natural non-seeking native media observations
may initialize/start tracking, or resume the sole matching paused origin after play.
They must share account/mapping/document/player scope; complete origin pagination and
an empty foreground are required. The existing durable command journal and server
state expectations remain authoritative. A Start never increments completed totals.
A local terminal barrier (`watch-terminal-barriers-v1`, at most 500 account/title
scopes) is persisted before Complete delivery, including explicit retry. It stores
episode/duration and a SHA-256 native-media lineage, not source URLs. Backward seek
cannot unlock the barrier; a series opening on an earlier episode or an opening
after the original native terminal media ended is required. For movies/single episodes,
a known different top document/navigation context may also qualify, but only jointly
with fresh scoped native Play and two naturally advancing non-seeking opening observations.
Opening/reloading alone, Play without advance, and replacement media in the same
top context cannot qualify. Actual playback (including autoplay) means Started,
not deliberate intent or Completed; previous completion totals remain unchanged.
Legacy context is unknown and is never backfilled from current media. Ambiguous restart/end
evidence fails closed. Neither local barrier data nor lineage hashes are uploaded.
For multi-episode finished TV, the same final episode ending is not a whole-anime
restart: a strictly earlier episode is required. Existing unique paused cycles
resume without the new-Start opening gate. The five-minute progress-write throttle
does not suppress lifecycle admission or terminal evidence. At full barrier capacity,
an unrecorded title cannot automatically initialize/start, including after restart;
no entry is evicted and existing cycle controls remain available.
An explicit Cancel suppresses a new automatic cycle in the same live document
until a newly observed play action; continued timeupdates do not undo Cancel.
The stop is written to trusted session storage before Cancel POST, surviving
service-worker restart, scoped to account/title/tab and native document. Closing
a tab removes only its own stops. A retry lacking the original live document conservatively
requires a new play for that account/title. This guard is local, never uploaded.
Original retry/settlement revokes pre-command cycle capabilities; its receipt is
not publication of current-document state, which requires an explicit fresh read.
History caches and asynchronous controller publication are generation-fenced.
After an accepted mutation and fresh receipt read, every pre-command snapshot is
retired, including a GET started while the command was reserved.
Scoped play evidence survives metadata/rate events until natural advance, but is
revoked by pause, seek, ended, account/mapping or native document/player change.
Account/navigation invalidation fences callbacks; the service worker fences legacy
status/progress writers while the history namespace owns the mutation. Complete related
cycle choices require explicit selection without defaults; incomplete pagination cannot
authorize POST. Local Chromium reload/lost-ACK fixtures are evidence only for their
loopback environment, not installed or real browser-to-backend acceptance.
When automatic catalog matching is not unique, the selected catalog ID and metadata are stored locally against the normalized recognized title. The binding contains no source URL or hostname and is revalidated through catalog search before it can authorize sync.
An explicit season with an empty initial result may use one base-title search, followed by one catalog-alias search. Automatic selection requires a unique exact alias for the requested season that is also present among the base-title candidates; the first season is never selected merely because its base title matches.
Recognition arrivals are fenced before asynchronous consent reads by the native top-document ID, detector token and exact page URL. A fresh page-observed receipt permits navigation even when its consent read finishes later; an old native document cannot revoke the new mapping. Popup/session recovery and publication cannot admit a tuple already superseded by a live recognition receipt. Same-native-document SPA changes remain supported. These receipts are volatile/local and are cleared with their tab; no new endpoint, timer or upload is introduced.
