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
        this.paidText = options.paidText || 'Pay to watch';
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
        if (selector === 'ytd-browse') return this.browseEl || null;
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
            const paidText = this.paidText;
            return this.isPaid ? [{
                textContent: paidText,
                getAttribute: name => name === 'aria-label' ? paidText : null
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
    // Simulates YouTube's SPA page cache: a hidden ytd-browse for a channel
    // page the user already left, still in the DOM with its header intact.
    const staleChannelDom = options.staleChannelDom ? {
        browse: {},
        canonical: { getAttribute: () => 'https://www.youtube.com/channel/UCstale0000000000000000' },
        header: {
            textContent: 'stalechan @stalechan 1M subscribers 514 videos',
            querySelector(sel) {
                if (sel === 'a[href^="/@"]') return { getAttribute: () => '/@stalechan' };
                if (sel.includes('yt-content-metadata-view-model')) {
                    return { textContent: '@stalechan • 514 videos' };
                }
                return null;
            }
        }
    } : null;
    const watchTitle = options.watchTitle || null;
    // Optional mini-dom document: answers whatever the stubs below don't.
    const dom = options.dom || null;
    const flexyData = options.flexyData || null;
    // Tests that pass playerData exercise the direct player path (a browser
    // exposing the page-world API); bridge tests use setElement + messages.
    const playerData = options.playerData || null;
    if (playerData) {
        elements.set('movie_player', {
            getVideoData() { return playerData; }
        });
    }
    if (options.player) elements.set('movie_player', options.player);
    // Page-world listeners a test attaches (attachPageWorld): they receive the
    // events content.js dispatches on document, as the shared DOM delivers them.
    const pageListeners = {};
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
        removeEventListener(type, fn) {
            listeners[type] = (listeners[type] || []).filter(item => item !== fn);
        },
        dispatchEvent(event) {
            (pageListeners[event.type] || []).forEach(fn => fn(event));
            return true;
        },
        querySelector(selector) {
            if (watchTitle && selector.includes('ytd-watch-metadata h1')) return watchTitle;
            if (watchFlexy && selector === 'ytd-watch-flexy[video-id]') return watchFlexy;
            if (staleChannelDom) {
                if (selector === 'ytd-browse[page-subtype="channels"]:not([hidden])') return null;
                if (selector === 'ytd-browse[page-subtype="channels"]') return staleChannelDom.browse;
                if (selector.includes('yt-page-header-renderer')) return staleChannelDom.header;
                if (selector.includes('link[rel="canonical"]')) return staleChannelDom.canonical;
            }
            return dom ? dom.querySelector(selector) : null;
        },
        querySelectorAll(selector) { return dom ? dom.querySelectorAll(selector) : []; },
        getElementById(id) { return elements.get(id) || null; },
        createElement: tag => new (require('./mini-dom').MiniElement)(tag)
    };

    let revision = 0;
    const channelAttributions = [];
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
        recordChannelVideo(info, id) { channelAttributions.push({ info, id }); },
        recordChannelHidden() {},
        removeHidden() {}
    };
    const noopListener = { addListener() {} };
    // Optional storage.local: each call settles a tick later, so two saves
    // that are not serialized would interleave their reads and writes.
    const storage = options.storage || null;
    const local = storage ? {
        async get(keys) {
            await null;
            const list = typeof keys === 'string' ? [keys] : keys;
            return Object.fromEntries(list.map(key => [key, structuredClone(storage.values[key])]));
        },
        async set(items) {
            await null;
            storage.writes.push(Object.keys(items));
            Object.assign(storage.values, structuredClone(items));
        }
    } : undefined;
    // MutationObserver stand-in: mutate(target, attributeName) delivers a
    // record to every observer watching that target.
    const observers = [];
    class FakeMutationObserver {
        constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
        observe(target) { this.targets.add(target); }
        disconnect() { this.targets.clear(); }
    }
    const mutate = (target, attributeName) => observers
        .filter(observer => observer.targets.has(target))
        .forEach(observer => observer.callback([{ type: 'attributes', target, attributeName }]));
    const context = {
        browser: {
            runtime: { onMessage: noopListener },
            storage: { onChanged: noopListener, local }
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
        MutationObserver: FakeMutationObserver,
        YTBWatchedDB: watchedDb,
        YTBFeatures: storage ? require('../src/feature-core.js') : undefined
    };
    context.self = context;
    context.window = context;

    let source = fs.readFileSync(CONTENT_PATH, 'utf8');
    const hook = `
    self.__YTB_FILTER_TEST__ = {
        filterMutatedTiles,
        isPaidBadgeText,
        processTiles(tiles, force = true) { processTiles(new Set(tiles), force, false); },
        processLegacyMutationFilters,
        removeShortsSurfaces,
        getTitleFromNode,
        deTitleTarget,
        getState() { return state; },
        getSettings() { return settings; },
        rebuildDerived,
        setVolumeBoost,
        rememberHiddenVideo,
        saveOnly,
        spyRunAll() {
            let calls = 0;
            runAll = () => { calls++; };
            return () => calls;
        },
        isPendingWhileHidden() { return pendingWhileHidden; },
        applyRydTo,
        processRyd,
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
        getChannelInfoFromChannelPage,
        parseVideoCountText,
        setCurrentChannel(info) { curChannelInfo = info; },
        applyMaxQuality,
        applyDefaultSpeed,
        ensureWatchedHook,
        setPlaybackRate,
        preventIdlePause,
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
        channelAttributions,
        postedMessages,
        fire: (type, detail) => (listeners[type] || []).forEach(fn => fn({ type, detail })),
        setHidden: value => { document.hidden = value; },
        mutate,
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
        },
        addPageListener(type, fn) { (pageListeners[type] ||= []).push(fn); }
    });
}

// Runs the real MAIN-world helper beside content.js: pagePlayer is the page
// world's view of #movie_player (with its API), the harness player is the
// isolated world's view (without it). Events cross both ways through document.
function attachPageWorld(api, pagePlayer) {
    const context = {
        console,
        Date,
        JSON,
        location: { origin: 'https://www.youtube.com' },
        CustomEvent: class CustomEvent {
            constructor(type, init) { this.type = type; this.detail = init && init.detail; }
        },
        document: {
            getElementById: id => (id === 'movie_player' ? pagePlayer : null),
            addEventListener: (type, fn) => api.addPageListener(type, fn),
            dispatchEvent(event) { api.fire(event.type, event.detail); return true; }
        },
        addEventListener() {}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page-quality.js'), 'utf8'), context);
}

function childListRecord(root) {
    return { type: 'childList', target: root, addedNodes: [root], removedNodes: [] };
}

test('Chromium max-quality bridge asks the MAIN world on every pass', () => {
    const h = loadContentHarness(new Set());
    h.setPath('/watch');
    h.setLocationSearch('?v=bridge123');
    h.setElement('movie_player', {});
    h.applyMaxQuality();
    h.applyMaxQuality();

    // page-quality.js keeps the per-video state, so the request repeats:
    // a single early answer was undone by YouTube's reset after navigation.
    assert.equal(h.postedMessages.length, 2);
    assert.equal(h.postedMessages[0].message.type, 'ytb-max-quality');
    assert.equal(h.postedMessages[0].message.vid, 'bridge123');
    assert.equal(h.postedMessages[1].message.vid, 'bridge123');
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

test('watch-page DeArrow releases a reused heading across later navigations', () => {
    const title = new FakeDecoratedText('Native A');
    const playerData = { video_id: 'video-a', title: 'Native A' };
    const flexyData = { videoId: 'video-a' };
    const api = loadContentHarness(
        new Set(), { watchTitle: title, playerData, flexyData }
    );

    api.configure({ settings: { enabled: true, deArrowTitles: true } });
    api.setPath('/watch?v=video-a');
    api.setDeArrowCache('video-a', { title: 'Community A' });
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Community A');

    // End-screen click to video B (no community title). Firefox reuses the
    // heading unhydrated; the repair path recovers B's native title.
    api.setPath('/watch?v=video-b');
    flexyData.videoId = 'video-b';
    playerData.video_id = 'video-b';
    playerData.title = 'Native B';
    api.setDeArrowCache('video-b', {});
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Native B');

    // B finishes; an end-screen click to video C (also without a community
    // title) reuses the unhydrated heading again. No replacement markers are
    // left after the repair, so staleness must be detected from our own last
    // write or B's title persists under video C forever.
    api.setPath('/watch?v=video-c');
    flexyData.videoId = 'video-c';
    playerData.video_id = 'video-c';
    playerData.title = 'Native C';
    api.setDeArrowCache('video-c', {});
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Native C',
        'a repaired heading reused by a later navigation must be released');

    // A later hop with a community title must release the repaired text first
    // so the recorded original belongs to the new video.
    api.setPath('/watch?v=video-d');
    flexyData.videoId = 'video-d';
    playerData.video_id = 'video-d';
    playerData.title = 'Native D';
    api.setDeArrowCache('video-d', { title: 'Community D' });
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Community D');
    assert.equal(title.dataset.ytbDeOriginalTitle, 'Native D');
    assert.equal(title.dataset.ytbDeOriginalTitleVideo, 'video-d');
});

class FakeHeadingText {
    constructor(text) {
        this.nodeType = 3;
        this.text = text;
    }
    get textContent() { return this.text; }
}

class FakeHeading extends FakeDecoratedText {
    constructor(text) {
        super('');
        this.childNodes = [new FakeHeadingText(text)];
    }
    get textContent() {
        return this.childNodes.map(node => node.textContent).join('');
    }
    set textContent(value) {
        this.childNodes = [new FakeHeadingText(String(value))];
    }
    removeChild(node) {
        this.childNodes = this.childNodes.filter(item => item !== node);
    }
}

test('watch-page DeArrow removes its stale text node when YouTube appends the new title', () => {
    const title = new FakeHeading('Native A');
    const playerData = { video_id: 'video-a', title: 'Native A' };
    const flexyData = { videoId: 'video-a' };
    const api = loadContentHarness(
        new Set(), { watchTitle: title, playerData, flexyData }
    );

    api.configure({ settings: { enabled: true, deArrowTitles: true } });
    api.setPath('/watch?v=video-a');
    api.setDeArrowCache('video-a', { title: 'Community A' });
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Community A');

    // YouTube hydrates the next video by appending its own text node beside
    // the foreign node the extension wrote, so both titles render at once.
    title.childNodes.push(new FakeHeadingText('Native B'));
    api.setPath('/watch?v=video-b');
    flexyData.videoId = 'video-b';
    playerData.video_id = 'video-b';
    playerData.title = 'Native B';
    api.setDeArrowCache('video-b', {});
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Native B',
        'the stale community text node must be pruned, keeping YouTube\'s node');
    assert.equal(title.dataset.ytbDeTitle, undefined);
    assert.equal(title.dataset.ytbDeWatchWritten, undefined);

    // A later video with a community title still applies over the pruned node.
    api.setDeArrowCache('video-b', { title: 'Community B' });
    api.refreshDeArrowWatchTitle();
    assert.equal(title.textContent, 'Community B');
    assert.equal(title.dataset.ytbDeOriginalTitle, 'Native B');
});

test('watch-page DeArrow trusts native hydration over its own last repair', () => {
    const title = new FakeDecoratedText('Native A');
    const playerData = { video_id: 'video-a', title: 'Native A' };
    const flexyData = { videoId: 'video-a' };
    const api = loadContentHarness(
        new Set(), { watchTitle: title, playerData, flexyData }
    );

    api.configure({ settings: { enabled: true, deArrowTitles: true } });
    api.setPath('/watch?v=video-a');
    api.setDeArrowCache('video-a', { title: 'Community A' });
    api.processDeArrowWatchPage();

    api.setPath('/watch?v=video-b');
    flexyData.videoId = 'video-b';
    playerData.video_id = 'video-b';
    playerData.title = 'Native B';
    api.setDeArrowCache('video-b', {});
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Native B');

    // YouTube hydrates the heading itself on the next navigation before our
    // pass runs. The hydrated text wins even when player data differs.
    api.setPath('/watch?v=video-c');
    flexyData.videoId = 'video-c';
    playerData.video_id = 'video-c';
    playerData.title = 'Native C (player)';
    title.textContent = 'Native C';
    api.setDeArrowCache('video-c', {});
    api.processDeArrowWatchPage();
    assert.equal(title.textContent, 'Native C',
        'a natively hydrated heading must never be overwritten by the repair');
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

test('paid and free badge labels are recognised across YouTube UI languages', () => {
    const api = loadContentHarness(new Set());

    const paidBadges = [
        'Pay to watch', 'Buy or rent',      // en
        // de wording verified live on the storefront, 2026-07
        'Kaufen oder leihen', 'Kaufen oder ausleihen', 'Kostenpflichtig',
        'Comprar o alquilar', 'De pago',    // es
        'Acheter ou louer', 'Payant',       // fr
        'Noleggia o acquista',              // it
        'A pagamento',                      // it
        'Alugar ou comprar',                // pt
        'Huren of kopen', 'Betaald',        // nl
        'Kup lub wypożycz', 'Płatne',       // pl
        'Купить или взять напрокат',        // ru
        'Платно',                           // ru
        'Satın al veya kirala', 'Ücretli',  // tr
        '購入またはレンタル', 'レンタル',      // ja
        '有料',                              // ja
        '구매 또는 대여', '유료',              // ko
        '购买或租借', '購買或租借', '付費',     // zh
        'شراء أو استئجار', 'مدفوع'          // ar
    ];
    const freeBadges = [
        'Free with ads',                    // en
        'Kostenlos mit Werbung',            // de (verified live 2026-07)
        'Gratis con anuncios',              // es
        'Gratuit avec des annonces',        // fr
        'Gratis con annunci',               // it
        'Grátis com anúncios',              // pt
        'Za darmo z reklamami',             // pl
        'Bezpłatne z reklamami',            // pl (contains the "płatn" stem)
        'Бесплатно с рекламой',             // ru (contains the "платн" stem)
        'Reklamlarla ücretsiz',             // tr
        '広告付きで無料',                     // ja
        '광고 포함 무료',                     // ko
        '含广告免费', '免費（含廣告）'          // zh
    ];
    for (const label of paidBadges) {
        assert.equal(api.isPaidBadgeText(label), true, 'paid: ' + label);
    }
    for (const label of freeBadges) {
        assert.equal(api.isPaidBadgeText(label), false, 'free: ' + label);
    }
});

test('a localized paid badge hides the tile and a localized free badge does not', () => {
    const api = loadContentHarness(new Set());
    api.configure({
        settings: { enabled: true, hidePaidVideos: true, reduceFlashing: true }
    });

    const cards = [
        new FakeTile('paidjp000001', { isPaid: true, paidText: '購入またはレンタル' }),
        new FakeTile('freejp000001', { isPaid: true, paidText: '広告付きで無料' }),
        new FakeTile('plain0000001')
    ];
    api.filterMutatedTiles([childListRecord(new FakeRoot(cards))]);

    assert.equal(cards[0].dataset.ytbFilterReason, 'paid');
    assert.equal(cards[1].dataset.ytbFilterReason, undefined);
    assert.equal(cards[2].dataset.ytbFilterReason, undefined);
});

test('a cached hidden channel page never leaks channel identity onto other pages', () => {
    const api = loadContentHarness(new Set(), { staleChannelDom: true });
    api.configure({ settings: { enabled: true } });

    api.setPath('/watch?v=abc12345678');
    assert.equal(api.getChannelInfoFromChannelPage(), null,
        'watch pages must not inherit the identity of the cached channel browse');
    api.setPath('/');
    assert.equal(api.getChannelInfoFromChannelPage(), null);
    api.setPath('/feed/subscriptions');
    assert.equal(api.getChannelInfoFromChannelPage(), null);

    // On a real channel page the URL wins; the stale hidden header (a
    // different channel) must contribute nothing, and without a rendered
    // matching header the identity stays unconfirmed (no attribution).
    api.setPath('/@realchan/videos');
    const info = api.getChannelInfoFromChannelPage();
    assert.equal(info.handle, 'realchan');
    assert.equal(info.channelId, '', 'the stale canonical link must not supply a channel ID');
    assert.equal(info.name, '', 'the stale hidden header must not supply a name');
    assert.equal(info.confirmed, false,
        'identity must stay unconfirmed until the visible header matches the URL');
});

test('watched tiles on a channel page are only credited to their own channel', () => {
    const watched = new Set(['ownvid000001', 'foreignvid01', 'barevid00001']);
    const api = loadContentHarness(watched);
    api.configure({
        settings: {
            enabled: true,
            hideWatched: true,
            watchedChannel: true,
            reduceFlashing: true
        }
    });
    api.setPath('/@pagechan/videos');
    api.setCurrentChannel({ handle: 'pagechan', channelId: '', name: 'Page Chan', confirmed: true });

    const own = new FakeTile('ownvid000001', { handle: 'pagechan', channel: 'Page Chan' });
    const foreign = new FakeTile('foreignvid01', { handle: 'otherchan', channel: 'Other Chan' });
    const bare = new FakeTile('barevid00001');
    bare.handle = '';
    bare.channel = '';
    bare.setVideo('barevid00001');   // regenerate anchors without a byline
    api.processTiles([own, foreign, bare]);

    assert.equal(own.dataset.ytbFilterReason, 'watched-history');
    assert.equal(foreign.dataset.ytbFilterReason, 'watched-history',
        'the foreign tile is still hidden as watched, just not attributed');
    assert.equal(bare.dataset.ytbFilterReason, 'watched-history');
    assert.deepEqual(
        api.channelAttributions.map(a => a.id).sort(),
        ['barevid00001', 'ownvid000001'],
        'a tile with a different byline must not count toward this channel');
    for (const a of api.channelAttributions) {
        assert.equal(a.info.handle, 'pagechan');
    }
});

test('byline-less tiles outside the confirmed channel browse are never attributed', () => {
    const watched = new Set(['transvid0001', 'ownvid000001', 'cachevid0001']);
    const api = loadContentHarness(watched);
    api.configure({
        settings: {
            enabled: true,
            hideWatched: true,
            watchedChannel: true,
            reduceFlashing: true
        }
    });
    api.setPath('/@pagechan/videos');
    const strip = tile => {
        tile.handle = '';
        tile.channel = '';
        tile.setVideo(tile.id);   // regenerate anchors without a byline
        return tile;
    };

    // Mid-navigation (URL flipped, header still the previous channel's):
    // identity is unconfirmed, so the old page's grid attributes nothing.
    api.setCurrentChannel({ handle: 'pagechan', channelId: '', name: '', confirmed: false, browse: null });
    const transitional = strip(new FakeTile('transvid0001'));
    api.processTiles([transitional]);
    assert.equal(transitional.dataset.ytbFilterReason, 'watched-history',
        'hiding still applies while attribution is suspended');
    assert.deepEqual(api.channelAttributions, []);

    // Confirmed page: only tiles inside the channel's visible browse count.
    // The SPA keeps other channels' cached pages hidden in the DOM with
    // their byline-less grids intact; those must not be credited here.
    const pageBrowse = { label: 'visible pagechan browse' };
    api.setCurrentChannel({
        handle: 'pagechan', channelId: '', name: 'Page Chan',
        confirmed: true, browse: pageBrowse
    });
    const own = strip(new FakeTile('ownvid000001'));
    own.browseEl = pageBrowse;
    const cached = strip(new FakeTile('cachevid0001'));
    cached.browseEl = { label: 'hidden cached browse of another channel' };
    api.processTiles([own, cached]);

    assert.equal(own.dataset.ytbFilterReason, 'watched-history');
    assert.equal(cached.dataset.ytbFilterReason, 'watched-history');
    assert.deepEqual(api.channelAttributions.map(a => a.id), ['ownvid000001'],
        'only the tile inside the confirmed visible browse is credited');
});

test('a reused grid card keeps the old channel until it is restamped (carry-over window)', () => {
    // Verified live: on a channel-to-channel SPA navigation the header
    // confirms the new channel seconds before the reused grid restamps, so
    // the previous channel's byline-less cards sit inside the CONFIRMED
    // browse. Those carried-over cards must never be credited to the new
    // channel; once restamped with the new channel's videos they count.
    const watched = new Set(['oldchanvid01', 'newchanvid01']);
    const api = loadContentHarness(watched);
    api.configure({
        settings: {
            enabled: true,
            hideWatched: true,
            watchedChannel: true,
            reduceFlashing: true
        }
    });

    const card = new FakeTile('oldchanvid01');
    card.handle = '';
    card.channel = '';
    card.setVideo('oldchanvid01');   // byline-less grid card

    api.setPath('/@channela/videos');
    api.setCurrentChannel({ handle: 'channela', channelId: '', name: 'Channel A', confirmed: true });
    api.processTiles([card]);
    assert.deepEqual(api.channelAttributions.map(a => a.info.handle + ':' + a.id),
        ['channela:oldchanvid01'], 'on its own page the grid card is credited normally');

    // SPA navigation to channel B: same element, same video, new context.
    api.setPath('/@channelb/videos');
    api.setCurrentChannel({ handle: 'channelb', channelId: '', name: 'Channel B', confirmed: true });
    api.processTiles([card]);
    assert.equal(card.dataset.ytbFilterReason, 'watched-history',
        'the carried-over card is still hidden as watched');
    assert.deepEqual(api.channelAttributions.map(a => a.info.handle + ':' + a.id),
        ['channela:oldchanvid01'],
        'the carried-over card must not be credited to the new channel');

    // YouTube restamps the recycled card with the new channel's video.
    card.setVideo('newchanvid01');
    api.processTiles([card]);
    assert.deepEqual(api.channelAttributions.map(a => a.info.handle + ':' + a.id),
        ['channela:oldchanvid01', 'channelb:newchanvid01'],
        'after the restamp the card belongs to the new channel');
});

test('channel video totals parse abbreviated counts and reject foreign header rows', () => {
    const api = loadContentHarness(new Set());
    api.configure({ settings: { enabled: true } });
    const parse = api.parseVideoCountText;

    assert.equal(parse('514 videos'), 514);
    assert.equal(parse('1,234 videos'), 1234);
    assert.equal(parse('@gamersnexus • 2.63m subscribers • 3.2k videos'), 3200,
        'the subscriber count must not shadow the abbreviated video count');
    assert.equal(parse('3.2K videos'), 3200);
    assert.equal(parse('3,2 mil vídeos'), 3200);
    assert.equal(parse('1,2 Tsd. Videos'), 1200);
    assert.equal(parse('1,2 тыс. видео'), 1200);
    assert.equal(parse('1.5m videos'), 1500000);
    assert.equal(parse('1.2万本の動画'), 12000);
    assert.equal(parse('no counts here'), null);

    // While a reused header restamps, its rows can still belong to the
    // previous channel; a mismatched @handle rejects the whole row.
    assert.equal(parse('@gamersnexus • 3.2k videos', 'gamersnexus'), 3200);
    assert.equal(parse('@oldchannel • 514 videos', 'gamersnexus'), null);
    assert.equal(parse('514 videos', 'gamersnexus'), 514);
});

const { fakeQualityPlayer, replayNavigationReset } = require('./quality-fixture');

test('max quality survives the reset YouTube does while loading the next video', () => {
    const h = loadContentHarness(new Set());
    h.configure({ settings: { enabled: true, maxQuality: true } });
    const player = fakeQualityPlayer();
    h.setElement('movie_player', player);
    replayNavigationReset(player, vid => h.setPath('/watch?v=' + vid), () => h.applyMaxQuality());
});

test('max quality waits until the player is on the video in the URL', () => {
    const h = loadContentHarness(new Set());
    h.configure({ settings: { enabled: true, maxQuality: true } });
    const player = fakeQualityPlayer();
    h.setElement('movie_player', player);
    h.setPath('/watch?v=nextVideo01');
    player.preferred = 'large';
    h.applyMaxQuality();
    assert.equal(player.sets, 0, "the previous video's streams are not this video's");
    player.vid = 'nextVideo01';
    h.applyMaxQuality();
    assert.equal(player.preferred, 'hd2160');
});

const { h, createDocument } = require('./mini-dom');

const SIDEBAR_TITLE = "SteamOS, Linux, & Microsoft's Valve-Sized Problem, ft. Wendell of Level1 Techs";

// Watch-sidebar (compact) lockup as rendered live 2026-10: the metadata host's
// own class contains "lockupMetadataViewModelTitle" (…TitleMaxLines3) and it
// precedes the real title in document order.
function sidebarLockup(videoId = 'tfVVngHbb4s') {
    return h('yt-lockup-view-model', { class: 'lockup' },
        h('a', { href: '/watch?v=' + videoId, class: 'ytLockupViewModelContentImage' }),
        h('yt-lockup-metadata-view-model', {
            class: 'ytLockupMetadataViewModelHost ytLockupMetadataViewModelHorizontal ' +
                'ytLockupMetadataViewModelTitleMaxLines3 ytLockupMetadataViewModelCompact'
        },
        h('div', { class: 'ytLockupMetadataViewModelTextContainer' },
            h('h3', {
                class: 'ytLockupMetadataViewModelHeadingReset',
                title: SIDEBAR_TITLE,
                'aria-label': SIDEBAR_TITLE
            },
            h('a', { href: '/watch?v=' + videoId, class: 'ytLockupMetadataViewModelTitle' },
                h('span', { class: 'yt-core-attributed-string' }, SIDEBAR_TITLE))),
            h('div', { class: 'ytLockupMetadataViewModelMetadata' },
                h('yt-content-metadata-view-model', {},
                    h('span', { class: 'ytContentMetadataViewModelMetadataText' }, 'Gamers Nexus'),
                    h('span', { class: 'ytContentMetadataViewModelMetadataText' }, '912K views'),
                    h('span', { class: 'ytContentMetadataViewModelMetadataText' }, '4 days ago'))))));
}

test('compact sidebar lockups yield the title, not the whole metadata block', () => {
    const api = loadContentHarness(new Set());
    const lockup = sidebarLockup();

    assert.equal(api.getTitleFromNode(lockup), SIDEBAR_TITLE);
    const target = api.deTitleTarget(lockup);
    assert.equal(target.localName, 'a');
    assert.equal(target.className, 'ytLockupMetadataViewModelTitle',
        'DeArrow must write to the title link, not the metadata host');

    // A keyword that only appears in the byline must not hide the video;
    // one from the title still does.
    api.configure({ settings: { enabled: true }, blockedKeywords: ['nexus'] });
    api.processTiles([lockup]);
    assert.equal(lockup.classList.contains('ytb-removed'), false);

    const other = sidebarLockup('otherVideo01');
    api.configure({ settings: { enabled: true }, blockedKeywords: ['valve'] });
    api.processTiles([other]);
    assert.equal(other.dataset.ytbFilterReason, 'blocked-keyword');
});

// Search-results Shorts shelf as rendered live 2026-10.
function searchShortsShelf() {
    return h('grid-shelf-view-model', {},
        h('yt-section-header-view-model', {},
            h('yt-shelf-header-layout', {}, h('h2', {}, 'Shorts'))),
        h('div', { class: 'ytGridShelfViewModelGridShelfRow' },
            h('ytm-shorts-lockup-view-model-v2', {},
                h('ytm-shorts-lockup-view-model', {},
                    h('a', { href: '/shorts/shortvideo1' }))),
            h('ytm-shorts-lockup-view-model-v2', {},
                h('ytm-shorts-lockup-view-model', {},
                    h('a', { href: '/shorts/shortvideo2' })))),
        h('button-view-model', {}, h('button', {}, 'Show more')));
}

test('search-results Shorts shelves hide whole, header and Show more included', () => {
    const shelf = searchShortsShelf();
    const plainShelf = h('grid-shelf-view-model', {},
        h('yt-section-header-view-model', {}, h('h2', {}, 'Latest from Example')),
        h('ytd-video-renderer', {}, h('a', { href: '/watch?v=regular0001' })));
    const section = h('ytd-item-section-renderer', {}, h('div', { id: 'contents' }, shelf, plainShelf));
    const dom = createDocument(h('ytd-search', {}, section));

    const api = loadContentHarness(new Set(), { dom });
    api.configure({ settings: { enabled: true, blockShorts: true } });

    // Pre-paint pass: the shelf is inserted, then its lockups render into it.
    const lockups = shelf.children[1];
    lockups.remove();
    api.processLegacyMutationFilters([{
        type: 'childList', target: section, addedNodes: [shelf], removedNodes: []
    }]);
    assert.equal(shelf.classList.contains('ytb-removed'), false,
        'an empty grid shelf is not known to be Shorts yet');
    shelf.insertBefore(lockups, shelf.children[1]);
    api.processLegacyMutationFilters([{
        type: 'childList', target: shelf, addedNodes: [lockups], removedNodes: []
    }]);
    assert.equal(shelf.classList.contains('ytb-removed'), true);
    assert.equal(plainShelf.classList.contains('ytb-removed'), false);

    // Maintenance pass over the whole page.
    shelf.classList.remove('ytb-removed');
    api.removeShortsSurfaces();
    assert.equal(shelf.classList.contains('ytb-removed'), true);
    assert.equal(plainShelf.classList.contains('ytb-removed'), false,
        'a grid shelf without Shorts stays');
});

test('shared speed hotkeys feed the per-channel speed memory', () => {
    const owner = h('ytd-video-owner-renderer', {},
        h('a', { href: '/@gamersnexus' }, 'Gamers Nexus'));
    const api = loadContentHarness(new Set(), { dom: createDocument(owner) });
    api.configure({ settings: { enabled: true, ytSpeedPerChannel: true } });
    api.setPath('/watch?v=tfVVngHbb4s');

    api.fire('ytb-speed-action', { site: 'youtube', speed: 1.75 });
    assert.equal(api.getState().ytChannelSpeeds['@gamersnexus'], 1.75);

    api.fire('ytb-speed-action', { site: 'twitch', speed: 2 });
    assert.equal(api.getState().ytChannelSpeeds['@gamersnexus'], 1.75,
        'Twitch speed changes are not YouTube channel speeds');

    api.fire('ytb-speed-action', { site: 'youtube', speed: 1 });
    assert.equal('@gamersnexus' in api.getState().ytChannelSpeeds, false,
        'returning to 1x forgets the channel speed');
});

test('a profile volume boost survives storage reloads until changed by hand', () => {
    const api = loadContentHarness(new Set());
    // No style-injecting features: the stub document cannot build <style>.
    api.configure({ settings: {
        enabled: true, volumeBoost: 1,
        blockShorts: false, hideSidebarSpinner: false, hideEndScreen: false
    } });

    api.fire('ytb-apply-playback-profile', { site: 'youtube', speed: 1.5, volumeBoost: 2 });
    assert.equal(api.getSettings().volumeBoost, 2);

    // Any write to the shared record reloads settings from storage, where the
    // base boost is still 1x: the session-scoped profile boost must hold.
    api.rebuildDerived();
    assert.equal(api.getSettings().volumeBoost, 2);
    assert.equal(api.getState().settings.volumeBoost, 1, 'the profile boost is never saved');

    api.setVolumeBoost(1);
    api.rebuildDerived();
    assert.equal(api.getSettings().volumeBoost, 1, 'a manual change replaces the profile boost');

    api.fire('ytb-apply-playback-profile', { site: 'youtube', speed: 1.5, volumeBoost: 3 });
    api.fire('ytb-apply-playback-profile', { site: 'youtube', speed: 1.5, volumeBoost: null });
    api.rebuildDerived();
    assert.equal(api.getSettings().volumeBoost, 1, 'a profile without a boost uses the base');
});

test('hidden-video details go to their own key, folded with an old in-record copy', async () => {
    const storage = {
        values: {
            data: {
                settings: { enabled: true },
                hiddenVideoIds: ['legacyVid01'],
                hiddenVideoMetadata: {
                    legacyVid01: { title: 'Legacy title', channel: '', thumbnail: '', addedAt: 1 }
                }
            }
        },
        writes: []
    };
    const api = loadContentHarness(new Set(), { storage });
    api.configure(storage.values.data);

    // Two hides saved back to back. Each save reads the stored record first,
    // so the two must not interleave and drop each other's details.
    api.rememberHiddenVideo('firstVid001', sidebarLockup('firstVid001'), { name: 'Gamers Nexus' });
    const first = api.saveOnly();
    api.rememberHiddenVideo('secondVid01', sidebarLockup('secondVid01'), { name: 'Gamers Nexus' });
    await Promise.all([first, api.saveOnly()]);

    const meta = storage.values.ytbHiddenVideoMeta;
    assert.deepEqual(Object.keys(meta).sort(), ['firstVid001', 'legacyVid01', 'secondVid01']);
    assert.equal(meta.firstVid001.title, SIDEBAR_TITLE);
    assert.equal(meta.firstVid001.channel, 'Gamers Nexus');
    assert.equal(meta.legacyVid01.title, 'Legacy title');
    assert.equal('hiddenVideoMetadata' in storage.values.data, false, 'the old copy left `data`');

    // A save with no new details (a volume change, say) leaves the key alone.
    await api.saveOnly();
    assert.deepEqual(storage.writes.at(-1), ['data']);
});

test('caption updates inside the player do not queue a full page pass', () => {
    const api = loadContentHarness(new Set());
    const segment = h('span', { class: 'ytp-caption-segment' }, 'Hello');
    const player = h('div', { id: 'movie_player' },
        h('div', { class: 'ytp-caption-window-container' },
            h('div', { class: 'caption-window' },
                h('span', { class: 'captions-text' }, segment))));
    createDocument(player);
    const line = segment.parentElement;
    assert.equal(api.mutationNeedsMaintenance([{
        type: 'childList', target: line, addedNodes: [segment], removedNodes: []
    }]), false);
    const replaced = h('span', { class: 'ytp-caption-segment' }, 'Earlier line');
    assert.equal(api.mutationNeedsMaintenance([{
        type: 'childList', target: line, addedNodes: [], removedNodes: [replaced]
    }]), false);

    // End-screen suggestions inside the same player still get the page pass,
    // which hides blocked channels there.
    const endscreen = h('div', { class: 'html5-endscreen' });
    player.appendChild(endscreen);
    const still = h('a', { class: 'ytp-videowall-still', href: '/watch?v=endscreen01' });
    endscreen.appendChild(still);
    assert.equal(api.mutationNeedsMaintenance([{
        type: 'childList', target: endscreen, addedNodes: [still], removedNodes: []
    }]), true);
});

test('watched-history changes in a hidden tab wait until it is shown', () => {
    const api = loadContentHarness(new Set());
    api.configure({ settings: { enabled: true } });
    const runAllCalls = api.spyRunAll();

    api.setHidden(true);
    api.fire('ytb-watched-db-change');
    assert.equal(runAllCalls(), 0);
    assert.equal(api.isPendingWhileHidden(), true, 'the visibility handler catches up later');

    api.setHidden(false);
    api.fire('ytb-watched-db-change');
    assert.equal(runAllCalls(), 1);
});

// The watch page's dislike button as rendered live 2026-11 (icon-only, the
// pressed state on the button's aria-pressed).
function watchDislikeButton(pressed) {
    const button = h('button', { 'aria-pressed': pressed ? 'true' : 'false', 'aria-label': 'Dislike this video' });
    h('ytd-watch-metadata', {},
        h('segmented-like-dislike-button-view-model', {},
            h('dislike-button-view-model', {}, button)));
    return button;
}

test('your own dislike shows in the Return YouTube Dislike count', () => {
    const api = loadContentHarness(new Set());
    const button = watchDislikeButton(false);
    api.applyRydTo(button, 'rydVideo001', { dislikes: 11 });
    assert.equal(button.querySelector('.ytb-ryd-count').textContent, '11');

    // RYD never hears about this vote, so its count can't include it.
    button.setAttribute('aria-pressed', 'true');
    api.mutate(button, 'aria-pressed');
    assert.equal(button.querySelector('.ytb-ryd-count').textContent, '12');
    assert.match(button.getAttribute('title'), /^12 dislikes/);

    // Taking it back, or liking instead, un-presses the button.
    button.setAttribute('aria-pressed', 'false');
    api.mutate(button, 'aria-pressed');
    assert.equal(button.querySelector('.ytb-ryd-count').textContent, '11');
});

test('a count written before a reload still follows your vote', () => {
    const button = watchDislikeButton(true);
    // Stamped by an earlier add-on instance: no new lookup is made.
    button.dataset.ytbRyd = 'rydVideo001';
    button.dataset.ytbRydBase = '11';
    const api = loadContentHarness(new Set(), { dom: createDocument(button.closest('ytd-watch-metadata')) });
    api.configure({ settings: { enabled: true, rydEnabled: true } });
    api.setPath('/watch?v=rydVideo001');
    api.processRyd();
    assert.equal(button.querySelector('.ytb-ryd-count').textContent, '12');

    button.setAttribute('aria-pressed', 'false');
    api.mutate(button, 'aria-pressed');
    assert.equal(button.querySelector('.ytb-ryd-count').textContent, '11', 'and is watched from then on');
});

// The player on a live stream as seen 2026-11-09 (Lofi Girl): YouTube no
// longer puts "ytp-live" on #movie_player, the video reports a finite
// duration (50390 s) and plays near its end, and the player API says isLive.
function livePlayerPage(videoData, options = {}) {
    const video = h('video', { class: 'html5-main-video' });
    Object.assign(video, { readyState: 4, playbackRate: 1, currentTime: 46790, duration: 50390 });
    const handlers = {};
    video.addEventListener = (type, fn) => { handlers[type] = fn; };
    const timeDisplay = h('div', { class: options.liveSwitch ? 'ytp-time-display ytp-live' : 'ytp-time-display' });
    const player = h('div', { id: 'movie_player', class: 'html5-video-player ytp-livebadge-color' },
        video, timeDisplay);
    player.rates = [];
    player.setPlaybackRate = rate => { player.rates.push(rate); };
    if (videoData) {
        player.data = videoData;
        player.getVideoData = () => player.data;
    }
    return { video, player, handlers, timeDisplay, dom: createDocument(player) };
}

test('the default speed leaves a live stream alone and waits for the player after navigation', () => {
    const page = livePlayerPage({ video_id: 'liveStream1', isLive: true });
    const api = loadContentHarness(new Set(), { dom: page.dom, player: page.player });
    api.configure({ settings: { enabled: true, ytSpeedDefault: 1.5 } });
    api.setPath('/watch?v=liveStream1');
    api.applyDefaultSpeed();
    assert.equal(page.video.playbackRate, 1, 'a live stream keeps its speed');
    assert.deepEqual(page.player.rates, []);

    // In-page navigation to a normal video: the URL changes first, and for
    // about 150 ms the player still describes the live stream.
    api.setPath('/watch?v=normalVid01');
    api.applyDefaultSpeed();
    assert.equal(page.video.playbackRate, 1, "the previous video's answer is not this video's");
    page.player.data = { video_id: 'normalVid01', isLive: false };
    page.video.duration = 7479;
    api.applyDefaultSpeed();
    assert.equal(page.video.playbackRate, 1.5, 'the default applies once the player is on the new video');
    assert.deepEqual(page.player.rates, [1.5]);

    // And back to a live stream: the stale "not live" answer is not trusted either.
    api.setPath('/watch?v=liveStream2');
    api.applyDefaultSpeed();
    page.player.data = { video_id: 'liveStream2', isLive: true };
    api.applyDefaultSpeed();
    assert.deepEqual(page.player.rates, [1.5], 'the second live stream is left alone too');
});

test("a playback profile's speed skips a live stream", () => {
    const page = livePlayerPage({ video_id: 'liveStream1', isLive: true });
    const api = loadContentHarness(new Set(), { dom: page.dom, player: page.player });
    api.configure({ settings: {
        enabled: true, volumeBoost: 1,
        blockShorts: false, hideSidebarSpinner: false, hideEndScreen: false
    } });
    api.setPath('/watch?v=liveStream1');
    api.fire('ytb-apply-playback-profile', { site: 'youtube', speed: 1.75, volumeBoost: null });
    assert.deepEqual(page.player.rates, [], 'the player rate is left alone');
    assert.equal(page.video.playbackRate, 1);

    page.player.data = { video_id: 'liveStream1', isLive: false };
    api.fire('ytb-apply-playback-profile', { site: 'youtube', speed: 1.75, volumeBoost: null });
    assert.deepEqual(page.player.rates, [1.75], 'a normal video still gets the profile speed');
});

test('a live stream playing near its live edge is not recorded as watched', () => {
    const watched = new Set();
    const page = livePlayerPage({ video_id: 'liveStream1', isLive: true });
    const api = loadContentHarness(watched, { dom: page.dom, player: page.player });
    api.configure({ settings: { enabled: true, hideWatched: true, watchedThreshold: 90 } });
    api.setPath('/watch?v=liveStream1');
    api.ensureWatchedHook(page.video);
    page.handlers.timeupdate();
    assert.equal(watched.has('liveStream1'), false, '93% of a live window is not a watched video');

    api.setPath('/watch?v=normalVid01');
    Object.assign(page.video, { currentTime: 95, duration: 100 });
    page.handlers.timeupdate();
    assert.equal(watched.has('normalVid01'), false, 'not while the player still describes the live stream');
    page.player.data = { video_id: 'normalVid01', isLive: false };
    page.handlers.timeupdate();
    assert.equal(watched.has('normalVid01'), true, 'a normal video past the threshold is recorded');
});

test("without the player API the time display's live switch decides", () => {
    const page = livePlayerPage(null, { liveSwitch: true });
    const api = loadContentHarness(new Set(), { dom: page.dom, player: page.player });
    api.configure({ settings: { enabled: true, ytSpeedDefault: 1.5 } });
    api.setPath('/watch?v=liveStream1');

    // A preroll ad clears the switch (seen live 2026-11-09): wait it out.
    page.player.classList.add('ad-showing');
    page.timeDisplay.classList.remove('ytp-live');
    api.applyDefaultSpeed();
    assert.equal(page.video.playbackRate, 1, 'no decision during the ad');
    page.player.classList.remove('ad-showing');
    page.timeDisplay.classList.add('ytp-live');
    api.applyDefaultSpeed();
    assert.equal(page.video.playbackRate, 1, 'the live switch keeps a live stream at its speed');

    api.setPath('/watch?v=normalVid01');
    page.timeDisplay.classList.remove('ytp-live');
    api.applyDefaultSpeed();
    assert.equal(page.video.playbackRate, 1.5);
});

test('Chromium asks the MAIN world whether the player is live, synchronously', () => {
    // The isolated world's #movie_player has no API and (as on a live stream
    // seen 2026-11-09) no "ytp-live" class; only the page world can ask it.
    const page = livePlayerPage(null);
    delete page.player.setPlaybackRate;
    let pageData = { video_id: 'liveStream1', isLive: true };
    const api = loadContentHarness(new Set(), { dom: page.dom, player: page.player });
    attachPageWorld(api, { getVideoData: () => pageData });
    api.configure({ settings: { enabled: true, ytSpeedDefault: 1.5 } });
    api.setPath('/watch?v=liveStream1');
    api.applyDefaultSpeed();
    assert.equal(page.video.playbackRate, 1, 'a live stream keeps its speed');

    api.setPath('/watch?v=normalVid01');
    api.applyDefaultSpeed();
    assert.equal(page.video.playbackRate, 1, 'the player is still on the live stream');
    pageData = { video_id: 'normalVid01', isLive: false };
    api.applyDefaultSpeed();
    assert.equal(page.video.playbackRate, 1.5);
    assert.deepEqual(api.postedMessages.map(item => item.message.type), ['ytb-set-rate'],
        'the live check itself posts no messages');
});
