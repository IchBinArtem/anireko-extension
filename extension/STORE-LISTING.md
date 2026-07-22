# Chrome Web Store disclosure

AniReko requests `<all_urls>` because its single core purpose is to recognize anime playback on arbitrary websites and inside arbitrary cross-origin player frames. Chrome's native site-access controls let each user run it on click, on selected sites, or on all sites.

- Locally read: cleaned anime title, episode/voice labels, and HTML5 player timing/state.
- Sent for catalog matching when a permitted page looks like anime: cleaned title only. No full page URL or video content.
- Sent only when account sync is enabled: anime ID, status, episode, position, duration, voice track, and expected bound account ID.
- Sent only with diagnostics opt-in: unsupported-player hostname and a compact structural probe without path, query, cookies, or watch history.
- Sent only after the user clicks “anime is present” on an unrecognized page: hostname and the same compact structural probe, without URL/path/query, page title/content, cookies, account identity, or watch history.
- Stored locally: consent, minimal watch history, account binding, and caches. URL-bearing tab state uses browser-session storage and is cleared when Chrome closes.
- User control: Chrome owns site grants; one popup action removes AniReko local history, caches, settings, and account binding.

The extension does not sell data, run ads, or collect seek segments, playback-rate profiles, or browsing history.
