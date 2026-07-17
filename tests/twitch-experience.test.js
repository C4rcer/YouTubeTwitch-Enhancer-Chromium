/* eslint-env node */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const experience = require('../src/twitch-experience.js');

test('retry backoff is exponential and bounded', () => {
    assert.deepEqual(
        [0, 1, 2, 3, 4, 5].map(attempt => experience.retryDelay(attempt, 1000, 12000)),
        [1000, 2000, 4000, 8000, 12000, 12000]
    );
    assert.equal(experience.retryDelay(-5, 0, 0), 1000,
        'malformed values fall back to the safe defaults');
});

test('recoverability uses DOM/media state and rejects inactive playback', () => {
    assert.deepEqual(experience.classifyRecoverablePlayerState({
        mediaErrorCode: 2, hasSource: true
    }), { recoverable: true, kind: 'media-network' });
    assert.deepEqual(experience.classifyRecoverablePlayerState({
        hasErrorNode: true, mediaErrorCode: 0
    }), { recoverable: true, kind: 'player-error' });
    assert.deepEqual(experience.classifyRecoverablePlayerState({
        readyState: 1, networkState: 2, hasSource: true, paused: false,
        seeking: false, stalledForMs: 9000
    }), { recoverable: true, kind: 'stalled' });
    assert.equal(experience.classifyRecoverablePlayerState({
        hasErrorNode: true, offline: true
    }).recoverable, false);
    assert.equal(experience.classifyRecoverablePlayerState({
        hasErrorNode: true, ended: true
    }).recoverable, false);
});

test('quality fallback selects only the next safely rendered lower rung', () => {
    const qualities = [
        { label: 'Source', selected: false },
        { label: '1080p60', selected: true },
        { label: '720p60' },
        { label: '480p' },
        { label: 'Auto' }
    ];
    assert.equal(experience.chooseQualityFallback(qualities, qualities[1], 1, 2), null);
    assert.equal(experience.chooseQualityFallback(qualities, qualities[1], 2, 2), qualities[2]);
    assert.equal(experience.chooseQualityFallback(qualities, qualities[3], 2, 2), null,
        'the last numeric rung never wraps back to a higher quality');
    assert.equal(experience.chooseQualityFallback([{ label: 'Auto', selected: true }], null, 4, 2), null);
});

function ranges(values) {
    return {
        length: values.length,
        start(index) { return values[index][0]; },
        end(index) { return values[index][1]; }
    };
}

test('live delay and configurable seeking stay inside media ranges', () => {
    const seekable = ranges([[100, 160]]);
    assert.equal(experience.liveDelaySeconds({ currentTime: 151.25, seekable }), 8.75);
    assert.equal(experience.formatDelay(1.2), 'Live');
    assert.equal(experience.formatDelay(72), '1m 12s behind');
    assert.equal(experience.seekTarget(105, -1, 30, seekable, Infinity), 100);
    assert.equal(experience.seekTarget(155, 1, 30, seekable, Infinity), 160);
});

test('sidebar normalization is bounded, unique, and rejects non-channel paths', () => {
    const favourites = [];
    for (let i = 0; i < 340; i++) favourites.push('user_' + String(i).padStart(3, '0'));
    favourites.push('directory', 'user_001', '../bad');
    const groups = [];
    for (let i = 0; i < 40; i++) {
        groups.push({
            id: i < 2 ? 'duplicate' : 'group-' + i,
            name: ' Group ' + i + ' ',
            members: [...favourites, 'videos']
        });
    }
    const normalized = experience.normalizeSidebar({ favourites, groups });
    assert.equal(normalized.favourites.length, experience.MAX_FAVOURITES);
    assert.equal(new Set(normalized.favourites).size, normalized.favourites.length);
    assert.equal(normalized.groups.length, experience.MAX_GROUPS);
    assert.equal(new Set(normalized.groups.map(group => group.id)).size, normalized.groups.length);
    assert.ok(normalized.groups.every(group => group.members.length <= experience.MAX_GROUP_MEMBERS));
    assert.equal(experience.loginFromHref('/directory'), '');
    assert.equal(experience.loginFromHref('https://www.twitch.tv/Some_Channel'), 'some_channel');
});

