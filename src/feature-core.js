/* ==================================================================
 * Shared pure helpers for configurable controls, playback profiles and
 * resumable feature data. Loaded before common.js/content modules and also
 * exported under Node for dependency-free tests.
 * ================================================================== */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.YTBFeatures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SITES = ['youtube', 'twitch'];
    const INPUT_TYPES = ['keyboard', 'mouse', 'wheel'];
    const MAX_PROFILES = 32;
    const MAX_CHANNEL_RULES = 500;
    const MAX_COLLECTIONS = 40;
    const MAX_COLLECTION_CHANNELS = 500;
    const MAX_SIDEBAR_GROUPS = 30;
    const MAX_SIDEBAR_CHANNELS = 250;
    const MAX_RECENT_ACTIONS = 50;

    const ACTION_CATALOGUE = Object.freeze([
        { id: 'playPause', label: 'Play / pause', sites: SITES },
        { id: 'seekBackward', label: 'Seek backward', sites: SITES },
        { id: 'seekForward', label: 'Seek forward', sites: SITES },
        { id: 'frameBackward', label: 'Previous frame', sites: ['youtube'] },
        { id: 'frameForward', label: 'Next frame', sites: ['youtube'] },
        { id: 'speedDown', label: 'Decrease speed', sites: SITES },
        { id: 'speedUp', label: 'Increase speed', sites: SITES },
        { id: 'speedReset', label: 'Reset speed', sites: SITES },
        { id: 'volumeDown', label: 'Volume down', sites: SITES },
        { id: 'volumeUp', label: 'Volume up', sites: SITES },
        { id: 'mute', label: 'Mute / unmute', sites: SITES },
        { id: 'screenshot', label: 'Screenshot', sites: SITES },
        { id: 'loop', label: 'A-B loop', sites: ['youtube'] },
        { id: 'cinema', label: 'Cinema mode', sites: SITES },
        { id: 'captions', label: 'Captions', sites: SITES },
        { id: 'previousChapter', label: 'Previous chapter', sites: ['youtube'] },
        { id: 'nextChapter', label: 'Next chapter', sites: ['youtube'] },
        { id: 'liveEdge', label: 'Jump to live edge', sites: ['twitch'] },
        { id: 'chatOverlay', label: 'Chat overlay', sites: ['twitch'] }
    ]);

    const ACTION_IDS = new Set(ACTION_CATALOGUE.map(a => a.id));
    const SITE_ACTIONS = Object.fromEntries(SITES.map(site => [
        site,
        new Set(ACTION_CATALOGUE.filter(a => a.sites.includes(site)).map(a => a.id))
    ]));

    const DEFAULT_INPUT_BINDINGS = Object.freeze({
        youtube: Object.freeze({
            enabled: true,
            keyboard: Object.freeze({
                speedDown: 'BracketLeft',
                speedUp: 'BracketRight',
                speedReset: 'Backslash'
            }),
            mouse: Object.freeze({}),
            wheel: Object.freeze({})
        }),
        twitch: Object.freeze({
            enabled: true,
            keyboard: Object.freeze({
                speedDown: 'BracketLeft',
                speedUp: 'BracketRight',
                speedReset: 'Backslash'
            }),
            mouse: Object.freeze({}),
            wheel: Object.freeze({})
        })
    });

    const DEFAULT_PLAYBACK_PROFILE = Object.freeze({
        id: 'default',
        name: 'Default',
        sites: Object.freeze(['youtube', 'twitch']),
        speed: null,
        volumeBoost: null,
        quality: 'current',
        captions: 'unchanged',
        compressor: 'unchanged'
    });

    const QUALITY_VALUES = new Set([
        'current', 'max', '2160', '1440', '1080', '720', '480', '360'
    ]);
    const TRI_VALUES = new Set(['unchanged', 'on', 'off']);

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function cleanText(value, max) {
        return typeof value === 'string'
            ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
            : '';
    }

    function cleanId(value, fallback) {
        const id = cleanText(value, 64).toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        return id || fallback;
    }

    function finiteNumber(value, min, max) {
        if (value === null || value === '' || typeof value === 'undefined') return null;
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        return Math.min(max, Math.max(min, Math.round(number * 100) / 100));
    }

    function normalizeCode(value) {
        const raw = cleanText(value, 40);
        if (!raw) return '';
        const aliases = {
            '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
            ' ': 'Space', spacebar: 'Space', esc: 'Escape',
            left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
            plus: 'Equal', minus: 'Minus', comma: 'Comma', period: 'Period'
        };
        const lower = raw.toLowerCase();
        if (aliases[lower]) return aliases[lower];
        if (/^[a-z]$/i.test(raw)) return 'Key' + raw.toUpperCase();
        if (/^[0-9]$/.test(raw)) return 'Digit' + raw;
        if (/^f(?:[1-9]|1[0-2])$/i.test(raw)) return raw.toUpperCase();
        if (/^(?:Key[A-Z]|Digit[0-9]|Numpad\w+|Arrow(?:Left|Right|Up|Down)|Bracket(?:Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Minus|Equal|Space|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown)$/i.test(raw)) {
            if (/^key/i.test(raw)) return 'Key' + raw.slice(3).toUpperCase();
            if (/^digit/i.test(raw)) return 'Digit' + raw.slice(5);
            return raw[0].toUpperCase() + raw.slice(1);
        }
        return '';
    }

    function normalizeKeyChord(value) {
        if (typeof value !== 'string') return '';
        const parts = value.split('+').map(p => p.trim()).filter(Boolean);
        if (!parts.length) return '';
        const modifiers = new Set();
        let code = '';
        for (const part of parts) {
            const key = part.toLowerCase();
            if (key === 'ctrl' || key === 'control') modifiers.add('Ctrl');
            else if (key === 'alt' || key === 'option') modifiers.add('Alt');
            else if (key === 'shift') modifiers.add('Shift');
            else if (key === 'meta' || key === 'cmd' || key === 'command' || key === 'super') modifiers.add('Meta');
            else {
                if (code) return '';
                code = normalizeCode(part);
            }
        }
        if (!code) return '';
        const ordered = ['Ctrl', 'Alt', 'Shift', 'Meta'].filter(m => modifiers.has(m));
        ordered.push(code);
        return ordered.join('+');
    }

    function eventToChord(event) {
        if (!event || event.isComposing) return '';
        const code = normalizeCode(event.code || event.key || '');
        if (!code || /^(?:Shift|Control|Alt|Meta)(?:Left|Right)?$/.test(code)) return '';
        const parts = [];
        if (event.ctrlKey) parts.push('Ctrl');
        if (event.altKey) parts.push('Alt');
        if (event.shiftKey) parts.push('Shift');
        if (event.metaKey) parts.push('Meta');
        parts.push(code);
        return parts.join('+');
    }

    function isEditableTarget(target) {
        if (!target) return false;
        const node = target.nodeType === 3 ? target.parentElement : target;
        if (!node) return false;
        if (node.isContentEditable) return true;
        const tag = String(node.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        return typeof node.closest === 'function' &&
            !!node.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
    }

    function isReservedChord(value) {
        const chord = normalizeKeyChord(value);
        if (!chord) return false;
        if (chord === 'F5' || chord === 'F11') return true;
        if (chord === 'Alt+ArrowLeft' || chord === 'Alt+ArrowRight') return true;
        const match = chord.match(/^(Ctrl|Meta)(?:\+Shift)?\+(Key[A-Z]|Digit[0-9])$/);
        if (!match) return false;
        const code = match[2];
        return new Set([
            'KeyL', 'KeyT', 'KeyW', 'KeyN', 'KeyR', 'KeyQ',
            'KeyI', 'KeyJ', 'KeyC', 'KeyU', 'KeyS', 'KeyP'
        ]).has(code);
    }

    function defaultInputBindings() {
        return clone(DEFAULT_INPUT_BINDINGS);
    }

    function normalizeInputBindings(value) {
        const input = value && typeof value === 'object' ? value : {};
        const output = defaultInputBindings();
        for (const site of SITES) {
            const source = input[site];
            if (!source || typeof source !== 'object') continue;
            output[site].enabled = source.enabled !== false;
            for (const type of INPUT_TYPES) {
                const map = source[type];
                if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
                output[site][type] = {};
                for (const action of Object.keys(map)) {
                    if (!SITE_ACTIONS[site].has(action)) continue;
                    const raw = cleanText(map[action], 50);
                    let gesture = '';
                    if (type === 'keyboard') gesture = normalizeKeyChord(raw);
                    else if (type === 'mouse' && /^Mouse(?:[0-9]|1[0-6])$/.test(raw)) gesture = raw;
                    else if (type === 'wheel' && /^(?:WheelUp|WheelDown)$/.test(raw)) gesture = raw;
                    if (gesture) output[site][type][action] = gesture;
                }
            }
        }
        return output;
    }

    function bindingConflicts(value, site) {
        const bindings = normalizeInputBindings(value);
        const sites = SITES.includes(site) ? [site] : SITES;
        const conflicts = [];
        for (const siteName of sites) {
            for (const type of INPUT_TYPES) {
                const byGesture = new Map();
                for (const [action, gesture] of Object.entries(bindings[siteName][type])) {
                    if (!byGesture.has(gesture)) byGesture.set(gesture, []);
                    byGesture.get(gesture).push(action);
                }
                for (const [gesture, actions] of byGesture) {
                    if (actions.length > 1) conflicts.push({
                        site: siteName, type, gesture, actions: actions.sort()
                    });
                }
            }
        }
        return conflicts;
    }

    function defaultProfile(id, name) {
        const result = clone(DEFAULT_PLAYBACK_PROFILE);
        result.id = cleanId(id, 'default');
        result.name = cleanText(name, 60) || (result.id === 'default' ? 'Default' : 'Profile');
        return result;
    }

    function normalizeProfile(profile, index) {
        const fallbackId = index === 0 ? 'default' : 'profile-' + (index + 1);
        const output = defaultProfile(profile && profile.id, profile && profile.name);
        output.id = cleanId(profile && profile.id, fallbackId);
        const rawSites = profile && Array.isArray(profile.sites) ? profile.sites : SITES;
        output.sites = [...new Set(rawSites.filter(site => SITES.includes(site)))];
        if (!output.sites.length) output.sites = [...SITES];
        output.speed = finiteNumber(profile && profile.speed, 0.1, 8);
        output.volumeBoost = finiteNumber(profile && profile.volumeBoost, 1, 5);
        output.quality = QUALITY_VALUES.has(String(profile && profile.quality))
            ? String(profile.quality) : 'current';
        output.captions = TRI_VALUES.has(profile && profile.captions)
            ? profile.captions : 'unchanged';
        output.compressor = TRI_VALUES.has(profile && profile.compressor)
            ? profile.compressor : 'unchanged';
        return output;
    }

    function normalizePlaybackProfiles(value) {
        const source = Array.isArray(value) ? value : [];
        const output = [];
        const seen = new Set();
        for (let i = 0; i < source.length && output.length < MAX_PROFILES; i++) {
            const profile = normalizeProfile(source[i], i);
            if (seen.has(profile.id)) continue;
            seen.add(profile.id);
            output.push(profile);
        }
        if (!seen.has('default')) output.unshift(defaultProfile());
        else {
            const index = output.findIndex(profile => profile.id === 'default');
            if (index > 0) output.unshift(output.splice(index, 1)[0]);
        }
        return output.slice(0, MAX_PROFILES);
    }

    function normalizeActiveProfiles(value, profiles) {
        const ids = new Set(profiles.map(profile => profile.id));
        const source = value && typeof value === 'object' ? value : {};
        return {
            youtube: ids.has(source.youtube) ? source.youtube : 'default',
            twitch: ids.has(source.twitch) ? source.twitch : 'default'
        };
    }

    function normalizeRuleMap(value, validProfileIds) {
        const output = {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
        for (const [rawKey, profileId] of Object.entries(value)) {
            const key = cleanText(rawKey, 120).toLowerCase();
            if (!key || !validProfileIds.has(profileId)) continue;
            output[key] = profileId;
            if (Object.keys(output).length >= MAX_CHANNEL_RULES) break;
        }
        return output;
    }

    function normalizeChannelProfileRules(value, profiles) {
        const source = value && typeof value === 'object' ? value : {};
        const ids = new Set((profiles || normalizePlaybackProfiles()).map(profile => profile.id));
        return {
            youtube: normalizeRuleMap(source.youtube, ids),
            twitch: normalizeRuleMap(source.twitch, ids)
        };
    }

    function normalizeYouTubeChannel(channel) {
        if (!channel || typeof channel !== 'object') return null;
        const handle = cleanText(channel.handle, 100).replace(/^@/, '');
        const channelId = cleanText(channel.channelId, 100);
        const key = cleanText(channel.key, 120) ||
            (channelId ? 'id:' + channelId : handle ? 'handle:' + handle.toLowerCase() : '');
        if (!key) return null;
        return {
            key,
            name: cleanText(channel.name, 120),
            handle,
            channelId,
            url: cleanText(channel.url, 300),
            addedAt: Number.isFinite(Number(channel.addedAt)) ? Number(channel.addedAt) : Date.now()
        };
    }

    function normalizeCollections(value) {
        if (!Array.isArray(value)) return [];
        const output = [];
        const ids = new Set();
        for (let i = 0; i < value.length && output.length < MAX_COLLECTIONS; i++) {
            const source = value[i];
            if (!source || typeof source !== 'object') continue;
            let id = cleanId(source.id, 'collection-' + (i + 1));
            if (ids.has(id)) continue;
            ids.add(id);
            const channels = [];
            const channelKeys = new Set();
            for (const raw of Array.isArray(source.channels) ? source.channels : []) {
                const channel = normalizeYouTubeChannel(raw);
                if (!channel || channelKeys.has(channel.key.toLowerCase())) continue;
                channelKeys.add(channel.key.toLowerCase());
                channels.push(channel);
                if (channels.length >= MAX_COLLECTION_CHANNELS) break;
            }
            output.push({
                id,
                name: cleanText(source.name, 60) || 'Collection ' + (output.length + 1),
                color: /^#[0-9a-f]{6}$/i.test(source.color || '') ? source.color.toLowerCase() : '#3ea6ff',
                channels
            });
        }
        return output;
    }

    function normalizeTwitchChannel(channel) {
        if (typeof channel === 'string') channel = { login: channel };
        if (!channel || typeof channel !== 'object') return null;
        const login = cleanText(channel.login, 25).replace(/^@/, '').toLowerCase();
        if (!/^[a-z0-9_]{2,25}$/.test(login)) return null;
        return {
            login,
            name: cleanText(channel.name, 80),
            addedAt: Number.isFinite(Number(channel.addedAt)) ? Number(channel.addedAt) : Date.now()
        };
    }

    function uniqueTwitchChannels(value, limit) {
        const output = [];
        const seen = new Set();
        for (const raw of Array.isArray(value) ? value : []) {
            const channel = normalizeTwitchChannel(raw);
            if (!channel || seen.has(channel.login)) continue;
            seen.add(channel.login);
            output.push(channel);
            if (output.length >= limit) break;
        }
        return output;
    }

    function normalizeTwitchSidebar(value) {
        const source = value && typeof value === 'object' ? value : {};
        const groups = [];
        const ids = new Set();
        for (let i = 0; i < (Array.isArray(source.groups) ? source.groups.length : 0) &&
                        groups.length < MAX_SIDEBAR_GROUPS; i++) {
            const raw = source.groups[i];
            if (!raw || typeof raw !== 'object') continue;
            const id = cleanId(raw.id, 'group-' + (i + 1));
            if (ids.has(id)) continue;
            ids.add(id);
            groups.push({
                id,
                name: cleanText(raw.name, 60) || 'Group ' + (groups.length + 1),
                collapsed: !!raw.collapsed,
                channels: uniqueTwitchChannels(Array.isArray(raw.channels)
                    ? raw.channels : raw.members, MAX_SIDEBAR_CHANNELS)
            });
        }
        return {
            favorites: uniqueTwitchChannels(Array.isArray(source.favorites)
                ? source.favorites : source.favourites, MAX_SIDEBAR_CHANNELS),
            groups
        };
    }

    function boundedInteger(value, min, max, fallback) {
        const number = parseInt(value, 10);
        return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
    }

    function normalizeTwitchPlayer(value) {
        const source = value && typeof value === 'object' ? value : {};
        return {
            seekStep: boundedInteger(source.seekStep, 1, 120, 10),
            maxRetries: boundedInteger(source.maxRetries, 1, 6, 4),
            baseDelayMs: boundedInteger(source.baseDelayMs, 250, 5000, 1000),
            maxDelayMs: boundedInteger(source.maxDelayMs, 1000, 30000, 12000),
            fallbackAfter: boundedInteger(source.fallbackAfter, 1, 5, 2)
        };
    }

    function normalizeTwitchChatOverlay(value) {
        const source = value && typeof value === 'object' ? value : {};
        return {
            opacity: finiteNumber(source.opacity, 0.2, 1) || 0.82,
            width: boundedInteger(source.width, 240, 720, 380),
            fontScale: finiteNumber(source.fontScale, 0.75, 1.75) || 1,
            placement: ['left', 'right', 'bottom'].includes(source.placement)
                ? source.placement : 'right',
            autoHideMs: source.autoHideMs === 0 ? 0
                : boundedInteger(source.autoHideMs, 1000, 30000, 5000),
            clickThrough: source.clickThrough !== false,
            interactive: source.interactive === true
        };
    }

    function normalizeTwitchDiagnostics(value) {
        const source = value && typeof value === 'object' ? value : {};
        const player = source.player && typeof source.player === 'object' ? source.player : {};
        const statuses = new Set(['idle', 'scheduled', 'retrying', 'recovered', 'failed', 'cancelled']);
        return {
            player: {
                status: statuses.has(player.status) ? player.status : 'idle',
                attempts: boundedInteger(player.attempts, 0, 6, 0),
                lastErrorKind: cleanText(player.lastErrorKind, 80),
                lastErrorAt: Math.max(0, Number(player.lastErrorAt) || 0),
                lastRecoveredAt: Math.max(0, Number(player.lastRecoveredAt) || 0)
            }
        };
    }
    function safeSettingsSnapshot(value) {
        const output = {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
        for (const [key, raw] of Object.entries(value)) {
            if (!/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(key)) continue;
            if (typeof raw === 'boolean' || typeof raw === 'string' ||
                (typeof raw === 'number' && Number.isFinite(raw))) output[key] = raw;
            if (Object.keys(output).length >= 200) break;
        }
        return output;
    }

    function normalizeSettingsPresets(value) {
        const output = [];
        const seen = new Set();
        for (let i = 0; i < (Array.isArray(value) ? value.length : 0) && output.length < 12; i++) {
            const raw = value[i];
            if (!raw || typeof raw !== 'object') continue;
            const id = cleanId(raw.id, 'preset-' + (i + 1));
            if (seen.has(id)) continue;
            seen.add(id);
            output.push({
                id,
                name: cleanText(raw.name, 60) || 'Preset ' + (output.length + 1),
                settings: safeSettingsSnapshot(raw.settings),
                updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now()
            });
        }
        return output;
    }

    function compactJsonValue(value, maxLength) {
        if (typeof value === 'undefined') return null;
        try {
            const serialized = JSON.stringify(value);
            if (serialized.length > maxLength) return null;
            return JSON.parse(serialized);
        } catch (error) {
            return null;
        }
    }

    function normalizeRecentActions(value) {
        const output = [];
        for (const raw of Array.isArray(value) ? value : []) {
            if (!raw || typeof raw !== 'object') continue;
            const type = cleanText(raw.type, 60);
            const label = cleanText(raw.label, 120);
            const at = Number(raw.at);
            if (!type || !label || !Number.isFinite(at)) continue;
            output.push({
                id: cleanId(raw.id, 'action-' + Math.round(at)),
                type,
                label,
                at,
                expiresAt: Number.isFinite(Number(raw.expiresAt)) ? Number(raw.expiresAt) : at + 86400000,
                before: compactJsonValue(raw.before, 12000),
                after: compactJsonValue(raw.after, 12000)
            });
        }
        return output.sort((a, b) => b.at - a.at).slice(0, MAX_RECENT_ACTIONS);
    }

    function addRecentAction(value, action) {
        return normalizeRecentActions([Object.assign({ at: Date.now() }, action), ...(value || [])]);
    }

    function normalizeHiddenVideoMetadata(value) {
        const output = {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
        for (const [id, raw] of Object.entries(value)) {
            if (!/^[A-Za-z0-9_-]{6,20}$/.test(id) || !raw || typeof raw !== 'object') continue;
            output[id] = {
                title: cleanText(raw.title, 200),
                channel: cleanText(raw.channel, 120),
                thumbnail: /^https:\/\//.test(raw.thumbnail || '') ? cleanText(raw.thumbnail, 500) : '',
                addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : Date.now()
            };
            if (Object.keys(output).length >= 2000) break;
        }
        return output;
    }

    function normalizeFeatureData(value) {
        const source = value && typeof value === 'object' ? value : {};
        const profiles = normalizePlaybackProfiles(source.playbackProfiles);
        return {
            inputBindings: normalizeInputBindings(source.inputBindings),
            playbackProfiles: profiles,
            activePlaybackProfiles: normalizeActiveProfiles(source.activePlaybackProfiles, profiles),
            channelPlaybackProfiles: normalizeChannelProfileRules(source.channelPlaybackProfiles, profiles),
            ytCollections: normalizeCollections(source.ytCollections),
            twitchSidebar: normalizeTwitchSidebar(source.twitchSidebar),
            twitchPlayer: normalizeTwitchPlayer(source.twitchPlayer),
            twitchChatOverlay: normalizeTwitchChatOverlay(source.twitchChatOverlay),
            twitchDiagnostics: normalizeTwitchDiagnostics(source.twitchDiagnostics),
            settingsPresets: normalizeSettingsPresets(source.settingsPresets),
            recentActions: normalizeRecentActions(source.recentActions),
            hiddenVideoMetadata: normalizeHiddenVideoMetadata(source.hiddenVideoMetadata)
        };
    }

    function selectPlaybackProfile(data, site, channelKey) {
        if (!SITES.includes(site)) return null;
        const normalized = normalizeFeatureData(data);
        const key = cleanText(channelKey, 120).toLowerCase();
        const candidates = [key];
        if (site === 'youtube' && key.startsWith('handle:')) {
            candidates.push('@' + key.slice(7), key.slice(7));
        } else if (site === 'youtube' && key.startsWith('id:')) {
            candidates.push(key.slice(3));
        }
        const matchedKey = candidates.find(candidate =>
            candidate && normalized.channelPlaybackProfiles[site][candidate]);
        const ruleId = matchedKey && normalized.channelPlaybackProfiles[site][matchedKey];
        const id = ruleId || normalized.activePlaybackProfiles[site] || 'default';
        let profile = normalized.playbackProfiles.find(item => item.id === id && item.sites.includes(site));
        if (!profile) profile = normalized.playbackProfiles.find(item => item.id === 'default');
        return {
            profile: clone(profile || defaultProfile()),
            source: ruleId && profile && profile.id === ruleId ? 'channel' : 'global',
            channelKey: ruleId ? matchedKey : ''
        };
    }

    function redactDiagnostics(value) {
        const source = value && typeof value === 'object' ? value : {};
        const recovery = source.lastRecovery && typeof source.lastRecovery === 'object'
            ? source.lastRecovery : {};
        return {
            extensionVersion: cleanText(source.extensionVersion, 30),
            site: SITES.includes(source.site) ? source.site : '',
            activeProfile: cleanText(source.activeProfile, 64),
            capabilities: safeSettingsSnapshot(source.capabilities),
            featureHealth: safeSettingsSnapshot(source.featureHealth),
            lastRecovery: {
                code: cleanText(recovery.code, 80),
                attempts: Math.max(0, Math.min(20, parseInt(recovery.attempts, 10) || 0)),
                at: Number.isFinite(Number(recovery.at)) ? Number(recovery.at) : 0
            },
            storageCounts: safeSettingsSnapshot(source.storageCounts),
            integrations: safeSettingsSnapshot(source.integrations)
        };
    }

    function importPreview(value) {
        const source = value && typeof value === 'object' ? value : {};
        const normalized = normalizeFeatureData(source);
        return {
            valid: !!(source.settings || source.blockedChannels || source.hiddenVideoIds ||
                source.inputBindings || source.playbackProfiles || source.activePlaybackProfiles ||
                source.channelPlaybackProfiles || source.ytCollections || source.twitchSidebar ||
                source.twitchPlayer || source.twitchChatOverlay || source.settingsPresets ||
                source.hiddenVideoMetadata),
            counts: {
                settings: source.settings && typeof source.settings === 'object'
                    ? Object.keys(source.settings).length : 0,
                profiles: normalized.playbackProfiles.filter(p => p.id !== 'default').length,
                collections: normalized.ytCollections.length,
                collectionChannels: normalized.ytCollections.reduce((n, c) => n + c.channels.length, 0),
                twitchFavorites: normalized.twitchSidebar.favorites.length,
                twitchGroups: normalized.twitchSidebar.groups.length,
                bindings: SITES.reduce((total, site) => total + INPUT_TYPES.reduce(
                    (n, type) => n + Object.keys(normalized.inputBindings[site][type]).length, 0), 0)
            }
        };
    }

    return Object.freeze({
        SITES: Object.freeze(SITES),
        INPUT_TYPES: Object.freeze(INPUT_TYPES),
        ACTION_CATALOGUE,
        DEFAULT_INPUT_BINDINGS,
        DEFAULT_PLAYBACK_PROFILE,
        defaultInputBindings,
        defaultProfile,
        normalizeKeyChord,
        eventToChord,
        isEditableTarget,
        isReservedChord,
        bindingConflicts,
        normalizeInputBindings,
        normalizePlaybackProfiles,
        normalizeChannelProfileRules,
        normalizeCollections,
        normalizeTwitchSidebar,
        normalizeTwitchPlayer,
        normalizeTwitchChatOverlay,
        normalizeTwitchDiagnostics,
        normalizeSettingsPresets,
        normalizeRecentActions,
        normalizeHiddenVideoMetadata,
        normalizeFeatureData,
        selectPlaybackProfile,
        addRecentAction,
        redactDiagnostics,
        importPreview
    });
});
