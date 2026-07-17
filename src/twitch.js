/* ==================================================================
 * Twitch side of the extension — content script for www.twitch.tv
 * (and clips.twitch.tv, where it only records freshly-created clips).
 *
 * Responsibilities:
 *   - Hide stream/category cards for blocked channels, blocked
 *     categories and blocked title keywords (front page shelves,
 *     directory grids, side nav)                                  [lists]
 *   - Hide + pause the front-page auto-playing carousel           [setting]
 *   - Auto-click the channel-points "Claim Bonus" button          [setting]
 *   - Visually hide the chat column (kept in the DOM so points
 *     keep accruing and claiming keeps working)                   [setting]
 *   - On-player Clip button + "share last clip to chat"           [setting]
 *   - Pin new streams to source quality via Twitch's own
 *     localStorage flags                                          [setting]
 *   - Hide extension overlays/dock on the player                  [setting]
 *
 * State lives in browser.storage.local under the key "data",
 * shared with the popup / options pages (see common.js).
 *
 * Selector notes (verified live 2026-07): stream cards are <article>
 * elements whose grid cell is the nearest `.tw-tower > *` ancestor;
 * the carousel is [data-a-target="front-page-carousel"]; the clip
 * button lost its data-a-target and is matched by its aria-label;
 * quality is pinned with localStorage "video-quality-highest-available"
 * + a fresh "s-qs-ts" timestamp; chat text is inserted through the
 * Slate editor found on the chat input's React fiber (synthetic
 * paste/beforeinput events are ignored by Slate). Chromium content
 * scripts cannot see page-world objects like the fiber, so that work
 * is relayed to src/page-twitch.js (a MAIN-world script) by
 * postMessage — see the "page bridge" helpers below.
 * ================================================================== */