test('sidebar accepts legacy and canonical schemas and writes canonical channel metadata', () => {
    const canonicalInput = {
        favorites: [{ login: 'Alpha', name: 'Alpha Name', addedAt: 123 }],
        groups: [{
            id: 'team',
            name: 'Team',
            collapsed: true,
            channels: [{ login: 'beta', name: 'Beta Name', addedAt: 456 }]
        }]
    };
    assert.deepEqual(experience.normalizeSidebar(canonicalInput), {
        favourites: ['alpha'],
        groups: [{ id: 'team', name: 'Team', collapsed: true, members: ['beta'] }]
    });

    const output = experience.toCanonicalSidebar({
        favourites: ['alpha', 'gamma'],
        groups: [{ id: 'team', name: 'Team', collapsed: false, members: ['beta', 'gamma'] }]
    }, canonicalInput, 999);
    assert.deepEqual(output.favorites, [
        { login: 'alpha', name: 'Alpha Name', addedAt: 123 },
        { login: 'gamma', name: '', addedAt: 999 }
    ]);
    assert.deepEqual(output.groups[0].channels, [
        { login: 'beta', name: 'Beta Name', addedAt: 456 },
        { login: 'gamma', name: '', addedAt: 999 }
    ]);
});

test('flat settings override compatible player and overlay state when present', () => {
    assert.equal(experience.normalizePlayerOptions({ seekStep: 1 }).seekStep, 1);
    assert.equal(experience.normalizePlayerOptions({ seekStep: 120 }).seekStep, 60);
    assert.deepEqual(experience.playerOptionsFromState({
        seekStep: 30, maxRetries: 2, baseDelayMs: 750
    }, { twSeekStep: 15 }), {
        seekStep: 15, maxRetries: 2, baseDelayMs: 750, maxDelayMs: 12000, fallbackAfter: 2
    });
    assert.deepEqual(experience.overlayOptionsFromState({
        opacity: 0.4, width: 300, autoHideMs: 9000, interactive: false
    }, {
        twChatOverlayOpacity: 0.75,
        twChatOverlayWidth: 420,
        twChatOverlayAutoHide: false,
        twChatOverlayClickThrough: true,
        twChatOverlayInteraction: true
    }), {
        opacity: 0.75,
        width: 420,
        fontScale: 1,
        placement: 'right',
        autoHideMs: 0,
        clickThrough: true,
        interactive: true
    });
});

test('controller handles shared player actions and removes those listeners on retire', () => {
    const listeners = new Map();
    const document = {
        hidden: false,
        activeElement: null,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
            const set = listeners.get(type);
            if (set) set.delete(listener);
        },
        querySelector() { return null; },
        getElementById() { return null; }
    };
    const emit = (type, detail) => {
        for (const listener of [...(listeners.get(type) || [])]) listener({ detail });
    };
    let profileDetail = null;
    let playCount = 0;
    const video = {
        currentTime: 120,
        seekable: ranges([[100, 160]]),
        play() { playCount++; return Promise.resolve(); }
    };
    const controller = experience.createController({
        document,
        window: {
            location: { pathname: '/channel', hostname: 'www.twitch.tv' },
            setTimeout,
            clearTimeout
        },
        api: {
            storage: {
                local: {
                    async get() { return { data: {} }; },
                    async set() {}
                }
            }
        },
        getVideo: () => video,
        applyPlaybackProfile(detail) { profileDetail = detail; }
    });

    emit('ytbtw-experience-action', { action: 'liveEdge' });
    assert.equal(video.currentTime, 159.95);
    assert.equal(playCount, 1);
    emit('ytb-apply-playback-profile', {
        site: 'twitch', volumeBoost: 1.5, quality: 'current'
    });
    assert.equal(profileDetail.volumeBoost, 1.5);

    video.currentTime = 120;
    for (const listener of [...(listeners.get('keydown') || [])]) {
        listener({
            defaultPrevented: true,
            repeat: false,
            key: 'ArrowRight',
            shiftKey: true,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            target: null
        });
    }
    assert.equal(video.currentTime, 120,
        'the local seek handler respects actions already handled by shared bindings');

    controller.retire();
    profileDetail = null;
    emit('ytb-apply-playback-profile', { site: 'twitch', volumeBoost: 2 });
    assert.equal(profileDetail, null);
});

