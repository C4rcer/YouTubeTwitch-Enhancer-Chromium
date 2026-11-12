# Changelog

Chromium releases now use the same version numbers as the Firefox
extension for the same feature set. The two entries below originally
shipped from this repo as "4.8.0" and "4.8.1"; they correspond to
Firefox 4.7.1 and 4.7.2 and have been renumbered to match (nothing was
ever published to the Chrome Web Store under the old numbers).

## 4.8.13 - 2026-11-12

Brings this repo to the Firefox 4.8.13 feature set (Firefox 4.8.12 and 4.8.13); the Firefox CHANGELOG has the full story behind each fix.

### Added

- A "Rate it on the Chrome Web Store" link beside the existing Ko-fi link in the popup, both settings pages and the welcome page. It opens the extension's store page in a new tab, and nothing is sent unless you click it. Same as the Firefox 4.8.12 rating link, which points at addons.mozilla.org.

### Fixed

- Channel points auto-claim no longer clicks Twitch's disabled "Claim Bonus" button (the grey chest) or announces "Claimed channel points" every 5 seconds while nothing is being claimed. Each click is followed to its outcome: "Claimed channel points" once Twitch removes the bonus, "Twitch couldn't claim the channel points bonus" after its error state, and one "Twitch hasn't confirmed the channel points claim" if the button stays disabled for 30 seconds (as happens when `k.twitchcdn.net`, Twitch's anti-bot script host, is blocked). Matches Firefox 4.8.12; the four regressions in `tests/twitch.test.js` came across unchanged.
- Live streams were sped up by the default playback speed, a remembered per-channel speed and playback profiles, and with "Hide already-watched videos" on they were recorded as watched as soon as they played. YouTube no longer sets the `ytp-live` class on `#movie_player` that the live check relied on, and profiles had never checked for YouTube live streams. Same fix as Firefox 4.8.13: the player API's `isLive`, trusted only once the player is on the video in the address bar, with the time display's `ytp-live` switch as the fallback. This build's isolated content scripts can't call the player API, so `page-quality.js` (MAIN world) answers a `ytb-live-query` DOM event with a `ytb-live-data` event carrying `getVideoData()`'s video ID and live flag as a JSON string. It replies inside the query's `dispatchEvent()` call, so the check stays synchronous and needs no message round trip or DOM attribute.

### Validation

- Live-stream fix, checked end to end on 2026-11-09 in a throwaway headless Chrome 153 profile with the unpacked extension, on Lofi Girl's live stream and normal videos reached from its sidebar by in-page navigation. Before the fix, a 1.75x playback profile played the live stream at 1.75x, and a 1.5x default speed played it at 1.5x after going back to it from a normal video. With the fix the live stream stayed at 1x in all four cases (opened directly or by going back, default speed or profile), while the normal videos still got 1.5x and 1.75x. From the content script's isolated world, `#movie_player` exposed no `getVideoData`, and the `ytb-live-query` exchange returned the live stream's ID with `isLive: true` as a string (and `isLive: false` for the normal video).
- The Firefox 4.8.13 regressions came across through `patch` (the content-filter harness takes a `player` option here), plus three Chromium ones: the MAIN-world helper's answer in `tests/page-quality.test.js`, and the isolated-world path in the content-filter and player-controls tests, each against the real or a stand-in `page-quality.js`. All ten fail against the previous Chromium code; the full suite passes 144/144.

## 4.8.11 — 2026-11-04

Brings this repo to the Firefox 4.8.11 feature set; the Firefox CHANGELOG has the full story behind each fix.

### Fixed

