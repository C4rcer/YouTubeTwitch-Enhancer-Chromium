/* global YTB */
(function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;

    let data = null;

    const $ = (id) => document.getElementById(id);
    const els = {
        // header / panels
        tabYoutube: $('tab-youtube'),
        tabTwitch: $('tab-twitch'),
        panelYoutube: $('panel-youtube'),
        panelTwitch: $('panel-twitch'),
        // YouTube
        channels: $('count-channels'),
        videos: $('count-videos'),
        addInput: $('add-input'),
        addBtn: $('add-btn'),
        enabled: $('set-enabled'),
        shorts: $('set-shorts'),
        watched: $('set-watched'),
        members: $('set-members'),
        paid: $('set-paid'),
        reveal: $('set-reveal'),
        wheelvol: $('set-wheelvol'),
        cinema: $('set-cinema'),
        threshold: $('set-threshold'),
        exportBtn: $('export-btn'),
        importBtn: $('import-btn'),
        importFile: $('import-file'),
        copyBtn: $('copy-btn'),
        optionsBtn: $('options-btn'),
        status: $('status'),
        // Twitch
        twEnabled: $('tw-enabled'),
        twChannels: $('tw-count-channels'),
        twCategories: $('tw-count-categories'),
        twAddInput: $('tw-add-input'),
        twAddChannelBtn: $('tw-add-channel-btn'),
        twAddCategoryBtn: $('tw-add-category-btn'),
        twAutoclaim: $('tw-autoclaim'),
        twDrops: $('tw-drops'),
        twMoments: $('tw-moments'),
        twAnon: $('tw-anon'),
        twEmotes: $('tw-emotes'),
        twCinema: $('tw-cinema'),
        twCarousel: $('tw-carousel'),
        twHideChat: $('tw-hidechat'),
        twClipHelper: $('tw-cliphelper'),
        twMaxQuality: $('tw-maxquality'),
        twHideExt: $('tw-hideext'),
        twOptionsBtn: $('tw-options-btn'),
        twStatus: $('tw-status')
    };

    /* ---- panel switching ---- */
    function showPanel(site) {
        const twitch = site === 'twitch';
        els.panelTwitch.classList.toggle('hidden', !twitch);
        els.panelYoutube.classList.toggle('hidden', twitch);
        els.tabTwitch.classList.toggle('active', twitch);
        els.tabYoutube.classList.toggle('active', !twitch);
    }

    // Pick the panel matching the site in the active tab. Tab URLs are only
    // visible for hosts we hold permissions for; anything else (or an API
    // hiccup) falls back to YouTube.
    async function detectSite() {
        try {
            const tabs = await api.tabs.query({ active: true, currentWindow: true });
            const url = (tabs && tabs[0] && tabs[0].url) || '';
            if (/^https?:\/\/([a-z0-9-]+\.)?twitch\.tv\//i.test(url)) return 'twitch';
        } catch (e) { /* ignore */ }
        return 'youtube';
    }

    function render() {
        // YouTube
        els.channels.textContent = data.blockedChannels.length;
        els.videos.textContent = data.hiddenVideoIds.length;
        els.enabled.checked = !!data.settings.enabled;
        els.shorts.checked = !!data.settings.blockShorts;
        els.watched.checked = !!data.settings.hideWatched;
        els.members.checked = !!data.settings.hideMembersOnly;
        els.paid.checked = !!data.settings.hidePaidVideos;
        els.reveal.checked = !!data.settings.revealHidden;
        els.wheelvol.checked = !!data.settings.wheelVolume;
        els.cinema.checked = !!data.settings.ytCinemaButton;
        els.threshold.value = data.settings.watchedThreshold;
        // Twitch
        els.twEnabled.checked = !!data.settings.twEnabled;
        els.twChannels.textContent = data.twitchBlockedChannels.length;
        els.twCategories.textContent = data.twitchBlockedCategories.length;
        els.twAutoclaim.checked = !!data.settings.twAutoClaim;
        els.twDrops.checked = !!data.settings.twAutoClaimDrops;
        els.twMoments.checked = !!data.settings.twAutoClaimMoments;
        els.twAnon.checked = !!data.settings.twAnonChat;
        els.twEmotes.checked = !!data.settings.twEmotes;
        els.twCinema.checked = !!data.settings.twCinemaButton;
        els.twCarousel.checked = !!data.settings.twHideCarousel;
        els.twHideChat.checked = !!data.settings.twHideChat;
        els.twClipHelper.checked = !!data.settings.twClipHelper;
        els.twMaxQuality.checked = !!data.settings.twMaxQuality;
        els.twHideExt.checked = !!data.settings.twHideExtensions;
    }

    function status(msg, isErr) {
        els.status.textContent = msg;
        els.status.classList.toggle('err', !!isErr);
        if (msg) setTimeout(() => { els.status.textContent = ''; els.status.classList.remove('err'); }, 3500);
    }

    function twStatus(msg, isErr) {
        els.twStatus.textContent = msg;
        els.twStatus.classList.toggle('err', !!isErr);
        if (msg) setTimeout(() => { els.twStatus.textContent = ''; els.twStatus.classList.remove('err'); }, 3500);
    }

    async function commit() {
        data = await YTB.save(data);
        render();
    }

    /* ---- YouTube actions ---- */
    async function addChannel() {
        const info = YTB.parseChannelInput(els.addInput.value);
        if (!info) { status('Enter a channel handle, URL, or name.', true); return; }
        if (YTB.addChannel(data, info)) {
            await commit();
            status('Blocked ' + YTB.channelLabel(info));
            els.addInput.value = '';
        } else {
            status('Already in the block list.', true);
        }
    }

    /* ---- Twitch actions ---- */
    async function addTwitchChannel() {
        const info = YTB.parseTwitchChannelInput(els.twAddInput.value);
        if (!info) { twStatus('Enter a channel name or twitch.tv URL.', true); return; }
        if (YTB.addTwitchChannel(data, info)) {
            await commit();
            twStatus('Blocked ' + YTB.twitchChannelLabel(info));
            els.twAddInput.value = '';
        } else {
            twStatus('Already in the block list.', true);
        }
    }

    async function addTwitchCategory() {
        const info = YTB.parseTwitchCategoryInput(els.twAddInput.value);
        if (!info) { twStatus('Enter a category name or its directory URL.', true); return; }
        if (YTB.addTwitchCategory(data, info)) {
            await commit();
            twStatus('Blocked category ' + YTB.twitchCategoryLabel(info));
            els.twAddInput.value = '';
        } else {
            twStatus('Already in the block list.', true);
        }
    }

    async function saveSettings() {
        data.settings.enabled = els.enabled.checked;
        data.settings.blockShorts = els.shorts.checked;
        data.settings.hideWatched = els.watched.checked;
        data.settings.hideMembersOnly = els.members.checked;
        data.settings.hidePaidVideos = els.paid.checked;
        data.settings.revealHidden = els.reveal.checked;
        data.settings.wheelVolume = els.wheelvol.checked;
        data.settings.ytCinemaButton = els.cinema.checked;
        data.settings.watchedThreshold = YTB.clampThreshold(els.threshold.value);
        data.settings.twEnabled = els.twEnabled.checked;
        data.settings.twAutoClaim = els.twAutoclaim.checked;
        data.settings.twAutoClaimDrops = els.twDrops.checked;
        data.settings.twAutoClaimMoments = els.twMoments.checked;
        data.settings.twAnonChat = els.twAnon.checked;
        data.settings.twEmotes = els.twEmotes.checked;
        data.settings.twCinemaButton = els.twCinema.checked;
        data.settings.twHideCarousel = els.twCarousel.checked;
        data.settings.twHideChat = els.twHideChat.checked;
        data.settings.twClipHelper = els.twClipHelper.checked;
        data.settings.twMaxQuality = els.twMaxQuality.checked;
        data.settings.twHideExtensions = els.twHideExt.checked;
        await commit();
    }

    function doExport() {
        YTB.downloadJson(data, YTB.exportFilename());
        status('Exported block list.');
    }

    function doImport(file) {
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const obj = JSON.parse(reader.result);
                if (!YTB.isValidPayload(obj)) throw new Error('bad');
                const res = YTB.mergeImport(data, obj);
                data = await YTB.save(res.data);
                render();
                status('Imported +' + res.addedChannels + ' channels, +' + res.addedVideos + ' videos.');
            } catch (e) {
                status('Could not read that file.', true);
            }
        };
        reader.readAsText(file);
    }

    async function doCopy() {
        try {
            await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
            status('Copied JSON to clipboard.');
        } catch (e) {
            status('Clipboard blocked — use Export instead.', true);
        }
    }

    function wire() {
        els.tabYoutube.addEventListener('click', () => showPanel('youtube'));
        els.tabTwitch.addEventListener('click', () => showPanel('twitch'));
        // YouTube
        els.addBtn.addEventListener('click', addChannel);
        els.addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addChannel(); });
        els.exportBtn.addEventListener('click', doExport);
        els.importBtn.addEventListener('click', () => els.importFile.click());
        els.importFile.addEventListener('change', (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; });
        els.copyBtn.addEventListener('click', doCopy);
        els.optionsBtn.addEventListener('click', () => {
            api.runtime.openOptionsPage();
            window.close();
        });
        // Twitch
        els.twAddChannelBtn.addEventListener('click', addTwitchChannel);
        els.twAddCategoryBtn.addEventListener('click', addTwitchCategory);
        els.twAddInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTwitchChannel(); });
        els.twOptionsBtn.addEventListener('click', () => {
            api.tabs.create({ url: api.runtime.getURL('src/twitch-options.html') }).catch(() => {});
            window.close();
        });
        // Settings (both panels)
        [els.enabled, els.shorts, els.watched, els.members, els.paid, els.reveal, els.wheelvol, els.cinema,
         els.twEnabled, els.twAutoclaim, els.twDrops, els.twMoments, els.twAnon,
         els.twEmotes, els.twCinema, els.twCarousel, els.twHideChat,
         els.twClipHelper, els.twMaxQuality, els.twHideExt
        ].forEach(c => c.addEventListener('change', saveSettings));
        els.threshold.addEventListener('change', saveSettings);
        YTB.onChanged((d) => { data = d; render(); });
    }

    async function start() {
        data = await YTB.load();
        wire();
        render();
        showPanel(await detectSite());
    }

    document.addEventListener('DOMContentLoaded', start);
})();
