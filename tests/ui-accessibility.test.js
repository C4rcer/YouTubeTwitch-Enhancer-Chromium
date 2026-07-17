'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('ok - ' + name); }
    catch (error) { console.error('not ok - ' + name); throw error; }
}

test('popup tabs expose the complete ARIA relationship', () => {
    const html = read('src/popup.html');
    assert.match(html, /role="tablist"[^>]+aria-label=/);
    assert.match(html, /id="tab-youtube"[^>]+role="tab"[^>]+aria-controls="panel-youtube"[^>]+aria-selected=/);
    assert.match(html, /id="tab-twitch"[^>]+role="tab"[^>]+aria-controls="panel-twitch"[^>]+aria-selected=/);
    assert.match(html, /id="panel-youtube"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-youtube"/);
    assert.match(html, /id="panel-twitch"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-twitch"/);
});

test('popup tabs support arrow, home and end keyboard navigation', () => {
    const script = read('src/popup.js');
    assert.match(script, /ArrowLeft/);
    assert.match(script, /ArrowRight/);
    assert.match(script, /Home/);
    assert.match(script, /End/);
    assert.match(script, /aria-selected/);
    assert.match(script, /\.focus\(\)/);
});

test('onboarding privacy copy does not claim all network access is absent', () => {
    const html = read('src/onboarding.html');
    assert.doesNotMatch(html, /nothing is collected or sent anywhere/i);
    assert.match(html, /BTTV/i);
    assert.match(html, /browser sync/i);
    assert.match(html, /no custom (?:enhancer )?backend/i);
});

test('shared UI honours system theme, focus and forced colours', () => {
    const css = read('src/ui.css');
    assert.match(css, /data-theme="light"/);
    assert.match(css, /data-theme="dark"/);
    assert.match(css, /prefers-color-scheme:\s*light/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /forced-colors:\s*active/);
});

test('both full settings pages load the progressive settings layer', () => {
    for (const file of ['src/options.html', 'src/twitch-options.html']) {
        const html = read(file);
        assert.match(html, /settings-enhancements\.css/);
        assert.match(html, /settings-enhancements\.js/);
        assert.ok(html.indexOf('feature-core.js') < html.indexOf('common.js'));
        assert.ok(html.indexOf('common.js') < html.indexOf('settings-enhancements.js'));
    }
});

test('shared settings API and dynamic sections are integrated', () => {
    assert.match(read('src/common.js'), /globalThis\.YTB\s*=\s*YTB/);
    const script = read('src/settings-enhancements.js');
    assert.match(script, /#ytb-enhancements-root > \.section/);
    assert.doesNotMatch(script, /aria-controls': id \+ '-content'/);
});

test('large list managers expose sorting and bounded paging', () => {
    for (const [htmlFile, scriptFile] of [
        ['src/options.html', 'src/options.js'],
        ['src/twitch-options.html', 'src/twitch-options.js']
    ]) {
        assert.match(read(htmlFile), /id="list-sort"/);
        const script = read(scriptFile);
        assert.match(script, /const PAGE_SIZE = 500/);
        assert.match(script, /function appendPager/);
        assert.match(script, /listPages/);
    }
});

test('destructive list managers retain bounded undo snapshots', () => {
    for (const file of ['src/options.js', 'src/twitch-options.js']) {
        const script = read(file);
        assert.match(script, /addRecentAction/);
        assert.match(script, /type: 'list-removal'/);
        assert.match(script, /snapshotKeys/);
    }
    assert.match(read('src/youtube-workspace.js'), /type: 'collection-change'/);
    assert.match(read('src/twitch-experience.js'), /type: 'sidebar-change'/);
});

test('new settings and option helper text is never below twelve pixels', () => {
    assert.doesNotMatch(read('src/settings-enhancements.css'), /font(?:-size)?:\s*(?:10|11)px/);
    assert.doesNotMatch(read('src/ui.css'), /font(?:-size)?:\s*(?:10|11)px/);
    assert.doesNotMatch(read('src/options.html'), /font-size:\s*(?:10|11)px/);
    assert.doesNotMatch(read('src/twitch-options.html'), /font-size:\s*(?:10|11)px/);
});
test('legacy speed listeners defer to enabled configurable bindings', () => {
    assert.match(read('src/content.js'), /sharedInputActionsEnabled[\s\S]+ytSpeedHotkeys/);
    assert.match(read('src/twitch.js'), /sharedInputActionsEnabled[\s\S]+twSpeedHotkeys/);
    assert.match(read('src/settings-enhancements.js'), /hasSpeedBinding/);
});
console.log('ui-accessibility: ' + passed + ' tests passed');
