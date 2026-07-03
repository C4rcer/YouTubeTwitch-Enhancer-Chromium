/* ==================================================================
 * Background script.
 *   - Registers right-click menu entries on YouTube and relays clicks
 *     to the content script of the active tab.
 *   - Opens the onboarding page on first install.
 *   - Mirrors the block lists to storage.sync (Firefox Sync) when the
 *     "syncBlockLists" setting is on. storage.local stays the source
 *     of truth; sync is a chunked JSON mirror (8KB/item quota).
 *
 * Loaded together with common.js (YTB helpers) — see manifest.json.
 * ================================================================== */
/* global YTB */
(function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const YT_PATTERNS = ['*://www.youtube.com/*'];

    /* ---------------- context menus ---------------- */
    function buildMenus() {
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
                id: 'ytb-sep',
                type: 'separator',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytb-open-options',
                title: 'Manage block list…',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
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

    api.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === 'ytb-open-options') {
            api.runtime.openOptionsPage();
            return;
        }
        if (tab && tab.id != null) {
            api.tabs.sendMessage(tab.id, { action: info.menuItemId }).catch(() => {});
        }
    });

    /* ---------------- Firefox Sync mirror ----------------
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

    function listsOf(data) {
        const d = YTB.normalize(data);
        return JSON.stringify({
            hiddenVideoIds: d.hiddenVideoIds,
            blockedChannels: d.blockedChannels,
            blockedKeywords: d.blockedKeywords
        });
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
            const vids = new Set(merged.hiddenVideoIds);
            inc.hiddenVideoIds.forEach(v => vids.add(v));
            merged.hiddenVideoIds = [...vids];
            for (const c of inc.blockedChannels) {
                if (!merged.blockedChannels.some(x => YTB.sameChannel(x, c))) {
                    merged.blockedChannels.push(c);
                }
            }
            const kws = new Set(merged.blockedKeywords);
            inc.blockedKeywords.forEach(k => kws.add(k));
            merged.blockedKeywords = [...kws];
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
        next.hiddenVideoIds = inc.hiddenVideoIds;
        next.blockedChannels = inc.blockedChannels;
        next.blockedKeywords = inc.blockedKeywords;
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
