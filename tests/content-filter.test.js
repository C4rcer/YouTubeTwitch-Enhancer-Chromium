/* eslint-env node */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const CONTENT_PATH = path.join(__dirname, '..', 'src', 'content.js');

class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...names) { names.forEach(name => this.values.add(name)); }
    remove(...names) { names.forEach(name => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
}

class FakeAnchor {
    constructor(href, text, owner) {
        this.href = href;
        this.textContent = text || '';
        this.owner = owner;
        this.nodeType = 1;
        this.parentElement = owner;
    }
    getAttribute(name) { return name === 'href' ? this.href : null; }
    closest(selector) { return this.owner && this.owner.closest(selector); }
    matches() { return false; }
    querySelectorAll() { return []; }
}

class FakeText {
    constructor(text, title) {
        this.textContent = text || '';
        this.title = title || '';
    }
    getAttribute(name) { return name === 'title' ? this.title : null; }
}

class FakeTile {
    constructor(id, options = {}) {
        this.nodeType = 1;
        this.tag = options.tag || 'ytd-rich-item-renderer';
        this.classList = new FakeClassList();
        this.dataset = {};
        this.parentElement = null;
        this.queryCount = 0;
        this.title = options.title || 'Ordinary upload';
        this.channel = options.channel || 'Example Channel';
        this.handle = options.handle || 'example';
        this.progress = options.progress;
        this.isShort = !!options.isShort;
        this.isMix = !!options.isMix;
        this.isPlaylist = !!options.isPlaylist;
        this.isMembers = !!options.isMembers;
        this.isPaid = !!options.isPaid;
        this.setVideo(id);
    }

    setVideo(id) {
        this.id = id || '';
        this.videoAnchor = this.id ? new FakeAnchor('/watch?v=' + this.id, '', this) : null;
        this.channelAnchor = new FakeAnchor('/@' + this.handle, this.channel, this);
    }

    matches(selector) {
        return selector.split(',').some(part => part.trim().startsWith(this.tag));
    }

    closest(selector) {
        if (selector === '.ytb-removed') {
            return this.classList.contains('ytb-removed') ? this : null;
        }
        return selector.includes(this.tag) ? this : null;
    }

    querySelector(selector) {
        this.queryCount++;
        if (selector.includes('a[href*="/watch?v="]')) return this.videoAnchor;
        if (selector.includes('a[href*="/shorts/"]')) {
            return this.isShort ? new FakeAnchor('/shorts/' + this.id, '', this) : null;
        }
        if (selector.includes('a[href*="list=RD"]')) {
            return this.isMix ? new FakeAnchor('/watch?v=' + this.id + '&list=RDx', '', this) : null;
        }
        if (selector.includes('a[href^="/playlist?"]')) {
            return this.isPlaylist ? new FakeAnchor('/playlist?list=x', '', this) : null;
        }
        if (selector.includes('.badge-style-type-members-only')) {
            return this.isMembers ? new FakeText('Members only') : null;
        }
        if (selector.includes('#video-title')) return this.title ? new FakeText(this.title, this.title) : null;
        if (selector.includes('ytd-channel-name #text')) {
            return this.channel ? new FakeText(this.channel) : null;
        }
        return null;
    }

    querySelectorAll(selector) {
        this.queryCount++;
        if (selector === 'a[href]') {
            return [this.videoAnchor, this.channelAnchor].filter(Boolean);
        }
        if (selector === 'badge-shape.ytBadgeShapeCommerce') {
            return this.isPaid ? [{
                textContent: 'Pay to watch',
                getAttribute: name => name === 'aria-label' ? 'Pay to watch' : null
            }] : [];
        }
        if (selector.includes('ytd-badge-supported-renderer')) {
            return this.isMembers ? [new FakeText('Members only')] : [];
        }
        if (selector.includes('#progress') ||
            selector.includes('yt-thumbnail-overlay-progress-bar-view-model')) {
            return this.progress == null ? [] : [{ style: { width: this.progress + '%' } }];
        }
        if (selector.includes('.ytThumbnailOverlayProgressBarHostWatchedProgressBar')) return [];
        if (selector.includes('ytd-rich-item-renderer')) return [];
        return [];
    }
}

class FakeRoot {
    constructor(children) {
        this.nodeType = 1;
        this.children = children;
        this.parentElement = null;
    }
    closest() { return null; }
    matches() { return false; }
    querySelectorAll(selector) {
        return selector.includes('ytd-rich-item-renderer') ? this.children : [];
    }
}

function loadContentHarness(watched, options = {}) {
    const listeners = {};
    const windowListeners = {};
    const postedMessages = [];
    const elements = new Map();
    let nextTimeoutId = 1;
    const timeouts = new Map();
    const watchTitle = options.watchTitle || null;
    const flexyData = options.flexyData || null;
    const watchFlexy = flexyData ? {
        getAttribute(name) { return name === 'video-id' ? flexyData.videoId : null; }
    } : null;
    const rootAttributes = new Map();
    const documentElement = {
        dataset: {},
        setAttribute(name, value) { rootAttributes.set(name, value); },
        getAttribute(name) { return rootAttributes.get(name) || null; },
        removeAttribute(name) { rootAttributes.delete(name); }
    };
    const document = {
        documentElement,
        hidden: false,
        body: new FakeRoot([]),
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        dispatchEvent() { return true; },
        querySelector(selector) {
            if (watchTitle && selector.includes('ytd-watch-metadata h1')) return watchTitle;
            if (watchFlexy && selector === 'ytd-watch-flexy[video-id]') return watchFlexy;
            return null;
        },
        querySelectorAll() { return []; },
        getElementById(id) { return elements.get(id) || null; }
    };

    let revision = 0;
    const watchedDb = {
        isWatched: id => watched.has(id),
        count: () => watched.size,
        revision: () => revision,
        markWatched(id) {
            if (watched.has(id)) return false;
            watched.add(id);
            revision++;
            return true;
        },
        recordChannelVideo() {},
        recordChannelHidden() {},
        removeHidden() {}
    };
    const noopListener = { addListener() {} };
    const context = {
        browser: {
            runtime: { onMessage: noopListener },
            storage: { onChanged: noopListener }
        },
        document,
        location: { pathname: '/', search: '', href: 'https://www.youtube.com/', origin: 'https://www.youtube.com' },
        console,
        URL,
        URLSearchParams,
        Math,
        Date,
        Set,
        WeakMap,
        Promise,
        CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
        setTimeout(fn) {
            const id = nextTimeoutId++;
            timeouts.set(id, fn);
            return id;
        },
        clearTimeout(id) { timeouts.delete(id); },
        setInterval: () => 1,
        clearInterval() {},
        requestAnimationFrame() {},
        addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) {
            windowListeners[type] = (windowListeners[type] || []).filter(item => item !== fn);
        },
        postMessage(message, origin) { postedMessages.push({ message, origin }); },
        confirm: () => true,
        YTBWatchedDB: watchedDb
    };
    context.self = context;
    context.window = context;

    let source = fs.readFileSync(CONTENT_PATH, 'utf8');
    const hook = `
    self.__YTB_FILTER_TEST__ = {
        filterMutatedTiles,
        processTiles(tiles, force = true) { processTiles(new Set(tiles), force, false); },
        processLegacyMutationFilters,
        prepareDeArrowTitleIdentity,
        applyDeArrowTitle,
        processDeArrowWatchPage,
        beginDeArrowWatchNavigation,
        finishDeArrowWatchNavigation,
        refreshDeArrowWatchTitle,
        setDeArrowCache(vid, value) { deCache.set(vid, value); },
        completeWatchPlayerData(token, requestedVid, videoId, title) {
            onPageQualityMessage({
                source: window,
                data: {
                    type: 'ytb-video-data', token, requestedVid, videoId, title
                }
            });
        },
        mutationNeedsMaintenance,
        applyMaxQuality,
        setPlaybackRate,
        preventIdlePause,
        completeMaxQuality(vid) {
            onPageQualityMessage({
                source: window,
                data: { type: 'ytb-max-quality-done', vid }
            });
        },
        setPath(path) {
            const url = new URL(path, location.origin);
            location.pathname = url.pathname;
            location.search = url.search;
            location.href = url.href;
        },
        setLocationSearch(search) {
            location.search = search;
            location.href = location.origin + location.pathname + search;
        },
        configure(input) {
            state = normalize(input || {});
            settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
            hiddenSet = new Set(state.hiddenVideoIds);
            blockedIndex = { handles: new Set(), ids: new Set(), names: new Set() };
            for (const channel of state.blockedChannels) {
                if (channel.handle) blockedIndex.handles.add(channel.handle.toLowerCase());
                if (channel.channelId) blockedIndex.ids.add(channel.channelId);
                if (channel.name) blockedIndex.names.add(channel.name.toLowerCase().trim());
            }
            keywordMatchers = compileMatcherList(state.blockedKeywords);
            curChannelInfo = null;
            configVersion++;
            tileCache = new WeakMap();
        }
    };
`;
    const marker = /    init\(\);\r?\n\}\)\(\);\s*$/;
    assert.match(source, marker, 'content test hook marker must stay stable');
    source = source.replace(marker, hook + '})();');

    vm.createContext(context);
    vm.runInContext(source, context, { filename: CONTENT_PATH });
    return Object.assign(context.__YTB_FILTER_TEST__, {
        postedMessages,
        runLatestTimeout() {
            const ids = Array.from(timeouts.keys());
            const id = ids[ids.length - 1];
            assert.ok(id, 'expected a scheduled timeout');
            const fn = timeouts.get(id);
            timeouts.delete(id);
            fn();
        },
        setElement(id, element) {
            if (element == null) elements.delete(id);
            else elements.set(id, element);
        },
        emitWindowMessage(data) {
            (windowListeners.message || []).forEach(fn => fn({ source: context.window, data }));
        }
    });
}

