/* eslint-env node */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCommon() {
    const storage = {};
    const context = {
        console,
        Blob: global.Blob,
        URL: global.URL,
        setTimeout,
        clearTimeout,
        browser: {
            storage: {
                local: {
                    async get(key) {
                        if (typeof key === 'string') return { [key]: storage[key] };
                        return {};
                    },
                    async set(value) { Object.assign(storage, value); }
                },
                onChanged: { addListener() {} }
            }
        }
    };
    context.chrome = context.browser;
    context.globalThis = context;
    vm.createContext(context);
    const featureSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'feature-core.js'), 'utf8');
    const commonSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'common.js'), 'utf8');
    vm.runInContext(featureSource + '\n' + commonSource + '\n;globalThis.__YTB = YTB;', context);
    return { YTB: context.__YTB, storage };
}

test('common normalization supplies and clamps the new feature schema', () => {
    const { YTB } = loadCommon();
    const data = YTB.normalize({
        settings: {
            twSeekStep: 999,
            twChatOverlayOpacity: -2,
            twChatOverlayWidth: 99,
            twChatOverlayFontScale: 9,
            twChatOverlayPlacement: 'centre',
            settingsTheme: 'neon',
            settingsMode: 'expert'
        },
        inputBindings: {
            youtube: {
                keyboard: { playPause: 'space' },
                mouse: {},
                wheel: {}
            }
        },
        playbackProfiles: [{ id: 'lecture', name: 'Lecture', speed: 1.5 }],
        ytCollections: [{ id: 'news', name: 'News', channels: [{ handle: 'example' }] }],
        twitchSidebar: { favorites: ['streamer'], groups: [] }
    });
    assert.equal(data.settings.twSeekStep, 60);
    assert.equal(data.settings.twChatOverlayOpacity, 0.2);
    assert.equal(data.settings.twChatOverlayWidth, 260);
    assert.equal(data.settings.twChatOverlayFontScale, 1.75);
    assert.equal(data.settings.twChatOverlayPlacement, 'right');
    assert.equal(data.settings.settingsTheme, 'system');
    assert.equal(data.settings.settingsMode, 'basic');
    assert.equal(data.inputBindings.youtube.keyboard.playPause, 'Space');
    assert.ok(data.playbackProfiles.some(profile => profile.id === 'default'));
    assert.ok(data.playbackProfiles.some(profile => profile.id === 'lecture'));
    assert.equal(data.ytCollections[0].channels[0].key, 'handle:example');
    assert.equal(data.twitchSidebar.favorites[0].login, 'streamer');
});

test('common save retains normalized feature data in the shared record', async () => {
    const { YTB, storage } = loadCommon();
    await YTB.save({
        settings: {},
        channelPlaybackProfiles: {
            youtube: { 'handle:example': 'lecture' },
            twitch: {}
        },
        playbackProfiles: [
            { id: 'lecture', name: 'Lecture', sites: ['youtube'], speed: 1.4 }
        ]
    });
    assert.equal(storage.data.channelPlaybackProfiles.youtube['handle:example'], 'lecture');
    assert.equal(storage.data.playbackProfiles.find(p => p.id === 'lecture').speed, 1.4);
});

test('merge import unions local collections/sidebar without replacing collisions', () => {
    const { YTB } = loadCommon();
    const current = {
        settings: {},
        ytCollections: [{
            id: 'news',
            name: 'News',
            channels: [{ handle: 'one', name: 'One' }]
        }],
        twitchSidebar: {
            favorites: ['one'],
            groups: [{ id: 'team', name: 'Team', channels: ['one'] }]
        },
        playbackProfiles: [{ id: 'local', name: 'Local', speed: 1.2 }]
    };
    const incoming = {
        ytCollections: [{
            id: 'news',
            name: 'Remote name',
            channels: [{ handle: 'two', name: 'Two' }]
        }],
        twitchSidebar: {
            favorites: ['two'],
            groups: [{ id: 'team', name: 'Remote team', channels: ['two'] }]
        },
        playbackProfiles: [{ id: 'remote', name: 'Remote', speed: 1.6 }]
    };
    const merged = YTB.mergeImport(current, incoming).data;
    assert.deepEqual(
        [...merged.ytCollections[0].channels.map(channel => channel.handle)].sort(),
        ['one', 'two']
    );
    assert.deepEqual(
        [...merged.twitchSidebar.favorites.map(channel => channel.login)].sort(),
        ['one', 'two']
    );
    assert.deepEqual(
        [...merged.twitchSidebar.groups[0].channels.map(channel => channel.login)].sort(),
        ['one', 'two']
    );
    assert.ok(merged.playbackProfiles.some(profile => profile.id === 'local'));
    assert.ok(merged.playbackProfiles.some(profile => profile.id === 'remote'));
});

test('merge import preserves Twitch player and overlay preferences when selected', () => {
    const { YTB } = loadCommon();
    const merged = YTB.mergeImport({
        settings: {},
        twitchPlayer: { seekStep: 5, maxRetries: 2 },
        twitchChatOverlay: { width: 300, opacity: 0.5 }
    }, {
        twitchPlayer: { seekStep: 25, maxRetries: 5 },
        twitchChatOverlay: { width: 500, opacity: 0.75 }
    }).data;
    assert.equal(merged.twitchPlayer.seekStep, 25);
    assert.equal(merged.twitchPlayer.maxRetries, 5);
    assert.equal(merged.twitchChatOverlay.width, 500);
    assert.equal(merged.twitchChatOverlay.opacity, 0.75);
});
test('feature-only backups are accepted as valid imports', () => {
    const { YTB } = loadCommon();
    assert.equal(YTB.isValidPayload({ ytCollections: [] }), true);
    assert.equal(YTB.isValidPayload({ inputBindings: {} }), true);
    assert.equal(YTB.isValidPayload({ twitchSidebar: {} }), true);
    assert.equal(YTB.isValidPayload({ twitchPlayer: {} }), true);
    assert.equal(YTB.isValidPayload({ twitchChatOverlay: {} }), true);
    assert.equal(YTB.isValidPayload({ unrelated: true }), false);
});