test('chat overlay moves the live chat node and restores the exact original layout', () => {
    function domNode(tag) {
        const classes = new Set();
        return {
            tag,
            nodeType: tag === '#comment' ? 8 : 1,
            children: [],
            parentNode: null,
            dataset: {},
            id: '',
            classList: {
                add: (...items) => items.forEach(item => classes.add(item)),
                remove: (...items) => items.forEach(item => classes.delete(item)),
                toggle(item, force) {
                    if (force === true) classes.add(item);
                    else if (force === false) classes.delete(item);
                    else if (classes.has(item)) classes.delete(item);
                    else classes.add(item);
                },
                contains: item => classes.has(item)
            },
            style: { setProperty() {}, removeProperty() {} },
            setAttribute(name, value) { this[name] = String(value); },
            getAttribute() { return null; },
            appendChild(child) { return this.insertBefore(child, null); },
            insertBefore(child, before) {
                if (child.parentNode) {
                    child.parentNode.children = child.parentNode.children.filter(item => item !== child);
                }
                child.parentNode = this;
                const index = before ? this.children.indexOf(before) : -1;
                if (index < 0) this.children.push(child);
                else this.children.splice(index, 0, child);
                return child;
            },
            remove() {
                if (this.parentNode) {
                    this.parentNode.children = this.parentNode.children.filter(item => item !== this);
                    this.parentNode = null;
                }
            },
            closest() { return null; },
            querySelector() { return null; },
            matches() { return false; },
            get isConnected() {
                let node = this;
                while (node.parentNode) node = node.parentNode;
                return node.tag === 'body';
            },
            get nextSibling() {
                if (!this.parentNode) return null;
                const index = this.parentNode.children.indexOf(this);
                return this.parentNode.children[index + 1] || null;
            }
        };
    }

    const body = domNode('body');
    const container = body.appendChild(domNode('container'));
    const column = body.appendChild(domNode('column'));
    const chat = column.appendChild(domNode('chat'));
    const sibling = column.appendChild(domNode('sibling'));

    const listeners = new Map();
    const doc = {
        hidden: false,
        activeElement: null,
        body,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
            const set = listeners.get(type);
            if (set) set.delete(listener);
        },
        createElement: tag => domNode(tag),
        createComment: () => domNode('#comment'),
        getElementById(id) {
            const found = [];
            (function walk(node) {
                for (const child of node.children) {
                    if (child.id === id) found.push(child);
                    walk(child);
                }
            })(body);
            return found[0] || null;
        },
        querySelector(selector) {
            if (selector.includes('video-player')) return container;
            if (selector.includes('channel-root__right-column')) return chat;
            return null;
        }
    };
    const emit = (type, detail) => {
        for (const listener of [...(listeners.get(type) || [])]) listener({ detail });
    };

    const controller = experience.createController({
        document: doc,
        window: {
            location: { pathname: '/channel', hostname: 'www.twitch.tv' },
            setTimeout,
            clearTimeout
        },
        api: {
            storage: {
                local: {
                    async get() { return { data: {} }; },
                    async set() {}
                }
            }
        }
    });

    emit('ytbtw-experience-action', { action: 'chatOverlay' });
    assert.equal(controller.isOverlayActive(), true);
    const host = doc.getElementById('ytbtw-chat-overlay');
    assert.ok(host, 'the overlay host is mounted in the player container');
    assert.equal(host.parentNode, container);
    assert.equal(chat.parentNode, host, 'the existing chat node is reused, not cloned');
    assert.equal(chat.classList.contains('ytbtw-overlay-chat-node'), true);
    assert.equal(column.children.length, 2, 'a placeholder marks the original chat position');

    emit('ytbtw-experience-action', { action: 'chatOverlay' });
    assert.equal(controller.isOverlayActive(), false);
    assert.equal(doc.getElementById('ytbtw-chat-overlay'), null, 'the overlay host is removed');
    assert.deepEqual(column.children.map(node => node.tag), ['chat', 'sibling'],
        'the chat node returns to its exact original position');
    assert.equal(chat.classList.contains('ytbtw-overlay-chat-node'), false);

    emit('ytbtw-experience-action', { action: 'chatOverlay' });
    assert.equal(controller.isOverlayActive(), true);
    controller.retire();
    assert.equal(doc.getElementById('ytbtw-chat-overlay'), null);
    assert.deepEqual(column.children.map(node => node.tag), ['chat', 'sibling'],
        'retiring the controller restores the original layout too');
});

