/* eslint-env node */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const features = require('../src/feature-core');

test('key chords normalize aliases and modifier order', () => {
    assert.equal(features.normalizeKeyChord('shift + control + ['), 'Ctrl+Shift+BracketLeft');
    assert.equal(features.normalizeKeyChord('cmd+a'), 'Meta+KeyA');
    assert.equal(features.normalizeKeyChord('option + left'), 'Alt+ArrowLeft');
    assert.equal(features.normalizeKeyChord('Ctrl+Alt'), '');
    assert.equal(features.normalizeKeyChord('Ctrl+A+B'), '');
});

test('keyboard events produce stable code-based chords', () => {
    assert.equal(features.eventToChord({
        code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false
    }), 'Ctrl+Shift+KeyK');
    assert.equal(features.eventToChord({ code: 'ShiftLeft' }), '');
    assert.equal(features.eventToChord({ code: 'KeyA', isComposing: true }), '');
});

test('browser-reserved chords are identified', () => {
    assert.equal(features.isReservedChord('Ctrl+L'), true);
    assert.equal(features.isReservedChord('Alt+ArrowLeft'), true);
    assert.equal(features.isReservedChord('F11'), true);
    assert.equal(features.isReservedChord('Shift+KeyL'), false);
});

test('editable targets suppress input handling', () => {
    assert.equal(features.isEditableTarget({ tagName: 'INPUT' }), true);
    assert.equal(features.isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(features.isEditableTarget({
        tagName: 'SPAN', closest: selector => selector.includes('role="textbox"') ? {} : null
    }), true);
    assert.equal(features.isEditableTarget({ tagName: 'BUTTON' }), false);
});

test('input bindings keep legacy defaults and sanitize gestures', () => {
    const defaults = features.normalizeInputBindings();
    assert.equal(defaults.youtube.keyboard.speedDown, 'BracketLeft');
    const value = features.normalizeInputBindings({
        youtube: {
            enabled: false,
            keyboard: { playPause: 'space', madeUp: 'KeyQ', speedUp: 'bad key' },
            mouse: { mute: 'Mouse4', playPause: 'Mouse99' },
            wheel: { volumeUp: 'WheelUp', volumeDown: 'Sideways' }
        }
    });
    assert.equal(value.youtube.enabled, false);
    assert.deepEqual(value.youtube.keyboard, { playPause: 'Space' });
    assert.deepEqual(value.youtube.mouse, { mute: 'Mouse4' });
    assert.deepEqual(value.youtube.wheel, { volumeUp: 'WheelUp' });
});

test('binding conflicts are reported per input type', () => {
    const conflicts = features.bindingConflicts({
        youtube: {
            keyboard: { playPause: 'KeyP', mute: 'KeyP' },
            mouse: {}, wheel: {}
        }
    }, 'youtube');
    assert.deepEqual(conflicts, [{
        site: 'youtube',
        type: 'keyboard',
        gesture: 'KeyP',
        actions: ['mute', 'playPause']
    }]);
});

test('profiles are bounded, clamped and always retain Default', () => {
    const profiles = features.normalizePlaybackProfiles([
        {
            id: 'focus profile',
            name: ' Focus ',
            sites: ['youtube', 'invalid'],
            speed: 99,
            volumeBoost: 0,
            quality: '1080',
            captions: 'on',
            compressor: 'bad'
        },
        { id: 'focus-profile', name: 'duplicate' }
    ]);
    assert.equal(profiles[0].id, 'default');
    const focus = profiles.find(profile => profile.id === 'focus-profile');
    assert.ok(focus);
    assert.deepEqual(focus.sites, ['youtube']);
    assert.equal(focus.speed, 8);
    assert.equal(focus.volumeBoost, 1);
    assert.equal(focus.quality, '1080');
    assert.equal(focus.compressor, 'unchanged');
    assert.equal(profiles.filter(profile => profile.id === 'focus-profile').length, 1);
});

test('channel profile rules retain only valid bounded profile references', () => {
    const profiles = features.normalizePlaybackProfiles([
        { id: 'lecture', name: 'Lecture', sites: ['youtube'], speed: 1.5 }
    ]);
    const rules = features.normalizeChannelProfileRules({
        youtube: { '@Example': 'lecture', bad: 'missing' },
        twitch: { STREAMER: 'lecture' }
    }, profiles);
    assert.deepEqual(rules.youtube, { '@example': 'lecture' });
    assert.deepEqual(rules.twitch, { streamer: 'lecture' });
});

test('channel rules override the global profile', () => {
    const data = {
        playbackProfiles: [
            features.defaultProfile(),
            { id: 'lecture', name: 'Lecture', sites: ['youtube'], speed: 1.5 }
        ],
        activePlaybackProfiles: { youtube: 'default', twitch: 'default' },
        channelPlaybackProfiles: { youtube: { 'handle:example': 'lecture' }, twitch: {} }
    };
    const chosen = features.selectPlaybackProfile(data, 'youtube', 'HANDLE:EXAMPLE');
    assert.equal(chosen.profile.id, 'lecture');
    assert.equal(chosen.source, 'channel');
    assert.equal(features.selectPlaybackProfile(data, 'youtube', 'other').source, 'global');
    data.channelPlaybackProfiles.youtube = { '@example': 'lecture' };
    assert.equal(features.selectPlaybackProfile(data, 'youtube', 'handle:example').source, 'channel');
});

test('collections deduplicate channel identities and sanitize colour', () => {
    const collections = features.normalizeCollections([{
        id: 'News!',
        name: ' Daily news ',
        color: 'red',
        channels: [
            { handle: '@Example', name: 'Example' },
            { key: 'handle:example', name: 'Duplicate' },
            { channelId: 'UC123456', name: 'ID channel' },
            {}
        ]
    }]);
    assert.equal(collections[0].id, 'news');
    assert.equal(collections[0].color, '#3ea6ff');
    assert.equal(collections[0].channels.length, 2);
});

test('Twitch sidebar data is local, bounded and identity-deduplicated', () => {
    const sidebar = features.normalizeTwitchSidebar({
        favorites: ['Example', { login: 'example' }, { login: 'two_name', name: 'Two' }],
        groups: [{
            id: 'Speed runs',
            name: 'Speed runs',
            collapsed: true,
            channels: ['Example', 'bad login']
        }]
    });
    assert.deepEqual(sidebar.favorites.map(item => item.login), ['example', 'two_name']);
    assert.equal(sidebar.groups[0].id, 'speed-runs');
    assert.equal(sidebar.groups[0].collapsed, true);
    assert.deepEqual(sidebar.groups[0].channels.map(item => item.login), ['example']);
    const legacy = features.normalizeTwitchSidebar({ favourites: ['legacy'], groups: [{ name: 'Old', members: ['member'] }] });
    assert.equal(legacy.favorites[0].login, 'legacy');
    assert.equal(legacy.groups[0].channels[0].login, 'member');
});

test('recent actions are bounded and oversized snapshots are discarded', () => {
    const actions = Array.from({ length: 60 }, (_, index) => ({
        id: 'a-' + index,
        type: 'remove',
        label: 'Removed item',
        at: index + 1,
        before: index === 59 ? 'x'.repeat(13000) : { index }
    }));
    const normalized = features.normalizeRecentActions(actions);
    assert.equal(normalized.length, 50);
    assert.equal(normalized[0].at, 60);
    assert.equal(normalized[0].before, null);
});

test('diagnostic export is a strict redacted allowlist', () => {
    const result = features.redactDiagnostics({
        extensionVersion: '5.0',
        site: 'twitch',
        activeProfile: 'Default',
        capabilities: { media: true },
        lastRecovery: { code: 'MEDIA_ERR', attempts: 2, at: 123, token: 'secret' },
        token: 'secret',
        transcript: 'private text',
        integrations: { bttv: true }
    });
    assert.equal(result.lastRecovery.code, 'MEDIA_ERR');
    assert.equal(result.lastRecovery.token, undefined);
    assert.equal(result.token, undefined);
    assert.equal(result.transcript, undefined);
});

test('import preview reports feature categories without committing data', () => {
    const preview = features.importPreview({
        settings: { enabled: true },
        playbackProfiles: [{ id: 'lecture', name: 'Lecture' }],
        ytCollections: [{ id: 'news', name: 'News', channels: [{ handle: 'example' }] }],
        twitchSidebar: { favorites: ['streamer'], groups: [] }
    });
    assert.equal(preview.valid, true);
    assert.equal(preview.counts.settings, 1);
    assert.equal(preview.counts.profiles, 1);
    assert.equal(preview.counts.collections, 1);
    assert.equal(preview.counts.collectionChannels, 1);
    assert.equal(preview.counts.twitchFavorites, 1);
});
