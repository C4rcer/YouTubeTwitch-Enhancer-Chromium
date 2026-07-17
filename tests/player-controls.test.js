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
    const elementsById = new Map();
    const rootChildren = [];
    const bodyChildren = [];

    function element(tagName) {
        return {
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
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            if (listeners.has(type)) {
                listeners.set(type, listeners.get(type).filter(item => item !== handler));
            }
        },
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

    return { video, videoTarget, fire };
}

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
