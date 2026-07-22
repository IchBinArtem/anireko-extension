# Permissions

## Required

- `storage` — consent, local watch history, caches, account binding, and session-only tab state.
- `<all_urls>` — the core feature recognizes anime and HTML5 playback on arbitrary sites and in arbitrary cross-origin player frames. A static detector runs at `document_start` in all frames; no player-provider domain list is used.

Incognito use is disabled. The extension does not request `tabs`, `scripting`, browsing history, cookies, webRequest, or debugger access.

## Native Chrome site controls

Chrome itself lets the user choose “on click”, selected sites, or all sites from the extension menu/settings. These native controls directly govern static content-script injection, so AniReko does not duplicate them in its popup or persist a second site allowlist.

Site access and account writes are separate controls. Mutating status/progress sync remains fail-closed until the user enables sync and binds the current AniReko `user_id`.
