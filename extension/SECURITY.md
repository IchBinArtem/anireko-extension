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

## Public source boundary

The public repository contains only the extension client, its tests, documentation, and reproducible release tooling. `extension/api-contract.json` documents the fixed HTTPS boundary, while unit and browser tests verify the client-side network and field allowlists.

The extension never connects directly to the database. Server implementation, PHP, SQL, storage, database schema, deployment configuration, server-side guards, and secret-bearing files remain private and are tested in the private AniReko CI.

Supported versions are the latest Chrome Web Store release and the current tagged source release.
