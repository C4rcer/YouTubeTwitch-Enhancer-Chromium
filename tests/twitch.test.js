/* eslint-env node */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { NodeFilter, h, createDocument } = require('./mini-dom');

const TWITCH_PATH = path.join(__dirname, '..', 'src', 'twitch.js');

// Loads twitch.js without init(): no storage load, observers or intervals.
// Time is manual: advance() moves Date.now() and runs due timers.
function loadTwitch(options = {}) {
    const document = createDocument(...(options.body || []));
    document.hidden = options.hidden !== false;
    const sent = [];
    const clock = { now: 1700000000000 };
    const timers = new Map();
    let timerId = 0;
    const context = {
        console,
        URL,
        URLSearchParams,
        NodeFilter,
        document,
        location: {
            hostname: 'www.twitch.tv',
            pathname: options.pathname || '/drops/inventory',
            hash: '#ytbtw-autoclaim',
            search: '',
            href: 'https://www.twitch.tv' + (options.pathname || '/drops/inventory') + '#ytbtw-autoclaim'
        },
        browser: {
            runtime: {
                onMessage: { addListener() {} },
                // Chromium relays emote lookups through the background service
                // worker (ytb-fetch-json); answer them the way it does.
                sendMessage: async message => {
                    if (message && message.action === 'ytb-fetch-json') {
                        const r = await context.fetch(message.url);
                        return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: 'HTTP ' + r.status };
                    }
                    sent.push(message);
                },
                getURL: p => 'moz-extension://test/' + p
            },
            storage: {
                local: { get: async () => ({}), set: async () => {} },
                onChanged: { addListener() {}, removeListener() {} }
            }
        },
        fetch: options.fetch || (() => new Promise(() => {})),
        CustomEvent: class CustomEvent {
            constructor(type, init) { this.type = type; this.detail = init && init.detail; }
        },
        MutationObserver: class MutationObserver { observe() {} disconnect() {} },
        Date: class FakeDate extends Date {
            static now() { return clock.now; }
        },
        setTimeout(fn, ms) {
            timers.set(++timerId, { fn, at: clock.now + (ms || 0) });
            return timerId;
        },
        clearTimeout(id) { timers.delete(id); },
        setInterval: () => 0,
        clearInterval() {},
        requestAnimationFrame() {},
        // Page-world bridges (page-twitch.js) talk over window messages.
        addEventListener() {},
        removeEventListener() {},
        postMessage() {}
    };
    context.window = context;
    context.self = context;

    let source = fs.readFileSync(TWITCH_PATH, 'utf8');
    const hook = `
    self.__YTBTW_TEST__ = {
        isDropClaimLabel,
        claimInventoryHere,
        autoClaimDrops,
        autoClaim,
        maybeFetchEmotes,
        categoryFromTarget,
        configure(input) { settings = Object.assign({}, DEFAULT_SETTINGS, input); },
        // What init() does for a tab opened at #ytbtw-autoclaim.
        armInventoryClose() { inventoryArmedAt = Date.now(); },
        setChat(container) { chatContainer = container; },
        emotes() { return emoteMap; },
        emoteRound() { return { inFlight: emoteFetchInFlight, loaded: emoteGlobalsLoaded }; }
    };
`;
    const marker = /    init\(\);\r?\n\}\)\(\);\s*$/;
    assert.match(source, marker, 'twitch test hook marker must stay stable');
    source = source.replace(marker, hook + '})();');
    vm.createContext(context);
    vm.runInContext(source, context, { filename: TWITCH_PATH });

    function advance(ms) {
        const until = clock.now + ms;
        for (;;) {
            const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            timers.delete(due[0]);
            clock.now = Math.max(clock.now, due[1].at);
            due[1].fn();
        }
        clock.now = until;
    }

    return Object.assign(context.__YTBTW_TEST__, { document, sent, advance });
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('drop claim labels cover Twitch UI languages and fail closed', () => {
    const tw = loadTwitch();
    for (const label of ['Claim Now', 'Claim', ' Claim\n  Now ', 'Jetzt abholen',
        'Reclamar ahora', '今すぐ入手', 'Kiváltás most!', 'Şimdi Al']) {
        assert.equal(tw.isDropClaimLabel(label), true, label);
    }
    // "Connect" sits beside "Claim Now" in the same reward component; bare
    // "Abholen"/"Riscatta" are also Twitch's "Redeem"/"Claim" elsewhere.
    for (const label of ['Connect', 'Verknüpfen', 'Abholen', 'Riscatta', 'Claimed',
        'Claim the previous reward to start earning progress toward this one', '']) {
        assert.equal(tw.isDropClaimLabel(label), false, label);
    }
});

