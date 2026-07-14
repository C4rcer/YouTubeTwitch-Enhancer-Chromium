/* eslint-env node */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const DB_PATH = path.join(__dirname, '..', 'src', 'watched-db.js');

function shardOf(id) {
    let hash = 5381;
    for (let i = 0; i < id.length; i++) hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
    return (hash & 0x7fffffff) % 64;
}

function createHarness(initial = {}) {
    const state = { ...initial };
    const changeListeners = [];
    const documentEvents = [];
    const documentListeners = {};
    let failNextSet = false;

    const local = {
        async get(keys) {
            if (typeof keys === 'string') return { [keys]: state[keys] };
            const out = {};
            for (const key of keys || []) {
                if (Object.hasOwn(state, key)) out[key] = state[key];
            }
            return out;
        },
        async set(items) {
            if (failNextSet) {
                failNextSet = false;
                throw new Error('synthetic storage failure');
            }
            Object.assign(state, items);
        },
        async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
        }
    };
    const document = {
        hidden: false,
        addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); },
        dispatchEvent(event) {
            documentEvents.push(event.type);
            (documentListeners[event.type] || []).forEach(fn => fn(event));
        }
    };
    const context = {
        browser: {
            storage: {
                local,
                onChanged: { addListener(fn) { changeListeners.push(fn); } }
            }
        },
        document,
        CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
        addEventListener() {},
        setTimeout,
        clearTimeout,
        console
    };
    context.self = context;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(DB_PATH, 'utf8'), context, { filename: DB_PATH });

    return {
        db: context.YTBWatchedDB,
        state,
        documentEvents,
        onDocumentChange(fn) {
            document.addEventListener('ytb-watched-db-change', fn);
        },
        failNextWrite() { failNextSet = true; },
        emitExternal(changes) {
            changeListeners.forEach(listener => listener(changes, 'local'));
        }
    };
}

function createSharedBackend(initial = {}) {
    const state = { ...initial };
    const listeners = [];
    const pendingWrites = [];
    const pendingReads = [];
    let deferReads = false;
    let deferWrites = false;
    let failingReads = 0;

    function select(keys) {
        if (typeof keys === 'string') return { [keys]: state[keys] };
        const out = {};
        for (const key of keys || []) {
            if (Object.hasOwn(state, key)) out[key] = state[key];
        }
        return out;
    }

    function apply(items) {
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: state[key], newValue: value };
            state[key] = value;
        }
        listeners.forEach(listener => listener(changes, 'local'));
    }

    const local = {
        get(keys) {
            if (failingReads > 0) {
                failingReads--;
                return Promise.reject(new Error('synthetic storage read failure'));
            }
            const snapshot = select(keys);
            if (!deferReads) return Promise.resolve(snapshot);
            return new Promise((resolve, reject) =>
                pendingReads.push({ snapshot, resolve, reject }));
        },
        set(items) {
            if (!deferWrites) {
                apply(items);
                return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
                pendingWrites.push({ items, resolve, reject });
            });
        },
        async remove(keys) {
            const changes = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                changes[key] = { oldValue: state[key], newValue: undefined };
                delete state[key];
            }
            listeners.forEach(listener => listener(changes, 'local'));
        }
    };

    return {
        state,
        local,
        addListener(listener) { listeners.push(listener); },
        defer(value) { deferWrites = value; },
        deferRead(value) { deferReads = value; },
        pendingCount() { return pendingWrites.length; },
        pendingReadCount() { return pendingReads.length; },
        releaseReads() {
            const reads = pendingReads.splice(0);
            reads.forEach(read => read.resolve(read.snapshot));
        },
        rejectReads(error = new Error('synthetic deferred read failure')) {
            const reads = pendingReads.splice(0);
            reads.forEach(read => read.reject(error));
        },
        releaseWrites() {
            const writes = pendingWrites.splice(0);
            for (const write of writes) {
                try {
                    apply(write.items);
                    write.resolve();
                } catch (error) {
                    write.reject(error);
                }
            }
        },
        failNextReads(count) { failingReads = count; },
        emitItems(items) { apply(items); }
    };
}

