/* ==================================================================
 * YouTube/Twitch Enhancer — watched-video database
 *
 * A dedicated persistence layer for "have I watched this video?",
 * independent of YouTube's flaky thumbnail progress bar. The set is
 * cached in memory for O(1) lookups during DOM scans and written back
 * to browser.storage.local in debounced batches, so a full-page tile
 * scan never touches storage.
 *
 * Storage layout — all keys live OUTSIDE the shared "data" record, so the
 * Firefox-Sync mirror in background.js never tries to push this (it can be
 * enormous, sync has an 8KB/item quota):
 *   ytbWatchedEpoch       reset generation. Clear advances this token, making
 *                         every older in-flight snapshot logically stale.
 *   ytbWatchedMeta        { v, epoch, shards, count } — count without loading
 *                         the full set (validated against the current epoch).
 *   ytbWatchedShard0..N   { epoch, ids[] }, bucketed by a cheap hash so adding
 *                         one ID only rewrites one bucket. Legacy bare arrays
 *                         are accepted while the epoch is still zero.
 *   ytbWatchedChannels    { epoch, records } — per-channel watched/hidden data
 *                         for the badge shown on channel pages.
 *   ytbWatchedOpsShard0..N timestamped watched remove/restore operations,
 *                         sharded with the watched IDs so one Undo stays small.
 *   ytbWatchedOps         timestamped channel-hidden operations. The legacy v2
 *                         combined watched/hidden shape is migrated on load.
 *
 * Exposed as `YTBWatchedDB` on the shared content-script global (and on the
 * options page's window). All storage access is confined to this file — the
 * rest of the extension calls the API below and never touches these keys.
 * ================================================================== */
