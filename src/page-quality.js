/* ==================================================================
 * Chromium-only MAIN-world helper for the max-quality feature.
 *
 * Chromium content scripts are fully isolated from the page, so
 * content.js cannot reach YouTube's player API there (on Firefox it
 * can, via wrappedJSObject — this file is not in the Firefox
 * manifest). content.js posts a "ytb-max-quality" message each
 * cleanup pass; once the player is ready this script forces the
 * highest available quality and answers with "ytb-max-quality-done"
 * so content.js stops retrying for that video.
 *
 * Runs in the page world: no extension APIs, no storage access.
 * ================================================================== */
(function () {
    'use strict';

    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data || e.data.type !== 'ytb-max-quality') return;
        const vid = e.data.vid;
        if (!vid) return;
        const player = document.getElementById('movie_player');
        if (!player || typeof player.getAvailableQualityLevels !== 'function') return;
        let levels;
        try { levels = player.getAvailableQualityLevels(); } catch (err) { return; }
        if (!levels || !levels.length) return;            // player not ready yet — content.js retries
        const best = levels[0];                           // ordered highest -> lowest
        try {
            if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange(best, best);
            if (typeof player.setPlaybackQuality === 'function') player.setPlaybackQuality(best);
            window.postMessage({ type: 'ytb-max-quality-done', vid }, location.origin);
        } catch (err) { /* ignore */ }
    });
})();