function createDbOnBackend(backend) {
    const documentEvents = [];
    const documentListeners = {};
    const document = {
        hidden: false,
        addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); },
        dispatchEvent(event) {
            documentEvents.push(event.type);
            (documentListeners[event.type] || []).forEach(fn => fn(event));
        }
    };
    const context = {
        browser: {
            storage: {
                local: backend.local,
                onChanged: { addListener(fn) { backend.addListener(fn); } }
            }
        },
        document,
        CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
        addEventListener() {},
        setTimeout,
        clearTimeout,
        console
    };
    context.self = context;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(DB_PATH, 'utf8'), context, { filename: DB_PATH });
    return {
        db: context.YTBWatchedDB,
        documentEvents,
        onDocumentChange(fn) {
            document.addEventListener('ytb-watched-db-change', fn);
        }
    };
}

function idInShardOf(reference, prefix) {
    const wanted = shardOf(reference);
    for (let i = 0; i < 10000; i++) {
        const candidate = prefix + String(i).padStart(5, '0');
        if (candidate !== reference && shardOf(candidate) === wanted) return candidate;
    }
    throw new Error('could not find a matching shard ID');
}
test('watched IDs remain O(1) in memory and flush to bounded shards', async () => {
    const harness = createHarness();
    const db = harness.db;
    await db.whenReady();

    for (let i = 0; i < 1000; i++) {
        assert.equal(db.markWatched('id' + String(i).padStart(9, '0')), true);
    }
    assert.equal(db.markWatched('id000000000'), false);
    assert.equal(db.count(), 1000);
    assert.equal(db.revision(), 1000);
    assert.equal(db.isWatched('id000000500'), true);
    assert.equal(db.isWatched('missing00000'), false);

    await db.flush();
    assert.equal(harness.state.ytbWatchedMeta.count, 1000);
    const shardKeys = Object.keys(harness.state).filter(key => key.startsWith('ytbWatchedShard'));
    assert.ok(shardKeys.length > 1 && shardKeys.length <= 64);
});

test('a failed storage write remains dirty and succeeds on retry', async () => {
    const harness = createHarness();
    const db = harness.db;
    await db.whenReady();

    db.markWatched('retry000001');
    harness.failNextWrite();
    await assert.rejects(db.flush(), /synthetic storage failure/);
    await db.flush();

    assert.equal(harness.state.ytbWatchedMeta.count, 1);
    const key = 'ytbWatchedShard' + shardOf('retry000001');
    assert.equal(harness.state[key].epoch, 0);
    assert.deepEqual(Array.from(harness.state[key].ids), ['retry000001']);
});

test('external shard changes advance the revision and notify the content filter', async () => {
    const harness = createHarness();
    const db = harness.db;
    await db.whenReady();

    const id = 'external0001';
    harness.emitExternal({
        ['ytbWatchedShard' + shardOf(id)]: { newValue: [id] }
    });

    assert.equal(db.isWatched(id), true);
    assert.equal(db.count(), 1);
    assert.equal(db.revision(), 1);
    assert.deepEqual(harness.documentEvents, ['ytb-watched-db-change']);

    await db.clear();
    assert.equal(db.count(), 0);
    assert.equal(db.revision(), 2);
});
test('simultaneous tabs converge same-shard writes', async () => {
    const backend = createSharedBackend();
    const first = createDbOnBackend(backend);
    const second = createDbOnBackend(backend);
    await Promise.all([first.db.whenReady(), second.db.whenReady()]);

    const firstId = 'concurrent-A';
    const secondId = idInShardOf(firstId, 'concurrent-B');
    backend.defer(true);
    first.db.markWatched(firstId);
    second.db.markWatched(secondId);
    const firstWrite = first.db.flush();
    const secondWrite = second.db.flush();
    assert.equal(backend.pendingCount(), 2, 'both tabs must snapshot before either write lands');

    backend.releaseWrites();
    await Promise.all([firstWrite, secondWrite]);
    backend.defer(false);
    await Promise.all([first.db.flush(), second.db.flush()]);

    const stored = backend.state['ytbWatchedShard' + shardOf(firstId)];
    assert.deepEqual(new Set(stored.ids), new Set([firstId, secondId]));
    assert.equal(first.db.isWatched(secondId), true);
    assert.equal(second.db.isWatched(firstId), true);
});