function childListRecord(root) {
    return { type: 'childList', target: root, addedNodes: [root], removedNodes: [] };
}

test('Chromium max-quality bridge posts once and accepts MAIN-world completion', () => {
    const h = loadContentHarness(new Set());
    h.setPath('/watch');
    h.setLocationSearch('?v=bridge123');
    h.setElement('movie_player', {});
    h.applyMaxQuality();

    assert.equal(h.postedMessages.length, 1);
    assert.equal(h.postedMessages[0].message.type, 'ytb-max-quality');
    assert.equal(h.postedMessages[0].message.vid, 'bridge123');

    h.completeMaxQuality('bridge123');
    h.applyMaxQuality();
    assert.equal(h.postedMessages.length, 1, 'completed video should not be requested again');
});

test('Chromium playback-rate and idle-timer bridges relay to the MAIN world', () => {
    const h = loadContentHarness(new Set());
    h.setPath('/watch');
    h.setElement('movie_player', {});
    const video = { playbackRate: 1 };

    h.setPlaybackRate(video, 1.75);
    h.preventIdlePause();

    assert.equal(video.playbackRate, 1.75);
    assert.equal(h.postedMessages.length, 2);
    assert.equal(h.postedMessages[0].message.type, 'ytb-set-rate');
    assert.equal(h.postedMessages[0].message.rate, 1.75);
    assert.equal(h.postedMessages[1].message.type, 'ytb-lact');
});
test('600-card batches are filtered synchronously and later appends stay incremental', () => {
    const watched = new Set();
    const cards = [];
    for (let i = 0; i < 600; i++) {
        const id = 'video' + String(i).padStart(5, '0');
        if (i < 450) watched.add(id);
        cards.push(new FakeTile(id));
    }

    const api = loadContentHarness(watched);
    api.configure({
        settings: {
            enabled: true,
            blockShorts: false,
            hideWatched: true,
            watchedHome: true,
            reduceFlashing: true
        }
    });

    const root = new FakeRoot(cards);
    api.filterMutatedTiles([childListRecord(root)]);

    assert.equal(cards.filter(card => card.classList.contains('ytb-removed')).length, 450);
    assert.equal(cards.filter(card => card.classList.contains('ytb-filter-pending')).length, 0);
    assert.equal(cards[0].dataset.ytbFilterReason, 'watched-history');
    assert.equal(cards[599].dataset.ytbFilterReason, undefined);

    const originalQueries = cards.reduce((sum, card) => sum + card.queryCount, 0);
    const appended = Array.from({ length: 24 }, (_, i) => {
        const id = 'append' + String(i).padStart(5, '0');
        if (i % 2 === 0) watched.add(id);
        return new FakeTile(id);
    });
    api.filterMutatedTiles([childListRecord(new FakeRoot(appended))]);

    assert.equal(appended.filter(card => card.classList.contains('ytb-removed')).length, 12);
    assert.equal(cards.reduce((sum, card) => sum + card.queryCount, 0), originalQueries,
        'dirty-card filtering must not revisit the original 600 cards');
});

