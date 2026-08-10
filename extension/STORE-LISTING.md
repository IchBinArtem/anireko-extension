# Chrome Web Store disclosure

## Localized listing

Category: **Entertainment**.

### Русский

**Название:** AniReko — трекер аниме

**Краткое описание:** Распознаёт аниме на любом сайте, показывает совместимость, отмечает «смотрю» и хранит локальную статистику.

**Описание:**

AniReko помогает не терять прогресс при просмотре аниме на разных сайтах.

- распознаёт название аниме, серию и озвучку;
- показывает процент совместимости с вашим вкусом;
- хранит локальную статистику просмотра;
- по вашему выбору синхронизирует статус и прогресс с аккаунтом AniReko.

Расширение не показывает рекламу и не продаёт пользовательские данные. Полный адрес страницы и видео не отправляются для распознавания.

### English

**Name:** AniReko — Anime Tracker

**Short description:** Recognizes anime on any site, shows taste match, marks watching status, and keeps local viewing statistics.

**Description:**

AniReko helps you keep your anime progress across different websites.

- recognizes the anime title, episode, and voice track;
- shows how well the title matches your taste;
- keeps local viewing statistics;
- optionally syncs your status and progress with your AniReko account.

The extension does not show ads or sell user data. The full page address and video are not sent for recognition.

## Privacy disclosure

AniReko requests `<all_urls>` because its single core purpose is to recognize anime playback on arbitrary websites and inside arbitrary cross-origin player frames. Chrome's native site-access controls let each user run it on click, on selected sites, or on all sites.

- Locally read: cleaned anime title, episode/voice labels, and HTML5 player timing/state.
- Sent for catalog matching when a permitted page looks like anime: the cleaned title, without credentials. No full page URL or video content.
- Sent automatically for a signed-in user to calculate the taste-match percentage: the recognized anime ID with the current AniReko session. This does not write to the user's list.
- Sent only when account sync is enabled to write status and progress: anime ID, status, episode, position, duration, voice track, and expected bound account ID.
- Sent only with diagnostics opt-in: unsupported-player hostname and a compact structural probe without path, query, cookies, or watch history.
- Sent only after the user clicks “anime is present” on an unrecognized page: hostname and the same compact structural probe, without URL/path/query, page title/content, cookies, account identity, or watch history.
- Stored locally: consent, minimal watch history, account binding, and caches. URL-bearing tab state uses browser-session storage and is cleared when Chrome closes.
- User control: Chrome owns site grants; one popup action removes AniReko local history, caches, settings, and account binding.

The extension does not sell data, run ads, or collect seek segments, playback-rate profiles, or browsing history.