test('clear advances the generation in every tab and rejects stale writes', async () => {
    const backend = createSharedBackend();
    const first = createDbOnBackend(backend);
    const second = createDbOnBackend(backend);
    await Promise.all([first.db.whenReady(), second.db.whenReady()]);

    const oldId = 'before-clear';
    first.db.markWatched(oldId);
    await first.db.flush();
    assert.equal(second.db.isWatched(oldId), true);

    const secondRevision = second.db.revision();
    await first.db.clear();
    const newEpoch = backend.state.ytbWatchedEpoch;
    assert.notEqual(newEpoch, 0);
    assert.equal(first.db.count(), 0);
    assert.equal(second.db.count(), 0);
    assert.ok(second.db.revision() > secondRevision);

    const staleId = idInShardOf(oldId, 'stale-write');
    backend.emitItems({
        ['ytbWatchedShard' + shardOf(staleId)]: { epoch: 0, ids: [oldId, staleId] }
    });
    assert.equal(first.db.isWatched(staleId), false);
    assert.equal(second.db.isWatched(staleId), false);

    const newId = 'after-clear';
    second.db.markWatched(newId);
    await second.db.flush();
    assert.equal(first.db.isWatched(newId), true);
    assert.equal(await first.db.getStoredCount(), 1);

    const reloaded = createDbOnBackend(backend);
    await reloaded.db.whenReady();
    assert.equal(reloaded.db.isWatched(oldId), false);
    assert.equal(reloaded.db.isWatched(staleId), false);
    assert.equal(reloaded.db.isWatched(newId), true);
});

test('an unreadable initial snapshot stays read-only until a clean retry', async () => {
    const backend = createSharedBackend();
    backend.failNextReads(3);
    const harness = createDbOnBackend(backend);

    await assert.rejects(harness.db.whenReady(), /synthetic storage read failure/);
    assert.equal(harness.db.count(), 0);
    assert.equal(Object.keys(backend.state).length, 0,
        'a failed load must remain read-only and not manufacture a snapshot');

    await new Promise(resolve => harness.onDocumentChange(resolve));
    assert.equal(harness.db.count(), 0);
    assert.equal(harness.db.revision(), 1,
        'recovering from an untrusted initial read must invalidate card caches');
    assert.deepEqual(harness.documentEvents, ['ytb-watched-db-change']);
    assert.equal(Object.keys(backend.state).length, 0,
        'a failed load must not manufacture an empty persistent snapshot');

    assert.equal(harness.db.markWatched('safe-after-retry'), true);
    await harness.db.flush();
    assert.equal(await harness.db.getStoredCount(), 1);
});
test('Undo tombstones beat a stale in-flight shard and can be restored later', async () => {
    const backend = createSharedBackend();
    const first = createDbOnBackend(backend);
    const second = createDbOnBackend(backend);
    await Promise.all([first.db.whenReady(), second.db.whenReady()]);

    const removedId = 'undo-target';
    const staleCompanion = idInShardOf(removedId, 'stale-companion');
    first.db.markWatched(removedId);
    await first.db.flush();
    assert.equal(second.db.isWatched(removedId), true);

    backend.defer(true);
    first.db.remove(removedId);
    second.db.markWatched(staleCompanion);
    const removeWrite = first.db.flush();
    const staleWrite = second.db.flush();
    assert.equal(backend.pendingCount(), 2);
    backend.releaseWrites(); // deletion lands first, stale whole-shard snapshot second
    await Promise.all([removeWrite, staleWrite]);
    backend.defer(false);
    await Promise.all([first.db.flush(), second.db.flush()]);

    assert.equal(first.db.isWatched(removedId), false);
    assert.equal(second.db.isWatched(removedId), false);
    const cleaned = backend.state['ytbWatchedShard' + shardOf(removedId)];
    assert.equal(cleaned.ids.includes(removedId), false);

    assert.equal(second.db.markWatched(removedId), true,
        'watching again must supersede the older remove operation');
    await second.db.flush();
    assert.equal(first.db.isWatched(removedId), true);
});