test('recycled renderers and incomplete shells are re-evaluated by identity', () => {
    const watched = new Set(['watched00001']);
    const api = loadContentHarness(watched);
    api.configure({
        blockedKeywords: ['spoiler'],
        settings: {
            enabled: true,
            blockShorts: false,
            hideWatched: true,
            watchedHome: true,
            reduceFlashing: true
        }
    });

    const recycled = new FakeTile('watched00001');
    api.filterMutatedTiles([childListRecord(new FakeRoot([recycled]))]);
    assert.equal(recycled.classList.contains('ytb-removed'), true);

    recycled.setVideo('fresh0000001');
    api.filterMutatedTiles([{
        type: 'attributes',
        target: recycled.videoAnchor,
        addedNodes: [],
        removedNodes: []
    }]);
    assert.equal(recycled.classList.contains('ytb-removed'), false,
        'a reused DOM card must not retain the previous video reason');

    const shell = new FakeTile('', { title: '' });
    api.filterMutatedTiles([childListRecord(new FakeRoot([shell]))]);
    assert.equal(shell.classList.contains('ytb-removed'), false);

    shell.setVideo('spoiler00001');
    shell.title = 'A spoiler appears';
    api.filterMutatedTiles([{
        type: 'childList',
        target: shell,
        addedNodes: [],
        removedNodes: []
    }]);
    assert.equal(shell.classList.contains('ytb-removed'), true,
        'an incomplete shell must not be frozen in the cache before hydration');
    assert.equal(shell.dataset.ytbFilterReason, 'blocked-keyword');
});

