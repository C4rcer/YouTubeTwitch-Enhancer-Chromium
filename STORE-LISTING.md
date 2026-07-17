# Chrome Web Store release sheet — 4.8.0

This file contains the copy and dashboard answers for the Chromium 4.8.0
upload (Chromium versions are now aligned with the Firefox extension; see
CHANGELOG.md). Upload the ZIP produced by `build.ps1`; do not upload this file
or the `store-assets` directory as part of the extension package.

## Package

- File: `youtube-twitch-enhancer-chromium-4.8.0.zip`
- Manifest: V3
- Minimum Chrome version: 111
- Category: Productivity
- Language: English
- Privacy policy URL:
  `https://github.com/C4rcer/YouTubeTwitch-Enhancer-Chromium/blob/main/PRIVACY.md`

## Short description (130/132 characters)

> Enhance YouTube & Twitch: block channels, categories, tags & keywords; hide Shorts/watched videos; add player, chat & claim tools.

## Detailed description

Take control of YouTube and Twitch with one privacy-focused extension.

Filter unwanted channels, categories, tags, stream titles, video titles, and
comments. Remove Shorts, watched videos, paid or members-only tiles, promos,
Mixes, playlists, shelves, chat, and other clutter using granular controls.

Watched history is kept locally so videos stay hidden even when the site
loses their progress. Mark videos watched from the right-click or three-dot
menu, view per-channel Watched and Hidden counts, and export, import, or
clear the watched database independently.

Playback tools include maximum quality, speed controls and per-channel speed
memory, volume boost, audio compression, screenshots, A-B looping, cinema
mode, autoplay control, and idle-pause dismissal. Configurable keyboard,
mouse-button, and scroll-wheel player actions plus named playback profiles
with per-channel rules apply your preferred speed, quality, captions, and
compressor automatically on both sites.

A transcript and chapter workspace renders searchable transcripts locally,
and local subscription collections organize channels into filterable groups
with JSON/CSV import and export. On the streaming side, local sidebar
favourites, collapsible groups and search, live-edge and stream-delay
controls, bounded player recovery, and a theater/fullscreen chat overlay
round out the toolkit.

Streaming tools also include channel/category/tag filtering,
points/drops/Moments claiming, third-party emotes, chat filters and
performance controls, optional anonymous read-only chat, clip
sharing/downloads, source quality, uptime, sidebar previews, and matching
player tools. Claim automation, clip tools, source quality, and sidebar
previews start enabled and can be turned off; third-party emotes and
anonymous chat start off.

SponsorBlock, DeArrow, Return YouTube Dislike, third-party emotes, and browser
sync are separately controlled. Community integrations are opt-in and all
extension logic is packaged locally. The developer operates no analytics or
backend and does not receive or sell user data. See the privacy policy for the
exact local storage and network disclosures.

This independent extension is not affiliated with or endorsed by YouTube,
Google, Twitch, Amazon, SponsorBlock, DeArrow, Return YouTube Dislike,
BetterTTV, FrankerFaceZ, or 7TV.

## What's new in 4.8.0

- Configurable keyboard, mouse-button, and scroll-wheel player actions plus
  named playback profiles with per-channel rules on both supported sites.
- Transcript/chapter workspace and local subscription collections with
  JSON/CSV transfer.
- Stream sidebar favourites, collapsible groups and search, live-edge and
  delay controls, bounded player recovery, and a theater/fullscreen chat
  overlay.
- Redesigned settings with search, Basic/Advanced views, themes, presets,
  privacy summary, selective import, pre-reset backups, and undo.
- Fixed the previous video's title persisting under the player after
  end-screen or suggested-video navigation.

## Single purpose

> Customize YouTube and Twitch viewing by filtering unwanted content and adding local playback, watch-history, chat, and convenience controls.

## Permission justifications

**storage**

Stores user settings, block/filter lists, local watched history, feature state,
and the optional block-list mirror in browser sync.

**unlimitedStorage**

The user-controlled watched-history database can contain many video IDs. This
permission prevents that local database from reaching the browser's normal
extension-storage quota or being evicted. It is not used for a remote cache.

**contextMenus**

Adds user-invoked commands to block a channel or category, hide a video, mark
a video watched, and open advanced settings.

**Host access: www.youtube.com**

Runs the content and MAIN-world player helper scripts on this site only, so
the extension can filter cards/comments, maintain local watched history, and
add playback controls.

**Host access: www.twitch.tv and clips.twitch.tv**