test('hidden-channel Undo converges against a stale channel snapshot', async () => {
    const backend = createSharedBackend();
    const first = createDbOnBackend(backend);
    const second = createDbOnBackend(backend);
    await Promise.all([first.db.whenReady(), second.db.whenReady()]);
    const channel = { handle: 'example', name: 'Example' };
    const id = 'hidden-undo';

    first.db.recordChannelHidden(channel, id);
    await first.db.flush();
    assert.equal(second.db.getChannelStats(channel).hidden, 1);

    backend.defer(true);
    first.db.removeHidden(id);
    second.db.setChannelTotal(channel, 12);
    const removeWrite = first.db.flush();
    const staleWrite = second.db.flush();
    backend.releaseWrites();
    await Promise.all([removeWrite, staleWrite]);
    backend.defer(false);
    await Promise.all([first.db.flush(), second.db.flush()]);

    assert.equal(first.db.getChannelStats(channel).hidden, 0);
    assert.equal(second.db.getChannelStats(channel).hidden, 0);
    first.db.recordChannelHidden(channel, id);
    await first.db.flush();
    assert.equal(second.db.getChannelStats(channel).hidden, 1);
});

test('clear blocks same-context mutations until its generation is durable', async () => {
    const backend = createSharedBackend();
    const harness = createDbOnBackend(backend);
    await harness.db.whenReady();
    harness.db.markWatched('before-barrier');
    await harness.db.flush();

    backend.defer(true);
    const clearing = harness.db.clear();
    assert.equal(backend.pendingCount(), 1);
    assert.equal(harness.db.markWatched('during-clear'), false);
    const flushing = harness.db.flush();
    backend.releaseWrites();
    backend.defer(false);
    await Promise.all([clearing, flushing]);

    assert.equal(harness.db.count(), 0);
    assert.equal(await harness.db.getStoredCount(), 0);
    const shardKeys = Object.keys(backend.state)
        .filter(key => key.startsWith('ytbWatchedShard'));
    assert.equal(shardKeys.length, 64);
    assert.equal(shardKeys.every(key => backend.state[key].ids.length === 0), true);
});

test('a superseded initial loader cannot erase marks made after clear', async () => {
    const backend = createSharedBackend();
    backend.deferRead(true);
    const harness = createDbOnBackend(backend);
    const oldLoad = harness.db.whenReady();
    assert.equal(backend.pendingReadCount(), 1);

    backend.deferRead(false);
    await harness.db.clear();
    assert.equal(harness.db.markWatched('post-clear-mark'), true);
    backend.releaseReads();
    await oldLoad;

    assert.equal(harness.db.isWatched('post-clear-mark'), true);
    assert.equal(harness.db.count(), 1);
    await harness.db.flush();
});
test('a failed superseded loader stops retrying after clear', async () => {
    const backend = createSharedBackend();
    backend.deferRead(true);
    const harness = createDbOnBackend(backend);
    const oldLoad = harness.db.whenReady();
    assert.equal(backend.pendingReadCount(), 1);

    backend.deferRead(false);
    await harness.db.clear();
    assert.equal(harness.db.markWatched('post-clear-after-error'), true);
    backend.rejectReads();
    await oldLoad;

    assert.equal(harness.db.isWatched('post-clear-after-error'), true);
    assert.equal(harness.db.count(), 1);
    await harness.db.flush();
});
test('an initial load re-reads when another tab writes after its snapshot', async () => {
    const backend = createSharedBackend();
    const writer = createDbOnBackend(backend);
    await writer.db.whenReady();

    backend.deferRead(true);
    const reader = createDbOnBackend(backend);
    const loading = reader.db.whenReady();
    assert.equal(backend.pendingReadCount(), 1);

    const firstId = 'during-load';
    writer.db.markWatched(firstId);
    await writer.db.flush();
    backend.deferRead(false);
    backend.releaseReads();
    await loading;
    assert.equal(reader.db.isWatched(firstId), true);

    const secondId = idInShardOf(firstId, 'reader-write');
    reader.db.markWatched(secondId);
    await reader.db.flush();
    const reloaded = createDbOnBackend(backend);
    await reloaded.db.whenReady();
    assert.equal(reloaded.db.isWatched(firstId), true);
    assert.equal(reloaded.db.isWatched(secondId), true);
});

test('startup storage churn re-reads without consuming the failure budget', async () => {
    const backend = createSharedBackend();
    backend.deferRead(true);
    const harness = createDbOnBackend(backend);
    const loading = harness.db.whenReady();
    assert.equal(backend.pendingReadCount(), 1);

    const ids = [];
    const usedShards = new Set();
    for (let i = 0; ids.length < 4; i++) {
        const id = 'load-churn-' + i;
        const shard = shardOf(id);
        if (usedShards.has(shard)) continue;
        usedShards.add(shard);
        ids.push(id);
        backend.emitItems({ ['ytbWatchedShard' + shard]: [id] });
        backend.releaseReads();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(backend.pendingReadCount(), 1,
            'each invalidated snapshot should be retried');
    }

    backend.deferRead(false);
    backend.releaseReads();
    await loading;
    ids.forEach(id => assert.equal(harness.db.isWatched(id), true));
});