test('progress, channel, keyword, Shorts, members, and paid reasons keep precedence', () => {
    const watched = new Set();
    const api = loadContentHarness(watched);
    api.configure({
        blockedChannels: [{ handle: 'blocked' }],
        blockedKeywords: ['spoiler'],
        settings: {
            enabled: true,
            blockShorts: true,
            hideWatched: true,
            watchedThreshold: 90,
            watchedHome: true,
            reduceFlashing: true,
            hideMembersOnly: true,
            hidePaidVideos: true
        }
    });

    const cards = [
        new FakeTile('progress0001', { progress: 95 }),
        new FakeTile('channel00001', { handle: 'blocked', channel: 'Blocked' }),
        new FakeTile('keyword00001', { title: 'Spoiler inside' }),
        new FakeTile('shorts000001', { isShort: true }),
        new FakeTile('members0001', { isMembers: true }),
        new FakeTile('paid00000001', { isPaid: true }),
        new FakeTile('keep00000001')
    ];
    api.filterMutatedTiles([childListRecord(new FakeRoot(cards))]);

    assert.deepEqual(cards.map(card => card.dataset.ytbFilterReason || ''), [
        'watched-progress',
        'blocked-channel',
        'blocked-keyword',
        'shorts',
        'members-only',
        'paid',
        ''
    ]);
});
test('text-only hydration reclassifies a cached card before paint', () => {
    const api = loadContentHarness(new Set());
    api.configure({
        blockedKeywords: ['spoiler'],
        settings: {
            enabled: true,
            blockShorts: false,
            hideWatched: false,
            reduceFlashing: true
        }
    });

    const card = new FakeTile('samevideo01', { title: 'Safe title' });
    api.filterMutatedTiles([childListRecord(new FakeRoot([card]))]);
    assert.equal(card.classList.contains('ytb-removed'), false);

    card.title = 'Spoiler arrives after hydration';
    api.filterMutatedTiles([{
        type: 'characterData',
        target: { nodeType: 3, parentElement: card }
    }]);
    assert.equal(card.classList.contains('ytb-removed'), true);
    assert.equal(card.dataset.ytbFilterReason, 'blocked-keyword');
});

