'use strict';

const assert = require('node:assert/strict');
const Features = require('../src/feature-core.js');
const Settings = require('../src/settings-enhancements.js');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('ok - ' + name); }
    catch (error) { console.error('not ok - ' + name); throw error; }
}

test('settings search uses every token and ignores whitespace/case', () => {
    assert.equal(Settings.matchesSearch('Player Tools', 'Playback speed and volume', ' SPEED player '), true);
    assert.equal(Settings.matchesSearch('Player Tools', 'Playback speed and volume', 'speed captions'), false);
    assert.equal(Settings.matchesSearch('Privacy', 'Local storage', ''), true);
});

test('selective backup payload includes only requested categories', () => {
    const source = {
        settings: { enabled: false },
        blockedChannels: [{ handle: 'one' }],
        twitchBlockedChannels: [{ login: 'two' }],
        inputBindings: Features.defaultInputBindings(),
        playbackProfiles: [Features.defaultProfile()],
        recentActions: [{ id: 'private-history' }]
    };
    const payload = Settings.buildSelectivePayload(source, ['youtubeLists', 'features']);
    assert.deepEqual(payload.blockedChannels, source.blockedChannels);
    assert.deepEqual(payload.inputBindings, source.inputBindings);
    assert.deepEqual(payload.playbackProfiles, source.playbackProfiles);
    assert.equal(Object.hasOwn(payload, 'settings'), false);
    assert.equal(Object.hasOwn(payload, 'twitchBlockedChannels'), false);
    assert.equal(Object.hasOwn(payload, 'recentActions'), false);
    payload.blockedChannels[0].handle = 'changed';
    assert.equal(source.blockedChannels[0].handle, 'one');
});

test('undo snapshots restore allowlisted categories without prototype keys', () => {
    const current = {
        settings: { enabled: true, settingsTheme: 'dark' },
        blockedChannels: [{ handle: 'new' }],
        recentActions: [{ id: 'keep' }]
    };
    const restored = Settings.applyUndoSnapshot(current, {
        settings: { enabled: false, settingsTheme: 'system' },
        blockedChannels: [{ handle: 'old' }],
        recentActions: [],
        arbitrary: 'ignored'
    });
    assert.deepEqual(restored.settings, { enabled: false, settingsTheme: 'system' });
    assert.deepEqual(restored.blockedChannels, [{ handle: 'old' }]);
    assert.deepEqual(restored.recentActions, current.recentActions);
    assert.equal(Object.hasOwn(restored, 'arbitrary'), false);
});

test('channel profile rule parser reports invalid lines and normalises keys', () => {
    const parsed = Settings.parseChannelRules([
        '# comment',
        '@Creator = focus',
        'id:UC123 = default',
        'missing-profile = unknown',
        'bad line'
    ].join('\n'), ['default', 'focus']);
    assert.deepEqual(parsed.rules, {
        '@creator': 'focus',
        'id:uc123': 'default'
    });
    assert.deepEqual(parsed.errors.map(item => item.line), [4, 5]);
    assert.equal(Settings.profileRulesText(parsed.rules), '@creator = focus\nid:uc123 = default');
});

test('privacy summary accurately reflects enabled network integrations', () => {
    const summary = Object.fromEntries(Settings.integrationSummary({
        sbEnabled: true,
        deArrowTitles: false,
        deArrowThumbs: true,
        rydEnabled: false,
        twEmotes: true,
        syncBlockLists: false
    }).map(item => [item.id, item.active]));
    assert.deepEqual(summary, {
        sponsorblock: true, dearrow: true, ryd: false, emotes: true, sync: false
    });
});

test('diagnostics contain counts and booleans but no stored identities', () => {
    const data = Features.normalizeFeatureData({});
    Object.assign(data, {
        settings: { sbEnabled: true, twEmotes: false, diagnosticsEnabled: true },
        blockedChannels: [{ handle: 'private-name' }],
        hiddenVideoIds: ['private-video-id'],
        twitchBlockedChannels: [{ login: 'private-login' }]
    });
    const diagnostics = Settings.diagnosticsFrom(data, { site: 'youtube', version: '9.9.9' });
    const text = JSON.stringify(diagnostics);
    assert.equal(diagnostics.extensionVersion, '9.9.9');
    assert.equal(diagnostics.storageCounts.blockedYouTubeChannels, 1);
    assert.equal(text.includes('private-name'), false);
    assert.equal(text.includes('private-video-id'), false);
    assert.equal(text.includes('private-login'), false);
});

test('control-feature imports do not silently replace collection or sidebar lists', () => {
    const source = {
        inputBindings: Features.defaultInputBindings(),
        playbackProfiles: [Features.defaultProfile()],
        twitchPlayer: { seekStep: 15 },
        twitchChatOverlay: { width: 420 },
        ytCollections: [{ id: 'private-list', name: 'Private list' }],
        twitchSidebar: { favorites: ['private-login'] },
        hiddenVideoMetadata: { abcdef: { title: 'Private title' } }
    };
    const payload = Settings.buildSelectivePayload(source, ['features']);
    assert.equal(Object.hasOwn(payload, 'inputBindings'), true);
    assert.equal(Object.hasOwn(payload, 'twitchPlayer'), true);
    assert.equal(Object.hasOwn(payload, 'twitchChatOverlay'), true);
    assert.equal(Object.hasOwn(payload, 'ytCollections'), false);
    assert.equal(Object.hasOwn(payload, 'twitchSidebar'), false);
    assert.equal(Object.hasOwn(payload, 'hiddenVideoMetadata'), false);
});

test('diagnostics expose only redacted Twitch recovery state', () => {
    const data = Features.normalizeFeatureData({
        twitchDiagnostics: { player: {
            status: 'failed', attempts: 4, lastErrorKind: 'media-decode',
            lastErrorAt: 12345, privateUrl: 'https://private.invalid/watch'
        } }
    });
    data.settings = {};
    const diagnostics = Settings.diagnosticsFrom(data, { site: 'twitch', version: '5.0' });
    assert.deepEqual(diagnostics.lastRecovery, {
        code: 'media-decode', attempts: 4, at: 12345
    });
    assert.equal(JSON.stringify(diagnostics).includes('private.invalid'), false);
});
console.log('settings-enhancements: ' + passed + ' tests passed');
