/* eslint-env node */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeClassList() {
    const values = new Set();
    return {
        add(...items) { items.forEach(item => values.add(item)); },
        remove(...items) { items.forEach(item => values.delete(item)); },
        contains(item) { return values.has(item); },
        toggle(item, force) {
            if (force === true) values.add(item);
            else if (force === false) values.delete(item);
            else if (values.has(item)) values.delete(item);
            else values.add(item);
        }
    };
}

function buildHarness(data) {
    const listeners = new Map();
    const owners = [];   // { owner, type, handler } for every live listener
    const elementsById = new Map();
    const rootChildren = [];
    const bodyChildren = [];

    function listen(owner, type, handler) {
        owners.push({ owner, type, handler });
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
    }

    function unlisten(owner, type, handler) {
        const index = owners.findIndex(item =>
            item.owner === owner && item.type === type && item.handler === handler);
        if (index >= 0) owners.splice(index, 1);
        if (listeners.has(type)) {
            listeners.set(type, listeners.get(type).filter(item => item !== handler));
        }
    }

    function element(tagName) {
        return {
            addEventListener(type, handler) { listen(this, type, handler); },
            removeEventListener(type, handler) { unlisten(this, type, handler); },
            tagName: String(tagName || 'div').toUpperCase(),
            dataset: {},
            style: {},
            classList: fakeClassList(),
            children: [],
            parentElement: null,
            textContent: '',
            id: '',
            setAttribute(name, value) { this[name] = String(value); },
            appendChild(child) {
                child.parentElement = this;
                this.children.push(child);
                if (child.id) elementsById.set(child.id, child);
                return child;
            },
            remove() {
                if (this.id) elementsById.delete(this.id);
                if (this.parentElement) {
                    this.parentElement.children = this.parentElement.children.filter(item => item !== this);
                }
            },
            querySelector(selector) {
                if (selector === '.ytb-active-profile-chip') {
                    return this.children.find(item => item.className === 'ytb-active-profile-chip') || null;
                }
                return null;
            },
            contains(target) { return target === this || target === videoTarget; },
            closest() { return null; },
            click() {}
        };
    }

    const player = element('div');
    player.id = 'movie_player';
    player.appendChild = child => {
        child.parentElement = player;
        rootChildren.push(child);
        player.children = rootChildren;
        if (child.id) elementsById.set(child.id, child);
        return child;
    };

    const videoTarget = element('span');
    const video = element('video');
    Object.assign(video, {
        readyState: 2,
        currentSrc: 'https://media.example/video',
        src: '',
        paused: false,
        playbackRate: 1,
        volume: 0.5,
        muted: false,
        currentTime: 30,
        duration: 100,
        videoWidth: 1920,
        videoHeight: 1080,
        getBoundingClientRect: () => ({ width: 1280, height: 720 }),
        play() { this.paused = false; return Promise.resolve(); },
        pause() { this.paused = true; },
        seekable: { length: 1, start: () => 0, end: () => 100 }
    });

    const document = {
        body: element('body'),
        activeElement: null,
        addEventListener(type, handler) { listen(document, type, handler); },
        removeEventListener(type, handler) { unlisten(document, type, handler); },
        dispatchEvent(event) {
            for (const handler of listeners.get(event.type) || []) handler(event);
            return true;
        },
        querySelectorAll(selector) {
            if (selector === 'video') return [video];
            return [];
        },
        querySelector(selector) {
            if (selector === 'video') return video;
            return null;
        },
        getElementById(id) {
            if (id === 'movie_player') return player;
            return elementsById.get(id) || null;
        },
        createElement: element
    };
    document.body.appendChild = child => {
        child.parentElement = document.body;
        bodyChildren.push(child);
        document.body.children = bodyChildren;
        if (child.id) elementsById.set(child.id, child);
        return child;
    };

    const storageListeners = [];
    const browser = {
        runtime: { getManifest: () => ({ version: 'test' }) },
        storage: {
            local: {
                get: async () => ({ data }),
                set: async () => {}
            },
            onChanged: {
                addListener(handler) { storageListeners.push(handler); },
                removeListener(handler) {
                    const index = storageListeners.indexOf(handler);
                    if (index >= 0) storageListeners.splice(index, 1);
                }
            }
        }
    };

    let timerId = 0;
    const queued = new Map();
    function fastTimeout(handler, delay) {
        const id = ++timerId;
        if (delay <= 200) {
            const native = setTimeout(() => {
                queued.delete(id);
                handler();
            }, 0);
            queued.set(id, native);
        }
        return id;
    }
    function fastClearTimeout(id) {
        const native = queued.get(id);
        if (native) clearTimeout(native);
        queued.delete(id);
    }

    class CustomEvent {
        constructor(type, options) {
            this.type = type;
            this.detail = options && options.detail;
        }
    }

    const context = {
        console,
        document,
        browser,
        chrome: browser,
        CustomEvent,
        URL,
        URLSearchParams,
        location: {
            hostname: 'www.youtube.com',
            pathname: '/watch',
            search: '?v=abc123',
            href: 'https://www.youtube.com/watch?v=abc123'
        },
        window: {
            addEventListener() {},
            removeEventListener() {}
        },
        setTimeout: fastTimeout,
        clearTimeout: fastClearTimeout
    };
    context.globalThis = context;
    vm.createContext(context);
    const featureSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'feature-core.js'), 'utf8');
    const playerSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'player-controls.js'), 'utf8');
    vm.runInContext(featureSource + '\n' + playerSource, context);

    function fire(type, event) {
        event.type = type;
        event.target = event.target || videoTarget;
        event.prevented = false;
        event.stopped = false;
        event.preventDefault = () => { event.prevented = true; };
        event.stopImmediatePropagation = () => { event.stopped = true; };
        for (const handler of listeners.get(type) || []) handler(event);
        return event;
    }

    function changeData(newValue) {
        for (const handler of storageListeners.slice()) handler({ data: { newValue } }, 'local');
    }

    const listenerOwners = type => owners.filter(item => item.type === type).map(item => item.owner);

    return {
        video, videoTarget, player, document, fire, changeData, listenerOwners,
        on: document.addEventListener, location: context.location
    };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const bracketRight = {
    code: 'BracketRight',
    key: ']',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false
};