test('leaving an enabled watched surface releases only filter-managed cards', () => {
    const watched = new Set(['routevideo01']);
    const api = loadContentHarness(watched);
    api.configure({
        settings: {
            enabled: true,
            blockShorts: false,
            hideWatched: true,
            watchedHome: true,
            watchedPlaylists: false,
            reduceFlashing: true
        }
    });

    const card = new FakeTile('routevideo01');
    api.filterMutatedTiles([childListRecord(new FakeRoot([card]))]);
    assert.equal(card.classList.contains('ytb-removed'), true);

    api.setPath('/playlist?list=example');
    api.processTiles([card]);
    assert.equal(card.classList.contains('ytb-removed'), false);
    assert.equal(card.dataset.ytbFilterReason, undefined);
});

test('playlist and radio renderer shells are hidden in the synchronous pass', () => {
    const api = loadContentHarness(new Set());
    api.configure({
        settings: {
            enabled: true,
            blockShorts: false,
            hideWatched: false,
            hidePlaylists: true,
            reduceFlashing: true
        }
    });

    const playlist = new FakeTile('playlist0001', { tag: 'ytd-playlist-renderer' });
    const radio = new FakeTile('radio0000001', { tag: 'ytd-radio-renderer' });
    api.filterMutatedTiles([childListRecord(new FakeRoot([playlist, radio]))]);

    assert.deepEqual([playlist, radio].map(card => card.dataset.ytbFilterReason), [
        'playlist',
        'playlist'
    ]);
    assert.equal(playlist.classList.contains('ytb-filter-pending'), false);
    assert.equal(radio.classList.contains('ytb-filter-pending'), false);
});
test('late style hydration hides watched progress in the mutation pass', () => {
    const api = loadContentHarness(new Set());
    api.configure({
        settings: {
            enabled: true,
            blockShorts: false,
            hideWatched: true,
            watchedThreshold: 90,
            watchedHome: true,
            reduceFlashing: true
        }
    });

    const card = new FakeTile('latewidth001');
    api.filterMutatedTiles([childListRecord(new FakeRoot([card]))]);
    assert.equal(card.classList.contains('ytb-removed'), false);

    card.progress = 96;
    api.filterMutatedTiles([{
        type: 'attributes',
        attributeName: 'style',
        target: card
    }]);
    assert.equal(card.classList.contains('ytb-removed'), true);
    assert.equal(card.dataset.ytbFilterReason, 'watched-progress');
});

