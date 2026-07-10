/* ==================================================================
 * Shared helpers for the popup and options pages.
 * Loaded as a plain script, so it exposes globals on window.
 * ================================================================== */
/* global browser, chrome */
const YTB = (function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const STORAGE_KEY = 'data';

    const DEFAULT_SETTINGS = {
        enabled: true,               // master switch for the whole extension
        blockShorts: true,
        hideWatched: true,
        watchedThreshold: 75,
        // Per-surface scope for watched-hiding. Playlists default OFF because
        // seeing progress in Watch Later / playlists is usually the point.
        watchedHome: true,
        watchedSubs: true,
        watchedSearch: true,
        watchedRelated: true,
        watchedChannel: true,
        watchedPlaylists: false,
        blackoutBlockedChannels: true,
        revealHidden: false,         // audit mode: show hidden tiles dimmed instead of removed
        maxQuality: true,
        hideSidebarSpinner: true,
        reduceFlashing: true,
        hideEndScreen: true,
        hidePromos: true,            // ads / promos / nudges (previously always on)
        hideMixes: false,
        hidePlaylists: false,
        hideNewsShelves: false,
        hideMembersOnly: false,      // off by default: people may be members on some channels
        syncBlockLists: false,       // mirror block lists via the browser's own sync
        volumeBoost: 1,
        wheelVolume: true,
        ytCompressorButton: true,    // 🎚 audio-compressor button in the player controls
        ytCompressorOn: false,       // compressor engaged (remembered across loads)
        ytLoopButton: true,          // 🔁 A-B loop button in the player controls
        ytShotButton: true,          // 📷 screenshot button in the player controls
        ytSpeedDefault: 1,           // playback speed applied to each new (non-live) video
        ytSpeedPerChannel: false,    // remember the last speed used per channel
        ytSpeedHotkeys: true,        // [ and ] step speed, \ resets
        ytNoPauseDialog: true,       // auto-dismiss "Video paused. Continue watching?"
        ytDisableAutoplay: false,    // keep YouTube's up-next autoplay toggle off
        ytAutoExpandDesc: false,     // auto-expand the watch-page description
        // ---- Community data (opt-in; all off by default) ----
        sbEnabled: false,            // SponsorBlock segment skipping (sponsor.ajay.app)
        sbSkipSponsor: true,         //   which categories to skip while enabled
        sbSkipSelfpromo: true,
        sbSkipInteraction: true,
        sbSkipIntro: false,
        sbSkipOutro: false,
        sbSkipPreview: false,
        sbSkipOfftopic: false,
        sbSkipFiller: false,
        deArrowTitles: false,        // DeArrow community titles
        deArrowThumbs: false,        // DeArrow thumbnails (heavier; their service renders them)
        rydEnabled: false,           // Return YouTube Dislike counts
        // ---- Twitch (www.twitch.tv) ----
        twEnabled: true,             // master switch for the Twitch side
        twAutoClaim: true,           // auto-click the channel-points "Claim Bonus" button
        twAutoClaimDrops: true,      // auto-click drop "Claim Now" (inventory + in-chat callouts)
        twAutoClaimMoments: true,    // auto-click "Claim Moment" chat callouts
        twAnonChat: false,           // connect to chat as an anonymous user (read-only;
                                     // you never appear in the viewer list). Needs reload.
        twEmotes: true,              // render BTTV / FFZ / 7TV emotes in chat
        twHideCarousel: true,        // hide (and pause) the front-page auto-playing carousel
        twHideChat: false,           // visually hide the chat column (stays in the DOM so
                                     // point claiming keeps working)
        twClipHelper: true,          // on-player Clip + "share last clip to chat" buttons
        twClipDownload: true,        // Download button on clip pages
        twCinemaButton: true,        // cinema-mode (darken page) button on the player
        twMaxQuality: true,          // pin new streams to source quality
        twHideExtensions: false,     // hide extension overlays/dock on the player
        // Chat performance (0 = feature off / Twitch default behaviour)
        twChatLineLimit: 0,          // max chat lines kept in the DOM (0 = Twitch default)
        twChatBatchMs: 0,            // reveal new messages in batches every N ms
        twSmoothScrollMs: 0,         // smooth-scroll new messages over N ms
        twVolumeBoost: 1,            // in-player volume boost (1 = 100%, native)
        twHideReruns: false,         // hide rerun-badged streams everywhere
        twAltShading: false,         // alternate chat line backgrounds
        twShowDeleted: false,        // keep moderator-deleted messages readable (struck through)
        twTabComplete: true,         // Tab-complete third-party emote names in chat
        twCompressorButton: true,    // 🎚 audio-compressor button on the player bar
        twCompressorOn: false,       // compressor engaged (remembered across loads)
        twShotButton: true,          // 📷 screenshot button on the player bar
        twSpeedHotkeys: true,        // [ ] \ speed hotkeys on VODs and clips
        twUptime: true,              // ⏱ stream uptime chip near the viewer count
        twHoverPreviews: true,       // live thumbnail preview when hovering sidebar channels
        // ---- YouTube extras ----
        ytCinemaButton: true         // cinema-mode (darken page) button on the player
    };

    function cleanKeywords(arr) {
        if (!Array.isArray(arr)) return [];
        return [...new Set(
            arr.filter(k => typeof k === 'string')
               .map(k => k.trim().slice(0, 200))
               .filter(Boolean)
        )];
    }

    function clampInt(v, min, max, def) {
        v = parseInt(v, 10);
        if (isNaN(v)) return def;
        return Math.min(max, Math.max(min, v));
    }

    function clampSpeed(v) {
        v = parseFloat(v);
        if (isNaN(v) || v <= 0) return 1;
        return Math.min(8, Math.max(0.1, Math.round(v * 100) / 100));
    }

    // { channelKey: rate } map for per-channel playback speed. Bounded so a
    // long-lived install can't grow storage without limit.
    function cleanSpeedMap(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
        const out = {};
        let n = 0;
        for (const k of Object.keys(obj)) {
            if (typeof k !== 'string' || !k) continue;
            const r = clampSpeed(obj[k]);
            if (r === 1) continue;          // 1x entries carry no information
            out[k.slice(0, 120)] = r;
            if (++n >= 400) break;
        }
        return out;
    }

    function normalize(d) {
        d = d || {};
        const settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
        settings.watchedThreshold = clampThreshold(settings.watchedThreshold);
        settings.volumeBoost = clampBoost(settings.volumeBoost);
        settings.twChatLineLimit = clampInt(settings.twChatLineLimit, 0, 1000, 0);
        settings.twChatBatchMs = clampInt(settings.twChatBatchMs, 0, 2000, 0);
        settings.twSmoothScrollMs = clampInt(settings.twSmoothScrollMs, 0, 1000, 0);
        settings.twVolumeBoost = clampBoost(settings.twVolumeBoost);
        settings.ytSpeedDefault = clampSpeed(settings.ytSpeedDefault);
        return {
            hiddenVideoIds: Array.isArray(d.hiddenVideoIds) ? [...new Set(d.hiddenVideoIds)] : [],
            blockedChannels: Array.isArray(d.blockedChannels)
                ? d.blockedChannels
                    .filter(c => c && (c.handle || c.channelId || c.name))
                    .map(c => ({
                        name: c.name || '',
                        handle: c.handle || '',
                        channelId: c.channelId || '',
                        addedAt: c.addedAt || Date.now()
                    }))
                : [],
            blockedKeywords: cleanKeywords(d.blockedKeywords),
            twitchBlockedChannels: Array.isArray(d.twitchBlockedChannels)
                ? d.twitchBlockedChannels
                    .filter(c => c && (c.login || c.name))
                    .map(c => ({
                        login: (c.login || '').toLowerCase(),
                        name: c.name || '',
                        addedAt: c.addedAt || Date.now()
                    }))
                : [],
            twitchBlockedCategories: Array.isArray(d.twitchBlockedCategories)
                ? d.twitchBlockedCategories
                    .filter(c => c && (c.slug || c.name))
                    .map(c => ({
                        slug: (c.slug || '').toLowerCase(),
                        name: c.name || '',
                        addedAt: c.addedAt || Date.now()
                    }))
                : [],
            twitchBlockedKeywords: cleanKeywords(d.twitchBlockedKeywords),
            twitchBlockedTags: cleanKeywords(d.twitchBlockedTags),
            twitchHighlightKeywords: cleanKeywords(d.twitchHighlightKeywords),
            twitchChatBlockKeywords: cleanKeywords(d.twitchChatBlockKeywords),
            twitchChatBlockUsers: cleanKeywords(d.twitchChatBlockUsers).map(u => u.toLowerCase()),
            ytCommentKeywords: cleanKeywords(d.ytCommentKeywords),
            ytChannelSpeeds: cleanSpeedMap(d.ytChannelSpeeds),
            settings
        };
    }

    function clampThreshold(v) {
        v = parseInt(v, 10);
        if (isNaN(v)) return DEFAULT_SETTINGS.watchedThreshold;
        return Math.min(100, Math.max(1, v));
    }

    function clampBoost(v) {
        v = parseFloat(v);
        if (isNaN(v)) return 1;
        return Math.min(5, Math.max(1, Math.round(v * 100) / 100));
    }

    async function load() {
        const r = await api.storage.local.get(STORAGE_KEY);
        return normalize(r[STORAGE_KEY]);
    }

    async function save(data) {
        const clean = normalize(data);
        await api.storage.local.set({ [STORAGE_KEY]: clean });
        return clean;
    }

    function parseChannelInput(str) {
        str = (str || '').trim();
        if (!str) return null;
        const idM = str.match(/channel\/(UC[\w-]+)/) || str.match(/^(UC[\w-]{20,})$/);
        if (idM) return { channelId: idM[1], handle: '', name: '' };
        const handleM = str.match(/@([\w.\-]+)/);
        if (handleM) return { handle: handleM[1], channelId: '', name: '' };
        return { name: str, handle: '', channelId: '' };
    }

    function sameChannel(a, b) {
        if (a.channelId && b.channelId) return a.channelId === b.channelId;
        if (a.handle && b.handle) return a.handle.toLowerCase() === b.handle.toLowerCase();
        if (a.name && b.name) return a.name.toLowerCase().trim() === b.name.toLowerCase().trim();
        return false;
    }

    // Adds to data.blockedChannels (mutates). Returns true if newly added.
    function addChannel(data, info) {
        if (!info || (!info.handle && !info.channelId && !info.name)) return false;
        if (data.blockedChannels.some(c => sameChannel(c, info))) return false;
        data.blockedChannels.push({
            name: info.name || '',
            handle: info.handle || '',
            channelId: info.channelId || '',
            addedAt: Date.now()
        });
        return true;
    }

    function channelLabel(c) {
        if (c.name) return c.name;
        if (c.handle) return '@' + c.handle;
        return c.channelId;
    }

    function channelUrl(c) {
        if (c.handle) return 'https://www.youtube.com/@' + c.handle;
        if (c.channelId) return 'https://www.youtube.com/channel/' + c.channelId;
        return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(c.name);
    }

    /* ---- Twitch helpers ------------------------------------------------ */

    // "loginname", "@loginname", or any twitch.tv/<login> URL -> { login }.
    // Twitch logins are 4-25 chars [a-z0-9_], but be lenient on length.
    function parseTwitchChannelInput(str) {
        str = (str || '').trim();
        if (!str) return null;
        const urlM = str.match(/twitch\.tv\/([A-Za-z0-9_]{2,25})(?:[/?#]|$)/i);
        if (urlM && !/^(directory|videos|settings|downloads|search|drops|wallet|subscriptions|turbo|jobs|p)$/i.test(urlM[1])) {
            return { login: urlM[1].toLowerCase(), name: '' };
        }
        const plainM = str.match(/^@?([A-Za-z0-9_]{2,25})$/);
        if (plainM) return { login: plainM[1].toLowerCase(), name: '' };
        return null;
    }

    function slugifyTwitchCategory(name) {
        return (name || '').toLowerCase().trim()
            .replace(/['’.]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    // Category URL (/directory/category/<slug> or legacy /directory/game/<name>)
    // or a plain category name -> { slug, name }.
    function parseTwitchCategoryInput(str) {
        str = (str || '').trim();
        if (!str) return null;
        const catM = str.match(/\/directory\/category\/([^/?#]+)/i);
        if (catM) return { slug: decodeURIComponent(catM[1]).toLowerCase(), name: '' };
        const gameM = str.match(/\/directory\/game\/([^/?#]+)/i);
        if (gameM) {
            const name = decodeURIComponent(gameM[1]);
            return { slug: slugifyTwitchCategory(name), name };
        }
        if (/twitch\.tv/i.test(str)) return null;   // some other twitch URL, not a category
        return { slug: slugifyTwitchCategory(str), name: str };
    }

    function sameTwitchChannel(a, b) {
        if (a.login && b.login) return a.login.toLowerCase() === b.login.toLowerCase();
        if (a.name && b.name) return a.name.toLowerCase().trim() === b.name.toLowerCase().trim();
        return false;
    }

    function sameTwitchCategory(a, b) {
        if (a.slug && b.slug) return a.slug === b.slug;
        if (a.name && b.name) return a.name.toLowerCase().trim() === b.name.toLowerCase().trim();
        return false;
    }

    function addTwitchChannel(data, info) {
        if (!info || !info.login) return false;
        if (data.twitchBlockedChannels.some(c => sameTwitchChannel(c, info))) return false;
        data.twitchBlockedChannels.push({
            login: info.login.toLowerCase(),
            name: info.name || '',
            addedAt: Date.now()
        });
        return true;
    }

    function addTwitchCategory(data, info) {
        if (!info || (!info.slug && !info.name)) return false;
        if (data.twitchBlockedCategories.some(c => sameTwitchCategory(c, info))) return false;
        data.twitchBlockedCategories.push({
            slug: (info.slug || slugifyTwitchCategory(info.name)).toLowerCase(),
            name: info.name || '',
            addedAt: Date.now()
        });
        return true;
    }

    function twitchChannelLabel(c) { return c.name || c.login; }
    function twitchChannelUrl(c) { return 'https://www.twitch.tv/' + (c.login || ''); }
    function twitchCategoryLabel(c) { return c.name || c.slug; }
    function twitchCategoryUrl(c) { return 'https://www.twitch.tv/directory/category/' + (c.slug || slugifyTwitchCategory(c.name)); }

    // Merge an imported payload into current data (union of lists).
    function mergeImport(current, incoming) {
        const out = normalize(current);
        const inc = normalize(incoming);
        let addedVideos = 0, addedChannels = 0, addedKeywords = 0;
        const vids = new Set(out.hiddenVideoIds);
        for (const v of inc.hiddenVideoIds) {
            if (!vids.has(v)) { vids.add(v); addedVideos++; }
        }
        out.hiddenVideoIds = [...vids];
        for (const c of inc.blockedChannels) {
            if (!out.blockedChannels.some(x => sameChannel(x, c))) {
                out.blockedChannels.push(c);
                addedChannels++;
            }
        }
        const kws = new Set(out.blockedKeywords);
        for (const k of inc.blockedKeywords) {
            if (!kws.has(k)) { kws.add(k); addedKeywords++; }
        }
        out.blockedKeywords = [...kws];
        for (const c of inc.twitchBlockedChannels) {
            if (!out.twitchBlockedChannels.some(x => sameTwitchChannel(x, c))) {
                out.twitchBlockedChannels.push(c);
                addedChannels++;
            }
        }
        for (const c of inc.twitchBlockedCategories) {
            if (!out.twitchBlockedCategories.some(x => sameTwitchCategory(x, c))) {
                out.twitchBlockedCategories.push(c);
                addedChannels++;
            }
        }
        const twKws = new Set(out.twitchBlockedKeywords);
        for (const k of inc.twitchBlockedKeywords) {
            if (!twKws.has(k)) { twKws.add(k); addedKeywords++; }
        }
        out.twitchBlockedKeywords = [...twKws];
        // Keyword-style lists added in 4.2: tags, chat filters, comment keywords.
        for (const field of ['twitchBlockedTags', 'twitchHighlightKeywords',
                             'twitchChatBlockKeywords', 'twitchChatBlockUsers',
                             'ytCommentKeywords']) {
            const set = new Set(out[field]);
            for (const k of inc[field]) {
                if (!set.has(k)) { set.add(k); addedKeywords++; }
            }
            out[field] = [...set];
        }
        // Per-channel speeds: incoming entries win only where local has none.
        out.ytChannelSpeeds = Object.assign({}, inc.ytChannelSpeeds, out.ytChannelSpeeds);
        // Only take settings the file actually carries — never let a
        // lists-only payload reset settings to defaults.
        if (incoming && incoming.settings && typeof incoming.settings === 'object') {
            out.settings = Object.assign({}, out.settings, incoming.settings);
            out.settings.watchedThreshold = clampThreshold(out.settings.watchedThreshold);
            out.settings.volumeBoost = clampBoost(out.settings.volumeBoost);
        }
        return { data: out, addedVideos, addedChannels, addedKeywords };
    }

    function isValidPayload(obj) {
        return obj && typeof obj === 'object' &&
            (Array.isArray(obj.blockedChannels) || Array.isArray(obj.hiddenVideoIds) ||
             Array.isArray(obj.blockedKeywords) || Array.isArray(obj.twitchBlockedChannels) ||
             Array.isArray(obj.twitchBlockedCategories) || Array.isArray(obj.twitchBlockedKeywords) ||
             Array.isArray(obj.twitchBlockedTags) || Array.isArray(obj.twitchHighlightKeywords) ||
             Array.isArray(obj.twitchChatBlockKeywords) || Array.isArray(obj.twitchChatBlockUsers) ||
             Array.isArray(obj.ytCommentKeywords) ||
             obj.settings);
    }

    function onChanged(cb) {
        api.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[STORAGE_KEY]) {
                cb(normalize(changes[STORAGE_KEY].newValue));
            }
        });
    }

    function exportFilename() {
        return 'youtube-blocklist-' + new Date().toISOString().slice(0, 10) + '.json';
    }

    function downloadJson(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || exportFilename();
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return {
        DEFAULT_SETTINGS,
        normalize, clampThreshold, clampBoost, clampInt, clampSpeed, cleanKeywords,
        load, save, onChanged,
        parseChannelInput, sameChannel, addChannel,
        channelLabel, channelUrl,
        parseTwitchChannelInput, parseTwitchCategoryInput, slugifyTwitchCategory,
        sameTwitchChannel, sameTwitchCategory, addTwitchChannel, addTwitchCategory,
        twitchChannelLabel, twitchChannelUrl, twitchCategoryLabel, twitchCategoryUrl,
        mergeImport, isValidPayload,
        exportFilename, downloadJson
    };
})();
