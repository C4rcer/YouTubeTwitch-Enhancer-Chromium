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
    const context = {
        console,
        Date,
        location: { origin: 'https://www.youtube.com' },
        document: { getElementById: id => (id === 'movie_player' ? player : null) },
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
    return { send, posted };
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