test('cached decisions repair managed classes without re-querying a card', () => {
    const watched = new Set(['repaircard01']);
    const api = loadContentHarness(watched);
    api.configure({
        settings: {
            enabled: true,
            blockShorts: false,
            hideWatched: true,
            watchedHome: true,
            reduceFlashing: true
        }
    });

    const card = new FakeTile('repaircard01');
    api.filterMutatedTiles([childListRecord(new FakeRoot([card]))]);
    const queries = card.queryCount;
    card.classList.remove('ytb-removed');
    delete card.dataset.ytbFilterReason;

    api.processTiles([card], false);
    assert.equal(card.classList.contains('ytb-removed'), true);
    assert.equal(card.dataset.ytbFilterReason, 'watched-history');
    assert.equal(card.queryCount, queries + 1,
        'only the video identity lookup should run on a cache hit');
});

test('tile-only mutations do not queue full-page maintenance', () => {
    const api = loadContentHarness(new Set());
    const card = new FakeTile('incremental01');
    assert.equal(api.mutationNeedsMaintenance([{
        type: 'childList',
        target: new FakeRoot([card]),
        addedNodes: [card],
        removedNodes: []
    }]), false);
    assert.equal(api.mutationNeedsMaintenance([{
        type: 'attributes',
        attributeName: 'style',
        target: card
    }]), false);

    const detachedChild = {
        nodeType: 1,
        parentElement: null,
        closest() { return null; },
        matches() { return false; },
        querySelector() { return null; }
    };
    assert.equal(api.mutationNeedsMaintenance([{
        type: 'childList',
        target: card,
        addedNodes: [],
        removedNodes: [detachedChild]
    }]), false, 'a detached child from a live card must stay on the tile-only path');

    const richShelf = new FakeTile('', { tag: 'ytd-rich-section-renderer' });
    assert.equal(api.mutationNeedsMaintenance([{
        type: 'childList',
        target: new FakeRoot([richShelf]),
        addedNodes: [richShelf],
        removedNodes: []
    }]), true, 'rich shelves and promo containers still need the legacy cleanup pass');
});

