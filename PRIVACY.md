# Privacy Policy: YouTube/Twitch Enhancer

**Last updated: July 2026**

YouTube/Twitch Enhancer does **not** collect, transmit, or sell any personal
data. It has no analytics, no tracking, and no remote servers, and it never
sends your information anywhere.

## What it stores

Your block lists (channels, categories, hidden video IDs, keywords, chat
filters) and your settings are stored locally on your device using the
browser's storage API (`chrome.storage.local`).

## Optional sync

If you turn on the "sync block lists" option, those lists are mirrored through
your browser's own built-in sync (`chrome.storage.sync`), so on browsers that
support extension sync they can follow your browser account across your
devices. This data stays within your browser account; the developer has no
access to it and receives nothing.

## Website access

The extension runs only on `www.youtube.com`, `www.twitch.tv` and
`clips.twitch.tv`, where it reads and modifies the page in your browser to
hide the channels, videos, streams, and other content you have chosen to
block, and to add its player and chat tools. All of this happens entirely on
your device. No page content, browsing history, or viewing activity is
recorded or transmitted.

## Optional features that talk to third-party services

Each of the following is behind its own toggle, and with those toggles off no
feature makes any network request:

- **Third-party emotes (Twitch, on by default, easily turned off):** fetches
  emote lists from the public BetterTTV, FrankerFaceZ and 7TV APIs and loads
  emote images from their CDNs. Those services see the numeric ID of the
  Twitch channel you're watching and your IP address, the same as if you used
  their own extensions.
- **Community data (YouTube, all off by default):** SponsorBlock and DeArrow
  lookups go to sponsor.ajay.app; Return YouTube Dislike lookups go to
  returnyoutubedislikeapi.com. SponsorBlock lookups send only a hashed
  4-character prefix of the video ID (k-anonymity), so the exact video you
  watch is not revealed; DeArrow and RYD lookups send the video ID.
- **Sidebar hover previews (Twitch):** loads one thumbnail per hover from
  Twitch's own preview CDN.

None of these requests carry any identifier of you beyond what any web
request carries (your IP address), and nothing is stored server-side by the
developer, who operates no servers at all.

## Permissions

- **storage**: save your block lists and settings on your device.
- **contextMenus**: add the right-click "Block channel", "Hide video" and
  "Block category" menu items.
- **host access to `www.youtube.com`, `www.twitch.tv`, `clips.twitch.tv`**:
  let the content scripts hide blocked content and add the player/chat tools.
- **host access to `api.betterttv.net`, `api.frankerfacez.com`, `7tv.io`**:
  let the optional third-party emotes feature fetch emote lists without being
  blocked by page security policies.

## Contact

Questions? Reach out via [Ko-fi](https://ko-fi.com/carcer7378).
