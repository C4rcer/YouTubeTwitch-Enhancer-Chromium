# Privacy Policy: YouTube/Twitch Enhancer

**Last updated: 16 July 2026**

YouTube/Twitch Enhancer contains no analytics, advertising, or tracking and has
no developer-operated backend. The extension does not send page data, viewing
activity, settings, or identifiers to the developer. Information a user
voluntarily sends through the contact links is outside the extension and is
handled by the selected contact service.

The extension does handle website content, viewing activity, personal
communications, and—only when Anonymous chat is enabled—authentication
information on the user's device to provide its filtering, watched-history,
playback, chat, and auto-claim features. The details are below.

## Data stored on the device

The extension stores the following in `chrome.storage.local`:

- settings and user-created block/filter lists, including YouTube and Twitch
  channel identifiers, categories, tags, keywords, hidden video IDs,
  comment/chat filters, SponsorBlock whitelist entries, and per-channel
  playback-speed preferences;
- exact YouTube video IDs watched past the selected threshold or manually
  marked watched, together with channel names/handles/IDs, channel video
  totals, and the exact watched and manually hidden video IDs associated with
  each channel;
- feature state including cross-tab watched-history Undo records, browser-sync
  status, a Twitch clip-intent timestamp, and the most recently created Twitch
  clip URL and timestamp;
- user-created configuration for the shared playback layer: keyboard/mouse/wheel
  input bindings, named playback profiles and their channel assignments, local
  YouTube subscription collections (channel identifiers the user grouped),
  local Twitch sidebar favourites and groups (channel logins the user pinned or
  grouped), chat-overlay and player-recovery preferences, named settings
  presets, a bounded automatic pre-reset backup, a bounded list of recent
  reversible actions, and bounded title/channel/thumbnail metadata for videos
  the user hides (so hidden entries stay recognizable in the manager);
- a bounded, redacted player-recovery diagnostics record that never contains
  URLs, channel or video identities, titles, transcript or chat text, or
  tokens; and
- a SponsorBlock user ID used only for user-initiated submissions and votes. It
  is generated randomly on first use unless the user supplies an existing
  SponsorBlock ID, and it can be viewed, replaced, or cleared in Advanced
  settings.

The recent Twitch clip record is used by the Share clip tool for 30 minutes,
but the stored record may remain afterward until extension data is cleared or
the extension is uninstalled. The extension also reads a legacy YouTube
page-local-storage hidden-video list for migration. On Twitch, it writes small
page-local-storage flags for the source-quality and optional anonymous-chat
settings. These records remain in the browser and are not sent to the
developer.

Watched history is stored separately from the normal block-list record in
shards so a large history remains efficient. It is not included in browser
sync. Users can export, import, or clear it from **Advanced settings → Watched
history database**. Users can also clear block lists with the extension's
controls and clear the SponsorBlock ID from its field. Other local feature
state remains until the browser clears extension/site data or the extension is
uninstalled.

The extension reads page elements such as video/stream titles, channel names
and IDs, categories, tags, progress indicators, badges, comments, and Twitch
chat messages to apply the user's filters and tools. This processing occurs in
the browser. Comments and chat messages are not saved as a browsing log or
sent to the developer.

## Optional browser sync

If the user enables **Sync block lists via browser sync**, the extension
mirrors its YouTube/Twitch blocked channel and category lists, manually hidden
video IDs, keyword/comment/chat filter lists, and a quota-capped copy of the
user's local YouTube subscription collections and Twitch sidebar
favourites/groups through the browser vendor's `chrome.storage.sync` service.
Settings, per-channel playback speeds, playback profiles, input bindings,
settings presets, diagnostics, recent actions, hidden-video metadata,
SponsorBlock data, recent-clip state, and the watched-history database are not
synced. Disabling the option stops future mirroring; an existing browser-sync
copy may remain under the browser vendor's retention and deletion rules. The
developer has no access to the browser account or synced data.

## Network requests for user-facing features

The developer operates no receiving server. Some user-facing features
communicate directly with the named website or community service:

- **Third-party Twitch emotes (off by default):** when enabled, the extension
  sends the current Twitch channel's numeric ID to the BetterTTV,
  FrankerFaceZ, and 7TV APIs and loads emote images from their CDNs.
- **SponsorBlock and DeArrow (off by default):** segment and branding lookups
  send a four-character SHA-256 prefix derived from the YouTube video ID to
  `sponsor.ajay.app`; the extension filters the returned group locally.
  DeArrow thumbnail rendering, when separately enabled, requests an image from
  `dearrow-thumb.ajay.app` using the exact video ID and selected timestamp.
- **Return YouTube Dislike (off by default):** lookups send the exact YouTube
  video ID to `returnyoutubedislikeapi.com`.
- **SponsorBlock submissions and votes (user initiated):** a submission sends
  the exact video ID, segment timestamps, category, extension version, and the
  stored SponsorBlock user ID (randomly generated unless the user supplied
  one). A vote sends the segment UUID, vote, and that user ID. These values let
  SponsorBlock maintain submission reputation.
- **Twitch sidebar hover previews (on by default):** when the user hovers a live
  sidebar channel, the extension requests that channel login's preview image
  from Twitch's `static-cdn.jtvnw.net` service. The feature can be disabled in
  Twitch advanced settings.
- **Twitch automation, clips, and downloads (enabled by default and
  user-disableable):** points, drops, and Moments tools inspect Twitch page
  state and click Twitch's claim controls; drop claiming may open Twitch's
  inventory in a temporary background tab. When the user creates a clip, the
  extension stores its URL locally; sharing sends that URL through Twitch chat
  only when invoked, and downloading fetches the Twitch-hosted video only when
  invoked.
- **Anonymous Twitch chat (off by default):** when enabled, the extension
  locally intercepts Twitch's outgoing IRC WebSocket authentication command
  and replaces the Twitch OAuth credential and login with anonymous Twitch
  credentials before Twitch receives it. The original credential is not
  stored, logged, sent to the developer, or sent to any non-Twitch service.

The named services receive requests directly from the browser and therefore
receive ordinary network metadata such as the user's IP address and user
agent. Their own privacy and retention policies apply. No response is
evaluated or executed as code; all extension logic is packaged with the
extension.

## Permissions

- **storage**: stores settings, block lists, watched history, and feature state
  on the device, with optional browser sync for block lists.
- **unlimitedStorage**: prevents a large, user-controlled watched-history
  database from hitting the normal local extension storage quota or being
  evicted.
- **contextMenus**: adds right-click commands to block channels/categories,
  hide videos, mark videos watched, and open settings.
- **Host access to `www.youtube.com`, `www.twitch.tv`, and
  `clips.twitch.tv`**: lets the content scripts filter the supported sites and
  add the requested player, chat, watch-history, clip, and auto-claim tools.
- **Host access to `sponsor.ajay.app` and
  `returnyoutubedislikeapi.com`**: lets the optional SponsorBlock, DeArrow, and
  Return YouTube Dislike features request their documented API data from the
  extension service worker.
- **Host access to `api.betterttv.net`, `api.frankerfacez.com`, and
  `7tv.io`**: lets the optional emote feature fetch JSON lists through a fixed
  allowlist in the extension service worker.

## Sharing, advertising, and human access

The extension does not sell user data or use it for advertising, credit, or
unrelated purposes. It transfers data only when necessary for browser sync or
a feature the user enables or invokes, as described above. User-initiated
Twitch chat and SponsorBlock submissions are delivered to those services and
are subject to their ordinary publication, moderation, and privacy rules. The
developer does not provide human access to data obtained through Chrome APIs.

Use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data),
including the Limited Use requirements.

This independent extension is not affiliated with or endorsed by YouTube,
Google, Twitch, Amazon, SponsorBlock, DeArrow, Return YouTube Dislike,
BetterTTV, FrankerFaceZ, or 7TV.

## Contact

Questions may be sent through
[Ko-fi](https://ko-fi.com/carcer7378) or the
[project issue tracker](https://github.com/C4rcer/YouTubeTwitch-Enhancer-Chromium/issues).