test('sidebar projection pins favourites, filters groups, and never duplicates a login', () => {
    const model = {
        favourites: ['gamma', 'alpha'],
        groups: [{ id: 'speedruns', name: 'Speedruns', members: ['beta', 'gamma'] }]
    };
    const entries = [
        { login: 'alpha', label: 'Alpha', nativeIndex: 0 },
        { login: 'beta', label: 'Beta Runner', nativeIndex: 1 },
        { login: 'gamma', label: 'Gamma', nativeIndex: 2 },
        { login: 'alpha', label: 'Alpha duplicate', nativeIndex: 3 }
    ];
    const all = experience.sidebarProjection(model, entries, '', 'all');
    assert.deepEqual(all.map(item => item.login), ['gamma', 'alpha', 'beta']);
    const group = experience.sidebarProjection(model, entries, 'run', 'speedruns');
    assert.deepEqual(group.filter(item => item.visible).map(item => item.login), ['beta']);
});

test('collapsed groups tuck non-favourite members out of the default view only', () => {
    const model = {
        favourites: ['gamma'],
        groups: [{ id: 'speedruns', name: 'Speedruns', collapsed: true, members: ['beta', 'gamma'] }]
    };
    const entries = [
        { login: 'alpha', label: 'Alpha', nativeIndex: 0 },
        { login: 'beta', label: 'Beta Runner', nativeIndex: 1 },
        { login: 'gamma', label: 'Gamma', nativeIndex: 2 }
    ];
    const all = experience.sidebarProjection(model, entries, '', 'all');
    assert.deepEqual(all.filter(item => item.visible).map(item => item.login), ['gamma', 'alpha'],
        'collapsed members hide while favourites stay pinned');
    const searched = experience.sidebarProjection(model, entries, 'beta', 'all');
    assert.deepEqual(searched.filter(item => item.visible).map(item => item.login), ['beta'],
        'an explicit search reveals collapsed members');
    const grouped = experience.sidebarProjection(model, entries, '', 'speedruns');
    assert.deepEqual(grouped.filter(item => item.visible).map(item => item.login), ['beta', 'gamma'],
        'the group view still lists collapsed members');
});

class FakeElement {
    constructor(tag, options = {}) {
        this.nodeType = 1;
        this.tag = tag;
        this.parentElement = options.parent || null;
        this.href = options.href || '';
        this.label = options.label || '';
        this.children = options.children || [];
        this.queryCount = 0;
        for (const child of this.children) child.parentElement = this;
    }
    matches(selector) {
        return selector.split(',').some(part => part.trim() === this.tag);
    }
    closest(selector) {
        let node = this;
        while (node) {
            if (node.matches && node.matches(selector)) return node;
            node = node.parentElement;
        }
        return null;
    }
    querySelectorAll(selector) {
        this.queryCount++;
        const out = [];
        const visit = node => {
            for (const child of node.children || []) {
                if (child.matches(selector)) out.push(child);
                visit(child);
            }
        };
        visit(this);
        return out;
    }
    querySelector(selector) {
        if (selector === 'a[href]') return this.tag === 'a[href]' ? this :
            this.children.find(child => child.tag === 'a[href]') || null;
        if (selector.includes('side-nav-title') || selector.includes('p')) {
            return { textContent: this.label, getAttribute() { return null; } };
        }
        return null;
    }
    getAttribute(name) {
        if (name === 'href') return this.href;
        if (name === 'aria-label') return this.label || null;
        return null;
    }
}