(function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;

    // 64 buckets: at N watched videos each dirty write is ~N/64 of the data,
    // and loading reads all 64 keys in a single storage.get. More buckets =
    // smaller writes but a longer key list; 64 is a good middle ground.
    const SHARD_COUNT = 64;
    const EPOCH_KEY = 'ytbWatchedEpoch';
    const META_KEY = 'ytbWatchedMeta';
    const SHARD_PREFIX = 'ytbWatchedShard';
    const CHANNELS_KEY = 'ytbWatchedChannels';
    const OPS_KEY = 'ytbWatchedOps';          // channel-hidden operations
    const OPS_SHARD_PREFIX = 'ytbWatchedOpsShard';
    const STORAGE_VERSION = 3;
    const LOAD_ATTEMPTS = 3;
    const LOAD_SNAPSHOT_MAX_WAIT = 2000;
    const LOAD_RETRY_INITIAL = 250;
    const LOAD_RETRY_MAX = 30000;
    const FLUSH_DELAY = 2000;              // write after the current scan goes quiet
    const FLUSH_MAX_WAIT = 10000;           // but never defer active changes forever
    const MAX_CHANNEL_IDS = 200000;        // per-channel safety bound

    /* ---- in-memory state ---- */
    const shards = new Array(SHARD_COUNT); // Array<Set<string>>
    const watchedOps = new Array(SHARD_COUNT); // per-ID remove/restore operations
    for (let i = 0; i < SHARD_COUNT; i++) {
        shards[i] = new Set();
        watchedOps[i] = new Map();
    }
    let channels = {};                     // key -> { name, handle, channelId, total, ids:Set }
    const hiddenOps = new Map();            // global channel-hidden remove/restore operations
    let totalCount = 0;
    let loaded = false;
    let loadingPromise = null;
    const dirtyShards = new Set();
    const dirtyOpShards = new Set();
    let channelsDirty = false;
    let metaDirty = false;
    let hiddenOpsDirty = false;
    let flushTimer = null;
    let flushWindowStarted = 0;
    let flushInFlight = null;
    let clearInFlight = null;
    let epochResetApplying = false;
    let loadRecoveryPending = false;
    let loadRetryTimer = null;
    let loadRetryDelay = LOAD_RETRY_INITIAL;
    let dataRevision = 0;
    let storageEpoch = 0;                  // 0 reads the legacy bare-array format
    let epochSignal = 0;                   // generation changes cancel stale loaders
    let storageSignal = 0;                 // any storage event invalidates a read snapshot
    const operationOrigin = makeEpoch();
    let operationClock = 0;

    /* ---- helpers ---- */
    // djb2 string hash → bucket index. Cheap and well-distributed for IDs.
    function shardOf(id) {
        let h = 5381;
        for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
        return (h & 0x7fffffff) % SHARD_COUNT;
    }

    function shardKey(i) { return SHARD_PREFIX + i; }
    function opsShardKey(i) { return OPS_SHARD_PREFIX + i; }

    function isWatchedStorageKey(key) {
        return key === EPOCH_KEY || key === META_KEY || key === CHANNELS_KEY ||
            key === OPS_KEY || key.startsWith(SHARD_PREFIX) ||
            key.startsWith(OPS_SHARD_PREFIX);
    }

    // Stable identity for a channel record. Prefers @handle, then UC id, then
    // display name — mirrors the content script's channelSpeedKey convention.
    function channelKey(info) {
        if (!info) return null;
        if (info.handle) return '@' + info.handle.toLowerCase();
        if (info.channelId) return info.channelId;
        if (info.name) return 'name:' + info.name.toLowerCase().trim();
        return null;
    }

    function normalizeEpoch(value) {
        return (typeof value === 'string' || typeof value === 'number') ? value : 0;
    }

    function makeEpoch() {
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }

    function readOperation(value) {
        if (!value || typeof value !== 'object' ||
            !Object.prototype.hasOwnProperty.call(value, 'p') ||
            !Number.isFinite(value.t) || typeof value.o !== 'string') return null;
        const op = { p: value.p === true || value.p === 1, t: value.t, o: value.o };
        operationClock = Math.max(operationClock, op.t);
        return op;
    }

    function compareOperations(a, b) {
        if (!a) return b ? -1 : 0;
        if (!b) return 1;
        if (a.t !== b.t) return a.t > b.t ? 1 : -1;
        if (a.o === b.o) return 0;
        return a.o > b.o ? 1 : -1;
    }

    function makeOperation(present) {
        operationClock = Math.max(Date.now(), operationClock + 1);
        return { p: !!present, t: operationClock, o: operationOrigin };
    }

    function serializeOperationMap(map) {
        const out = {};
        for (const [id, op] of map) out[id] = { p: op.p ? 1 : 0, t: op.t, o: op.o };
        return out;
    }

    function serializeHiddenOperations() {
        return { epoch: storageEpoch, hidden: serializeOperationMap(hiddenOps) };
    }

    function watchedOperationRecords(value, epoch) {
        if (!value || typeof value !== 'object' || value.epoch !== epoch ||
            !value.ops || typeof value.ops !== 'object') return null;
        return value.ops;
    }

    // v2 kept watched and hidden operations together. Continue reading that
    // shape while v3 writes watched operations to bounded per-shard records.
    function operationPayload(value, epoch) {
        if (!value || typeof value !== 'object' || value.epoch !== epoch) return null;
        const hasWatched = !!(value.watched && typeof value.watched === 'object');
        return {
            hasWatched,
            watched: hasWatched ? value.watched : {},
            hidden: value.hidden && typeof value.hidden === 'object' ? value.hidden : {}
        };
    }

    function watchedOperation(id) {
        return watchedOps[shardOf(id)].get(id) || null;
    }

    function watchedOperationAllows(id) {
        const op = watchedOperation(id);
        return !op || op.p;
    }

    function hiddenOperationAllows(id) {
        const op = hiddenOps.get(id);
        return !op || op.p;
    }

    function shardIds(value, epoch) {
        if (Array.isArray(value)) return epoch === 0 ? value : null;
        if (!value || typeof value !== 'object' || value.epoch !== epoch ||
            !Array.isArray(value.ids)) return null;
        return value.ids;
    }

    function channelRecords(value, epoch) {
        if (!value || typeof value !== 'object') return null;
        if (value.epoch === epoch && value.records && typeof value.records === 'object') {
            return value.records;
        }
        // v1 stored the records object directly.
        if (epoch === 0 && !Object.prototype.hasOwnProperty.call(value, 'epoch')) return value;
        return null;
    }

    function resetMemory() {
        for (let i = 0; i < SHARD_COUNT; i++) {
            shards[i] = new Set();
            watchedOps[i] = new Map();
        }
        hiddenOps.clear();
        channels = {};
        totalCount = 0;
        dirtyShards.clear();
        dirtyOpShards.clear();
        channelsDirty = false;
        metaDirty = false;
        hiddenOpsDirty = false;
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        flushWindowStarted = 0;
    }

    function notifyChange() {
        dataRevision++;
        try { document.dispatchEvent(new CustomEvent('ytb-watched-db-change')); } catch (e) {}
    }

    function cancelLoadRetry() {
        if (loadRetryTimer) {
            clearTimeout(loadRetryTimer);
            loadRetryTimer = null;
        }
        loadRetryDelay = LOAD_RETRY_INITIAL;
    }

    function scheduleLoadRetry() {
        if (loaded || loadRetryTimer) return;
        const delay = loadRetryDelay;
        loadRetryDelay = Math.min(LOAD_RETRY_MAX, loadRetryDelay * 2);
        loadRetryTimer = setTimeout(() => {
            loadRetryTimer = null;
            ensureLoaded().catch(() => {});
        }, delay);
    }

    function applyEpochReset(epoch) {
        if (epoch === storageEpoch && loaded) return;
        epochResetApplying = true;
        try {
            storageEpoch = epoch;
            epochSignal++;
            resetMemory();
            loaded = true;
            loadRecoveryPending = false;
            cancelLoadRetry();
            notifyChange();
        } finally {
            epochResetApplying = false;
        }
    }

    function serializeChannels() {
        const out = {};
        for (const k of Object.keys(channels)) {
            const rec = channels[k];
            out[k] = {
                name: rec.name, handle: rec.handle, channelId: rec.channelId,
                total: rec.total, ids: [...rec.ids], hidden: [...rec.hidden]
            };
        }
        return out;
    }

    async function ensureLoaded() {
        if (loaded) return;
        if (loadingPromise) return loadingPromise;

        const promise = (async () => {
            const keys = [EPOCH_KEY, META_KEY, CHANNELS_KEY, OPS_KEY];
            for (let i = 0; i < SHARD_COUNT; i++) {
                keys.push(shardKey(i), opsShardKey(i));
            }

            let lastError = null;
            let failures = 0;
            const snapshotDeadline = Date.now() + LOAD_SNAPSHOT_MAX_WAIT;
            while (failures < LOAD_ATTEMPTS) {
                if (loaded) return;
                const epochAtStart = epochSignal;
                const storageAtStart = storageSignal;
                try {
                    const got = await api.storage.local.get(keys);
                    // A local or distributed reset supersedes this loader even
                    // before its storage event is delivered.
                    if (loaded || epochAtStart !== epochSignal) return;
                    if (storageAtStart !== storageSignal) {
                        lastError = new Error('Watched history changed while loading.');
                        if (Date.now() >= snapshotDeadline) throw lastError;
                        continue;
                    }

                    const epoch = normalizeEpoch(got[EPOCH_KEY]);
                    const nextShards = Array.from(
                        { length: SHARD_COUNT }, () => new Set());
                    const nextWatchedOps = Array.from(
                        { length: SHARD_COUNT }, () => new Map());
                    const nextHiddenOps = new Map();
                    const nextChannels = {};

                    const storedOps = operationPayload(got[OPS_KEY], epoch);
                    const migrateLegacyWatchedOps = !!(storedOps && storedOps.hasWatched);
                    if (storedOps) {
                        for (const id of Object.keys(storedOps.watched)) {
                            const op = readOperation(storedOps.watched[id]);
                            if (op && id) nextWatchedOps[shardOf(id)].set(id, op);
                        }
                        for (const id of Object.keys(storedOps.hidden)) {
                            const op = readOperation(storedOps.hidden[id]);
                            if (op && id) nextHiddenOps.set(id, op);
                        }
                    }
                    for (let i = 0; i < SHARD_COUNT; i++) {
                        const records = watchedOperationRecords(got[opsShardKey(i)], epoch);
                        if (!records) continue;
                        for (const id of Object.keys(records)) {
                            const op = readOperation(records[id]);
                            if (!op || !id || shardOf(id) !== i) continue;
                            const local = nextWatchedOps[i].get(id);
                            if (compareOperations(op, local) > 0) {
                                nextWatchedOps[i].set(id, op);
                            }
                        }
                    }

                    const allowsWatched = id => {
                        const op = nextWatchedOps[shardOf(id)].get(id);
                        return !op || op.p;
                    };
                    const allowsHidden = id => {
                        const op = nextHiddenOps.get(id);
                        return !op || op.p;
                    };

                    for (let i = 0; i < SHARD_COUNT; i++) {
                        const ids = shardIds(got[shardKey(i)], epoch);
                        if (!ids) continue;
                        for (const id of ids) {
                            if (typeof id === 'string' && id && allowsWatched(id)) {
                                nextShards[i].add(id);
                            }
                        }
                    }
                    // A restore operation is authoritative even if a stale tab's
                    // last shard snapshot omitted the ID.
                    for (let i = 0; i < SHARD_COUNT; i++) {
                        for (const [id, op] of nextWatchedOps[i]) {
                            if (op.p) nextShards[i].add(id);
                        }
                    }

                    const records = channelRecords(got[CHANNELS_KEY], epoch);
                    if (records) {
                        for (const k of Object.keys(records)) {
                            const rec = records[k] || {};
                            nextChannels[k] = {
                                name: rec.name || '',
                                handle: rec.handle || '',
                                channelId: rec.channelId || '',
                                total: (typeof rec.total === 'number' && rec.total >= 0)
                                    ? rec.total : null,
                                ids: new Set((Array.isArray(rec.ids) ? rec.ids : [])
                                    .filter(id => typeof id === 'string' && id && allowsWatched(id))),
                                hidden: new Set((Array.isArray(rec.hidden) ? rec.hidden : [])
                                    .filter(id => typeof id === 'string' && id && allowsHidden(id)))
                            };
                        }
                    }

                    resetMemory();
                    storageEpoch = epoch;
                    for (let i = 0; i < SHARD_COUNT; i++) {
                        shards[i] = nextShards[i];
                        watchedOps[i] = nextWatchedOps[i];
                        totalCount += shards[i].size;
                    }
                    for (const [id, op] of nextHiddenOps) hiddenOps.set(id, op);
                    channels = nextChannels;
                    loaded = true;
                    const recovered = loadRecoveryPending;
                    loadRecoveryPending = false;
                    cancelLoadRetry();
                    // Atomically migrate v2's monolithic watched-operation map
                    // into v3 shards and replace the combined record.
                    if (migrateLegacyWatchedOps) {
                        for (let i = 0; i < SHARD_COUNT; i++) {
                            if (watchedOps[i].size) dirtyOpShards.add(i);
                        }
                        hiddenOpsDirty = true;
                    }
                    const persistedMeta = got[META_KEY];
                    if ((persistedMeta || totalCount > 0) &&
                        (!persistedMeta || typeof persistedMeta !== 'object' ||
                         normalizeEpoch(persistedMeta.epoch) !== storageEpoch ||
                         persistedMeta.count !== totalCount ||
                         persistedMeta.shards !== SHARD_COUNT)) {
                        metaDirty = true;
                    }
                    if (dirtyOpShards.size || hiddenOpsDirty || metaDirty) scheduleFlush();
                    if (recovered) notifyChange();
                    return;
                } catch (e) {
                    if (epochAtStart !== epochSignal && loaded) return;
                    lastError = e;
                    failures++;
                    if (failures < LOAD_ATTEMPTS) {
                        await new Promise(resolve => setTimeout(resolve, 50 * failures));
                    }
                }
            }
            throw lastError || new Error('Could not load watched history.');
        })();

        loadingPromise = promise;
        try {
            await promise;
        } catch (e) {
            // Leave the store untrusted. Mutation APIs refuse to write until a
            // later retry succeeds, preventing an empty-cache overwrite.
            loaded = false;
            loadRecoveryPending = true;
            if (loadingPromise === promise) loadingPromise = null;
            scheduleLoadRetry();
            throw e;
        }
    }
    function scheduleFlush() {
        const now = Date.now();
        if (!flushWindowStarted) flushWindowStarted = now;
        if (flushTimer) clearTimeout(flushTimer);
        const remaining = Math.max(0, FLUSH_MAX_WAIT - (now - flushWindowStarted));
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushWindowStarted = 0;
            flush().catch(() => {});
        }, Math.min(FLUSH_DELAY, remaining));
    }

    async function flush() {
        if (clearInFlight) await clearInFlight;
        if (!loaded) throw new Error('Watched history is not loaded.');
        if (flushInFlight) {
            try { await flushInFlight; } catch (e) { /* first caller handles retry */ }
        }
        if (!dirtyShards.size && !dirtyOpShards.size && !channelsDirty &&
            !metaDirty && !hiddenOpsDirty) return;

        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        flushWindowStarted = 0;

        // Snapshot and clear first. Marks made while storage.set is in flight
        // become a new dirty batch instead of being lost when this write lands.
        const writeEpoch = storageEpoch;
        const writtenShards = [...dirtyShards];
        const writtenOpShards = [...dirtyOpShards];
        const wroteChannels = channelsDirty;
        const wroteMeta = metaDirty;
        const wroteHiddenOps = hiddenOpsDirty;
        dirtyShards.clear();
        dirtyOpShards.clear();
        channelsDirty = false;
        metaDirty = false;
        hiddenOpsDirty = false;

        const items = {};
        for (const i of writtenShards) {
            items[shardKey(i)] = { epoch: writeEpoch, ids: [...shards[i]] };
        }
        for (const i of writtenOpShards) {
            items[opsShardKey(i)] = {
                epoch: writeEpoch,
                ops: serializeOperationMap(watchedOps[i])
            };
        }
        if (wroteChannels) {
            items[CHANNELS_KEY] = {
                epoch: writeEpoch,
                records: serializeChannels()
            };
        }
        if (wroteHiddenOps) items[OPS_KEY] = serializeHiddenOperations();
        items[META_KEY] = {
            v: STORAGE_VERSION,
            epoch: writeEpoch,
            shards: SHARD_COUNT,
            count: totalCount
        };

        const write = api.storage.local.set(items);
        flushInFlight = write;
        try {
            await write;
        } catch (e) {
            // A reset makes this snapshot obsolete. Only retry failures from
            // the still-current generation.
            if (storageEpoch === writeEpoch) {
                writtenShards.forEach(i => dirtyShards.add(i));
                writtenOpShards.forEach(i => dirtyOpShards.add(i));
                if (wroteChannels) channelsDirty = true;
                if (wroteMeta) metaDirty = true;
                if (wroteHiddenOps) hiddenOpsDirty = true;
                scheduleFlush();
            }
            throw e;
        } finally {
            if (flushInFlight === write) flushInFlight = null;
        }

        if ((dirtyShards.size || dirtyOpShards.size || channelsDirty ||
             metaDirty || hiddenOpsDirty) && !flushTimer) scheduleFlush();
    }
    /* ================= public API: watched set ================= */
    function isWatched(id) {
        return !!id && shards[shardOf(id)].has(id);
    }

    // Returns true if the ID was newly added (false if already present).
    function markWatched(id) {
        if (!loaded || clearInFlight || epochResetApplying) {
            if (!loaded) ensureLoaded().catch(() => {});
            return false;
        }
        if (!id || typeof id !== 'string') return false;
        const idx = shardOf(id);
        const s = shards[idx];
        if (s.has(id)) return false;
        const previousOp = watchedOps[idx].get(id);
        if (previousOp && !previousOp.p) {
            watchedOps[idx].set(id, makeOperation(true));
            dirtyOpShards.add(idx);
        }
        s.add(id);
        totalCount++;
        dataRevision++;
        dirtyShards.add(idx);
        scheduleFlush();
        return true;
    }

    function remove(id) {
        if (!loaded || clearInFlight || epochResetApplying || !id) return false;
        const idx = shardOf(id);
        if (!shards[idx].delete(id)) return false;
        watchedOps[idx].set(id, makeOperation(false));
        dirtyOpShards.add(idx);
        totalCount--;
        dataRevision++;
        dirtyShards.add(idx);
        for (const k of Object.keys(channels)) {
            if (channels[k].ids.delete(id)) channelsDirty = true;
        }
        scheduleFlush();
        return true;
    }

    function count() { return totalCount; }
    function revision() { return dataRevision; }

    /* ================= public API: channel records ================= */
    function ensureChannelRec(info) {
        if (!loaded || clearInFlight || epochResetApplying) {
            if (!loaded) ensureLoaded().catch(() => {});
            return null;
        }
        const key = channelKey(info);
        if (!key) return null;
        let rec = channels[key];
        if (!rec) {
            rec = channels[key] = {
                name: info.name || '', handle: info.handle || '',
                channelId: info.channelId || '', total: null, ids: new Set(), hidden: new Set()
            };
            channelsDirty = true;
        } else {
            // Learn identifiers we didn't have when the record was created.
            if (info.handle && !rec.handle) { rec.handle = info.handle; channelsDirty = true; }
            if (info.channelId && !rec.channelId) { rec.channelId = info.channelId; channelsDirty = true; }
            if (info.name && !rec.name) { rec.name = info.name; channelsDirty = true; }
        }
        return rec;
    }

    // Attribute a watched video to a channel (the numerator of the badge).
    function recordChannelVideo(info, id) {
        if (!id || !watchedOperationAllows(id)) return;
        const rec = ensureChannelRec(info);
        if (!rec || rec.ids.size >= MAX_CHANNEL_IDS || rec.ids.has(id)) return;
        rec.ids.add(id);
        channelsDirty = true;
        scheduleFlush();
    }

    // Attribute a manually-hidden video to a channel (the "Hidden N" counter).
    // Kept separate from the watched tally so the two are counted independently.
    function recordChannelHidden(info, id) {
        if (!id) return;
        const rec = ensureChannelRec(info);
        if (!rec || rec.hidden.size >= MAX_CHANNEL_IDS || rec.hidden.has(id)) return;
        const previousOp = hiddenOps.get(id);
        if (previousOp && !previousOp.p) {
            hiddenOps.set(id, makeOperation(true));
            hiddenOpsDirty = true;
        }
        rec.hidden.add(id);
        channelsDirty = true;
        scheduleFlush();
    }

    // Drop a video from every channel's hidden tally (used when a hide is undone).
    function removeHidden(id) {
        if (!loaded || clearInFlight || epochResetApplying || !id) return;
        let changed = false;
        for (const k of Object.keys(channels)) {
            if (channels[k].hidden.delete(id)) changed = true;
        }
        const previousOp = hiddenOps.get(id);
        if (!previousOp || previousOp.p) {
            hiddenOps.set(id, makeOperation(false));
            hiddenOpsDirty = true;
            changed = true;
        }
        if (changed) { channelsDirty = true; scheduleFlush(); }
    }

    // Record the channel's total video count (scraped from the channel page).
    function setChannelTotal(info, total) {
        if (!(total >= 0)) return;
        const rec = ensureChannelRec(info);
        if (!rec || rec.total === total) return;
        rec.total = total;
        channelsDirty = true;
        scheduleFlush();
    }

    function getChannelStats(info) {
        const key = channelKey(info);
        if (!key) return null;
        const rec = channels[key];
        return rec
            ? { watched: rec.ids.size, total: rec.total, hidden: rec.hidden.size }
            : { watched: 0, total: null, hidden: 0 };
    }

    /* ================= public API: import / export / clear ================= */
    function exportData() {
        const ids = [];
        for (let i = 0; i < SHARD_COUNT; i++) for (const id of shards[i]) ids.push(id);
        const chOut = {};
        for (const k of Object.keys(channels)) {
            const rec = channels[k];
            chOut[k] = {
                name: rec.name, handle: rec.handle, channelId: rec.channelId,
                total: rec.total, ids: [...rec.ids], hidden: [...rec.hidden]
            };
        }
        return { type: 'ytb-watched', version: 1, count: ids.length, ids, channels: chOut };
    }

    // Merge watched IDs from a bare array, or from an object shaped like the
    // export ({ ids:[...], channels:{...} }) or { watched:[...] }. Duplicates
    // are ignored. Returns the number of newly-added video IDs.
    function importData(data) {
        let list = [];
        let chIn = null;
        if (Array.isArray(data)) {
            list = data;
        } else if (data && typeof data === 'object') {
            if (Array.isArray(data.ids)) list = data.ids;
            else if (Array.isArray(data.watched)) list = data.watched;
            if (data.channels && typeof data.channels === 'object') chIn = data.channels;
        }
        let added = 0;
        for (const id of list) if (typeof id === 'string' && id && markWatched(id)) added++;
        if (chIn) {
            for (const k of Object.keys(chIn)) {
                const rec = chIn[k] || {};
                const target = ensureChannelRec({
                    handle: rec.handle, channelId: rec.channelId, name: rec.name
                });
                if (!target) continue;
                if (rec.total >= 0 && (target.total == null || rec.total > target.total)) {
                    target.total = rec.total;
                    channelsDirty = true;
                }
                if (Array.isArray(rec.ids)) {
                    for (const id of rec.ids) {
                        if (typeof id === 'string' && id && watchedOperationAllows(id) &&
                            !target.ids.has(id)) {
                            target.ids.add(id);
                            channelsDirty = true;
                        }
                    }
                }
                if (Array.isArray(rec.hidden)) {
                    for (const id of rec.hidden) {
                        if (typeof id !== 'string' || !id) continue;
                        const previousOp = hiddenOps.get(id);
                        if (previousOp && !previousOp.p) {
                            hiddenOps.set(id, makeOperation(true));
                            hiddenOpsDirty = true;
                        }
                        if (!target.hidden.has(id)) {
                            target.hidden.add(id);
                            channelsDirty = true;
                        }
                    }
                }
            }
        }
        if (added || dirtyOpShards.size || channelsDirty || hiddenOpsDirty) scheduleFlush();
        return added;
    }

    async function clear() {
        if (clearInFlight) await clearInFlight;

        // Install the mutation barrier before the synchronous change event:
        // content filtering can re-enter markWatched while reacting to reset.
        let releaseBarrier;
        const barrier = new Promise(resolve => { releaseBarrier = resolve; });
        clearInFlight = barrier;

        // Advancing the generation is the logical clear. Empty tagged shards
        // erase the normal durable copies in the same transaction; an old
        // in-flight tab write may still land later, but listeners repair any
        // fixed key it overwrites with the current generation.
        const previousEpoch = storageEpoch;
        const epoch = makeEpoch();
        try {
            storageEpoch = epoch;
            epochSignal++;
            resetMemory();
            loaded = true;
            loadingPromise = null;
            loadRecoveryPending = false;
            cancelLoadRetry();
            notifyChange();

            const empty = {
                [EPOCH_KEY]: epoch,
                [META_KEY]: {
                    v: STORAGE_VERSION,
                    epoch,
                    shards: SHARD_COUNT,
                    count: 0
                },
                [CHANNELS_KEY]: { epoch, records: {} },
                [OPS_KEY]: { epoch, hidden: {} }
            };
            for (let i = 0; i < SHARD_COUNT; i++) {
                empty[shardKey(i)] = { epoch, ids: [] };
                empty[opsShardKey(i)] = { epoch, ops: {} };
            }

            await api.storage.local.set(empty);
        } catch (e) {
            // Restore the durable generation if the reset itself failed.
            storageEpoch = previousEpoch;
            loaded = false;
            loadingPromise = null;
            try { await ensureLoaded(); } catch (loadError) { /* remain read-only */ }
            notifyChange();
            throw e;
        } finally {
            if (clearInFlight === barrier) clearInFlight = null;
            releaseBarrier();
        }
    }
    // Read just the persisted count without loading the whole set — used by
    // the options page. A stale in-flight meta write cannot restore the count
    // because its epoch will not match EPOCH_KEY.
    async function getStoredCount() {
        try {
            const r = await api.storage.local.get([EPOCH_KEY, META_KEY]);
            const epoch = normalizeEpoch(r[EPOCH_KEY]);
            const meta = r[META_KEY];
            if (!meta || typeof meta !== 'object') return 0;
            const metaEpoch = Object.prototype.hasOwnProperty.call(meta, 'epoch')
                ? meta.epoch : 0;
            return metaEpoch === epoch ? (meta.count || 0) : 0;
        } catch (e) {
            return 0;
        }
    }
    // Cross-tab convergence. Generation changes are distributed clears. Plain
    // additions are unioned; explicit timestamped operations make remove/restore
    // deterministic even when an older tab writes a stale whole-shard snapshot.
    api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !Object.keys(changes).some(isWatchedStorageKey)) return;
        storageSignal++;

        const epochChange = changes[EPOCH_KEY];
        if (epochChange) {
            const nextEpoch = normalizeEpoch(epochChange.newValue);
            if (nextEpoch !== storageEpoch) applyEpochReset(nextEpoch);
        }
        if (!loaded) return;

        let watchedChanged = false;
        let channelChanged = false;
        let needsUnionFlush = false;

        // Merge operations before shard/channel snapshots so a deletion in the
        // same storage event wins over an old ID still present in those arrays.
        const mergeWatchedOperation = (id, incoming, idx) => {
            const local = watchedOps[idx].get(id);
            const order = compareOperations(incoming, local);
            if (order > 0) {
                watchedOps[idx].set(id, incoming);
                if (incoming.p) {
                    if (!shards[idx].has(id)) {
                        shards[idx].add(id);
                        totalCount++;
                        watchedChanged = true;
                    }
                } else if (shards[idx].delete(id)) {
                    totalCount--;
                    watchedChanged = true;
                }
                if (!incoming.p) {
                    for (const key of Object.keys(channels)) {
                        if (channels[key].ids.delete(id)) {
                            channelsDirty = true;
                            channelChanged = true;
                        }
                    }
                }
                // Keep the physical ID shard coherent with the winning op.
                dirtyShards.add(idx);
                needsUnionFlush = true;
            } else if (order < 0) {
                // The local op won; restore it after a stale whole-shard write.
                dirtyOpShards.add(idx);
                needsUnionFlush = true;
            }
            return order;
        };

        // v3 stores watched operations beside their matching ID shard. Merge
        // every operation shard before any watched-ID snapshot in this event.
        for (let i = 0; i < SHARD_COUNT; i++) {
            const operationChange = changes[opsShardKey(i)];
            if (!operationChange) continue;
            const records = watchedOperationRecords(operationChange.newValue, storageEpoch);
            if (!records) {
                dirtyOpShards.add(i);
                needsUnionFlush = true;
                continue;
            }

            const seen = new Set();
            for (const id of Object.keys(records)) {
                const incoming = readOperation(records[id]);
                if (!incoming || !id || shardOf(id) !== i) {
                    dirtyOpShards.add(i);
                    needsUnionFlush = true;
                    continue;
                }
                seen.add(id);
                mergeWatchedOperation(id, incoming, i);
            }
            for (const id of watchedOps[i].keys()) {
                if (!seen.has(id)) {
                    dirtyOpShards.add(i);
                    needsUnionFlush = true;
                    break;
                }
            }
        }

        // v2 stored watched and channel-hidden operations together. Watched
        // records from an older live tab are accepted and migrated into v3.
        const opsChange = changes[OPS_KEY];
        if (opsChange) {
            const incomingOps = operationPayload(opsChange.newValue, storageEpoch);
            if (incomingOps) {
                if (incomingOps.hasWatched) {
                    // Replacing the combined v2 record is part of migration even
                    // when its watched map is empty.
                    hiddenOpsDirty = true;
                    needsUnionFlush = true;
                    for (const id of Object.keys(incomingOps.watched)) {
                        const incoming = readOperation(incomingOps.watched[id]);
                        if (!incoming || !id) continue;
                        const idx = shardOf(id);
                        mergeWatchedOperation(id, incoming, idx);
                        dirtyOpShards.add(idx);
                        needsUnionFlush = true;
                    }
                }

                const seenHidden = new Set();
                for (const id of Object.keys(incomingOps.hidden)) {
                    const incoming = readOperation(incomingOps.hidden[id]);
                    if (!incoming || !id) continue;
                    seenHidden.add(id);
                    const local = hiddenOps.get(id);
                    const order = compareOperations(incoming, local);
                    if (order > 0) {
                        hiddenOps.set(id, incoming);
                        if (!incoming.p) {
                            for (const key of Object.keys(channels)) {
                                if (channels[key].hidden.delete(id)) {
                                    channelsDirty = true;
                                    channelChanged = true;
                                }
                            }
                        }
                    } else if (order < 0) {
                        hiddenOpsDirty = true;
                        needsUnionFlush = true;
                    }
                }
                for (const id of hiddenOps.keys()) {
                    if (!seenHidden.has(id)) {
                        hiddenOpsDirty = true;
                        needsUnionFlush = true;
                    }
                }
            } else {
                hiddenOpsDirty = true;
                needsUnionFlush = true;
            }
        }
        for (let i = 0; i < SHARD_COUNT; i++) {
            const change = changes[shardKey(i)];
            if (!change) continue;
            const ids = shardIds(change.newValue, storageEpoch);
            if (!ids) {
                dirtyShards.add(i);
                needsUnionFlush = true;
                continue;
            }

            const incoming = new Set();
            for (const id of ids) {
                if (typeof id !== 'string' || !id) continue;
                if (watchedOperationAllows(id)) incoming.add(id);
                else {
                    dirtyShards.add(i); // physically clean a stale tombstoned ID
                    needsUnionFlush = true;
                }
            }
            const local = shards[i];
            for (const id of local) {
                if (!incoming.has(id)) {
                    dirtyShards.add(i);
                    needsUnionFlush = true;
                    break;
                }
            }
            for (const id of incoming) {
                if (local.has(id)) continue;
                local.add(id);
                totalCount++;
                watchedChanged = true;
            }
        }

        const channelChange = changes[CHANNELS_KEY];
        if (channelChange) {
            const incomingRecords = channelRecords(channelChange.newValue, storageEpoch);
            if (incomingRecords) {
                for (const key of Object.keys(channels)) {
                    if (!Object.prototype.hasOwnProperty.call(incomingRecords, key)) {
                        channelsDirty = true;
                        needsUnionFlush = true;
                    }
                }
                for (const key of Object.keys(incomingRecords)) {
                    const incoming = incomingRecords[key] || {};
                    const incomingIds = new Set((Array.isArray(incoming.ids) ? incoming.ids : [])
                        .filter(id => typeof id === 'string' && id && watchedOperationAllows(id)));
                    const incomingHidden = new Set(
                        (Array.isArray(incoming.hidden) ? incoming.hidden : [])
                            .filter(id => typeof id === 'string' && id && hiddenOperationAllows(id)));
                    if ((Array.isArray(incoming.ids) && incomingIds.size !== incoming.ids.length) ||
                        (Array.isArray(incoming.hidden) &&
                         incomingHidden.size !== incoming.hidden.length)) {
                        channelsDirty = true;
                        needsUnionFlush = true;
                    }

                    let local = channels[key];
                    if (!local) {
                        local = channels[key] = {
                            name: incoming.name || '',
                            handle: incoming.handle || '',
                            channelId: incoming.channelId || '',
                            total: (typeof incoming.total === 'number' && incoming.total >= 0)
                                ? incoming.total : null,
                            ids: incomingIds,
                            hidden: incomingHidden
                        };
                        channelChanged = true;
                        continue;
                    }

                    let localOnly = false;
                    for (const field of ['name', 'handle', 'channelId']) {
                        const next = incoming[field] || '';
                        if (!local[field] && next) {
                            local[field] = next;
                            channelChanged = true;
                        } else if (local[field] && !next) {
                            localOnly = true;
                        } else if (local[field] && next && local[field] !== next) {
                            if (next > local[field]) {
                                local[field] = next;
                                channelChanged = true;
                            } else {
                                localOnly = true;
                            }
                        }
                    }
                    if (typeof incoming.total === 'number' && incoming.total >= 0) {
                        if (local.total == null || incoming.total > local.total) {
                            local.total = incoming.total;
                            channelChanged = true;
                        } else if (local.total > incoming.total) {
                            localOnly = true;
                        }
                    } else if (local.total != null) {
                        localOnly = true;
                    }

                    for (const id of local.ids) if (!incomingIds.has(id)) localOnly = true;
                    for (const id of local.hidden) if (!incomingHidden.has(id)) localOnly = true;
                    for (const id of incomingIds) {
                        if (!local.ids.has(id)) { local.ids.add(id); channelChanged = true; }
                    }
                    for (const id of incomingHidden) {
                        if (!local.hidden.has(id)) { local.hidden.add(id); channelChanged = true; }
                    }
                    if (localOnly) {
                        channelsDirty = true;
                        needsUnionFlush = true;
                    }
                }
            } else {
                channelsDirty = true;
                needsUnionFlush = true;
            }
        }

        const metaChange = changes[META_KEY];
        if (metaChange) {
            const incomingMeta = metaChange.newValue;
            const incomingEpoch = incomingMeta && typeof incomingMeta === 'object'
                ? normalizeEpoch(incomingMeta.epoch) : null;
            if (!incomingMeta || incomingEpoch !== storageEpoch ||
                incomingMeta.count !== totalCount ||
                incomingMeta.shards !== SHARD_COUNT) {
                metaDirty = true;
                needsUnionFlush = true;
            }
        }
        if (watchedChanged) metaDirty = true;
        if (needsUnionFlush || dirtyShards.size || dirtyOpShards.size || channelsDirty ||
            metaDirty || hiddenOpsDirty) scheduleFlush();
        if (watchedChanged || channelChanged) notifyChange();
    });
    // Flush on tab/background transitions: serialization happens off the
    // visible filtering cascade, and pagehide reduces the chance of losing the
    // final quiet-window batch.
    const flushBeforeSuspend = () => {
        if (!dirtyShards.size && !dirtyOpShards.size && !channelsDirty &&
            !metaDirty && !hiddenOpsDirty) return;
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        flushWindowStarted = 0;
        flush().catch(() => {});
    };
    try {
        addEventListener('pagehide', flushBeforeSuspend);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) flushBeforeSuspend();
        });
    } catch (e) { /* non-window test context */ }

    const YTBWatchedDB = {
        whenReady: ensureLoaded,
        isWatched, markWatched, remove, count, revision,
        recordChannelVideo, recordChannelHidden, removeHidden,
        setChannelTotal, getChannelStats,
        export: exportData, import: importData, clear,
        getStoredCount, flush
    };

    // Share on the content-script global (all content-script files for a frame
    // run in one scope) and on window (options page).
    const g = (typeof self !== 'undefined') ? self
        : (typeof window !== 'undefined') ? window : this;
    g.YTBWatchedDB = YTBWatchedDB;
})();