test('legacy shelf filtering scans only newly inserted subtrees', () => {
    const api = loadContentHarness(new Set());
    api.configure({ settings: { enabled: true } });

    let targetScans = 0;
    let addedScans = 0;
    const target = {
        nodeType: 1,
        parentElement: null,
        matches() { return false; },
        closest() { return null; },
        querySelectorAll() { targetScans++; return []; }
    };
    const added = {
        nodeType: 1,
        parentElement: target,
        matches() { return false; },
        closest() { return null; },
        querySelectorAll() { addedScans++; return []; }
    };

    api.processLegacyMutationFilters([{
        type: 'childList',
        target,
        addedNodes: [added],
        removedNodes: []
    }]);

    assert.equal(targetScans, 0,
        'an append must not rescan the existing 500-card contents subtree');
    assert.equal(addedScans, 1);
});
class FakeDecoratedText {
    constructor(text) {
        this.textContent = text;
        this.dataset = {};
        this.attributes = new Map();
    }
    dataKey(name) {
        return name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    }
    hasAttribute(name) {
        if (name.startsWith('data-')) return Object.hasOwn(this.dataset, this.dataKey(name));
        return this.attributes.has(name);
    }
    getAttribute(name) {
        if (name.startsWith('data-')) {
            const value = this.dataset[this.dataKey(name)];
            return value == null ? null : String(value);
        }
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    setAttribute(name, value) {
        if (name.startsWith('data-')) this.dataset[this.dataKey(name)] = String(value);
        else this.attributes.set(name, String(value));
    }
    removeAttribute(name) {
        if (name.startsWith('data-')) delete this.dataset[this.dataKey(name)];
        else this.attributes.delete(name);
    }
    querySelector() { return null; }
    matches() { return false; }
    closest() { return null; }
}

test('DeArrow originals follow video identity and native rehydration', () => {
    const api = loadContentHarness(new Set());
    const title = new FakeDecoratedText('Native A');

    api.applyDeArrowTitle(title, 'video-a', 'Community A', title);
    assert.equal(title.textContent, 'Community A');
    assert.equal(title.dataset.ytbDeOriginalTitle, 'Native A');
    assert.equal(title.dataset.ytbDeOriginalTitleVideo, 'video-a');

    title.textContent = 'Native A rehydrated';
    api.applyDeArrowTitle(title, 'video-a', 'Community A', title);
    assert.equal(title.textContent, 'Community A');
    assert.equal(title.dataset.ytbDeOriginalTitle, 'Native A rehydrated',
        'same-video native hydration must refresh the value restored later');

    assert.equal(api.prepareDeArrowTitleIdentity(title, 'video-b'), false);
    assert.equal(title.textContent, 'Community A',
        'an ambiguous equal value stays untouched until video B hydrates');
    assert.equal(title.dataset.ytbDeTitle, undefined);
    assert.equal(title.dataset.ytbDeAwaitTitle, 'video-b');

    api.applyDeArrowTitle(title, 'video-b', 'Community B', title);
    assert.equal(title.textContent, 'Community A',
        'a new community title must wait for the recycled card to hydrate');

    title.textContent = 'Native B';
    api.applyDeArrowTitle(title, 'video-b', 'Community B', title);
    assert.equal(title.textContent, 'Community B');
    assert.equal(title.dataset.ytbDeOriginalTitle, 'Native B');
    assert.equal(title.dataset.ytbDeOriginalTitleVideo, 'video-b');

    const alreadyHydrated = new FakeDecoratedText('Native A');
    api.applyDeArrowTitle(alreadyHydrated, 'video-a', 'Community A', alreadyHydrated);
    alreadyHydrated.textContent = 'Native B already present';
    assert.equal(
        api.prepareDeArrowTitleIdentity(alreadyHydrated, 'video-b'),
        true,
        'a same-batch href/title update is already ready for video B'
    );
    assert.equal(alreadyHydrated.textContent, 'Native B already present',
        'recycling must never overwrite an already-hydrated B title with A');
    api.applyDeArrowTitle(alreadyHydrated, 'video-b', 'Community B', alreadyHydrated);
    assert.equal(alreadyHydrated.dataset.ytbDeOriginalTitle, 'Native B already present');
});

test('watch-page DeArrow repairs a stale SPA title through the Chromium player bridge', () => {
    const title = new FakeDecoratedText('Native A');
    const flexyData = { videoId: 'video-a' };
    const api = loadContentHarness(
        new Set(), { watchTitle: title, flexyData }
    );
    api.setElement('movie_player', {});

    api.configure({ settings: { enabled: true, deArrowTitles: true } });
    api.setPath('/watch?v=video-a');
    api.setDeArrowCache('video-a', { title: 'Community A' });
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Community A');

    const playerRequests = () => api.postedMessages.filter(
        item => item.message.type === 'ytb-get-video-data'
    );
    assert.equal(playerRequests().length, 1);
    assert.equal(playerRequests()[0].message.vid, 'video-a');
    api.processDeArrowWatchPage();
    assert.equal(playerRequests().length, 1,
        'a pending MAIN-world read must not be posted twice');

    api.setPath('/watch?v=video-b');
    api.setDeArrowCache('video-b', {});
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Community A',
        'flexy A must block route B from mutating A ownership');
    assert.equal(playerRequests().length, 1);

    flexyData.videoId = 'video-b';
    api.refreshDeArrowWatchTitle();
    assert.equal(title.textContent, 'Community A');
    assert.equal(playerRequests().length, 2);
    const firstBRequest = playerRequests()[1].message;

    api.completeWatchPlayerData(
        firstBRequest.token, 'video-b', 'video-a', 'Native A'
    );
    assert.equal(title.textContent, 'Community A');
    assert.equal(playerRequests().length, 2,
        'a mismatched reply must not start a request/response loop');

    api.runLatestTimeout();
    assert.equal(playerRequests().length, 3);
    const currentBRequest = playerRequests()[2].message;
    assert.notEqual(currentBRequest.token, firstBRequest.token);

    api.completeWatchPlayerData(
        firstBRequest.token, 'video-b', 'video-b', 'Ignored Native B'
    );
    assert.equal(title.textContent, 'Community A',
        'a superseded bridge reply must be ignored');

    api.completeWatchPlayerData(
        currentBRequest.token, 'video-b', 'video-b', 'Native B'
    );
    assert.equal(title.textContent, 'Native B',
        'verified player data must release stale A without a B replacement');
    assert.equal(title.dataset.ytbDeTitle, undefined);
    assert.equal(title.dataset.ytbDeAppliedTitle, undefined);
    assert.equal(title.dataset.ytbDeAwaitTitle, undefined);
    assert.equal(title.dataset.ytbDeStaleTitle, undefined);

    api.setDeArrowCache('video-b', { title: 'Community B' });
    api.refreshDeArrowWatchTitle();

    assert.equal(title.textContent, 'Community B');
    assert.equal(title.dataset.ytbDeOriginalTitle, 'Native B');
    assert.equal(title.dataset.ytbDeOriginalTitleVideo, 'video-b');
    assert.equal(title.dataset.ytbDeAwaitTitle, undefined);
    assert.equal(playerRequests().length, 3,
        'cached matching player data must suppress another bridge read');

    const stalledTitle = new FakeDecoratedText('Stale A');
    const stalledFlexy = { videoId: 'video-b' };
    const stalled = loadContentHarness(
        new Set(), { watchTitle: stalledTitle, flexyData: stalledFlexy }
    );
    stalled.setElement('movie_player', {});
    stalled.configure({ settings: { enabled: true, deArrowTitles: true } });
    stalled.setPath('/watch?v=video-b');
    stalled.setDeArrowCache('video-b', {});
    stalled.processDeArrowWatchPage();
    const stalledRequests = () => stalled.postedMessages.filter(
        item => item.message.type === 'ytb-get-video-data'
    );
    assert.equal(stalledRequests().length, 1);

    for (let attempt = 0; attempt < 12; attempt++) {
        const request = stalledRequests()[stalledRequests().length - 1].message;
        stalled.completeWatchPlayerData(
            request.token, 'video-b', 'video-a', 'Stale A'
        );
        stalled.runLatestTimeout();
    }
    const exhaustedRequestCount = stalledRequests().length;
    stalled.processDeArrowWatchPage();
    assert.equal(stalledRequests().length, exhaustedRequestCount,
        'the bounded retry budget must enter cooldown after exhaustion');
});