Runs the content script on these two hosts for filtering, clip, emote,
player, and claim tools. A MAIN-world helper runs only on `www.twitch.tv` to
implement player/chat features that require page APIs.

**Host access: sponsor.ajay.app**

Lets the separately controlled SponsorBlock and DeArrow features retrieve
community segment/branding data and lets users submit or vote on segments.
Requests are limited to fixed API endpoints on this host.

**Host access: returnyoutubedislikeapi.com**

Lets the separately controlled Return YouTube Dislike feature retrieve counts
for the exact video currently being viewed.

**Host access: api.betterttv.net, api.frankerfacez.com, and 7tv.io**

Lets the optional third-party-emote feature retrieve JSON emote lists. The
service worker accepts only a fixed allowlist; it is not an open network proxy.

## Remote code

Select **No, I am not using remote code**.

All JavaScript is included in the ZIP. Remote endpoints return data, images,
or media; the extension never evaluates or executes those responses as code.

## Data-use disclosure

Select and disclose these dashboard categories:

- **Web history:** exact YouTube video IDs watched past the configured threshold
  or manually marked watched are stored locally for the visible watched-history
  feature. A recently created Twitch clip URL and timestamp are also stored
  locally for the Share clip tool. Watched history is never sent to the
  developer or browser sync and is user-exportable and user-clearable.
- **Website content:** video/stream titles, channel identifiers, categories,
  tags, progress indicators, badges, comments, Twitch chat, and related page
  data are processed in the browser to filter pages and provide controls. Some
  user-created lists and channel associations are stored locally.
- **Personal communications:** Twitch chat is processed locally for
  filtering/highlighting; user-invoked clip sharing inserts and sends the
  stored clip URL through Twitch chat. The developer does not receive chat
  content.
- **Authentication information:** only when Anonymous chat is enabled, the
  extension transiently handles Twitch's outgoing IRC OAuth/login command and
  replaces it locally with anonymous credentials before transmission. It never
  stores, logs, or transfers the original credential elsewhere.
- **User activity:** playback progress is observed to determine when a YouTube
  video crosses the user-selected watched threshold; feature-specific clicks,
  keys, and hovers are handled only to perform the requested controls and are
  not retained as an activity log.

User-created filter lists, keywords, settings, and the optional SponsorBlock
identity are also handled as described in the privacy policy even if the
current dashboard has no separate checkbox with that wording. Certify that
data is used only for user-facing functionality, is not sold or used for
advertising or credit, and is transferred only as required for browser sync or
an enabled/invoked feature. Do not select **Location** solely because ordinary
HTTPS requests expose an IP address unless the dashboard instructions or a
reviewer explicitly classify that network metadata as extension collection.

## Store graphics

Chrome accepts at most five screenshots. Recommended upload order:

1. `store-assets/chrome-screenshots/yte-01-watch-tools.png`
2. `store-assets/chrome-screenshots/yte-02-block-menu.png`
3. `store-assets/chrome-screenshots/yte-03-options.png`
4. `store-assets/chrome-screenshots/yte-05-twitch-live.png`
5. `store-assets/chrome-screenshots/yte-08-emote-panel.png`

Other required/available graphics:

- Store icon: `icons/icon-128.png`
- Small promo tile: `store-assets/chrome-promo/promo-small-440x280.png`
- Marquee promo tile (optional):
  `store-assets/chrome-promo/promo-marquee-1400x560.png`

## Final dashboard checklist

1. Push the updated public `PRIVACY.md` before submitting so its URL resolves.
2. Enable 2-Step Verification on the owning Google account.
3. Open the existing item and choose **Upload new package**.
4. Upload only `youtube-twitch-enhancer-chromium-4.8.0.zip` (built 2026-07-16
   from this release; it replaced an older 2026-07-14 zip of the same name
   that predated the version realignment).
5. Paste the updated description, What's new text, single purpose, permission
   justifications, remote-code answer, and data-use disclosures above.
6. Upload no more than five screenshots.
7. Verify the support contact, category, language, regions, and privacy URL.
8. If the published version predates the community API host permissions,
   expect Chrome to request approval for them on update; verify the warning
   shown for the package before publishing.
9. Submit for review; use deferred publishing if you want approval before the
   release becomes public.

Official references:

- https://developer.chrome.com/docs/webstore/prepare/
- https://developer.chrome.com/docs/webstore/cws-dashboard-listing/
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/
- https://developer.chrome.com/docs/webstore/update/