- Auto-claim drops silently stopped claiming on the drops inventory page. Twitch changed the inventory claim control from a styled link with the exact text "Claim" to a plain button labelled "Claim Now" with no stable data attributes, so the claim pass (which still ran every 2.5 seconds) never matched anything. The matcher now accepts "Claim Now" as well as "Claim"; all existing guards (stable-attribute match, disabled state, skipping the popover's link to the inventory page) are unchanged. Matches Firefox 4.8.5.
- "Block this Twitch category" now resolves the card you right-clicked, wherever on it you clicked (Browse card tag pills such as "IRL", box art, padding, the home page's featured stream, sidebar cards by name), instead of answering "Couldn't work out which category that is". A right-click on a sidebar card no longer falls through to the watched stream's category, collection shelf headings such as "Just Chatting & IRL" get a message explaining they are not categories, and shelf category cards save a clean name. Same change as the Firefox "Unreleased" fix of 2026-11-01; its regression tests live in the Firefox repo's `tests/twitch.test.js`, which this repo does not have yet.
- The previous video's title could stay under the player beside the current one after the add-on wrote the heading (a DeArrow title, the title repair, or the original put back when DeArrow titles is switched off). The clean-up for the add-on's own stale title text now runs on every pass and as soon as YouTube inserts the new title, whatever the DeArrow setting, instead of only while DeArrow titles is on. Firefox 4.8.9 also removes any title text YouTube's ShadyDOM does not own, which catches text whose markers were cleared; Chromium content scripts cannot see the page-world data that proof needs, so here it stays inert and only the marker-based clean-up applies. Its regression tests live in the Firefox repo's `tests/content-filter.test.js`.
- Auto max quality could leave a video at YouTube's automatic quality, which follows the player's size, for the whole video. It set the quality once and stopped: content.js asked `page-quality.js` until it answered "done", and it answered after its first attempt. After an in-page navigation the player reports the new video with its streams, then about 100 ms later resets its preference to "auto" while it loads that video's formats, which undid that attempt. content.js now asks on every pass, and `page-quality.js` re-applies the highest level until the video plays at it (or five seconds have passed), skips an ad's streams and a player still on the previous video, and afterwards corrects only a fall back to "auto", so a quality you pick by hand is kept. Same fix as Firefox 4.8.10, where the reset was reproduced live; new regressions in `tests/page-quality.test.js` and `tests/content-filter.test.js` replay it and fail against the previous code.
- YouTube search left an empty "Shorts" heading and "Show more" button where each Shorts shelf had been; a `grid-shelf-view-model` holding Shorts is now hidden whole. (Firefox 4.8.6)
- Blocked keywords matched the channel name, view count and age of watch-page sidebar videos, because the title lookup read the whole metadata block; titles are now looked up in priority tiers, and DeArrow writes to the title link. (Firefox 4.8.6)
- One emote provider that never answered held back all third-party emotes. Each lookup now gives up after 8 seconds (the service worker aborts its fetch too), all six run at once, and each provider's emotes appear as soon as it answers. (Firefox 4.8.6)
- The drops auto-claim tab could close before the inventory rendered, and claiming only worked with Twitch in English. The tab now closes 6 seconds after its last claim or after 30 seconds with nothing to claim, never while you're on it, and "Claim Now" is recognised in every Twitch UI language. (Firefox 4.8.6)
- Playback profiles re-applied on every save, undoing manual speed, caption and compressor changes; they now re-apply only when a profile changes, and a profile's volume boost lasts the session on its own. "Remember speed per channel" records the shared speed hotkeys again. (Firefox 4.8.6)
- DeArrow showed a lower-ranked replacement title when the community had voted for the original; only the top-ranked submission counts now. (Firefox 4.8.6)
- Context menu entries could be missing until the next browser restart; they are now built every time the service worker starts. (Firefox 4.8.6)
- Browser sync could fail for block lists with non-Latin names; chunks are now cut by UTF-8 bytes and never inside a character. (Firefox 4.8.6)
- Disliking a video didn't change the Return YouTube Dislike count. The extension never sends votes, so RYD's count can't include yours; the shown count now adds one while your dislike is pressed. (Firefox 4.8.11)

### Performance

- Hidden-video details and undo history moved out of the shared `data` record into their own keys (`ytbHiddenVideoMeta`, `ytbRecentActions`), so frequent saves no longer copy them to every tab. Existing copies move once; the service worker reads the large keys only when there is something to move. (Firefox 4.8.7)
- No wheel listener is attached unless a wheel shortcut is configured, and then only on the player. Caption updates no longer trigger full filtering passes, and a background YouTube tab catches up on watched-history changes once when shown. The uptime chip's dead LD+JSON lookup is gone. (Firefox 4.8.7)

### Validation

- The Firefox regression tests for these changes are ported: `tests/mini-dom.js`, `tests/twitch.test.js` and `tests/background.test.js`, plus new cases in the content-filter, player-controls and common-features tests. They are adapted to Chromium's page-world bridges, the service-worker relay for emote requests, `sendResponse` messaging and emotes being off by default. 30 of them fail against the previous Chromium code, and the full suite passes 130/130. Not yet run in a Chromium browser.

## 4.8.4 — 2026-07-18

Parity with the Firefox 4.8.1 language-coverage fixes and the Firefox
4.8.2 / 4.8.3 / 4.8.4 channel watched-counter fixes, released together
as a single Chrome Web Store update (4.8.0 was the last submission, so
4.8.1 through 4.8.3 have no separate Chromium package).

### Fixed

- Paid / rental badge hiding now recognises Japanese, Korean, Chinese, Russian, Turkish, Polish, and Arabic labels, and keeps localized "free with ads" badges visible, matching the members-only badge's language coverage. It also matches each language's bare "paid" badge ("Kostenpflichtig", 有料, and similar), which appears alongside the buy/rent wording; the German strings were verified against the live storefront.
- The desktop guide's Shorts entry is now also matched by its language-independent /shorts link, and the Japanese channel tab (ショート) is hidden like its English counterpart.
- The workspace's "Show transcript" lookup now matches localized button labels (Transkript, transcription, 文字起こし, and similar) instead of only the English wording.
- The channel page "Watched N / total" badge could exceed the channel's own video count (for example 596 / 514). YouTube's SPA keeps the previous channel page, header included, hidden in the DOM after navigation (verified live: on a watch page reached from a channel, the hidden `ytd-browse[page-subtype="channels"]`, its header h1, and even the channel's canonical link all remain readable). Channel-page detection therefore kept reporting the last visited channel on watch pages and feeds, and every watched video encountered there, including the entire related sidebar, was credited to that channel's tally. Channel identity is now derived from the URL and scraped only from the visible channel header, with a stale header that names a different handle contributing nothing.
- On a genuine channel page, a tile carrying a different channel's byline (channel home shelves and featured playlists can surface other channels' videos) is still hidden as watched but no longer credited to the page channel's "Watched" count.
- The per-channel "Watched" tally could still absorb other channels' videos on channel-to-channel navigation, which is why the counter jumped when moving between channel pages. Two remaining leaks, both verified live: the SPA keeps other channels' cached pages hidden in the DOM with their byline-less video grids intact, and the tile scanner visits them; and on a channel-to-channel navigation the reused page confirms its new header seconds before the grid restamps, so the previous channel's byline-less cards briefly sit inside the new channel's confirmed page (about 3 seconds in live sampling). Channel attribution of a byline-less card now requires all of: a confirmed page identity (rendered header matching the URL, canonical link for /channel/UC pages), the card living inside that channel's visible page, and the card not being a carry-over (a recycled element still holding the video it had under another page's context attributes nothing until it is restamped with the new channel's video). Hiding of watched videos is unaffected throughout, including while attribution is suspended.
- The "Watched N / total" badge, its insertion point, and the scraped channel video total now wait for the confirmed header, so a mid-navigation or hidden cached header can no longer supply another channel's total or swallow the badge.
- A channel could show another channel's video total in the badge (e.g. Gamers Nexus, 3.2k videos, showing "/ 514" inherited from a previously visited channel). Two causes: earlier versions wrote the previous channel's scraped total into the new channel's record during the same stale-header windows, and the total parser could not read abbreviated counts ("3.2k videos"), so the wrong stored value never self-corrected on the channel's own page. The parser now handles abbreviated counts (3.2k, 1.5m, 3,2 mil, 1,2 Tsd., 1,2 тыс., 1.2万 and similar, with ',' or '.' before a multiplier read as a decimal point), refuses a header row that names a different @handle than the current channel, and, as a side effect of the same fix, Russian and Greek totals parse for the first time (the old word-boundary check never matched after Cyrillic or Greek words).
- Watched database v6: per-channel watched attributions are reset once (inflated tallies cannot be repaired in place), and stored channel totals are reset once, since older data may hold another channel's count. The watched-video set itself and the hidden tallies are untouched, so the migration never un-hides a video. Attributions rebuild from each channel's own pages and future watches; totals re-scrape on the next visit to each channel page, and the badge already falls back to the freshly scraped value, so the denominator reappears immediately.

### Validation

- Live-verified on youtube.com (in Firefox, on the shared content script): the URL flips first, the header confirms roughly 300ms later, and the reused grid keeps the previous channel's cards for about 3 seconds under the new header. The abbreviated parser was verified against the live Gamers Nexus header row ("@GamersNexus•2.63m subscribers•3.2k videos" parses to 3200, skipping the subscriber count).
- New regressions cover the attribution guards (unconfirmed identity attributes nothing, byline-less cards outside the confirmed visible page are ignored, a carried-over card is not credited until it is restamped, foreign-byline tiles are hidden without being attributed), the abbreviated total formats across locales with the subscriber-count trap and foreign-handle rejection, and the v6 migration dropping stale attributions and totals while preserving the watched set and hidden tallies. The Chromium suite passes 96/96 (the Firefox 94 plus the two Chromium MAIN-world bridge regressions).

## 4.8.0 — 2026-07-16

Port of the Firefox 4.8.0 release.

### Added

- Configurable keyboard, auxiliary-mouse, and player-wheel actions shared by YouTube and Twitch, retaining `[`, `]`, and `\` as defaults.
- Named playback profiles with channel rules, quality/caption/compressor preferences, active-profile feedback, and graceful native-quality fallback. On Chromium the profile quality selection runs in the MAIN-world page-quality.js helper (new `ytb-profile-quality` bridge message), since the isolated world cannot reach YouTube's player API.
- A rendered-transcript/chapter workspace and local YouTube subscription collections with JSON/CSV transfer and quota-bounded optional Sync.
- Bounded Twitch player recovery, live-edge/delay controls, configurable seeking, local sidebar favourites/groups/search, and a reversible theater/fullscreen chat overlay.
- Collapsible Twitch sidebar groups: a manager toggle tucks a group's non-favourite members out of the default sidebar view, while search and the group's own view still reveal them.
- The browser-sync status line now appears with the sync control on both settings pages instead of YouTube only.
- Progressive shared settings navigation, search, Basic/Advanced views, persisted collapsible sections, themes, presets, privacy disclosure, redacted diagnostics, recent actions/undo, selective import merge/replace, and automatic pre-reset backups.
- Sorted 500-row manager paging, hidden-video metadata for new entries, and accessibility improvements for popup tabs, labels, focus, forced colours, reduced motion, and helper text.

### Changed

- Twitch card work now uses cached dirty-subtree processing with bounded hydration recovery instead of mutation-triggered or periodic full-page article scans.
- Twitch selectors prefer stable data attributes, URLs, roles, and media state; documented text fallbacks fail closed.
- Shared storage normalization, JSON backup/merge, and browser-sync payloads now preserve the new bounded local models (`ytCollections`, `twitchSidebar`) with quota caps, without adding a host permission or custom backend.

### Fixed

- Release a reused watch heading whose text was last written by the extension for a previous video, so the old video's title can no longer persist under the next video after an end-screen or suggested-video navigation. The native-title repair now records its own write, letting later passes distinguish an unhydrated reused heading from a genuine hydration even when neither video has a DeArrow replacement.
- Remove the extension's own stale heading text node when YouTube's SPA hydration appends the new video's title beside it instead of replacing it, which rendered the previous and current titles together under the player.
- Keep the Twitch sidebar group manager's rename and collapse controls working after a save: handlers now resolve the group by ID at event time and the open manager re-renders on storage updates, so the asynchronous storage echo can no longer orphan the objects behind an open panel's rows.

### Validation

- Ported the dependency-free suites for the shared schema/runtime, YouTube workspace, Twitch experience, settings helpers, and static UI accessibility, plus the regressions for watch-heading reuse, appended-duplicate heading pruning, the chat overlay move/restore lifecycle, chat-batch mutation bounds, and collapsed sidebar groups. The Chromium suite passes 87/87 (the Firefox 85 plus the two Chromium MAIN-world bridge regressions).

## 4.7.2 — 2026-07-15

### Fixed

- Reconcile DeArrow watch-page titles against the route, watch container, and MAIN-world player identity during YouTube SPA navigation so Chromium cannot retain or reapply the previous video's title.
- Recover the new video's native title from verified player data when YouTube reuses the old heading, including videos without a DeArrow replacement.
- Defer watch-title writes while YouTube's route, watch container, and player identities disagree, then reprocess on page-data and lookup completion.

### Validation

- Add two watch-page SPA regressions; the dependency-free suite now contains 37 tests.

## 4.7.1 — 2026-07-14

### Fixed

- Hold startup cards, shelves, and promo renderers behind a layout-preserving pre-paint gate until settings, watched history, and the first classification finish; fail open after three seconds if initialization stalls.
- Classify continuation batches plus relevant progress-width, title, link, badge, and text hydration in the mutation's observer turn.
- Re-evaluate virtualized/recycled renderers when their video URL changes, and never cache incomplete shells before identity, title, or channel metadata arrives.
- Repair managed filter classes stripped by YouTube and release route/settings-scoped reasons immediately when their filter is disabled.
- Keep detached internal card mutations on the incremental path instead of scheduling a redundant full-document pass.
- Hide late promo, news, and Shorts-shelf insertions before their debounced legacy maintenance pass can paint.
- Remove the prior 40-selector relational anti-flash stylesheet and permanent keep markers during same-DOM extension updates.
- Restore DeArrow titles and thumbnails when DeArrow or the YouTube master switch is disabled, and bind originals/replacements to the current video so recycled cards cannot restore or retain another video's metadata.
- Preserve dirty watched-history batches after failed writes while a failed initial read stays read-only.
- Make clear generation-tagged, mutation-barrier protected, and distributed across tabs; current-generation state repairs any older fixed-key write that lands afterward.
- Make watched and channel-hidden Undo operations deterministic across tabs, including against stale whole-shard snapshots.
- Re-read invalidated startup snapshots without consuming the storage-failure budget, retry transient startup failures with backoff, repair stale persisted counts, and prevent delayed loaders from publishing across a local clear.
- Complete the v2-to-v3 migration from the monolithic watched-operation record to sharded records, including records received from an older live tab.
- Keep distributed-clear notifications behind a mutation barrier so synchronous rescans cannot repopulate the history being cleared.
- Invalidate SponsorBlock badge results when categories change, remove badges from recycled cards immediately, and preserve the six-request cap across category generations.
- Report clear failures in the options page while retaining the existing durable history.

### Performance

- Replace the 200 ms whole-document mutation reaction with a synchronous dirty-card pass driven by MutationObserver records.
- Keep high-frequency style/text/thumbnail observation scoped to known cards and comments, and ignore unrelated style/class churn.
- Canonicalize nested YouTube renderers to one outer card and deduplicate every mutation batch.
- Search only newly inserted subtrees for legacy shelf/promo renderers instead of rescanning an existing large grid for every mutation record.
- Replace the 2-second recovery loop and 1.5-second global progress scan with event-driven filtering plus a 10-second safety pass.
- Stop physically moving Polymer grid nodes; CSS display-contents layout reflows rows while filtered nodes remain hidden in place.
- Use a true trailing debounce for unrelated page/player work.
- Persist and drain SponsorBlock/DeArrow card queues with at most six concurrent requests per service, including initial and duplicate cards.
- Batch watched-history writes after a scan goes quiet, with a 10-second maximum wait and a background/page-hide flush.
- Shard watched Undo operations alongside watched IDs so one remove/restore does not rewrite the complete operation history.
- Stop YouTube observers, queues, and recurring timers when a newer content-script instance takes over.

### Validation

- Add 35 dependency-free Node regressions covering a 600-card channel, incremental appends, bounded shelf scanning, hydration, incomplete/recycled renderers, DeArrow identity, filter precedence and route release, redundant-scan suppression, storage sharding/retry and autonomous read recovery, simultaneous tabs, distributed clear/re-entry, loader races and churn, stale-generation repair, metadata repair, load-time/live operation migration, Undo convergence, and Chromium MAIN-world player/idle bridge fallbacks.
