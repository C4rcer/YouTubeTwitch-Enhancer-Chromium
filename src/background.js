/* ==================================================================
 * Background script (runs as the MV3 service worker on Chromium; pulled
 * in by background-sw.js together with common.js).
 *   - Registers right-click menu entries on YouTube and relays clicks
 *     to the content script of the active tab.
 *   - Opens the onboarding page on first install.
 *   - Mirrors the block lists to storage.sync (the browser's own sync)
 *     when the "syncBlockLists" setting is on. storage.local stays the
 *     source of truth; sync is a chunked JSON mirror (8KB/item quota).
 * ================================================================== */
/* global YTB */
(function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const YT_PATTERNS = ['https://www.youtube.com/*'];
    const TW_PATTERNS = ['https://www.twitch.tv/*'];
    const HAS_MENUS = !!api.contextMenus;

    /* ---------------- context menus ---------------- */
    function buildMenus() {
        if (!HAS_MENUS) return;
        api.contextMenus.removeAll(() => {
            api.contextMenus.create({
                id: 'ytb-block-channel',
                title: 'Block this YouTube channel',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytb-hide-video',
                title: 'Hide this video',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytb-mark-watched',
                title: 'Mark video as watched',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytb-sep',
                type: 'separator',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytb-open-options',
                title: 'Advanced settings…',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytbtw-block-channel',
                title: 'Block this Twitch channel',
                contexts: ['all'],
                documentUrlPatterns: TW_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytbtw-block-category',
                title: 'Block this Twitch category',
                contexts: ['all'],
                documentUrlPatterns: TW_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytbtw-sep',
                type: 'separator',
                contexts: ['all'],
                documentUrlPatterns: TW_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytbtw-open-options',
                title: 'Twitch advanced settings…',
                contexts: ['all'],
                documentUrlPatterns: TW_PATTERNS
            });
        });
    }

    api.runtime.onInstalled.addListener((details) => {
        buildMenus();
        if (details && details.reason === 'install') {
            api.tabs.create({ url: api.runtime.getURL('src/onboarding.html') }).catch(() => {});
        }
    });
    api.runtime.onStartup.addListener(buildMenus);

    /* ---------------- Community data proxies (opt-in features) ----------
     * SponsorBlock / DeArrow / Return YouTube Dislike lookups run here in
     * the background so the page CSP never interferes. The manifest declares
     * only the two community API hosts used by these fixed requests.
     *   - SponsorBlock & DeArrow data: CC BY-NC-SA 4.0, by Ajay Ramachandran
     *     (https://sponsor.ajay.app). Lookups use the k-anonymity endpoints:
     *     only a 4-character sha256 prefix of the video ID leaves the browser.
     *   - Return YouTube Dislike (https://returnyoutubedislike.com): free
     *     with attribution; limits 100 req/min & 10k/day, far above what a
     *     per-watch-page cache can generate.
     * ------------------------------------------------------------------ */
    const SB_API = 'https://sponsor.ajay.app';
    const RYD_API = 'https://returnyoutubedislikeapi.com';
    const commCache = new Map();          // key -> { at, value }
    const COMM_TTL = 10 * 60 * 1000;
    const COMM_MAX = 600;
    const commFailAt = { sb: 0, de: 0, ryd: 0 };

    function commGet(key) {
        const hit = commCache.get(key);
        return (hit && Date.now() - hit.at < COMM_TTL) ? hit.value : undefined;
    }

    function commSet(key, value) {
        if (commCache.size >= COMM_MAX) commCache.delete(commCache.keys().next().value);
        commCache.set(key, { at: Date.now(), value });
        return value;
    }

    async function sha256Prefix(str, len) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
    }

    async function sbSegments(videoId, categories) {
        const key = 'sb:' + videoId + ':' + categories.join(',');
        const cached = commGet(key);
        if (cached !== undefined) return cached;
        if (Date.now() - commFailAt.sb < 60000) return null;
        try {
            const prefix = await sha256Prefix(videoId, 4);
            const r = await fetch(SB_API + '/api/skipSegments/' + prefix +
                '?categories=' + encodeURIComponent(JSON.stringify(categories)));
            if (r.status === 404) return commSet(key, []);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const arr = await r.json();
            const mine = ((arr || []).find(v => v.videoID === videoId) || {}).segments || [];
            return commSet(key, mine
                .filter(s => !s.actionType || s.actionType === 'skip')
                .filter(s => s.locked || s.votes == null || s.votes >= 0)
                .map(s => ({ category: s.category, start: s.segment[0], end: s.segment[1], uuid: s.UUID })));
        } catch (e) {
            commFailAt.sb = Date.now();
            return null;
        }
    }

    async function deBranding(videoId) {
        const key = 'de:' + videoId;
        const cached = commGet(key);
        if (cached !== undefined) return cached;
        if (Date.now() - commFailAt.de < 60000) return null;
        try {
            const prefix = await sha256Prefix(videoId, 4);
            const r = await fetch(SB_API + '/api/branding/' + prefix);
            if (r.status === 404) return commSet(key, {});
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const map = await r.json();
            const mine = map && map[videoId];
            if (!mine) return commSet(key, {});
            const t = (mine.titles || []).find(x => !x.original && (x.locked || x.votes >= 0));
            const th = (mine.thumbnails || []).find(x => !x.original && (x.locked || x.votes >= 0));
            return commSet(key, {
                // ">" prefixes a word to opt it out of DeArrow's auto-formatting.
                title: t ? t.title.replace(/(^|\s)>(\S)/g, '$1$2') : null,
                thumbTime: (th && th.timestamp != null) ? th.timestamp : null
            });
        } catch (e) {
            commFailAt.de = Date.now();
            return null;
        }
    }

    async function rydVotes(videoId) {
        const key = 'ryd:' + videoId;
        const cached = commGet(key);
        if (cached !== undefined) return cached;
        if (Date.now() - commFailAt.ryd < 60000) return null;
        try {
            const r = await fetch(RYD_API + '/votes?videoId=' + encodeURIComponent(videoId));
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const d = await r.json();
            return commSet(key, { likes: d.likes, dislikes: d.dislikes });
        } catch (e) {
            commFailAt.ryd = Date.now();
            return null;
        }
    }

    // Emote-list fetches for the Twitch content script. Chromium content
    // scripts fetch under the page's CORS/CSP rules, so the lookups run
    // here, where the manifest's host permissions apply. Fixed allowlist —
    // never an open proxy.
    const FETCH_ALLOW = [
        'https://api.betterttv.net/',
        'https://api.frankerfacez.com/',
        'https://7tv.io/'
    ];
    async function fetchJsonForContent(url) {
        if (typeof url !== 'string' || !FETCH_ALLOW.some(p => url.startsWith(p))) {
            return { ok: false, error: 'blocked url' };
        }
        try {
            const r = await fetch(url);
            if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
            return { ok: true, data: await r.json() };
        } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
        }
    }

    /* ---- SponsorBlock submissions & votes (always user-initiated) -----
     * Both carry the local SponsorBlock user ID: a random secret that
     * accumulates reputation server-side. It lives in its own storage key
     * (outside `data`) so list-clearing and sync never touch it, and the
     * options page lets users paste the ID from the official SponsorBlock
     * extension so an existing reputation carries over.
     * ------------------------------------------------------------------ */
    const SB_UID_KEY = 'sbUserId';

    async function sbUserId() {
        const r = await api.storage.local.get(SB_UID_KEY);
        let uid = r[SB_UID_KEY];
        if (!uid) {
            const bytes = new Uint8Array(32);
            crypto.getRandomValues(bytes);
            uid = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
            await api.storage.local.set({ [SB_UID_KEY]: uid });
        }
        return uid;
    }

    function sbUserAgent() {
        const v = (api.runtime.getManifest() || {}).version || '0';
        return 'YouTubeTwitchEnhancer/' + v;
    }

    async function sbSubmit(videoId, start, end, category) {
        if (!videoId || !(end > start) || start < 0) return { ok: false, error: 'invalid segment' };
        try {
            const r = await fetch(SB_API + '/api/skipSegments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoID: videoId,
                    userID: await sbUserId(),
                    userAgent: sbUserAgent(),
                    segments: [{ segment: [start, end], category, actionType: 'skip' }]
                })
            });
            if (!r.ok) {
                const text = (await r.text()).slice(0, 300);
                return { ok: false, error: 'HTTP ' + r.status + (text ? ': ' + text : '') };
            }
            // Drop cached lookups for this video so the new segment shows up.
            for (const key of [...commCache.keys()]) {
                if (key.startsWith('sb:' + videoId + ':')) commCache.delete(key);
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
        }
    }

    async function sbVote(uuid, type) {
        if (!uuid) return { ok: false, error: 'no segment id' };
        try {
            const params = new URLSearchParams({ UUID: uuid, userID: await sbUserId(), type: String(type) });
            const r = await fetch(SB_API + '/api/voteOnSponsorTime?' + params.toString(), { method: 'POST' });
            if (!r.ok) {
                const text = (await r.text()).slice(0, 300);
                return { ok: false, error: 'HTTP ' + r.status + (text ? ': ' + text : '') };
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
        }
    }

    // Messages from the content scripts (they can't open extension pages,
    // manage tabs, or make CSP-free cross-origin fetches themselves).
    // Chromium ignores a Promise returned from onMessage, so async replies
    // go through sendResponse + `return true` instead.
    let dropClaimTabAt = 0;
    api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || !msg.action) return;
        let reply = null;
        if (msg.action === 'ytb-sb-segments') {
            reply = sbSegments(String(msg.videoId || ''), Array.isArray(msg.categories) && msg.categories.length ? msg.categories : ['sponsor']);
        } else if (msg.action === 'ytb-de-branding') {
            reply = deBranding(String(msg.videoId || ''));
        } else if (msg.action === 'ytb-ryd-votes') {
            reply = rydVotes(String(msg.videoId || ''));
        } else if (msg.action === 'ytb-fetch-json') {
            reply = fetchJsonForContent(msg.url);
        } else if (msg.action === 'ytb-sb-submit') {
            reply = sbSubmit(String(msg.videoId || ''), Number(msg.start), Number(msg.end), String(msg.category || 'sponsor'));
        } else if (msg.action === 'ytb-sb-vote') {
            reply = sbVote(String(msg.uuid || ''), msg.type ? 1 : 0);
        } else if (msg.action === 'ytbtw-open-options') {
            api.tabs.create({ url: api.runtime.getURL('src/twitch-options.html') }).catch(() => {});
        } else if (msg.action === 'ytbtw-claim-drops') {
            // Open the drops inventory in a background (inactive) tab so the
            // stream the user is watching is never disturbed. That tab's own
            // content script claims and then asks to be closed. Guard against
            // opening more than one within a short window.
            if (Date.now() - dropClaimTabAt < 60000) return;
            dropClaimTabAt = Date.now();
            api.tabs.create({
                url: 'https://www.twitch.tv/drops/inventory#ytbtw-autoclaim',
                active: false
            }).catch(() => {});
        } else if (msg.action === 'ytbtw-close-self') {
            if (sender && sender.tab && sender.tab.id != null) {
                api.tabs.remove(sender.tab.id).catch(() => {});
            }
        }
        if (reply) {
            reply.then(sendResponse, () => sendResponse(null));
            return true;   // keep the channel open for the async reply
        }
    });

    if (HAS_MENUS) {
        api.contextMenus.onClicked.addListener((info, tab) => {
            if (info.menuItemId === 'ytb-open-options') {
                api.runtime.openOptionsPage();
                return;
            }
            if (info.menuItemId === 'ytbtw-open-options') {
                api.tabs.create({ url: api.runtime.getURL('src/twitch-options.html') }).catch(() => {});
                return;
            }
            if (tab && tab.id != null) {
                api.tabs.sendMessage(tab.id, { action: info.menuItemId }).catch(() => {});
            }
        });
    }

    /* ---------------- browser-sync mirror ----------------
     * Layout in storage.sync:
     *   ytbSyncMeta            { chunks, updatedAt }
     *   ytbSyncChunk0..N       slices of the lists JSON
     * Strategy: startup / enable = union-merge both sides, then last-writer-
     * wins on subsequent changes. Only the lists sync — settings stay local.
     * ---------------------------------------------------- */
    const META_KEY = 'ytbSyncMeta';
    const CHUNK_PREFIX = 'ytbSyncChunk';
    const CHUNK_SIZE = 6000;          // chars; well under the 8KB/item quota
    let lastPushedStr = null;         // what we last wrote to sync
    let lastAppliedStr = null;        // what we last applied from sync to local
    let pushTimer = null;
    let applyTimer = null;

    // Keyword-style lists mirrored verbatim (union on merge). Channel /
    // category lists need identity-aware merging and stay explicit below.
    const SIMPLE_LIST_FIELDS = [
        'hiddenVideoIds', 'blockedKeywords', 'twitchBlockedKeywords',
        'twitchBlockedTags', 'twitchHighlightKeywords',
        'twitchChatBlockKeywords', 'twitchChatBlockUsers', 'ytCommentKeywords'
    ];

    // Collection data is quota-aware: retain collection/group structure and a
    // bounded number of channel identities rather than letting one large local
    // library crowd every other synced list out of the browser's sync quota.
    function collectionsForSync(collections) {
        let remaining = 300;
        return collections.map(collection => {
            const channels = collection.channels.slice(0, remaining);
            remaining -= channels.length;
            return Object.assign({}, collection, { channels });
        });
    }

    function sidebarForSync(sidebar) {
        let remaining = 300;
        const favorites = sidebar.favorites.slice(0, Math.min(150, remaining));
        remaining -= favorites.length;
        const groups = sidebar.groups.map(group => {
            const channels = group.channels.slice(0, remaining);
            remaining -= channels.length;
            return Object.assign({}, group, { channels });
        });
        return { favorites, groups };
    }
    function listsOf(data) {
        const d = YTB.normalize(data);
        const out = {
            blockedChannels: d.blockedChannels,
            twitchBlockedChannels: d.twitchBlockedChannels,
            twitchBlockedCategories: d.twitchBlockedCategories,
            ytCollections: collectionsForSync(d.ytCollections),
            twitchSidebar: sidebarForSync(d.twitchSidebar)
        };
        for (const f of SIMPLE_LIST_FIELDS) out[f] = d[f];
        return JSON.stringify(out);
    }

    async function getLocal() {
        const r = await api.storage.local.get('data');
        return YTB.normalize(r.data);
    }

    async function setSyncStatus(s) {
        try { await api.storage.local.set({ ytbSyncStatus: s }); } catch (e) { /* ignore */ }
    }

    async function readSync() {
        const meta = (await api.storage.sync.get(META_KEY))[META_KEY];
        if (!meta || !meta.chunks) return null;
        const keys = [];
        for (let i = 0; i < meta.chunks; i++) keys.push(CHUNK_PREFIX + i);
        const parts = await api.storage.sync.get(keys);
        let str = '';
        for (let i = 0; i < meta.chunks; i++) str += parts[CHUNK_PREFIX + i] || '';
        try {
            return { str, lists: JSON.parse(str), updatedAt: meta.updatedAt || 0 };
        } catch (e) {
            return null;
        }
    }

    async function pushSync(str) {
        const prev = (await api.storage.sync.get(META_KEY))[META_KEY];
        const chunks = Math.max(1, Math.ceil(str.length / CHUNK_SIZE));
        const items = { [META_KEY]: { chunks, updatedAt: Date.now() } };
        for (let i = 0; i < chunks; i++) {
            items[CHUNK_PREFIX + i] = str.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        }
        lastPushedStr = str;
        await api.storage.sync.set(items);
        if (prev && prev.chunks > chunks) {
            const stale = [];
            for (let i = chunks; i < prev.chunks; i++) stale.push(CHUNK_PREFIX + i);
            await api.storage.sync.remove(stale);
        }
        await setSyncStatus({ ok: true, at: Date.now() });
    }

    function syncFailed(err) {
        // Most likely QUOTA_BYTES exceeded on very large lists.
        setSyncStatus({ ok: false, error: String(err && err.message || err), at: Date.now() });
    }

    // Union-merge local and remote lists (used at startup / when enabling),
    // then push the result so both sides converge.
    async function initialMerge() {
        const local = await getLocal();
        const remote = await readSync();
        const merged = YTB.normalize(local);
        if (remote && remote.lists) {
            const inc = YTB.normalize(remote.lists);
            for (const c of inc.blockedChannels) {
                if (!merged.blockedChannels.some(x => YTB.sameChannel(x, c))) {
                    merged.blockedChannels.push(c);
                }
            }
            for (const c of inc.twitchBlockedChannels) {
                if (!merged.twitchBlockedChannels.some(x => YTB.sameTwitchChannel(x, c))) {
                    merged.twitchBlockedChannels.push(c);
                }
            }
            for (const c of inc.twitchBlockedCategories) {
                if (!merged.twitchBlockedCategories.some(x => YTB.sameTwitchCategory(x, c))) {
                    merged.twitchBlockedCategories.push(c);
                }
            }
            for (const f of SIMPLE_LIST_FIELDS) {
                const set = new Set(merged[f]);
                inc[f].forEach(k => set.add(k));
                merged[f] = [...set];
            }
            const features = YTB.mergeImport(merged, {
                ytCollections: inc.ytCollections,
                twitchSidebar: inc.twitchSidebar
            }).data;
            merged.ytCollections = features.ytCollections;
            merged.twitchSidebar = features.twitchSidebar;
        }
        const str = listsOf(merged);
        if (str !== listsOf(local)) {
            lastAppliedStr = str;
            await api.storage.local.set({ data: merged });
        }
        await pushSync(str);
    }

    async function applyRemote() {
        const local = await getLocal();
        if (!local.settings.syncBlockLists) return;
        const remote = await readSync();
        if (!remote || !remote.lists) return;
        if (remote.str === lastPushedStr) return;        // our own write echoing
        if (remote.str === listsOf(local)) return;       // already identical
        const next = YTB.normalize(local);
        const inc = YTB.normalize(remote.lists);
        next.blockedChannels = inc.blockedChannels;
        next.twitchBlockedChannels = inc.twitchBlockedChannels;
        next.twitchBlockedCategories = inc.twitchBlockedCategories;
        next.ytCollections = inc.ytCollections;
        next.twitchSidebar = inc.twitchSidebar;
        for (const f of SIMPLE_LIST_FIELDS) next[f] = inc[f];
        lastAppliedStr = listsOf(next);
        await api.storage.local.set({ data: next });
        await setSyncStatus({ ok: true, at: Date.now() });
    }

    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.data) {
            const d = YTB.normalize(changes.data.newValue);
            if (!d.settings.syncBlockLists) return;
            const oldD = changes.data.oldValue ? YTB.normalize(changes.data.oldValue) : null;
            if (!oldD || !oldD.settings.syncBlockLists) {
                // Sync was just switched on: one-time union of both sides.
                initialMerge().catch(syncFailed);
                return;
            }
            const str = listsOf(d);
            if (str === lastAppliedStr || str === lastPushedStr) return;
            clearTimeout(pushTimer);
            pushTimer = setTimeout(() => pushSync(str).catch(syncFailed), 2000);
        } else if (area === 'sync' && (changes[META_KEY] || Object.keys(changes).some(k => k.startsWith(CHUNK_PREFIX)))) {
            // Sync writes arrive as several key changes; coalesce them.
            clearTimeout(applyTimer);
            applyTimer = setTimeout(() => applyRemote().catch(() => {}), 500);
        }
    });

    // On browser startup, reconcile with whatever sync has.
    (async () => {
        try {
            const local = await getLocal();
            if (local.settings.syncBlockLists) await initialMerge();
        } catch (e) { /* ignore */ }
    })();
})();
