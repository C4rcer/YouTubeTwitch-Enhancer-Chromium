/* ==================================================================
 * YouTube/Twitch Enhancer - transcript workspace and local collections
 *
 * This module is intentionally dependency-free and can be loaded as a
 * standalone YouTube content script. Pure helpers are exported for tests.
 * No YouTube/private API or extension-owned backend is used: transcript,
 * chapter, and channel identities are read from the rendered page only.
 * ================================================================== */
(function (root, factory) {
    'use strict';

    const workspace = factory();
    root.YTBYouTubeWorkspace = workspace;
    if (typeof module !== 'undefined' && module.exports) module.exports = workspace;

    if (typeof document !== 'undefined' && typeof location !== 'undefined' &&
        /(^|\.)youtube\.com$/i.test(location.hostname)) {
        workspace.install();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STORAGE_KEY = 'data';
    const TAKEOVER_EVENT = 'ytb-youtube-workspace-takeover';
    const OWNED_ATTR = 'data-ytb-yw-owned';
    const FILTERED_CLASS = 'ytb-yw-filtered';
    const CARD_HOST_CLASS = 'ytb-yw-card-host';
    const DEFAULT_FLAGS = Object.freeze({
        ytTranscriptWorkspace: true,
        ytCollectionsEnabled: true
    });
    const LIMITS = Object.freeze({
        transcriptCues: 8000,
        chapters: 300,
        collections: 40,
        channelsPerCollection: 500,
        totalCollectionChannels: 4000,
        collectionName: 60,
        channelName: 120
    });

    const TRANSCRIPT_SEGMENT_SELECTORS = [
        'ytd-transcript-segment-renderer',
        'yt-transcript-segment-view-model',
        '.ytwTranscriptSegmentViewModelHost',
        '[data-start-offset-ms][class*="ranscript"]'
    ];
    const TRANSCRIPT_PANEL_SELECTORS = [
        'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
        'ytd-transcript-renderer',
        'ytd-transcript-search-panel-renderer',
        '[class*="TranscriptSearchPanel"]'
    ];
    const VIDEO_CARD_SELECTOR = [
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-compact-video-renderer',
        'yt-lockup-view-model',
        'ytm-rich-item-renderer',
        'ytm-video-with-context-renderer'
    ].join(',');

    function asObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function cleanText(value, maxLength) {
        return String(value == null ? '' : value)
            .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLength || 10000);
    }

    function searchKey(value) {
        const text = cleanText(value).toLocaleLowerCase();
        try {
            return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        } catch (e) {
            return text;
        }
    }

    function parseDurationWords(value) {
        const text = cleanText(value).toLowerCase();
        if (!text) return NaN;
        let total = 0;
        let matched = false;
        const units = [
            [/([\d.]+)\s*(?:hours?|hrs?|hr|h)(?=\s|,|\d|$)/, 3600],
            [/([\d.]+)\s*(?:minutes?|mins?|min|m)(?=\s|,|\d|$)/, 60],
            [/([\d.]+)\s*(?:seconds?|secs?|sec|s)(?=\s|,|\d|$)/, 1]
        ];
        for (const pair of units) {
            const match = text.match(pair[0]);
            if (!match) continue;
            total += Number(match[1]) * pair[1];
            matched = true;
        }
        return matched && Number.isFinite(total) ? total : NaN;
    }

    function parseTimestamp(value) {
        if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : NaN;
        let text = cleanText(value);
        if (!text) return NaN;
        text = text.replace(/^\[|\]$/g, '').trim();
        if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
        const wordDuration = parseDurationWords(text);
        if (Number.isFinite(wordDuration)) return wordDuration;
        if (!/^\d{1,4}(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(text)) return NaN;
        const parts = text.split(':').map(Number);
        if (parts.some(part => !Number.isFinite(part))) return NaN;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    function parseTimeToken(value) {
        const text = cleanText(value).toLowerCase();
        if (!text) return NaN;
        if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
        const words = parseDurationWords(text);
        if (Number.isFinite(words)) return words;
        return parseTimestamp(text);
    }

    function parseTimeFromHref(href) {
        if (!href) return NaN;
        try {
            const url = new URL(String(href), 'https://www.youtube.com/');
            const raw = url.searchParams.get('t') || url.searchParams.get('start') ||
                url.searchParams.get('time_continue') ||
                (url.hash.match(/(?:^#|[&#])t=([^&]+)/i) || [])[1];
            return parseTimeToken(raw);
        } catch (e) {
            const match = String(href).match(/[?&#](?:t|start|time_continue)=([^&#]+)/i);
            return parseTimeToken(match && match[1]);
        }
    }

    function formatTimestamp(seconds) {
        const value = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor((value % 3600) / 60);
        const secs = value % 60;
        if (hours) return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
        return minutes + ':' + String(secs).padStart(2, '0');
    }

    function normalizeTranscriptCues(input) {
        const cues = [];
        const seen = new Set();
        for (const raw of Array.isArray(input) ? input : []) {
            if (!raw || cues.length >= LIMITS.transcriptCues) break;
            const start = parseTimestamp(raw.start != null ? raw.start :
                (raw.time != null ? raw.time : raw.timestamp));
            const text = cleanText(raw.text != null ? raw.text : raw.label, 2000);
            if (!Number.isFinite(start) || !text) continue;
            const key = Math.round(start * 1000) + '|' + text;
            if (seen.has(key)) continue;
            seen.add(key);
            const cue = { start, text };
            if (raw.node) cue.node = raw.node;
            cues.push(cue);
        }
        cues.sort((a, b) => a.start - b.start);
        return cues;
    }

    function searchTranscript(cues, query) {
        const list = Array.isArray(cues) ? cues : [];
        const words = searchKey(query).split(/\s+/).filter(Boolean);
        if (!words.length) return list.map((cue, index) => index);
        const result = [];
        list.forEach((cue, index) => {
            const haystack = searchKey(cue && cue.text);
            if (words.every(word => haystack.includes(word))) result.push(index);
        });
        return result;
    }

    function findActiveCueIndex(cues, currentTime) {
        const list = Array.isArray(cues) ? cues : [];
        const time = Number(currentTime);
        if (!list.length || !Number.isFinite(time) || time < list[0].start) return -1;
        let low = 0;
        let high = list.length - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (list[mid].start <= time) low = mid + 1;
            else high = mid - 1;
        }
        return high;
    }

    function formatTranscriptText(cues, includeTimestamps) {
        const normalized = normalizeTranscriptCues(cues);
        return normalized.map(cue =>
            (includeTimestamps === false ? '' : '[' + formatTimestamp(cue.start) + '] ') + cue.text
        ).join('\n');
    }

    function queryAll(rootNode, selectors) {
        const found = [];
        const seen = new Set();
        if (!rootNode || !rootNode.querySelectorAll) return found;
        for (const selector of selectors) {
            let nodes = [];
            try { nodes = rootNode.querySelectorAll(selector); } catch (e) { nodes = []; }
            for (const node of nodes) {
                if (!seen.has(node)) {
                    seen.add(node);
                    found.push(node);
                }
            }
        }
        return found;
    }

    function firstText(node, selectors) {
        if (!node) return '';
        for (const selector of selectors) {
            let el = null;
            try { el = node.querySelector && node.querySelector(selector); } catch (e) { el = null; }
            const text = cleanText(el && (el.textContent || el.getAttribute && el.getAttribute('aria-label')));
            if (text) return text;
        }
        return '';
    }

    function nodeAttribute(node, names) {
        for (const name of names) {
            const datasetKey = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const value = node && node.dataset && node.dataset[datasetKey] != null
                ? node.dataset[datasetKey]
                : node && node.getAttribute && node.getAttribute(name);
            if (value != null && value !== '') return value;
        }
        return null;
    }

    function parseTranscriptDom(rootNode) {
        const raw = [];
        for (const node of queryAll(rootNode, TRANSCRIPT_SEGMENT_SELECTORS)) {
            const offsetMs = nodeAttribute(node, ['data-start-offset-ms', 'data-start-ms']);
            const offset = offsetMs != null ? offsetMs :
                nodeAttribute(node, ['data-start-time', 'start-time']);
            let start = NaN;
            if (offset != null) {
                start = Number(offset);
                if (offsetMs != null) start /= 1000;
            }
            const timestamp = firstText(node, [
                '.segment-timestamp', '[class*="Timestamp"]', '[class*="timestamp"]',
                '[aria-label*="minute"]', '[aria-label*="second"]'
            ]);
            if (!Number.isFinite(start)) start = parseTimestamp(timestamp);
            let text = firstText(node, [
                '.segment-text', 'yt-formatted-string.segment-text',
                '[class*="SegmentText"]', '[class*="segment-text"]'
            ]);
            if (!text) {
                text = cleanText(node.textContent, 2000);
                if (timestamp && text.startsWith(timestamp)) text = cleanText(text.slice(timestamp.length), 2000);
            }
            raw.push({ start, text, node });
        }
        return normalizeTranscriptCues(raw);
    }

    function normalizeChapters(input) {
        const chapters = [];
        const seen = new Set();
        for (const raw of Array.isArray(input) ? input : []) {
            if (!raw || chapters.length >= LIMITS.chapters) break;
            const start = parseTimestamp(raw.start != null ? raw.start : raw.time);
            const title = cleanText(raw.title != null ? raw.title : raw.text, 300);
            if (!Number.isFinite(start) || !title) continue;
            const key = Math.round(start * 1000) + '|' + searchKey(title);
            if (seen.has(key)) continue;
            seen.add(key);
            const chapter = { start, title };
            if (raw.node) chapter.node = raw.node;
            chapters.push(chapter);
        }
        chapters.sort((a, b) => a.start - b.start);
        return chapters;
    }

    function chapterTarget(chapters, currentTime, direction) {
        const normalized = normalizeChapters(chapters);
        const time = Math.max(0, Number(currentTime) || 0);
        if (!normalized.length) return null;
        if (direction === 'nextChapter') {
            const next = normalized.find(chapter => chapter.start > time + 0.5);
            return next ? next.start : null;
        }
        if (direction === 'previousChapter') {
            const earlier = normalized.filter(chapter => chapter.start < time - 1);
            return earlier.length ? earlier[earlier.length - 1].start : normalized[0].start;
        }
        return null;
    }
    function parseChaptersFromDOM(rootNode) {
        if (!rootNode || !rootNode.querySelectorAll) return [];
        const raw = [];
        const renderers = queryAll(rootNode, [
            'ytd-macro-markers-list-item-renderer',
            'ytd-chapter-renderer',
            'yt-list-item-view-model[class*="chapter"]'
        ]);
        for (const node of renderers) {
            let anchor = null;
            try { anchor = node.querySelector('a[href*="t="], a[href*="start="]'); } catch (e) { anchor = null; }
            const timestamp = firstText(node, ['#time', '#timestamp', '[class*="time"]']);
            const start = parseTimeFromHref(anchor && (anchor.href || anchor.getAttribute('href')));
            const title = firstText(node, ['#title', 'h3', 'h4', 'yt-formatted-string', '[class*="title"]']);
            raw.push({ start: Number.isFinite(start) ? start : parseTimestamp(timestamp), title, node });
        }

        // Chapters expanded in the rendered description are ordinary timestamp
        // links. Restrict the fallback to watch-page description containers.
        const descriptionRoots = queryAll(rootNode, ['#description', '#description-inline-expander']);
        for (const description of descriptionRoots) {
            let anchors = [];
            try { anchors = description.querySelectorAll('a[href*="t="], a[href*="start="]'); } catch (e) { anchors = []; }
            for (const anchor of anchors) {
                const start = parseTimeFromHref(anchor.href || anchor.getAttribute('href'));
                let title = cleanText(anchor.textContent, 300);
                const parentText = cleanText(anchor.parentElement && anchor.parentElement.textContent, 500);
                if (parentText && title && parentText !== title) {
                    title = cleanText(parentText.replace(title, ''), 300) || title;
                }
                raw.push({ start, title, node: anchor });
            }
        }
        return normalizeChapters(raw);
    }

    function parseChannelFromHref(href) {
        if (!href) return null;
        let path = '';
        try { path = new URL(String(href), 'https://www.youtube.com/').pathname; }
        catch (e) { path = String(href).split(/[?#]/)[0]; }
        let match = path.match(/^\/@([^/]+)/);
        if (match) return { channelId: '', handle: decodeURIComponent(match[1]), name: '' };
        match = path.match(/^\/channel\/(UC[\w-]+)/i);
        if (match) return { channelId: match[1], handle: '', name: '' };
        match = path.match(/^\/(?:c|user)\/([^/]+)/i);
        if (match) return { channelId: '', handle: '', name: decodeURIComponent(match[1]) };
        return null;
    }

    function normalizeChannelIdentity(value) {
        const raw = typeof value === 'string' ? (parseChannelFromHref(value) || { name: value }) : asObject(value);
        const storedKey = cleanText(raw.key, 140);
        const fromUrl = parseChannelFromHref(raw.url) || {};
        const keyedId = (storedKey.match(/^id:(UC[\w-]+)$/i) || [])[1] || '';
        const keyedHandle = (storedKey.match(/^handle:(.+)$/i) || [])[1] || '';
        const rawChannelId = cleanText(raw.channelId || raw.id || keyedId || fromUrl.channelId, 80);
        const channelId = /^UC[\w-]+$/i.test(rawChannelId) ? rawChannelId : '';
        const handle = cleanText(raw.handle || keyedHandle || fromUrl.handle, 100)
            .replace(/^@/, '').toLocaleLowerCase();
        const name = cleanText(raw.name || raw.title || fromUrl.name, LIMITS.channelName);
        if (!channelId && !handle && !name) return null;
        const key = channelId ? 'id:' + channelId :
            handle ? 'handle:' + handle : 'name:' + searchKey(name);
        return {
            key,
            name,
            handle,
            channelId,
            url: cleanText(raw.url, 300),
            addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : 0
        };
    }

    function channelIdentityKey(value) {
        const channel = normalizeChannelIdentity(value);
        if (!channel) return '';
        if (channel.channelId) return 'id:' + channel.channelId.toLocaleLowerCase();
        if (channel.handle) return 'handle:' + channel.handle;
        return 'name:' + searchKey(channel.name);
    }

    function sameChannelIdentity(left, right) {
        const a = normalizeChannelIdentity(left);
        const b = normalizeChannelIdentity(right);
        if (!a || !b) return false;
        if (a.channelId && b.channelId) return a.channelId.toLocaleLowerCase() === b.channelId.toLocaleLowerCase();
        if (a.handle && b.handle) return a.handle === b.handle;
        // Do not merge two explicitly different strong identities merely
        // because their current display names happen to match.
        if ((a.channelId && b.channelId) || (a.handle && b.handle)) return false;
        return !!(a.name && b.name && searchKey(a.name) === searchKey(b.name));
    }

    function safeId(value) {
        return cleanText(value, 80).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    }

    function createCollectionId(seed) {
        const random = typeof crypto !== 'undefined' && crypto.getRandomValues
            ? crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
            : Math.random().toString(36).slice(2);
        return 'c_' + (Number(seed) || Date.now()).toString(36) + '_' + random;
    }

    function normalizeCollections(input) {
        const out = [];
        const ids = new Set();
        let totalChannels = 0;
        for (const raw of Array.isArray(input) ? input : []) {
            if (!raw || out.length >= LIMITS.collections || totalChannels >= LIMITS.totalCollectionChannels) break;
            const name = cleanText(raw.name, LIMITS.collectionName);
            if (!name) continue;
            let id = safeId(raw.id) || createCollectionId(raw.createdAt);
            while (ids.has(id)) id = createCollectionId();
            ids.add(id);
            const channels = [];
            const rawChannels = Array.isArray(raw.channels) ? raw.channels : [];
            for (const item of rawChannels) {
                if (channels.length >= LIMITS.channelsPerCollection ||
                    totalChannels >= LIMITS.totalCollectionChannels) break;
                const channel = normalizeChannelIdentity(item);
                if (!channel || channels.some(existing => sameChannelIdentity(existing, channel))) continue;
                channels.push(channel);
                totalChannels++;
            }
            out.push({
                id,
                name,
                color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color.toLowerCase() : '#3ea6ff',
                channels,
                createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0,
                updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0
            });
        }
        return out;
    }

    function collectionIncludesChannel(collection, channel) {
        const identity = normalizeChannelIdentity(channel);
        return !!(identity && collection && Array.isArray(collection.channels) &&
            collection.channels.some(item => sameChannelIdentity(item, identity)));
    }

    function collectionViewIncludesChannel(collections, activeCollectionId, channel) {
        if (!activeCollectionId) return true;
        const identity = normalizeChannelIdentity(channel);
        if (!identity) return false;
        const normalized = normalizeCollections(collections);
        if (activeCollectionId === '__uncollected__') {
            return !normalized.some(collection => collectionIncludesChannel(collection, identity));
        }
        const selected = normalized.find(collection => collection.id === activeCollectionId);
        return !!(selected && collectionIncludesChannel(selected, identity));
    }
    function escapeCsv(value) {
        const text = String(value == null ? '' : value);
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }

    function serializeCollectionsJSON(collections) {
        return JSON.stringify({ version: 1, collections: normalizeCollections(collections) }, null, 2);
    }

    function parseCollectionsJSON(text) {
        const parsed = JSON.parse(String(text || ''));
        return normalizeCollections(Array.isArray(parsed) ? parsed : parsed && parsed.collections);
    }

    function serializeCollectionsCSV(collections) {
        const rows = [['collection_id', 'collection_name', 'channel_id', 'handle', 'channel_name']];
        for (const collection of normalizeCollections(collections)) {
            if (!collection.channels.length) rows.push([collection.id, collection.name, '', '', '']);
            for (const channel of collection.channels) {
                rows.push([collection.id, collection.name, channel.channelId, channel.handle, channel.name]);
            }
        }
        return rows.map(row => row.map(escapeCsv).join(',')).join('\r\n');
    }

    function parseCsvRows(text) {
        const rows = [];
        let row = [];
        let field = '';
        let quoted = false;
        const source = String(text || '').replace(/^\uFEFF/, '');
        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            if (quoted) {
                if (char === '"' && source[index + 1] === '"') {
                    field += '"';
                    index++;
                } else if (char === '"') quoted = false;
                else field += char;
            } else if (char === '"') quoted = true;
            else if (char === ',') {
                row.push(field);
                field = '';
            } else if (char === '\n') {
                row.push(field.replace(/\r$/, ''));
                rows.push(row);
                row = [];
                field = '';
            } else field += char;
        }
        if (field || row.length) {
            row.push(field.replace(/\r$/, ''));
            rows.push(row);
        }
        return rows;
    }

    function parseCollectionsCSV(text) {
        const rows = parseCsvRows(text);
        if (!rows.length) return [];
        const header = rows.shift().map(cell => cleanText(cell).toLowerCase());
        const indexOf = name => header.indexOf(name);
        const grouped = new Map();
        for (const row of rows) {
            const name = cleanText(row[indexOf('collection_name')], LIMITS.collectionName);
            if (!name) continue;
            const rawId = safeId(row[indexOf('collection_id')]);
            const key = rawId || 'name_' + searchKey(name);
            if (!grouped.has(key)) grouped.set(key, { id: rawId, name, channels: [] });
            const channel = normalizeChannelIdentity({
                channelId: row[indexOf('channel_id')],
                handle: row[indexOf('handle')],
                name: row[indexOf('channel_name')]
            });
            if (channel) grouped.get(key).channels.push(channel);
        }
        return normalizeCollections([...grouped.values()]);
    }

    function channelLabel(channel) {
        const normalized = normalizeChannelIdentity(channel);
        if (!normalized) return 'Unknown channel';
        return normalized.name || (normalized.handle ? '@' + normalized.handle : normalized.channelId);
    }

    function getBrowserApi(override) {
        if (override) return override;
        if (typeof browser !== 'undefined') return browser;
        if (typeof chrome !== 'undefined') return chrome;
        return null;
    }

    let currentRuntime = null;

    function install(options) {
        options = options || {};
        if (currentRuntime && !currentRuntime.retired) return currentRuntime.publicApi;
        if (typeof document === 'undefined' || typeof location === 'undefined') return null;
        const api = getBrowserApi(options.api);
        if (!api || !api.storage || !api.storage.local) return null;

        const instanceId = Math.random().toString(36).slice(2);
        const runtime = {
            retired: false,
            loaded: false,
            settings: Object.assign({ enabled: true }, DEFAULT_FLAGS),
            collections: [],
            activeCollectionId: '',
            observer: null,
            timer: null,
            urlTimer: null,
            writeChain: Promise.resolve(),
            lastUrl: location.href,
            workspaceOpen: false,
            workspaceTab: 'transcript',
            transcriptQuery: '',
            cues: [],
            chapters: [],
            cueSignature: '',
            chapterSignature: '',
            activeCueIndex: -1,
            cueButtons: new Map(),
            video: null,
            nativeAttemptVideo: '',
            listeners: [],
            publicApi: null
        };
        currentRuntime = runtime;

        function own(element) {
            if (element && element.setAttribute) element.setAttribute(OWNED_ATTR, instanceId);
            return element;
        }

        function listen(target, type, handler, capture) {
            if (!target || !target.addEventListener) return;
            target.addEventListener(type, handler, capture);
            runtime.listeners.push(() => {
                try { target.removeEventListener(type, handler, capture); } catch (e) { /* ignore */ }
            });
        }

        function removeOwned(selector) {
            const query = selector || '[' + OWNED_ATTR + '="' + instanceId + '"]';
            document.querySelectorAll(query).forEach(node => node.remove());
        }

        function clearFilteredCards() {
            document.querySelectorAll('.' + FILTERED_CLASS)
                .forEach(card => card.classList.remove(FILTERED_CLASS));
        }

        function restoreFilteredCards() {
            clearFilteredCards();
            document.querySelectorAll('.' + CARD_HOST_CLASS)
                .forEach(card => card.classList.remove(CARD_HOST_CLASS));
        }

        function unbindVideo() {
            if (runtime.video) {
                try { runtime.video.removeEventListener('timeupdate', updateActiveCue); } catch (e) { /* ignore */ }
                try { runtime.video.removeEventListener('loadedmetadata', updateActiveCue); } catch (e) { /* ignore */ }
            }
            runtime.video = null;
        }

        function retire() {
            if (runtime.retired) return;
            runtime.retired = true;
            if (runtime.observer) runtime.observer.disconnect();
            if (runtime.timer) clearTimeout(runtime.timer);
            if (runtime.urlTimer) clearInterval(runtime.urlTimer);
            unbindVideo();
            runtime.listeners.splice(0).forEach(remove => remove());
            removeOwned();
            restoreFilteredCards();
            if (api.storage.onChanged && api.storage.onChanged.removeListener) {
                try { api.storage.onChanged.removeListener(onStorageChanged); } catch (e) { /* ignore */ }
            }
            if (currentRuntime === runtime) currentRuntime = null;
        }

        function isEnabled(flag) {
            return runtime.settings.enabled !== false && runtime.settings[flag] !== false;
        }

        function isWatchPage() {
            return location.pathname === '/watch' && !!new URL(location.href).searchParams.get('v');
        }

        function isSubscriptionsPage() {
            return /^\/feed\/subscriptions\/?$/.test(location.pathname);
        }

        function isChannelPage() {
            return /^\/(?:@[^/]+|channel\/UC[\w-]+|c\/[^/]+|user\/[^/]+)/i.test(location.pathname);
        }

        function videoId() {
            try { return new URL(location.href).searchParams.get('v') || ''; } catch (e) { return ''; }
        }

        function loadState(rawData) {
            const data = asObject(rawData);
            runtime.settings = Object.assign({ enabled: true }, DEFAULT_FLAGS, asObject(data.settings));
            runtime.collections = normalizeCollections(data.ytCollections);
            if (runtime.activeCollectionId && runtime.activeCollectionId !== '__uncollected__' &&
                !runtime.collections.some(collection => collection.id === runtime.activeCollectionId)) {
                runtime.activeCollectionId = '';
            }
        }

        function persistCollections(nextCollections, actionLabel) {
            const beforeCollections = actionLabel ? normalizeCollections(runtime.collections) : null;
            runtime.collections = normalizeCollections(nextCollections);
            if (runtime.activeCollectionId && runtime.activeCollectionId !== '__uncollected__' &&
                !runtime.collections.some(collection => collection.id === runtime.activeCollectionId)) {
                runtime.activeCollectionId = '';
            }
            reconcileCollections();
            runtime.writeChain = runtime.writeChain.catch(() => {}).then(async () => {
                const stored = await api.storage.local.get(STORAGE_KEY);
                const full = Object.assign({}, asObject(stored && stored[STORAGE_KEY]));
                full.ytCollections = normalizeCollections(runtime.collections);
                if (actionLabel && typeof YTBFeatures !== 'undefined' &&
                        (!full.settings || full.settings.recentActionsEnabled !== false)) {
                    full.recentActions = YTBFeatures.addRecentAction(full.recentActions, {
                        id: 'action-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
                        type: 'collection-change', label: actionLabel,
                        before: { ytCollections: beforeCollections },
                        after: { ytCollections: full.ytCollections },
                        expiresAt: Date.now() + 7 * 86400000
                    });
                }
                await api.storage.local.set({ [STORAGE_KEY]: full });
                return full.ytCollections;
            }).catch(error => {
                console.warn('[YTB workspace] Could not save collections:', error);
            });
            return runtime.writeChain;
        }

        function onStorageChanged(changes, area) {
            if (runtime.retired || area !== 'local' || !changes || !changes[STORAGE_KEY]) return;
            loadState(changes[STORAGE_KEY].newValue);
            scheduleReconcile(0);
        }

        function scheduleReconcile(delay) {
            if (runtime.retired) return;
            if (runtime.timer) clearTimeout(runtime.timer);
            runtime.timer = setTimeout(() => {
                runtime.timer = null;
                reconcile();
            }, delay == null ? 100 : delay);
        }

        function element(tag, className, text) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text != null) node.textContent = text;
            return node;
        }

        function button(className, text, label) {
            const node = element('button', className, text);
            node.type = 'button';
            if (label) node.setAttribute('aria-label', label);
            return node;
        }

        function findPlayerControls() {
            return document.querySelector('.html5-video-player .ytp-right-controls, .html5-video-player .ytp-left-controls');
        }

        function ensurePlayerButton() {
            let playerButton = document.querySelector('#ytb-yw-player-button[' + OWNED_ATTR + '="' + instanceId + '"]');
            if (playerButton && playerButton.isConnected) return playerButton;
            const controls = findPlayerControls();
            if (!controls) return null;
            playerButton = own(button('ytp-button ytb-yw-player-button', '≡', 'Open transcript and chapters'));
            playerButton.id = 'ytb-yw-player-button';
            playerButton.title = 'Transcript and chapters';
            playerButton.setAttribute('aria-haspopup', 'dialog');
            playerButton.setAttribute('aria-expanded', String(runtime.workspaceOpen));
            playerButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                toggleWorkspace();
            });
            controls.appendChild(playerButton);
            return playerButton;
        }

        function workspaceHost() {
            return document.querySelector('#secondary-inner') ||
                document.querySelector('ytd-watch-flexy #secondary') || document.body;
        }

        function setWorkspaceStatus(message, mode) {
            const rootNode = document.querySelector('#ytb-yw-workspace[' + OWNED_ATTR + '="' + instanceId + '"]');
            const status = rootNode && rootNode.querySelector('.ytb-yw-status');
            if (!status) return;
            status.textContent = message || '';
            status.dataset.mode = mode || '';
            status.hidden = !message;
        }

        function setWorkspaceTab(tab, focusTab) {
            runtime.workspaceTab = tab === 'chapters' ? 'chapters' : 'transcript';
            const rootNode = document.querySelector('#ytb-yw-workspace[' + OWNED_ATTR + '="' + instanceId + '"]');
            if (!rootNode) return;
            rootNode.querySelectorAll('[role="tab"]').forEach(tabButton => {
                const selected = tabButton.dataset.tab === runtime.workspaceTab;
                tabButton.setAttribute('aria-selected', String(selected));
                tabButton.tabIndex = selected ? 0 : -1;
                if (selected && focusTab) tabButton.focus();
            });
            rootNode.querySelectorAll('[role="tabpanel"]').forEach(panel => {
                panel.hidden = panel.dataset.panel !== runtime.workspaceTab;
            });
        }

        function buildWorkspace() {
            const dock = own(element('aside', 'ytb-yw-workspace'));
            dock.id = 'ytb-yw-workspace';
            dock.setAttribute('role', 'dialog');
            dock.setAttribute('aria-modal', 'false');
            dock.setAttribute('aria-labelledby', 'ytb-yw-title');

            const header = element('header', 'ytb-yw-header');
            const heading = element('h2', 'ytb-yw-title', 'Transcript workspace');
            heading.id = 'ytb-yw-title';
            const close = button('ytb-yw-icon-button', '×', 'Close transcript workspace');
            close.addEventListener('click', closeWorkspace);
            header.append(heading, close);

            const tabs = element('div', 'ytb-yw-tabs');
            tabs.setAttribute('role', 'tablist');
            tabs.setAttribute('aria-label', 'Workspace views');
            const transcriptTab = button('ytb-yw-tab', 'Transcript');
            transcriptTab.dataset.tab = 'transcript';
            transcriptTab.setAttribute('role', 'tab');
            transcriptTab.setAttribute('aria-controls', 'ytb-yw-transcript-panel');
            const chapterTab = button('ytb-yw-tab', 'Chapters');
            chapterTab.dataset.tab = 'chapters';
            chapterTab.setAttribute('role', 'tab');
            chapterTab.setAttribute('aria-controls', 'ytb-yw-chapter-panel');
            [transcriptTab, chapterTab].forEach(tab => {
                tab.addEventListener('click', () => setWorkspaceTab(tab.dataset.tab));
                tab.addEventListener('keydown', event => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    setWorkspaceTab(runtime.workspaceTab === 'transcript' ? 'chapters' : 'transcript', true);
                });
            });
            tabs.append(transcriptTab, chapterTab);

            const transcriptPanel = element('section', 'ytb-yw-panel');
            transcriptPanel.id = 'ytb-yw-transcript-panel';
            transcriptPanel.dataset.panel = 'transcript';
            transcriptPanel.setAttribute('role', 'tabpanel');
            transcriptPanel.setAttribute('aria-labelledby', transcriptTab.id = 'ytb-yw-transcript-tab');
            const searchRow = element('div', 'ytb-yw-search-row');
            const search = element('input', 'ytb-yw-search');
            search.type = 'search';
            search.placeholder = 'Search transcript';
            search.setAttribute('aria-label', 'Search transcript');
            search.value = runtime.transcriptQuery;
            const count = element('span', 'ytb-yw-result-count');
            count.setAttribute('aria-live', 'polite');
            search.addEventListener('input', () => {
                runtime.transcriptQuery = search.value;
                renderTranscriptList();
            });
            searchRow.append(search, count);
            const actions = element('div', 'ytb-yw-actions');
            const native = button('ytb-yw-button', 'Open native', 'Open YouTube transcript');
            native.dataset.action = 'native';
            native.addEventListener('click', () => openNativeTranscript(true));
            const copy = button('ytb-yw-button', 'Copy', 'Copy transcript');
            copy.dataset.action = 'copy';
            copy.addEventListener('click', copyTranscript);
            const download = button('ytb-yw-button', 'Download', 'Download transcript as text');
            download.dataset.action = 'download';
            download.addEventListener('click', downloadTranscript);
            actions.append(native, copy, download);
            const transcriptList = element('div', 'ytb-yw-list ytb-yw-transcript-list');
            transcriptList.setAttribute('aria-label', 'Transcript cues');
            transcriptPanel.append(searchRow, actions, transcriptList);

            const chapterPanel = element('section', 'ytb-yw-panel');
            chapterPanel.id = 'ytb-yw-chapter-panel';
            chapterPanel.dataset.panel = 'chapters';
            chapterPanel.setAttribute('role', 'tabpanel');
            chapterPanel.setAttribute('aria-labelledby', chapterTab.id = 'ytb-yw-chapter-tab');
            const chapterList = element('div', 'ytb-yw-list ytb-yw-chapter-list');
            chapterList.setAttribute('aria-label', 'Video chapters');
            chapterPanel.appendChild(chapterList);

            const status = element('p', 'ytb-yw-status');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.hidden = true;
            dock.append(header, tabs, transcriptPanel, chapterPanel, status);
            workspaceHost().prepend(dock);
            setWorkspaceTab(runtime.workspaceTab);
            return dock;
        }

        function ensureWorkspace() {
            let dock = document.querySelector('#ytb-yw-workspace[' + OWNED_ATTR + '="' + instanceId + '"]');
            if (!dock) dock = buildWorkspace();
            const host = workspaceHost();
            if (dock.parentElement !== host) host.prepend(dock);
            return dock;
        }

        function toggleWorkspace() {
            if (runtime.workspaceOpen) closeWorkspace();
            else openWorkspace();
        }

        function openWorkspace() {
            if (!isEnabled('ytTranscriptWorkspace') || !isWatchPage()) return;
            runtime.workspaceOpen = true;
            const dock = ensureWorkspace();
            const playerButton = ensurePlayerButton();
            if (playerButton) playerButton.setAttribute('aria-expanded', 'true');
            refreshWorkspaceData();
            const focusTarget = dock.querySelector('[role="tab"][aria-selected="true"]') || dock.querySelector('button');
            if (focusTarget) focusTarget.focus({ preventScroll: true });
            if (!runtime.cues.length && runtime.nativeAttemptVideo !== videoId()) openNativeTranscript(false);
        }

        function closeWorkspace() {
            runtime.workspaceOpen = false;
            removeOwned('#ytb-yw-workspace[' + OWNED_ATTR + '="' + instanceId + '"]');
            const playerButton = ensurePlayerButton();
            if (playerButton) {
                playerButton.setAttribute('aria-expanded', 'false');
                playerButton.focus({ preventScroll: true });
            }
        }

        function cleanupTranscriptUI() {
            runtime.workspaceOpen = false;
            runtime.cues = [];
            runtime.chapters = [];
            runtime.cueSignature = '';
            runtime.chapterSignature = '';
            runtime.activeCueIndex = -1;
            runtime.cueButtons.clear();
            unbindVideo();
            removeOwned('#ytb-yw-workspace[' + OWNED_ATTR + '="' + instanceId + '"]');
            removeOwned('#ytb-yw-player-button[' + OWNED_ATTR + '="' + instanceId + '"]');
        }

        function bindVideo() {
            const video = document.querySelector('.html5-video-player video, video.html5-main-video');
            if (video === runtime.video) return;
            unbindVideo();
            runtime.video = video || null;
            if (runtime.video) {
                runtime.video.addEventListener('timeupdate', updateActiveCue);
                runtime.video.addEventListener('loadedmetadata', updateActiveCue);
            }
        }

        function cueSignature(cues) {
            return cues.map(cue => Math.round(cue.start * 1000) + ':' + cue.text).join('|');
        }

        function chapterSignature(chapters) {
            return chapters.map(chapter => Math.round(chapter.start * 1000) + ':' + chapter.title).join('|');
        }

        function refreshWorkspaceData() {
            if (!runtime.workspaceOpen || runtime.retired) return;
            ensureWorkspace();
            bindVideo();
            const cues = parseTranscriptDom(document);
            const chapters = parseChaptersFromDOM(document);
            const nextCueSignature = cueSignature(cues);
            const nextChapterSignature = chapterSignature(chapters);
            if (nextCueSignature !== runtime.cueSignature) {
                runtime.cues = cues;
                runtime.cueSignature = nextCueSignature;
                renderTranscriptList();
            }
            if (nextChapterSignature !== runtime.chapterSignature) {
                runtime.chapters = chapters;
                runtime.chapterSignature = nextChapterSignature;
                renderChapterList();
            }
            updateActiveCue();
            if (!runtime.cues.length) {
                setWorkspaceStatus('No rendered transcript cues found. Open YouTube’s transcript, then try again.', 'empty');
            } else setWorkspaceStatus('', '');
        }

        function renderTranscriptList() {
            const dock = document.querySelector('#ytb-yw-workspace[' + OWNED_ATTR + '="' + instanceId + '"]');
            const list = dock && dock.querySelector('.ytb-yw-transcript-list');
            if (!list) return;
            const matches = searchTranscript(runtime.cues, runtime.transcriptQuery);
            const fragment = document.createDocumentFragment();
            runtime.cueButtons.clear();
            for (const index of matches) {
                const cue = runtime.cues[index];
                const item = button('ytb-yw-cue', '', 'Jump to ' + formatTimestamp(cue.start));
                item.dataset.cueIndex = String(index);
                const time = element('span', 'ytb-yw-time', formatTimestamp(cue.start));
                const text = element('span', 'ytb-yw-cue-text', cue.text);
                item.append(time, text);
                item.addEventListener('click', () => seekTo(cue.start));
                fragment.appendChild(item);
                runtime.cueButtons.set(index, item);
            }
            if (!matches.length) {
                const empty = element('p', 'ytb-yw-empty', runtime.cues.length
                    ? 'No transcript results match this search.'
                    : 'Transcript cues will appear here after YouTube renders them.');
                empty.setAttribute('role', 'status');
                fragment.appendChild(empty);
            }
            list.replaceChildren(fragment);
            const count = dock.querySelector('.ytb-yw-result-count');
            if (count) count.textContent = runtime.transcriptQuery
                ? matches.length + ' result' + (matches.length === 1 ? '' : 's')
                : runtime.cues.length + ' cue' + (runtime.cues.length === 1 ? '' : 's');
            const disabled = !runtime.cues.length;
            ['copy', 'download'].forEach(action => {
                const actionButton = dock.querySelector('[data-action="' + action + '"]');
                if (actionButton) actionButton.disabled = disabled;
            });
            runtime.activeCueIndex = -1;
            updateActiveCue();
        }

        function renderChapterList() {
            const dock = document.querySelector('#ytb-yw-workspace[' + OWNED_ATTR + '="' + instanceId + '"]');
            const list = dock && dock.querySelector('.ytb-yw-chapter-list');
            if (!list) return;
            const fragment = document.createDocumentFragment();
            for (const chapter of runtime.chapters) {
                const item = button('ytb-yw-cue ytb-yw-chapter', '', 'Jump to chapter ' + chapter.title);
                item.append(
                    element('span', 'ytb-yw-time', formatTimestamp(chapter.start)),
                    element('span', 'ytb-yw-cue-text', chapter.title)
                );
                item.addEventListener('click', () => seekTo(chapter.start));
                fragment.appendChild(item);
            }
            if (!runtime.chapters.length) {
                const empty = element('p', 'ytb-yw-empty', 'No rendered chapters were found for this video.');
                empty.setAttribute('role', 'status');
                fragment.appendChild(empty);
            }
            list.replaceChildren(fragment);
        }

        function seekTo(seconds) {
            bindVideo();
            if (!runtime.video) {
                setWorkspaceStatus('The video player is not available yet.', 'error');
                return;
            }
            runtime.video.currentTime = Math.max(0, Number(seconds) || 0);
            try { runtime.video.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
            updateActiveCue();
        }

        function onWorkspaceAction(event) {
            const action = event && event.detail && event.detail.action;
            if (action !== 'previousChapter' && action !== 'nextChapter') return;
            bindVideo();
            if (!runtime.video) return;
            if (!runtime.chapters.length) runtime.chapters = parseChaptersFromDOM(document);
            const target = chapterTarget(runtime.chapters, runtime.video.currentTime, action);
            if (target !== null) seekTo(target);
        }
        function updateActiveCue() {
            const next = findActiveCueIndex(runtime.cues, runtime.video && runtime.video.currentTime);
            if (next === runtime.activeCueIndex) return;
            const previousButton = runtime.cueButtons.get(runtime.activeCueIndex);
            if (previousButton) {
                previousButton.classList.remove('is-active');
                previousButton.removeAttribute('aria-current');
            }
            runtime.activeCueIndex = next;
            const activeButton = runtime.cueButtons.get(next);
            if (activeButton) {
                activeButton.classList.add('is-active');
                activeButton.setAttribute('aria-current', 'true');
                const list = activeButton.closest('.ytb-yw-list');
                if (list && (activeButton.offsetTop < list.scrollTop ||
                    activeButton.offsetTop + activeButton.offsetHeight > list.scrollTop + list.clientHeight)) {
                    activeButton.scrollIntoView({ block: 'nearest' });
                }
            }
        }

        // "Show transcript" carries a localized label. Match the word stem in
        // YouTube's common UI languages ("transcri" covers en/fr/es/pt/nl,
        // "transkrip" covers de/pl); the section renderer selector below is the
        // language-independent fallback for everything else.
        const TRANSCRIPT_LABEL_RE = /transcri|transkrip|trascrizion|расшифровк|文字起こし|스크립트/i;

        function renderedTranscriptButton() {
            const selectors = [
                'button[aria-label*="transcri" i]',
                'button[aria-label*="transkrip" i]',
                'button[aria-label*="文字起こし"]',
                '[role="button"][aria-label*="transcri" i]',
                '[role="button"][aria-label*="transkrip" i]',
                'ytd-video-description-transcript-section-renderer button'
            ];
            for (const selector of selectors) {
                const candidate = document.querySelector(selector);
                if (candidate && !candidate.closest('#ytb-yw-workspace')) return candidate;
            }
            const candidates = document.querySelectorAll(
                '#description button, #description tp-yt-paper-button, ytd-watch-metadata button, ytd-watch-metadata [role="button"]'
            );
            return [...candidates].find(candidate => TRANSCRIPT_LABEL_RE.test(cleanText(
                candidate.getAttribute('aria-label') || candidate.textContent
            ))) || null;
        }

        function openNativeTranscript(announceFailure) {
            runtime.nativeAttemptVideo = videoId();
            const existingPanel = queryAll(document, TRANSCRIPT_PANEL_SELECTORS)[0];
            if (existingPanel) {
                refreshWorkspaceData();
                return true;
            }
            let nativeButton = renderedTranscriptButton();
            if (!nativeButton) {
                const expand = document.querySelector('#description-inline-expander #expand, #description #expand');
                if (expand) {
                    try { expand.click(); } catch (e) { /* ignore */ }
                    setWorkspaceStatus('Looking for YouTube’s transcript control…', 'loading');
                    setTimeout(() => {
                        if (runtime.retired || !runtime.workspaceOpen) return;
                        const delayedButton = renderedTranscriptButton();
                        if (!delayedButton) {
                            setWorkspaceStatus(
                                'YouTube’s transcript control is not rendered. Open it from the description menu and this workspace will import it.',
                                'empty'
                            );
                            return;
                        }
                        try { delayedButton.click(); } catch (e) { return; }
                        setWorkspaceStatus('Waiting for YouTube to render transcript cues…', 'loading');
                        setTimeout(() => {
                            if (!runtime.retired && runtime.workspaceOpen) refreshWorkspaceData();
                        }, 350);
                    }, 180);
                    return true;
                }
            }
            if (!nativeButton) {
                if (announceFailure) setWorkspaceStatus(
                    'YouTube’s transcript control is not rendered. Open it from the description menu and this workspace will import it.',
                    'empty'
                );
                return false;
            }
            try { nativeButton.click(); } catch (e) { return false; }
            setWorkspaceStatus('Waiting for YouTube to render transcript cues…', 'loading');
            setTimeout(() => {
                if (!runtime.retired && runtime.workspaceOpen) refreshWorkspaceData();
            }, 350);
            return true;
        }

        async function writeClipboard(text) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return;
            }
            const area = element('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.className = 'ytb-yw-clipboard-fallback';
            document.body.appendChild(area);
            area.select();
            const copied = document.execCommand && document.execCommand('copy');
            area.remove();
            if (!copied) throw new Error('Copy command unavailable');
        }

        async function copyTranscript() {
            if (!runtime.cues.length) return;
            try {
                await writeClipboard(formatTranscriptText(runtime.cues, true));
                setWorkspaceStatus('Transcript copied.', 'success');
            } catch (e) {
                setWorkspaceStatus('Could not copy the transcript.', 'error');
            }
        }

        function safeFilename(value) {
            return cleanText(value, 100).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'youtube-transcript';
        }

        function downloadText(filename, text, type) {
            const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const anchor = own(element('a'));
            anchor.href = url;
            anchor.download = filename;
            anchor.hidden = true;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 0);
        }

        function downloadTranscript() {
            if (!runtime.cues.length) return;
            const title = document.querySelector('h1.ytd-watch-metadata, ytd-watch-metadata h1, meta[name="title"]');
            const name = safeFilename(title && (title.textContent || title.content));
            downloadText(name + '.txt', formatTranscriptText(runtime.cues, true));
            setWorkspaceStatus('Transcript download started.', 'success');
        }

        function extractChannelIdentity(container) {
            if (!container) return null;
            let channelId = nodeAttribute(container, ['data-channel-id', 'channel-id']) || '';
            let anchor = null;
            try {
                anchor = container.matches && container.matches('a[href*="/@"], a[href*="/channel/"]')
                    ? container
                    : container.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/c/"], a[href*="/user/"]');
            } catch (e) { anchor = null; }
            const fromHref = parseChannelFromHref(anchor && (anchor.href || anchor.getAttribute('href'))) || {};
            channelId = channelId || fromHref.channelId || '';
            const name = firstText(container, [
                'ytd-channel-name #text', '#channel-name #text', '.ytd-channel-name',
                '[class*="ChannelName"]', '#text-container yt-formatted-string'
            ]) || cleanText(anchor && anchor.textContent, LIMITS.channelName);
            return normalizeChannelIdentity({ channelId, handle: fromHref.handle, name: name || fromHref.name });
        }

        function currentChannelIdentity() {
            const fromPath = parseChannelFromHref(location.pathname) || {};
            const header = document.querySelector(
                'ytd-c4-tabbed-header-renderer, ytd-page-header-renderer, yt-page-header-view-model, ytm-channel-header-renderer'
            );
            const rendered = extractChannelIdentity(header) || {};
            return normalizeChannelIdentity({
                channelId: rendered.channelId || fromPath.channelId,
                handle: rendered.handle || fromPath.handle,
                name: rendered.name || fromPath.name
            });
        }

        function clearCollectionFilter() {
            runtime.activeCollectionId = '';
            clearFilteredCards();
            updateCollectionToolbar();
        }

        function collectionFilter() {
            return runtime.collections.find(collection => collection.id === runtime.activeCollectionId) || null;
        }

        function applyCollectionFilter() {
            if (!isSubscriptionsPage()) {
                clearFilteredCards();
                return;
            }
            const cards = document.querySelectorAll(VIDEO_CARD_SELECTOR);
            cards.forEach(card => {
                const matches = collectionViewIncludesChannel(
                    runtime.collections, runtime.activeCollectionId, extractChannelIdentity(card));
                card.classList.toggle(FILTERED_CLASS, !matches);
            });
        }

        function toolbarHost() {
            const grid = document.querySelector(
                'ytd-browse[page-subtype="subscriptions"] ytd-rich-grid-renderer, ytd-browse ytd-rich-grid-renderer, ytm-browse ytm-rich-grid-renderer'
            );
            return grid && grid.parentElement || document.querySelector('ytd-browse #primary, ytm-browse');
        }

        function ensureCollectionToolbar() {
            let toolbar = document.querySelector('#ytb-yw-collection-toolbar[' + OWNED_ATTR + '="' + instanceId + '"]');
            if (toolbar && toolbar.isConnected) return toolbar;
            const host = toolbarHost();
            if (!host) return null;
            toolbar = own(element('section', 'ytb-yw-collection-toolbar'));
            toolbar.id = 'ytb-yw-collection-toolbar';
            toolbar.setAttribute('aria-label', 'Subscription collections');
            const label = element('label', 'ytb-yw-toolbar-label', 'Collection');
            label.htmlFor = 'ytb-yw-collection-select';
            const select = element('select', 'ytb-yw-select');
            select.id = 'ytb-yw-collection-select';
            select.addEventListener('change', () => {
                runtime.activeCollectionId = select.value;
                applyCollectionFilter();
                updateCollectionToolbar();
            });
            const clear = button('ytb-yw-button', 'Clear filter');
            clear.dataset.action = 'clear-filter';
            clear.addEventListener('click', clearCollectionFilter);
            const manage = button('ytb-yw-button', 'Manage');
            manage.addEventListener('click', openCollectionManager);
            toolbar.append(label, select, clear, manage);
            host.insertBefore(toolbar, host.firstChild);
            updateCollectionToolbar();
            return toolbar;
        }

        function updateCollectionToolbar() {
            const toolbar = document.querySelector('#ytb-yw-collection-toolbar[' + OWNED_ATTR + '="' + instanceId + '"]');
            if (!toolbar) return;
            const select = toolbar.querySelector('select');
            const fragment = document.createDocumentFragment();
            const all = element('option', '', 'All subscriptions');
            all.value = '';
            fragment.appendChild(all);
            const uncollected = element('option', '', 'Uncollected channels');
            uncollected.value = '__uncollected__';
            fragment.appendChild(uncollected);
            runtime.collections.forEach(collection => {
                const option = element('option', '', collection.name + ' (' + collection.channels.length + ')');
                option.value = collection.id;
                fragment.appendChild(option);
            });
            select.replaceChildren(fragment);
            select.value = runtime.activeCollectionId;
            const clear = toolbar.querySelector('[data-action="clear-filter"]');
            if (clear) clear.disabled = !runtime.activeCollectionId;
        }

        function ensureChannelPageAction() {
            if (!isChannelPage()) return;
            if (document.querySelector('#ytb-yw-channel-add[' + OWNED_ATTR + '="' + instanceId + '"]')) return;
            const host = document.querySelector(
                'ytd-c4-tabbed-header-renderer #buttons, ytd-page-header-renderer #buttons, yt-page-header-view-model #actions, ytm-channel-header-renderer'
            );
            const identity = currentChannelIdentity();
            if (!host || !identity) return;
            const add = own(button('ytb-yw-button ytb-yw-channel-add', 'Collections', 'Add channel to a collection'));
            add.id = 'ytb-yw-channel-add';
            add.addEventListener('click', () => openChannelChooser(currentChannelIdentity() || identity));
            host.appendChild(add);
        }

        function enhanceChannelCards() {
            const cards = document.querySelectorAll(VIDEO_CARD_SELECTOR);
            let enhanced = 0;
            for (const card of cards) {
                if (enhanced >= 500) break;
                if (card.querySelector(':scope > .ytb-yw-card-add[' + OWNED_ATTR + '="' + instanceId + '"]')) continue;
                const identity = extractChannelIdentity(card);
                if (!identity) continue;
                card.classList.add(CARD_HOST_CLASS);
                const add = own(button('ytb-yw-card-add', '+', 'Add ' + channelLabel(identity) + ' to a collection'));
                add.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    openChannelChooser(extractChannelIdentity(card) || identity);
                });
                card.appendChild(add);
                enhanced++;
            }
        }

        function modalShell(titleText) {
            removeOwned('.ytb-yw-modal-backdrop[' + OWNED_ATTR + '="' + instanceId + '"]');
            const backdrop = own(element('div', 'ytb-yw-modal-backdrop'));
            const dialog = element('section', 'ytb-yw-modal');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            const title = element('h2', 'ytb-yw-modal-title', titleText);
            const titleId = 'ytb-yw-modal-title-' + Math.random().toString(36).slice(2);
            title.id = titleId;
            dialog.setAttribute('aria-labelledby', titleId);
            const close = button('ytb-yw-icon-button ytb-yw-modal-close', '×', 'Close');
            const previousFocus = document.activeElement;
            let dismissed = false;
            const dismiss = () => {
                if (dismissed) return;
                dismissed = true;
                backdrop.remove();
                if (previousFocus && previousFocus.isConnected && previousFocus.focus) {
                    previousFocus.focus({ preventScroll: true });
                }
            };
            close.addEventListener('click', dismiss);
            backdrop.addEventListener('mousedown', event => {
                if (event.target === backdrop) dismiss();
            });
            dialog.append(title, close);
            backdrop.appendChild(dialog);
            document.body.appendChild(backdrop);
            backdrop.addEventListener('keydown', event => {
                if (event.key === 'Escape') dismiss();
                if (event.key !== 'Tab') return;
                const focusable = [...dialog.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')]
                    .filter(node => !node.disabled && !node.hidden);
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            });
            setTimeout(() => close.focus(), 0);
            return { backdrop, dialog, dismiss };
        }

        function addCollection(name, channel) {
            const cleanName = cleanText(name, LIMITS.collectionName);
            if (!cleanName || runtime.collections.length >= LIMITS.collections) return null;
            const collection = {
                id: createCollectionId(),
                name: cleanName,
                color: '#3ea6ff',
                channels: channel ? [normalizeChannelIdentity(channel)] : [],
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            persistCollections(runtime.collections.concat(collection));
            return collection;
        }

        function openCollectionManager() {
            const shell = modalShell('Manage subscription collections');
            const createForm = element('form', 'ytb-yw-create-form');
            const input = element('input', 'ytb-yw-input');
            input.placeholder = 'New collection name';
            input.maxLength = LIMITS.collectionName;
            input.setAttribute('aria-label', 'New collection name');
            const create = button('ytb-yw-button', 'Create');
            create.type = 'submit';
            createForm.append(input, create);
            const rows = element('div', 'ytb-yw-manager-list');

            function renderRows() {
                const fragment = document.createDocumentFragment();
                runtime.collections.forEach((collection, index) => {
                    const row = element('div', 'ytb-yw-manager-row');
                    const name = element('input', 'ytb-yw-input');
                    name.value = collection.name;
                    name.maxLength = LIMITS.collectionName;
                    name.setAttribute('aria-label', 'Collection name');
                    name.addEventListener('change', () => {
                        const renamed = cleanText(name.value, LIMITS.collectionName);
                        if (!renamed) {
                            name.value = collection.name;
                            return;
                        }
                        persistCollections(runtime.collections.map(item => item.id === collection.id
                            ? Object.assign({}, item, { name: renamed, updatedAt: Date.now() }) : item));
                    });
                    const color = element('input', 'ytb-yw-color');
                    color.type = 'color';
                    color.value = collection.color;
                    color.setAttribute('aria-label', 'Colour for ' + collection.name);
                    color.addEventListener('change', () => {
                        persistCollections(runtime.collections.map(item => item.id === collection.id
                            ? Object.assign({}, item, { color: color.value, updatedAt: Date.now() }) : item));
                    });
                    const count = element('span', 'ytb-yw-manager-count',
                        collection.channels.length + ' channels');
                    const up = button('ytb-yw-icon-button', '↑', 'Move ' + collection.name + ' up');
                    up.disabled = index === 0;
                    up.addEventListener('click', () => {
                        const next = runtime.collections.slice();
                        const moved = next.splice(index, 1)[0];
                        next.splice(index - 1, 0, moved);
                        persistCollections(next);
                        renderRows();
                    });
                    const down = button('ytb-yw-icon-button', '↓', 'Move ' + collection.name + ' down');
                    down.disabled = index === runtime.collections.length - 1;
                    down.addEventListener('click', () => {
                        const next = runtime.collections.slice();
                        const moved = next.splice(index, 1)[0];
                        next.splice(index + 1, 0, moved);
                        persistCollections(next);
                        renderRows();
                    });
                    const duplicate = button('ytb-yw-button', 'Duplicate', 'Duplicate ' + collection.name);
                    duplicate.disabled = runtime.collections.length >= LIMITS.collections;
                    duplicate.addEventListener('click', () => {
                        const copy = Object.assign({}, collection, {
                            id: createCollectionId(),
                            name: cleanText(collection.name + ' copy', LIMITS.collectionName),
                            channels: collection.channels.map(channel => Object.assign({}, channel)),
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        });
                        const next = runtime.collections.slice();
                        next.splice(index + 1, 0, copy);
                        persistCollections(next);
                        renderRows();
                    });
                    const remove = button('ytb-yw-button ytb-yw-danger', 'Delete', 'Delete ' + collection.name);
                    remove.addEventListener('click', () => {
                        if (typeof confirm === 'function' && !confirm('Delete collection “' + collection.name + '”?')) return;
                        persistCollections(runtime.collections.filter(item => item.id !== collection.id),
                            'Deleted a YouTube subscription collection');
                        renderRows();
                    });
                    const channelDetails = element('details', 'ytb-yw-manager-channels');
                    const summary = element('summary', '', collection.channels.length
                        ? 'Manage channels' : 'No channels');
                    channelDetails.appendChild(summary);
                    collection.channels.forEach(channel => {
                        const channelRow = element('div', 'ytb-yw-manager-channel');
                        channelRow.appendChild(element('span', '', channelLabel(channel)));
                        const removeChannel = button('ytb-yw-icon-button ytb-yw-danger', '×',
                            'Remove ' + channelLabel(channel) + ' from ' + collection.name);
                        removeChannel.addEventListener('click', () => {
                            const channels = collection.channels.filter(
                                item => !sameChannelIdentity(item, channel));
                            persistCollections(runtime.collections.map(item => item.id === collection.id
                                ? Object.assign({}, item, { channels, updatedAt: Date.now() }) : item),
                                'Removed a channel from a YouTube subscription collection');
                            renderRows();
                        });
                        channelRow.appendChild(removeChannel);
                        channelDetails.appendChild(channelRow);
                    });
                    row.append(name, color, count, up, down, duplicate, remove, channelDetails);
                    fragment.appendChild(row);
                });                if (!runtime.collections.length) fragment.appendChild(element('p', 'ytb-yw-empty', 'No collections yet.'));
                rows.replaceChildren(fragment);
            }

            createForm.addEventListener('submit', event => {
                event.preventDefault();
                if (addCollection(input.value)) {
                    input.value = '';
                    renderRows();
                }
            });
            renderRows();

            const transfers = element('div', 'ytb-yw-transfer-actions');
            const exportJson = button('ytb-yw-button', 'Export JSON');
            exportJson.addEventListener('click', () => downloadText(
                'youtube-collections.json', serializeCollectionsJSON(runtime.collections), 'application/json;charset=utf-8'
            ));
            const exportCsv = button('ytb-yw-button', 'Export CSV');
            exportCsv.addEventListener('click', () => downloadText(
                'youtube-collections.csv', serializeCollectionsCSV(runtime.collections), 'text/csv;charset=utf-8'
            ));
            const importLabel = element('label', 'ytb-yw-button ytb-yw-file-label', 'Import JSON');
            const file = element('input');
            file.type = 'file';
            file.accept = 'application/json,.json';
            file.hidden = true;
            file.addEventListener('change', async () => {
                const selected = file.files && file.files[0];
                if (!selected) return;
                try {
                    const imported = parseCollectionsJSON(await selected.text());
                    persistCollections(imported, 'Imported YouTube subscription collections from JSON');
                    renderRows();
                } catch (e) {
                    alert('That file is not a valid collections JSON export.');
                }
                file.value = '';
            });
            importLabel.appendChild(file);
            const importCsvLabel = element('label', 'ytb-yw-button ytb-yw-file-label', 'Import CSV');
            const csvFile = element('input');
            csvFile.type = 'file';
            csvFile.accept = 'text/csv,.csv';
            csvFile.hidden = true;
            csvFile.addEventListener('change', async () => {
                const selected = csvFile.files && csvFile.files[0];
                if (!selected) return;
                try {
                    persistCollections(parseCollectionsCSV(await selected.text()),
                        'Imported YouTube subscription collections from CSV');
                    renderRows();
                } catch (e) {
                    alert('That file is not a valid collections CSV export.');
                }
                csvFile.value = '';
            });
            importCsvLabel.appendChild(csvFile);
            transfers.append(exportJson, exportCsv, importLabel, importCsvLabel);
            shell.dialog.append(createForm, rows, transfers);
            input.focus();
        }

        function openChannelChooser(channel) {
            const identity = normalizeChannelIdentity(channel);
            if (!identity) return;
            const shell = modalShell('Collections for ' + channelLabel(identity));
            const form = element('form', 'ytb-yw-chooser-form');
            const list = element('div', 'ytb-yw-chooser-list');
            runtime.collections.forEach(collection => {
                const label = element('label', 'ytb-yw-check-row');
                const checkbox = element('input');
                checkbox.type = 'checkbox';
                checkbox.value = collection.id;
                checkbox.checked = collectionIncludesChannel(collection, identity);
                label.append(checkbox, element('span', '', collection.name));
                list.appendChild(label);
            });
            if (!runtime.collections.length) list.appendChild(element('p', 'ytb-yw-empty', 'Create a collection below.'));
            const newName = element('input', 'ytb-yw-input');
            newName.placeholder = 'New collection (optional)';
            newName.maxLength = LIMITS.collectionName;
            newName.setAttribute('aria-label', 'New collection name');
            const actions = element('div', 'ytb-yw-actions');
            const cancel = button('ytb-yw-button', 'Cancel');
            cancel.addEventListener('click', shell.dismiss);
            const save = button('ytb-yw-button ytb-yw-primary', 'Save');
            save.type = 'submit';
            actions.append(cancel, save);
            form.append(list, newName, actions);
            form.addEventListener('submit', event => {
                event.preventDefault();
                const selected = new Set([...list.querySelectorAll('input[type="checkbox"]:checked')].map(box => box.value));
                let next = runtime.collections.map(collection => {
                    const channels = collection.channels.filter(item => !sameChannelIdentity(item, identity));
                    if (selected.has(collection.id) && channels.length < LIMITS.channelsPerCollection) {
                        channels.push(Object.assign({}, identity, { addedAt: Date.now() }));
                    }
                    return Object.assign({}, collection, { channels, updatedAt: Date.now() });
                });
                const requestedName = cleanText(newName.value, LIMITS.collectionName);
                if (requestedName && next.length < LIMITS.collections) {
                    next = next.concat({
                        id: createCollectionId(),
                        name: requestedName,
                        color: '#3ea6ff',
                        channels: [Object.assign({}, identity, { addedAt: Date.now() })],
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });
                }
                persistCollections(next, 'Updated YouTube subscription collection memberships');
                shell.dismiss();
            });
            shell.dialog.appendChild(form);
            (list.querySelector('input') || newName).focus();
        }

        function cleanupCollectionsUI() {
            removeOwned('#ytb-yw-collection-toolbar[' + OWNED_ATTR + '="' + instanceId + '"]');
            removeOwned('#ytb-yw-channel-add[' + OWNED_ATTR + '="' + instanceId + '"]');
            removeOwned('.ytb-yw-card-add[' + OWNED_ATTR + '="' + instanceId + '"]');
            removeOwned('.ytb-yw-modal-backdrop[' + OWNED_ATTR + '="' + instanceId + '"]');
            restoreFilteredCards();
        }

        function reconcileCollections() {
            if (!isEnabled('ytCollectionsEnabled')) {
                cleanupCollectionsUI();
                return;
            }
            if (isSubscriptionsPage()) ensureCollectionToolbar();
            else removeOwned('#ytb-yw-collection-toolbar[' + OWNED_ATTR + '="' + instanceId + '"]');
            ensureChannelPageAction();
            enhanceChannelCards();
            applyCollectionFilter();
            updateCollectionToolbar();
        }

        function reconcileTranscript() {
            if (!isEnabled('ytTranscriptWorkspace') || !isWatchPage()) {
                cleanupTranscriptUI();
                return;
            }
            ensurePlayerButton();
            if (runtime.workspaceOpen) {
                ensureWorkspace();
                refreshWorkspaceData();
            }
        }

        function reconcile() {
            if (runtime.retired || !runtime.loaded) return;
            if (location.href !== runtime.lastUrl) {
                const oldVideo = runtime.lastUrl;
                runtime.lastUrl = location.href;
                if (oldVideo !== location.href) {
                    runtime.cueSignature = '';
                    runtime.chapterSignature = '';
                    runtime.cues = [];
                    runtime.chapters = [];
                    runtime.nativeAttemptVideo = '';
                    runtime.activeCueIndex = -1;
                    unbindVideo();
                }
            }
            reconcileTranscript();
            reconcileCollections();
        }

        function nodeTouchesRelevantUi(node) {
            const elementNode = node && node.nodeType === 1 ? node : node && node.parentElement;
            if (!elementNode || !elementNode.matches) return false;
            if (elementNode.closest && elementNode.closest('[' + OWNED_ATTR + ']')) return false;
            const selector = [
                '.ytp-right-controls', '.ytp-left-controls', '#secondary-inner',
                ...TRANSCRIPT_SEGMENT_SELECTORS, ...TRANSCRIPT_PANEL_SELECTORS,
                'ytd-macro-markers-list-item-renderer', 'ytd-chapter-renderer',
                'ytd-rich-grid-renderer', VIDEO_CARD_SELECTOR,
                'ytd-c4-tabbed-header-renderer', 'ytd-page-header-renderer'
            ].join(',');
            try {
                return elementNode.matches(selector) || !!elementNode.querySelector(selector) || !!elementNode.closest(selector);
            } catch (e) {
                return true;
            }
        }

        runtime.publicApi = {
            retire,
            reconcile,
            persistCollections,
            getState: () => ({
                settings: Object.assign({}, runtime.settings),
                collections: normalizeCollections(runtime.collections),
                activeCollectionId: runtime.activeCollectionId,
                workspaceOpen: runtime.workspaceOpen
            })
        };

        try {
            document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
            listen(document, TAKEOVER_EVENT, retire, true);
        } catch (e) { /* ignore */ }

        // Remove stale DOM from an instance whose extension context died before
        // it could process the takeover event.
        document.querySelectorAll('[' + OWNED_ATTR + ']').forEach(node => node.remove());
        restoreFilteredCards();

        if (api.storage.onChanged && api.storage.onChanged.addListener) {
            api.storage.onChanged.addListener(onStorageChanged);
        }
        Promise.resolve(api.storage.local.get(STORAGE_KEY)).then(stored => {
            if (runtime.retired) return;
            loadState(stored && stored[STORAGE_KEY]);
            runtime.loaded = true;
            reconcile();
            if (!document.body) return;
            runtime.observer = new MutationObserver(records => {
                if (records.some(record => [...record.addedNodes, ...record.removedNodes]
                    .some(nodeTouchesRelevantUi))) scheduleReconcile(80);
            });
            runtime.observer.observe(document.body, { childList: true, subtree: true });
        }).catch(error => {
            console.warn('[YTB workspace] Could not load settings:', error);
            runtime.loaded = true;
            reconcile();
        });

        listen(document, 'ytb-workspace-action', onWorkspaceAction, true);
        listen(document, 'yt-navigate-start', () => scheduleReconcile(0), true);
        listen(document, 'yt-navigate-finish', () => scheduleReconcile(50), true);
        listen(document, 'yt-page-data-updated', () => scheduleReconcile(50), true);
        listen(window, 'popstate', () => scheduleReconcile(0));
        runtime.urlTimer = setInterval(() => {
            if (runtime.retired) return;
            const transcriptExpected = isEnabled('ytTranscriptWorkspace') && isWatchPage();
            const collectionsExpected = isEnabled('ytCollectionsEnabled');
            const playerMissing = transcriptExpected &&
                !document.querySelector('#ytb-yw-player-button[' + OWNED_ATTR + '="' + instanceId + '"]');
            const workspaceMissing = runtime.workspaceOpen &&
                !document.querySelector('#ytb-yw-workspace[' + OWNED_ATTR + '="' + instanceId + '"]');
            const toolbarMissing = collectionsExpected && isSubscriptionsPage() &&
                !document.querySelector('#ytb-yw-collection-toolbar[' + OWNED_ATTR + '="' + instanceId + '"]');
            const channelActionMissing = collectionsExpected && isChannelPage() &&
                !document.querySelector('#ytb-yw-channel-add[' + OWNED_ATTR + '="' + instanceId + '"]');
            if (location.href !== runtime.lastUrl || playerMissing || workspaceMissing ||
                toolbarMissing || channelActionMissing) scheduleReconcile(0);
        }, 750);

        return runtime.publicApi;
    }

    return {
        DEFAULT_FLAGS,
        LIMITS,
        parseTimestamp,
        parseTimeFromHref,
        formatTimestamp,
        normalizeTranscriptCues,
        searchTranscript,
        findActiveCueIndex,
        formatTranscriptText,
        parseTranscriptDom,
        normalizeChapters,
        chapterTarget,
        parseChaptersFromDOM,
        parseChannelFromHref,
        normalizeChannelIdentity,
        channelIdentityKey,
        sameChannelIdentity,
        normalizeCollections,
        collectionIncludesChannel,
        collectionViewIncludesChannel,
        serializeCollectionsJSON,
        parseCollectionsJSON,
        serializeCollectionsCSV,
        parseCollectionsCSV,
        install
    };
});
