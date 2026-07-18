# Changelog

Chromium releases now use the same version numbers as the Firefox
extension for the same feature set. The two entries below originally
shipped from this repo as "4.8.0" and "4.8.1"; they correspond to
Firefox 4.7.1 and 4.7.2 and have been renumbered to match (nothing was
ever published to the Chrome Web Store under the old numbers).

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