test('simultaneous different-shard additions repair the persisted count', async () => {
    const backend = createSharedBackend();
    const first = createDbOnBackend(backend);
    const second = createDbOnBackend(backend);
    await Promise.all([first.db.whenReady(), second.db.whenReady()]);

    const firstId = 'different-A';
    let secondId = '';
    for (let i = 0; i < 10000; i++) {
        const candidate = 'different-B' + i;
        if (shardOf(candidate) !== shardOf(firstId)) { secondId = candidate; break; }
    }
    assert.ok(secondId);

    backend.defer(true);
    first.db.markWatched(firstId);
    second.db.markWatched(secondId);
    const firstWrite = first.db.flush();
    const secondWrite = second.db.flush();
    backend.releaseWrites();
    await Promise.all([firstWrite, secondWrite]);
    backend.defer(false);
    await Promise.all([first.db.flush(), second.db.flush()]);

    assert.equal(first.db.count(), 2);
    assert.equal(second.db.count(), 2);
    assert.equal(await first.db.getStoredCount(), 2);
});
test('watched remove and restore operations stay in bounded shards', async () => {
    const harness = createHarness();
    const db = harness.db;
    await db.whenReady();

    const ids = Array.from({ length: 512 },
        (_, i) => 'op-id-' + String(i).padStart(6, '0'));
    ids.forEach(id => assert.equal(db.markWatched(id), true));
    await db.flush();
    ids.forEach(id => assert.equal(db.remove(id), true));
    await db.flush();

    const operationKeys = Object.keys(harness.state)
        .filter(key => key.startsWith('ytbWatchedOpsShard'));
    assert.ok(operationKeys.length > 1 && operationKeys.length <= 64);
    const recordCounts = operationKeys
        .map(key => Object.keys(harness.state[key].ops).length);
    assert.equal(recordCounts.reduce((sum, count) => sum + count, 0), ids.length);
    assert.ok(Math.max(...recordCounts) < ids.length,
        'one Undo must not rewrite the complete operation history');
    assert.equal(harness.state.ytbWatchedOps, undefined,
        'watched operations must not recreate the legacy monolithic record');

    assert.equal(db.markWatched(ids[0]), true);
    await db.flush();
    const restored = harness.state['ytbWatchedOpsShard' + shardOf(ids[0])].ops[ids[0]];
    assert.equal(restored.p, 1);
});

test('legacy monolithic watched operations migrate before replacement', async () => {
    const id = 'legacy-remove';
    const harness = createHarness({
        ytbWatchedOps: {
            epoch: 0,
            watched: { [id]: { p: 0, t: 100, o: 'legacy-tab' } },
            hidden: {}
        },
        ['ytbWatchedShard' + shardOf(id)]: [id]
    });
    await harness.db.whenReady();

    assert.equal(harness.db.isWatched(id), false);
    await harness.db.flush();
    const migrated = harness.state['ytbWatchedOpsShard' + shardOf(id)];
    assert.equal(migrated.ops[id].p, 0);

    assert.equal(Object.hasOwn(harness.state.ytbWatchedOps, 'watched'), false,
        'the production migration must replace the v2 combined record');
    const reloaded = createHarness(harness.state);
    await reloaded.db.whenReady();
    assert.equal(reloaded.db.isWatched(id), false,
        'the migrated tombstone must survive removal of the v2 combined record');
});
test('a live v2 operation event migrates and replaces the combined record', async () => {
    const harness = createHarness();
    await harness.db.whenReady();
    const id = 'live-legacy-remove';

    harness.emitExternal({
        ytbWatchedOps: {
            newValue: {
                epoch: 0,
                watched: { [id]: { p: 0, t: 101, o: 'legacy-live-tab' } },
                hidden: {}
            }
        }
    });
    await harness.db.flush();

    assert.equal(harness.state['ytbWatchedOpsShard' + shardOf(id)].ops[id].p, 0);
    assert.equal(Object.hasOwn(harness.state.ytbWatchedOps, 'watched'), false);
});

