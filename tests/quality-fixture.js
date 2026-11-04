/* eslint-env node */
'use strict';

// YouTube's #movie_player quality API, enough to replay what the player did
// live (2026-11, on Firefox) during an SPA navigation. Used by the
// content.js and page-quality.js tests.

const assert = require('node:assert/strict');

function fakeQualityPlayer() {
    const classes = new Set();
    return {
        vid: 'previousVid',
        levels: ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny', 'auto'],
        preferred: 'hd2160',
        state: 3,
        sets: 0,
        classList: {
            contains: name => classes.has(name),
            toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }
        },
        getVideoData() { return { video_id: this.vid }; },
        getAvailableQualityLevels() { return this.levels.slice(); },
        getPreferredQuality() { return this.preferred; },
        getPlayerState() { return this.state; },
        setPlaybackQualityRange(min) { this.preferred = min; this.sets++; },
        setPlaybackQuality(quality) { this.preferred = quality; }
    };
}

// Replays the live sequence; `apply` is one add-on pass.
function replayNavigationReset(player, setVideo, apply) {
    const levels = player.levels.slice();
    // SPA navigation: the URL and the player both report the new video,
    // still carrying the previous video's preference.
    setVideo('nextVideo01');
    player.vid = 'nextVideo01';
    apply();
    // ~100 ms later the player loads that video's formats: no levels, then
    // the levels again with the preference reset to "auto".
    player.levels = [];
    player.preferred = 'auto';
    apply();
    player.levels = levels;
    apply();
    assert.equal(player.preferred, 'hd2160', 'the best level is applied again after the reset');

    player.state = 1;   // playing at the best level: settled
    apply();
    const sets = player.sets;

    // A quality picked by hand afterwards is kept.
    player.preferred = 'hd720';
    apply();
    assert.equal(player.preferred, 'hd720');

    // An ad's streams are left alone; a fall back to "auto" after it is fixed.
    player.classList.toggle('ad-showing', true);
    player.preferred = 'auto';
    apply();
    assert.equal(player.sets, sets, 'nothing is applied while an ad plays');
    player.classList.toggle('ad-showing', false);
    apply();
    assert.equal(player.preferred, 'hd2160');
}

module.exports = { fakeQualityPlayer, replayNavigationReset };
