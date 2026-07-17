/* global YTB */
(function () {
    'use strict';

    let data = null;
    let filterText = '';

    const $ = (id) => document.getElementById(id);
    const els = {
        enabled: $('tw-enabled'),
        chInput: $('ch-input'),
        chBtn: $('ch-btn'),
        catInput: $('cat-input'),
        catBtn: $('cat-btn'),
        kwInput: $('kw-input'),
        kwBtn: $('kw-btn'),
        kwList: $('kw-list'),
        tagInput: $('tag-input'),
        tagBtn: $('tag-btn'),
        tagList: $('tag-list'),
        hlInput: $('hl-input'),
        hlBtn: $('hl-btn'),
        hlList: $('hl-list'),
        cbwInput: $('cbw-input'),
        cbwBtn: $('cbw-btn'),
        cbwList: $('cbw-list'),
        cbuInput: $('cbu-input'),
        cbuBtn: $('cbu-btn'),
        cbuList: $('cbu-list'),
        filterInput: $('filter-input'),
listSort: $('list-sort'),
        rmSelectedBtn: $('rm-selected-btn'),
        chCount: $('ch-count'),
        catCount: $('cat-count'),
        channelList: $('channel-list'),
        categoryList: $('category-list'),
        autoclaim: $('set-autoclaim'),
        drops: $('set-drops'),
        moments: $('set-moments'),
        anon: $('set-anon'),
        emotes: $('set-emotes'),
        clipdl: $('set-clipdl'),
        cinema: $('set-cinema'),
        carousel: $('set-carousel'),
        hidechat: $('set-hidechat'),
        cliphelper: $('set-cliphelper'),
        maxquality: $('set-maxquality'),
        hideext: $('set-hideext'),
        reruns: $('set-reruns'),
        compbtn: $('set-compbtn'),
        shotbtn: $('set-shotbtn'),
        speedkeys: $('set-speedkeys'),
        uptime: $('set-uptime'),
        previews: $('set-previews'),
        altshade: $('set-altshade'),
        showdeleted: $('set-showdeleted'),
        tabcomplete: $('set-tabcomplete'),
        lineLimit: $('set-linelimit'),
        lineLimitVal: $('linelimit-val'),
        batchMs: $('set-batchms'),
        batchMsVal: $('batchms-val'),
        smoothMs: $('set-smoothms'),
        smoothMsVal: $('smoothms-val'),
        exportBtn: $('export-btn'),
        importBtn: $('import-btn'),
        importFile: $('import-file'),
        copyBtn: $('copy-btn'),
        clearBtn: $('clear-btn'),
        status: $('status')
    };

    const PAGE_SIZE = 500;
    const listPages = { channels: 0, categories: 0 };

    // Chip lists all behave identically: an input + Add button feeding a
    // string array, rendered as removable chips.
    const CHIP_LISTS = [
        { input: 'kwInput', btn: 'kwBtn', list: 'kwList', field: 'twitchBlockedKeywords',
          what: 'keyword', empty: 'No keywords yet — streams are never filtered by title.' },
        { input: 'tagInput', btn: 'tagBtn', list: 'tagList', field: 'twitchBlockedTags',
          what: 'tag', empty: 'No tags yet — streams are never filtered by tag.' },
        { input: 'hlInput', btn: 'hlBtn', list: 'hlList', field: 'twitchHighlightKeywords',
          what: 'highlight keyword', empty: 'Nothing highlighted yet.' },
        { input: 'cbwInput', btn: 'cbwBtn', list: 'cbwList', field: 'twitchChatBlockKeywords',
          what: 'chat word', empty: 'No blocked chat words yet.' },
        { input: 'cbuInput', btn: 'cbuBtn', list: 'cbuList', field: 'twitchChatBlockUsers',
          what: 'chat user', empty: 'No blocked chat users yet.' }
    ];

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
        renderCategories();
        CHIP_LISTS.forEach(renderChips);
        els.enabled.checked = !!data.settings.twEnabled;
        els.autoclaim.checked = !!data.settings.twAutoClaim;
        els.drops.checked = !!data.settings.twAutoClaimDrops;
        els.moments.checked = !!data.settings.twAutoClaimMoments;
        els.anon.checked = !!data.settings.twAnonChat;
        els.emotes.checked = !!data.settings.twEmotes;
        els.clipdl.checked = !!data.settings.twClipDownload;
        els.cinema.checked = !!data.settings.twCinemaButton;
        els.carousel.checked = !!data.settings.twHideCarousel;
        els.hidechat.checked = !!data.settings.twHideChat;
        els.cliphelper.checked = !!data.settings.twClipHelper;
        els.maxquality.checked = !!data.settings.twMaxQuality;
        els.hideext.checked = !!data.settings.twHideExtensions;
        els.reruns.checked = !!data.settings.twHideReruns;
        els.compbtn.checked = !!data.settings.twCompressorButton;
        els.shotbtn.checked = !!data.settings.twShotButton;
        els.speedkeys.checked = !!data.settings.twSpeedHotkeys;
        els.uptime.checked = !!data.settings.twUptime;
        els.previews.checked = !!data.settings.twHoverPreviews;
        els.altshade.checked = !!data.settings.twAltShading;
        els.showdeleted.checked = !!data.settings.twShowDeleted;
        els.tabcomplete.checked = !!data.settings.twTabComplete;
        els.lineLimit.value = data.settings.twChatLineLimit;
        els.batchMs.value = data.settings.twChatBatchMs;
        els.smoothMs.value = data.settings.twSmoothScrollMs;
        renderSliderLabels();
    }

    function renderSliderLabels() {
        const v = (n, unit) => (parseInt(n, 10) > 0 ? n + unit : 'off');
        els.lineLimitVal.textContent = v(els.lineLimit.value, '');
        els.batchMsVal.textContent = v(els.batchMs.value, ' ms');
        els.smoothMsVal.textContent = v(els.smoothMs.value, ' ms');
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

    function emptyRow(text) {
        const d = document.createElement('div');
        d.className = 'empty';
        d.textContent = text;
        return d;
    }

    function renderChannels() {
        els.chCount.textContent = data.twitchBlockedChannels.length;
        els.channelList.textContent = '';
        const filtered = sortEntries(data.twitchBlockedChannels.filter(c => {
            const hay = [YTB.twitchChannelLabel(c), c.login].filter(Boolean).join(' ');
            return matchesFilter(hay);
        }), YTB.twitchChannelLabel, c => c.addedAt);
        for (const c of pageEntries(filtered, 'channels')) {
            const item = document.createElement('div');
            item.className = 'list-item';
            item.appendChild(selCheckbox(c, 'channel'));

            const grow = document.createElement('div');
            grow.className = 'grow';
            const label = document.createElement('a');
            label.className = 'label';
            label.href = YTB.twitchChannelUrl(c);
            label.target = '_blank';
            label.rel = 'noopener';
            label.textContent = YTB.twitchChannelLabel(c);
            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = c.login ? 'twitch.tv/' + c.login : 'matched by name';
            grow.appendChild(label);
            grow.appendChild(meta);

            const rm = document.createElement('button');
            rm.className = 'icon danger';
            rm.title = 'Remove';
            rm.setAttribute('aria-label', 'Remove blocked Twitch channel');
            rm.textContent = '✕';
            rm.addEventListener('click', () => removeChannel(c));

            item.appendChild(grow);
            item.appendChild(rm);
            els.channelList.appendChild(item);
        }
        if (!filtered.length) {
            els.channelList.appendChild(emptyRow(
                data.twitchBlockedChannels.length ? 'No matches for the search.' : 'No channels blocked yet.'
            ));
        } else {
            appendPager(els.channelList, 'channels', filtered.length, renderChannels);
        }
    }
    function renderCategories() {
        els.catCount.textContent = data.twitchBlockedCategories.length;
        els.categoryList.textContent = '';
        const filtered = sortEntries(data.twitchBlockedCategories.filter(c => {
            const hay = [YTB.twitchCategoryLabel(c), c.slug].filter(Boolean).join(' ');
            return matchesFilter(hay);
        }), YTB.twitchCategoryLabel, c => c.addedAt);
        for (const c of pageEntries(filtered, 'categories')) {
            const item = document.createElement('div');
            item.className = 'list-item';
            item.appendChild(selCheckbox(c, 'category'));

            const grow = document.createElement('div');
            grow.className = 'grow';
            const label = document.createElement('a');
            label.className = 'label';
            label.href = YTB.twitchCategoryUrl(c);
            label.target = '_blank';
            label.rel = 'noopener';
            label.textContent = YTB.twitchCategoryLabel(c);
            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = c.slug || '';
            grow.appendChild(label);
            grow.appendChild(meta);

            const rm = document.createElement('button');
            rm.className = 'icon danger';
            rm.title = 'Remove';
            rm.setAttribute('aria-label', 'Remove blocked Twitch category');
            rm.textContent = '✕';
            rm.addEventListener('click', () => removeCategory(c));

            item.appendChild(grow);
            item.appendChild(rm);
            els.categoryList.appendChild(item);
        }
        if (!filtered.length) {
            els.categoryList.appendChild(emptyRow(
                data.twitchBlockedCategories.length ? 'No matches for the search.' : 'No categories blocked yet.'
            ));
        } else {
            appendPager(els.categoryList, 'categories', filtered.length, renderCategories);
        }
    }
    function renderChips(cfg) {
        const list = els[cfg.list];
        list.textContent = '';
        const arr = data[cfg.field];
        if (!arr.length) {
            list.appendChild(emptyRow(cfg.empty));
            return;
        }
        for (const k of arr) {
            const chip = document.createElement('span');
            chip.className = 'chip';
            const txt = document.createElement('span');
            txt.textContent = k;
            const rm = document.createElement('button');
            rm.title = 'Remove ' + cfg.what;
            rm.setAttribute('aria-label', rm.title);
            rm.textContent = '✕';
            rm.addEventListener('click', () => removeChip(cfg, k));
            chip.appendChild(txt);
            chip.appendChild(rm);
            list.appendChild(chip);
        }
    }

    /* ---- actions ---- */
    async function addChannel() {
        const info = YTB.parseTwitchChannelInput(els.chInput.value);
        if (!info) { status('Enter a Twitch channel name or URL.', true); return; }
        if (YTB.addTwitchChannel(data, info)) {
            await commit();
            status('Blocked ' + YTB.twitchChannelLabel(info));
            els.chInput.value = '';
        } else {
            status('Already in the block list.', true);
        }
    }

    async function addCategory() {
        const info = YTB.parseTwitchCategoryInput(els.catInput.value);
        if (!info) { status('Enter a category name or its /directory/category/ URL.', true); return; }
        if (YTB.addTwitchCategory(data, info)) {
            await commit();
            status('Blocked category ' + YTB.twitchCategoryLabel(info));
            els.catInput.value = '';
        } else {
            status('Already in the block list.', true);
        }
    }

    async function addChip(cfg) {
        const k = (els[cfg.input].value || '').trim();
        if (!k) { status('Enter a ' + cfg.what + '.', true); return; }
        if (data[cfg.field].includes(k)) { status('Already in the list.', true); return; }
        data[cfg.field].push(k);
        await commit();
        status('Added ' + cfg.what + ' "' + k + '".');
        els[cfg.input].value = '';
    }

    async function removeChip(cfg, k) {
        const keys = [cfg.field];
        const before = snapshotKeys(keys);
        data[cfg.field] = data[cfg.field].filter(x => x !== k);
        await commit({ label: 'Removed a Twitch ' + cfg.what, keys, before });
        status('Removed ' + cfg.what + ' "' + k + '".');
    }

    async function removeChannel(c) {
        const before = snapshotKeys(['twitchBlockedChannels']);
        data.twitchBlockedChannels = data.twitchBlockedChannels.filter(x => !YTB.sameTwitchChannel(x, c));
        await commit({ label: 'Removed a blocked Twitch channel', keys: ['twitchBlockedChannels'], before });
        status('Removed ' + YTB.twitchChannelLabel(c) + ' (reload Twitch to see their streams again).');
    }

    async function removeCategory(c) {
        const before = snapshotKeys(['twitchBlockedCategories']);
        data.twitchBlockedCategories = data.twitchBlockedCategories.filter(x => !YTB.sameTwitchCategory(x, c));
        await commit({ label: 'Removed a blocked Twitch category', keys: ['twitchBlockedCategories'], before });
        status('Removed category ' + YTB.twitchCategoryLabel(c) + '.');
    }

    async function removeSelected() {
        const boxes = document.querySelectorAll('.list input.sel:checked');
        if (!boxes.length) { status('Tick some entries first.', true); return; }
        const keys = ['twitchBlockedChannels', 'twitchBlockedCategories'];
        const before = snapshotKeys(keys);
        const channels = new Set(), categories = new Set();
        boxes.forEach(cb => (cb._kind === 'channel' ? channels : categories).add(cb._ref));
        data.twitchBlockedChannels = data.twitchBlockedChannels.filter(c => !channels.has(c));
        data.twitchBlockedCategories = data.twitchBlockedCategories.filter(c => !categories.has(c));
        await commit({ label: 'Removed selected Twitch list entries', keys, before });
        status('Removed ' + channels.size + ' channels and ' + categories.size + ' categories.');
    }

    async function saveSettings() {
        data.settings.twEnabled = els.enabled.checked;
        data.settings.twAutoClaim = els.autoclaim.checked;
        data.settings.twAutoClaimDrops = els.drops.checked;
        data.settings.twAutoClaimMoments = els.moments.checked;
        data.settings.twAnonChat = els.anon.checked;
        data.settings.twEmotes = els.emotes.checked;
        data.settings.twClipDownload = els.clipdl.checked;
        data.settings.twCinemaButton = els.cinema.checked;
        data.settings.twHideCarousel = els.carousel.checked;
        data.settings.twHideChat = els.hidechat.checked;
        data.settings.twClipHelper = els.cliphelper.checked;
        data.settings.twMaxQuality = els.maxquality.checked;
        data.settings.twHideExtensions = els.hideext.checked;
        data.settings.twHideReruns = els.reruns.checked;
        data.settings.twCompressorButton = els.compbtn.checked;
        data.settings.twShotButton = els.shotbtn.checked;
        data.settings.twSpeedHotkeys = els.speedkeys.checked;
        data.settings.twUptime = els.uptime.checked;
        data.settings.twHoverPreviews = els.previews.checked;
        data.settings.twAltShading = els.altshade.checked;
        data.settings.twShowDeleted = els.showdeleted.checked;
        data.settings.twTabComplete = els.tabcomplete.checked;
        data.settings.twChatLineLimit = YTB.clampInt(els.lineLimit.value, 0, 1000, 0);
        data.settings.twChatBatchMs = YTB.clampInt(els.batchMs.value, 0, 2000, 0);
        data.settings.twSmoothScrollMs = YTB.clampInt(els.smoothMs.value, 0, 1000, 0);
        await commit();
    }

    function doExport() {
        YTB.downloadJson(data, YTB.exportFilename());
        status('Exported ' + data.twitchBlockedChannels.length + ' channels, ' +
               data.twitchBlockedCategories.length + ' categories, ' +
               data.twitchBlockedKeywords.length + ' keywords (plus the YouTube lists).');
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
                status('Imported +' + res.addedChannels + ' channels/categories, +' + res.addedKeywords + ' keywords.');
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
        if (!confirm('Remove ALL blocked Twitch channels, categories, keywords, tags and chat filters? YouTube lists and settings are kept.')) return;
        const keys = ['twitchBlockedChannels', 'twitchBlockedCategories', 'twitchBlockedKeywords', 'twitchBlockedTags', 'twitchHighlightKeywords', 'twitchChatBlockKeywords', 'twitchChatBlockUsers'];
        const before = snapshotKeys(keys);
        data.twitchBlockedChannels = [];
        data.twitchBlockedCategories = [];
        data.twitchBlockedKeywords = [];
        data.twitchBlockedTags = [];
        data.twitchHighlightKeywords = [];
        data.twitchChatBlockKeywords = [];
        data.twitchChatBlockUsers = [];
        await commit({ label: 'Cleared Twitch block lists', keys, before });
        status('Cleared the Twitch block lists.');
    }

    function wire() {
        els.chBtn.addEventListener('click', addChannel);
        els.chInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addChannel(); });
        els.catBtn.addEventListener('click', addCategory);
        els.catInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCategory(); });
        for (const cfg of CHIP_LISTS) {
            els[cfg.btn].addEventListener('click', () => addChip(cfg));
            els[cfg.input].addEventListener('keydown', (e) => { if (e.key === 'Enter') addChip(cfg); });
        }
        els.filterInput.addEventListener('input', () => {
            filterText = els.filterInput.value.trim().toLowerCase();
            listPages.channels = 0; listPages.categories = 0;
            renderChannels();
            renderCategories();
        });
        els.listSort.addEventListener('change', () => {
            listPages.channels = 0; listPages.categories = 0;
            renderChannels(); renderCategories();
        });
        els.rmSelectedBtn.addEventListener('click', removeSelected);
        [els.enabled, els.autoclaim, els.drops, els.moments, els.anon,
         els.emotes, els.clipdl, els.cinema, els.carousel, els.hidechat,
         els.cliphelper, els.maxquality, els.hideext,
         els.reruns, els.compbtn, els.shotbtn, els.speedkeys, els.uptime,
         els.previews, els.altshade, els.showdeleted, els.tabcomplete
        ].forEach(c => c.addEventListener('change', saveSettings));
        [els.lineLimit, els.batchMs, els.smoothMs].forEach(s => {
            s.addEventListener('input', renderSliderLabels);
            s.addEventListener('change', saveSettings);
        });
        els.exportBtn.addEventListener('click', doExport);
        els.importBtn.addEventListener('click', () => els.importFile.click());
        els.importFile.addEventListener('change', (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; });
        els.copyBtn.addEventListener('click', doCopy);
        els.clearBtn.addEventListener('click', doClear);
        YTB.onChanged((d) => { data = d; render(); });
    }

    async function start() {
        data = await YTB.load();
        wire();
        render();
    }

    document.addEventListener('DOMContentLoaded', start);
})();
