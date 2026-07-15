/* ==================================================================
 * Chromium-only MAIN-world helper for YouTube player-API features.
 *
 * Chromium content scripts are fully isolated from the page, so
 * content.js cannot reach YouTube's player API there (on Firefox it
 * can, via wrappedJSObject — this file is not in the Firefox
 * manifest). content.js posts a message per operation and this script
 * performs it against the page-world player:
 *   ytb-max-quality  { vid }   force the highest available quality;
 *                              answered with "ytb-max-quality-done"
 *                              so content.js stops retrying.
 *   ytb-set-rate     { rate }  set the playback rate through the
 *                              player API so its UI stays in sync
 *                              (content.js sets the element rate too).
 *   ytb-get-video-data
 *              { token, vid }  read the active player's video ID and title;
 *                              answered with "ytb-video-data".
 *   ytb-lact                   refresh YouTube's idle timer global so
 *                              the "Continue watching?" prompt stays
 *                              away ("never pause me").
 *
 * Runs in the page world: no extension APIs, no storage access.
 * ================================================================== */
(function () {
    'use strict';

    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data || typeof e.data.type !== 'string') return;

        if (e.data.type === 'ytb-lact') {
            try {
                if (typeof window._lact === 'number') window._lact = Date.now();
            } catch (err) { /* ignore */ }
            return;
        }

        if (e.data.type === 'ytb-set-rate') {
            const rate = Number(e.data.rate);
            if (!(rate >= 0.25 && rate <= 2)) return;
            const player = document.getElementById('movie_player');
            try {
                if (player && typeof player.setPlaybackRate === 'function') player.setPlaybackRate(rate);
            } catch (err) { /* content.js sets the element rate regardless */ }
            return;
        }

        if (e.data.type === 'ytb-get-video-data') {
            const token = e.data.token;
            const requestedVid = e.data.vid;
            if (typeof token !== 'string' || !token ||
                typeof requestedVid !== 'string' || !requestedVid) return;
            const player = document.getElementById('movie_player');
            let videoId = '', title = '';
            try {
                const data = player && typeof player.getVideoData === 'function'
                    ? player.getVideoData() : null;
                if (data) {
                    videoId = String(data.video_id || data.videoId || '');
                    title = String(data.title || '');
                }
            } catch (err) { /* reply empty so content.js can retry later */ }
            window.postMessage({
                type: 'ytb-video-data',
                token,
                requestedVid,
                videoId,
                title
            }, location.origin);
            return;
        }

        if (e.data.type === 'ytb-max-quality') {
            const vid = e.data.vid;
            if (!vid) return;
            const player = document.getElementById('movie_player');
            if (!player || typeof player.getAvailableQualityLevels !== 'function') return;
            let levels;
            try { levels = player.getAvailableQualityLevels(); } catch (err) { return; }
            if (!levels || !levels.length) return;        // player not ready yet — content.js retries
            const best = levels[0];                       // ordered highest -> lowest
            try {
                if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange(best, best);
                if (typeof player.setPlaybackQuality === 'function') player.setPlaybackQuality(best);
                window.postMessage({ type: 'ytb-max-quality-done', vid }, location.origin);
            } catch (err) { /* ignore */ }
        }
    });
})();