test('the inventory pass clicks claim controls in main only', () => {
    const claim = h('button', {}, h('div', { 'data-a-target': 'tw-core-button-label-text' }, 'Jetzt abholen'));
    const connect = h('button', {}, 'Verknüpfen');
    const disabled = h('button', { disabled: true }, 'Jetzt abholen');
    const popoverLink = h('a', { href: '/drops/inventory' }, 'Claim');
    const outside = h('button', {}, 'Claim Now');
    const tw = loadTwitch({
        body: [h('nav', {}, outside), h('main', {}, claim, connect, disabled, popoverLink)]
    });

    assert.equal(tw.claimInventoryHere(), 1);
    assert.equal(claim.clicks, 1);
    assert.equal(connect.clicks + disabled.clicks + popoverLink.clicks + outside.clicks, 0);
});

test('an auto-claim tab waits for the inventory to render before closing', () => {
    const main = h('main', {});
    const tw = loadTwitch({ body: [main] });
    tw.configure({});
    tw.armInventoryClose();

    // The first passes run before Twitch has rendered the inventory.
    tw.autoClaimDrops();
    tw.advance(2500); tw.autoClaimDrops();
    tw.advance(2500); tw.autoClaimDrops();
    tw.advance(2500); tw.autoClaimDrops();
    assert.deepEqual(tw.sent, [], 'no close before anything could be claimed');

    const claim = h('button', {}, 'Claim Now');
    main.appendChild(claim);
    tw.advance(2500); tw.autoClaimDrops();
    assert.equal(claim.clicks, 1);
    claim.remove();   // Twitch swaps the button out once the claim lands

    tw.advance(2500); tw.autoClaimDrops();
    assert.deepEqual(tw.sent, [], 'the claim request gets time to go out');
    tw.advance(4000); tw.autoClaimDrops();
    assert.deepEqual(tw.sent.map(m => m.action), ['ytbtw-close-self']);
    tw.advance(10000); tw.autoClaimDrops();
    assert.equal(tw.sent.length, 1, 'asks to close once');
});

test('an auto-claim tab with nothing to claim gives up, unless the user is on it', () => {
    const idle = loadTwitch({ body: [h('main', {})] });
    idle.configure({});
    idle.armInventoryClose();
    for (let t = 0; t < 27500; t += 2500) { idle.autoClaimDrops(); idle.advance(2500); }
    idle.autoClaimDrops();
    assert.deepEqual(idle.sent, [], 'still waiting at 27.5 s');
    idle.advance(2500); idle.autoClaimDrops();
    assert.deepEqual(idle.sent.map(m => m.action), ['ytbtw-close-self']);

    const watched = loadTwitch({ body: [h('main', {})], hidden: false });
    watched.configure({});
    watched.armInventoryClose();
    watched.advance(31000); watched.autoClaimDrops();
    assert.deepEqual(watched.sent, [], 'a tab the user switched to stays open');
});

// The channel-points bonus as the live summary renders it (2026-11-07).
function pointsSummary() {
    const icon = h('div', { class: 'claimable-bonus__icon' });
    const button = h('button', { 'aria-label': 'Claim Bonus' }, icon);
    const summary = h('div', { 'data-test-selector': 'community-points-summary' }, button);
    return { summary, button, icon };
}

function loadChannel(summary) {
    const tw = loadTwitch({ body: [summary], pathname: '/opie420247', hidden: false });
    tw.configure({});
    tw.toastText = () => {
        const el = tw.document.getElementById('ytbtw-toast');
        return el ? el.textContent : '';
    };
    return tw;
}

test('channel points: a disabled claim button is never clicked or reported', () => {
    // The grey chest found live: Twitch's earlier claim never settled.
    const { summary, button } = pointsSummary();
    button.disabled = true;
    const tw = loadChannel(summary);
    for (let t = 0; t < 60000; t += 2500) { tw.autoClaim(); tw.advance(2500); }
    assert.equal(button.clicks, 0);
    assert.equal(tw.toastText(), '');
});

test('channel points: "Claimed" waits for Twitch to remove the bonus', () => {
    const { summary, button } = pointsSummary();
    const tw = loadChannel(summary);
    tw.autoClaim();
    assert.equal(button.clicks, 1);
    assert.equal(tw.toastText(), '', 'nothing is claimed yet when the click goes out');

    button.disabled = true;   // Twitch's request is in flight
    tw.advance(250);
    assert.equal(tw.toastText(), '');
    button.disabled = false;  // settled; the bonus slides out
    tw.advance(250);
    assert.equal(tw.toastText(), '');
    button.remove();
    tw.advance(250);
    assert.equal(tw.toastText(), 'Claimed channel points +bonus');
});

