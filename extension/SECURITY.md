# Security policy

Please report extension security issues privately to `info@anireko.com`. Do not include authentication cookies, tokens, private page URLs, or personal watch history in a report.

Security invariants:

- fixed AniReko API origin and action allowlist;
- exact sender/document/top-origin validation for content-script messages;
- current-navigation document tokens reject stale iframe messages;
- episode/voice signals are bound to the reporting player document; top-page signals require one unambiguous active visible player, so hidden or competing iframes fail closed;
- status/progress writes require both an explicitly trusted top origin and a live account ID matching the bound account;
- account-scoped reads carry the expected user ID and taste caches are partitioned by the live account;
- server endpoints repeat the expected-user check before mutation;
- only one lexical exact catalog result auto-confirms; ambiguous/inexact candidates require an explicit local binding that is freshly revalidated against catalog search, while stale/closed tabs and revoked privacy consent fail closed before popup-triggered writes;
- Chrome native host controls govern where the static detector can run; diagnostics and account mutation are independently fail-closed.

## Local write lifecycle (source candidate)

The service worker owns extension storage mutations. Popup settings/cache writes use
typed background commands; a popup cannot supply arbitrary storage objects. Each
operation captures an instance/epoch binding before its asynchronous work. Clear
closes admission synchronously, drains entered local/session writes, then clears
storage. It acknowledges only after clearing succeeds; failure does not reopen the
old instance. A distinct concurrent settings/clear operation cannot borrow another
operation's acknowledgement. Successful control creates a new instance and popup
revision; old popup capabilities fail closed.

Observed account changes invalidate pending bindings. Queued progress/history
captures media values before entering the queue; completion metadata and taste
responses recheck their binding before publication. In-flight reservations have
per-operation ownership: stale completion releases only its own reservation,
never a newer same-key operation. A session read pairs its rendered account with
a fresh popup capability, including guest/401 responses: authorization failure
does not disable local clear or grant account sync. Popup and tab-close recovery
admit only their exact persisted tab state, preserve newer sensor publications,
and keep the usual account/origin checks. Tests exercise the actual
service-worker listener and delayed storage/network boundaries in a synthetic VM.
This is local source evidence, not installed Chrome/restart or Store acceptance.
The watch-cycle journal/controller and public history endpoint remain separate,
unwired work; these lifecycle guards do not implement the complete rewatch UI.

## Public source boundary

The public repository contains only the extension client, its tests, documentation, and reproducible release tooling. `extension/api-contract.json` documents the fixed HTTPS boundary, while unit and browser tests verify the client-side network and field allowlists.

The extension never connects directly to the database. Server implementation, PHP, SQL, storage, database schema, deployment configuration, server-side guards, and secret-bearing files remain private and are tested in the private AniReko CI.

Supported versions are the latest Chrome Web Store release and the current tagged source release.
