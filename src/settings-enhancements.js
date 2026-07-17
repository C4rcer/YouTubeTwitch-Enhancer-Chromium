/* ==================================================================
 * Progressive settings UI for shared controls, playback profiles,
 * privacy, safer data management and local diagnostics.
 *
 * The options pages keep their established handlers. This module adds a
 * self-contained layer and only persists through YTB.load()/YTB.save().
 * Pure helpers are exported for dependency-free Node tests.
 * ================================================================== */
(function (root, factory) {
    'use strict';
    const api = factory(root && root.YTBFeatures);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.YTBSettingsEnhancements = api;
    if (root && root.document) api.schedule(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Features) {
    'use strict';

    const FEATURE_KEYS = Object.freeze([
        'inputBindings', 'playbackProfiles', 'activePlaybackProfiles',
        'channelPlaybackProfiles', 'ytCollections', 'twitchSidebar',
        'settingsPresets', 'hiddenVideoMetadata', 'twitchPlayer', 'twitchChatOverlay'
    ]);
    const CONTROL_FEATURE_KEYS = Object.freeze([
        'inputBindings', 'playbackProfiles', 'activePlaybackProfiles',
        'channelPlaybackProfiles', 'settingsPresets', 'twitchPlayer', 'twitchChatOverlay'
    ]);
    const YOUTUBE_LIST_KEYS = Object.freeze([
        'blockedChannels', 'hiddenVideoIds', 'blockedKeywords', 'ytCommentKeywords',
        'sbWhitelist', 'ytChannelSpeeds', 'hiddenVideoMetadata', 'ytCollections'
    ]);
    const TWITCH_LIST_KEYS = Object.freeze([
        'twitchBlockedChannels', 'twitchBlockedCategories', 'twitchBlockedKeywords',
        'twitchBlockedTags', 'twitchHighlightKeywords', 'twitchChatBlockKeywords',
        'twitchChatBlockUsers', 'twitchSidebar'
    ]);
    const UNDO_KEYS = new Set(['settings', ...FEATURE_KEYS, ...YOUTUBE_LIST_KEYS, ...TWITCH_LIST_KEYS]);
    const ADVANCED_TITLES = Object.freeze([
        'watched history', 'community data', 'chat performance', 'clean-up extras',
        'import / export', 'data, backup', 'diagnostics', 'input actions',
        'playback profiles', 'settings presets'
    ]);

    function clone(value) {
        if (typeof value === 'undefined') return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    function cleanText(value, max) {
        return typeof value === 'string'
            ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
            : '';
    }

    function slug(value, fallback) {
        const result = cleanText(value, 80).toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return result || fallback || 'section';
    }

    function matchesSearch(title, text, query) {
        const words = cleanText(query, 200).toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return true;
        const haystack = (String(title || '') + ' ' + String(text || ''))
            .toLowerCase().replace(/\s+/g, ' ');
        return words.every(word => haystack.includes(word));
    }

    function selectedKeys(categories) {
        const selected = new Set(Array.isArray(categories) ? categories : []);
        const keys = new Set();
        if (selected.has('settings')) keys.add('settings');
        if (selected.has('youtubeLists')) YOUTUBE_LIST_KEYS.forEach(key => keys.add(key));
        if (selected.has('twitchLists')) TWITCH_LIST_KEYS.forEach(key => keys.add(key));
        if (selected.has('features')) CONTROL_FEATURE_KEYS.forEach(key => keys.add(key));
        return [...keys];
    }

    function buildSelectivePayload(incoming, categories) {
        const source = incoming && typeof incoming === 'object' && !Array.isArray(incoming)
            ? incoming : {};
        const output = {};
        for (const key of selectedKeys(categories)) {
            if (Object.prototype.hasOwnProperty.call(source, key)) output[key] = clone(source[key]);
        }
        return output;
    }

    function snapshot(data, keys) {
        const output = {};
        for (const key of keys || []) {
            if (UNDO_KEYS.has(key) && Object.prototype.hasOwnProperty.call(data || {}, key)) {
                output[key] = clone(data[key]);
            }
        }
        return output;
    }

    function applyUndoSnapshot(current, before) {
        const output = clone(current && typeof current === 'object' ? current : {});
        if (!before || typeof before !== 'object' || Array.isArray(before)) return output;
        for (const [key, value] of Object.entries(before)) {
            if (UNDO_KEYS.has(key)) output[key] = clone(value);
        }
        return output;
    }

    function parseChannelRules(value, profileIds) {
        const valid = new Set(profileIds || []);
        const rules = {};
        const errors = [];
        const lines = String(value || '').split(/\r?\n/);
        lines.forEach((raw, index) => {
            const line = raw.trim();
            if (!line || line.startsWith('#')) return;
            const equals = line.indexOf('=');
            const channel = cleanText(equals < 0 ? '' : line.slice(0, equals), 120).toLowerCase();
            const profile = cleanText(equals < 0 ? '' : line.slice(equals + 1), 64).toLowerCase();
            if (!channel || !valid.has(profile)) {
                errors.push({ line: index + 1, value: line });
                return;
            }
            rules[channel] = profile;
        });
        return { rules, errors };
    }

    function profileRulesText(rules) {
        return Object.entries(rules && typeof rules === 'object' ? rules : {})
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([channel, profile]) => channel + ' = ' + profile).join('\n');
    }

    function integrationSummary(settings) {
        const s = settings || {};
        return [
            {
                id: 'sponsorblock', name: 'SponsorBlock', active: !!s.sbEnabled,
                detail: 'Hashed video-ID prefixes are sent for lookups; submissions send the video ID and segment times.'
            },
            {
                id: 'dearrow', name: 'DeArrow', active: !!(s.deArrowTitles || s.deArrowThumbs),
                detail: 'The current video ID is sent for community title or thumbnail lookups.'
            },
            {
                id: 'ryd', name: 'Return YouTube Dislike', active: !!s.rydEnabled,
                detail: 'The current video ID is sent for vote-count lookups.'
            },
            {
                id: 'emotes', name: 'BTTV, FFZ and 7TV', active: !!s.twEmotes,
                detail: 'Twitch channel identifiers are sent to the selected public emote services.'
            },
            {
                id: 'sync', name: 'Browser sync', active: !!s.syncBlockLists,
                detail: 'When enabled, supported block lists are stored through your browser account (for example, Chrome Sync).'
            }
        ];
    }

    function diagnosticsFrom(data, context) {
        const d = data && typeof data === 'object' ? data : {};
        const s = d.settings || {};
        const site = context && context.site;
        const profileId = d.activePlaybackProfiles && d.activePlaybackProfiles[site];
        const raw = {
            extensionVersion: cleanText(context && context.version, 30),
            site,
            activeProfile: profileId || 'default',
            capabilities: {
                configurableInputs: !!d.inputBindings,
                playbackProfiles: Array.isArray(d.playbackProfiles),
                localUndo: s.recentActionsEnabled !== false,
                syncBlockLists: !!s.syncBlockLists
            },
            featureHealth: {
                settingsLoaded: !!d.settings,
                inputsValid: !!d.inputBindings,
                profilesValid: Array.isArray(d.playbackProfiles)
            },
            storageCounts: {
                blockedYouTubeChannels: (d.blockedChannels || []).length,
                hiddenYouTubeVideos: (d.hiddenVideoIds || []).length,
                youtubeCollections: (d.ytCollections || []).length,
                blockedTwitchChannels: (d.twitchBlockedChannels || []).length,
                twitchFavourites: (d.twitchSidebar && d.twitchSidebar.favorites || []).length,
                recentActions: (d.recentActions || []).length
            },
            integrations: Object.fromEntries(integrationSummary(s).map(item => [item.id, item.active])),
            lastRecovery: {
                code: d.twitchDiagnostics && d.twitchDiagnostics.player && d.twitchDiagnostics.player.lastErrorKind,
                attempts: d.twitchDiagnostics && d.twitchDiagnostics.player && d.twitchDiagnostics.player.attempts,
                at: d.twitchDiagnostics && d.twitchDiagnostics.player && d.twitchDiagnostics.player.lastErrorAt
            }
        };
        return Features && Features.redactDiagnostics ? Features.redactDiagnostics(raw) : raw;
    }

    function schedule(win) {
        const start = () => boot(win).catch(error => {
            // Do not compromise the established settings page if enhancements fail.
            if (win.console && win.console.warn) win.console.warn('Settings enhancements unavailable', error);
        });
        if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    }

    async function boot(win) {
        const doc = win.document;
        const YTB = win.YTB;
        const F = win.YTBFeatures || Features;
        if (!YTB || !F || !doc.body || doc.body.dataset.ytbSettingsEnhanced === 'true') return;
        doc.body.dataset.ytbSettingsEnhanced = 'true';

        const browserApi = typeof win.browser !== 'undefined' ? win.browser : win.chrome;
        const site = /twitch-options\.html$/i.test(win.location.pathname) ? 'twitch' : 'youtube';
        const collapseKey = 'ytbCollapsedSections:' + site;
        let collapsedSections = new Set();
        try {
            const stored = JSON.parse(win.localStorage.getItem(collapseKey) || '[]');
            if (Array.isArray(stored)) collapsedSections = new Set(stored.filter(value => typeof value === 'string'));
        } catch (error) { /* localStorage can be unavailable in hardened contexts */ }
        const persistCollapsedSections = () => {
            try { win.localStorage.setItem(collapseKey, JSON.stringify([...collapsedSections])); }
            catch (error) { /* the UI remains usable without persistence */ }
        };
        let data = await YTB.load();
        let selectedProfileId = (data.activePlaybackProfiles && data.activePlaybackProfiles[site]) || 'default';
        let pendingImport = null;
        let pendingImportName = '';
        let globalSaveStatus = null;

        const node = (tag, attrs, children) => {
            const element = doc.createElement(tag);
            for (const [key, value] of Object.entries(attrs || {})) {
                if (key === 'class') element.className = value;
                else if (key === 'text') element.textContent = value;
                else if (key === 'checked') element.checked = !!value;
                else if (key === 'value') element.value = value == null ? '' : value;
                else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
                else if (value !== false && value != null) element.setAttribute(key, value === true ? '' : String(value));
            }
            const list = Array.isArray(children) ? children : children == null ? [] : [children];
            list.forEach(child => element.append(child && child.nodeType ? child : doc.createTextNode(String(child))));
            return element;
        };

        const setStatus = (element, message, isError) => {
            element.textContent = message || '';
            element.classList.toggle('err', !!isError);
        };

        const section = (title, description, advanced) => {
            const content = node('div', { class: 'ytb-section-content' });
            if (description) content.append(node('p', { class: 'muted ytb-section-description', text: description }));
            const result = node('section', {
                class: 'section ytb-dynamic-section' + (advanced ? ' ytb-advanced' : ''),
                'data-ytb-title': title
            }, [node('h2', { text: title }), content]);
            return { root: result, content };
        };

        const actionBeforeKeys = (keys) => [...new Set(keys.filter(key => UNDO_KEYS.has(key)))];
        async function updateData(label, keys, mutator) {
            if (globalSaveStatus) globalSaveStatus.textContent = 'Saving…';
            const latest = await YTB.load();
            const safeKeys = actionBeforeKeys(keys);
            const before = snapshot(latest, safeKeys);
            await mutator(latest);
            const after = snapshot(latest, safeKeys);
            if (JSON.stringify(before) === JSON.stringify(after)) {
                if (globalSaveStatus) globalSaveStatus.textContent = 'No changes';
                return latest;
            }
            if (latest.settings.recentActionsEnabled !== false) {
                latest.recentActions = F.addRecentAction(latest.recentActions, {
                    id: 'action-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
                    type: 'settings-change', label, before, after,
                    expiresAt: Date.now() + 7 * 86400000
                });
            }
            data = await YTB.save(latest);
            if (globalSaveStatus) globalSaveStatus.textContent = 'Saved';
            applyTheme(data.settings.settingsTheme);
            renderAll();
            return data;
        }

        function applyTheme(theme) {
            const value = ['light', 'dark'].includes(theme) ? theme : 'system';
            doc.documentElement.dataset.theme = value;
        }
        applyTheme(data.settings.settingsTheme);

        /* ---------------- Settings navigation and discovery ---------------- */
        const toolbar = node('div', { class: 'ytb-settings-toolbar', 'aria-label': 'Settings tools' });
        const siteNav = node('nav', { class: 'ytb-site-nav', 'aria-label': 'Site settings' }, [
            node('a', { href: 'options.html', class: site === 'youtube' ? 'active' : '', text: 'YouTube' }),
            node('a', { href: 'twitch-options.html', class: site === 'twitch' ? 'active twitch' : '', text: 'Twitch' })
        ]);
        const search = node('input', {
            type: 'search', class: 'ytb-settings-search',
            placeholder: 'Search settings…', 'aria-label': 'Search settings'
        });
        const searchStatus = node('span', { class: 'muted ytb-search-status', 'aria-live': 'polite' });
        const modeGroup = node('div', { class: 'ytb-mode-group', role: 'group', 'aria-label': 'Settings detail' });
        const basicButton = node('button', { type: 'button', text: 'Basic' });
        const advancedButton = node('button', { type: 'button', text: 'Advanced' });
        modeGroup.append(basicButton, advancedButton);
        const themeSelect = node('select', { 'aria-label': 'Settings colour theme', title: 'Settings colour theme' }, [
            node('option', { value: 'system', text: 'System theme' }),
            node('option', { value: 'light', text: 'Light theme' }),
            node('option', { value: 'dark', text: 'Dark theme' })
        ]);
        globalSaveStatus = node('span', { class: 'ytb-save-status', role: 'status', 'aria-live': 'polite', text: (site === 'youtube' ? 'YouTube' : 'Twitch') + ' settings loaded' });
        toolbar.append(siteNav, search, searchStatus, modeGroup, themeSelect, globalSaveStatus);
        const header = doc.querySelector('.header');
        (header ? header.after.bind(header) : doc.body.prepend.bind(doc.body))(toolbar);
        const toc = node('nav', { class: 'ytb-settings-toc', 'aria-label': 'Settings sections' });
        toolbar.after(toc);

        function isAdvancedTitle(title) {
            const lower = title.toLowerCase();
            return ADVANCED_TITLES.some(part => lower.includes(part));
        }

        function enhanceSections() {
            const used = new Set();
            const sections = [...doc.querySelectorAll(
                'body > .section, body > .twocol > .section, #ytb-enhancements-root > .section'
            )];
            toc.replaceChildren();
            for (const item of sections) {
                const heading = item.querySelector(':scope > h2');
                if (!heading) continue;
                const title = item.dataset.ytbTitle || heading.textContent.trim();
                item.dataset.ytbTitle = title;
                item.classList.add('ytb-settings-section');
                if (isAdvancedTitle(title)) item.classList.add('ytb-advanced');
                let id = 'settings-' + slug(title, 'section');
                let suffix = 2;
                while (used.has(id) || (doc.getElementById(id) && doc.getElementById(id) !== item)) id = 'settings-' + slug(title) + '-' + suffix++;
                used.add(id);
                item.id = id;
                if (collapsedSections.has(id)) item.classList.add('ytb-collapsed');
                if (!heading.querySelector('.ytb-collapse')) {
                    const isCollapsed = item.classList.contains('ytb-collapsed');
                    const collapse = node('button', {
                        type: 'button', class: 'ytb-collapse',
                        'aria-expanded': String(!isCollapsed),
                        'aria-label': (isCollapsed ? 'Expand ' : 'Collapse ') + title,
                        title: isCollapsed ? 'Expand section' : 'Collapse section',
                        text: isCollapsed ? '▸' : '▾'
                    });
                    collapse.addEventListener('click', () => {
                        const collapsed = item.classList.toggle('ytb-collapsed');
                        collapse.setAttribute('aria-expanded', String(!collapsed));
                        collapse.textContent = collapsed ? '▸' : '▾';
                        collapse.title = collapsed ? 'Expand section' : 'Collapse section';
                        collapse.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + title);
                        if (collapsed) collapsedSections.add(id); else collapsedSections.delete(id);
                        persistCollapsedSections();
                    });
                    heading.prepend(collapse);
                }
                const anchor = node('a', { href: '#' + id, text: title });
                toc.append(anchor);
            }
            applyFilters();
        }

        function applyFilters() {
            const mode = data.settings.settingsMode === 'advanced' ? 'advanced' : 'basic';
            const query = search.value;
            let visible = 0;
            const sections = [...doc.querySelectorAll('.ytb-settings-section')];
            for (const item of sections) {
                const searchMatch = matchesSearch(item.dataset.ytbTitle, item.textContent, query);
                const modeMatch = mode === 'advanced' || !item.classList.contains('ytb-advanced') || !!query.trim();
                item.classList.toggle('ytb-search-hidden', !(searchMatch && modeMatch));
                const link = toc.querySelector('a[href="#' + item.id + '"]');
                if (link) link.classList.toggle('hidden', !(searchMatch && modeMatch));
                if (searchMatch && modeMatch) visible++;
            }
            searchStatus.textContent = query.trim() ? visible + ' section' + (visible === 1 ? '' : 's') : '';
            basicButton.classList.toggle('active', mode === 'basic');
            advancedButton.classList.toggle('active', mode === 'advanced');
            basicButton.setAttribute('aria-pressed', String(mode === 'basic'));
            advancedButton.setAttribute('aria-pressed', String(mode === 'advanced'));
            themeSelect.value = ['system', 'light', 'dark'].includes(data.settings.settingsTheme)
                ? data.settings.settingsTheme : 'system';
        }
        search.addEventListener('input', applyFilters);
        basicButton.addEventListener('click', () => updateData('Changed settings detail to Basic', ['settings'], current => { current.settings.settingsMode = 'basic'; }));
        advancedButton.addEventListener('click', () => updateData('Changed settings detail to Advanced', ['settings'], current => { current.settings.settingsMode = 'advanced'; }));
        themeSelect.addEventListener('change', () => updateData('Changed settings theme', ['settings'], current => { current.settings.settingsTheme = themeSelect.value; }));

        const enhancementRoot = node('div', { id: 'ytb-enhancements-root' });
        const footer = doc.querySelector('.footer');
        footer ? footer.before(enhancementRoot) : doc.body.append(enhancementRoot);

        /* ---------------- Site feature switches ---------------- */
        const siteFeaturesSection = section(
            site === 'twitch' ? 'Twitch experience' : 'YouTube experience',
            'Enable or pause the new local workspace features independently.'
        );
        const siteFeatureInputs = new Map();
        const siteFeatureDefinitions = site === 'twitch' ? [
            ['twPlayerRecovery', 'Bounded player recovery', 'Retries recoverable rendered player errors with a visible cancel control.'],
            ['twSidebarTools', 'Sidebar favourites, groups and search', 'Organises rendered followed-channel entries using local extension storage.'],
            ['twChatOverlayButton', 'Theater/fullscreen chat overlay', 'Adds the reversible overlay control and keeps native chat behaviour.']
        ] : [
            ['ytTranscriptWorkspace', 'Transcript and chapter workspace', 'Adds the local dock and chapter actions on YouTube watch pages.'],
            ['ytCollectionsEnabled', 'Subscription collections', 'Adds local collection management and feed filtering without changing subscriptions.']
        ];
        for (const [key, label, detail] of siteFeatureDefinitions) {
            const input = node('input', { type: 'checkbox' });
            siteFeatureInputs.set(key, input);
            input.addEventListener('change', () => updateData(
                (input.checked ? 'Enabled ' : 'Disabled ') + label,
                ['settings'], current => { current.settings[key] = input.checked; }
            ));
            siteFeaturesSection.content.append(node('label', { class: 'toggle' }, [
                input, node('span', { class: 't-text' }, [
                    node('b', { text: label }), node('small', { text: detail })
                ])
            ]));
        }
        let twitchSeekStep = null;
        if (site === 'twitch') {
            twitchSeekStep = node('input', {
                type: 'number', min: '1', max: '60', step: '1',
                'aria-label': 'Twitch VOD and clip seek step in seconds'
            });
            twitchSeekStep.addEventListener('change', () => updateData(
                'Changed Twitch seek step', ['settings'], current => {
                    current.settings.twSeekStep = YTB.clampInt(twitchSeekStep.value, 1, 60, 10);
                }
            ));
            siteFeaturesSection.content.append(node('div', { class: 'row spread' }, [
                node('span', { text: 'VOD/clip seek step (seconds)' }), twitchSeekStep
            ]));
        }
        enhancementRoot.append(siteFeaturesSection.root);
        function renderSiteFeatures() {
            for (const [key, input] of siteFeatureInputs) input.checked = data.settings[key] !== false;
            if (twitchSeekStep) twitchSeekStep.value = data.settings.twSeekStep;
        }
        /* ---------------- C1: configurable input actions ---------------- */
        const bindingsSection = section('Input actions', 'Assign keyboard, auxiliary-mouse, or wheel gestures. Bindings are ignored while you type in a field.', true);
        const bindingsEnabled = node('input', { type: 'checkbox' });
        const bindingsTable = node('div', { class: 'ytb-bindings-table' });
        const bindingsWarning = node('div', { class: 'status', 'aria-live': 'polite' });
        const saveBindings = node('button', { type: 'button', class: 'primary', text: 'Save bindings' });
        const resetBindings = node('button', { type: 'button', text: 'Restore defaults' });
        bindingsSection.content.append(
            node('label', { class: 'toggle' }, [bindingsEnabled, node('span', { class: 't-text', text: 'Enable custom actions on ' + (site === 'twitch' ? 'Twitch' : 'YouTube') })]),
            bindingsTable, node('div', { class: 'row ytb-action-row' }, [saveBindings, resetBindings]), bindingsWarning
        );
        enhancementRoot.append(bindingsSection.root);
        let bindingDraft = null;

        function renderBindings() {
            const all = F.normalizeInputBindings(data.inputBindings);
            bindingDraft = clone(all);
            const current = bindingDraft[site];
            bindingsEnabled.checked = current.enabled;
            bindingsTable.replaceChildren(node('div', { class: 'ytb-binding-head' }, [
                node('b', { text: 'Action' }), node('b', { text: 'Keyboard' }),
                node('b', { text: 'Mouse' }), node('b', { text: 'Wheel' })
            ]));
            const actions = F.ACTION_CATALOGUE.filter(action => action.sites.includes(site));
            for (const action of actions) {
                const keyInput = node('input', {
                    type: 'text', readonly: true, value: current.keyboard[action.id] || '',
                    placeholder: 'Click, then press keys', 'aria-label': action.label + ' keyboard binding'
                });
                keyInput.addEventListener('keydown', event => {
                    event.preventDefault();
                    if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Escape') {
                        delete current.keyboard[action.id]; keyInput.value = ''; validateBindings(); return;
                    }
                    const chord = F.eventToChord(event);
                    if (chord) { current.keyboard[action.id] = chord; keyInput.value = chord; validateBindings(); }
                });
                const mouse = node('select', { 'aria-label': action.label + ' mouse binding' });
                [['', 'None'], ['Mouse1', 'Middle'], ['Mouse3', 'Back'], ['Mouse4', 'Forward']].forEach(([value, label]) => mouse.append(node('option', { value, text: label })));
                mouse.value = current.mouse[action.id] || '';
                mouse.addEventListener('change', () => {
                    if (mouse.value) current.mouse[action.id] = mouse.value; else delete current.mouse[action.id];
                    validateBindings();
                });
                const wheel = node('select', { 'aria-label': action.label + ' wheel binding' });
                [['', 'None'], ['WheelUp', 'Wheel up'], ['WheelDown', 'Wheel down']].forEach(([value, label]) => wheel.append(node('option', { value, text: label })));
                wheel.value = current.wheel[action.id] || '';
                wheel.addEventListener('change', () => {
                    if (wheel.value) current.wheel[action.id] = wheel.value; else delete current.wheel[action.id];
                    validateBindings();
                });
                bindingsTable.append(node('div', { class: 'ytb-binding-row' }, [
                    node('span', { text: action.label }), keyInput, mouse, wheel
                ]));
            }
            validateBindings();
        }

        function validateBindings() {
            bindingDraft[site].enabled = bindingsEnabled.checked;
            const conflicts = F.bindingConflicts(bindingDraft, site);
            const reserved = Object.values(bindingDraft[site].keyboard).filter(value => F.isReservedChord(value));
            const messages = [];
            if (conflicts.length) messages.push(conflicts.map(item => item.gesture + ' is assigned more than once').join('; '));
            if (reserved.length) messages.push('Browser-reserved shortcut: ' + [...new Set(reserved)].join(', '));
            setStatus(bindingsWarning, messages.join('. '), !!messages.length);
            saveBindings.disabled = !!messages.length;
        }
        bindingsEnabled.addEventListener('change', validateBindings);
        saveBindings.addEventListener('click', async () => {
            validateBindings();
            if (saveBindings.disabled) return;
            await updateData('Updated ' + site + ' input actions', ['inputBindings', 'settings'], current => {
                const normalized = F.normalizeInputBindings(bindingDraft);
                current.inputBindings[site] = normalized[site];
                const speedActions = new Set(['speedDown', 'speedUp', 'speedReset']);
                const hasSpeedBinding = ['keyboard', 'mouse', 'wheel'].some(type =>
                    Object.keys(normalized[site][type]).some(action => speedActions.has(action)));
                if (hasSpeedBinding) current.settings[site === 'youtube' ? 'ytSpeedHotkeys' : 'twSpeedHotkeys'] = true;
            });
            setStatus(bindingsWarning, 'Bindings saved.');
        });
        resetBindings.addEventListener('click', async () => {
            await updateData('Restored ' + site + ' input defaults', ['inputBindings', 'settings'], current => {
                current.inputBindings[site] = F.defaultInputBindings()[site];
                current.settings[site === 'youtube' ? 'ytSpeedHotkeys' : 'twSpeedHotkeys'] = true;
            });
            setStatus(bindingsWarning, 'Default bindings restored.');
        });

        /* ---------------- C2: profiles and per-channel rules ---------------- */
        const profilesSection = section('Playback profiles', 'Profiles can control speed, boost, quality, captions and compressor state globally or for a channel.', true);
        const profileSelect = node('select', { 'aria-label': 'Playback profile' });
        const activeProfile = node('select', { 'aria-label': 'Active playback profile' });
        const profileName = node('input', { type: 'text', maxlength: '60', placeholder: 'Profile name' });
        const profileSpeed = node('input', { type: 'number', min: '0.1', max: '8', step: '0.05', placeholder: 'unchanged' });
        const profileBoost = node('input', { type: 'number', min: '1', max: '5', step: '0.1', placeholder: 'unchanged' });
        const profileQuality = node('select');
        [['current', 'Keep current quality'], ['max', 'Maximum'], ['2160', '2160p'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']]
            .forEach(([value, label]) => profileQuality.append(node('option', { value, text: label })));
        const profileCaptions = node('select');
        [['unchanged', 'Captions unchanged'], ['on', 'Captions on'], ['off', 'Captions off']]
            .forEach(([value, label]) => profileCaptions.append(node('option', { value, text: label })));
        const profileCompressor = node('select');
        [['unchanged', 'Compressor unchanged'], ['on', 'Compressor on'], ['off', 'Compressor off']]
            .forEach(([value, label]) => profileCompressor.append(node('option', { value, text: label })));
        const profileYouTube = node('input', { type: 'checkbox' });
        const profileTwitch = node('input', { type: 'checkbox' });
        const newProfileName = node('input', { type: 'text', maxlength: '60', placeholder: 'New profile name' });
        const addProfile = node('button', { type: 'button', text: 'Add profile' });
        const saveProfile = node('button', { type: 'button', class: 'primary', text: 'Save profile' });
        const duplicateProfile = node('button', { type: 'button', text: 'Duplicate' });
        const resetProfile = node('button', { type: 'button', text: 'Reset values' });
        const deleteProfile = node('button', { type: 'button', class: 'danger', text: 'Delete profile' });
        const rules = node('textarea', { rows: '5', spellcheck: 'false', placeholder: 'channel-key = profile-id' });
        const saveRules = node('button', { type: 'button', text: 'Save channel rules' });
        const profileStatus = node('div', { class: 'status', 'aria-live': 'polite' });
        profilesSection.content.append(
            node('div', { class: 'ytb-form-grid' }, [
                node('label', {}, ['Edit profile', profileSelect]),
                node('label', {}, ['Active on ' + site, activeProfile]),
                node('label', {}, ['Name', profileName]),
                node('label', {}, ['Speed', profileSpeed]),
                node('label', {}, ['Volume boost', profileBoost]),
                node('label', {}, ['Quality', profileQuality]),
                node('label', {}, ['Captions', profileCaptions]),
                node('label', {}, ['Compressor', profileCompressor])
            ]),
            node('div', { class: 'row ytb-site-checks' }, [
                node('label', {}, [profileYouTube, ' YouTube']), node('label', {}, [profileTwitch, ' Twitch'])
            ]),
            node('div', { class: 'row' }, [saveProfile, duplicateProfile, resetProfile, deleteProfile]),
            node('div', { class: 'row ytb-add-profile' }, [newProfileName, addProfile]),
            node('h3', { text: 'Per-channel overrides' }),
            node('p', { class: 'muted', text: 'One rule per line. Use the stable channel key shown by the site tools, followed by a profile ID.' }),
            rules, saveRules, profileStatus
        );
        enhancementRoot.append(profilesSection.root);

        function renderProfiles() {
            const profiles = F.normalizePlaybackProfiles(data.playbackProfiles);
            if (!profiles.some(profile => profile.id === selectedProfileId)) selectedProfileId = 'default';
            profileSelect.replaceChildren(); activeProfile.replaceChildren();
            for (const profile of profiles) {
                profileSelect.append(node('option', { value: profile.id, text: profile.name + ' (' + profile.id + ')' }));
                if (profile.sites.includes(site)) activeProfile.append(node('option', { value: profile.id, text: profile.name }));
            }
            profileSelect.value = selectedProfileId;
            activeProfile.value = data.activePlaybackProfiles[site] || 'default';
            const profile = profiles.find(item => item.id === selectedProfileId) || profiles[0];
            profileName.value = profile.name;
            profileSpeed.value = profile.speed == null ? '' : profile.speed;
            profileBoost.value = profile.volumeBoost == null ? '' : profile.volumeBoost;
            profileQuality.value = profile.quality;
            profileCaptions.value = profile.captions;
            profileCompressor.value = profile.compressor;
            profileYouTube.checked = profile.sites.includes('youtube');
            profileTwitch.checked = profile.sites.includes('twitch');
            deleteProfile.disabled = profile.id === 'default';
            rules.value = profileRulesText(data.channelPlaybackProfiles[site]);
        }
        profileSelect.addEventListener('change', () => { selectedProfileId = profileSelect.value; renderProfiles(); });
        activeProfile.addEventListener('change', () => updateData('Activated playback profile on ' + site, ['activePlaybackProfiles'], current => {
            current.activePlaybackProfiles[site] = activeProfile.value;
        }));
        addProfile.addEventListener('click', async () => {
            const name = cleanText(newProfileName.value, 60);
            if (!name) { setStatus(profileStatus, 'Enter a profile name.', true); return; }
            const base = slug(name, 'profile');
            let id = base;
            const ids = new Set(data.playbackProfiles.map(profile => profile.id));
            let n = 2; while (ids.has(id)) id = base + '-' + n++;
            selectedProfileId = id;
            await updateData('Added playback profile ' + name, ['playbackProfiles'], current => {
                const profile = F.defaultProfile(id, name); profile.sites = [site];
                current.playbackProfiles.push(profile);
            });
            newProfileName.value = '';
            setStatus(profileStatus, 'Profile added.');
        });
        saveProfile.addEventListener('click', async () => {
            const sites = [];
            if (profileYouTube.checked) sites.push('youtube');
            if (profileTwitch.checked) sites.push('twitch');
            if (!sites.length) { setStatus(profileStatus, 'Select at least one site.', true); return; }
            await updateData('Updated playback profile ' + selectedProfileId, ['playbackProfiles'], current => {
                const profile = current.playbackProfiles.find(item => item.id === selectedProfileId);
                if (!profile) return;
                profile.name = cleanText(profileName.value, 60) || profile.name;
                profile.sites = sites;
                profile.speed = profileSpeed.value === '' ? null : Number(profileSpeed.value);
                profile.volumeBoost = profileBoost.value === '' ? null : Number(profileBoost.value);
                profile.quality = profileQuality.value;
                profile.captions = profileCaptions.value;
                profile.compressor = profileCompressor.value;
            });
            setStatus(profileStatus, 'Profile saved.');
        });
        duplicateProfile.addEventListener('click', async () => {
            const source = data.playbackProfiles.find(profile => profile.id === selectedProfileId);
            if (!source) return;
            const name = cleanText(source.name + ' Copy', 60);
            const base = slug(name, 'profile-copy');
            const ids = new Set(data.playbackProfiles.map(profile => profile.id));
            let id = base;
            let n = 2; while (ids.has(id)) id = base + '-' + n++;
            await updateData('Duplicated playback profile ' + source.name, ['playbackProfiles'], current => {
                const original = current.playbackProfiles.find(profile => profile.id === selectedProfileId);
                if (!original) return;
                const duplicate = clone(original);
                duplicate.id = id;
                duplicate.name = name;
                current.playbackProfiles.push(duplicate);
            });
            selectedProfileId = id;
            renderProfiles();
            setStatus(profileStatus, 'Profile duplicated.');
        });
        resetProfile.addEventListener('click', async () => {
            const source = data.playbackProfiles.find(profile => profile.id === selectedProfileId);
            if (!source || !win.confirm('Reset this profile’s playback values? Its name and site assignments will be kept.')) return;
            await updateData('Reset playback profile ' + source.name, ['playbackProfiles'], current => {
                const profile = current.playbackProfiles.find(item => item.id === selectedProfileId);
                if (!profile) return;
                const reset = F.defaultProfile(profile.id, profile.name);
                reset.sites = profile.sites.slice();
                Object.assign(profile, reset);
            });
            setStatus(profileStatus, 'Profile values reset.');
        });
        deleteProfile.addEventListener('click', async () => {
            if (selectedProfileId === 'default') return;
            if (!win.confirm('Delete this profile and its channel rules?')) return;
            const id = selectedProfileId; selectedProfileId = 'default';
            await updateData('Deleted playback profile ' + id,
                ['playbackProfiles', 'activePlaybackProfiles', 'channelPlaybackProfiles'], current => {
                    current.playbackProfiles = current.playbackProfiles.filter(profile => profile.id !== id);
                    for (const siteName of ['youtube', 'twitch']) {
                        if (current.activePlaybackProfiles[siteName] === id) current.activePlaybackProfiles[siteName] = 'default';
                        for (const [key, value] of Object.entries(current.channelPlaybackProfiles[siteName])) {
                            if (value === id) delete current.channelPlaybackProfiles[siteName][key];
                        }
                    }
                });
            setStatus(profileStatus, 'Profile deleted.');
        });
        saveRules.addEventListener('click', async () => {
            const ids = data.playbackProfiles.map(profile => profile.id);
            const parsed = parseChannelRules(rules.value, ids);
            if (parsed.errors.length) {
                setStatus(profileStatus, 'Fix invalid rule line' + (parsed.errors.length === 1 ? ' ' : 's ') + parsed.errors.map(item => item.line).join(', ') + '.', true);
                return;
            }
            await updateData('Updated ' + site + ' channel profile rules', ['channelPlaybackProfiles'], current => {
                current.channelPlaybackProfiles[site] = parsed.rules;
            });
            setStatus(profileStatus, 'Channel rules saved.');
        });

        /* ---------------- U1: named settings presets ---------------- */
        const presetsSection = section('Settings presets', 'Save the current simple on/off and numeric settings as a named preset. Lists and histories are never included.', true);
        const presetName = node('input', { type: 'text', maxlength: '60', placeholder: 'Preset name' });
        const savePreset = node('button', { type: 'button', text: 'Save current settings' });
        const presetList = node('div', { class: 'list ytb-preset-list' });
        const presetStatus = node('div', { class: 'status', 'aria-live': 'polite' });
        presetsSection.content.append(node('div', { class: 'row' }, [presetName, savePreset]), presetList, presetStatus);
        enhancementRoot.append(presetsSection.root);
        function renderPresets() {
            presetList.replaceChildren();
            if (!data.settingsPresets.length) presetList.append(node('div', { class: 'empty', text: 'No saved presets.' }));
            for (const preset of data.settingsPresets) {
                const apply = node('button', { type: 'button', text: 'Apply' });
                const remove = node('button', { type: 'button', class: 'danger', text: 'Delete' });
                apply.addEventListener('click', () => updateData('Applied settings preset ' + preset.name, ['settings'], current => {
                    current.settings = Object.assign({}, current.settings, preset.settings);
                }));
                remove.addEventListener('click', () => updateData('Deleted settings preset ' + preset.name, ['settingsPresets'], current => {
                    current.settingsPresets = current.settingsPresets.filter(item => item.id !== preset.id);
                }));
                presetList.append(node('div', { class: 'list-item' }, [
                    node('span', { class: 'grow', text: preset.name }), apply, remove
                ]));
            }
        }
        savePreset.addEventListener('click', async () => {
            const name = cleanText(presetName.value, 60);
            if (!name) { setStatus(presetStatus, 'Enter a preset name.', true); return; }
            await updateData('Saved settings preset ' + name, ['settingsPresets'], current => {
                current.settingsPresets.push({
                    id: slug(name, 'preset') + '-' + Date.now().toString(36), name,
                    settings: clone(current.settings), updatedAt: Date.now()
                });
            });
            presetName.value = '';
            setStatus(presetStatus, 'Preset saved.');
        });

        /* ---------------- U2/U3: privacy and accessibility ---------------- */
        const privacySection = section('Privacy and network access', 'Filtering, preferences, lists, profiles and diagnostics stay in extension storage. The integrations below make requests only while enabled.');
        const privacyList = node('div', { class: 'ytb-privacy-list' });
        const privacyNote = node('p', { class: 'muted', text: 'No custom enhancer backend is used. Normal YouTube and Twitch traffic remains subject to those sites’ privacy policies.' });
        privacySection.content.append(privacyList, privacyNote);
        enhancementRoot.append(privacySection.root);
        function renderPrivacy() {
            privacyList.replaceChildren();
            for (const item of integrationSummary(data.settings)) {
                privacyList.append(node('div', { class: 'ytb-privacy-row' }, [
                    node('span', { class: 'ytb-state ' + (item.active ? 'active' : ''), text: item.active ? 'Active' : 'Off' }),
                    node('div', { class: 'grow' }, [node('b', { text: item.name }), node('small', { text: item.detail })])
                ]));
            }
        }

        /* ---------------- U4: backup, preview, merge and reset ---------------- */
        const dataSection = section('Data, backup and reset', 'Preview a backup before merging selected categories. Reset actions require confirmation.', true);
        const exportBackup = node('button', { type: 'button', text: 'Download configuration backup' });
        const chooseImport = node('button', { type: 'button', text: 'Choose backup to preview' });
        const importFile = node('input', { type: 'file', accept: 'application/json,.json', class: 'hidden-input' });
        const preview = node('div', { class: 'ytb-import-preview hidden', 'aria-live': 'polite' });
        const importCategories = {};
        const categoryBox = node('fieldset', { class: 'ytb-import-categories hidden' }, [node('legend', { text: 'Import categories' })]);
        [['settings', 'Settings'], ['youtubeLists', 'YouTube lists and collections'], ['twitchLists', 'Twitch lists, favourites and groups'], ['features', 'Bindings, playback profiles, player/overlay preferences and presets']]
            .forEach(([id, label]) => {
                const input = node('input', { type: 'checkbox', checked: true }); importCategories[id] = input;
                categoryBox.append(node('label', {}, [input, ' ' + label]));
            });
        const importMode = node('select', { 'aria-label': 'Import mode' }, [
            node('option', { value: 'merge', text: 'Merge with current data' }),
            node('option', { value: 'replace', text: 'Replace selected categories' })
        ]);
        const importModeLabel = node('label', { class: 'ytb-import-mode hidden' }, ['Import mode', importMode]);
        const applyImport = node('button', { type: 'button', class: 'primary hidden', text: 'Merge selected categories' });
        const syncToggle = node('input', { type: 'checkbox' });
        const syncState = node('span', { class: 'muted ytb-sync-state', role: 'status', 'aria-live': 'polite' });
        const resetSettings = node('button', { type: 'button', class: 'danger', text: 'Reset settings to defaults' });
        const resetConfiguration = node('button', { type: 'button', class: 'danger', text: 'Reset all configuration' });
        const dataStatus = node('div', { class: 'status', 'aria-live': 'polite' });
        dataSection.content.append(
            node('div', { class: 'btn-grid' }, [exportBackup, chooseImport]), importFile, preview,
            categoryBox, importModeLabel, applyImport,
            node('label', { class: 'toggle ytb-sync-toggle' }, [syncToggle, node('span', { class: 't-text' }, [
                node('b', {}, ['Browser sync for supported block lists ', node('span', { class: 'network-badge', text: 'Browser sync' })]),
                node('small', {}, ['Visible here so Twitch users can see and control the same shared sync state. ', syncState])
            ])]),
            node('div', { class: 'row ytb-reset-row' }, [resetSettings, resetConfiguration]), dataStatus
        );
        enhancementRoot.append(dataSection.root);
        function manifestVersion() {
            try { return cleanText(browserApi.runtime.getManifest().version, 30); }
            catch (error) { return ''; }
        }
        async function downloadConfiguration(filename) {
            const backup = clone(await YTB.load());
            backup.backupVersion = manifestVersion() || 'unversioned';
            YTB.downloadJson(backup, filename);
        }
        exportBackup.addEventListener('click', async () => {
            await downloadConfiguration('youtube-twitch-enhancer-backup-' + new Date().toISOString().slice(0, 10) + '.json');
            setStatus(dataStatus, 'Backup downloaded. Watched-history shards remain a separate export in YouTube settings.');
        });
        chooseImport.addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', () => {
            const file = importFile.files && importFile.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const parsed = JSON.parse(reader.result);
                    const info = F.importPreview(parsed);
                    if (!info.valid || !YTB.isValidPayload(parsed)) throw new Error('Unsupported backup');
                    const cleanPreview = YTB.normalize(parsed);
                    const rawArrayKeys = [
                        'blockedChannels', 'hiddenVideoIds', 'blockedKeywords', 'sbWhitelist',
                        'ytCommentKeywords', 'playbackProfiles', 'ytCollections', 'settingsPresets',
                        'twitchBlockedChannels', 'twitchBlockedCategories', 'twitchBlockedKeywords',
                        'twitchBlockedTags', 'twitchHighlightKeywords', 'twitchChatBlockKeywords',
                        'twitchChatBlockUsers'
                    ];
                    let skipped = rawArrayKeys.reduce((total, key) => {
                        if (!Array.isArray(parsed[key])) return total;
                        const kept = Array.isArray(cleanPreview[key]) ? cleanPreview[key].length : 0;
                        return total + Math.max(0, parsed[key].length - kept);
                    }, 0);
                    if (Array.isArray(parsed.ytCollections)) {
                        const rawChannels = parsed.ytCollections.reduce((total, item) =>
                            total + (item && Array.isArray(item.channels) ? item.channels.length : 0), 0);
                        skipped += Math.max(0, rawChannels - info.counts.collectionChannels);
                    }
                    const sidebar = parsed.twitchSidebar && typeof parsed.twitchSidebar === 'object'
                        ? parsed.twitchSidebar : {};
                    const rawFavorites = Array.isArray(sidebar.favorites) ? sidebar.favorites
                        : Array.isArray(sidebar.favourites) ? sidebar.favourites : [];
                    const rawGroups = Array.isArray(sidebar.groups) ? sidebar.groups : [];
                    const rawGroupChannels = rawGroups.reduce((total, group) => total +
                        (group && Array.isArray(group.channels) ? group.channels.length
                            : group && Array.isArray(group.members) ? group.members.length : 0), 0);
                    const keptGroupChannels = cleanPreview.twitchSidebar.groups.reduce(
                        (total, group) => total + group.channels.length, 0);
                    skipped += Math.max(0, rawFavorites.length - info.counts.twitchFavorites);
                    skipped += Math.max(0, rawGroups.length - info.counts.twitchGroups);
                    skipped += Math.max(0, rawGroupChannels - keptGroupChannels);
                    const changedSettings = Object.entries(parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {})
                        .filter(([key]) => JSON.stringify(cleanPreview.settings[key]) !== JSON.stringify(data.settings[key])).length;
                    const backupVersion = cleanText(parsed.backupVersion || parsed.schemaVersion || '', 30) || 'legacy/unversioned';
                    pendingImport = parsed; pendingImportName = file.name;
                    preview.textContent = file.name + ' — version ' + backupVersion + '. ' +
                        info.counts.settings + ' settings (' + changedSettings + ' would change); ' + info.counts.profiles +
                        ' custom profiles; ' + info.counts.collections + ' collections (' +
                        info.counts.collectionChannels + ' channels); ' + info.counts.twitchFavorites +
                        ' Twitch favourites; ' + info.counts.twitchGroups + ' groups; ' +
                        info.counts.bindings + ' bindings. Malformed/skipped records: ' + skipped + '.';
                    preview.classList.remove('hidden');
                    categoryBox.classList.remove('hidden');
                    importModeLabel.classList.remove('hidden');
                    applyImport.classList.remove('hidden');
                    setStatus(dataStatus, 'Preview ready. Select categories and merge or replace, then apply.');
                } catch (error) {
                    pendingImport = null; preview.classList.add('hidden'); categoryBox.classList.add('hidden');
                    importModeLabel.classList.add('hidden'); applyImport.classList.add('hidden');
                    setStatus(dataStatus, 'That file is not a supported enhancer backup.', true);
                }
            };
            reader.readAsText(file); importFile.value = '';
        });
        importMode.addEventListener('change', () => {
            applyImport.textContent = importMode.value === 'replace'
                ? 'Replace selected categories' : 'Merge selected categories';
        });
        applyImport.addEventListener('click', async () => {
            if (!pendingImport) return;
            const categories = Object.entries(importCategories).filter(([, input]) => input.checked).map(([id]) => id);
            if (!categories.length) { setStatus(dataStatus, 'Select at least one category.', true); return; }
            const payload = buildSelectivePayload(pendingImport, categories);
            const keys = selectedKeys(categories);
            const mode = importMode.value === 'replace' ? 'replace' : 'merge';
            await updateData((mode === 'replace' ? 'Replaced' : 'Imported') + ' selected data from ' + pendingImportName, keys, current => {
                if (mode === 'replace') {
                    const clean = YTB.normalize(payload);
                    for (const key of keys) {
                        if (Object.prototype.hasOwnProperty.call(payload, key)) current[key] = clone(clean[key]);
                    }
                } else {
                    const merged = YTB.mergeImport(current, payload);
                    Object.assign(current, merged.data);
                }
            });
            pendingImport = null;
            preview.classList.add('hidden'); categoryBox.classList.add('hidden');
            importModeLabel.classList.add('hidden'); applyImport.classList.add('hidden');
            setStatus(dataStatus, mode === 'replace'
                ? 'Selected categories replaced. Other local categories were kept.'
                : 'Selected categories merged. Existing local entries won on conflicts.');
        });
        syncToggle.addEventListener('change', () => updateData((syncToggle.checked ? 'Enabled' : 'Disabled') + ' browser sync', ['settings'], current => {
            current.settings.syncBlockLists = syncToggle.checked;
        }));
        resetSettings.addEventListener('click', async () => {
            if (!win.confirm('Reset every setting to its default? Lists, profiles and collections will be kept.')) return;
            await downloadConfiguration('youtube-twitch-enhancer-pre-reset-' + new Date().toISOString().slice(0, 10) + '.json');
            await updateData('Reset settings to defaults', ['settings'], current => {
                current.settings = clone(YTB.DEFAULT_SETTINGS);
            });
            setStatus(dataStatus, 'Settings reset. You can undo this below for seven days.');
        });
        resetConfiguration.addEventListener('click', async () => {
            if (!win.confirm('Reset all enhancer configuration, lists, profiles and collections on this device? Watched-history shards are not changed.')) return;
            await downloadConfiguration('youtube-twitch-enhancer-pre-reset-' + new Date().toISOString().slice(0, 10) + '.json');
            const keys = ['settings', ...FEATURE_KEYS, ...YOUTUBE_LIST_KEYS, ...TWITCH_LIST_KEYS];
            await updateData('Reset all configuration', keys, current => {
                const fresh = YTB.normalize({});
                for (const key of Object.keys(current)) delete current[key];
                Object.assign(current, fresh);
            });
            setStatus(dataStatus, 'Configuration reset. Large datasets may exceed the local undo snapshot limit.');
        });

        /* ---------------- U5: redacted diagnostics and undo ---------------- */
        const diagnosticsSection = section('Diagnostics and recent actions', 'Diagnostics omit URLs, channel names, video IDs and message content. Recent enhancement actions can be undone locally for seven days.', true);
        const diagnosticsPre = node('pre', { class: 'ytb-diagnostics' });
        const copyDiagnostics = node('button', { type: 'button', text: 'Copy redacted diagnostics' });
        const recentList = node('div', { class: 'list ytb-recent-list' });
        const diagnosticsStatus = node('div', { class: 'status', 'aria-live': 'polite' });
        diagnosticsSection.content.append(diagnosticsPre, copyDiagnostics, node('h3', { text: 'Recent actions' }), recentList, diagnosticsStatus);
        enhancementRoot.append(diagnosticsSection.root);
        function diagnostics() {
            let version = '';
            try { version = browserApi.runtime.getManifest().version; } catch (error) { /* optional */ }
            return diagnosticsFrom(data, { site, version });
        }
        function renderDiagnostics() {
            diagnosticsPre.textContent = JSON.stringify(diagnostics(), null, 2);
            recentList.replaceChildren();
            const actions = F.normalizeRecentActions(data.recentActions);
            if (!actions.length) recentList.append(node('div', { class: 'empty', text: 'No recent enhancement actions.' }));
            for (const action of actions.slice(0, 12)) {
                const undo = node('button', { type: 'button', text: 'Undo' });
                const expired = action.expiresAt < Date.now();
                undo.disabled = expired || !action.before || !Object.keys(action.before).length;
                undo.title = expired ? 'Undo window expired' : '';
                undo.addEventListener('click', async () => {
                    const latest = await YTB.load();
                    const selected = (latest.recentActions || []).find(item => item.id === action.id);
                    if (!selected || !selected.before || selected.expiresAt < Date.now()) {
                        setStatus(diagnosticsStatus, 'That action can no longer be undone.', true); return;
                    }
                    const restored = applyUndoSnapshot(latest, selected.before);
                    restored.recentActions = (latest.recentActions || []).filter(item => item.id !== action.id);
                    data = await YTB.save(restored); renderAll();
                    setStatus(diagnosticsStatus, 'Undid: ' + action.label);
                });
                recentList.append(node('div', { class: 'list-item' }, [
                    node('div', { class: 'grow' }, [
                        node('div', { class: 'label', text: action.label }),
                        node('div', { class: 'meta', text: new Date(action.at).toLocaleString() })
                    ]), undo
                ]));
            }
        }
        copyDiagnostics.addEventListener('click', async () => {
            try {
                await win.navigator.clipboard.writeText(JSON.stringify(diagnostics(), null, 2));
                setStatus(diagnosticsStatus, 'Redacted diagnostics copied.');
            } catch (error) { setStatus(diagnosticsStatus, 'Clipboard access was blocked.', true); }
        });

        async function renderSyncState() {
            if (!data.settings.syncBlockLists) { syncState.textContent = ''; return; }
            try {
                const stored = await browserApi.storage.local.get('ytbSyncStatus');
                const state = stored.ytbSyncStatus;
                syncState.textContent = !state ? ''
                    : state.ok ? 'Last synced ' + new Date(state.at).toLocaleString() + '.'
                        : 'Sync error: ' + state.error;
            } catch (error) { /* the toggle stays usable without a status */ }
        }

        function renderAll() {
            applyTheme(data.settings.settingsTheme);
            renderSiteFeatures(); renderBindings(); renderProfiles(); renderPresets(); renderPrivacy(); renderDiagnostics();
            syncToggle.checked = !!data.settings.syncBlockLists;
            renderSyncState();
            applyFilters();
        }

        enhanceSections();
        renderAll();
        // Rebuild the table of contents now dynamic sections exist.
        [...enhancementRoot.children].forEach(item => {
            item.classList.add('ytb-settings-section');
            if (isAdvancedTitle(item.dataset.ytbTitle || '')) item.classList.add('ytb-advanced');
        });
        enhanceSections();
        YTB.onChanged(next => {
            data = next;
            if (globalSaveStatus) globalSaveStatus.textContent = 'Saved';
            renderAll();
        });
    }

    return Object.freeze({
        cleanText, slug, matchesSearch, selectedKeys, buildSelectivePayload,
        snapshot, applyUndoSnapshot, parseChannelRules, profileRulesText,
        integrationSummary, diagnosticsFrom, schedule
    });
});