test('channel points: a claim Twitch rejects is not reported as claimed', () => {
    const { summary, button, icon } = pointsSummary();
    const tw = loadChannel(summary);
    tw.autoClaim();
    button.disabled = true;
    tw.advance(250);
    button.disabled = false;  // red error state: the icon loses its class
    icon.classList.remove('claimable-bonus__icon');
    tw.advance(250);
    tw.autoClaim();
    assert.equal(button.clicks, 1, 'the error state is not clicked again');
    tw.advance(2000);
    button.remove();          // Twitch drops the bonus 2 s after an error
    tw.advance(250);
    assert.equal(tw.toastText(), 'Twitch couldn’t claim the channel points bonus');
});

test('channel points: a claim that never settles is reported once, not retried', () => {
    const { summary, button } = pointsSummary();
    const tw = loadChannel(summary);
    tw.autoClaim();
    button.disabled = true;   // "failed integrity check" and no way to answer it
    for (let t = 0; t < 30000; t += 2500) { tw.advance(2500); tw.autoClaim(); }
    assert.equal(tw.toastText(), 'Twitch hasn’t confirmed the channel points claim');
    tw.document.getElementById('ytbtw-toast').textContent = '';
    for (let t = 0; t < 60000; t += 2500) { tw.advance(2500); tw.autoClaim(); }
    assert.equal(button.clicks, 1);
    assert.equal(tw.toastText(), '', 'the stuck notice is shown once');
});

// Markup shapes below mirror the live pages (2026-11-01).
function sideNavCard(login, category) {
    return h('div', { class: 'side-nav-card' },
        h('a', { 'data-test-selector': 'followed-channel', href: '/' + login },
            h('div', { 'data-a-target': 'side-nav-card-metadata' },
                h('p', { 'data-a-target': 'side-nav-title', title: login }, login),
                h('p', { title: category }, category))));
}

test('a right-click anywhere on a Browse category card means that category', () => {
    const boxArt = h('img', { alt: 'Just Chatting cover image' });
    const irlPill = h('button', { 'data-a-target': 'IRL', 'aria-label': 'Tag, IRL' }, 'IRL');
    const padding = h('div', {});
    const tw = loadTwitch({
        pathname: '/directory',
        body: [h('div', { class: 'tw-tower' },
            h('div', {},
                h('a', { 'data-a-target': 'tw-box-art-card-link', href: '/directory/category/just-chatting' }, boxArt),
                h('h2', { title: 'Just Chatting' }, h('a', { href: '/directory/category/just-chatting' }, 'Just Chatting')),
                h('a', { href: '/directory/category/just-chatting' }, '269K viewers'),
                padding, irlPill))]
    });
    for (const target of [boxArt, irlPill, padding]) {
        assert.deepEqual({ ...tw.categoryFromTarget(target) }, { slug: 'just-chatting', name: 'Just Chatting' });
    }
});

test('a home shelf category card is named by its title, not its whole text', () => {
    const viewers = h('p', {}, '266K live viewers');
    const tw = loadTwitch({
        pathname: '/',
        body: [h('a', { href: '/directory/category/just-chatting' },
            h('p', { title: 'Just Chatting' }, 'Just Chatting'),
            h('span', { title: 'IRL' }, 'IRL'),
            viewers)]
    });
    assert.deepEqual({ ...tw.categoryFromTarget(viewers) }, { slug: 'just-chatting', name: 'Just Chatting' });
});

test('stream cards and the featured carousel resolve to their own category', () => {
    const thumb = h('img', {});
    const video = h('video', {});
    const tw = loadTwitch({
        pathname: '/',
        body: [
            h('div', { 'data-a-target': 'front-page-carousel' },
                video, h('a', { href: '/anniesatv' }, 'anniesatv'),
                h('a', { href: '/directory/category/aion-2' }, 'AION 2')),
            h('article', {},
                h('a', { 'data-a-target': 'preview-card-image-link', href: '/jantuneee' }, thumb),
                h('a', { 'data-a-target': 'preview-card-game-link', href: '/directory/category/wardogs' }, 'WARDOGS'),
                h('a', { href: '/directory/all/tags/PUBG' }, 'PUBG'))
        ]
    });
    assert.deepEqual({ ...tw.categoryFromTarget(thumb) }, { slug: 'wardogs', name: 'WARDOGS' });
    assert.deepEqual({ ...tw.categoryFromTarget(video) }, { slug: 'aion-2', name: 'AION 2' });
});

