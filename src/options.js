/* global YTB, browser, chrome */
(function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;

    let data = null;
    let filterText = '';

    const $ = (id) => document.getElementById(id);
    const els = {
        enabled: $('set-enabled'),
        addInput: $('add-input'),
        addBtn: $('add-btn'),
        kwInput: $('kw-input'),
        kwBtn: $('kw-btn'),
        kwList: $('kw-list'),
        ckwInput: $('ckw-input'),
        ckwBtn: $('ckw-btn'),
        ckwList: $('ckw-list'),
        filterInput: $('filter-input'),
listSort: $('list-sort'),
        rmSelectedBtn: $('rm-selected-btn'),
        chCount: $('ch-count'),
        vidCount: $('vid-count'),
        channelList: $('channel-list'),
        videoList: $('video-list'),
        shorts: $('set-shorts'),
        watched: $('set-watched'),
        wHome: $('set-w-home'),
        wSubs: $('set-w-subs'),
        wSearch: $('set-w-search'),
        wRelated: $('set-w-related'),
        wChannel: $('set-w-channel'),
        wPlaylists: $('set-w-playlists'),
        flash: $('set-flash'),
        reveal: $('set-reveal'),
        blackout: $('set-blackout'),
        quality: $('set-quality'),
        wheelvol: $('set-wheelvol'),
        cinema: $('set-cinema'),
        speed: $('set-speed'),
        speedkeys: $('set-speedkeys'),
        speedchan: $('set-speedchan'),
        comp: $('set-comp'),
        loop: $('set-loop'),
        shot: $('set-shot'),
        nopause: $('set-nopause'),
        noautoplay: $('set-noautoplay'),
        expanddesc: $('set-expanddesc'),
        sb: $('set-sb'),
        sbSponsor: $('set-sb-sponsor'),
        sbSelfpromo: $('set-sb-selfpromo'),
        sbInteraction: $('set-sb-interaction'),
        sbIntro: $('set-sb-intro'),
        sbOutro: $('set-sb-outro'),
        sbPreview: $('set-sb-preview'),
        sbOfftopic: $('set-sb-offtopic'),
        sbFiller: $('set-sb-filler'),
        sbBadges: $('set-sb-badges'),
        deTitles: $('set-de-titles'),
        deThumbs: $('set-de-thumbs'),
        ryd: $('set-ryd'),
        sbWlInput: $('sb-wl-input'),
        sbWlAdd: $('sb-wl-add'),
        sbWlList: $('sb-wl-list'),
        promos: $('set-promos'),
        mixes: $('set-mixes'),
        playlists: $('set-playlists'),
        members: $('set-members'),
        paid: $('set-paid'),
        news: $('set-news'),
        spinner: $('set-spinner'),
        endscreen: $('set-endscreen'),
        threshold: $('set-threshold'),
        sync: $('set-sync'),
        syncStatus: $('sync-status'),
        exportBtn: $('export-btn'),
        importBtn: $('import-btn'),
        importFile: $('import-file'),
        copyBtn: $('copy-btn'),
        clearBtn: $('clear-btn'),
        status: $('status'),
        watchedCount: $('watched-count'),
        watchedExport: $('watched-export'),
        watchedImport: $('watched-import'),
        watchedImportFile: $('watched-import-file'),
        watchedClear: $('watched-clear'),
        watchedStatus: $('watched-status')
    };

    // Watched-history database (src/watched-db.js). May be absent if the
    // script failed to load; the section then reports "unavailable".
    const WDB = window.YTBWatchedDB || null;

    const PAGE_SIZE = 500;
    const listPages = { channels: 0, videos: 0 };

    function status(msg, isErr) {
        els.status.textContent = msg;
        els.status.classList.toggle('err', !!isErr);
        if (msg) setTimeout(() => { els.status.textContent = ''; els.status.classList.remove('err'); }, 4000);
    }

    function snapshotKeys(keys) {
        const output = {};
        for (const key of keys || []) output[key] = JSON.parse(JSON.stringify(data[key]));
        return output;
    }

    async function commit(recent) {
        if (recent && window.YTBFeatures && data.settings.recentActionsEnabled !== false) {
            data.recentActions = window.YTBFeatures.addRecentAction(data.recentActions, {
                id: 'action-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
                type: 'list-removal', label: recent.label, before: recent.before,
                after: snapshotKeys(recent.keys), expiresAt: Date.now() + 7 * 86400000
            });
        }
        data = await YTB.save(data);
        render();
    }

    function sortEntries(items, labelOf, addedAtOf) {
        const mode = els.listSort ? els.listSort.value : 'name';
        return items.slice().sort((a, b) => {
            if (mode === 'newest' || mode === 'oldest') {
                const delta = (Number(addedAtOf(a)) || 0) - (Number(addedAtOf(b)) || 0);
                if (delta) return mode === 'newest' ? -delta : delta;
            }
            return labelOf(a).toLowerCase().localeCompare(labelOf(b).toLowerCase());
        });
    }

    function pageEntries(items, kind) {
        const lastPage = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
        listPages[kind] = Math.min(lastPage, Math.max(0, listPages[kind] || 0));
        const start = listPages[kind] * PAGE_SIZE;
        return items.slice(start, start + PAGE_SIZE);
    }

    function appendPager(container, kind, total, rerender) {
        if (total <= PAGE_SIZE) return;
        const pages = Math.ceil(total / PAGE_SIZE);
        const nav = document.createElement('div');
        nav.className = 'list-item row spread';
        nav.setAttribute('role', 'navigation');
        nav.setAttribute('aria-label', kind + ' pages');
        const previous = document.createElement('button');
        previous.textContent = 'Previous';
        previous.disabled = listPages[kind] <= 0;
        previous.addEventListener('click', () => { listPages[kind]--; rerender(); });
        const label = document.createElement('span');
        label.textContent = 'Page ' + (listPages[kind] + 1) + ' of ' + pages + ' · ' + total + ' matches';
        const next = document.createElement('button');
        next.textContent = 'Next';
        next.disabled = listPages[kind] >= pages - 1;
        next.addEventListener('click', () => { listPages[kind]++; rerender(); });
        nav.append(previous, label, next);
        container.appendChild(nav);
    }

    /* ---- rendering ---- */
    function render() {
        renderChannels();
        renderVideos();
        renderKeywords();
        renderCommentKeywords();
        renderWhitelist();
        els.enabled.checked = !!data.settings.enabled;
        els.shorts.checked = !!data.settings.blockShorts;
        els.watched.checked = !!data.settings.hideWatched;
        els.wHome.checked = !!data.settings.watchedHome;
        els.wSubs.checked = !!data.settings.watchedSubs;
        els.wSearch.checked = !!data.settings.watchedSearch;
        els.wRelated.checked = !!data.settings.watchedRelated;
        els.wChannel.checked = !!data.settings.watchedChannel;
        els.wPlaylists.checked = !!data.settings.watchedPlaylists;
        els.flash.checked = !!data.settings.reduceFlashing;
        els.reveal.checked = !!data.settings.revealHidden;
        els.blackout.checked = !!data.settings.blackoutBlockedChannels;
        els.quality.checked = !!data.settings.maxQuality;
        els.wheelvol.checked = !!data.settings.wheelVolume;
        els.cinema.checked = !!data.settings.ytCinemaButton;
        els.speed.value = data.settings.ytSpeedDefault;
        els.speedkeys.checked = !!data.settings.ytSpeedHotkeys;
        els.speedchan.checked = !!data.settings.ytSpeedPerChannel;
        els.comp.checked = !!data.settings.ytCompressorButton;
        els.loop.checked = !!data.settings.ytLoopButton;
        els.shot.checked = !!data.settings.ytShotButton;
        els.nopause.checked = !!data.settings.ytNoPauseDialog;
        els.noautoplay.checked = !!data.settings.ytDisableAutoplay;
        els.expanddesc.checked = !!data.settings.ytAutoExpandDesc;
        els.sb.checked = !!data.settings.sbEnabled;
        els.sbSponsor.checked = !!data.settings.sbSkipSponsor;
        els.sbSelfpromo.checked = !!data.settings.sbSkipSelfpromo;
        els.sbInteraction.checked = !!data.settings.sbSkipInteraction;
        els.sbIntro.checked = !!data.settings.sbSkipIntro;
        els.sbOutro.checked = !!data.settings.sbSkipOutro;
        els.sbPreview.checked = !!data.settings.sbSkipPreview;
        els.sbOfftopic.checked = !!data.settings.sbSkipOfftopic;
        els.sbFiller.checked = !!data.settings.sbSkipFiller;
        els.sbBadges.checked = !!data.settings.sbThumbnailBadges;
        els.deTitles.checked = !!data.settings.deArrowTitles;
        els.deThumbs.checked = !!data.settings.deArrowThumbs;
        els.ryd.checked = !!data.settings.rydEnabled;
        els.promos.checked = !!data.settings.hidePromos;
        els.mixes.checked = !!data.settings.hideMixes;
        els.playlists.checked = !!data.settings.hidePlaylists;
        els.members.checked = !!data.settings.hideMembersOnly;
        els.paid.checked = !!data.settings.hidePaidVideos;
        els.news.checked = !!data.settings.hideNewsShelves;
        els.spinner.checked = !!data.settings.hideSidebarSpinner;
        els.endscreen.checked = !!data.settings.hideEndScreen;
        setThresholdValue(els.threshold, data.settings.watchedThreshold);
        els.sync.checked = !!data.settings.syncBlockLists;
        renderSyncStatus();
    }

    // The threshold is a fixed-choice dropdown (70/80/90/95/100), but a legacy
    // install may hold another value (e.g. the old 75% default). Surface it as
    // an extra option rather than silently snapping it to the wrong choice.
    function setThresholdValue(sel, val) {
        val = String(val);
        if (![...sel.options].some(o => o.value === val)) {
            const o = document.createElement('option');
            o.value = val;
            o.textContent = val + '% (current)';
            sel.appendChild(o);
        }
        sel.value = val;
    }

    /* ---- watched-history database ---- */
    function watchedStatus(msg, isErr) {
        els.watchedStatus.textContent = msg;
        els.watchedStatus.classList.toggle('err', !!isErr);
        if (msg) setTimeout(() => { els.watchedStatus.textContent = ''; els.watchedStatus.classList.remove('err'); }, 4000);
    }

    async function updateWatchedCount() {
        if (!WDB) { els.watchedCount.textContent = 'unavailable'; return; }
        try {
            els.watchedCount.textContent = (await WDB.getStoredCount()).toLocaleString();
        } catch (e) {
            els.watchedCount.textContent = '0';
        }
    }

    async function doWatchedExport() {
        if (!WDB) return;
        await WDB.whenReady();
        YTB.downloadJson(WDB.export(), 'youtube-watched-' + new Date().toISOString().slice(0, 10) + '.json');
        watchedStatus('Exported watched history.');
    }

    function doWatchedImport(file) {
        if (!WDB) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const obj = JSON.parse(reader.result);
                await WDB.whenReady();
                const added = WDB.import(obj);
                await WDB.flush();
                await updateWatchedCount();
                watchedStatus('Imported +' + added + ' watched videos (duplicates ignored).');
            } catch (e) {
                watchedStatus('Could not read that file — is it a watched-history export?', true);
            }
        };
        reader.readAsText(file);
    }

    async function doWatchedClear() {
        if (!WDB) return;
        if (!confirm('Erase your entire local watched history? This cannot be undone.')) return;
        try {
            await WDB.clear();
            await updateWatchedCount();
            watchedStatus('Watched history cleared.');
        } catch (e) {
            watchedStatus('Could not clear watched history. Your existing data was kept.', true);
        }
    }

    async function renderSyncStatus() {
        if (!data.settings.syncBlockLists) { els.syncStatus.textContent = ''; return; }
        try {
            const r = await api.storage.local.get('ytbSyncStatus');
            const s = r.ytbSyncStatus;
            if (!s) { els.syncStatus.textContent = ''; return; }
            els.syncStatus.textContent = s.ok
                ? 'Last synced ' + new Date(s.at).toLocaleString() + '.'
                : 'Sync error: ' + s.error;
        } catch (e) { /* ignore */ }
    }

    function matchesFilter(text) {
        return !filterText || text.toLowerCase().includes(filterText);
    }

    function selCheckbox(ref, kind) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'sel';
        cb.title = 'Select for bulk removal';
        cb.setAttribute('aria-label', 'Select ' + kind + ' for bulk removal');
        cb._ref = ref;
        cb._kind = kind;
        return cb;
    }

    function renderChannels() {
        els.chCount.textContent = data.blockedChannels.length;
        els.channelList.textContent = '';
        const filtered = sortEntries(data.blockedChannels.filter(c => {
            const hay = [YTB.channelLabel(c), c.handle, c.channelId].filter(Boolean).join(' ');
            return matchesFilter(hay);
        }), YTB.channelLabel, c => c.addedAt);
        for (const c of pageEntries(filtered, 'channels')) {
            const item = document.createElement('div');
            item.className = 'list-item';
            item.appendChild(selCheckbox(c, 'channel'));

            const grow = document.createElement('div');
            grow.className = 'grow';
            const label = document.createElement('a');
            label.className = 'label';
            label.href = YTB.channelUrl(c);
            label.target = '_blank';
            label.rel = 'noopener';
            label.textContent = YTB.channelLabel(c);
            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = [c.handle ? '@' + c.handle : '', c.channelId].filter(Boolean).join('  ·  ') || 'matched by name';
            grow.appendChild(label);
            grow.appendChild(meta);

            const rm = document.createElement('button');
            rm.className = 'icon danger';
            rm.title = 'Remove';
            rm.setAttribute('aria-label', 'Remove blocked channel');
            rm.textContent = '✕';
            rm.addEventListener('click', () => removeChannel(c));

            item.appendChild(grow);
            item.appendChild(rm);
            els.channelList.appendChild(item);
        }
        if (!filtered.length) {
            els.channelList.appendChild(emptyRow(
                data.blockedChannels.length ? 'No matches for the search.' : 'No channels blocked yet.'
            ));
        } else {
            appendPager(els.channelList, 'channels', filtered.length, renderChannels);
        }
    }
    function renderWhitelist() {
        if (!els.sbWlList) return;
        els.sbWlList.textContent = '';
        const list = (data.sbWhitelist || []).slice().sort(
            (a, b) => YTB.channelLabel(a).toLowerCase().localeCompare(YTB.channelLabel(b).toLowerCase())
        );
        if (!list.length) {
            els.sbWlList.appendChild(emptyRow('No whitelisted channels. SponsorBlock skips on every channel.'));
            return;
        }
        for (const c of list) {
            const item = document.createElement('div');
            item.className = 'list-item';

            const grow = document.createElement('div');
            grow.className = 'grow';
            const label = document.createElement('a');
            label.className = 'label';
            label.href = YTB.channelUrl(c);
            label.target = '_blank';
            label.rel = 'noopener';
            label.textContent = YTB.channelLabel(c);
            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = [c.handle ? '@' + c.handle : '', c.channelId].filter(Boolean).join('  ·  ') || 'matched by name';
            grow.appendChild(label);
            grow.appendChild(meta);

            const rm = document.createElement('button');
            rm.className = 'icon danger';
            rm.title = 'Remove from whitelist';
            rm.setAttribute('aria-label', rm.title);
            rm.textContent = '✕';
            rm.addEventListener('click', () => removeWhitelist(c));

            item.appendChild(grow);
            item.appendChild(rm);
            els.sbWlList.appendChild(item);
        }
    }

    function renderVideos() {
        els.vidCount.textContent = data.hiddenVideoIds.length;
        els.videoList.textContent = '';
        const filtered = sortEntries(data.hiddenVideoIds.filter(id => {
            const details = data.hiddenVideoMetadata && data.hiddenVideoMetadata[id] || {};
            return matchesFilter([id, details.title, details.channel].filter(Boolean).join(' '));
        }), id => {
            const details = data.hiddenVideoMetadata && data.hiddenVideoMetadata[id] || {};
            return details.title || id;
        }, id => {
            const details = data.hiddenVideoMetadata && data.hiddenVideoMetadata[id] || {};
            return details.addedAt;
        });
        for (const id of pageEntries(filtered, 'videos')) {
            const details = data.hiddenVideoMetadata && data.hiddenVideoMetadata[id] || {};
            const item = document.createElement('div');
            item.className = 'list-item';
            item.appendChild(selCheckbox(id, 'video'));

            const grow = document.createElement('div');
            grow.className = 'grow';
            const label = document.createElement('a');
            label.className = 'label';
            label.href = 'https://www.youtube.com/watch?v=' + id;
            label.target = '_blank';
            label.rel = 'noopener';
            label.textContent = details.title || id;
            grow.appendChild(label);
            if (details.title || details.channel) {
                const meta = document.createElement('div');
                meta.className = 'meta';
                const date = details.addedAt ? new Date(details.addedAt).toLocaleDateString() : '';
                meta.textContent = [details.channel, id, date].filter(Boolean).join(' · ');
                grow.appendChild(meta);
            }

            const rm = document.createElement('button');
            rm.className = 'icon danger';
            rm.title = 'Unhide';
            rm.setAttribute('aria-label', 'Unhide video');
            rm.textContent = '✕';
            rm.addEventListener('click', () => removeVideo(id));

            item.appendChild(grow);
            item.appendChild(rm);
            els.videoList.appendChild(item);
        }
        if (!filtered.length) {
            els.videoList.appendChild(emptyRow(
                data.hiddenVideoIds.length ? 'No matches for the search.' : 'No individually-hidden videos.'
            ));
        } else {
            appendPager(els.videoList, 'videos', filtered.length, renderVideos);
        }
    }
    function renderChipList(listEl, arr, emptyText, onRemove) {
        listEl.textContent = '';
        if (!arr.length) {
            listEl.appendChild(emptyRow(emptyText));
            return;
        }
        for (const k of arr) {
            const chip = document.createElement('span');
            chip.className = 'chip';
            const txt = document.createElement('span');
            txt.textContent = k;
            const rm = document.createElement('button');
            rm.title = 'Remove keyword';
            rm.setAttribute('aria-label', rm.title);
            rm.textContent = '✕';
            rm.addEventListener('click', () => onRemove(k));
            chip.appendChild(txt);
            chip.appendChild(rm);
            listEl.appendChild(chip);
        }
    }

    function renderKeywords() {
        renderChipList(els.kwList, data.blockedKeywords,
            'No keywords yet — videos are never filtered by title.', removeKeyword);
    }

    function renderCommentKeywords() {
        renderChipList(els.ckwList, data.ytCommentKeywords,
            'No keywords yet — comments are never filtered.', removeCommentKeyword);
    }

    function emptyRow(text) {
        const d = document.createElement('div');
        d.className = 'empty';
        d.textContent = text;
        return d;
    }

    /* ---- actions ---- */
    async function addChannel() {
        const info = YTB.parseChannelInput(els.addInput.value);
        if (!info) { status('Enter a channel handle, URL, ID, or name.', true); return; }
        if (YTB.addChannel(data, info)) {
            await commit();
            status('Blocked ' + YTB.channelLabel(info));
            els.addInput.value = '';
        } else {
            status('Already in the block list.', true);
        }
    }

    async function addKeyword() {
        const k = (els.kwInput.value || '').trim();
        if (!k) { status('Enter a keyword or /regex/.', true); return; }
        if (data.blockedKeywords.includes(k)) { status('Already in the keyword list.', true); return; }
        data.blockedKeywords.push(k);
        await commit();
        status('Added keyword "' + k + '".');
        els.kwInput.value = '';
    }

    async function removeKeyword(k) {
        const before = snapshotKeys(['blockedKeywords']);
        data.blockedKeywords = data.blockedKeywords.filter(x => x !== k);
        await commit({ label: 'Removed a YouTube title keyword', keys: ['blockedKeywords'], before });
        status('Removed keyword "' + k + '".');
    }

    async function addCommentKeyword() {
        const k = (els.ckwInput.value || '').trim();
        if (!k) { status('Enter a keyword or /regex/.', true); return; }
        if (data.ytCommentKeywords.includes(k)) { status('Already in the comment keyword list.', true); return; }
        data.ytCommentKeywords.push(k);
        await commit();
        status('Added comment keyword "' + k + '".');
        els.ckwInput.value = '';
    }

    async function removeCommentKeyword(k) {
        const before = snapshotKeys(['ytCommentKeywords']);
        data.ytCommentKeywords = data.ytCommentKeywords.filter(x => x !== k);
        await commit({ label: 'Removed a YouTube comment keyword', keys: ['ytCommentKeywords'], before });
        status('Removed comment keyword "' + k + '".');
    }

    async function removeChannel(c) {
        const before = snapshotKeys(['blockedChannels']);
        data.blockedChannels = data.blockedChannels.filter(x => !YTB.sameChannel(x, c));
        await commit({ label: 'Removed a blocked YouTube channel', keys: ['blockedChannels'], before });
        status('Removed ' + YTB.channelLabel(c) + ' (reload YouTube to see its videos again).');
    }

    async function addWhitelist() {
        const info = YTB.parseChannelInput(els.sbWlInput.value);
        if (!info) { status('Enter a channel handle, URL, ID, or name.', true); return; }
        if (YTB.addWhitelistChannel(data, info)) {
            await commit();
            status('Whitelisted ' + YTB.channelLabel(info) + '. SponsorBlock won’t skip there.');
            els.sbWlInput.value = '';
        } else {
            status('Already whitelisted.', true);
        }
    }

    async function removeWhitelist(c) {
        const before = snapshotKeys(['sbWhitelist']);
        data.sbWhitelist = (data.sbWhitelist || []).filter(x => !YTB.sameChannel(x, c));
        await commit({ label: 'Removed a SponsorBlock whitelist channel', keys: ['sbWhitelist'], before });
        status('Removed ' + YTB.channelLabel(c) + ' from the SponsorBlock whitelist.');
    }

    async function removeVideo(id) {
        const keys = ['hiddenVideoIds', 'hiddenVideoMetadata'];
        const before = snapshotKeys(keys);
        data.hiddenVideoIds = data.hiddenVideoIds.filter(x => x !== id);
        if (data.hiddenVideoMetadata) delete data.hiddenVideoMetadata[id];
        await commit({ label: 'Unhid a YouTube video', keys, before });
        status('Unhid ' + id + ' (reload YouTube to see it again).');
    }

    async function removeSelected() {
        const boxes = document.querySelectorAll('.list input.sel:checked');
        if (!boxes.length) { status('Tick some entries first.', true); return; }
        const keys = ['blockedChannels', 'hiddenVideoIds', 'hiddenVideoMetadata'];
        const before = snapshotKeys(keys);
        const channels = new Set(), videos = new Set();
        boxes.forEach(cb => (cb._kind === 'channel' ? channels : videos).add(cb._ref));
        data.blockedChannels = data.blockedChannels.filter(c => !channels.has(c));
        data.hiddenVideoIds = data.hiddenVideoIds.filter(id => !videos.has(id));
        if (data.hiddenVideoMetadata) videos.forEach(id => delete data.hiddenVideoMetadata[id]);
        await commit({ label: 'Removed selected YouTube list entries', keys, before });
        status('Removed ' + channels.size + ' channels and ' + videos.size + ' videos.');
    }

    async function saveSettings() {
        data.settings.enabled = els.enabled.checked;
        data.settings.blockShorts = els.shorts.checked;
        data.settings.hideWatched = els.watched.checked;
        data.settings.watchedHome = els.wHome.checked;
        data.settings.watchedSubs = els.wSubs.checked;
        data.settings.watchedSearch = els.wSearch.checked;
        data.settings.watchedRelated = els.wRelated.checked;
        data.settings.watchedChannel = els.wChannel.checked;
        data.settings.watchedPlaylists = els.wPlaylists.checked;
        data.settings.reduceFlashing = els.flash.checked;
        data.settings.revealHidden = els.reveal.checked;
        data.settings.blackoutBlockedChannels = els.blackout.checked;
        data.settings.maxQuality = els.quality.checked;
        data.settings.wheelVolume = els.wheelvol.checked;
        data.settings.ytCinemaButton = els.cinema.checked;
        data.settings.ytSpeedDefault = YTB.clampSpeed(els.speed.value);
        data.settings.ytSpeedHotkeys = els.speedkeys.checked;
        data.settings.ytSpeedPerChannel = els.speedchan.checked;
        data.settings.ytCompressorButton = els.comp.checked;
        data.settings.ytLoopButton = els.loop.checked;
        data.settings.ytShotButton = els.shot.checked;
        data.settings.ytNoPauseDialog = els.nopause.checked;
        data.settings.ytDisableAutoplay = els.noautoplay.checked;
        data.settings.ytAutoExpandDesc = els.expanddesc.checked;
        data.settings.sbEnabled = els.sb.checked;
        data.settings.sbSkipSponsor = els.sbSponsor.checked;
        data.settings.sbSkipSelfpromo = els.sbSelfpromo.checked;
        data.settings.sbSkipInteraction = els.sbInteraction.checked;
        data.settings.sbSkipIntro = els.sbIntro.checked;
        data.settings.sbSkipOutro = els.sbOutro.checked;
        data.settings.sbSkipPreview = els.sbPreview.checked;
        data.settings.sbSkipOfftopic = els.sbOfftopic.checked;
        data.settings.sbSkipFiller = els.sbFiller.checked;
        data.settings.sbThumbnailBadges = els.sbBadges.checked;
        data.settings.deArrowTitles = els.deTitles.checked;
        data.settings.deArrowThumbs = els.deThumbs.checked;
        data.settings.rydEnabled = els.ryd.checked;
        data.settings.hidePromos = els.promos.checked;
        data.settings.hideMixes = els.mixes.checked;
        data.settings.hidePlaylists = els.playlists.checked;
        data.settings.hideMembersOnly = els.members.checked;
        data.settings.hidePaidVideos = els.paid.checked;
        data.settings.hideNewsShelves = els.news.checked;
        data.settings.hideSidebarSpinner = els.spinner.checked;
        data.settings.hideEndScreen = els.endscreen.checked;
        data.settings.watchedThreshold = YTB.clampThreshold(els.threshold.value);
        data.settings.syncBlockLists = els.sync.checked;
        await commit();
    }

    function doExport() {
        YTB.downloadJson(data, YTB.exportFilename());
        status('Exported ' + data.blockedChannels.length + ' channels, ' +
               data.hiddenVideoIds.length + ' videos, ' + data.blockedKeywords.length + ' keywords.');
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
                status('Imported +' + res.addedChannels + ' channels, +' + res.addedVideos +
                       ' videos, +' + res.addedKeywords + ' keywords.');
            } catch (e) {
                status('Could not read that file — is it a valid export?', true);
            }
        };
        reader.readAsText(file);
    }

    async function doCopy() {
        try {
            await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
            status('Copied JSON to clipboard.');
        } catch (e) {
            status('Clipboard blocked — use Export to file instead.', true);
        }
    }

    async function doClear() {
        if (!confirm('Remove ALL blocked channels, hidden videos and keywords? Settings are kept.')) return;
        const keys = ['blockedChannels', 'hiddenVideoIds', 'hiddenVideoMetadata', 'blockedKeywords', 'ytCommentKeywords', 'sbWhitelist'];
        const before = snapshotKeys(keys);
        data.blockedChannels = [];
        data.hiddenVideoIds = [];
        data.hiddenVideoMetadata = {};
        data.blockedKeywords = [];
        data.ytCommentKeywords = [];
        data.sbWhitelist = [];
        await commit({ label: 'Cleared YouTube block lists', keys, before });
        status('Cleared the block list.');
    }

    function wire() {
        els.addBtn.addEventListener('click', addChannel);
        els.addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addChannel(); });
        els.kwBtn.addEventListener('click', addKeyword);
        els.kwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addKeyword(); });
        els.ckwBtn.addEventListener('click', addCommentKeyword);
        els.ckwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCommentKeyword(); });
        els.sbWlAdd.addEventListener('click', addWhitelist);
        els.sbWlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addWhitelist(); });
        els.filterInput.addEventListener('input', () => {
            filterText = els.filterInput.value.trim().toLowerCase();
            listPages.channels = 0; listPages.videos = 0;
            renderChannels();
            renderVideos();
        });
        els.listSort.addEventListener('change', () => {
            listPages.channels = 0; listPages.videos = 0;
            renderChannels(); renderVideos();
        });
        els.rmSelectedBtn.addEventListener('click', removeSelected);
        [els.enabled, els.shorts, els.watched,
         els.wHome, els.wSubs, els.wSearch, els.wRelated, els.wChannel, els.wPlaylists,
         els.flash, els.reveal, els.blackout, els.quality, els.wheelvol, els.cinema,
         els.speedkeys, els.speedchan, els.comp, els.loop, els.shot,
         els.nopause, els.noautoplay, els.expanddesc,
         els.sb, els.sbSponsor, els.sbSelfpromo, els.sbInteraction, els.sbIntro,
         els.sbOutro, els.sbPreview, els.sbOfftopic, els.sbFiller, els.sbBadges,
         els.deTitles, els.deThumbs, els.ryd,
         els.promos, els.mixes, els.playlists, els.members, els.paid, els.news, els.spinner, els.endscreen,
         els.sync
        ].forEach(c => c.addEventListener('change', saveSettings));
        els.threshold.addEventListener('change', saveSettings);
        els.speed.addEventListener('change', saveSettings);
        els.exportBtn.addEventListener('click', doExport);
        els.importBtn.addEventListener('click', () => els.importFile.click());
        els.importFile.addEventListener('change', (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; });
        els.copyBtn.addEventListener('click', doCopy);
        els.clearBtn.addEventListener('click', doClear);
        if (WDB) {
            els.watchedExport.addEventListener('click', doWatchedExport);
            els.watchedImport.addEventListener('click', () => els.watchedImportFile.click());
            els.watchedImportFile.addEventListener('change', (e) => { if (e.target.files[0]) doWatchedImport(e.target.files[0]); e.target.value = ''; });
            els.watchedClear.addEventListener('click', doWatchedClear);
        }
        wireSbUserId();
        YTB.onChanged((d) => { data = d; render(); });
    }

    // SponsorBlock user ID lives in its own storage key (outside `data`) so
    // list-clearing and sync never touch it. Pasting the ID from the
    // official SponsorBlock extension carries reputation over.
    function wireSbUserId() {
        const input = $('sb-uid');
        const copy = $('sb-uid-copy');
        if (!input) return;
        api.storage.local.get('sbUserId').then(r => { input.value = r.sbUserId || ''; });
        let t = null;
        input.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(() => {
                const v = input.value.trim();
                if (v) api.storage.local.set({ sbUserId: v });
                else api.storage.local.remove('sbUserId');
                status(v ? 'SponsorBlock user ID saved.' : 'SponsorBlock user ID cleared — a fresh one is generated on the next submission.');
            }, 500);
        });
        copy.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(input.value);
                status('SponsorBlock user ID copied.');
            } catch (e) {
                status('Could not copy — select the text manually.');
            }
        });
    }

    async function start() {
        data = await YTB.load();
        wire();
        render();
        updateWatchedCount();
    }

    document.addEventListener('DOMContentLoaded', start);
})();
