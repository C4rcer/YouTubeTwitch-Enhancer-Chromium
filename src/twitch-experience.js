/* ==================================================================
 * Local Twitch experience helpers and DOM controller.
 *
 * This file deliberately has no network code. Player recovery uses only
 * rendered player state and HTMLMediaElement APIs; sidebar data and the
 * bounded diagnostics record remain in browser.storage.local.
 * ================================================================== */
(function (root, factory) {
    'use strict';

    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.YTBTW_TWITCH_EXPERIENCE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MAX_FAVOURITES = 250;
    const MAX_GROUPS = 30;
    const MAX_GROUP_MEMBERS = 250;
    const STORAGE_KEY = 'data';
    const LOGIN_RE = /^[a-z0-9_]{2,25}$/;
    const RESERVED_PATHS = new Set([
        'directory', 'videos', 'downloads', 'p', 'search', 'settings',
        'friends', 'subscriptions', 'inventory', 'wallet', 'drops',
        'prime', 'turbo', 'jobs', 'store', 'following', 'moderator',
        'popout', 'embed', 'team', 'collections', 'activity'
    ]);

    function clamp(value, min, max, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    function integer(value, min, max, fallback) {
        return Math.round(clamp(value, min, max, fallback));
    }

    function normalizeLogin(value) {
        const login = String(value || '').trim().toLowerCase();
        return LOGIN_RE.test(login) && !RESERVED_PATHS.has(login) ? login : '';
    }

    function loginFromHref(href) {
        let path = String(href || '');
        try {
            if (/^[a-z][a-z0-9+.-]*:/i.test(path)) path = new URL(path).pathname;
        } catch (e) { return ''; }
        const match = path.match(/^\/([A-Za-z0-9_]{2,25})\/?(?:[?#].*)?$/);
        return match ? normalizeLogin(match[1]) : '';
    }

    function normalizePlayerOptions(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        return {
            seekStep: integer(raw.seekStep, 1, 60, 10),
            maxRetries: integer(raw.maxRetries, 1, 6, 4),
            baseDelayMs: integer(raw.baseDelayMs, 250, 5000, 1000),
            maxDelayMs: integer(raw.maxDelayMs, 1000, 30000, 12000),
            fallbackAfter: integer(raw.fallbackAfter, 1, 5, 2)
        };
    }

    function retryDelay(attempt, baseDelayMs, maxDelayMs) {
        const attemptIndex = integer(attempt, 0, 30, 0);
        const requestedBase = Number(baseDelayMs);
        const base = Number.isFinite(requestedBase) && requestedBase > 0
            ? integer(requestedBase, 1, 60000, 1000) : 1000;
        const requestedCap = Number(maxDelayMs);
        const cap = Number.isFinite(requestedCap) && requestedCap > 0
            ? integer(requestedCap, base, 120000, 12000) : 12000;
        return Math.min(cap, base * Math.pow(2, attemptIndex));
    }

    function classifyRecoverablePlayerState(input) {
        const state = input && typeof input === 'object' ? input : {};
        if (state.offline || state.ended || state.destroyed || state.hiddenDocument) {
            return { recoverable: false, kind: 'inactive' };
        }

        const code = Number(state.mediaErrorCode) || 0;
        if (code === 2) return { recoverable: true, kind: 'media-network' };
        if (code === 3) return { recoverable: true, kind: 'media-decode' };
        if (code === 4) return { recoverable: true, kind: 'media-source' };
        if (code === 1 && state.hasErrorNode) {
            return { recoverable: true, kind: 'media-aborted' };
        }
        if (state.hasErrorNode) return { recoverable: true, kind: 'player-error' };
        if (Number(state.networkState) === 3 && state.hasSource) {
            return { recoverable: true, kind: 'no-source' };
        }
        if (!state.paused && !state.seeking && state.hasSource &&
                Number(state.readyState) < 3 && Number(state.stalledForMs) >= 8000) {
            return { recoverable: true, kind: 'stalled' };
        }
        return { recoverable: false, kind: '' };
    }

    function qualityHeight(label) {
        const text = String(label || '').trim();
        if (/source/i.test(text)) return Number.POSITIVE_INFINITY;
        if (/auto/i.test(text)) return null;
        const match = text.match(/(?:^|\D)(\d{3,4})p?(?:\D|$)/i);
        return match ? Number(match[1]) : null;
    }

    function qualityLabel(option) {
        if (typeof option === 'string') return option;
        return option && (option.label || option.name || option.value) || '';
    }

    function chooseQualityFallback(options, current, failures, fallbackAfter) {
        if (Number(failures) < (Number(fallbackAfter) || 2)) return null;
        const candidates = (Array.isArray(options) ? options : [])
            .map((option, index) => ({ option, index, height: qualityHeight(qualityLabel(option)) }))
            .filter(item => item.height != null && !(item.option && item.option.disabled))
            .sort((a, b) => b.height - a.height || a.index - b.index);
        if (candidates.length < 2) return null;

        let selected = -1;
        const currentLabel = qualityLabel(current);
        const explicitCurrent = current != null && currentLabel !== '';
        for (let i = 0; i < candidates.length; i++) {
            const option = candidates[i].option;
            if (option === current || qualityLabel(option) === currentLabel ||
                    (!explicitCurrent && option && (option.selected || option.checked))) {
                selected = i;
                break;
            }
        }
        if (selected < 0 || selected + 1 >= candidates.length) return null;
        return candidates[selected + 1].option;
    }

    function lastRangeEnd(ranges) {
        if (!ranges) return null;
        try {
            if (typeof ranges.length === 'number' && typeof ranges.end === 'function') {
                return ranges.length ? Number(ranges.end(ranges.length - 1)) : null;
            }
            if (Array.isArray(ranges) && ranges.length) {
                const last = ranges[ranges.length - 1];
                return Number(Array.isArray(last) ? last[1] : last && last.end != null ? last.end : last);
            }
        } catch (e) { return null; }
        return null;
    }

    function firstRangeStart(ranges) {
        if (!ranges) return null;
        try {
            if (typeof ranges.length === 'number' && typeof ranges.start === 'function') {
                return ranges.length ? Number(ranges.start(0)) : null;
            }
            if (Array.isArray(ranges) && ranges.length) {
                const first = ranges[0];
                return Number(Array.isArray(first) ? first[0] : first && first.start != null ? first.start : 0);
            }
        } catch (e) { return null; }
        return null;
    }

    function liveDelaySeconds(media) {
        if (!media) return null;
        const edge = lastRangeEnd(media.seekable);
        const bufferedEdge = lastRangeEnd(media.buffered);
        const liveEdge = Number.isFinite(edge) ? edge : bufferedEdge;
        const current = Number(media.currentTime);
        if (!Number.isFinite(liveEdge) || !Number.isFinite(current)) return null;
        return Math.max(0, liveEdge - current);
    }

    function formatDelay(seconds) {
        if (!Number.isFinite(seconds)) return '';
        if (seconds < 2) return 'Live';
        if (seconds < 60) return Math.round(seconds) + 's behind';
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return mins + 'm ' + secs + 's behind';
    }

    function seekTarget(currentTime, direction, step, ranges, duration) {
        const current = Number(currentTime);
        if (!Number.isFinite(current)) return null;
        const delta = integer(step, 1, 600, 10) * (Number(direction) < 0 ? -1 : 1);
        let min = firstRangeStart(ranges);
        let max = lastRangeEnd(ranges);
        if (!Number.isFinite(min)) min = 0;
        if (!Number.isFinite(max)) {
            const d = Number(duration);
            max = Number.isFinite(d) ? d : Math.max(current, current + delta);
        }
        return Math.min(max, Math.max(min, current + delta));
    }

    function safeGroupId(value, index, used) {
        let id = String(value || '').trim().toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
        if (!id) id = 'group-' + (index + 1);
        let unique = id;
        let suffix = 2;
        while (used.has(unique)) unique = id.slice(0, 58) + '-' + suffix++;
        used.add(unique);
        return unique;
    }

    function normalizeSidebar(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const favourites = [];
        const favouriteSet = new Set();
        const rawFavourites = Array.isArray(raw.favourites) ? raw.favourites
            : Array.isArray(raw.favorites) ? raw.favorites : [];
        for (const value of rawFavourites) {
            const login = normalizeLogin(typeof value === 'string' ? value : value && value.login);
            if (!login || favouriteSet.has(login)) continue;
            favouriteSet.add(login);
            favourites.push(login);
            if (favourites.length >= MAX_FAVOURITES) break;
        }

        const groups = [];
        const usedIds = new Set();
        for (const item of (Array.isArray(raw.groups) ? raw.groups : [])) {
            if (!item || typeof item !== 'object') continue;
            const name = String(item.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
            if (!name) continue;
            const members = [];
            const memberSet = new Set();
            const rawMembers = Array.isArray(item.members) ? item.members
                : Array.isArray(item.channels) ? item.channels : [];
            for (const value of rawMembers) {
                const login = normalizeLogin(typeof value === 'string' ? value : value && value.login);
                if (!login || memberSet.has(login)) continue;
                memberSet.add(login);
                members.push(login);
                if (members.length >= MAX_GROUP_MEMBERS) break;
            }
            groups.push({
                id: safeGroupId(item.id || name, groups.length, usedIds),
                name,
                collapsed: !!item.collapsed,
                members
            });
            if (groups.length >= MAX_GROUPS) break;
        }
        return { favourites, groups };
    }

    function toCanonicalSidebar(model, existing, timestamp, labels) {
        const normalized = normalizeSidebar(model);
        const prior = existing && typeof existing === 'object' ? existing : {};
        const metadata = new Map();
        const remember = value => {
            if (!value || typeof value !== 'object') return;
            const login = normalizeLogin(value.login);
            if (!login) return;
            const old = metadata.get(login);
            if (!old) {
                metadata.set(login, value);
            } else if (!old.name && value.name) {
                metadata.set(login, Object.assign({}, old, { name: value.name }));
            }
        };
        const priorFavourites = Array.isArray(prior.favorites) ? prior.favorites
            : Array.isArray(prior.favourites) ? prior.favourites : [];
        priorFavourites.forEach(remember);
        for (const group of (Array.isArray(prior.groups) ? prior.groups : [])) {
            const channels = Array.isArray(group && group.channels) ? group.channels
                : Array.isArray(group && group.members) ? group.members : [];
            channels.forEach(remember);
        }
        const addedAt = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
        const channel = login => {
            const old = metadata.get(login) || {};
            return {
                login,
                name: String(old.name || labels && labels.get && labels.get(login) || '')
                    .trim().replace(/\s+/g, ' ').slice(0, 80),
                addedAt: Number.isFinite(Number(old.addedAt)) ? Number(old.addedAt) : addedAt
            };
        };
        return {
            favorites: normalized.favourites.map(channel),
            groups: normalized.groups.map(group => ({
                id: group.id,
                name: group.name,
                collapsed: group.collapsed,
                channels: group.members.map(channel)
            }))
        };
    }

    function playerOptionsFromState(rawPlayer, settings) {
        const merged = Object.assign({}, rawPlayer && typeof rawPlayer === 'object' ? rawPlayer : {});
        const flags = settings && typeof settings === 'object' ? settings : {};
        if (Object.prototype.hasOwnProperty.call(flags, 'twSeekStep')) {
            merged.seekStep = flags.twSeekStep;
        }
        return normalizePlayerOptions(merged);
    }

    function overlayOptionsFromState(rawOverlay, settings) {
        const merged = Object.assign({}, rawOverlay && typeof rawOverlay === 'object' ? rawOverlay : {});
        const flags = settings && typeof settings === 'object' ? settings : {};
        const map = {
            twChatOverlayOpacity: 'opacity',
            twChatOverlayWidth: 'width',
            twChatOverlayFontScale: 'fontScale',
            twChatOverlayPlacement: 'placement',
            twChatOverlayClickThrough: 'clickThrough',
            twChatOverlayInteraction: 'interactive'
        };
        for (const [setting, option] of Object.entries(map)) {
            if (Object.prototype.hasOwnProperty.call(flags, setting)) merged[option] = flags[setting];
        }
        if (Object.prototype.hasOwnProperty.call(flags, 'twChatOverlayAutoHide')) {
            merged.autoHideMs = flags.twChatOverlayAutoHide
                ? Number(merged.autoHideMs) > 0 ? merged.autoHideMs : 5000
                : 0;
        }
        return normalizeOverlay(merged);
    }

    function normalizeOverlay(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const placement = ['left', 'right'].includes(raw.placement)
            ? raw.placement : 'right';
        const autoHide = Number(raw.autoHideMs);
        return {
            opacity: Math.round(clamp(raw.opacity, 0.2, 1, 0.82) * 100) / 100,
            width: integer(raw.width, 260, 700, 380),
            fontScale: Math.round(clamp(raw.fontScale, 0.75, 1.75, 1) * 100) / 100,
            placement,
            autoHideMs: Number.isFinite(autoHide) && autoHide > 0
                ? integer(autoHide, 1000, 30000, 5000) : 0,
            clickThrough: raw.clickThrough === true,
            interactive: raw.interactive === true
        };
    }

    function normalizeDiagnostics(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const allowedKinds = new Set([
            '', 'media-network', 'media-decode', 'media-source',
            'media-aborted', 'player-error', 'no-source', 'stalled'
        ]);
        const kind = allowedKinds.has(raw.lastErrorKind) ? raw.lastErrorKind : '';
        const status = ['idle', 'scheduled', 'retrying', 'recovered', 'failed', 'cancelled']
            .includes(raw.status) ? raw.status : 'idle';
        return {
            status,
            attempts: integer(raw.attempts, 0, 6, 0),
            lastErrorKind: kind,
            lastErrorAt: integer(raw.lastErrorAt, 0, Number.MAX_SAFE_INTEGER, 0),
            lastRecoveredAt: integer(raw.lastRecoveredAt, 0, Number.MAX_SAFE_INTEGER, 0)
        };
    }

    function extractSidebarIdentity(entry) {
        if (!entry) return null;
        let anchor = null;
        try {
            anchor = entry.matches && entry.matches('a[href]') ? entry : entry.querySelector('a[href]');
        } catch (e) { return null; }
        if (!anchor) return null;
        const href = anchor.getAttribute && anchor.getAttribute('href') || anchor.href || '';
        const login = loginFromHref(href);
        if (!login) return null;
        let label = '';
        try {
            const title = entry.querySelector(
                '[data-a-target="side-nav-title"], [data-a-target="side-nav-card-title"], ' +
                '[data-test-selector="side-nav-card-title"], p, [aria-label]'
            );
            label = String(title && (title.getAttribute && title.getAttribute('aria-label') ||
                title.textContent) || anchor.getAttribute && anchor.getAttribute('aria-label') ||
                login).trim().replace(/\s+/g, ' ').slice(0, 80);
        } catch (e) { label = login; }
        return { login, href: String(href), label: label || login,
            signature: login + '|' + String(href) + '|' + (label || login) };
    }

    function sidebarProjection(model, entries, query, view) {
        const normalized = normalizeSidebar(model);
        const favouriteOrder = new Map(normalized.favourites.map((login, index) => [login, index]));
        const group = normalized.groups.find(item => item.id === view);
        const allowed = view === 'favourites' ? new Set(normalized.favourites)
            : group ? new Set(group.members) : null;
        const needle = String(query || '').trim().toLowerCase();
        // Collapsed groups tuck their non-favourite members out of the default
        // view; an explicit search or a group view still reveals them.
        const collapsed = new Set();
        if (!allowed && !needle) {
            for (const item of normalized.groups) {
                if (!item.collapsed) continue;
                for (const login of item.members) {
                    if (!favouriteOrder.has(login)) collapsed.add(login);
                }
            }
        }
        const seen = new Set();
        const out = [];
        for (let index = 0; index < (Array.isArray(entries) ? entries.length : 0); index++) {
            const item = entries[index] || {};
            const login = normalizeLogin(item.login);
            if (!login || seen.has(login)) continue;
            seen.add(login);
            const label = String(item.label || login);
            const matches = !needle || login.includes(needle) || label.toLowerCase().includes(needle);
            const visible = matches && (!allowed || allowed.has(login)) && !collapsed.has(login);
            out.push(Object.assign({}, item, {
                login,
                label,
                nativeIndex: Number.isFinite(item.nativeIndex) ? item.nativeIndex : index,
                favourite: favouriteOrder.has(login),
                favouriteIndex: favouriteOrder.has(login) ? favouriteOrder.get(login) : -1,
                visible
            }));
        }
        out.sort((a, b) => {
            if (view && view !== 'all') return a.nativeIndex - b.nativeIndex;
            if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
            if (a.favourite && b.favourite) return a.favouriteIndex - b.favouriteIndex;
            return a.nativeIndex - b.nativeIndex;
        });
        return out;
    }

    function elementNode(node) {
        if (!node) return null;
        return node.nodeType === 1 || node.nodeType === 9 ? node : node.parentElement || null;
    }

    function collectMutationElements(records, selector, limit) {
        const out = new Set();
        const max = integer(limit, 1, 5000, 1000);
        function add(node, includeDescendants) {
            if (out.size >= max) return;
            const el = elementNode(node);
            if (!el) return;
            try {
                if (el.matches && el.matches(selector)) out.add(el);
                const closest = el.closest && el.closest(selector);
                if (closest) out.add(closest);
                if (!includeDescendants || out.size >= max || !el.querySelectorAll) return;
                for (const match of el.querySelectorAll(selector)) {
                    out.add(match);
                    if (out.size >= max) break;
                }
            } catch (e) { /* malformed fixture or transient DOM */ }
        }
        for (const record of (records || [])) {
            if (!record) continue;
            add(record.target, false);
            if (record.type === 'childList') {
                for (const node of (record.addedNodes || [])) add(node, true);
            }
            if (out.size >= max) break;
        }
        return out;
    }

    function processMutationElements(records, selector, limit, processor) {
        const dirty = collectMutationElements(records, selector, limit);
        if (typeof processor === 'function') {
            for (const element of dirty) processor(element);
        }
        return dirty;
    }

    function editableTarget(target) {
        return !!(target && (target.isContentEditable ||
            /^(input|textarea|select|button)$/i.test(target.tagName || '') ||
            target.closest && target.closest('[contenteditable="true"], input, textarea, select')));
    }

    function createController(environment) {
        const env = environment || {};
        const doc = env.document;
        const win = env.window;
        const api = env.api;
        if (!doc || !win || !api || !api.storage || !api.storage.local) {
            throw new Error('Twitch experience controller requires document, window and storage');
        }

        const now = typeof env.now === 'function' ? env.now : () => Date.now();
        const later = typeof env.setTimeout === 'function' ? env.setTimeout : win.setTimeout.bind(win);
        const cancelLater = typeof env.clearTimeout === 'function' ? env.clearTimeout : win.clearTimeout.bind(win);
        const toast = typeof env.toast === 'function' ? env.toast : function () {};
        const featureCore = env.features || (typeof globalThis !== 'undefined' ? globalThis.YTBFeatures : null);
        const loc = env.location || win.location;
        let rawData = {};
        let playerOptions = normalizePlayerOptions(null);
        let sidebarModel = normalizeSidebar(null);
        let overlayOptions = normalizeOverlay(null);
        let diagnostics = normalizeDiagnostics(null);
        let enabled = true;
        let playerRecoveryEnabled = true;
        let sidebarEnabled = true;
        let overlayButtonEnabled = true;
        let retired = false;
        let currentView = 'all';
        let sidebarQuery = '';
        let sidebarSequence = 0;
        let managerLogin = '';
        let lastFocus = null;
        let overlayActive = false;
        let overlayMove = null;
        let overlayHideTimer = null;
        let diagnosticsTimer = null;
        let lastDiagnosticsJson = '';
        const sidebarEntries = new Set();
        const sidebarLabels = new Map();
        let lastMediaTime = null;
        let lastMediaProgressAt = now();
        let cancelledSignature = '';
        let pendingQualityRequest = '';
        const recovery = { attempt: 0, timer: null, kind: '', signature: '' };

        async function mergeStorage(mutator) {
            try {
                const stored = await api.storage.local.get(STORAGE_KEY);
                const full = stored && stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === 'object'
                    ? stored[STORAGE_KEY] : {};
                const next = mutator(Object.assign({}, full)) || full;
                await api.storage.local.set({ [STORAGE_KEY]: next });
            } catch (e) {
                if (env.console && env.console.warn) env.console.warn('[YT/Twitch Enhancer] Local Twitch save failed', e);
            }
        }

        function savePart(key, value, recentLabel) {
            rawData[key] = value;
            return mergeStorage(full => {
                const before = full[key];
                full[key] = value;
                if (recentLabel && featureCore && featureCore.addRecentAction &&
                        (!full.settings || full.settings.recentActionsEnabled !== false)) {
                    full.recentActions = featureCore.addRecentAction(full.recentActions, {
                        id: 'action-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
                        type: 'sidebar-change', label: recentLabel,
                        before: { [key]: before }, after: { [key]: value },
                        expiresAt: now() + 7 * 86400000
                    });
                }
                return full;
            });
        }

        function savePlayerOptions(syncSeekSetting) {
            rawData.twitchPlayer = playerOptions;
            if (syncSeekSetting) {
                rawData.settings = Object.assign({}, rawData.settings || {}, {
                    twSeekStep: playerOptions.seekStep
                });
            }
            return mergeStorage(full => {
                full.twitchPlayer = playerOptions;
                if (syncSeekSetting) {
                    full.settings = Object.assign({}, full.settings || {}, {
                        twSeekStep: playerOptions.seekStep
                    });
                }
                return full;
            });
        }

        function saveOverlayPreferences() {
            rawData.twitchChatOverlay = overlayOptions;
            const flat = {
                twChatOverlayOpacity: overlayOptions.opacity,
                twChatOverlayWidth: overlayOptions.width,
                twChatOverlayFontScale: overlayOptions.fontScale,
                twChatOverlayPlacement: overlayOptions.placement,
                twChatOverlayAutoHide: overlayOptions.autoHideMs > 0,
                twChatOverlayClickThrough: overlayOptions.clickThrough,
                twChatOverlayInteraction: overlayOptions.interactive
            };
            rawData.settings = Object.assign({}, rawData.settings || {}, flat);
            return mergeStorage(full => {
                full.twitchChatOverlay = overlayOptions;
                full.settings = Object.assign({}, full.settings || {}, flat);
                return full;
            });
        }

        function saveDiagnostics(next) {
            diagnostics = normalizeDiagnostics(Object.assign({}, diagnostics, next));
            const serialized = JSON.stringify(diagnostics);
            if (serialized === lastDiagnosticsJson) return;
            lastDiagnosticsJson = serialized;
            cancelLater(diagnosticsTimer);
            diagnosticsTimer = later(() => {
                diagnosticsTimer = null;
                const safe = normalizeDiagnostics(diagnostics);
                mergeStorage(full => {
                    const existing = full.twitchDiagnostics && typeof full.twitchDiagnostics === 'object'
                        ? full.twitchDiagnostics : {};
                    full.twitchDiagnostics = Object.assign({}, existing, { player: safe });
                    return full;
                });
            }, 250);
        }

        function playerContainer() {
            return doc.querySelector('.video-player__container, [data-a-target="video-player"]');
        }

        function playerVideo() {
            if (typeof env.getVideo === 'function') {
                const supplied = env.getVideo();
                if (supplied) return supplied;
            }
            const container = playerContainer();
            return container && container.querySelector('video');
        }

        function isLivePage(video) {
            const path = String(loc && loc.pathname || '');
            if (/^\/videos\/\d+/.test(path) || /\/clip\//.test(path) ||
                    String(loc && loc.hostname || '').startsWith('clips.')) return false;
            return !video || !Number.isFinite(Number(video.duration)) || Number(video.duration) === Infinity;
        }

        function visibleNode(node) {
            if (!node || node.hidden || node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
            try {
                if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) return false;
            } catch (e) { /* fixtures */ }
            return true;
        }

        function playerErrorNode() {
            const container = playerContainer();
            if (!container) return null;
            const node = container.querySelector(
                '[data-a-target="player-error-message"], ' +
                '[data-a-target="player-error-retry-button"], ' +
                '[data-test-selector="player-error-message"], ' +
                '[data-test-selector="player-error-retry-button"], ' +
                '[data-a-target^="player-error-"]'
            );
            return visibleNode(node) ? node : null;
        }

        function mediaState(video) {
            const current = Number(video && video.currentTime);
            if (Number.isFinite(current) && (lastMediaTime == null || Math.abs(current - lastMediaTime) > 0.05)) {
                lastMediaTime = current;
                lastMediaProgressAt = now();
                cancelledSignature = '';
            }
            return {
                mediaErrorCode: video && video.error && video.error.code || 0,
                networkState: video && video.networkState,
                readyState: video && video.readyState,
                paused: !video || !!video.paused,
                ended: !!(video && video.ended),
                seeking: !!(video && video.seeking),
                hasSource: !!(video && (video.currentSrc || video.src || video.querySelector && video.querySelector('source'))),
                hasErrorNode: !!playerErrorNode(),
                stalledForMs: now() - lastMediaProgressAt,
                offline: typeof navigator !== 'undefined' && navigator.onLine === false,
                hiddenDocument: !!doc.hidden
            };
        }

        function setRecoveryStatus(text, canCancel) {
            const status = doc.getElementById('ytbtw-recovery-status');
            if (!status) return;
            status.textContent = text || '';
            status.hidden = !text;
            status.disabled = !canCancel;
            status.setAttribute('aria-label', canCancel ? text + '. Cancel recovery.' : text);
        }

        function resetRecovery(recovered) {
            if (recovery.timer) cancelLater(recovery.timer);
            recovery.timer = null;
            if (recovered && recovery.attempt) {
                saveDiagnostics({ status: 'recovered', attempts: recovery.attempt, lastRecoveredAt: now() });
                setRecoveryStatus('Playback recovered', false);
                later(() => {
                    if (!recovery.timer) setRecoveryStatus('', false);
                }, 2500);
            } else if (!recovery.timer) {
                setRecoveryStatus('', false);
            }
            recovery.attempt = 0;
            recovery.kind = '';
            recovery.signature = '';
        }

        function idleRecovery() {
            const wasActive = !!(recovery.timer || recovery.attempt ||
                diagnostics.status !== 'idle');
            resetRecovery(false);
            if (wasActive) saveDiagnostics({ status: 'idle', attempts: 0 });
        }

        function cancelRecovery(manual) {
            if (recovery.timer) cancelLater(recovery.timer);
            recovery.timer = null;
            if (manual) {
                cancelledSignature = recovery.signature;
                setRecoveryStatus('Recovery cancelled', false);
                saveDiagnostics({ status: 'cancelled', attempts: recovery.attempt,
                    lastErrorKind: recovery.kind, lastErrorAt: now() });
            }
        }

        function goLive() {
            const video = playerVideo();
            if (!video) return false;
            const edge = lastRangeEnd(video.seekable);
            if (!Number.isFinite(edge)) return false;
            try {
                video.currentTime = Math.max(firstRangeStart(video.seekable) || 0, edge - 0.05);
                const play = video.play && video.play();
                if (play && typeof play.catch === 'function') play.catch(() => {});
                updateDelay();
                return true;
            } catch (e) { return false; }
        }

        function visibleQualityOptions() {
            const container = playerContainer();
            if (!container) return [];
            const nodes = container.querySelectorAll(
                '[data-a-target^="player-settings-menu-item-quality-option"], ' +
                '[role="menuitemradio"][data-a-target*="quality"]'
            );
            return [...nodes].filter(visibleNode).map(node => ({
                node,
                label: node.getAttribute('aria-label') || node.textContent || '',
                selected: node.getAttribute('aria-checked') === 'true' ||
                    node.getAttribute('data-selected') === 'true' ||
                    node.classList && node.classList.contains('selected'),
                disabled: node.disabled || node.getAttribute('aria-disabled') === 'true'
            }));
        }

        function applyQualityFallback() {
            const options = visibleQualityOptions();
            const selected = options.find(option => option.selected);
            const fallback = chooseQualityFallback(
                options, selected, recovery.attempt, playerOptions.fallbackAfter
            );
            if (!fallback || !fallback.node || typeof fallback.node.click !== 'function') return false;
            try {
                fallback.node.click();
                return true;
            } catch (e) { return false; }
        }

        function applyRequestedQuality(requested) {
            const value = String(requested || '').trim().toLowerCase();
            if (!value || value === 'current' || value === 'unchanged') return false;
            const options = visibleQualityOptions().filter(option => !option.disabled);
            if (!options.length) return false;
            let target = null;
            if (value === 'max') {
                target = options
                    .map((option, index) => ({ option, index, height: qualityHeight(option.label) }))
                    .filter(item => item.height != null)
                    .sort((a, b) => b.height - a.height || a.index - b.index)[0]?.option || null;
            } else if (value === 'auto') {
                target = options.find(option => /auto/i.test(option.label)) || null;
            } else {
                const requestedHeight = Number((value.match(/\d{3,4}/) || [])[0]);
                if (Number.isFinite(requestedHeight)) {
                    target = options.find(option => qualityHeight(option.label) === requestedHeight) || null;
                }
            }
            if (!target) return false;
            if (target.selected) return true;
            if (!target.node || typeof target.node.click !== 'function') return false;
            try {
                target.node.click();
                return true;
            } catch (e) { return false; }
        }

        function applyPendingQuality() {
            if (pendingQualityRequest && applyRequestedQuality(pendingQualityRequest)) {
                pendingQualityRequest = '';
            }
        }

        function performRecovery() {
            recovery.timer = null;
            if (retired || !enabled || !playerRecoveryEnabled) return;
            const video = playerVideo();
            if (!video) return;
            recovery.attempt++;
            setRecoveryStatus('Retrying playback ' + recovery.attempt + '/' + playerOptions.maxRetries, true);
            saveDiagnostics({ status: 'retrying', attempts: recovery.attempt,
                lastErrorKind: recovery.kind, lastErrorAt: now() });

            if (recovery.attempt >= playerOptions.fallbackAfter) applyQualityFallback();
            if (isLivePage(video)) goLive();
            const retryButton = playerContainer() && playerContainer().querySelector(
                '[data-a-target="player-error-retry-button"], ' +
                '[data-test-selector="player-error-retry-button"]'
            );
            try {
                if (retryButton && visibleNode(retryButton)) retryButton.click();
                else {
                    if (video.error && video.currentSrc && typeof video.load === 'function') video.load();
                    const play = video.play && video.play();
                    if (play && typeof play.catch === 'function') play.catch(() => {});
                }
            } catch (e) { /* the next bounded check can try again */ }
            later(checkPlayerHealth, 1200);
        }

        function scheduleRecovery(kind, signature) {
            if (recovery.timer || recovery.attempt >= playerOptions.maxRetries || signature === cancelledSignature) {
                if (recovery.attempt >= playerOptions.maxRetries) {
                    setRecoveryStatus('Recovery stopped after ' + playerOptions.maxRetries + ' attempts', false);
                    saveDiagnostics({ status: 'failed', attempts: recovery.attempt,
                        lastErrorKind: kind, lastErrorAt: now() });
                }
                return;
            }
            recovery.kind = kind;
            recovery.signature = signature;
            const delay = retryDelay(recovery.attempt, playerOptions.baseDelayMs, playerOptions.maxDelayMs);
            setRecoveryStatus('Retry ' + (recovery.attempt + 1) + '/' + playerOptions.maxRetries +
                ' in ' + Math.max(1, Math.ceil(delay / 1000)) + 's', true);
            saveDiagnostics({ status: 'scheduled', attempts: recovery.attempt,
                lastErrorKind: kind, lastErrorAt: now() });
            recovery.timer = later(performRecovery, delay);
        }

        function updateDelay() {
            const chip = doc.getElementById('ytbtw-live-delay');
            const liveButton = doc.getElementById('ytbtw-live-edge');
            if (!chip && !liveButton) return;
            const video = playerVideo();
            const live = !!video && isLivePage(video);
            if (liveButton) liveButton.hidden = !live;
            if (!chip) return;
            if (!live) {
                chip.hidden = true;
                chip.textContent = '';
                return;
            }
            const delay = liveDelaySeconds(video);
            chip.textContent = formatDelay(delay);
            chip.hidden = !chip.textContent;
            chip.dataset.state = Number.isFinite(delay) && delay < 2 ? 'live' : 'behind';
        }

        function checkPlayerHealth() {
            if (retired) return;
            updateDelay();
            if (!enabled || !playerRecoveryEnabled) {
                idleRecovery();
                return;
            }
            const video = playerVideo();
            if (!video) {
                idleRecovery();
                return;
            }
            const state = mediaState(video);
            const decision = classifyRecoverablePlayerState(state);
            if (!decision.recoverable) {
                if (recovery.attempt || recovery.timer) resetRecovery(true);
                return;
            }
            const signature = decision.kind + ':' + (state.mediaErrorCode || 0);
            if (recovery.signature && recovery.signature !== signature) {
                cancelRecovery(false);
                recovery.attempt = 0;
            }
            scheduleRecovery(decision.kind, signature);
        }

        function makeButton(id, label, title) {
            const button = doc.createElement('button');
            button.type = 'button';
            button.id = id;
            button.textContent = label;
            button.title = title;
            return button;
        }

        function labelledRange(label, name, min, max, step, value) {
            const wrap = doc.createElement('label');
            wrap.className = 'ytbtw-field';
            const text = doc.createElement('span');
            text.textContent = label;
            const input = doc.createElement('input');
            input.type = 'range';
            input.name = name;
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(value);
            const output = doc.createElement('output');
            output.textContent = String(value);
            wrap.append(text, input, output);
            input.addEventListener('input', () => { output.textContent = input.value; });
            return { wrap, input, output };
        }

        function removePlayerPanel() {
            const panel = doc.getElementById('ytbtw-player-panel');
            if (panel) panel.remove();
            const button = doc.getElementById('ytbtw-player-settings');
            if (button) button.setAttribute('aria-expanded', 'false');
        }

        function syncPlayerPanel() {
            const panel = doc.getElementById('ytbtw-player-panel');
            if (!panel) return;
            function value(name, next, suffix) {
                const control = panel.querySelector('[name="' + name + '"]');
                if (!control) return;
                if (doc.activeElement !== control) control.value = String(next);
                const label = control.closest && control.closest('label');
                const output = label && label.querySelector('output');
                if (output) output.textContent = String(control.value) + (suffix || '');
            }
            function checked(name, next) {
                const control = panel.querySelector('[name="' + name + '"]');
                if (control && doc.activeElement !== control) control.checked = !!next;
            }
            value('seekStep', playerOptions.seekStep);
            value('maxRetries', playerOptions.maxRetries);
            value('placement', overlayOptions.placement);
            value('opacity', Math.round(overlayOptions.opacity * 100), '%');
            value('width', overlayOptions.width, 'px');
            value('fontScale', Math.round(overlayOptions.fontScale * 100), '%');
            checked('clickThrough', overlayOptions.clickThrough);
            checked('interactive', overlayOptions.interactive);
        }

        function createPlayerPanel(container) {
            const panel = doc.createElement('div');
            panel.id = 'ytbtw-player-panel';
            panel.hidden = true;
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', 'Twitch playback and chat overlay settings');

            const heading = doc.createElement('strong');
            heading.textContent = 'Playback';
            panel.appendChild(heading);

            const seekLabel = doc.createElement('label');
            seekLabel.className = 'ytbtw-field';
            seekLabel.appendChild(doc.createTextNode('Seek step'));
            const seek = doc.createElement('input');
            seek.type = 'number';
            seek.name = 'seekStep';
            seek.min = '1';
            seek.max = '60';
            seek.step = '1';
            seek.value = String(playerOptions.seekStep);
            seek.setAttribute('aria-label', 'Seek step in seconds');
            seekLabel.appendChild(seek);
            panel.appendChild(seekLabel);
            seek.addEventListener('change', () => {
                playerOptions = normalizePlayerOptions(Object.assign({}, playerOptions, {
                    seekStep: Number(seek.value)
                }));
                savePlayerOptions(true);
            });

            const retryLabel = doc.createElement('label');
            retryLabel.className = 'ytbtw-field';
            retryLabel.appendChild(doc.createTextNode('Recovery attempts'));
            const retry = doc.createElement('select');
            retry.name = 'maxRetries';
            for (const count of [1, 2, 3, 4, 5, 6]) {
                const option = doc.createElement('option');
                option.value = String(count);
                option.textContent = String(count);
                option.selected = count === playerOptions.maxRetries;
                retry.appendChild(option);
            }
            retryLabel.appendChild(retry);
            panel.appendChild(retryLabel);
            retry.addEventListener('change', () => {
                playerOptions = normalizePlayerOptions(Object.assign({}, playerOptions, {
                    maxRetries: Number(retry.value)
                }));
                savePlayerOptions(false);
            });

            const overlayHeading = doc.createElement('strong');
            overlayHeading.textContent = 'Chat overlay';
            panel.appendChild(overlayHeading);
            const placement = doc.createElement('select');
            placement.name = 'placement';
            placement.setAttribute('aria-label', 'Chat overlay placement');
            for (const place of ['right', 'left']) {
                const option = doc.createElement('option');
                option.value = place;
                option.textContent = place[0].toUpperCase() + place.slice(1);
                option.selected = overlayOptions.placement === place;
                placement.appendChild(option);
            }
            const placementLabel = doc.createElement('label');
            placementLabel.className = 'ytbtw-field';
            placementLabel.append(doc.createTextNode('Placement'), placement);
            panel.appendChild(placementLabel);

            const opacity = labelledRange('Opacity', 'opacity', 20, 100, 5,
                Math.round(overlayOptions.opacity * 100));
            opacity.output.textContent += '%';
            opacity.input.addEventListener('input', () => { opacity.output.textContent = opacity.input.value + '%'; });
            panel.appendChild(opacity.wrap);
            const width = labelledRange('Width', 'width', 260, 700, 20, overlayOptions.width);
            width.output.textContent += 'px';
            width.input.addEventListener('input', () => { width.output.textContent = width.input.value + 'px'; });
            panel.appendChild(width.wrap);
            const font = labelledRange('Font size', 'fontScale', 75, 175, 5,
                Math.round(overlayOptions.fontScale * 100));
            font.output.textContent += '%';
            font.input.addEventListener('input', () => { font.output.textContent = font.input.value + '%'; });
            panel.appendChild(font.wrap);

            function checkbox(label, name, checked) {
                const wrap = doc.createElement('label');
                wrap.className = 'ytbtw-check';
                const input = doc.createElement('input');
                input.type = 'checkbox';
                input.name = name;
                input.checked = checked;
                wrap.append(input, doc.createTextNode(label));
                panel.appendChild(wrap);
                return input;
            }
            const clickThrough = checkbox('Click-through overlay', 'clickThrough', overlayOptions.clickThrough);
            const interactive = checkbox('Allow chat interaction/input', 'interactive', overlayOptions.interactive);

            function saveOverlayPanel() {
                overlayOptions = normalizeOverlay({
                    placement: placement.value,
                    opacity: Number(opacity.input.value) / 100,
                    width: Number(width.input.value),
                    fontScale: Number(font.input.value) / 100,
                    autoHideMs: overlayOptions.autoHideMs,
                    clickThrough: clickThrough.checked,
                    interactive: interactive.checked
                });
                if (overlayOptions.interactive) overlayOptions.clickThrough = false;
                clickThrough.checked = overlayOptions.clickThrough;
                saveOverlayPreferences();
                applyOverlayOptions();
            }
            for (const control of [placement, opacity.input, width.input, font.input, clickThrough, interactive]) {
                control.addEventListener('change', saveOverlayPanel);
            }

            const close = makeButton('', 'Close', 'Close settings');
            close.className = 'ytbtw-panel-close';
            close.addEventListener('click', () => {
                panel.hidden = true;
                const button = doc.getElementById('ytbtw-player-settings');
                if (button) { button.setAttribute('aria-expanded', 'false'); button.focus(); }
            });
            panel.appendChild(close);
            container.appendChild(panel);
            return panel;
        }

        function ensurePlayerTools() {
            const container = playerContainer();
            let tools = doc.getElementById('ytbtw-player-experience');
            if (!enabled || !container) {
                if (tools) tools.remove();
                removePlayerPanel();
                restoreChat();
                return;
            }
            if (tools && container.contains(tools)) {
                const chat = doc.getElementById('ytbtw-chat-overlay-toggle');
                if (chat) {
                    chat.hidden = !overlayButtonEnabled;
                    chat.setAttribute('aria-pressed', String(overlayActive));
                }
                return;
            }
            if (tools) tools.remove();
            removePlayerPanel();
            tools = doc.createElement('div');
            tools.id = 'ytbtw-player-experience';
            tools.setAttribute('role', 'group');
            tools.setAttribute('aria-label', 'Twitch playback tools');
            const live = makeButton('ytbtw-live-edge', 'Live', 'Jump to the live edge');
            live.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                if (goLive()) toast('At live edge', '');
            });
            const delay = doc.createElement('span');
            delay.id = 'ytbtw-live-delay';
            delay.setAttribute('role', 'status');
            delay.setAttribute('aria-live', 'polite');
            const status = makeButton('ytbtw-recovery-status', '', 'Playback recovery status');
            status.hidden = true;
            status.disabled = true;
            status.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                if (!status.disabled) cancelRecovery(true);
            });
            const chat = makeButton('ytbtw-chat-overlay-toggle', 'Chat', 'Toggle chat overlay');
            chat.hidden = !overlayButtonEnabled;
            chat.setAttribute('aria-pressed', String(overlayActive));
            chat.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                if (overlayActive) deactivateOverlay();
                else activateOverlay();
            });
            const settingsButton = makeButton('ytbtw-player-settings', '⋯', 'Playback and overlay settings');
            settingsButton.setAttribute('aria-expanded', 'false');
            settingsButton.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                let panel = doc.getElementById('ytbtw-player-panel');
                if (!panel) panel = createPlayerPanel(container);
                panel.hidden = !panel.hidden;
                settingsButton.setAttribute('aria-expanded', String(!panel.hidden));
                if (!panel.hidden) {
                    const focus = panel.querySelector('select, input, button');
                    if (focus) focus.focus();
                }
            });
            tools.append(live, delay, status, chat, settingsButton);
            container.appendChild(tools);
            updateDelay();
        }

        function sidebarCards(rootNode) {
            const selector = '.side-nav-card';
            if (!rootNode) return [];
            const cards = [];
            try {
                if (rootNode.matches && rootNode.matches(selector)) cards.push(rootNode);
                const closest = rootNode.closest && rootNode.closest(selector);
                if (closest) cards.push(closest);
                if (rootNode.querySelectorAll) cards.push(...rootNode.querySelectorAll(selector));
            } catch (e) { /* transient DOM */ }
            return [...new Set(cards)];
        }

        function mutationsRemoveSidebarCards(records) {
            for (const record of (records || [])) {
                if (!record || record.type !== 'childList') continue;
                for (const node of (record.removedNodes || [])) {
                    const element = elementNode(node);
                    if (!element) continue;
                    try {
                        if (element.matches && element.matches('.side-nav-card')) return true;
                        if (element.querySelector && element.querySelector('.side-nav-card')) return true;
                    } catch (e) { /* detached native subtree */ }
                }
            }
            return false;
        }

        function sidebarWrap(card) {
            return card && (card.closest && card.closest('.tw-transition') || card);
        }

        function updateSidebarAction(card, identity) {
            if (!card || !identity) return;
            const host = card.matches && card.matches('a[href]') ? card.parentElement : card;
            if (!host) return;
            host.classList.add('ytbtw-sidebar-action-host');
            let actions = host.querySelector && host.querySelector(':scope > .ytbtw-sidebar-actions');
            if (!actions) {
                actions = doc.createElement('span');
                actions.className = 'ytbtw-sidebar-actions';
                const favourite = makeButton('', '☆', 'Add channel to local favourites');
                favourite.className = 'ytbtw-sidebar-favourite';
                const group = makeButton('', '+', 'Assign channel to a local group');
                group.className = 'ytbtw-sidebar-group';
                favourite.addEventListener('click', e => {
                    e.preventDefault(); e.stopPropagation();
                    const current = extractSidebarIdentity(card);
                    if (current) toggleFavourite(current.login);
                });
                group.addEventListener('click', e => {
                    e.preventDefault(); e.stopPropagation();
                    const current = extractSidebarIdentity(card);
                    if (current) openSidebarManager(current.login, group);
                });
                actions.append(favourite, group);
                host.appendChild(actions);
            }
            if (actions.dataset.login !== identity.login) actions.dataset.login = identity.login;
            const favourite = actions.querySelector('.ytbtw-sidebar-favourite');
            const isFavourite = sidebarModel.favourites.includes(identity.login);
            const symbol = isFavourite ? '★' : '☆';
            const favouriteTitle = (isFavourite ? 'Remove ' : 'Add ') + identity.label +
                (isFavourite ? ' from local favourites' : ' to local favourites');
            if (favourite.textContent !== symbol) favourite.textContent = symbol;
            if (favourite.title !== favouriteTitle) favourite.title = favouriteTitle;
            if (favourite.getAttribute('aria-label') !== favouriteTitle) {
                favourite.setAttribute('aria-label', favouriteTitle);
            }
            if (favourite.getAttribute('aria-pressed') !== String(isFavourite)) {
                favourite.setAttribute('aria-pressed', String(isFavourite));
            }
            const group = actions.querySelector('.ytbtw-sidebar-group');
            const groupTitle = 'Assign ' + identity.label + ' to local groups';
            if (group.title !== groupTitle) group.title = groupTitle;
            if (group.getAttribute('aria-label') !== groupTitle) {
                group.setAttribute('aria-label', groupTitle);
            }
        }

        function clearSidebarCard(card) {
            if (!card) return;
            const wrap = sidebarWrap(card);
            if (wrap) {
                wrap.classList.remove('ytbtw-sidebar-filtered', 'ytbtw-sidebar-pinned');
                wrap.style.removeProperty('--ytbtw-sidebar-order');
            }
            const host = card.matches && card.matches('a[href]') ? card.parentElement : card;
            const actions = host && host.querySelector &&
                host.querySelector(':scope > .ytbtw-sidebar-actions');
            if (actions) actions.remove();
            if (host && host.classList) host.classList.remove('ytbtw-sidebar-action-host');
            if (card.dataset) {
                delete card.dataset.ytbtwSidebarLogin;
                delete card.dataset.ytbtwSidebarSignature;
                delete card.dataset.ytbtwSidebarSequence;
            }
            sidebarEntries.delete(card);
        }

        function decorateSidebarCard(card) {
            if (!card || !card.isConnected) return;
            const identity = extractSidebarIdentity(card);
            if (!identity) {
                clearSidebarCard(card);
                return;
            }
            if (card.dataset.ytbtwSidebarLogin !== identity.login) {
                card.dataset.ytbtwSidebarLogin = identity.login;
            }
            if (card.dataset.ytbtwSidebarSignature !== identity.signature) {
                card.dataset.ytbtwSidebarSignature = identity.signature;
            }
            card.dataset.ytbtwSidebarSequence ||= String(sidebarSequence++);
            if (!sidebarLabels.has(identity.login) && sidebarLabels.size >= 500) {
                sidebarLabels.delete(sidebarLabels.keys().next().value);
            }
            sidebarLabels.set(identity.login, identity.label);
            sidebarEntries.add(card);
            updateSidebarAction(card, identity);
        }

        function ensureSidebarToolbar() {
            let toolbar = doc.getElementById('ytbtw-sidebar-tools');
            if (!enabled || !sidebarEnabled) {
                if (toolbar) toolbar.remove();
                closeSidebarManager();
                clearSidebarDecorations();
                return null;
            }
            const first = doc.querySelector('.side-nav-card');
            const parent = first && first.parentElement;
            if (!parent) return toolbar;
            if (toolbar && toolbar.parentElement === parent) return toolbar;
            if (toolbar) toolbar.remove();
            toolbar = doc.createElement('section');
            toolbar.id = 'ytbtw-sidebar-tools';
            toolbar.setAttribute('aria-label', 'Local Twitch sidebar tools');
            const search = doc.createElement('input');
            search.type = 'search';
            search.placeholder = 'Search followed channels';
            search.setAttribute('aria-label', 'Search followed channels');
            search.value = sidebarQuery;
            const view = doc.createElement('select');
            view.setAttribute('aria-label', 'Sidebar view');
            const manage = makeButton('', 'Manage', 'Manage local Twitch groups');
            manage.addEventListener('click', () => openSidebarManager('', manage));
            const status = doc.createElement('span');
            status.className = 'ytbtw-sr-only';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            search.addEventListener('input', () => {
                sidebarQuery = search.value;
                applySidebarView();
            });
            view.addEventListener('change', () => {
                currentView = view.value;
                applySidebarView();
            });
            toolbar.append(search, view, manage, status);
            parent.insertBefore(toolbar, first);
            renderSidebarViewOptions();
            return toolbar;
        }

        function renderSidebarViewOptions() {
            const toolbar = doc.getElementById('ytbtw-sidebar-tools');
            const select = toolbar && toolbar.querySelector('select');
            if (!select) return;
            const valid = currentView === 'all' || currentView === 'favourites' ||
                sidebarModel.groups.some(group => group.id === currentView);
            if (!valid) currentView = 'all';
            select.textContent = '';
            const values = [
                { value: 'all', text: 'All (favourites first)' },
                { value: 'favourites', text: 'Favourites' },
                ...sidebarModel.groups.map(group => ({ value: group.id, text: group.name }))
            ];
            for (const item of values) {
                const option = doc.createElement('option');
                option.value = item.value;
                option.textContent = item.text;
                option.selected = item.value === currentView;
                select.appendChild(option);
            }
        }

        function applySidebarView() {
            const cards = [];
            for (const card of [...sidebarEntries]) {
                if (!card.isConnected) { clearSidebarCard(card); continue; }
                const identity = extractSidebarIdentity(card);
                if (!identity) { clearSidebarCard(card); continue; }
                if (card.dataset.ytbtwSidebarSignature !== identity.signature) decorateSidebarCard(card);
                cards.push({ card, login: identity.login, label: identity.label,
                    nativeIndex: Number(card.dataset.ytbtwSidebarSequence) || 0 });
            }
            cards.sort((a, b) => a.nativeIndex - b.nativeIndex);
            const seenLogins = new Set();
            for (const item of cards) {
                item.duplicate = seenLogins.has(item.login);
                seenLogins.add(item.login);
            }
            const projected = sidebarProjection(sidebarModel, cards, sidebarQuery, currentView);
            const byLogin = new Map(projected.map(item => [item.login, item]));
            let shown = 0;
            for (const item of cards) {
                const projection = byLogin.get(item.login);
                const wrap = sidebarWrap(item.card);
                if (!wrap) continue;
                const visible = !item.duplicate && !!(projection && projection.visible);
                const pinned = !item.duplicate && !!(projection && projection.favourite);
                wrap.classList.toggle('ytbtw-sidebar-filtered', !visible);
                wrap.classList.toggle('ytbtw-sidebar-pinned', pinned);
                if (pinned) {
                    wrap.style.setProperty('--ytbtw-sidebar-order', String(-1000 + projection.favouriteIndex));
                } else {
                    wrap.style.removeProperty('--ytbtw-sidebar-order');
                }
                if (visible) shown++;
                updateSidebarAction(item.card, extractSidebarIdentity(item.card));
            }
            const status = doc.querySelector('#ytbtw-sidebar-tools [role="status"]');
            if (status && status.textContent !== shown + ' channels shown') {
                status.textContent = shown + ' channels shown';
            }
        }

        function clearSidebarDecorations() {
            for (const card of [...sidebarEntries]) clearSidebarCard(card);
            sidebarEntries.clear();
        }

        function saveSidebar(recentLabel) {
            sidebarModel = normalizeSidebar(sidebarModel);
            const canonical = toCanonicalSidebar(sidebarModel, rawData.twitchSidebar, now(), sidebarLabels);
            rawData.twitchSidebar = canonical;
            renderSidebarViewOptions();
            applySidebarView();
            renderSidebarManager();
            savePart('twitchSidebar', canonical, recentLabel);
        }

        function toggleFavourite(login) {
            login = normalizeLogin(login);
            if (!login) return;
            const index = sidebarModel.favourites.indexOf(login);
            if (index >= 0) sidebarModel.favourites.splice(index, 1);
            else if (sidebarModel.favourites.length < MAX_FAVOURITES) sidebarModel.favourites.push(login);
            saveSidebar(index >= 0 ? 'Removed a Twitch sidebar favourite' : '');
        }

        function toggleGroupMember(groupId, login, checked) {
            const group = sidebarModel.groups.find(item => item.id === groupId);
            login = normalizeLogin(login);
            if (!group || !login) return;
            const index = group.members.indexOf(login);
            if (checked && index < 0 && group.members.length < MAX_GROUP_MEMBERS) group.members.push(login);
            if (!checked && index >= 0) group.members.splice(index, 1);
            saveSidebar(!checked && index >= 0 ? 'Removed a channel from a Twitch sidebar group' : '');
        }

        function closeSidebarManager() {
            const panel = doc.getElementById('ytbtw-sidebar-manager');
            if (panel) panel.remove();
            if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') lastFocus.focus();
            lastFocus = null;
            managerLogin = '';
        }

        function openSidebarManager(login, returnFocus) {
            managerLogin = normalizeLogin(login);
            lastFocus = returnFocus || doc.activeElement;
            let panel = doc.getElementById('ytbtw-sidebar-manager');
            if (!panel) {
                panel = doc.createElement('div');
                panel.id = 'ytbtw-sidebar-manager';
                panel.setAttribute('role', 'dialog');
                panel.setAttribute('aria-modal', 'true');
                panel.setAttribute('aria-label', 'Manage Twitch sidebar groups');
                (doc.body || doc.documentElement).appendChild(panel);
            }
            renderSidebarManager();
            const first = panel.querySelector('input, button, select');
            if (first) first.focus();
        }

        function renderSidebarManager() {
            const panel = doc.getElementById('ytbtw-sidebar-manager');
            if (!panel) return;
            panel.textContent = '';
            const head = doc.createElement('div');
            head.className = 'ytbtw-manager-head';
            const title = doc.createElement('strong');
            title.textContent = managerLogin ? 'Groups for ' + managerLogin : 'Sidebar groups';
            const close = makeButton('', '×', 'Close group manager');
            close.addEventListener('click', closeSidebarManager);
            head.append(title, close);
            panel.appendChild(head);

            const createRow = doc.createElement('form');
            createRow.className = 'ytbtw-manager-create';
            const name = doc.createElement('input');
            name.type = 'text';
            name.maxLength = 60;
            name.placeholder = 'New group name';
            name.setAttribute('aria-label', 'New group name');
            const add = makeButton('', 'Add', 'Create group');
            add.type = 'submit';
            createRow.append(name, add);
            createRow.addEventListener('submit', e => {
                e.preventDefault();
                const clean = name.value.trim();
                if (!clean || sidebarModel.groups.length >= MAX_GROUPS) return;
                sidebarModel.groups.push({ id: safeGroupId(clean, sidebarModel.groups.length,
                    new Set(sidebarModel.groups.map(group => group.id))), name: clean.slice(0, 60),
                    collapsed: false, members: managerLogin ? [managerLogin] : [] });
                saveSidebar();
            });
            panel.appendChild(createRow);

            const list = doc.createElement('div');
            list.className = 'ytbtw-manager-list';
            sidebarModel.groups.forEach((group, index) => {
                const row = doc.createElement('div');
                row.className = 'ytbtw-manager-row';
                if (managerLogin) {
                    const check = doc.createElement('input');
                    check.type = 'checkbox';
                    check.checked = group.members.includes(managerLogin);
                    check.setAttribute('aria-label', 'Include ' + managerLogin + ' in ' + group.name);
                    check.addEventListener('change', () => toggleGroupMember(group.id, managerLogin, check.checked));
                    row.appendChild(check);
                }
                // Storage echoes replace the model objects while the panel is
                // open, so handlers must resolve the group by id at event time
                // rather than mutate the object captured at render time.
                const liveGroup = () => sidebarModel.groups.find(item => item.id === group.id);
                const edit = doc.createElement('input');
                edit.type = 'text';
                edit.maxLength = 60;
                edit.value = group.name;
                edit.setAttribute('aria-label', 'Group name');
                edit.addEventListener('change', () => {
                    const target = liveGroup();
                    const clean = edit.value.trim().slice(0, 60);
                    if (!target || !clean) { edit.value = group.name; return; }
                    target.name = clean;
                    saveSidebar();
                });
                const collapse = makeButton('', group.collapsed ? '▸' : '▾',
                    (group.collapsed ? 'Expand ' : 'Collapse ') + group.name + ' in the sidebar list');
                collapse.setAttribute('aria-pressed', String(group.collapsed));
                collapse.addEventListener('click', () => {
                    const target = liveGroup();
                    if (!target) return;
                    target.collapsed = !target.collapsed;
                    saveSidebar();
                });
                const up = makeButton('', '↑', 'Move ' + group.name + ' up');
                const down = makeButton('', '↓', 'Move ' + group.name + ' down');
                const remove = makeButton('', 'Delete', 'Delete ' + group.name);
                up.disabled = index === 0;
                down.disabled = index === sidebarModel.groups.length - 1;
                up.addEventListener('click', () => {
                    if (index > 0) {
                        [sidebarModel.groups[index - 1], sidebarModel.groups[index]] =
                            [sidebarModel.groups[index], sidebarModel.groups[index - 1]];
                        saveSidebar();
                    }
                });
                down.addEventListener('click', () => {
                    if (index + 1 < sidebarModel.groups.length) {
                        [sidebarModel.groups[index + 1], sidebarModel.groups[index]] =
                            [sidebarModel.groups[index], sidebarModel.groups[index + 1]];
                        saveSidebar();
                    }
                });
                remove.addEventListener('click', () => {
                    sidebarModel.groups.splice(index, 1);
                    if (currentView === group.id) currentView = 'all';
                    saveSidebar('Deleted a Twitch sidebar group');
                });
                row.append(edit, collapse, up, down, remove);
                list.appendChild(row);
            });
            panel.appendChild(list);

            const io = doc.createElement('div');
            io.className = 'ytbtw-manager-io';
            const exportButton = makeButton('', 'Copy JSON', 'Copy local sidebar groups as JSON');
            const importButton = makeButton('', 'Import JSON', 'Import local sidebar groups from a JSON file');
            const file = doc.createElement('input');
            file.type = 'file';
            file.accept = 'application/json,.json';
            file.hidden = true;
            exportButton.addEventListener('click', async () => {
                const text = JSON.stringify(toCanonicalSidebar(
                    sidebarModel, rawData.twitchSidebar, now(), sidebarLabels
                ), null, 2);
                try {
                    await win.navigator.clipboard.writeText(text);
                    toast('Sidebar JSON copied', '');
                } catch (e) { toast('Clipboard unavailable', ''); }
            });
            importButton.addEventListener('click', () => file.click());
            file.addEventListener('change', () => {
                const picked = file.files && file.files[0];
                if (!picked || typeof win.FileReader !== 'function') return;
                const reader = new win.FileReader();
                reader.onload = () => {
                    try {
                        sidebarModel = normalizeSidebar(JSON.parse(String(reader.result || '{}')));
                        saveSidebar('Imported Twitch sidebar groups');
                        toast('Sidebar groups imported', '');
                    } catch (e) { toast('Invalid sidebar JSON', ''); }
                };
                reader.readAsText(picked);
            });
            io.append(exportButton, importButton, file);
            panel.appendChild(io);
        }

        function chatCandidate() {
            const selectors = [
                '.channel-root__right-column .stream-chat',
                '.channel-root__right-column [data-test-selector="chat-room-component-layout"]',
                '.channel-root__right-column'
            ];
            for (const selector of selectors) {
                const node = doc.querySelector(selector);
                if (node && !node.closest('#ytbtw-chat-overlay')) return node;
            }
            return null;
        }

        function applyOverlayOptions() {
            const host = doc.getElementById('ytbtw-chat-overlay');
            if (!host) return;
            host.dataset.placement = overlayOptions.placement;
            host.style.setProperty('--ytbtw-overlay-opacity', String(overlayOptions.opacity));
            host.style.setProperty('--ytbtw-overlay-width', overlayOptions.width + 'px');
            host.style.setProperty('--ytbtw-overlay-font-scale', String(overlayOptions.fontScale));
            host.classList.toggle('ytbtw-overlay-click-through', overlayOptions.clickThrough);
            host.classList.toggle('ytbtw-overlay-interactive', overlayOptions.interactive);
            host.classList.toggle('ytbtw-overlay-passive', !overlayOptions.interactive);
            armOverlayAutoHide();
        }

        function armOverlayAutoHide() {
            cancelLater(overlayHideTimer);
            overlayHideTimer = null;
            const host = doc.getElementById('ytbtw-chat-overlay');
            if (!host) return;
            host.classList.remove('ytbtw-overlay-hidden');
            if (!overlayOptions.autoHideMs) return;
            overlayHideTimer = later(() => {
                const current = doc.getElementById('ytbtw-chat-overlay');
                if (current && !current.matches(':focus-within')) current.classList.add('ytbtw-overlay-hidden');
            }, overlayOptions.autoHideMs);
        }

        function overlayActivity() {
            if (overlayActive) armOverlayAutoHide();
        }

        function overlayIntact() {
            if (!overlayActive || !overlayMove || !overlayMove.chat) return false;
            const host = doc.getElementById('ytbtw-chat-overlay');
            return !!(host && host.isConnected !== false &&
                overlayMove.chat.parentNode === host &&
                (!overlayMove.placeholder || overlayMove.placeholder.isConnected !== false));
        }

        function activateOverlay() {
            if (overlayActive || retired || !enabled || !overlayButtonEnabled) return false;
            const container = playerContainer();
            const chat = chatCandidate();
            if (!container || !chat || !chat.parentNode) {
                toast('Chat is not available on this page', '');
                return false;
            }
            const placeholder = typeof doc.createComment === 'function'
                ? doc.createComment('ytbtw-chat-origin') : doc.createElement('span');
            const originalParent = chat.parentNode;
            const originalNext = chat.nextSibling;
            const hadClass = chat.classList && chat.classList.contains('ytbtw-overlay-chat-node');
            originalParent.insertBefore(placeholder, chat);
            const host = doc.createElement('section');
            host.id = 'ytbtw-chat-overlay';
            host.setAttribute('role', 'region');
            host.setAttribute('aria-label', 'Twitch chat overlay');
            if (chat.classList) chat.classList.add('ytbtw-overlay-chat-node');
            host.appendChild(chat);
            container.appendChild(host);
            overlayMove = { chat, placeholder, originalParent, originalNext, hadClass };
            overlayActive = true;
            const button = doc.getElementById('ytbtw-chat-overlay-toggle');
            if (button) button.setAttribute('aria-pressed', 'true');
            applyOverlayOptions();
            return true;
        }

        function restoreChat() {
            cancelLater(overlayHideTimer);
            overlayHideTimer = null;
            const move = overlayMove;
            const host = doc.getElementById('ytbtw-chat-overlay');
            if (move && move.chat) {
                try {
                    if (move.placeholder && move.placeholder.parentNode) {
                        move.placeholder.parentNode.insertBefore(move.chat, move.placeholder);
                        move.placeholder.remove();
                    } else if (move.originalParent && move.originalParent.isConnected) {
                        const before = move.originalNext && move.originalNext.parentNode === move.originalParent
                            ? move.originalNext : null;
                        move.originalParent.insertBefore(move.chat, before);
                    }
                    if (!move.hadClass && move.chat.classList) move.chat.classList.remove('ytbtw-overlay-chat-node');
                } catch (e) { /* Twitch replaced the layout during navigation */ }
            }
            if (host) host.remove();
            overlayMove = null;
            overlayActive = false;
            const button = doc.getElementById('ytbtw-chat-overlay-toggle');
            if (button) button.setAttribute('aria-pressed', 'false');
        }

        function deactivateOverlay() {
            restoreChat();
            const button = doc.getElementById('ytbtw-chat-overlay-toggle');
            if (button && typeof button.focus === 'function') button.focus();
        }

        function processRoot(rootNode) {
            if (retired) return;
            ensurePlayerTools();
            const toolbar = ensureSidebarToolbar();
            if (toolbar) {
                for (const card of sidebarCards(rootNode || doc)) decorateSidebarCard(card);
                applySidebarView();
            }
            if (overlayActive && !overlayIntact()) restoreChat();
        }

        function processMutations(records) {
            if (retired) return;
            const cards = collectMutationElements(records, '.side-nav-card', 250);
            if (cards.size || mutationsRemoveSidebarCards(records)) {
                ensureSidebarToolbar();
                for (const card of cards) decorateSidebarCard(card);
                applySidebarView();
            }
            // Player/chat shells are few; these idempotent checks avoid rescanning
            // cards while still following Twitch's recycled SPA containers.
            ensurePlayerTools();
            applyPendingQuality();
            if (overlayActive && !overlayIntact()) restoreChat();
        }

        function updateState(nextRaw) {
            if (retired) return;
            rawData = nextRaw && typeof nextRaw === 'object' ? nextRaw : {};
            const flags = rawData.settings && typeof rawData.settings === 'object' ? rawData.settings : {};
            enabled = flags.twEnabled !== false;
            playerRecoveryEnabled = flags.twPlayerRecovery !== false;
            sidebarEnabled = flags.twSidebarTools !== false;
            overlayButtonEnabled = flags.twChatOverlayButton !== false;
            playerOptions = playerOptionsFromState(rawData.twitchPlayer, flags);
            sidebarModel = normalizeSidebar(rawData.twitchSidebar);
            overlayOptions = overlayOptionsFromState(rawData.twitchChatOverlay, flags);
            diagnostics = normalizeDiagnostics(rawData.twitchDiagnostics && rawData.twitchDiagnostics.player);
            lastDiagnosticsJson = JSON.stringify(diagnostics);
            if (!enabled || !playerRecoveryEnabled) idleRecovery();
            if (!enabled || !overlayButtonEnabled) restoreChat();
            ensurePlayerTools();
            syncPlayerPanel();
            ensureSidebarToolbar();
            renderSidebarViewOptions();
            renderSidebarManager();
            processRoot(doc);
            if (overlayActive) applyOverlayOptions();
        }

        function maintenance() {
            if (retired) return;
            if (overlayActive && !overlayIntact()) restoreChat();
            ensurePlayerTools();
            applyPendingQuality();
            ensureSidebarToolbar();
            if ([...sidebarEntries].some(card => !card.isConnected)) applySidebarView();
            checkPlayerHealth();
        }

        function onNavigation() {
            restoreChat();
            idleRecovery();
            cancelledSignature = '';
            pendingQualityRequest = '';
            lastMediaTime = null;
            lastMediaProgressAt = now();
            removePlayerPanel();
            ensurePlayerTools();
        }

        function experienceActionHandler(event) {
            if (retired || !enabled) return;
            const action = event && event.detail && event.detail.action;
            if (action === 'liveEdge') {
                if (goLive()) toast('At live edge', '');
            } else if (action === 'chatOverlay' && overlayButtonEnabled) {
                if (overlayActive) deactivateOverlay();
                else activateOverlay();
            }
        }

        function playbackProfileHandler(event) {
            if (retired) return;
            const detail = event && event.detail && typeof event.detail === 'object'
                ? event.detail : {};
            if (detail.site && detail.site !== 'twitch') return;
            if (typeof env.applyPlaybackProfile === 'function') {
                try { env.applyPlaybackProfile(detail); } catch (e) { /* optional host integration */ }
            }
            const quality = String(detail.quality || '').trim().toLowerCase();
            if (!quality || quality === 'current' || quality === 'unchanged') {
                pendingQualityRequest = '';
            } else if (applyRequestedQuality(quality)) {
                pendingQualityRequest = '';
            } else {
                pendingQualityRequest = quality;
            }
        }

        function keyHandler(event) {
            if (retired || event.defaultPrevented || event.repeat) return;
            if (event.key === 'Escape') {
                const manager = doc.getElementById('ytbtw-sidebar-manager');
                const panel = doc.getElementById('ytbtw-player-panel');
                if (manager) { event.preventDefault(); closeSidebarManager(); return; }
                if (panel && !panel.hidden) {
                    event.preventDefault(); panel.hidden = true;
                    const button = doc.getElementById('ytbtw-player-settings');
                    if (button) { button.setAttribute('aria-expanded', 'false'); button.focus(); }
                    return;
                }
            }
            if (!enabled || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
                    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || editableTarget(event.target)) return;
            const video = playerVideo();
            if (!video) return;
            const target = seekTarget(video.currentTime, event.key === 'ArrowLeft' ? -1 : 1,
                playerOptions.seekStep, video.seekable, video.duration);
            if (!Number.isFinite(target)) return;
            try {
                video.currentTime = target;
                event.preventDefault();
                event.stopPropagation();
                toast((event.key === 'ArrowLeft' ? 'Back ' : 'Forward ') + playerOptions.seekStep + 's', '');
            } catch (e) { /* media changed during the key event */ }
        }

        function retire() {
            if (retired) return;
            retired = true;
            cancelRecovery(false);
            cancelLater(diagnosticsTimer);
            cancelLater(overlayHideTimer);
            restoreChat();
            clearSidebarDecorations();
            closeSidebarManager();
            const toolbar = doc.getElementById('ytbtw-sidebar-tools');
            if (toolbar) toolbar.remove();
            const tools = doc.getElementById('ytbtw-player-experience');
            if (tools) tools.remove();
            removePlayerPanel();
            doc.removeEventListener('keydown', keyHandler, true);
            doc.removeEventListener('mousemove', overlayActivity, true);
            doc.removeEventListener('focusin', overlayActivity, true);
            doc.removeEventListener('ytbtw-experience-action', experienceActionHandler);
            doc.removeEventListener('ytb-apply-playback-profile', playbackProfileHandler);
        }

        doc.addEventListener('keydown', keyHandler, true);
        doc.addEventListener('mousemove', overlayActivity, true);
        doc.addEventListener('focusin', overlayActivity, true);
        doc.addEventListener('ytbtw-experience-action', experienceActionHandler);
        doc.addEventListener('ytb-apply-playback-profile', playbackProfileHandler);

        return {
            updateState,
            processRoot,
            processMutations,
            maintenance,
            onNavigation,
            retire,
            getDiagnostics: () => normalizeDiagnostics(diagnostics),
            getSidebar: () => normalizeSidebar(sidebarModel),
            isOverlayActive: () => overlayActive
        };
    }

    return {
        MAX_FAVOURITES,
        MAX_GROUPS,
        MAX_GROUP_MEMBERS,
        normalizeLogin,
        loginFromHref,
        normalizePlayerOptions,
        retryDelay,
        classifyRecoverablePlayerState,
        qualityHeight,
        chooseQualityFallback,
        lastRangeEnd,
        liveDelaySeconds,
        formatDelay,
        seekTarget,
        normalizeSidebar,
        toCanonicalSidebar,
        playerOptionsFromState,
        overlayOptionsFromState,
        normalizeOverlay,
        normalizeDiagnostics,
        extractSidebarIdentity,
        sidebarProjection,
        collectMutationElements,
        processMutationElements,
        editableTarget,
        createController
    };
});