test('a sidebar card never falls through to the watched stream category', () => {
    const streamGame = h('a', { 'data-a-target': 'stream-game-link', href: '/directory/category/hunt-showdown' },
        h('span', {}, 'Hunt: Showdown 1896'));
    const other = sideNavCard('someone', 'Just Chatting');
    const same = sideNavCard('arskanator', 'Hunt: Showdown 1896');
    const tw = loadTwitch({ pathname: '/arskanator', body: [h('nav', {}, other, same), h('main', {}, streamGame)] });

    // Only a name: matched against a category link on the page when there is one.
    assert.deepEqual({ ...tw.categoryFromTarget(same.querySelector('p[title="Hunt: Showdown 1896"]')) },
        { slug: 'hunt-showdown', name: 'Hunt: Showdown 1896' });
    assert.deepEqual({ ...tw.categoryFromTarget(other.querySelector('p[title="Just Chatting"]')) },
        { slug: '', name: 'Just Chatting' }, 'unresolved, not hunt-showdown');
    // A right-click elsewhere on the channel page still means the stream's category.
    assert.equal(tw.categoryFromTarget(h('div', {})).slug, 'hunt-showdown');
});

test('collection shelves and pages are reported as collections, not categories', () => {
    const heading = h('a', { href: '/directory/collection/just-chatting-irl-streams' }, 'Just Chatting & IRL');
    const showAll = h('a', { href: '/directory/collection/just-chatting-irl-streams' }, 'Show all');
    const home = loadTwitch({ pathname: '/', body: [h('h2', {}, heading), showAll] });
    assert.deepEqual({ ...home.categoryFromTarget(heading) }, { slug: '', collection: true });
    assert.deepEqual({ ...home.categoryFromTarget(showAll) }, { slug: '', collection: true });

    const page = loadTwitch({ pathname: '/directory/collection/just-chatting-irl-streams', body: [h('main', {})] });
    assert.deepEqual({ ...page.categoryFromTarget(h('div', {})) }, { slug: '', collection: true });
});

test('a container naming more than one category resolves to none', () => {
    const blank = h('div', {});
    const tw = loadTwitch({
        pathname: '/directory',
        body: [h('div', { class: 'tw-tower' }, h('div', {},
            h('a', { href: '/directory/category/rust' }, 'Rust'),
            h('a', { href: '/directory/category/irl' }, 'IRL'),
            blank))]
    });
    assert.equal(tw.categoryFromTarget(blank), null);
});

test('a hung emote provider holds back neither the others nor the round', async () => {
    let resolve7tv;
    const fetch = url => {
        // Accepts the connection and never answers.
        if (url.includes('frankerfacez')) return new Promise(() => {});
        if (url === 'https://api.betterttv.net/3/cached/emotes/global') {
            return Promise.resolve({ ok: true, json: async () => [{ id: 'b1', code: 'catJAM' }] });
        }
        if (url === 'https://7tv.io/v3/emote-sets/global') {
            return new Promise(resolve => {
                resolve7tv = () => resolve({
                    ok: true,
                    json: async () => ({ emotes: [{ name: 'KEKW', data: { host: { url: '//cdn.7tv.app/emote/k1' } } }] })
                });
            });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    };
    const text = h('span', { 'data-a-target': 'chat-message-text' }, 'catJAM hello KEKW');
    const container = h('div', { class: 'chat-scrollable-area__message-container' },
        h('div', { class: 'chat-line__message' }, text));
    const tw = loadTwitch({ pathname: '/somechannel', body: [container], fetch });
    tw.configure({ twEmotes: true });   // off by default on Chromium
    tw.setChat(container);

    tw.maybeFetchEmotes();
    await flush();
    assert.equal(tw.emotes().has('catJAM'), true, 'BTTV is published while FFZ hangs');
    assert.deepEqual(text.querySelectorAll('img.ytbtw-emote').map(img => img.alt), ['catJAM']);

    resolve7tv();
    await flush();
    assert.deepEqual(text.querySelectorAll('img.ytbtw-emote').map(img => img.alt), ['catJAM', 'KEKW'],
        'a later provider still renders into an already-rewritten message');
    assert.equal(text.textContent, ' hello ');
    assert.equal(tw.emoteRound().inFlight, true, 'FFZ is still pending');

    tw.advance(8000);
    await flush();
    assert.equal(tw.emoteRound().inFlight, false,
        'the timeout ends the round instead of waiting on FFZ forever');
    assert.equal(tw.emoteRound().loaded, true);
});