test('configured keyboard and wheel actions handle media and show conflicts nowhere at runtime', async () => {
    const harness = buildHarness({
        settings: { enabled: true, ytSpeedHotkeys: true },
        inputBindings: {
            youtube: {
                enabled: true,
                keyboard: { speedUp: 'BracketRight' },
                mouse: {},
                wheel: { volumeUp: 'WheelUp' }
            }
        },
        playbackProfiles: [
            { id: 'study', name: 'Study', sites: ['youtube'], speed: 1.5 }
        ],
        activePlaybackProfiles: { youtube: 'study', twitch: 'default' }
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(harness.video.playbackRate, 1.5, 'active profile applies once media is ready');

    const key = harness.fire('keydown', {
        code: 'BracketRight',
        key: ']',
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false
    });
    assert.equal(harness.video.playbackRate, 1.75);
    assert.equal(key.prevented, true);
    assert.equal(key.stopped, true);

    const wheel = harness.fire('wheel', { deltaY: -1 });
    assert.equal(harness.video.volume, 0.55);
    assert.equal(wheel.prevented, true);
});

test('configured shortcuts are ignored in editable targets', async () => {
    const harness = buildHarness({
        settings: { enabled: true, ytSpeedHotkeys: true },
        inputBindings: {
            youtube: {
                enabled: true,
                keyboard: { speedUp: 'BracketRight' },
                mouse: {},
                wheel: {}
            }
        }
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    harness.fire('keydown', {
        code: 'BracketRight',
        key: ']',
        target: { tagName: 'INPUT' },
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false
    });
    assert.equal(harness.video.playbackRate, 1);
});

test('unrelated data writes keep a manual speed; profile edits re-apply', async () => {
    const data = {
        settings: { enabled: true, ytSpeedHotkeys: true, volumeBoost: 1 },
        inputBindings: {
            youtube: { enabled: true, keyboard: { speedUp: 'BracketRight' }, mouse: {}, wheel: {} }
        },
        playbackProfiles: [
            { id: 'study', name: 'Study', sites: ['youtube'], speed: 1.5 }
        ],
        activePlaybackProfiles: { youtube: 'study', twitch: 'default' }
    };
    const harness = buildHarness(data);
    await settle();
    assert.equal(harness.video.playbackRate, 1.5);
    let applied = 0;
    harness.on('ytb-apply-playback-profile', () => { applied++; });

    harness.fire('keydown', Object.assign({}, bracketRight));
    assert.equal(harness.video.playbackRate, 1.75);

    // A volume-boost save (or a hide in another tab) rewrites the record.
    harness.changeData(Object.assign({}, data, {
        settings: Object.assign({}, data.settings, { volumeBoost: 2 }),
        hiddenVideoIds: ['abc']
    }));
    await settle();
    assert.equal(harness.video.playbackRate, 1.75, 'the manual speed survives');
    assert.equal(applied, 0, 'the profile is not re-run');

    harness.changeData(Object.assign({}, data, {
        playbackProfiles: [{ id: 'study', name: 'Study', sites: ['youtube'], speed: 1.25 }]
    }));
    await settle();
    assert.equal(harness.video.playbackRate, 1.25, 'editing the profile applies it');
    assert.equal(applied, 1);
});

test('speed hotkeys report each change for per-channel memory', async () => {
    const harness = buildHarness({
        settings: { enabled: true, ytSpeedHotkeys: true },
        inputBindings: {
            youtube: { enabled: true, keyboard: { speedUp: 'BracketRight' }, mouse: {}, wheel: {} }
        }
    });
    await settle();
    const reports = [];
    harness.on('ytb-speed-action', event => reports.push(event.detail));
    harness.fire('keydown', Object.assign({}, bracketRight));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].site, 'youtube');
    assert.equal(reports[0].speed, 1.25);
});

test('a wheel listener exists only for configured wheel shortcuts, on the player', async () => {
    const plain = buildHarness({ settings: { enabled: true } });
    await settle();
    assert.equal(plain.listenerOwners('wheel').length, 0,
        'no wheel shortcut, so page scrolling never waits on this script');

    const data = {
        settings: { enabled: true },
        inputBindings: {
            youtube: { enabled: true, keyboard: {}, mouse: {}, wheel: { volumeUp: 'WheelUp' } }
        }
    };
    const bound = buildHarness(data);
    await settle();
    const owners = bound.listenerOwners('wheel');
    assert.equal(owners.length, 1);
    assert.equal(owners[0], bound.player, 'scoped to the player, not the document');

    bound.changeData(Object.assign({}, data, {
        inputBindings: { youtube: { enabled: true, keyboard: {}, mouse: {}, wheel: {} } }
    }));
    await settle();
    assert.equal(bound.listenerOwners('wheel').length, 0, 'removing the shortcut removes the listener');
});

// The live player as seen 2026-11-09: no "ytp-live" class on #movie_player,
// only the player API's isLive flag, which names the video it describes.
const studyProfile = {
    settings: { enabled: true },
    playbackProfiles: [{ id: 'study', name: 'Study', sites: ['youtube'], speed: 1.5 }],
    activePlaybackProfiles: { youtube: 'study', twitch: 'default' }
};

test('a YouTube profile leaves a live stream at its own speed, like Twitch', async () => {
    const harness = buildHarness(studyProfile);
    let answers = [{ video_id: 'abc123', isLive: true }];
    harness.player.getVideoData = () => answers.length > 1 ? answers.shift() : answers[0];
    const applied = [];
    harness.on('ytb-apply-playback-profile', event => applied.push(event.detail));
    await settle();
    assert.equal(harness.video.playbackRate, 1, 'a live stream keeps its speed');
    assert.equal(applied.length, 1, 'the rest of the profile still applies');

    // In-page navigation to a normal video: the URL moves first, and the
    // player describes the live stream for two more passes.
    harness.location.search = '?v=next456';
    harness.location.href = 'https://www.youtube.com/watch?v=next456';
    harness.video.currentSrc = 'https://media.example/next';
    answers = [
        { video_id: 'abc123', isLive: true },
        { video_id: 'abc123', isLive: true },
        { video_id: 'next456', isLive: false }
    ];
    harness.fire('loadedmetadata', {});
    for (let i = 0; i < 100 && applied.length < 2; i++) await settle();
    assert.equal(answers.length, 1, 'it asked again until the player was on the new video');
    assert.equal(harness.video.playbackRate, 1.5, 'the normal video gets the profile speed');
    assert.equal(applied.length, 2, 'once');
});

test('a YouTube profile leaves the speed alone if the player never reaches the video', async () => {
    const harness = buildHarness(studyProfile);
    harness.player.getVideoData = () => ({ video_id: 'previous1', isLive: false });
    const applied = [];
    harness.on('ytb-apply-playback-profile', event => applied.push(event.detail));
    for (let i = 0; i < 100 && !applied.length; i++) await settle();
    assert.equal(applied.length, 1, 'the profile applies after the wait');
    assert.equal(harness.video.playbackRate, 1, 'without its speed, which could be a live stream');
});

test('without the player API a YouTube profile reads the live switch', async () => {
    const harness = buildHarness(studyProfile);
    const liveSwitch = { className: 'ytp-time-display ytp-live' };
    harness.player.querySelector = selector =>
        selector === '.ytp-time-display.ytp-live' ? liveSwitch : null;
    await settle();
    assert.equal(harness.video.playbackRate, 1);
});

test('Chromium profiles ask the MAIN world whether YouTube is live', async () => {
    const harness = buildHarness(studyProfile);
    // The isolated world's player has no API; page-quality.js answers a
    // ytb-live-query event with a ytb-live-data event before dispatch returns.
    let pageData = { video_id: 'abc123', isLive: true };
    let queries = 0;
    harness.on('ytb-live-query', () => {
        queries++;
        harness.document.dispatchEvent({
            type: 'ytb-live-data',
            detail: JSON.stringify({ videoId: pageData.video_id, isLive: pageData.isLive })
        });
    });
    const applied = [];
    harness.on('ytb-apply-playback-profile', event => applied.push(event.detail));
    await settle();
    assert.equal(queries, 1);
    assert.equal(harness.video.playbackRate, 1, 'a live stream keeps its speed');
    assert.equal(applied.length, 1);

    pageData = { video_id: 'abc123', isLive: false };
    harness.fire('loadedmetadata', {});
    for (let i = 0; i < 100 && applied.length < 2; i++) await settle();
    assert.equal(harness.video.playbackRate, 1.5, 'a normal video gets the profile speed');
});