(function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const STORAGE_KEY = 'data';
    const IS_CLIPS_HOST = location.hostname === 'clips.twitch.tv';
    const IS_MOBILE = location.hostname === 'm.twitch.tv';

    // Same orphaned-instance guard as the YouTube content script: on an
    // in-place extension update the old script keeps its DOM listeners but
    // loses API access, so a fresh instance tells older ones to stand down.
    const TAKEOVER_EVENT = 'ytbtw-instance-takeover';
    let retired = false;

    const DEFAULT_SETTINGS = {
        twEnabled: true,
        twAutoClaim: true,
        twAutoClaimDrops: true,
        twAutoClaimMoments: true,
        twAnonChat: false,
        twEmotes: false,
        twHideCarousel: true,
        twHideChat: false,
        twClipHelper: true,
        twClipDownload: true,
        twCinemaButton: true,
        twMaxQuality: true,
        twHideExtensions: false,
        twChatLineLimit: 0,
        twChatBatchMs: 0,
        twSmoothScrollMs: 0,
        twVolumeBoost: 1,
        twHideReruns: false,
        twAltShading: false,
        twShowDeleted: false,
        twTabComplete: true,
        twCompressorButton: true,
        twCompressorOn: false,
        twShotButton: true,
        twSpeedHotkeys: true,
        twUptime: true,
        twHoverPreviews: true,
        twPlayerRecovery: true,
        twSidebarTools: true,
        twChatOverlayButton: true
    };

    /* ==================================================================
     * Anonymous chat: Twitch's chat websocket authenticates with
     * "PASS oauth:…" + "NICK <login>"; rewriting those to the anonymous
     * justinfan login keeps you out of the viewer list (chat becomes
     * read-only). Settings load is async, so the toggle is mirrored into
     * page localStorage (key below, written in applyConfig) and read back
     * synchronously by src/page-twitch.js, which runs in the page's MAIN
     * world at document_start and patches WebSocket.prototype.send there —
     * the page's WebSocket is out of reach from this isolated world.
     * ================================================================== */
    const ANON_LS_KEY = 'ytbtw-anon';

    /* ---- live state ------------------------------------------------ */
    let state = {
        twitchBlockedChannels: [],
        twitchBlockedCategories: [],
        twitchBlockedKeywords: [],
        twitchBlockedTags: [],
        twitchHighlightKeywords: [],
        twitchChatBlockKeywords: [],
        twitchChatBlockUsers: [],
        inputBindings: {},
        settings: Object.assign({}, DEFAULT_SETTINGS)
    };
    let settings = Object.assign({}, DEFAULT_SETTINGS);
    let sharedInputActionsEnabled = false;
    let blockedLogins = new Set();
    let blockedChanNames = new Set();
    let blockedCatSlugs = new Set();
    let blockedCatNames = new Set();
    let blockedTagNames = new Set();
    let keywordMatchers = [];
    let highlightMatchers = [];
    let chatBlockMatchers = [];
    let chatBlockUsers = new Set();
    let chatCfgVersion = 0;
    let lastSerialized = '';
    let lastContextTarget = null;
    let lastClaimAt = 0;
    let rawStorageData = {};
    let twitchExperience = null;
    let filterConfigVersion = 0;
    let articleCache = new WeakMap();
    let categoryCardCache = new WeakMap();
    let sideNavCache = new WeakMap();
    const cardRecoveryQueue = new Set();
    let mainObserver = null;
    let maintenanceTimer = null;
    const lifecycleIntervals = new Set();

    const TWITCH_CARD_SELECTOR =
        'article, a[data-a-target="tw-box-art-card-link"], .side-nav-card';
    const CARD_MUTATION_LIMIT = 1500;
    const CARD_RECOVERY_LIMIT = 60;

    // Single-segment paths that are twitch pages, not channel logins.
    const RESERVED_PATHS = new Set([
        'directory', 'videos', 'downloads', 'p', 'search', 'settings',
        'friends', 'subscriptions', 'inventory', 'wallet', 'drops',
        'prime', 'turbo', 'jobs', 'store', 'following', 'moderator',
        'popout', 'embed', 'team', 'collections', 'activity'
    ]);

    const CHANNEL_HREF_RE = /^\/([A-Za-z0-9_]{2,25})\/?$/;
    const CATEGORY_HREF_RE = /^\/directory\/(?:category|game)\/([^/?#]+)/;

    function loginFromHref(href) {
        const m = (href || '').match(CHANNEL_HREF_RE);
        if (!m) return null;
        const login = m[1].toLowerCase();
        return RESERVED_PATHS.has(login) ? null : login;
    }

    function catSlugFromHref(href) {
        const m = (href || '').match(CATEGORY_HREF_RE);
        if (!m) return null;
        try { return decodeURIComponent(m[1]).toLowerCase(); }
        catch (e) { return m[1].toLowerCase(); }
    }

    /* ==================================================================
     * 0. State load / derive
     * ================================================================== */
    function cleanList(arr) {
        return Array.isArray(arr)
            ? [...new Set(arr.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim()))]
            : [];
    }

    function normalize(d) {
        d = d || {};
        return {
            twitchBlockedChannels: Array.isArray(d.twitchBlockedChannels)
                ? d.twitchBlockedChannels.filter(c => c && (c.login || c.name))
                : [],
            twitchBlockedCategories: Array.isArray(d.twitchBlockedCategories)
                ? d.twitchBlockedCategories.filter(c => c && (c.slug || c.name))
                : [],
            twitchBlockedKeywords: cleanList(d.twitchBlockedKeywords),
            twitchBlockedTags: cleanList(d.twitchBlockedTags),
            twitchHighlightKeywords: cleanList(d.twitchHighlightKeywords),
            twitchChatBlockKeywords: cleanList(d.twitchChatBlockKeywords),
            twitchChatBlockUsers: cleanList(d.twitchChatBlockUsers).map(u => u.toLowerCase()),
            inputBindings: d.inputBindings && typeof d.inputBindings === 'object'
                ? d.inputBindings : {},
            settings: Object.assign({}, DEFAULT_SETTINGS, d.settings || {})
        };
    }

    // Same keyword syntax as the YouTube side: plain case-insensitive
    // substrings, or /pattern/flags. Bad regexes fall back to substring.
    function compileMatcherList(list) {
        const out = [];
        for (const k of list) {
            const m = k.match(/^\/(.+)\/([a-z]*)$/i);
            if (m) {
                try {
                    const re = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i');
                    out.push(t => re.test(t));
                    continue;
                } catch (e) { /* fall through to substring */ }
            }
            const needle = k.toLowerCase();
            out.push(t => t.includes(needle));
        }
        return out;
    }

    function compileKeywords() {
        keywordMatchers = compileMatcherList(state.twitchBlockedKeywords);
        highlightMatchers = compileMatcherList(state.twitchHighlightKeywords);
        chatBlockMatchers = compileMatcherList(state.twitchChatBlockKeywords);
        chatBlockUsers = new Set(state.twitchChatBlockUsers);
        chatCfgVersion++;
    }

    function rebuildDerived() {
        settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
        sharedInputActionsEnabled = typeof YTBFeatures !== 'undefined' &&
            YTBFeatures.normalizeInputBindings(state.inputBindings).twitch.enabled;
        filterConfigVersion++;
        articleCache = new WeakMap();
        categoryCardCache = new WeakMap();
        sideNavCache = new WeakMap();
        cardRecoveryQueue.clear();
        blockedLogins = new Set();
        blockedChanNames = new Set();
        for (const c of state.twitchBlockedChannels) {
            if (c.login) blockedLogins.add(c.login.toLowerCase());
            if (c.name) blockedChanNames.add(c.name.toLowerCase().trim());
        }
        blockedCatSlugs = new Set();
        blockedCatNames = new Set();
        for (const c of state.twitchBlockedCategories) {
            if (c.slug) blockedCatSlugs.add(c.slug.toLowerCase());
            if (c.name) blockedCatNames.add(c.name.toLowerCase().trim());
        }
        blockedTagNames = new Set(state.twitchBlockedTags.map(t => t.toLowerCase()));
        compileKeywords();
        const on = settings.twEnabled;
        applyCss('ytbtw-carousel-style', on && settings.twHideCarousel,
            '[data-a-target="front-page-carousel"], .front-page-carousel { display: none !important; }');
        // Alternating chat line shading (pure CSS; Twitch flags light theme
        // with a class on <html>, dark is the default).
        applyCss('ytbtw-altshade-style', on && settings.twAltShading,
            'html:not(.tw-root--theme-light) .chat-scrollable-area__message-container > div:nth-child(even) { background: rgba(255,255,255,0.05); }' +
            'html.tw-root--theme-light .chat-scrollable-area__message-container > div:nth-child(even) { background: rgba(0,0,0,0.05); }');
        applyCss('ytbtw-chat-style', on && settings.twHideChat,
            '.channel-root__right-column { display: none !important; }');
        applyCss('ytbtw-ext-style', on && settings.twHideExtensions,
            '.extensions-video-overlay-size-container, .extensions-dock__layout, .extensions-notifications { display: none !important; }');
        applyQualityPin();
        // Mirror the anonymous-chat toggle into page localStorage so the
        // synchronous boot shim can read it on the NEXT page load.
        try {
            if (on && settings.twAnonChat) localStorage.setItem(ANON_LS_KEY, '1');
            else localStorage.removeItem(ANON_LS_KEY);
        } catch (e) { /* ignore */ }
        // Chat / extension hiding changes the layout; let the player re-measure.
        try { window.dispatchEvent(new Event('resize')); } catch (e) { /* ignore */ }
    }

    async function persist() {
        // Load-merge-save: this script only owns the twitch lists, so pull the
        // full record first rather than clobbering the YouTube side.
        try {
            const stored = await api.storage.local.get(STORAGE_KEY);
            const full = stored[STORAGE_KEY] || {};
            full.twitchBlockedChannels = state.twitchBlockedChannels;
            full.twitchBlockedCategories = state.twitchBlockedCategories;
            full.twitchBlockedKeywords = state.twitchBlockedKeywords;
            full.settings = Object.assign({}, full.settings, state.settings);
            lastSerialized = JSON.stringify(normalize(full));
            rawStorageData = full;
            if (twitchExperience) twitchExperience.updateState(rawStorageData);
            await api.storage.local.set({ [STORAGE_KEY]: full });
        } catch (e) {
            console.warn('[YT/Twitch Enhancer] Could not persist:', e);
        }
        rebuildDerived();
        runAll();
    }

    function applyCss(id, on, css) {
        let s = document.getElementById(id);
        if (on) {
            if (!s) {
                s = document.createElement('style');
                s.id = id;
                (document.head || document.documentElement).appendChild(s);
            }
            s.textContent = css;
        } else if (s) {
            s.remove();
        }
    }

    /* ==================================================================
     * 1. Max-quality pin
     * Twitch reads these localStorage keys when the player starts
     * (verified live: the "highest available" flag + a fresh s-qs-ts
     * timestamp select Source even without a video-quality entry).
     * ================================================================== */
    const PIN_MARKER = 'ytbtw-quality-pinned';
    function applyQualityPin() {
        if (IS_CLIPS_HOST) return;
        try {
            if (settings.twEnabled && settings.twMaxQuality) {
                localStorage.setItem('video-quality-highest-available', 'true');
                localStorage.setItem('s-qs-ts', String(Date.now()));
                localStorage.setItem(PIN_MARKER, '1');
            } else if (localStorage.getItem(PIN_MARKER)) {
                // Only undo what we set ourselves.
                localStorage.removeItem('video-quality-highest-available');
                localStorage.removeItem(PIN_MARKER);
            }
        } catch (e) { /* storage blocked; nothing to do */ }
    }

    /* ==================================================================
     * 2. Card hiding (channels / categories / keywords)
     * ================================================================== */
    function cellOf(el) {
        // The grid cell is the nearest direct child of a .tw-tower (front
        // page shelves and directory grids both use towers).
        return el.closest('.tw-tower > *') || null;
    }

    function setHidden(cell, hide) {
        if (!cell) return;
        if (hide) cell.classList.add('ytbtw-removed');
        else cell.classList.remove('ytbtw-removed');
    }

    function articleBlocked(art) {
        // Channel: first single-segment link is the channel.
        for (const a of art.querySelectorAll('a[href]')) {
            const login = loginFromHref(a.getAttribute('href'));
            if (login) {
                if (blockedLogins.has(login)) return true;
                break;
            }
        }
        // Category: the card's category link.
        const catLink = art.querySelector('a[href^="/directory/category/"], a[href^="/directory/game/"]');
        if (catLink) {
            const slug = catSlugFromHref(catLink.getAttribute('href'));
            if (slug && blockedCatSlugs.has(slug)) return true;
            const catText = (catLink.textContent || '').toLowerCase().trim();
            if (catText && blockedCatNames.has(catText)) return true;
        }
        // Title keywords.
        if (keywordMatchers.length) {
            const titleEl = art.querySelector('h4[title], h3[title], h4, h3');
            const text = ((titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || '').toLowerCase();
            if (text && keywordMatchers.some(fn => fn(text))) return true;
        }
        // Tags: freeform tag pills on the card (several markup generations).
        if (blockedTagNames.size) {
            for (const tag of art.querySelectorAll(
                'button[data-a-target="tag"], .tw-tag, a[href*="/directory/all/tags/"], [class*="tag-button" i]')) {
                const t = (tag.textContent || '').toLowerCase().trim();
                if (t && blockedTagNames.has(t)) return true;
            }
        }
        // Reruns: the corner status badge reads "Rerun" on rebroadcasts.
        if (settings.twHideReruns) {
            for (const b of art.querySelectorAll(
                '[data-a-target*="rerun" i], [data-test-selector*="rerun" i], ' +
                '.stream-type-indicator--rerun, [class*="status-text-indicator" i], ' +
                '[class*="stream-type-indicator" i], [class*="media-card-stat" i]')) {
                if (/rerun/i.test((b.getAttribute && (b.getAttribute('data-a-target') ||
                        b.getAttribute('data-test-selector'))) || '') ||
                    /^\s*rerun\s*$/i.test(b.textContent || '') ||
                    /rerun/i.test(String(b.className))) return true;
            }
        }
        // Display-name fallback for entries matched by name only.
        if (blockedChanNames.size) {
            for (const p of art.querySelectorAll('p')) {
                const t = (p.textContent || '').toLowerCase().trim();
                if (t && t.length <= 30 && blockedChanNames.has(t)) return true;
            }
        }
        return false;
    }

    function articleIdentity(art) {
        let login = '';
        let channelHref = '';
        for (const anchor of art.querySelectorAll('a[href]')) {
            const href = anchor.getAttribute('href') || '';
            const candidate = loginFromHref(href);
            if (candidate) {
                login = candidate;
                channelHref = href;
                break;
            }
        }
        const category = art.querySelector(
            'a[href^="/directory/category/"], a[href^="/directory/game/"]'
        );
        const categoryHref = category && category.getAttribute('href') || '';
        const categoryText = category && (category.textContent || '').trim().toLowerCase() || '';
        const titleNode = art.querySelector('h4[title], h3[title], h4, h3');
        const title = titleNode &&
            (titleNode.getAttribute('title') || titleNode.textContent || '').trim().toLowerCase() || '';
        let tags = '';
        if (blockedTagNames.size) {
            tags = [...art.querySelectorAll(
                'button[data-a-target="tag"], .tw-tag, a[href*="/directory/all/tags/"], ' +
                '[class*="tag-button" i]'
            )].map(tag => (tag.textContent || '').trim().toLowerCase()).join('|');
        }
        let names = '';
        if (blockedChanNames.size) {
            names = [...art.querySelectorAll('p')]
                .map(node => (node.textContent || '').trim().toLowerCase())
                .filter(text => text && text.length <= 30).join('|');
        }
        let rerun = '';
        if (settings.twHideReruns) {
            rerun = [...art.querySelectorAll(
                '[data-a-target*="rerun" i], [data-test-selector*="rerun" i], ' +
                '.stream-type-indicator--rerun, [class*="status-text-indicator" i], ' +
                '[class*="stream-type-indicator" i], [class*="media-card-stat" i]'
            )].map(node => String(node.className) + ':' + (node.textContent || '').trim()).join('|');
        }
        return {
            key: [channelHref, login, categoryHref, categoryText, title, tags, names, rerun].join('\u001f'),
            complete: !!(login || categoryHref || title)
        };
    }

    function processArticle(art, force) {
        if (!art || art.isConnected === false) return;
        const identity = articleIdentity(art);
        const cached = articleCache.get(art);
        let hide;
        if (!force && cached && cached.version === filterConfigVersion &&
                cached.identity === identity.key) {
            hide = cached.hide;
        } else {
            hide = articleBlocked(art);
            articleCache.set(art, {
                version: filterConfigVersion,
                identity: identity.key,
                hide
            });
        }
        setHidden(cellOf(art) || art, hide);
        if (identity.complete) cardRecoveryQueue.delete(art);
        else cardRecoveryQueue.add(art);
    }

    function processCategoryCard(link, force) {
        if (!link || link.isConnected === false) return;
        const href = link.getAttribute('href') || '';
        const cached = categoryCardCache.get(link);
        let hide;
        if (!force && cached && cached.version === filterConfigVersion && cached.href === href) {
            hide = cached.hide;
        } else {
            const slug = catSlugFromHref(href);
            hide = !!(slug && blockedCatSlugs.has(slug));
            categoryCardCache.set(link, { version: filterConfigVersion, href, hide });
        }
        setHidden(cellOf(link) || link.closest('.game-card'), hide);
        if (href) cardRecoveryQueue.delete(link);
        else cardRecoveryQueue.add(link);
    }

    function processSideNavCard(card, force) {
        if (!card || card.isConnected === false) return;
        const anchor = card.matches('a[href]') ? card : card.querySelector('a[href]');
        const href = anchor && anchor.getAttribute('href') || '';
        const cached = sideNavCache.get(card);
        let hide;
        if (!force && cached && cached.version === filterConfigVersion && cached.href === href) {
            hide = cached.hide;
        } else {
            const login = loginFromHref(href);
            const slug = catSlugFromHref(href);
            hide = !!((login && blockedLogins.has(login)) ||
                (slug && blockedCatSlugs.has(slug)));
            sideNavCache.set(card, { version: filterConfigVersion, href, hide });
        }
        const wrap = card.closest('.tw-transition') || card;
        setHidden(wrap, hide);
        if (href) cardRecoveryQueue.delete(card);
        else cardRecoveryQueue.add(card);
    }

    function processCardElement(element, force) {
        if (!element || !element.matches) return;
        if (element.matches('article')) processArticle(element, force);
        else if (element.matches('a[data-a-target="tw-box-art-card-link"]')) {
            processCategoryCard(element, force);
        } else if (element.matches('.side-nav-card')) {
            processSideNavCard(element, force);
        }
    }

    function cardElementsIn(root) {
        const elements = new Set();
        if (!root) return elements;
        const element = root.nodeType === 1 || root.nodeType === 9
            ? root : root.parentElement;
        if (!element) return elements;
        try {
            if (element.matches && element.matches(TWITCH_CARD_SELECTOR)) elements.add(element);
            if (element.querySelectorAll) {
                for (const match of element.querySelectorAll(TWITCH_CARD_SELECTOR)) {
                    elements.add(match);
                }
            }
        } catch (e) { /* Twitch may replace the subtree while it is queried */ }
        return elements;
    }

    function scanCards(root, force) {
        for (const element of cardElementsIn(root || document)) {
            processCardElement(element, force !== false);
        }
    }

    function addMutationCard(set, node, includeDescendants) {
        if (set.size >= CARD_MUTATION_LIMIT) return;
        const element = node && (node.nodeType === 1 ? node : node.parentElement);
        if (!element) return;
        try {
            if (element.matches && element.matches(TWITCH_CARD_SELECTOR)) set.add(element);
            const closest = element.closest && element.closest(TWITCH_CARD_SELECTOR);
            if (closest) set.add(closest);
            if (!includeDescendants || !element.querySelectorAll) return;
            for (const match of element.querySelectorAll(TWITCH_CARD_SELECTOR)) {
                set.add(match);
                if (set.size >= CARD_MUTATION_LIMIT) break;
            }
        } catch (e) { /* detached/recycled node */ }
    }

    function collectDirtyCardElements(records) {
        const experienceModule = typeof globalThis !== 'undefined' &&
            globalThis.YTBTW_TWITCH_EXPERIENCE;
        if (experienceModule && typeof experienceModule.collectMutationElements === 'function') {
            return experienceModule.collectMutationElements(
                records, TWITCH_CARD_SELECTOR, CARD_MUTATION_LIMIT
            );
        }
        const dirty = new Set();
        for (const record of records || []) {
            if (!record) continue;
            // A child-list target can be document.body. Only its nearest card
            // is relevant; descendants are collected from newly inserted roots.
            addMutationCard(dirty, record.target, false);
            if (record.type === 'childList') {
                for (const node of record.addedNodes || []) {
                    addMutationCard(dirty, node, true);
                    if (dirty.size >= CARD_MUTATION_LIMIT) break;
                }
            }
            if (dirty.size >= CARD_MUTATION_LIMIT) break;
        }
        return dirty;
    }

    function processCardMutations(records) {
        const experienceModule = typeof globalThis !== 'undefined' &&
            globalThis.YTBTW_TWITCH_EXPERIENCE;
        if (experienceModule && typeof experienceModule.processMutationElements === 'function') {
            return experienceModule.processMutationElements(
                records,
                TWITCH_CARD_SELECTOR,
                CARD_MUTATION_LIMIT,
                element => processCardElement(element, false)
            );
        }
        const dirty = collectDirtyCardElements(records);
        for (const element of dirty) processCardElement(element, false);
        return dirty;
    }

    function processCardRecovery(limit) {
        let remaining = Math.max(1, Number(limit) || CARD_RECOVERY_LIMIT);
        for (const element of [...cardRecoveryQueue]) {
            if (remaining-- <= 0) break;
            cardRecoveryQueue.delete(element);
            if (element && element.isConnected !== false) processCardElement(element, true);
        }
    }

    function unhideAll() {
        document.querySelectorAll('.ytbtw-removed').forEach(el => el.classList.remove('ytbtw-removed'));
    }

    /* ==================================================================
     * 3. Carousel pause (the CSS hides it; also stop it downloading/playing)
     * ================================================================== */
    function pauseCarousel() {
        if (!settings.twEnabled || !settings.twHideCarousel) return;
        document.querySelectorAll('[data-a-target="front-page-carousel"] video, .front-page-carousel video')
            .forEach(v => { try { if (!v.paused) v.pause(); } catch (e) { /* ignore */ } });
    }

    /* ==================================================================
     * 4. Auto-claim channel points
     * The claim button appears inside the community-points summary in the
     * chat input area (also matched globally by aria-label as a fallback).
     * Chat hidden via our CSS keeps this in the DOM, so claiming still works.
     * ================================================================== */
    function autoClaim() {
        if (!settings.twEnabled || !settings.twAutoClaim) return;
        if (Date.now() - lastClaimAt < 5000) return;   // debounce double-fires
        const hit = document.querySelector(
            '[data-test-selector="community-points-summary"] .claimable-bonus__icon, ' +
            '[data-test-selector="community-points-summary"] [data-test-selector*="claim" i], ' +
            '[data-test-selector="community-points-summary"] [data-a-target*="claim" i], ' +
            '[data-test-selector="community-points-summary"] button[aria-label*="Claim"], ' +
            'button[aria-label*="Claim Bonus"], .claimable-bonus__icon'
        );
        if (!hit) return;
        const btn = hit.closest('button') || hit;
        try {
            btn.click();
            lastClaimAt = Date.now();
            toast('Claimed channel points', '+bonus');
        } catch (e) { /* ignore */ }
    }

    /* ---- drops & moments --------------------------------------------
     * Drops are the awkward one. Verified live 2026-07: a completed drop
     * shows an in-chat callout and a pink dot on the Drops button, but the
     * green "Claim" in the drops popover is only an <a href="/drops/
     * inventory"> — the real claim happens on the inventory page, whose
     * claim control is a styled <a> ("Claim"), not a button. So a stream
     * page can never claim in place.
     *
     * Hands-free approach: when a drop looks claimable and we're NOT on the
     * inventory page, ask the background script to open /drops/inventory in
     * a background (inactive) tab; that tab's own instance claims and then
     * closes itself. The stream you're watching is never touched.
     * ================================================================== */
    const IS_INVENTORY = !IS_CLIPS_HOST && !IS_MOBILE &&
        location.pathname.startsWith('/drops/inventory');
    const AUTOCLAIM_HASH = '#ytbtw-autoclaim';
    let lastMomentClaimAt = 0;
    let lastBgClaimAt = 0;
    let dropWasClaimable = false;
    let inventoryCloseArmed = false;

    // Claim every "Claim" control on the current inventory page (styled <a>
    // or <button>, exact text, not disabled). Returns how many were clicked.
    function claimInventoryHere() {
        const els = [...document.querySelectorAll(
            'main a[data-a-target*="claim" i], main button[data-a-target*="claim" i], ' +
            'main a[data-test-selector*="claim" i], main button[data-test-selector*="claim" i], ' +
            'a.ScCoreButton-sc-ocjdkq-0, main a, main button'
        )].filter(b => {
            const stable = ((b.getAttribute('data-a-target') || '') + ' ' +
                (b.getAttribute('data-test-selector') || '')).toLowerCase().includes('claim');
            return (stable || /^claim$/i.test((b.textContent || '').trim())) && !b.disabled &&
                b.getAttribute('href') !== '/drops/inventory';
        });
        let n = 0;
        for (const el of els) { try { el.click(); n++; } catch (e) { /* ignore */ } }
        return n;
    }

    function dropsClaimable() {
        // The in-chat "drop ready" callout.
        if (document.querySelector(
            '[data-test-selector="chat-private-callout-queue__callout-container"] [aria-label="Open Drop reward"], ' +
            '[aria-label="Open Drop reward"]')) return true;
        // The pink notification dot beside the Drops button: an "indicator"
        // element in the button's wrapper (absent when nothing is due —
        // verified live 2026-07: class "…indicatorPositioning…").
        const db = document.querySelector('button[data-a-target="drops-button"]');
        const wrap = db && db.parentElement;
        if (wrap) {
            const dot = [...wrap.children].find(c =>
                c !== db && !c.contains(db) && /indicator/i.test(String(c.className)) && c.getClientRects().length);
            if (dot) return true;
        }
        return false;
    }

    function autoClaimDrops() {
        if (!settings.twEnabled || !settings.twAutoClaimDrops) return;
        if (IS_INVENTORY) {
            const n = claimInventoryHere();
            if (n) toast('Claimed drop', '');
            // If we were opened purely to auto-claim, close once we've had a
            // moment to fire the click(s) and let the request go out.
            if (inventoryCloseArmed) {
                inventoryCloseArmed = false;
                setTimeout(() => api.runtime.sendMessage({ action: 'ytbtw-close-self' }).catch(() => {}), 6000);
            }
            return;
        }
        // Non-inventory page: trigger a background claim. Twitch leaves the
        // indicator dot up until the page is refreshed, even after the drop
        // is claimed, so fire on the RISING edge (drop newly appeared) and,
        // while the dot lingers, only re-check every 15 min — otherwise we'd
        // reopen the inventory tab every few minutes for nothing.
        const claimable = dropsClaimable();
        const rising = claimable && !dropWasClaimable;
        dropWasClaimable = claimable;
        if (!claimable) return;
        const since = Date.now() - lastBgClaimAt;
        if (rising ? since < 30000 : since < 900000) return;
        lastBgClaimAt = Date.now();
        api.runtime.sendMessage({ action: 'ytbtw-claim-drops' }).catch(() => {});
    }

    function autoClaimMoments() {
        if (!settings.twEnabled || !settings.twAutoClaimMoments) return;
        if (Date.now() - lastMomentClaimAt < 5000) return;
        const hit = document.querySelector(
            '[data-test-selector*="moment" i] [data-test-selector*="claim" i], ' +
            '[data-test-selector*="moment" i] [data-a-target*="claim" i], ' +
            '[data-a-target*="moment" i][data-a-target*="claim" i], ' +
            'button[aria-label*="Claim Moment"], [data-test-selector*="moment" i] button[aria-label*="Claim"]'
        );
        if (!hit) return;
        try {
            hit.click();
            lastMomentClaimAt = Date.now();
            toast('Claimed Moment', '');
        } catch (e) { /* ignore */ }
    }

    function runClaims() {
        autoClaim();
        autoClaimDrops();
        autoClaimMoments();
    }

    /* ==================================================================
     * 5. Clip helper: on-player buttons + share-last-clip-to-chat
     * ================================================================== */
    const CLIP_INTENT_KEY = 'twClipIntentAt';
    const LAST_CLIP_KEY = 'twLastClip';
    const CLIP_FRESH_MS = 30 * 60 * 1000;

    function nativeClipButton() {
        return document.querySelector(
            'button[data-a-target="player-clip-button"], ' +
            '.video-player__container button[aria-label*="alt+x" i], ' +
            '.video-player__container button[aria-label^="Clip"]'
        );
    }

    function ensureClipBar() {
        const container = document.querySelector('.video-player__container');
        const existing = document.getElementById('ytbtw-clipbar');
        // Twitch now shows its own Clip button inline in the player controls,
        // so ours would be a duplicate: the bar only carries Share + Cinema.
        // Clip intent is recorded by watching the NATIVE button (see below).
        const wantShare = settings.twClipHelper && nativeClipButton();
        const wantCinema = settings.twCinemaButton;
        const wantComp = settings.twCompressorButton;
        const wantShot = settings.twShotButton;
        const want = settings.twEnabled && container;
        if (!want) {
            if (existing) existing.remove();
            return;
        }
        // Rebuild when the container or the wanted button set changed.
        // The ⚙ settings shortcut is always present while Twitch features
        // are on, so the extension's Twitch page is one click away.
        const key = (wantShare ? 's' : '') + (wantCinema ? 'd' : '') +
                    (wantComp ? 'c' : '') + (wantShot ? 'p' : '') + 'g';
        if (existing && container.contains(existing) && existing.dataset.ytbtwKey === key) {
            const cb = existing.querySelector('.ytbtw-comp-btn');
            if (cb) cb.classList.toggle('ytbtw-active', !!settings.twCompressorOn);
            return;
        }
        if (existing) existing.remove();
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        const bar = document.createElement('div');
        bar.id = 'ytbtw-clipbar';
        bar.dataset.ytbtwKey = key;
        if (wantShare) {
            const shareBtn = document.createElement('button');
            shareBtn.textContent = '➤ Share clip';
            shareBtn.title = 'Paste your most recent clip into chat and send it';
            shareBtn.addEventListener('click', onShareClick);
            bar.appendChild(shareBtn);
        }
        if (wantCinema) {
            const cinemaBtn = document.createElement('button');
            cinemaBtn.textContent = '◐ Cinema';
            cinemaBtn.title = 'Darken everything around the player (Esc or click the dark area to exit)';
            cinemaBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleCinema();
            });
            bar.appendChild(cinemaBtn);
        }
        if (wantComp) {
            const compBtn = document.createElement('button');
            compBtn.className = 'ytbtw-comp-btn';
            compBtn.textContent = '🎚 Comp';
            compBtn.title = 'Audio compressor — evens out quiet voices and loud game audio';
            compBtn.classList.toggle('ytbtw-active', !!settings.twCompressorOn);
            compBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const next = !settings.twCompressorOn;
                setTwCompressor(next, true);
                compBtn.classList.toggle('ytbtw-active', next);
                toast(next ? 'Compressor on' : 'Compressor off', '');
            });
            bar.appendChild(compBtn);
        }
        if (wantShot) {
            const shotBtn = document.createElement('button');
            shotBtn.textContent = '📷';
            shotBtn.title = 'Save a screenshot of the current frame (PNG)';
            shotBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                takeScreenshot();
            });
            bar.appendChild(shotBtn);
        }
        const gearBtn = document.createElement('button');
        gearBtn.textContent = '⚙';
        gearBtn.title = 'YouTube/Twitch Enhancer — Twitch settings';
        gearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            api.runtime.sendMessage({ action: 'ytbtw-open-options' }).catch(() => {});
        });
        bar.appendChild(gearBtn);
        container.appendChild(bar);
    }

    /* ---- cinema mode --------------------------------------------------
     * Four dark strips are laid around the player's rectangle instead of
     * one overlay under a raised player: Twitch's .persistent-player
     * ancestor creates a stacking context (transform + z-index), so the
     * player can never be raised above a body-level overlay. Strips need
     * no z-index tricks at all.
     * ------------------------------------------------------------------ */
    let cinemaTimer = null;

    function cinemaTarget() {
        return document.querySelector('.video-player__container');
    }

    function toggleCinema() {
        if (document.getElementById('ytbtw-dim')) exitCinema();
        else enterCinema();
    }

    function enterCinema() {
        if (!document.body || !cinemaTarget()) return;
        const wrap = document.createElement('div');
        wrap.id = 'ytbtw-dim';
        for (let i = 0; i < 4; i++) wrap.appendChild(document.createElement('div'));
        wrap.addEventListener('click', exitCinema);
        document.body.appendChild(wrap);
        updateCinema();
        cinemaTimer = setInterval(updateCinema, 250);
        window.addEventListener('resize', updateCinema);
        document.addEventListener('scroll', updateCinema, true);
        document.addEventListener('keydown', cinemaEscHandler, true);
    }

    function updateCinema() {
        const wrap = document.getElementById('ytbtw-dim');
        if (!wrap) return;
        const p = cinemaTarget();
        if (!p || !p.isConnected) { exitCinema(); return; }
        const r = p.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const t = Math.max(0, r.top), b = Math.min(vh, r.bottom);
        const l = Math.max(0, r.left), rt = Math.min(vw, r.right);
        const [top, bottom, left, right] = wrap.children;
        top.style.cssText = 'left:0;top:0;width:100%;height:' + t + 'px;';
        bottom.style.cssText = 'left:0;top:' + b + 'px;width:100%;height:' + Math.max(0, vh - b) + 'px;';
        left.style.cssText = 'left:0;top:' + t + 'px;width:' + l + 'px;height:' + Math.max(0, b - t) + 'px;';
        right.style.cssText = 'left:' + rt + 'px;top:' + t + 'px;width:' + Math.max(0, vw - rt) + 'px;height:' + Math.max(0, b - t) + 'px;';
    }

    function cinemaEscHandler(e) {
        if (e.key === 'Escape') exitCinema();
    }

    function exitCinema() {
        const wrap = document.getElementById('ytbtw-dim');
        if (wrap) wrap.remove();
        clearInterval(cinemaTimer);
        cinemaTimer = null;
        window.removeEventListener('resize', updateCinema);
        document.removeEventListener('scroll', updateCinema, true);
        document.removeEventListener('keydown', cinemaEscHandler, true);
    }

    // Record clip intent from Twitch's own Clip button (and Alt+X), so the
    // clips.twitch.tv recorder knows the next published clip is the user's.
    function recordClipIntent() {
        api.storage.local.set({ [CLIP_INTENT_KEY]: Date.now() }).catch(() => {});
    }
    document.addEventListener('click', (e) => {
        if (retired || !e.target.closest) return;
        const b = e.target.closest('button[data-a-target="player-clip-button"], ' +
            'button[data-test-selector="clip-button"], button[aria-label*="Clip" i]');
        if (b && !b.closest('#ytbtw-clipbar')) recordClipIntent();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (retired) return;
        if (e.altKey && (e.key === 'x' || e.key === 'X')) recordClipIntent();
    }, true);

    async function onShareClick(e) {
        e.preventDefault();
        e.stopPropagation();
        let clip = null;
        try {
            const r = await api.storage.local.get(LAST_CLIP_KEY);
            clip = r[LAST_CLIP_KEY];
        } catch (err) { /* ignore */ }
        if (!clip || !clip.url || (Date.now() - (clip.at || 0)) > CLIP_FRESH_MS) {
            toast('No recent clip found', 'create one with ✂ Clip first');
            return;
        }
        if (settings.twAnonChat) {
            // Anonymous chat is read-only; the server drops sent messages.
            try {
                await navigator.clipboard.writeText(clip.url);
                toast('Anonymous chat is on — link copied instead', 'disable it to send directly');
            } catch (err) {
                toast('Anonymous chat is on — sending is disabled', clip.url);
            }
            return;
        }
        if (await chatSend(clip.url)) {
            toast('Shared clip to chat', '');
        } else {
            // Fallback: put the link on the clipboard and focus chat.
            try {
                await navigator.clipboard.writeText(clip.url);
                const input = document.querySelector('div[data-a-target="chat-input"]');
                if (input) input.focus();
                toast('Clip link copied', 'press Ctrl+V then Enter in chat');
            } catch (err) {
                toast('Could not reach the chat input', clip.url);
            }
        }
    }

    // Text goes in through the Slate editor on the chat input's React fiber.
    // Synthetic paste / beforeinput / execCommand are all ignored by Slate,
    // and the fiber itself is invisible to Chromium's isolated world — so
    // the editor work happens in src/page-twitch.js (MAIN world) and is
    // requested from here over the page bridge.
    let chatOpSeq = 0;
    function pageChatOp(msg) {
        return new Promise((resolve) => {
            const token = 'ytbtw' + (++chatOpSeq) + '-' + Date.now();
            const timer = setTimeout(() => {
                window.removeEventListener('message', onReply);
                resolve(false);
            }, 500);
            function onReply(e) {
                if (e.source !== window || !e.data || e.data.type !== 'ytbtw-chat-done' || e.data.token !== token) return;
                clearTimeout(timer);
                window.removeEventListener('message', onReply);
                resolve(!!e.data.ok);
            }
            window.addEventListener('message', onReply);
            window.postMessage(Object.assign({ token }, msg), location.origin);
        });
    }

    async function chatInsert(text) {
        const input = document.querySelector('div[data-a-target="chat-input"]');
        if (!input) return false;
        input.focus();
        return pageChatOp({ type: 'ytbtw-chat-insert', text });
    }

    async function chatSend(text) {
        if (!(await chatInsert(text))) return false;
        setTimeout(() => {
            const send = document.querySelector('button[data-a-target="chat-send-button"]');
            if (send) send.click();
        }, 150);
        return true;
    }

    /* ==================================================================
     * 6. clips.twitch.tv: record the clip the user just created.
     * Only runs within a few minutes of our Clip button being pressed, so
     * merely browsing other people's clips never overwrites anything.
     * ================================================================== */
    function clipsRecorderTick() {
        api.storage.local.get([CLIP_INTENT_KEY, LAST_CLIP_KEY]).then(r => {
            const intentAt = r[CLIP_INTENT_KEY] || 0;
            if (Date.now() - intentAt > 10 * 60 * 1000) return;
            let url = null;
            // Published clip page: clips.twitch.tv/<Slug>
            if (/^\/[A-Za-z0-9][\w-]*$/.test(location.pathname) && !location.pathname.startsWith('/create')) {
                url = location.origin + location.pathname;
            }
            // Share panel on the editor: any input carrying the clip URL.
            if (!url) {
                for (const inp of document.querySelectorAll('input')) {
                    const v = inp.value || '';
                    const m = v.match(/https:\/\/(?:clips\.twitch\.tv\/[\w-]+|www\.twitch\.tv\/\w+\/clip\/[\w-]+)/);
                    if (m) { url = m[0]; break; }
                }
            }
            if (!url) return;
            const prev = r[LAST_CLIP_KEY];
            if (prev && prev.url === url) return;
            api.storage.local.set({ [LAST_CLIP_KEY]: { url, at: Date.now() } }).catch(() => {});
        }).catch(() => {});
    }

    /* ==================================================================
     * 6b. Chat engine: third-party emotes + performance tweaks.
     * One MutationObserver on the message container drives everything:
     * emote substitution, line limiting, batched reveal, smooth scroll.
     * (Selectors verified live 2026-07: messages are .chat-line__message,
     * text runs are [data-a-target="chat-message-text"], the scrolling
     * element is the .scrollable-area ancestor.)
     * ================================================================== */
    let chatContainer = null;
    let chatObserver = null;
    let chatObsSubtree = false;
    let pendingReveal = [];
    let batchTimer = null;
    // Original text of every processed chat line, so moderator-deleted
    // messages can be restored readably (twShowDeleted). WeakMap: entries
    // die with their DOM nodes, so the cache can't grow unbounded.
    const chatMsgCache = new WeakMap();
    let lastSweptCfg = -1;

    // token -> { url, title } from BTTV / FFZ / 7TV. All three APIs are
    // fetched through the service worker's fixed, permissioned allowlist;
    // a 404 just means the channel isn't registered with that provider.
    let emoteMap = new Map();
    let emoteChannelId = null;
    let emoteGlobalsLoaded = false;
    let emoteFetchInFlight = false;
    let emoteLastFailAt = 0;

    function chatFiltersWanted() {
        return !!(highlightMatchers.length || chatBlockMatchers.length || chatBlockUsers.size);
    }

    function chatEngineWanted() {
        return settings.twEnabled && !IS_MOBILE &&
            (settings.twEmotes || settings.twChatLineLimit > 0 ||
             settings.twChatBatchMs > 0 || settings.twSmoothScrollMs > 0 ||
             settings.twShowDeleted || chatFiltersWanted());
    }

    function ensureChatEngine() {
        const container = document.querySelector('.chat-scrollable-area__message-container');
        if (!chatEngineWanted() || !container) {
            if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
            revealPending();
            chatContainer = null;
            return;
        }
        // Deleted-message detection needs to see mutations INSIDE lines
        // (Twitch swaps the message body out in place), everything else only
        // needs direct children.
        const wantSubtree = !!settings.twShowDeleted;
        if (container === chatContainer && chatObserver && chatObsSubtree === wantSubtree) return;
        if (chatObserver) chatObserver.disconnect();
        chatContainer = container;
        chatObsSubtree = wantSubtree;
        pendingReveal = [];
        chatObserver = new MutationObserver(onChatMutations);
        chatObserver.observe(container, { childList: true, subtree: wantSubtree });
        if (settings.twEmotes) {
            container.querySelectorAll('.chat-line__message').forEach(m => emoteProcess(m));
        }
        trimChat();
    }

    function chatScroller() {
        let el = chatContainer && chatContainer.parentElement;
        while (el) {
            if (el.scrollHeight > el.clientHeight + 10) return el;
            el = el.parentElement;
        }
        return null;
    }

    function isChatPinned() {
        const sc = chatScroller();
        if (!sc) return true;
        return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 150;
    }

    function onChatMutations(muts) {
        if (retired) return;
        const added = [];    // direct children of the container = new chat lines
        const nested = [];   // deeper additions (only seen in subtree mode)
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (m.target === chatContainer) added.push(n);
                else nested.push(n);
            }
        }
        if (nested.length && settings.twShowDeleted) nested.forEach(checkDeletedMessage);
        if (!added.length) return;
        const pinned = isChatPinned();
        for (const n of added) {
            if (settings.twEmotes) emoteProcess(n);
            chatFilterProcess(n);
            if (settings.twChatBatchMs > 0 && pinned) {
                n.classList.add('ytbtw-chat-pending');
                pendingReveal.push(n);
            }
        }
        if (settings.twChatBatchMs > 0) {
            if (!batchTimer) {
                batchTimer = setTimeout(() => { batchTimer = null; revealPending(); }, settings.twChatBatchMs);
            }
        } else if (settings.twSmoothScrollMs > 0 && pinned) {
            smoothSlide(added);
        }
        trimChat();
    }

    function revealPending() {
        clearTimeout(batchTimer);
        batchTimer = null;
        const nodes = pendingReveal.splice(0);
        if (!nodes.length) return;
        nodes.forEach(n => n.classList.remove('ytbtw-chat-pending'));
        if (settings.twSmoothScrollMs > 0 && isChatPinned()) smoothSlide(nodes);
    }

    // Slide freshly-revealed messages in: the container is offset down by
    // their total height, then animated back to 0. Purely visual, so it
    // never fights Twitch's own scrollTop management.
    function smoothSlide(nodes) {
        const c = chatContainer;
        if (!c) return;
        let h = 0;
        for (const n of nodes) {
            if (n.isConnected && !n.classList.contains('ytbtw-chat-pending')) h += n.offsetHeight || 0;
        }
        if (h <= 0 || h > 300) return;   // skip huge bursts (initial backlog)
        c.style.transition = 'none';
        c.style.transform = 'translateY(' + h + 'px)';
        void c.offsetHeight;
        c.style.transition = 'transform ' + settings.twSmoothScrollMs + 'ms ease-out';
        c.style.transform = 'translateY(0)';
    }

    // Line limit: HIDE old lines instead of removing them — pulling nodes
    // out from under React causes reconciliation errors. Twitch trims its
    // own backlog (~200), so the hidden set stays bounded.
    function trimChat() {
        const limit = settings.twChatLineLimit;
        if (!limit || !chatContainer) return;
        const lines = chatContainer.querySelectorAll('.chat-line__message:not(.ytbtw-chat-trimmed)');
        const excess = lines.length - limit;
        for (let i = 0; i < excess; i++) lines[i].classList.add('ytbtw-chat-trimmed');
    }

    /* ---- chat filters: highlight / block words & users, deleted cache ----
     * Runs on every new chat line (and re-sweeps the backlog when the lists
     * change). Blocked lines are hidden with CSS; highlighted lines get a
     * tinted background and accent border. The message text is also cached
     * for the show-deleted feature.
     * ------------------------------------------------------------------ */
    function chatLineText(msg) {
        let text = '';
        for (const frag of msg.querySelectorAll(
            '[data-a-target="chat-message-text"], img.ytbtw-emote, .chat-line__message--emote')) {
            text += frag.alt ? ' ' + frag.alt + ' ' : (frag.textContent || '');
        }
        return text.trim();
    }

    function chatFilterProcess(node) {
        if (!node.querySelectorAll) return;
        const wantCache = settings.twShowDeleted;
        const wantFilters = chatFiltersWanted();
        if (!wantCache && !wantFilters) return;
        const msgs = (node.matches && node.matches('.chat-line__message'))
            ? [node]
            : [...node.querySelectorAll('.chat-line__message')];
        for (const msg of msgs) {
            const text = chatLineText(msg);
            if (wantCache && text && !chatMsgCache.has(msg)) chatMsgCache.set(msg, text);
            if (!wantFilters) continue;
            if (msg.dataset.ytbtwFiltered === String(chatCfgVersion)) continue;
            msg.dataset.ytbtwFiltered = String(chatCfgVersion);
            msg.classList.remove('ytbtw-chat-blocked', 'ytbtw-chat-highlight');
            const userEl = msg.querySelector('[data-a-target="chat-message-username"]');
            const login = ((userEl && (userEl.getAttribute('data-a-user') || userEl.textContent)) || '')
                .toLowerCase().trim();
            const lower = text.toLowerCase();
            if ((login && chatBlockUsers.has(login)) ||
                (lower && chatBlockMatchers.some(fn => fn(lower)))) {
                msg.classList.add('ytbtw-chat-blocked');
            } else if (lower && highlightMatchers.some(fn => fn(lower))) {
                msg.classList.add('ytbtw-chat-highlight');
            }
        }
    }

    // Re-apply the filters to the visible backlog after a list change.
    function chatFilterSweep() {
        if (!chatContainer || lastSweptCfg === chatCfgVersion) return;
        lastSweptCfg = chatCfgVersion;
        if (!chatFiltersWanted() && !settings.twShowDeleted) return;
        chatContainer.querySelectorAll('.chat-line__message').forEach(m => chatFilterProcess(m));
    }

    // Show-deleted: Twitch swaps a deleted message's body for a "message
    // deleted" notice in place (the line element survives), so the cached
    // text can be re-attached struck-through. Best-effort by nature.
    function checkDeletedMessage(node) {
        try {
            if (!node.closest) return;
            const line = node.closest('.chat-line__message');
            if (!line || line.querySelector('.ytbtw-deleted-restored')) return;
            const stableNotice = node.matches && node.matches(
                '[data-a-target*="deleted" i], [data-test-selector*="deleted" i], ' +
                '[data-a-target*="removed" i], [data-test-selector*="removed" i]'
            ) || node.closest && node.closest(
                '[data-a-target*="deleted" i], [data-test-selector*="deleted" i], ' +
                '[data-a-target*="removed" i], [data-test-selector*="removed" i]'
            );
            const isNotice = stableNotice ||
                /deleted|removed/i.test(String(node.className)) ||
                /message deleted|deleted by|removed by/i.test(node.textContent || '');
            if (!isNotice) return;
            const cached = chatMsgCache.get(line);
            if (!cached) return;
            const span = document.createElement('span');
            span.className = 'ytbtw-deleted-restored';
            span.textContent = ' ' + cached;
            (node.parentElement || line).appendChild(span);
        } catch (e) { /* React may re-render underneath us; never break chat */ }
    }

    /* ---- emote tab-completion -----------------------------------------
     * Tab completes the word being typed against the loaded third-party
     * emote names (channel set first); repeated Tab / Shift+Tab cycles.
     * Twitch's own completion still handles native emotes and @mentions —
     * we only intercept when a third-party name matches. The caret is
     * assumed to sit at the end of the input (where typing puts it).
     * ------------------------------------------------------------------ */
    let tabState = null;
    document.addEventListener('keydown', (e) => {
        if (retired || !settings.twEnabled || !settings.twEmotes || !settings.twTabComplete) return;
        if (!e.target || !e.target.closest) return;
        const input = e.target.closest('div[data-a-target="chat-input"]');
        if (!input) return;
        if (e.key !== 'Tab') { if (e.key !== 'Shift') tabState = null; return; }
        if (!emoteMap.size) return;
        const text = input.textContent || '';
        let st = tabState;
        // The input changed under us (click elsewhere, edits): start fresh.
        if (st && !text.endsWith(st.cands[st.idx])) st = tabState = null;
        if (!st) {
            const m = text.match(/(^|\s)(\S{2,})$/);
            if (!m) return;
            const word = m[2];
            const wl = word.toLowerCase();
            const rank = { channel: 0, global: 1 };
            const cands = [...emoteMap.entries()]
                .filter(([n]) => n.toLowerCase().startsWith(wl) && n !== word)
                .sort((a, b) => (rank[a[1].scope] - rank[b[1].scope]) || a[0].localeCompare(b[0]))
                .map(([n]) => n);
            if (!cands.length) return;   // no third-party match: leave Tab to Twitch
            st = { cands, idx: 0, lastLen: word.length };
        } else {
            st.idx = (st.idx + (e.shiftKey ? st.cands.length - 1 : 1)) % st.cands.length;
        }
        // The Slate ops run in the page world (page-twitch.js); commit the
        // completion optimistically and reset the cycle if the page helper
        // reports the editor was unreachable.
        e.preventDefault();
        e.stopPropagation();
        const name = st.cands[st.idx];
        pageChatOp({ type: 'ytbtw-chat-complete', del: st.lastLen, text: name })
            .then(ok => { if (!ok) tabState = null; });
        st.lastLen = name.length;
        tabState = st;
    }, true);

    /* ---- emotes ------------------------------------------------------ */
    // The chat input's React fiber carries the numeric channel id (needed by
    // the BTTV/7TV/FFZ APIs) — verified live; no network lookup required.
    // The fiber is only reachable from the page world, so page-twitch.js
    // reads it and answers over the bridge; the id is re-requested every
    // 30s so channel changes are picked up within one fetch cycle.
    let pageChannelId = null;
    let pageChannelIdAskedAt = 0;
    function getChannelId() {
        if (Date.now() - pageChannelIdAskedAt > 30000) {
            pageChannelIdAskedAt = Date.now();
            window.postMessage({ type: 'ytbtw-channel-id-req' }, location.origin);
        }
        return pageChannelId;
    }

    async function fetchJson(url) {
        // Content-script fetches on Chromium run under the page's CORS and
        // CSP rules; the background service worker holds host permissions
        // for the three emote APIs, so the request is relayed there.
        const res = await api.runtime.sendMessage({ action: 'ytb-fetch-json', url });
        if (!res || !res.ok) throw new Error((res && res.error) || 'fetch failed');
        return res.data;
    }

    function addEmote(map, name, url, title, scope) {
        if (name && url && !map.has(name)) map.set(name, { url, title, scope });
    }

    function collectFfz(map, data, scope) {
        Object.values((data && data.sets) || {}).forEach(s => (s.emoticons || []).forEach(e => {
            const u = e.urls && (e.urls['2'] || e.urls['1']);
            if (u) addEmote(map, e.name, u.startsWith('//') ? 'https:' + u : u, 'FFZ: ' + e.name, scope);
        }));
    }

    function collect7tv(map, emotes, scope) {
        (emotes || []).forEach(e => {
            const host = e.data && e.data.host;
            if (host && host.url) {
                addEmote(map, e.name, (host.url.startsWith('//') ? 'https:' : '') + host.url + '/2x.webp', '7TV: ' + e.name, scope);
            }
        });
    }

    function collectBttv(map, emotes, scope) {
        (emotes || []).forEach(e =>
            addEmote(map, e.code, 'https://cdn.betterttv.net/emote/' + e.id + '/2x', 'BTTV: ' + e.code, scope));
    }

    function maybeFetchEmotes() {
        if (!settings.twEmotes || !settings.twEnabled || IS_MOBILE || emoteFetchInFlight) return;
        // After a failed round (all providers unreachable), back off briefly
        // instead of hammering the APIs every pass.
        if (emoteLastFailAt && Date.now() - emoteLastFailAt < 30000) return;
        const id = getChannelId();
        if (emoteGlobalsLoaded && (id === emoteChannelId || !id)) return;
        emoteFetchInFlight = true;
        (async () => {
            const map = new Map();
            // Channel emotes load first so they win over same-named globals.
            if (id) {
                await Promise.allSettled([
                    fetchJson('https://api.betterttv.net/3/cached/users/twitch/' + id)
                        .then(d => { collectBttv(map, [].concat(d.channelEmotes || [], d.sharedEmotes || []), 'channel'); }),
                    fetchJson('https://7tv.io/v3/users/twitch/' + id)
                        .then(d => { collect7tv(map, d && d.emote_set && d.emote_set.emotes, 'channel'); }),
                    fetchJson('https://api.frankerfacez.com/v1/room/id/' + id)
                        .then(d => { collectFfz(map, d, 'channel'); })
                ]);
            }
            await Promise.allSettled([
                fetchJson('https://api.betterttv.net/3/cached/emotes/global')
                    .then(list => { collectBttv(map, list, 'global'); }),
                fetchJson('https://7tv.io/v3/emote-sets/global')
                    .then(d => { collect7tv(map, d && d.emotes, 'global'); }),
                fetchJson('https://api.frankerfacez.com/v1/set/global')
                    .then(d => { collectFfz(map, d, 'global'); })
            ]);
            emoteMap = map;
            emoteChannelId = id;
            if (map.size) {
                emoteGlobalsLoaded = true;
                emoteLastFailAt = 0;
            } else {
                // Every provider failed (network / permissions) — retry later.
                emoteGlobalsLoaded = false;
                emoteLastFailAt = Date.now();
            }
            if (chatContainer) {
                chatContainer.querySelectorAll('.chat-line__message').forEach(m => emoteProcess(m, true));
            }
        })().catch(() => {}).finally(() => { emoteFetchInFlight = false; });
    }

    function emoteProcess(node, force) {
        if (!emoteMap.size || !node.querySelectorAll) return;
        const msgs = (node.matches && node.matches('.chat-line__message'))
            ? [node]
            : [...node.querySelectorAll('.chat-line__message')];
        for (const msg of msgs) {
            for (const frag of msg.querySelectorAll('[data-a-target="chat-message-text"]')) {
                if (frag.dataset.ytbtwEmoted && !force) continue;
                if (frag.querySelector('img.ytbtw-emote')) continue;   // already rewritten
                const text = frag.textContent || '';
                const tokens = text.split(/(\s+)/);
                if (!tokens.some(t => emoteMap.has(t))) {
                    frag.dataset.ytbtwEmoted = '1';
                    continue;
                }
                const repl = document.createDocumentFragment();
                for (const t of tokens) {
                    const hit = emoteMap.get(t);
                    if (hit) {
                        const img = document.createElement('img');
                        img.className = 'ytbtw-emote';
                        img.src = hit.url;
                        img.alt = t;
                        img.title = hit.title;
                        repl.appendChild(img);
                    } else {
                        repl.appendChild(document.createTextNode(t));
                    }
                }
                frag.textContent = '';
                frag.appendChild(repl);
                frag.dataset.ytbtwEmoted = '1';
            }
        }
    }

    /* ---- in-player volume boost ----------------------------------------
     * Same approach as the YouTube side: a 100–500% slider that appears
     * inline next to Twitch's volume control while native volume sits at
     * 100%, boosting through a Web Audio gain node. The audio graph is
     * only built from a user gesture (slider input / first pointerdown
     * when a boost was persisted) so a suspended AudioContext can never
     * mute default playback.
     * ------------------------------------------------------------------ */
    let boostCtx = null, boostGain = null, boostSource = null, boostVideo = null;
    let compNode = null;

    function playerVideo() {
        return document.querySelector('.video-player__container video') ||
               document.querySelector('video');
    }

    // Audio compressor (FFZ-style leveller): evens out quiet talkers and
    // loud game audio. Sits between the media source and the boost gain.
    function rewireBoostChain() {
        if (!boostSource || !boostGain) return;
        try { boostSource.disconnect(); } catch (e) { /* ignore */ }
        if (compNode) { try { compNode.disconnect(); } catch (e) { /* ignore */ } }
        if (settings.twCompressorOn) {
            if (!compNode || compNode.context !== boostCtx) {
                compNode = boostCtx.createDynamicsCompressor();
                compNode.threshold.value = -50;
                compNode.knee.value = 40;
                compNode.ratio.value = 12;
                compNode.attack.value = 0;
                compNode.release.value = 0.25;
            }
            boostSource.connect(compNode);
            compNode.connect(boostGain);
        } else {
            boostSource.connect(boostGain);
        }
    }

    function setTwCompressor(on, save) {
        settings.twCompressorOn = on;
        state.settings.twCompressorOn = on;
        if (on) ensureBoostGraph();   // called from a click, so the ctx can run
        rewireBoostChain();
        if (save) persist();
    }

    function ensureBoostGraph() {
        const v = playerVideo();
        if (!v) return false;
        if (boostVideo === v && boostGain) {
            if (boostCtx && boostCtx.state === 'suspended') boostCtx.resume().catch(() => {});
            return true;
        }
        try {
            if (!boostCtx) boostCtx = new AudioContext();
            if (boostSource) { try { boostSource.disconnect(); } catch (e) { /* ignore */ } }
            boostSource = boostCtx.createMediaElementSource(v);
            if (!boostGain) {
                boostGain = boostCtx.createGain();
                boostGain.connect(boostCtx.destination);
            }
            rewireBoostChain();
            boostVideo = v;
            if (boostCtx.state === 'suspended') boostCtx.resume().catch(() => {});
            return true;
        } catch (e) {
            return false;   // element already claimed by another AudioContext
        }
    }

    function applyVolumeBoost() {
        const b = Math.min(5, Math.max(1, settings.twVolumeBoost || 1));
        if (b > 1) {
            if (ensureBoostGraph()) boostGain.gain.value = b;
        } else if (boostGain) {
            boostGain.gain.value = 1;
        }
    }

    function setVolumeBoost(b, save) {
        b = Math.min(5, Math.max(1, b));
        settings.twVolumeBoost = b;
        state.settings.twVolumeBoost = b;
        applyVolumeBoost();
        if (save) persist();
    }

    function updateBoostUI() {
        const wrap = document.getElementById('ytbtw-boost');
        if (!wrap) return;
        const v = playerVideo();
        const atMax = !!(v && v.volume >= 0.99 && !v.muted);
        // Native volume left 100%: boost turns off and the slider hides.
        if (!atMax && (settings.twVolumeBoost || 1) > 1) setVolumeBoost(1, true);
        wrap.classList.toggle('ytbtw-hide', !atMax);
        const input = wrap.querySelector('input');
        const label = wrap.querySelector('.ytbtw-boost-label');
        const pct = Math.round((settings.twVolumeBoost || 1) * 100);
        if (input && document.activeElement !== input) input.value = pct;
        if (label) label.textContent = pct + '%';
        wrap.classList.toggle('ytbtw-boosting', pct > 100);
    }

    function ensureBoostSlider() {
        let existing = document.getElementById('ytbtw-boost');
        const volInput = document.querySelector('input[data-a-target="player-volume-slider"]');
        if (!settings.twEnabled || !volInput) {
            if (existing) existing.remove();
            return;
        }
        // Insert right after the layout cell housing the native volume range.
        const anchor = volInput.parentElement && volInput.parentElement.parentElement;
        if (!anchor || !anchor.parentElement) return;
        let wrap = existing;
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'ytbtw-boost';
            wrap.title = 'Volume boost — shown while volume is at 100%. Click the % to reset.';
            const input = document.createElement('input');
            input.type = 'range';
            input.min = '100';
            input.max = '500';
            input.step = '5';
            const label = document.createElement('span');
            label.className = 'ytbtw-boost-label';
            wrap.appendChild(input);
            wrap.appendChild(label);
            input.addEventListener('input', (e) => {
                e.stopPropagation();
                const pct = parseInt(input.value, 10) || 100;
                const v = playerVideo();
                if (v) { if (v.muted) v.muted = false; v.volume = 1; }
                setVolumeBoost(pct / 100, false);
                updateBoostUI();
            });
            input.addEventListener('change', () => persist());
            label.addEventListener('click', (e) => {
                e.stopPropagation();
                setVolumeBoost(1, true);
                updateBoostUI();
            });
        }
        if (wrap.parentNode !== anchor.parentNode || wrap.previousElementSibling !== anchor) {
            anchor.insertAdjacentElement('afterend', wrap);
        }
        const v = playerVideo();
        if (v && !v.dataset.ytbtwVolListener) {
            v.dataset.ytbtwVolListener = '1';
            v.addEventListener('volumechange', updateBoostUI);
        }
        updateBoostUI();
    }

    // First user gesture: if a boost or the compressor was persisted, wire
    // the audio graph now (an AudioContext created outside a gesture would
    // stay suspended and mute the element instead of boosting it).
    document.addEventListener('pointerdown', () => {
        if (retired) return;
        if (((settings.twVolumeBoost || 1) > 1 || settings.twCompressorOn) && !boostGain) {
            ensureBoostGraph();
            applyVolumeBoost();
        }
    }, true);

    /* ---- third-party emote picker ------------------------------------
     * A button next to Twitch's own emote picker opens a searchable panel
     * of the loaded BTTV/FFZ/7TV emotes (channel + global). Clicking one
     * types its name into the chat input; other third-party-emote users
     * see it rendered.
     * ------------------------------------------------------------------ */
    function ensureEmotePicker() {
        const anchor = document.querySelector('button[data-a-target="emote-picker-button"]');
        const existing = document.getElementById('ytbtw-picker-btn');
        const want = settings.twEnabled && settings.twEmotes && anchor;
        if (!want) {
            if (existing) existing.remove();
            closeEmotePanel();
            return;
        }
        if (existing && anchor.parentElement && anchor.parentElement.contains(existing)) return;
        if (existing) existing.remove();
        const btn = document.createElement('button');
        btn.id = 'ytbtw-picker-btn';
        btn.type = 'button';
        btn.title = 'Third-party emotes (BTTV / FFZ / 7TV) — click one to type its name';
        btn.textContent = '😼';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (document.getElementById('ytbtw-picker-panel')) closeEmotePanel();
            else openEmotePanel(btn);
        });
        anchor.parentElement.insertBefore(btn, anchor);
    }

    function emotePanelOutside(e) {
        const p = document.getElementById('ytbtw-picker-panel');
        if (!p) { closeEmotePanel(); return; }
        if (e.target === p || p.contains(e.target)) return;
        const btn = document.getElementById('ytbtw-picker-btn');
        if (btn && (e.target === btn || btn.contains(e.target))) return;
        closeEmotePanel();
    }

    function closeEmotePanel() {
        const p = document.getElementById('ytbtw-picker-panel');
        if (p) p.remove();
        document.removeEventListener('pointerdown', emotePanelOutside, true);
    }

    function openEmotePanel(btn) {
        closeEmotePanel();
        const rect = btn.getBoundingClientRect();
        const panel = document.createElement('div');
        panel.id = 'ytbtw-picker-panel';
        panel.style.right = Math.max(8, window.innerWidth - rect.right - 160) + 'px';
        panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
        const search = document.createElement('input');
        search.type = 'text';
        search.placeholder = emoteMap.size ? 'Search ' + emoteMap.size + ' emotes…' : 'Emotes still loading…';
        const grid = document.createElement('div');
        grid.className = 'ytbtw-picker-grid';
        const render = () => {
            const q = search.value.trim().toLowerCase();
            grid.textContent = '';
            let shown = 0;
            for (const scope of ['channel', 'global']) {
                const items = [...emoteMap.entries()]
                    .filter(([n, e]) => e.scope === scope && (!q || n.toLowerCase().includes(q)));
                if (!items.length) continue;
                const head = document.createElement('div');
                head.className = 'ytbtw-picker-head';
                head.textContent = scope === 'channel' ? 'This channel' : 'Global';
                grid.appendChild(head);
                for (const [name, e] of items) {
                    if (++shown > 400) break;
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.title = e.title;
                    const img = document.createElement('img');
                    img.src = e.url;
                    img.alt = name;
                    img.loading = 'lazy';
                    b.appendChild(img);
                    b.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        chatInsert(name + ' ').then(ok => {
                            if (!ok) toast('Couldn’t reach the chat input', name);
                        });
                    });
                    grid.appendChild(b);
                }
                if (shown > 400) break;
            }
            if (!shown) {
                const empty = document.createElement('div');
                empty.className = 'ytbtw-picker-head';
                empty.textContent = emoteMap.size
                    ? 'No matches.'
                    : (emoteLastFailAt
                        ? 'Couldn’t load emotes — retrying automatically.'
                        : 'Emotes are still loading — try again in a moment.');
                grid.appendChild(empty);
            }
        };
        search.addEventListener('input', render);
        panel.appendChild(search);
        panel.appendChild(grid);
        document.body.appendChild(panel);
        render();
        search.focus();
        document.addEventListener('pointerdown', emotePanelOutside, true);
    }

    /* ==================================================================
     * 6c. Clip download (clip pages only — clips are plain MP4s).
     * ================================================================== */
    function isClipPage() {
        if (IS_CLIPS_HOST) return /^\/[A-Za-z0-9][\w-]*$/.test(location.pathname) && !location.pathname.startsWith('/create');
        return /^\/[^/]+\/clip\//.test(location.pathname);
    }

    function ensureClipDownload() {
        if (IS_MOBILE) return;
        const existing = document.getElementById('ytbtw-clipdl');
        const video = document.querySelector('video');
        const src = (video && video.src && /^https:/.test(video.src)) ? video.src : null;
        const want = settings.twEnabled && settings.twClipDownload && isClipPage() && src;
        if (!want) {
            if (existing) existing.remove();
            return;
        }
        if (existing) { existing.dataset.src = src; return; }
        const btn = document.createElement('button');
        btn.id = 'ytbtw-clipdl';
        btn.textContent = '⬇ Download clip';
        btn.title = 'Save this clip as an MP4';
        btn.dataset.src = src;
        btn.addEventListener('click', onClipDownload);
        document.body.appendChild(btn);
    }

    async function onClipDownload(e) {
        const btn = e.currentTarget;
        const src = btn.dataset.src;
        const name = (location.pathname.split('/').filter(Boolean).pop() || 'clip') + '.mp4';
        btn.disabled = true;
        btn.textContent = '⬇ Downloading…';
        try {
            const r = await fetch(src);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            btn.textContent = '✓ Downloaded';
        } catch (err) {
            // CORS or network refusal: open the MP4 directly instead.
            window.open(src, '_blank');
            btn.textContent = '⬇ Opened in new tab';
        }
        setTimeout(() => { btn.disabled = false; btn.textContent = '⬇ Download clip'; }, 3000);
    }

    /* ==================================================================
     * 6d. Screenshot: grab the current frame off the <video> (Twitch plays
     * through MSE, so the canvas isn't tainted).
     * ================================================================== */
    function currentChannelLogin() {
        return loginFromHref('/' + (location.pathname.split('/')[1] || ''));
    }

    function takeScreenshot() {
        const v = playerVideo();
        if (!v || !v.videoWidth) { toast('No frame to capture yet', ''); return; }
        try {
            const c = document.createElement('canvas');
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            c.getContext('2d').drawImage(v, 0, 0);
            const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
            const name = 'twitch-' + (currentChannelLogin() || 'stream') + '-' + stamp + '.png';
            c.toBlob((blob) => {
                if (!blob) { toast('Screenshot failed', ''); return; }
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
                toast('Screenshot saved', name);
            }, 'image/png');
        } catch (e) {
            toast('Screenshot failed', '');
        }
    }

    /* ==================================================================
     * 6e. Speed hotkeys on VODs and clips ([ slower, ] faster, \ reset).
     * Live streams are left alone — changing the rate there only fights
     * the latency buffer.
     * ================================================================== */
    function isSpeedablePage() {
        return /^\/videos\/\d+/.test(location.pathname) || isClipPage();
    }

    document.addEventListener('keydown', (e) => {
        if (retired || sharedInputActionsEnabled || !settings.twEnabled || !settings.twSpeedHotkeys || IS_MOBILE) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key !== '[' && e.key !== ']' && e.key !== '\\') return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''))) return;
        if (!isSpeedablePage()) return;
        const v = playerVideo();
        if (!v) return;
        let r = v.playbackRate || 1;
        if (e.key === '[') r -= 0.25;
        else if (e.key === ']') r += 0.25;
        else r = 1;
        r = Math.min(8, Math.max(0.1, Math.round(r * 100) / 100));
        v.playbackRate = r;
        e.preventDefault();
        e.stopPropagation();
        toast('Speed ' + r + '×', '');
    }, true);

    /* ==================================================================
     * 6f. Stream uptime chip next to the viewer count.
     * The start time comes from the page itself: the SSR LD+JSON block on a
     * full load, falling back to the Apollo cache reached through a React
     * fiber (same page-world plumbing as the chat editor). Best-effort —
     * when neither yields a time, no chip is shown.
     * ================================================================== */
    let uptimeCache = { login: null, start: 0, at: 0 };

    function streamStartFromLdJson(login) {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const data = JSON.parse(s.textContent);
                for (const d of (Array.isArray(data) ? data : [data])) {
                    if (!d || !d.publication) continue;
                    // Stale after SPA navigation: only trust it for its channel.
                    if (!JSON.stringify(d).toLowerCase().includes('twitch.tv/' + login)) continue;
                    const pubs = Array.isArray(d.publication) ? d.publication : [d.publication];
                    for (const p of pubs) {
                        const t = p && p.startDate && Date.parse(p.startDate);
                        if (t) return t;
                    }
                }
            } catch (e) { /* not JSON we understand */ }
        }
        return 0;
    }

    // The stream start time sits in Twitch's Apollo cache, reachable only
    // from the page world; page-twitch.js walks the fiber tree there and
    // answers over the bridge. A reply invalidates the uptime cache below
    // so the chip appears on the next pass instead of after the 5-minute
    // recheck.
    const pageStreamStarts = Object.create(null);
    const pageStreamStartAskedAt = Object.create(null);
    function streamStartFromApollo(login) {
        if (pageStreamStarts[login]) return pageStreamStarts[login];
        const lastAsked = pageStreamStartAskedAt[login] || 0;
        if (Date.now() - lastAsked > 5000) {
            pageStreamStartAskedAt[login] = Date.now();
            window.postMessage({ type: 'ytbtw-stream-start-req', login }, location.origin);
        }
        return 0;
    }

    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data) return;
        if (e.data.type === 'ytbtw-channel-id') {
            if (e.data.id) pageChannelId = String(e.data.id);
        } else if (e.data.type === 'ytbtw-stream-start' && e.data.login && e.data.start) {
            pageStreamStarts[e.data.login] = e.data.start;
            if (uptimeCache.login === e.data.login && !uptimeCache.start) uptimeCache.at = 0;
        }
    });

    function formatUptime(ms) {
        const mins = Math.floor(ms / 60000);
        const h = Math.floor(mins / 60), m = mins % 60;
        return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    }

    function ensureUptime() {
        const existing = document.getElementById('ytbtw-uptime');
        const login = currentChannelLogin();
        const viewers = document.querySelector('[data-a-target="animated-channel-viewers-count"]');
        if (!settings.twEnabled || !settings.twUptime || !login || !viewers) {
            if (existing) existing.remove();
            return;
        }
        const maxAge = uptimeCache.start ? 300000 : 5000;
        if (uptimeCache.login !== login || Date.now() - uptimeCache.at > maxAge) {
            uptimeCache = {
                login,
                start: streamStartFromLdJson(login) || streamStartFromApollo(login),
                at: Date.now()
            };
        }
        if (!uptimeCache.start || uptimeCache.start > Date.now()) {
            if (existing) existing.remove();
            return;
        }
        let chip = existing;
        if (!chip || chip.previousElementSibling !== viewers) {
            if (chip) chip.remove();
            chip = document.createElement('span');
            chip.id = 'ytbtw-uptime';
            chip.title = 'Stream uptime';
            viewers.insertAdjacentElement('afterend', chip);
        }
        chip.textContent = '⏱ ' + formatUptime(Date.now() - uptimeCache.start);
    }

    /* ==================================================================
     * 6g. Sidebar hover previews: a live thumbnail (Twitch's own preview
     * CDN, refreshed server-side every few minutes) floats next to the
     * side-nav entry under the cursor. Image-only, so no extra bandwidth
     * beyond one JPEG per hover.
     * ================================================================== */
    let previewTimer = null;

    function hidePreview() {
        clearTimeout(previewTimer);
        previewTimer = null;
        const p = document.getElementById('ytbtw-preview');
        if (p) p.remove();
    }

    function showPreview(login, rect) {
        hidePreview();
        const panel = document.createElement('div');
        panel.id = 'ytbtw-preview';
        panel.dataset.login = login;
        const img = document.createElement('img');
        // Cache-bust every 30 s so a long session doesn't show stale frames.
        img.src = 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + login +
                  '-440x248.jpg?ytbtw=' + Math.floor(Date.now() / 30000);
        img.alt = login;
        img.addEventListener('error', hidePreview);
        const cap = document.createElement('div');
        cap.className = 'ytbtw-preview-cap';
        cap.textContent = login;
        panel.appendChild(img);
        panel.appendChild(cap);
        panel.style.left = Math.round(rect.right + 10) + 'px';
        panel.style.top = Math.round(Math.max(8, Math.min(window.innerHeight - 290, rect.top - 8))) + 'px';
        document.body.appendChild(panel);
    }

    document.addEventListener('mouseover', (e) => {
        if (retired || IS_MOBILE || IS_CLIPS_HOST) return;
        if (!settings.twEnabled || !settings.twHoverPreviews) return;
        const card = e.target && e.target.closest && e.target.closest('.side-nav-card');
        if (!card) { hidePreview(); return; }
        const a = card.matches('a[href]') ? card : card.querySelector('a[href]');
        const login = a && loginFromHref(a.getAttribute('href'));
        // Skip offline rows (grey avatar) and blocked channels.
        const offline = card.querySelector('[class*="offline" i], .side-nav-card__avatar--offline');
        if (!login || offline || blockedLogins.has(login)) { hidePreview(); return; }
        // Already showing this channel: don't rebuild on every mouse move.
        const shown = document.getElementById('ytbtw-preview');
        if (shown && shown.dataset.login === login) return;
        clearTimeout(previewTimer);
        const rect = card.getBoundingClientRect();
        previewTimer = setTimeout(() => showPreview(login, rect), 150);
    }, true);

    /* ==================================================================
     * 7. Toast
     * ================================================================== */
    let toastTimer = null;
    function toast(message, accent, onUndo) {
        let el = document.getElementById('ytbtw-toast');
        if (!el) {
            if (!document.body) return;
            el = document.createElement('div');
            el.id = 'ytbtw-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        if (accent) {
            el.appendChild(document.createTextNode(' '));
            const span = document.createElement('span');
            span.className = 'ytbtw-toast-accent';
            span.textContent = accent;
            el.appendChild(span);
        }
        if (onUndo) {
            const btn = document.createElement('button');
            btn.className = 'ytbtw-undo';
            btn.textContent = 'Undo';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove('ytbtw-show');
                try { onUndo(); } catch (err) { /* ignore */ }
            });
            el.appendChild(btn);
        }
        void el.offsetWidth;
        el.classList.add('ytbtw-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('ytbtw-show'), onUndo ? 5000 : 2600);
    }

    /* ==================================================================
     * 8. Context-menu actions relayed from the background script
     * ================================================================== */
    document.addEventListener('contextmenu', (e) => {
        if (retired) return;
        lastContextTarget = e.target;
    }, true);

    function channelFromTarget(target) {
        if (target && target.closest) {
            const a = target.closest('a[href]');
            if (a) {
                const login = loginFromHref(new URL(a.href, location.origin).pathname);
                if (login) return login;
            }
            const art = target.closest('article');
            if (art) {
                for (const link of art.querySelectorAll('a[href]')) {
                    const login = loginFromHref(link.getAttribute('href'));
                    if (login) return login;
                }
            }
        }
        return loginFromHref('/' + location.pathname.split('/')[1]);
    }

    function categoryFromTarget(target) {
        if (target && target.closest) {
            const a = target.closest('a[href]');
            if (a) {
                const slug = catSlugFromHref(new URL(a.href, location.origin).pathname);
                if (slug) return { slug, name: (a.textContent || '').trim().slice(0, 80) };
            }
            const art = target.closest('article');
            if (art) {
                const link = art.querySelector('a[href^="/directory/category/"], a[href^="/directory/game/"]');
                if (link) {
                    return {
                        slug: catSlugFromHref(link.getAttribute('href')),
                        name: (link.textContent || '').trim().slice(0, 80)
                    };
                }
            }
        }
        // Category page itself, or the stream's category link on a channel page.
        const pageSlug = catSlugFromHref(location.pathname);
        if (pageSlug) return { slug: pageSlug, name: '' };
        const streamCat = document.querySelector('a[data-a-target="stream-game-link"], [data-a-target="stream-game-link"] a');
        if (streamCat) {
            return {
                slug: catSlugFromHref(streamCat.getAttribute('href')),
                name: (streamCat.textContent || '').trim().slice(0, 80)
            };
        }
        return null;
    }

    function blockChannelAction() {
        const login = channelFromTarget(lastContextTarget);
        if (!login) { toast('Couldn’t work out which channel that is', ''); return; }
        if (blockedLogins.has(login)) { toast('Already blocked', login); return; }
        state.twitchBlockedChannels.push({ login, name: '', addedAt: Date.now() });
        persist();
        toast('Blocked channel', login, () => {
            state.twitchBlockedChannels = state.twitchBlockedChannels.filter(c => c.login !== login);
            persist();
        });
    }

    function blockCategoryAction() {
        const info = categoryFromTarget(lastContextTarget);
        if (!info || !info.slug) { toast('Couldn’t work out which category that is', ''); return; }
        if (blockedCatSlugs.has(info.slug)) { toast('Already blocked', info.name || info.slug); return; }
        state.twitchBlockedCategories.push({ slug: info.slug, name: info.name || '', addedAt: Date.now() });
        persist();
        toast('Blocked category', info.name || info.slug, () => {
            state.twitchBlockedCategories = state.twitchBlockedCategories.filter(c => c.slug !== info.slug);
            persist();
        });
    }

    api.runtime.onMessage.addListener((msg) => {
        if (!msg || !msg.action || retired) return;
        switch (msg.action) {
            case 'ytbtw-block-channel':  blockChannelAction(); break;
            case 'ytbtw-block-category': blockCategoryAction(); break;
        }
    });

    /* ==================================================================
     * 9. Incremental main pass + boot
     * ================================================================== */
    function initTwitchExperience() {
        const module = typeof globalThis !== 'undefined' &&
            globalThis.YTBTW_TWITCH_EXPERIENCE;
        if (!module || typeof module.createController !== 'function') return;
        try {
            twitchExperience = module.createController({
                api,
                document,
                window,
                location,
                console,
                getVideo: playerVideo,
                applyPlaybackProfile(detail) {
                    if (!detail || detail.volumeBoost == null) return;
                    const boost = Number(detail.volumeBoost);
                    if (!Number.isFinite(boost)) return;
                    const bounded = Math.min(5, Math.max(1, boost));
                    if (bounded > 1) {
                        if (ensureBoostGraph()) boostGain.gain.value = bounded;
                    } else if (boostGain) {
                        boostGain.gain.value = 1;
                    }
                },
                toast
            });
            twitchExperience.updateState(rawStorageData);
        } catch (e) {
            twitchExperience = null;
            console.warn('[YT/Twitch Enhancer] Twitch experience tools unavailable:', e);
        }
    }

    function startLifecycleInterval(callback, ms) {
        const id = setInterval(callback, ms);
        lifecycleIntervals.add(id);
        return id;
    }

    function runAll(fullScan) {
        if (retired) return;
        const scan = fullScan !== false;
        if (!settings.twEnabled) {
            if (scan) unhideAll();
            ensureClipBar();
            ensureChatEngine();
            ensureClipDownload();
            ensureEmotePicker();
            ensureUptime();
            hidePreview();
            return;
        }
        if (scan) scanCards(document, true);
        pauseCarousel();
        runClaims();
        if (!IS_MOBILE) {
            ensureClipBar();
            ensureChatEngine();
            chatFilterSweep();
            ensureClipDownload();
            ensureEmotePicker();
            ensureBoostSlider();
            ensureUptime();
            maybeFetchEmotes();
        }
    }

    function onStorageChanged(changes, area) {
        if (retired || area !== 'local' || !changes[STORAGE_KEY]) return;
        rawStorageData = changes[STORAGE_KEY].newValue || {};
        if (twitchExperience) twitchExperience.updateState(rawStorageData);
        const incoming = JSON.stringify(normalize(rawStorageData));
        if (incoming === lastSerialized) return;
        lastSerialized = incoming;
        state = normalize(rawStorageData);
        settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
        if (!IS_CLIPS_HOST) {
            rebuildDerived();
            runAll(true);
        }
    }
    api.storage.onChanged.addListener(onStorageChanged);

    function ownedExperienceNode(node) {
        const element = node && (node.nodeType === 1 ? node : node.parentElement);
        return !!(element && element.closest && element.closest(
            '#ytbtw-player-experience, #ytbtw-player-panel, #ytbtw-sidebar-tools, ' +
            '#ytbtw-sidebar-manager, #ytbtw-chat-overlay, .ytbtw-sidebar-actions'
        ));
    }

    function mutationOnlyTouchesExperienceUi(record) {
        if (!record) return true;
        if (ownedExperienceNode(record.target)) return true;
        if (record.type !== 'childList' || !record.addedNodes ||
                !record.addedNodes.length) return false;
        return [...record.addedNodes].every(ownedExperienceNode);
    }

    function mutationInsideChatMessages(record) {
        const target = record && record.target && (record.target.nodeType === 1
            ? record.target : record.target.parentElement);
        return !!(target && target.closest &&
            target.closest('.chat-scrollable-area__message-container'));
    }

    function mutationNeedsMaintenance(record) {
        if (!record || record.type !== 'childList' || !record.addedNodes ||
                mutationInsideChatMessages(record)) return false;
        return [...record.addedNodes].some(node => node && node.nodeType === 1);
    }

    function scheduleMaintenance() {
        if (retired || maintenanceTimer) return;
        maintenanceTimer = setTimeout(() => {
            maintenanceTimer = null;
            runAll(false);
        }, 180);
    }

    function bootObserver() {
        if (retired) return;
        if (!document.body) {
            requestAnimationFrame(bootObserver);
            return;
        }
        mainObserver = new MutationObserver(records => {
            if (retired) return;
            const relevant = records.filter(record => !mutationOnlyTouchesExperienceUi(record));
            if (relevant.length) {
                const structural = relevant.filter(record => !mutationInsideChatMessages(record));
                if (structural.length) {
                    processCardMutations(structural);
                    if (twitchExperience) twitchExperience.processMutations(structural);
                    if (structural.some(mutationNeedsMaintenance)) scheduleMaintenance();
                }
            }
        });
        mainObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['href', 'title', 'data-a-target', 'aria-label']
        });
        runAll(true);
        if (twitchExperience) twitchExperience.processRoot(document);

        // Keep claims reliable in background tabs, but visible-tab maintenance
        // no longer performs a document-wide article/sidebar scan. Only
        // incomplete shells retained in the bounded recovery queue are revisited.
        startLifecycleInterval(() => {
            if (retired) return;
            runClaims();
            pauseCarousel();
            processCardRecovery(CARD_RECOVERY_LIMIT);
            if (!document.hidden) runAll(false);
            if (twitchExperience) twitchExperience.maintenance();
        }, 2500);

        // SPA navigation gets one deliberate full classification pass. Ordinary
        // hydration and list appends remain mutation-driven and incremental.
        let lastHref = location.href;
        startLifecycleInterval(() => {
            if (retired || location.href === lastHref) return;
            lastHref = location.href;
            if (twitchExperience) twitchExperience.onNavigation();
            applyQualityPin();
            runAll(true);
        }, 500);
    }

    function retireInstance() {
        if (retired) return;
        retired = true;
        if (mainObserver) {
            mainObserver.disconnect();
            mainObserver = null;
        }
        clearTimeout(maintenanceTimer);
        maintenanceTimer = null;
        for (const id of lifecycleIntervals) clearInterval(id);
        lifecycleIntervals.clear();
        if (twitchExperience) {
            twitchExperience.retire();
            twitchExperience = null;
        }
        if (chatObserver) {
            chatObserver.disconnect();
            chatObserver = null;
        }
        clearTimeout(batchTimer);
        batchTimer = null;
        for (const node of pendingReveal) {
            if (node && node.classList) node.classList.remove('ytbtw-chat-pending');
        }
        pendingReveal = [];
        exitCinema();
        hidePreview();
        closeEmotePanel();
        clearTimeout(toastTimer);
        try {
            if (api.storage.onChanged && typeof api.storage.onChanged.removeListener === 'function') {
                api.storage.onChanged.removeListener(onStorageChanged);
            }
        } catch (e) { /* extension context may already be invalid */ }
        document.removeEventListener(TAKEOVER_EVENT, retireInstance, true);
    }

    async function init() {
        try {
            document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
            document.addEventListener(TAKEOVER_EVENT, retireInstance, true);
        } catch (e) { /* ignore */ }
        try {
            const stored = await api.storage.local.get(STORAGE_KEY);
            rawStorageData = stored[STORAGE_KEY] || {};
            state = normalize(rawStorageData);
        } catch (e) {
            rawStorageData = {};
            state = normalize(null);
        }
        if (retired) return;
        lastSerialized = JSON.stringify(state);
        settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
        if (!IS_MOBILE) initTwitchExperience();
        if (IS_CLIPS_HOST) {
            // Clip-recorder mode + local player controls; no card scanning.
            startLifecycleInterval(() => {
                clipsRecorderTick();
                ensureClipDownload();
                if (twitchExperience) twitchExperience.maintenance();
            }, 1500);
            return;
        }
        // Opened by the background script purely to auto-claim drops: this
        // instance claims and then asks to be closed (see autoClaimDrops).
        if (IS_INVENTORY && location.hash === AUTOCLAIM_HASH) {
            inventoryCloseArmed = true;
        }
        rebuildDerived();
        bootObserver();
    }

    init();
})();