test('identity extraction follows a recycled native sidebar entry', () => {
    const anchor = new FakeElement('a[href]', { href: '/first_user' });
    const card = new FakeElement('.side-nav-card', { label: 'First User', children: [anchor] });
    assert.equal(experience.extractSidebarIdentity(card).login, 'first_user');
    anchor.href = '/second_user';
    card.label = 'Second User';
    const recycled = experience.extractSidebarIdentity(card);
    assert.equal(recycled.login, 'second_user');
    assert.match(recycled.signature, /^second_user\|/);
});

test('600-card initial mutations and later appends stay dirty-subtree bounded', () => {
    const initialCards = Array.from({ length: 600 }, () => new FakeElement('article'));
    const initialRoot = new FakeElement('root', { children: initialCards });
    let processed = 0;
    const initial = experience.processMutationElements([{
        type: 'childList', target: initialRoot, addedNodes: [initialRoot]
    }], 'article', 1000, () => { processed++; });
    assert.equal(initial.size, 600);
    assert.equal(processed, 600);

    const originalQueries = initialRoot.queryCount;
    const appendedCards = Array.from({ length: 24 }, () => new FakeElement('article'));
    const appendRoot = new FakeElement('root', {
        parent: initialRoot,
        children: appendedCards
    });
    const append = experience.processMutationElements([{
        type: 'childList', target: initialRoot, addedNodes: [appendRoot]
    }], 'article', 1000, () => { processed++; });
    assert.equal(append.size, 24);
    assert.equal(processed, 624);
    assert.equal(initialRoot.queryCount, originalQueries,
        'later mutation processing must not revisit the original 600-card subtree');
});

test('chat message batches collect each inserted line once without container rescans', () => {
    const backlog = Array.from({ length: 200 }, () => new FakeElement('.chat-line__message'));
    const container = new FakeElement('container', { children: backlog });
    let processed = 0;
    experience.processMutationElements([{
        type: 'childList', target: container, addedNodes: [container]
    }], '.chat-line__message', 1000, () => { processed++; });
    assert.equal(processed, 200);

    const containerQueries = container.queryCount;
    const batch = Array.from({ length: 40 }, () => new FakeElement('.chat-line__message', {
        parent: container
    }));
    const dirty = experience.processMutationElements([{
        type: 'childList', target: container, addedNodes: batch
    }], '.chat-line__message', 1000, () => { processed++; });
    assert.equal(dirty.size, 40, 'a chat batch collects exactly the inserted lines');
    assert.equal(processed, 240);
    assert.equal(container.queryCount, containerQueries,
        'a chat batch must not rescan the existing message backlog');

    const flood = Array.from({ length: 80 }, () => new FakeElement('.chat-line__message'));
    const bounded = experience.collectMutationElements([{
        type: 'childList', target: container, addedNodes: flood
    }], '.chat-line__message', 25);
    assert.equal(bounded.size, 25, 'chat floods stay bounded by the batch limit');
});

test('overlay and diagnostics normalization fail safe without sensitive fields', () => {
    assert.deepEqual(experience.normalizeOverlay({
        opacity: 5, width: 9999, fontScale: 0.1, placement: 'centre',
        autoHideMs: -1, clickThrough: false, interactive: true
    }), {
        opacity: 1,
        width: 700,
        fontScale: 0.75,
        placement: 'right',
        autoHideMs: 0,
        clickThrough: false,
        interactive: true
    });
    const diagnostics = experience.normalizeDiagnostics({
        status: 'retrying', attempts: 99, lastErrorKind: 'media-network',
        lastErrorAt: 100, lastRecoveredAt: 50,
        url: 'https://www.twitch.tv/private', message: 'sensitive chat text'
    });
    assert.deepEqual(Object.keys(diagnostics).sort(), [
        'attempts', 'lastErrorAt', 'lastErrorKind', 'lastRecoveredAt', 'status'
    ]);
    assert.equal(diagnostics.attempts, 6);
});
