/* eslint-env node */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const workspace = require('../src/youtube-workspace.js');

test('exports helpers globally and defaults both optional features on', () => {
    assert.equal(globalThis.YTBYouTubeWorkspace, workspace);
    assert.deepEqual(workspace.DEFAULT_FLAGS, {
        ytTranscriptWorkspace: true,
        ytCollectionsEnabled: true
    });
});

test('parses clock, spoken, compact, and URL timestamps', () => {
    assert.equal(workspace.parseTimestamp('1:23'), 83);
    assert.equal(workspace.parseTimestamp('1:02:03'), 3723);
    assert.equal(workspace.parseTimestamp('1 minute, 5 seconds'), 65);
    assert.equal(workspace.parseTimeFromHref('/watch?v=abc&t=1m2s'), 62);
    assert.equal(workspace.parseTimeFromHref('/watch?v=abc&start=91'), 91);
    assert.ok(Number.isNaN(workspace.parseTimestamp('not a time')));
});

test('normalizes, sorts, deduplicates, searches, and formats transcript cues', () => {
    const cues = workspace.normalizeTranscriptCues([
        { start: '0:12', text: '  Café launch  ' },
        { start: 2, text: 'First cue' },
        { start: '0:12', text: 'Café launch' },
        { start: -1, text: 'invalid' },
        { start: 20, text: '' }
    ]);
    assert.deepEqual(cues, [
        { start: 2, text: 'First cue' },
        { start: 12, text: 'Café launch' }
    ]);
    assert.deepEqual(workspace.searchTranscript(cues, 'cafe launch'), [1]);
    assert.deepEqual(workspace.searchTranscript(cues, 'FIRST'), [0]);
    assert.deepEqual(workspace.searchTranscript(cues, ''), [0, 1]);
    assert.equal(workspace.formatTranscriptText(cues), '[0:02] First cue\n[0:12] Café launch');
});

test('finds the active rendered cue with a binary boundary search', () => {
    const cues = workspace.normalizeTranscriptCues([
        { start: 0, text: 'a' },
        { start: 5, text: 'b' },
        { start: 10, text: 'c' }
    ]);
    assert.equal(workspace.findActiveCueIndex(cues, -0.1), -1);
    assert.equal(workspace.findActiveCueIndex(cues, 0), 0);
    assert.equal(workspace.findActiveCueIndex(cues, 9.99), 1);
    assert.equal(workspace.findActiveCueIndex(cues, 100), 2);
});

test('parses transcript segments from rendered DOM-like nodes without an API', () => {
    class FakeSegment {
        constructor(startMs, timestamp, text) {
            this.dataset = { startOffsetMs: String(startMs) };
            this.textContent = timestamp + ' ' + text;
            this.timestamp = { textContent: timestamp };
            this.text = { textContent: text };
        }
        getAttribute() { return null; }
        querySelector(selector) {
            if (selector.includes('timestamp') || selector.includes('Timestamp')) return this.timestamp;
            if (selector.includes('segment-text') || selector.includes('SegmentText')) return this.text;
            return null;
        }
    }
    const segments = [
        new FakeSegment(1250, '0:01', 'Rendered first'),
        new FakeSegment(4250, '0:04', 'Rendered second')
    ];
    const root = {
        querySelectorAll(selector) {
            return selector === 'ytd-transcript-segment-renderer' ? segments : [];
        }
    };
    assert.deepEqual(
        workspace.parseTranscriptDom(root).map(({ start, text }) => ({ start, text })),
        [
            { start: 1.25, text: 'Rendered first' },
            { start: 4.25, text: 'Rendered second' }
        ]
    );
});

test('normalizes chapters and parses chapter URL offsets', () => {
    assert.deepEqual(workspace.normalizeChapters([
        { start: '1:00', title: 'Second' },
        { start: 0, title: 'Intro' },
        { start: 60, title: 'Second' }
    ]), [
        { start: 0, title: 'Intro' },
        { start: 60, title: 'Second' }
    ]);
    assert.equal(workspace.parseTimeFromHref('https://youtu.be/x?t=1h2m3s'), 3723);
    const chapters = [{ start: 0, title: 'Intro' }, { start: 60, title: 'Main' }];
    assert.equal(workspace.chapterTarget(chapters, 10, 'nextChapter'), 60);
    assert.equal(workspace.chapterTarget(chapters, 70, 'previousChapter'), 60);
});

test('channel identity prefers stable IDs and handles over display names', () => {
    assert.deepEqual(workspace.parseChannelFromHref('https://youtube.com/@Example/videos'), {
        channelId: '', handle: 'Example', name: ''
    });
    assert.equal(workspace.channelIdentityKey({ handle: '@Example' }), 'handle:example');
    assert.equal(workspace.sameChannelIdentity(
        { channelId: 'UC111', name: 'Same name' },
        { channelId: 'UC222', name: 'Same name' }
    ), false);
    assert.equal(workspace.sameChannelIdentity(
        { handle: '@Example', name: 'Old name' },
        { handle: 'example', name: 'New name' }
    ), true);
    assert.equal(workspace.sameChannelIdentity(
        { name: 'Fallback Channel' },
        { name: ' fallback   channel ' }
    ), true);
});

test('collection normalization is bounded and membership uses channel identity', () => {
    const duplicateChannels = [
        { handle: '@One', name: 'One' },
        { handle: 'one', name: 'Renamed One' },
        { channelId: 'UCTWO', name: 'Two' }
    ];
    const raw = Array.from({ length: workspace.LIMITS.collections + 5 }, (_, index) => ({
        id: 'collection-' + index,
        name: 'Collection ' + index,
        channels: duplicateChannels
    }));
    const normalized = workspace.normalizeCollections(raw);
    assert.equal(normalized.length, workspace.LIMITS.collections);
    assert.equal(normalized[0].channels.length, 2);
    assert.equal(workspace.collectionIncludesChannel(normalized[0], { handle: '@ONE' }), true);
    assert.equal(workspace.collectionIncludesChannel(normalized[0], { handle: '@missing' }), false);
    assert.equal(workspace.collectionViewIncludesChannel(normalized, normalized[0].id, { handle: 'one' }), true);
    assert.equal(workspace.collectionViewIncludesChannel(normalized, '__uncollected__', { handle: 'missing' }), true);
    assert.equal(workspace.collectionViewIncludesChannel(normalized, '__uncollected__', { handle: 'one' }), false);
});

test('JSON and CSV collection helpers round-trip local identities', () => {
    const source = [{
        id: 'music',
        name: 'Music, live',
        channels: [
            { channelId: 'UCMUSIC', handle: 'music', name: 'Music "Official"' },
            { handle: 'acoustic', name: 'Acoustic' }
        ]
    }];
    const expected = workspace.normalizeCollections(source);
    assert.deepEqual(workspace.parseCollectionsJSON(
        workspace.serializeCollectionsJSON(source)
    ), expected);
    assert.deepEqual(workspace.parseCollectionsCSV(
        workspace.serializeCollectionsCSV(source)
    ), expected);
});
