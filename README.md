# YouTube/Twitch Enhancer (Chromium)

Take back your YouTube and Twitch feeds. Block whole channels and categories,
hide videos by title keyword, remove Shorts, hide what you've already watched,
auto-claim Twitch points and drops, and strip the clutter. There is no analytics,
tracking, or developer backend; optional network features are disclosed below.

This is the **Chromium (Manifest V3) port** for Chrome, Edge, Brave, Opera and
Vivaldi (Chrome 111+). The Firefox add-on lives in its own repo,
[`YouTubeTwitch-Enhancer`](https://github.com/C4rcer/YouTubeTwitch-Enhancer),
which is the primary codebase; feature changes land there first and are ported
here.

This independent extension is not affiliated with or endorsed by YouTube,
Google, Twitch, Amazon, or the named community services.

**[♥ Support development on Ko-fi](https://ko-fi.com/carcer7378)**

## YouTube features

- **Block entire channels.** Open a video's **⋮ menu** and click the injected
  **Block channel** item, right-click any video → **Block this YouTube
  channel**, or add channels by `@handle`, URL, `UC…` ID, or name in the
  popup/options. Every tile from a blocked channel disappears everywhere:
  home, search, sidebar, subscriptions, channel pages, end-screen suggestions.
- **Undo.** Misclicked? Every block/hide shows a toast with an **Undo** button.
- **Keyword / title blocking.** Hide any video whose title contains a word or
  phrase, or use `/regex/` patterns.
- **Keyword-filter comments.** A separate keyword list (same syntax) hides
  matching comments: the whole thread when the top comment matches, just the
  reply otherwise.
- **Black out blocked channels.** Landing on a blocked channel's page or video
  stops playback and covers the content with a black panel (one-click unblock
  available), best-effort at not registering a view.
- **Remove all Shorts**: sidebar entry, channel tabs, shelves, and
  `/shorts/<id>` URLs auto-redirect to the normal `/watch` player.
- **Persistent watched history.** Videos watched past the selected threshold
  (default 90%) are recorded locally, so they stay hidden even if YouTube later
  forgets their progress. Scope Home, Subscriptions, Search, Related, Channel
  pages and Playlists independently; mark a card watched from either its ⋮ menu
  or the right-click menu, and see Watched/Hidden counts on channel pages.
  Watched history can be exported, imported or cleared separately and is never
  sent through browser sync.
- **Reveal hidden (audit mode).** See everything the extension filtered,
  dimmed with a red outline, instead of removed.
- **Master switch.** One toggle in the popup pauses everything instantly.
- **Hide individual videos**: right-click → **Hide this video**, or
  **Ctrl + right-click** for an instant hide.
- **Hide members-only videos** (optional, off by default).
- **Hide paid videos (v4.6, optional, off by default).** Tiles badged
  "Pay to watch", "Buy or rent" or "Buy". Free-with-ads content stays visible.
- **Clean-up extras**: ads/promos/nudges (on by default), plus optional hiding
  of Mixes, playlist tiles, news/topic shelves, the sidebar loading spinner,
  and end-screen/pause-screen suggestions.
- **Auto max quality.** Each new video is set to the highest available
  resolution.
- **Playback speed suite.** A default speed for every new video (live streams
  are skipped), stepping with **[** / **]** (±0.25×, 0.1–8×), reset with
  **\\**, and optional per-channel speed memory.
- **Audio compressor.** A 🎚 button in the player controls runs the sound
  through a dynamics compressor: quiet dialogue comes up, sudden loud parts
  come down.
- **A-B loop.** A 🔁 button: first click marks the start, second the end,
  third clears it.
- **Screenshot.** A 📷 button saves the current frame as a PNG.
- **Never pause me.** Dismisses the "Video paused. Continue watching?" idle
  prompt. On by default.
- **Keep autoplay off / auto-expand description.** Two small optional toggles.
- **In-player volume boost.** A second slider appears next to YouTube's own
  volume control once volume sits at 100%, extending it to 500% via a Web
  Audio gain node; scrolling over the player adjusts volume/boost.
- **Cinema mode.** A ◐ button darkens everything around the player.
- **Import / export / sync.** One-click JSON export/import (merge, no
  duplicates) and optional **browser sync** (e.g. Chrome Sync) so your block
  lists follow your browser account. Settings stay per-device.
- **Reduce flashing.** A layout-preserving pre-paint gate waits for settings,
  watched history and initial classification before revealing cards. It fails
  open after three seconds if storage is unavailable, while continuation batches
  and later title/progress hydration are classified in the observer turn.

## Community data integrations (all off by default)

Three opt-in YouTube features backed by free community-run services, replacing
the separate SponsorBlock / DeArrow / Return YouTube Dislike extensions:

- **SponsorBlock: skip segments.** Auto-skips crowdsourced sponsor reads,
  self-promos, like/subscribe reminders and (optionally) intros, outros,
  previews, non-music sections and filler. Every skip shows a notice with
  **Unskip** (jumps back and stops auto-skipping that segment) and **Report**
  (downvotes a bad segment) buttons. Lookups use SponsorBlock's k-anonymity
  endpoint: only a 4-character hash prefix of the video ID leaves your
  browser.
- **SponsorBlock: create & vote.** A shield button on every video's player
  (while SponsorBlock is on) opens a panel: mark a segment's start and end at
  the playhead (±0.5 s nudges, local test of the jump), pick a category and
  submit it to SponsorBlock; existing segments can be up- or down-voted.
  Submissions and votes carry a local SponsorBlock user ID, generated
  automatically. Migrating from the official SponsorBlock extension? Paste
  your user ID into the options page and your reputation carries over.
- **SponsorBlock: whitelist channels & segment cues.** Whitelist any channel
  (from the shield panel on the player, or the options page) so its segments
  still show on the bar but are never auto-skipped, handy for creators you want
  to support. Videos that already have community segments are flagged with a
  small green shield: on the player's shield button, and as a badge in the
  top-left of every thumbnail across YouTube (search, home, suggestions),
  matching the official extension.
- **DeArrow: community titles & thumbnails.** Replaces clickbait titles (and,
  via a separate heavier toggle, thumbnails) with community-submitted ones
  where they exist.
- **Return YouTube Dislike.** Shows the crowdsourced dislike count on the
  watch page's dislike button.

**Data credits:** segment and title/thumbnail data by
[SponsorBlock](https://sponsor.ajay.app) and
[DeArrow](https://dearrow.ajay.app) (Ajay Ramachandran and contributors),
licensed [CC BY-NC-SA 4.0](https://github.com/ajayyy/SponsorBlock/wiki/Database-and-API-License);
dislike counts by [Return YouTube Dislike](https://returnyoutubedislike.com).
This extension is a non-commercial consumer of those APIs and is not
affiliated with either project. Please consider supporting them directly.

## Twitch features

All Twitch features have their own toggles: the popup's **Twitch** tab has the
quick switches, and **⚙ Twitch advanced…** opens a full Twitch-only manager
page.

- **Block Twitch channels.** Right-click any stream card → **Block this
  Twitch channel**, or add channels by name/URL. Blocked channels vanish from
  the front page, directory grids, search, and the side nav.
- **Block whole categories.** Right-click → **Block this Twitch category**, or
  add by name or directory URL. Usually the most effective clean-up: block the
  category once instead of chasing individual channels.
- **Stream title keywords, blocked tags & hide reruns.** Same `/regex/` syntax
  as the YouTube side.
- **Auto-claim channel points.** The bonus chest is clicked the moment it
  appears, including in background tabs.
- **Auto-claim drops and Moments.** When a drop is ready, the extension opens
  the drops inventory in a background tab, claims everything, and closes it
  again. Moment badges are grabbed the instant their chat callout appears.
- **Anonymous chat (off by default).** Connects to chat as an anonymous user
  so you never appear in the viewer list. Chat becomes read-only while it's
  on; points still accrue.
- **Third-party emotes (opt-in).** BetterTTV, FrankerFaceZ and 7TV emotes (global sets
  plus the current channel's) render in chat, and a 😼 button opens a
  searchable picker. Privacy note: with this toggle on, emote lists are
  fetched from those three services, which see the channel you're watching.
- **Chat performance tools**: line limit, message batching, smooth scrolling.
- **Chat filters**: highlight messages containing your keywords, hide messages
  by word/phrase/`/regex/` or by user.
- **Alternating line shading & show deleted** (off by default).
- **Emote tab-completion.** Tab completes third-party emote names while
  typing; Tab again cycles the matches.
- **Clip download.** Clip pages get a ⬇ Download button.
- **Hide the front-page carousel**, and **hide chat** (visual-only, so points
  keep accruing).
- **Clip helper.** Create a clip with Twitch's own Clip button (or Alt+X),
  publish it, then the **➤ Share clip** button pastes the link into chat and
  sends it.
- **Pin source quality.** New streams start at the highest available quality
  instead of "Auto".
- **In-player volume boost, audio compressor, screenshot, cinema mode**: same
  as the YouTube side.
- **Speed hotkeys on VODs & clips.** Live streams are never touched.
- **Stream uptime.** A ⏱ chip next to the viewer count, read from the page
  itself with no extra requests (best-effort).
- **Sidebar hover previews.** Hovering a live channel in the left sidebar
  shows its current stream thumbnail.
- **Hide extension overlays.** Optionally removes streamer-installed extension
  panels and their notifications from the player.

Designed for desktop `www.youtube.com` and `www.twitch.tv`.

## Install

No build step; this folder is a complete unpacked extension:

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open (or reload) any YouTube or Twitch tab.

To build the store upload package, run `powershell -File build.ps1`. It writes
`youtube-twitch-enhancer-chromium-<version>.zip` containing only the extension
files (`manifest.json`, `icons/`, `src/`, `LICENSE`).

Do **not** package it with `Compress-Archive`: on Windows PowerShell 5.1 that
cmdlet stores entries with backslash separators (`icons\icon-16.png`), which
the Chrome / Opera / Edge store validators reject because they can't resolve
the manifest's `icons/` paths. `build.ps1` writes proper forward-slash entries.
### Automated checks

The regression suite has no npm dependencies:

```powershell
node --test --test-isolation=none tests/content-filter.test.js tests/watched-db.test.js
```

It covers 600-card channels, incremental continuation batches, hydration and
renderer recycling, filter precedence, DeArrow/SponsorBlock identity and queue
behaviour, watched-history sharding/retry, simultaneous tabs, distributed
clears, migration and deterministic Undo convergence.

## Usage

### Block a channel

- **From the ⋮ menu (recommended):** open a video's three-dot menu and click
  the injected **Block channel** item.
- **From a video:** right-click any tile → **Block this YouTube channel**.
- **By hand:** popup or **⚙ Advanced…** → type `@handle`, channel URL,
  `UC…` ID, or display name → **Block**.

### Import / export / sync

| Button / toggle | What it does |
| --- | --- |
| **Export to file** | Downloads `youtube-blocklist-YYYY-MM-DD.json`. |
| **Import from file** | Merges into your current list (no duplicates). |
| **Copy JSON** | Copies the whole block list to the clipboard. |
| **Clear everything** | Removes all blocked channels, hidden videos and keywords (keeps settings). |
| **Browser sync** | Mirrors the block lists (not settings or watched history) to your browser account. |
| **Export / Import watched** | Backs up or merges the separate local watched-history database. |
| **Clear watched history** | Erases locally recorded watched IDs without changing block lists or settings. |

The JSON format is identical to the Firefox add-on's, so block lists move
freely between the two.

### Console helpers (on any YouTube page)

| Command | What it does |
| --- | --- |
| `ytsbListHidden()` | Array of hidden video IDs. |
| `ytsbListChannels()` | Array of blocked-channel records. |
| `ytsbUnhide("VIDEO_ID")` | Removes one video ID. |
| `ytsbResetHidden()` | Clears all hidden video IDs. |

## Privacy

The developer operates no analytics or backend and does not receive or sell
user data. Block lists, settings and watched YouTube video IDs are stored
locally in `chrome.storage.local`; watched history is never synced and can be
exported or erased from Advanced settings. Browser sync and every third-party
integration are optional. [PRIVACY.md](PRIVACY.md) documents the exact local
data, network requests, identifiers and retention controls.

## How it works

- **`src/content.js`** runs at `document_start`. A static startup gate keeps
  card geometry in place while settings and watched history load, with a
  three-second fail-open. A page observer handles inserts and recycled links;
  scoped card/comment observers handle progress, title, badge, thumbnail and
  text hydration. Mutation batches are canonicalized and deduplicated before
  synchronous classification, while unrelated page/player work uses a trailing
  debounce and a 10 s recovery pass. SponsorBlock and DeArrow card work uses
  persistent queues capped at six concurrent requests per service.
- **`src/watched-db.js`** keeps watched IDs and Undo operations in 64 matching
  storage shards. Quiet-window batching, bounded latency, retries and
  generation-tagged cross-tab clears keep persistence outside the filtering hot
  path and make Undo deterministic across tabs. Older layouts migrate
  automatically.
- **`src/twitch.js`** runs at `document_start` and keeps Chromium's dedicated
  page-world bridges for Twitch internals.
- **`src/page-quality.js`** and **`src/page-twitch.js`** (Chromium-specific)
  run in the page's MAIN world. Chromium content scripts are fully isolated
  from the page, so the content scripts can't reach YouTube's player API or
  Twitch's React fibers directly (on Firefox they can, via
  `wrappedJSObject`); instead they relay `postMessage` requests that these
  helpers answer: max quality and playback rate on YouTube; the Slate chat
  editor, channel id, stream start time, and the anonymous-chat WebSocket
  shim on Twitch.
- **`src/background.js`** registers the right-click menus, opens the
  onboarding page on first install, relays the SponsorBlock / DeArrow / RYD
  and emote-API lookups (so page CSP and CORS never interfere), and mirrors
  block lists to browser sync (chunked to fit `storage.sync` quotas) when
  enabled. It's loaded through the **`src/background-sw.js`** Manifest V3
  service-worker entry.
- **`src/popup.*`**, **`src/options.*`** and **`src/twitch-options.*`** share
  storage helpers in **`src/common.js`**; settings and block lists live under
  one `data` key, while watched history uses separate sharded local keys.
  Contexts converge through `storage.onChanged`.
- Content-script instances are tagged with a per-load id and hand over via a
  takeover event, so in-place extension updates never leave orphaned handlers
  fighting the new version.

## Project layout

```
manifest.json                   — Manifest V3 (Chrome 111+)
icons/icon-*.png                — manifest icons (Chromium rejects SVG there)
icons/icon.svg                  — used by the popup/options/onboarding pages
src/
  content.js     content.css    — incremental on-page engine (YouTube)
  watched-db.js                 — sharded local watched-history store
  twitch.js      twitch.css     — the on-page engine (Twitch)
  page-quality.js               — MAIN-world YouTube player helper (Chromium-only)
  page-twitch.js                — MAIN-world Twitch page-internals helper (Chromium-only)
  background.js                 — context menus, onboarding, API relays, browser sync
  background-sw.js              — MV3 service-worker entry (importScripts)
  common.js                     — shared storage/import/export helpers
  popup.html     popup.js       — toolbar popup (YouTube + Twitch panels)
  options.html   options.js     — full manager (YouTube)
  twitch-options.html/.js       — full manager (Twitch)
  onboarding.html               — first-run guide
  ui.css                        — shared popup/options styling
tests/
  content-filter.test.js        — 600-card/incremental DOM regression harness
  watched-db.test.js            — storage, retry and cross-tab regressions
CHANGELOG.md                    — release changes
STORE-LISTING.md                — Chrome Web Store fields and upload checklist
```

## Support

Enjoying it? [Buy me a coffee on Ko-fi](https://ko-fi.com/carcer7378) ♥

## License

[MIT](LICENSE)