test('watch-page DeArrow preserves early native hydration during navigation', () => {
    const title = new FakeDecoratedText('Native A');
    const flexyData = { videoId: 'video-a' };
    const api = loadContentHarness(
        new Set(), { watchTitle: title, flexyData }
    );
    api.setElement('movie_player', {});

    api.configure({ settings: { enabled: true, deArrowTitles: true } });
    api.setPath('/watch?v=video-a');
    api.setDeArrowCache('video-a', { title: 'Community A' });
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Community A');

    api.beginDeArrowWatchNavigation();
    title.textContent = 'Native B';
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Native B',
        'a route-A maintenance pass must not rewrite A over early B hydration');

    api.setPath('/watch?v=video-b');
    flexyData.videoId = 'video-b';
    api.setDeArrowCache('video-b', { title: 'Community B' });
    api.finishDeArrowWatchNavigation();
    api.refreshDeArrowWatchTitle();

    assert.equal(title.textContent, 'Community B');
    assert.equal(title.dataset.ytbDeOriginalTitle, 'Native B');
    assert.equal(title.dataset.ytbDeOriginalTitleVideo, 'video-b');
    assert.ok(api.postedMessages.some(item =>
        item.message.type === 'ytb-get-video-data' && item.message.vid === 'video-b'
    ));
});
