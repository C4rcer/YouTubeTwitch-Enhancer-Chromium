/* ==================================================================
 * Chromium-only MAIN-world helper for YouTube player-API features.
 *
 * Chromium content scripts are fully isolated from the page, so
 * content.js cannot reach YouTube's player API there (on Firefox it
 * can, via wrappedJSObject — this file is not in the Firefox
 * manifest). content.js posts a message per operation and this script
 * performs it against the page-world player:
 *   ytb-max-quality  { vid }   keep the highest available quality.
 *                              content.js asks on every pass; the
 *                              per-video state lives here (see the
 *                              handler below).
 *   ytb-set-rate     { rate }  set the playback rate through the
 *                              player API so its UI stays in sync
 *                              (content.js sets the element rate too).
 *   ytb-get-video-data
 *              { token, vid }  read the active player's video ID and title;
 *                              answered with "ytb-video-data".
 *   ytb-lact                   refresh YouTube's idle timer global so
 *                              the "Continue watching?" prompt stays
 *                              away ("never pause me").
 *   ytb-profile-quality
 *              { quality }     apply a playback-profile quality preference
 *                              ("max" or a height like "1080"), falling back
 *                              to the nearest available level — the same
 *                              selection player-controls.js performs directly
 *                              on Firefox.
 *
 * Runs in the page world: no extension APIs, no storage access.
 * ================================================================== */
(function () {
    'use strict';

    // ytb-max-quality state for the video in the URL.
    const QUALITY_SETTLE_MS = 5000;
    let qualityTarget = { vid: null, firstSeenAt: 0, settled: false };

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

        if (e.data.type === 'ytb-profile-quality') {
            const requested = String(e.data.quality || '');
            if (!requested || requested === 'current') return;
            const player = document.getElementById('movie_player');
            if (!player || typeof player.getAvailableQualityLevels !== 'function') return;
            let available;
            try { available = player.getAvailableQualityLevels(); } catch (err) { return; }
            if (!available || !available.length) return;
            const map = {
                '2160': 'hd2160', '1440': 'hd1440', '1080': 'hd1080',
                '720': 'hd720', '480': 'large', '360': 'medium'
            };
            const order = ['highres', 'hd4320', 'hd2880', 'hd2160', 'hd1440',
                'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
            let quality = requested === 'max' ? available[0] : map[requested];
            if (!available.includes(quality)) {
                const want = order.indexOf(quality);
                quality = available
                    .slice()
                    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
                    .find(level => order.indexOf(level) >= want) ||
                    available[available.length - 1];
            }
            try {
                if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange(quality, quality);
                if (typeof player.setPlaybackQuality === 'function') player.setPlaybackQuality(quality);
            } catch (err) { /* player API changed; leave native setting alone */ }
            return;
        }

        if (e.data.type === 'ytb-max-quality') {
            // One early attempt is not enough (verified live 2026-11 on
            // Firefox): after an SPA navigation the player reports the new
            // video with its streams, then about 100 ms later resets its
            // preference to "auto" while it loads that video's formats. So
            // each request re-applies the best level until the video plays at
            // it (or QUALITY_SETTLE_MS have passed). After that a quality
            // picked by hand is kept; only a fall back to "auto" is corrected.
            // Same rules as content.js's direct (Firefox) path.
            const vid = e.data.vid;
            if (typeof vid !== 'string' || !vid) return;
            if (qualityTarget.vid !== vid) qualityTarget = { vid, firstSeenAt: 0, settled: false };
            const player = document.getElementById('movie_player');
            if (!player || typeof player.getAvailableQualityLevels !== 'function') return;
            if (player.classList.contains('ad-showing')) return;   // the ad's streams
            const canConfirm = typeof player.getPreferredQuality === 'function';
            let levels, playerVid, preferred, playing;
            try {
                levels = [...(player.getAvailableQualityLevels() || [])];
                const data = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
                playerVid = data && data.video_id;
                preferred = canConfirm ? player.getPreferredQuality() : '';
                playing = typeof player.getPlayerState === 'function' && player.getPlayerState() === 1;
            } catch (err) { return; }
            const best = levels.find(level => level !== 'auto');   // ordered highest -> lowest
            if (!best || (playerVid && playerVid !== vid)) return;  // not this video's streams yet
            const now = Date.now();
            if (!qualityTarget.firstSeenAt) qualityTarget.firstSeenAt = now;
            if (preferred === best) {
                if (playing || now - qualityTarget.firstSeenAt >= QUALITY_SETTLE_MS) qualityTarget.settled = true;
                return;
            }
            if (qualityTarget.settled && preferred !== 'auto') return;   // picked by hand
            try {
                if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange(best, best);
                if (typeof player.setPlaybackQuality === 'function') player.setPlaybackQuality(best);
            } catch (err) { /* ignore */ }
            // Without getPreferredQuality nothing can confirm it: one attempt.
            if (!canConfirm) qualityTarget.settled = true;
        }
    });
})();
