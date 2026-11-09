/* eslint-env node */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { fakeQualityPlayer, replayNavigationReset } = require('./quality-fixture');

// Runs the MAIN-world helper against a fake page; send() is content.js's
// postMessage of one request.
function loadPageQuality(player) {
    const listeners = [];
    const posted = [];
    const documentListeners = {};
    const context = {
        console,
        Date,
        JSON,
        location: { origin: 'https://www.youtube.com' },
        CustomEvent: class CustomEvent {
            constructor(type, init) { this.type = type; this.detail = init && init.detail; }
        },
        document: {
            getElementById: id => (id === 'movie_player' ? player : null),
            addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); },
            removeEventListener(type, fn) {
                documentListeners[type] = (documentListeners[type] || []).filter(item => item !== fn);
            },
            dispatchEvent(event) {
                (documentListeners[event.type] || []).slice().forEach(fn => fn(event));
                return true;
            }
        },
        addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
        postMessage(message) { posted.push(message); }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'page-quality.js'), 'utf8'), context);
    // The helper only trusts messages from its own window, which inside the
    // context is the global proxy, not `context` itself.
    const pageWindow = vm.runInContext('window', context);
    const send = data => listeners.forEach(fn => fn({ source: pageWindow, data }));
    return { send, posted, document: context.document, CustomEvent: context.CustomEvent };
}

test('the MAIN-world helper keeps max quality through the post-navigation reset', () => {
    const player = fakeQualityPlayer();
    const page = loadPageQuality(player);
    let vid = 'previousVid';
    replayNavigationReset(player, next => { vid = next; },
        () => page.send({ type: 'ytb-max-quality', vid }));
    assert.equal(page.posted.length, 0, 'nothing to answer: content.js asks every pass');
});

test('the MAIN-world helper waits until the player is on the requested video', () => {
    const player = fakeQualityPlayer();
    const page = loadPageQuality(player);
    player.preferred = 'large';
    page.send({ type: 'ytb-max-quality', vid: 'nextVideo01' });
    assert.equal(player.sets, 0, "the previous video's streams are not this video's");
    player.vid = 'nextVideo01';
    page.send({ type: 'ytb-max-quality', vid: 'nextVideo01' });
    assert.equal(player.preferred, 'hd2160');
});

test('the MAIN-world helper answers a live query before dispatchEvent returns', () => {
    // As seen 2026-11-09 on a live stream: getVideoData() says isLive while
    // #movie_player no longer carries a "ytp-live" class.
    const player = { getVideoData: () => ({ video_id: 'liveStream1', isLive: true }) };
    const page = loadPageQuality(player);
    // content.js's side of the exchange.
    const ask = () => {
        let reply = null;
        const onReply = event => { reply = event.detail; };
        page.document.addEventListener('ytb-live-data', onReply);
        page.document.dispatchEvent(new page.CustomEvent('ytb-live-query'));
        page.document.removeEventListener('ytb-live-data', onReply);
        return reply;
    };
    assert.deepEqual(JSON.parse(ask()), { videoId: 'liveStream1', isLive: true });
    assert.equal(typeof ask(), 'string', 'the answer crosses worlds as a string');

    player.getVideoData = () => ({ video_id: 'normalVid01', isLive: false });
    assert.deepEqual(JSON.parse(ask()), { videoId: 'normalVid01', isLive: false });

    player.getVideoData = () => { throw new Error('player API changed'); };
    assert.equal(ask(), null, 'no answer: content.js falls back to the DOM');
    delete player.getVideoData;
    assert.equal(ask(), null);
    assert.equal(page.posted.length, 0, 'no window messages are involved');
});
