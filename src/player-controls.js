/* ==================================================================
 * Cross-site configurable player input and playback-profile runtime.
 * Uses only HTMLMediaElement/page player APIs and local browser storage.
 * ================================================================== */
/* global browser, chrome, YTBFeatures */
(function () {
    'use strict';

    if (typeof YTBFeatures === 'undefined') return;
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const SITE = /(^|\.)twitch\.tv$/.test(location.hostname) ? 'twitch' :
        /(^|\.)youtube\.com$/.test(location.hostname) ? 'youtube' : '';
    if (!SITE) return;

    const STORAGE_KEY = 'data';
    const TAKEOVER_EVENT = 'ytb-player-controls-takeover';
    const INSTANCE_ID = Math.random().toString(36).slice(2);
    let retired = false;
    let rawData = {};
    let featureData = YTBFeatures.normalizeFeatureData({});
    let settings = {};
    let currentMediaSignature = '';
    let applyTimer = null;
    let osdTimer = null;
    let lastUrl = location.href;
    let profileApplying = false;

    document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT, { detail: INSTANCE_ID }));

    function onTakeover(event) {
        if (event.detail !== INSTANCE_ID) retire();
    }
    document.addEventListener(TAKEOVER_EVENT, onTakeover);

    function playerVideo() {
        const videos = [...document.querySelectorAll('video')];
        return videos.find(video => video.readyState > 0 && video.getBoundingClientRect().width > 100) ||
            videos.find(video => video.readyState > 0) || videos[0] || null;
    }

    function playerRoot(video) {
        if (SITE === 'youtube') return document.getElementById('movie_player') ||
            (video && video.closest('#player, ytd-player')) || video;
        return document.querySelector('.video-player__container, [data-a-target="video-player"]') ||
            (video && video.parentElement) || video;
    }

    function channelKey() {
        if (SITE === 'twitch') {
            const part = location.pathname.split('/').filter(Boolean)[0] || '';
            if (/^(?:videos|directory|search|settings|downloads|subscriptions|inventory|drops|clip|clips)$/i.test(part)) {
                const link = document.querySelector('a[data-a-target="stream-title"], a[href^="/"][data-test-selector*="channel"]');
                return link ? (link.getAttribute('href') || '').split('/').filter(Boolean)[0].toLowerCase() : '';
            }
            return /^[a-z0-9_]{2,25}$/i.test(part) ? part.toLowerCase() : '';
        }
        const owner = document.querySelector(
            'ytd-watch-metadata ytd-channel-name a[href], #owner ytd-channel-name a[href], ' +
            'ytm-slim-owner-renderer a[href*="/@"], ytm-slim-owner-renderer a[href*="/channel/"]'
        );
        if (!owner) return '';
        const href = owner.getAttribute('href') || '';
        const id = href.match(/\/channel\/(UC[\w-]+)/);
        const handle = href.match(/\/@([\w.-]+)/);
        return id ? 'id:' + id[1].toLowerCase() :
            handle ? 'handle:' + handle[1].toLowerCase() : '';
    }

    function mediaSignature(video) {
        if (!video) return '';
        const pageId = SITE === 'youtube'
            ? new URLSearchParams(location.search).get('v') || location.pathname
            : location.pathname;
        return SITE + '|' + pageId + '|' + (video.currentSrc || video.src || '');
    }

    function showOsd(message, kind) {
        if (retired || !document.body) return;
        let element = document.getElementById('ytb-input-osd');
        if (!element) {
            element = document.createElement('div');
            element.id = 'ytb-input-osd';
            element.setAttribute('role', 'status');
            element.setAttribute('aria-live', 'polite');
            document.body.appendChild(element);
        }
        element.textContent = message;
        element.dataset.kind = kind || '';
        element.classList.add('ytb-input-osd-visible');
        clearTimeout(osdTimer);
        osdTimer = setTimeout(() => element.classList.remove('ytb-input-osd-visible'), 1300);
    }

    function showProfileChip(selection, root) {
        if (!root || !selection || !selection.profile) return;
        let chip = root.querySelector && root.querySelector('.ytb-active-profile-chip');
        if (!chip) {
            chip = document.createElement('div');
            chip.className = 'ytb-active-profile-chip';
            chip.setAttribute('role', 'status');
            root.appendChild(chip);
        }
        chip.textContent = selection.profile.name +
            (selection.source === 'channel' ? ' · channel profile' : ' · global profile');
        chip.title = 'Active YouTube/Twitch Enhancer playback profile';
        chip.classList.add('ytb-active-profile-chip-visible');
        clearTimeout(chip._ytbTimer);
        chip._ytbTimer = setTimeout(() => chip.classList.remove('ytb-active-profile-chip-visible'), 3500);
    }

    function isLiveTwitch() {
        return SITE === 'twitch' &&
            !/^\/videos\/\d+/.test(location.pathname) &&
            location.hostname !== 'clips.twitch.tv' &&
            !/\/clip\//.test(location.pathname);
    }

    function clickFirst(selectors) {
        const element = document.querySelector(selectors);
        if (!element) return false;
        element.click();
        return true;
    }

    function screenshotFallback(video) {
        if (!video || !video.videoWidth || !video.videoHeight) return false;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            canvas.toBlob(blob => {
                if (!blob) return showOsd('Screenshot unavailable', 'error');
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = SITE + '-' + new Date().toISOString()
                    .replace(/[:T]/g, '-').slice(0, 19) + '.png';
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
                showOsd('Screenshot saved');
            }, 'image/png');
            return true;
        } catch (error) {
            return false;
        }
    }

    function setSpeed(video, value) {
        if (!video || (SITE === 'twitch' && isLiveTwitch())) return false;
        const speed = Math.min(8, Math.max(0.1, Math.round(value * 100) / 100));
        video.playbackRate = speed;
        showOsd('Speed ' + speed + '×');
        return true;
    }

    function actionFor(type, gesture) {
        const siteBindings = featureData.inputBindings[SITE];
        if (!siteBindings || !siteBindings.enabled) return '';
        for (const action of YTBFeatures.ACTION_CATALOGUE) {
            if (!action.sites.includes(SITE)) continue;
            if (siteBindings[type][action.id] === gesture) return action.id;
        }
        return '';
    }

    function actionAllowed(action) {
        if (action === 'speedDown' || action === 'speedUp' || action === 'speedReset') {
            const legacy = SITE === 'youtube' ? settings.ytSpeedHotkeys : settings.twSpeedHotkeys;
            return legacy !== false;
        }
        return SITE === 'youtube' ? settings.enabled !== false : settings.twEnabled !== false;
    }

    function runAction(action) {
        if (!action || !actionAllowed(action)) return false;
        const video = playerVideo();
        if (!video) return false;
        const seekStep = SITE === 'twitch'
            ? Math.max(1, Math.min(60, parseInt(settings.twSeekStep, 10) || 10)) : 5;
        switch (action) {
        case 'playPause':
            if (video.paused) video.play().catch(() => {});
            else video.pause();
            showOsd(video.paused ? 'Paused' : 'Playing');
            return true;
        case 'seekBackward':
            video.currentTime = Math.max(0, video.currentTime - seekStep);
            showOsd('Back ' + seekStep + 's');
            return true;
        case 'seekForward':
            video.currentTime = Math.min(Number.isFinite(video.duration) ? video.duration : Infinity,
                video.currentTime + seekStep);
            showOsd('Forward ' + seekStep + 's');
            return true;
        case 'frameBackward':
        case 'frameForward':
            if (SITE !== 'youtube') return false;
            video.pause();
            video.currentTime = Math.max(0, video.currentTime +
                (action === 'frameBackward' ? -1 : 1) / 30);
            showOsd(action === 'frameBackward' ? 'Previous frame' : 'Next frame');
            return true;
        case 'speedDown':
            return setSpeed(video, (video.playbackRate || 1) - 0.25);
        case 'speedUp':
            return setSpeed(video, (video.playbackRate || 1) + 0.25);
        case 'speedReset':
            return setSpeed(video, 1);
        case 'volumeDown':
        case 'volumeUp':
            video.volume = Math.min(1, Math.max(0, video.volume +
                (action === 'volumeDown' ? -0.05 : 0.05)));
            if (video.volume > 0) video.muted = false;
            showOsd('Volume ' + Math.round(video.volume * 100) + '%');
            return true;
        case 'mute':
            video.muted = !video.muted;
            showOsd(video.muted ? 'Muted' : 'Unmuted');
            return true;
        case 'screenshot':
            if (SITE === 'youtube' && clickFirst('.ytb-shot-btn')) return true;
            if (SITE === 'twitch' && clickFirst(
                '#ytbtw-clipbar button[title^="Save a screenshot"]')) return true;
            return screenshotFallback(video);
        case 'loop':
            return SITE === 'youtube' && clickFirst('.ytb-loop-btn');
        case 'cinema':
            return clickFirst(SITE === 'youtube'
                ? '.ytb-cinema-btn'
                : '#ytbtw-clipbar button[title^="Darken everything"]');
        case 'captions':
            return clickFirst(SITE === 'youtube'
                ? '.ytp-subtitles-button'
                : 'button[data-a-target*="caption"], button[aria-pressed][aria-label*="caption" i]');
        case 'previousChapter':
        case 'nextChapter':
            document.dispatchEvent(new CustomEvent('ytb-workspace-action', {
                detail: { action }
            }));
            showOsd(action === 'previousChapter' ? 'Previous chapter' : 'Next chapter');
            return true;
        case 'liveEdge':
            if (SITE !== 'twitch') return false;
            if (video.seekable && video.seekable.length) {
                video.currentTime = video.seekable.end(video.seekable.length - 1);
                showOsd('Live edge');
                return true;
            }
            document.dispatchEvent(new CustomEvent('ytbtw-experience-action', {
                detail: { action }
            }));
            return true;
        case 'chatOverlay':
            if (SITE !== 'twitch') return false;
            document.dispatchEvent(new CustomEvent('ytbtw-experience-action', {
                detail: { action }
            }));
            showOsd('Chat overlay toggled');
            return true;
        default:
            return false;
        }
    }

    function onKeyDown(event) {
        if (retired || event.defaultPrevented || event.repeat ||
            YTBFeatures.isEditableTarget(event.target)) return;
        const chord = YTBFeatures.eventToChord(event);
        if (!chord || YTBFeatures.isReservedChord(chord)) return;
        const action = actionFor('keyboard', chord);
        if (!action || !runAction(action)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function onPointerUp(event) {
        if (retired || event.button === 0 || event.button === 2 || !playerRoot(playerVideo()) ||
            !playerRoot(playerVideo()).contains(event.target)) return;
        const action = actionFor('mouse', 'Mouse' + event.button);
        if (!action || !runAction(action)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function onWheel(event) {
        if (retired || !event.deltaY) return;
        const root = playerRoot(playerVideo());
        if (!root || !root.contains(event.target)) return;
        const action = actionFor('wheel', event.deltaY < 0 ? 'WheelUp' : 'WheelDown');
        if (!action || !runAction(action)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function chooseYouTubeQuality(profile) {
        if (!profile || profile.quality === 'current') return;
        const player = document.getElementById('movie_player');
        const pageApi = player && (player.wrappedJSObject || player);
        if (!pageApi || typeof pageApi.getAvailableQualityLevels !== 'function') {
            // Chromium's isolated world cannot reach the page player API;
            // page-quality.js repeats this selection in the MAIN world.
            if (player) {
                window.postMessage(
                    { type: 'ytb-profile-quality', quality: profile.quality },
                    location.origin
                );
            }
            return;
        }
        let available;
        try { available = [...pageApi.getAvailableQualityLevels()]; } catch (error) { return; }
        if (!available.length) return;
        const map = {
            '2160': 'hd2160', '1440': 'hd1440', '1080': 'hd1080',
            '720': 'hd720', '480': 'large', '360': 'medium'
        };
        const order = ['highres', 'hd4320', 'hd2880', 'hd2160', 'hd1440',
            'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
        let quality = profile.quality === 'max' ? available[0] : map[profile.quality];
        if (!available.includes(quality)) {
            const requested = order.indexOf(quality);
            quality = available
                .slice()
                .sort((a, b) => order.indexOf(a) - order.indexOf(b))
                .find(level => order.indexOf(level) >= requested) || available[available.length - 1];
        }
        try {
            if (typeof pageApi.setPlaybackQualityRange === 'function') {
                pageApi.setPlaybackQualityRange(quality, quality);
            }
            if (typeof pageApi.setPlaybackQuality === 'function') pageApi.setPlaybackQuality(quality);
        } catch (error) { /* page API changed; leave native setting alone */ }
    }

    function setTriState(profile, field, currentSelector, onSelector) {
        const wanted = profile[field];
        if (wanted === 'unchanged') return;
        const button = document.querySelector(currentSelector);
        if (!button) return;
        const isOn = button.classList.contains('ytb-on') ||
            button.classList.contains('ytbtw-active') ||
            button.getAttribute('aria-pressed') === 'true';
        if ((wanted === 'on') !== isOn) {
            const target = onSelector ? document.querySelector(onSelector) : button;
            if (target) target.click();
        }
    }

    function applyProfile(force) {
        if (retired) return;
        const video = playerVideo();
        if (!video || video.readyState < 1) return;
        const signature = mediaSignature(video);
        if (!force && signature && signature === currentMediaSignature) return;
        const selection = YTBFeatures.selectPlaybackProfile(rawData, SITE, channelKey());
        if (!selection || !selection.profile) return;
        currentMediaSignature = signature;
        profileApplying = true;
        const profile = selection.profile;
        if (profile.speed !== null && !(SITE === 'twitch' && isLiveTwitch())) {
            video.playbackRate = profile.speed;
        }
        if (SITE === 'youtube') chooseYouTubeQuality(profile);
        else if (profile.quality === 'max') {
            try {
                localStorage.setItem('video-quality-highest-available', 'true');
                localStorage.setItem('s-qs-ts', String(Date.now()));
            } catch (error) { /* storage unavailable */ }
        }
        if (profile.captions !== 'unchanged') {
            const captionButton = document.querySelector(SITE === 'youtube'
                ? '.ytp-subtitles-button'
                : 'button[data-a-target*="caption"], button[aria-label*="caption" i]');
            if (captionButton) {
                const on = captionButton.getAttribute('aria-pressed') === 'true';
                if ((profile.captions === 'on') !== on) captionButton.click();
            }
        }
        setTriState(profile, 'compressor',
            SITE === 'youtube' ? '.ytb-comp-btn' : '.ytbtw-comp-btn');
        document.dispatchEvent(new CustomEvent('ytb-apply-playback-profile', {
            detail: {
                site: SITE,
                id: profile.id,
                speed: profile.speed,
                volumeBoost: profile.volumeBoost,
                quality: profile.quality,
                source: selection.source
            }
        }));
        showProfileChip(selection, playerRoot(video));
        profileApplying = false;
        updateDiagnostics(selection);
    }

    function updateDiagnostics(selection) {
        const next = {
            extensionVersion: api.runtime && api.runtime.getManifest
                ? api.runtime.getManifest().version : '',
            site: SITE,
            activeProfile: selection && selection.profile ? selection.profile.name : '',
            capabilities: {
                media: !!playerVideo(),
                configurableInputs: true,
                playbackProfiles: true
            },
            featureHealth: { playerControls: 'ok' },
            integrations: {}
        };
        api.storage.local.set({ ytbDiagnostics: YTBFeatures.redactDiagnostics(next) }).catch(() => {});
    }

    function scheduleProfile(force) {
        clearTimeout(applyTimer);
        applyTimer = setTimeout(() => applyProfile(!!force), 120);
    }

    function onMediaEvent(event) {
        if (profileApplying) return;
        if (event.type === 'loadedmetadata' || event.type === 'emptied') {
            currentMediaSignature = '';
            scheduleProfile(true);
        }
    }

    function loadData(value) {
        rawData = value && typeof value === 'object' ? value : {};
        settings = rawData.settings && typeof rawData.settings === 'object'
            ? rawData.settings : {};
        featureData = YTBFeatures.normalizeFeatureData(rawData);
        currentMediaSignature = '';
        scheduleProfile(true);
    }

    function onStorageChanged(changes, area) {
        if (retired || area !== 'local' || !changes[STORAGE_KEY]) return;
        loadData(changes[STORAGE_KEY].newValue);
    }

    function onNavigation() {
        if (location.href !== lastUrl) lastUrl = location.href;
        currentMediaSignature = '';
        scheduleProfile(true);
    }

    function retire() {
        if (retired) return;
        retired = true;
        clearTimeout(applyTimer);
        clearTimeout(osdTimer);
        document.removeEventListener(TAKEOVER_EVENT, onTakeover);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('wheel', onWheel, true);
        document.removeEventListener('loadedmetadata', onMediaEvent, true);
        document.removeEventListener('emptied', onMediaEvent, true);
        document.removeEventListener('yt-navigate-finish', onNavigation);
        window.removeEventListener('popstate', onNavigation);
        api.storage.onChanged.removeListener(onStorageChanged);
        document.getElementById('ytb-input-osd')?.remove();
        document.querySelectorAll('.ytb-active-profile-chip').forEach(element => element.remove());
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('loadedmetadata', onMediaEvent, true);
    document.addEventListener('emptied', onMediaEvent, true);
    document.addEventListener('yt-navigate-finish', onNavigation);
    window.addEventListener('popstate', onNavigation);
    api.storage.onChanged.addListener(onStorageChanged);

    api.storage.local.get(STORAGE_KEY).then(result => loadData(result[STORAGE_KEY])).catch(() => {
        loadData({});
    });
})();