test('a stale pre-clear write landing last is repaired in the current generation', async () => {
    const backend = createSharedBackend();
    const first = createDbOnBackend(backend);
    const second = createDbOnBackend(backend);
    await Promise.all([first.db.whenReady(), second.db.whenReady()]);

    const staleId = 'stale-before-clear';
    const currentId = idInShardOf(staleId, 'current-after-clear');
    backend.defer(true);
    first.db.markWatched(staleId);
    const staleWrite = first.db.flush();
    assert.equal(backend.pendingCount(), 1);

    backend.defer(false);
    await second.db.clear();
    assert.equal(second.db.markWatched(currentId), true);
    await second.db.flush();
    assert.equal(first.db.isWatched(currentId), true);

    backend.releaseWrites();
    await staleWrite;
    await Promise.all([first.db.flush(), second.db.flush()]);

    const stored = backend.state['ytbWatchedShard' + shardOf(currentId)];
    assert.equal(stored.epoch, backend.state.ytbWatchedEpoch);
    assert.deepEqual(Array.from(stored.ids), [currentId]);
    const reloaded = createDbOnBackend(backend);
    await reloaded.db.whenReady();
    assert.equal(reloaded.db.isWatched(staleId), false);
    assert.equal(reloaded.db.isWatched(currentId), true);
});

test('a delayed channel-only flush cannot leave the persisted count stale', async () => {
    const backend = createSharedBackend();
    const first = createDbOnBackend(backend);
    const second = createDbOnBackend(backend);
    await Promise.all([first.db.whenReady(), second.db.whenReady()]);

    first.db.markWatched('meta-base');
    await first.db.flush();
    backend.defer(true);
    first.db.setChannelTotal({ handle: 'meta-channel' }, 12);
    const staleChannelWrite = first.db.flush();
    assert.equal(backend.pendingCount(), 1);

    backend.defer(false);
    second.db.markWatched('meta-new');
    await second.db.flush();
    assert.equal(first.db.count(), 2);
    backend.releaseWrites();
    await staleChannelWrite;
    await Promise.all([first.db.flush(), second.db.flush()]);

    assert.equal(backend.state.ytbWatchedMeta.count, 2);
    assert.equal(await first.db.getStoredCount(), 2);
});

test('clear blocks mutations re-entered from its synchronous change event', async () => {
    const harness = createHarness();
    await harness.db.whenReady();
    harness.db.markWatched('before-reentrant-clear');
    await harness.db.flush();

    let accepted = null;
    harness.onDocumentChange(() => {
        accepted = harness.db.markWatched('reentrant-clear-mark');
    });
    await harness.db.clear();

    assert.equal(accepted, false);
    assert.equal(harness.db.isWatched('reentrant-clear-mark'), false);
    assert.equal(harness.db.count(), 0);
});

test('a distributed clear blocks mutations re-entered from the remote reset event', async () => {
    const backend = createSharedBackend();
    const first = createDbOnBackend(backend);
    const second = createDbOnBackend(backend);
    await Promise.all([first.db.whenReady(), second.db.whenReady()]);

    let accepted = null;
    second.onDocumentChange(() => {
        accepted = second.db.markWatched('remote-reentrant-clear-mark');
    });
    await first.db.clear();

    assert.equal(accepted, false);
    assert.equal(second.db.isWatched('remote-reentrant-clear-mark'), false);
    assert.equal(second.db.count(), 0);
    await second.db.flush();
    assert.equal(await second.db.getStoredCount(), 0);
});

test('a local clear supersedes a loader before its storage event lands', async () => {
    const backend = createSharedBackend({
        ytbWatchedShard0: ['old-snapshot-id']
    });
    backend.deferRead(true);
    const harness = createDbOnBackend(backend);
    const oldLoad = harness.db.whenReady();
    assert.equal(backend.pendingReadCount(), 1);

    backend.defer(true);
    const clearing = harness.db.clear();
    assert.equal(backend.pendingCount(), 1);
    backend.releaseReads();
    await oldLoad;
    assert.equal(harness.db.count(), 0);

    backend.releaseWrites();
    backend.defer(false);
    await clearing;
    assert.equal(harness.db.count(), 0);
});
