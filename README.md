# YouTube Channel Blocker & Cleaner (Chromium)

Take back your YouTube feed. Block whole channels, hide videos by title keyword,
remove Shorts, hide what you've already watched, and strip the clutter — all
locally in your browser, with nothing collected or sent anywhere.

This is the **Chromium (Manifest V3) port** — Chrome, Edge, Brave, Opera,
Vivaldi (Chrome 111+). The Firefox add-on lives in its own repo
(`YouTube-Shorts-Blocker-and-Watched-Video-Hider`), which is the primary
codebase; feature changes land there first and are ported here.

**[♥ Support development on Ko-fi](https://ko-fi.com/carcer7378)**

## Features

- **Block entire channels.** Open a video's **⋮ menu** and click the injected
  **Block channel** item, right-click any video → **Block this YouTube channel**,
  or add channels by `@handle`, URL, `UC…` ID, or name in the popup/options.
  Every tile from a blocked channel disappears everywhere — home, search,
  sidebar, subscriptions, channel pages, end-screen suggestions.
- **Undo.** Misclicked? Every block/hide shows a toast with an **Undo** button.
- **Keyword / title blocking.** Hide any video whose title contains a word or
  phrase — or use `/regex/` patterns. Great for dodging spoilers, reaction
  content, or topics you're done with.
- **Black out blocked channels.** Landing on a blocked channel's page or video
  stops playback and covers the content with a black panel (recommendations
  stay, one-click unblock available) — best-effort at not registering a view.
- **Remove all Shorts** — sidebar entry, channel tabs, shelves, and
  `/shorts/<id>` URLs auto-redirect to the normal `/watch` player.
- **Hide already-watched videos** past a progress threshold (default 75%),
  scoped per surface: Home, Subscriptions, Search, Related, Channel pages,
  Playlists — each individually toggleable (playlists off by default so
  Watch Later keeps showing progress).
- **Reveal hidden (audit mode).** See everything the extension filtered, dimmed
  with a red outline, instead of removed — so you can trust what it's doing
  and rescue anything. Toggle off for a pure cleaned page.
- **Master switch.** One toggle in the popup pauses the entire extension
  instantly, no reload needed.
- **Hide individual videos** — right-click → **Hide this video**, or
  **Ctrl + right-click** for an instant hide (works on end-screen suggestions
  too).
- **Clean-up extras** — ads/promos/nudges (on by default), plus optional
  hiding of Mixes, playlist tiles, news/topic shelves, the sidebar loading
  spinner, and end-screen/pause-screen suggestions.
- **Auto max quality.** Each new video is set to the highest available
  resolution.
- **In-player volume boost.** A second slider appears next to YouTube's own
  volume control once volume sits at 100%, extending it to 500% via a Web
  Audio gain node; scrolling over the player adjusts volume/boost. The audio
  graph is only built when you actually boost, so default playback stays
  native.
- **Import / export / sync.** One-click JSON export/import (merge, no
  duplicates) and optional **browser sync** (Chrome Sync) so your block lists
  follow your browser account. Settings stay per-device.
- **Reduce flashing.** Watched videos are held hidden from first paint instead
  of popping in and vanishing.

Designed for desktop YouTube (`www.youtube.com`).

## Install

No build step — this folder is a complete unpacked extension:

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open (or reload) any YouTube tab.

To package for the Chrome Web Store, zip the folder contents (PowerShell:
`Compress-Archive -Path * -DestinationPath ..\youtube-blocker-chromium.zip`).

## Usage

### Block a channel

- **From the ⋮ menu (recommended):** open a video's three-dot menu and click
  the injected **Block channel** item.
- **From a video:** right-click any tile → **Block this YouTube channel**.
- **From a channel's page:** right-click anywhere → **Block this YouTube channel**.
- **By hand:** popup or **Manage block list…** → type `@handle`, channel URL,
  `UC…` ID, or display name → **Block**.

### Hide a single video

Right-click the tile → **Hide this video**, or **Ctrl + right-click** to hide
instantly (also works on the in-player end-screen video wall).

### Keywords

Options page → **Blocked title keywords** → add words, phrases, or
`/patterns/` — matching titles are hidden wherever they appear.

### Import / export / sync

| Button / toggle | What it does |
| --- | --- |
| **Export to file** | Downloads `youtube-blocklist-YYYY-MM-DD.json`. |
| **Import from file** | Merges into your current list (no duplicates; settings only change if present in the file). |
| **Copy JSON** | Copies the whole block list to the clipboard. |
| **Clear everything** | Removes all blocked channels, hidden videos and keywords (keeps settings). |
| **Browser sync** | Mirrors the block lists (not settings) to your browser account (Chrome Sync). |

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

Everything runs locally. The extension collects **no data**, phones home to
**nothing**, and requires no account. Your block list lives in
`chrome.storage.local` (and, only if you enable it, `chrome.storage.sync`
inside your own browser account).

## How it works

- **`src/content.js`** runs at `document_start`. A debounced `MutationObserver`
  (added/removed nodes only) plus a 2 s safety interval re-runs the cleanup
  pass on infinite scroll / SPA navigation; passes are skipped while the tab
  is hidden and caught up on focus. Channel matching merges the `@handle`,
  `UC…` ID, and display name found in a tile and compares case-insensitively;
  tiles are tagged per config version so unchanged tiles aren't re-scanned.
  Tiles are hidden in place (CSS) rather than removed, which avoids fighting
  YouTube's renderer and is what makes audit mode and Undo possible.
- **`src/page-quality.js`** (Chromium-specific) runs in the page's MAIN world.
  Chromium content scripts are fully isolated from the page, so content.js
  can't call YouTube's player API directly (on Firefox it can, via
  `wrappedJSObject`); instead it relays a `postMessage` request that this
  helper answers once the player accepted the max-quality change.
- **`src/background.js`** registers the right-click menu, opens the onboarding
  page on first install, and mirrors block lists to Chrome Sync (chunked to
  fit `storage.sync` quotas) when enabled. It's loaded through the
  **`src/background-sw.js`** Manifest V3 service-worker entry.
- **`src/popup.*`** and **`src/options.*`** share storage helpers in
  **`src/common.js`**; state lives under one `data` key and syncs across
  contexts via `storage.onChanged`.
- Content-script instances are tagged with a per-load id and hand over via a
  takeover event, so in-place extension updates never leave orphaned handlers
  fighting the new version.

## Project layout

```
manifest.json                   — Manifest V3 (Chrome 111+)
icons/icon-*.png                — manifest icons (Chromium rejects SVG there)
icons/icon.svg                  — used by the popup/options/onboarding pages
src/
  content.js     content.css    — the on-page engine
  page-quality.js               — MAIN-world max-quality helper (Chromium-only)
  background.js                 — context menus, onboarding, browser sync
  background-sw.js              — MV3 service-worker entry (importScripts)
  common.js                     — shared storage/import/export helpers
  popup.html     popup.js       — toolbar popup
  options.html   options.js     — full manager
  onboarding.html               — first-run guide
  ui.css                        — shared popup/options styling
```

## Support

Enjoying it? [Buy me a coffee on Ko-fi](https://ko-fi.com/carcer7378) ♥

## License

[MIT](LICENSE)
