/* ==================================================================
 * YouTube/Twitch Enhancer — YouTube content script
 *
 * Runs on every YouTube page. Responsibilities:
 *   - Remove Shorts (sidebar, tabs, shelves, /shorts redirect)   [setting]
 *   - Hide already-watched videos past a threshold               [setting]
 *   - Hide individually-blocked video IDs
 *   - Hide every tile from a blocked channel
 *   - Strip ad / promo / nudge clutter so the grid reflows
 *   - Handle right-click menu actions relayed from the background
 *   - Best-effort click YouTube's native "Don't recommend channel"
 *
 * State lives in browser.storage.local under the key "data" and is
 * shared with the popup and options pages. Changes there flow back
 * here via storage.onChanged.
 * ================================================================== */
(function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const STORAGE_KEY = 'data';
    const LEGACY_HIDDEN_KEY = 'ytShortsBlocker_manuallyHiddenIds';

    // Persistent watched-video database (src/watched-db.js runs first in the
    // same content-script scope). All watched-history storage goes through it.
    const WatchedDB = ((typeof self !== 'undefined') ? self : window).YTBWatchedDB || null;

    // When the extension updates in place, Firefox orphans the old content
    // script: its DOM listeners keep firing but its storage/API access is
    // dead. Every marker we leave on DOM nodes is therefore tagged with this
    // per-load id so a fresh instance re-wires instead of trusting stale
    // flags, and a takeover event tells older instances to stand down.
    const INSTANCE_ID = Math.random().toString(36).slice(2);
    const TAKEOVER_EVENT = 'ytb-instance-takeover';
    let retired = false;

    const DEFAULT_SETTINGS = {
        enabled: true,               // master switch for the whole extension
        blockShorts: true,
        hideWatched: true,
        watchedThreshold: 90,
        // Per-surface scope for watched-hiding. Playlists default OFF because
        // seeing progress in Watch Later / playlists is usually the point.
        watchedHome: true,
        watchedSubs: true,
        watchedSearch: true,
        watchedRelated: true,
        watchedChannel: true,
        watchedPlaylists: false,
        blackoutBlockedChannels: true,
        revealHidden: false,         // audit mode: show hidden tiles dimmed instead of removed
        maxQuality: true,
        hideSidebarSpinner: true,
        reduceFlashing: true,
        hideEndScreen: true,
        hidePromos: true,            // ads / promos / nudges (previously always on)
        hideMixes: false,
        hidePlaylists: false,
        hideNewsShelves: false,
        hideMembersOnly: false,      // off by default: people may be members on some channels
        hidePaidVideos: false,       // off by default: hide Pay-to-watch / Buy-or-rent tiles
        syncBlockLists: false,       // handled by the background script
        volumeBoost: 1,        // 1 = 100% (native, no Web Audio graph)
        wheelVolume: true,     // scroll over the player to change volume/boost
        ytCinemaButton: true,  // cinema-mode (darken page) button in the player
        ytCompressorButton: true,   // 🎚 audio-compressor button in the player controls
        ytCompressorOn: false,      // compressor engaged (remembered across loads)
        ytLoopButton: true,         // 🔁 A-B loop button in the player controls
        ytShotButton: true,         // 📷 screenshot button in the player controls
        ytSpeedDefault: 1,          // playback speed applied to each new (non-live) video
        ytSpeedPerChannel: false,   // remember the last hotkey speed per channel
        ytSpeedHotkeys: true,       // [ and ] step speed, \ resets
        ytNoPauseDialog: true,      // auto-dismiss "Video paused. Continue watching?"
        ytDisableAutoplay: false,   // keep YouTube's up-next autoplay toggle off
        ytAutoExpandDesc: false,    // auto-expand the watch-page description
        // ---- Community data (opt-in; all off by default) ----
        sbEnabled: false,
        sbSkipSponsor: true,
        sbSkipSelfpromo: true,
        sbSkipInteraction: true,
        sbSkipIntro: false,
        sbSkipOutro: false,
        sbSkipPreview: false,
        sbSkipOfftopic: false,
        sbSkipFiller: false,
        sbThumbnailBadges: true,     // green shield on tiles that already have segments
        deArrowTitles: false,
        deArrowThumbs: false,
        rydEnabled: false
    };

    /* ---- live state ------------------------------------------------ */
    let state = {
        hiddenVideoIds: [],
        hiddenVideoMetadata: {},
        blockedChannels: [],
        blockedKeywords: [],
        ytCommentKeywords: [],
        ytChannelSpeeds: {},
        sbWhitelist: [],
        inputBindings: {},
        settings: Object.assign({}, DEFAULT_SETTINGS)
    };
    let settings = Object.assign({}, DEFAULT_SETTINGS);
    let sharedInputActionsEnabled = false;
    let hiddenSet = new Set();
    let keywordMatchers = [];   // compiled from state.blockedKeywords
    let commentMatchers = [];   // compiled from state.ytCommentKeywords
    let blockedIndex = { handles: new Set(), ids: new Set(), names: new Set() };
    let sbWhitelistIndex = { handles: new Set(), ids: new Set(), names: new Set() };
    let configVersion = 0;
    let lastSerialized = '';          // guard against echoing our own writes
    let lastContextTarget = null;     // element under the last right-click
    let menuOwnerTile = null;         // tile whose 3-dot menu button was last pressed
    let menuOwnerIsMain = false;      // menu opened from the main watch video, not a tile
    let blackoutActive = false;       // current page is a blocked channel/video
    let lastQualityVideoId = null;    // video we've already forced to max quality
    let lastPointerDown = 0;          // timestamp of last pointerdown (menu-open hint)
    let lastNativeVolGesture = 0;     // last real interaction with YouTube's own volume control
    let nativeVolPointerDown = false; // a pointer is currently held on YouTube's volume slider
    let curChannelInfo = null;        // channel identity of the current channel page (per pass)
    let tileCache = new WeakMap();    // canonical tile -> { version, videoId, reason }
    let filterConfigSignature = '';
    let filterBootTimer = null;
    let pageObserver = null;
    let detailObserver = null;
    let detailObserved = new WeakSet();
    let maintenanceTimer = null;
    let tileEnhancementTimer = null;
    const pendingTileEnhancements = new Set();
    const lifecycleIntervals = [];

    const FILTER_BOOT_ATTR = 'data-ytb-filter-boot';
    const FILTER_PENDING_CLASS = 'ytb-filter-pending';
    const FILTER_BOOT_FAIL_OPEN_MS = 3000;

    // Start the gate before the first asynchronous storage read. content.css is
    // already present (manifest content-script CSS loads first), so YouTube
    // cannot paint an unclassified card while settings/history are loading.
    function beginFilterBoot() {
        const root = document.documentElement;
        if (!root) return;
        root.setAttribute(FILTER_BOOT_ATTR, INSTANCE_ID);
        filterBootTimer = setTimeout(() => {
            filterBootTimer = null;
            if (root.getAttribute(FILTER_BOOT_ATTR) === INSTANCE_ID) {
                root.removeAttribute(FILTER_BOOT_ATTR);
            }
        }, FILTER_BOOT_FAIL_OPEN_MS);
    }

    function endFilterBoot() {
        if (filterBootTimer) {
            clearTimeout(filterBootTimer);
            filterBootTimer = null;
        }
        const root = document.documentElement;
        if (root && root.getAttribute(FILTER_BOOT_ATTR) === INSTANCE_ID) {
            root.removeAttribute(FILTER_BOOT_ATTR);
        }
    }

    // Remove the previous implementation's expensive :has() stylesheet and
    // survivor markers during same-DOM extension updates.
    function cleanupLegacyAntiflash() {
        const style = document.getElementById('ytb-antiflash-style');
        if (style) style.remove();
        document.querySelectorAll('[data-ytb-keep]')
            .forEach(el => el.removeAttribute('data-ytb-keep'));
    }

    cleanupLegacyAntiflash();
    beginFilterBoot();

    /* ------------------------------------------------------------------
     * Selectors (shared by removal passes)
     * ------------------------------------------------------------------ */
    const INNER_CONTAINERS = [
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-compact-video-renderer',
        'ytd-playlist-video-renderer',
        'ytd-playlist-renderer',
        'ytd-grid-playlist-renderer',
        'ytd-compact-playlist-renderer',
        'ytd-radio-renderer',
        'ytd-compact-radio-renderer',
        'ytd-reel-item-renderer',
        'ytd-rich-grid-media',
        'yt-lockup-view-model',
        'ytm-shorts-lockup-view-model',
        'ytm-shorts-lockup-view-model-v2',
        'ytm-reel-item-renderer',
        // m.youtube.com (Firefox for Android) tile containers
        'ytm-rich-item-renderer',
        'ytm-video-with-context-renderer',
        'ytm-compact-video-renderer',
        'ytm-playlist-video-renderer',
        'ytm-playlist-renderer',
        'ytm-compact-playlist-renderer',
        'ytm-radio-renderer',
        'ytm-compact-radio-renderer',
        'ytm-video-card-renderer',
        'ytm-media-item'
    ].join(',');

    const OUTER_GRID_CELLS = [
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-compact-video-renderer',
        'ytd-playlist-video-renderer',
        'ytm-rich-item-renderer',
        'ytm-video-with-context-renderer',
        'ytm-compact-video-renderer',
        'ytm-playlist-video-renderer'
    ].join(',');

    const PROGRESS_SELECTORS = [
        'ytd-thumbnail-overlay-resume-playback-renderer #progress',
        // Structural fallback: the fill is a width-styled child of the resume
        // overlay regardless of its (obfuscated) class name.
        'ytd-thumbnail-overlay-resume-playback-renderer [style*="width"]',
        '#progress[style*="width"]',
        '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment',
        'yt-thumbnail-overlay-progress-bar-view-model div[style*="width"]',
        // m.youtube.com watched-progress overlay
        'ytm-thumbnail-overlay-resume-playback-renderer .thumbnail-overlay-resume-playback-progress',
        '.thumbnail-overlay-resume-playback-progress[style*="width"]'
    ].join(',');

    const WATCHED_BAR_CONTAINERS = [
        '.ytThumbnailOverlayProgressBarHostWatchedProgressBar',
        '.ytThumbnailOverlayProgressBarHostWatchedProgressBarLegacy'
    ].join(',');
    const WATCHED_PROGRESS_MARKERS = PROGRESS_SELECTORS + ',' +
        WATCHED_BAR_CONTAINERS.split(',')
            .map(selector => selector + ' [style*="width"]')
            .join(',');

    const NON_VIDEO_CARDS = [
        'ytd-feed-nudge-renderer',
        'ytd-emergency-onebox-renderer',
        'ytd-ad-slot-renderer',
        'ytd-promoted-video-renderer',
        'ytd-display-ad-renderer',
        'ytd-statement-banner-renderer',
        'ytd-banner-promo-renderer',
        'ytd-feed-tutorial-renderer',
        'ytd-clarification-renderer',
        'ytm-ad-slot-renderer',
        'ytm-promoted-video-renderer',
        'ytm-companion-ad-renderer',
        'ytm-statement-banner-renderer'
    ].join(',');

    // Non-tile shelves and promos still use their older dedicated passes.
    const LEGACY_MUTATION_CONTAINERS = [
        'ytd-rich-section-renderer',
        'ytd-rich-shelf-renderer',
        'ytd-reel-shelf-renderer',
        'ytm-reel-shelf-renderer',
        NON_VIDEO_CARDS
    ].join(',');

    // Members-only tiles. The classic desktop badge carries a language-
    // independent class; the newer view-model lockups and m.youtube.com only
    // expose the label text, so those hosts are matched against the badge
    // label in YouTube's most common UI languages (same approach as DNR_TEXTS).
    const MEMBERS_BADGE_CLASS_SEL = '.badge-style-type-members-only';
    const MEMBERS_BADGE_TEXT_HOSTS = [
        'ytd-badge-supported-renderer',
        'badge-shape',
        'yt-thumbnail-badge-view-model',
        'ytm-badge',
        'ytm-thumbnail-overlay-badge-view-model'
    ].join(',');

    const MEMBERS_TEXTS = [
        'members only', 'members first',                  // en (+ early access)
        'nur für mitglieder',                             // de
        'solo para miembros', 'sólo para miembros',       // es
        'réservé aux membres', 'réservée aux membres',    // fr
        'solo per i membri',                              // it
        'apenas para membros', 'somente para membros',    // pt
        'alleen voor leden',                              // nl
        'tylko dla wspierających',                        // pl
        'только для спонсоров',                           // ru
        'üyelere özel',                                   // tr
        'メンバー限定',                                    // ja
        '회원 전용',                                       // ko
        '会员专享', '会员专属', '會員專屬', '仅限会员',       // zh
        'للأعضاء فقط'                                     // ar
    ];

    function isMembersText(raw) {
        if (!raw) return false;
        const t = raw.trim().toLowerCase();
        // Badge labels are short; a long string means we grabbed a container.
        if (!t || t.length > 60) return false;
        return MEMBERS_TEXTS.some(s => t.includes(s));
    }

    // Paid / rental tiles. YouTube tags monetised videos with a <badge-shape>
    // carrying the language-independent class ytBadgeShapeCommerce; the label
    // text (mirrored in aria-label) says HOW it's monetised. We hide the ones
    // that cost money (Pay to watch / Buy or rent / Buy) but deliberately leave
    // "Free with ads" — that content is free. Matching the paid labels (rather
    // than the class minus free) means an unlisted-language free badge is never
    // hidden by mistake; a paid tile in an unlisted language is only missed.
    // Language coverage mirrors MEMBERS_TEXTS; the free list is checked first,
    // so its entries can be short stems ("gratis", "無料") without risk.
    // Besides buy/rent wording, YouTube also uses a bare "paid" badge (seen
    // live 2026-07 on the de storefront as "Kostenpflichtig" next to "Kaufen
    // oder ausleihen"), so each language lists its generic "paid" term too.
    // The "płatn"/"платн" stems are substrings of the free words "bezpłatne"/
    // "бесплатно"; the free-list-first check is what keeps those visible.
    const PAID_BADGE_SEL = 'badge-shape.ytBadgeShapeCommerce';
    const FILTER_DETAIL_PROGRESS_HOSTS = [
        'ytd-thumbnail-overlay-resume-playback-renderer',
        'yt-thumbnail-overlay-progress-bar-view-model',
        'ytm-thumbnail-overlay-resume-playback-renderer',
        WATCHED_BAR_CONTAINERS
    ].join(',');
    const FILTER_DETAIL_BADGE_TARGETS = [
        MEMBERS_BADGE_CLASS_SEL,
        MEMBERS_BADGE_TEXT_HOSTS,
        PAID_BADGE_SEL
    ].join(',');
    const PAID_TEXTS = [
        'pay to watch', 'buy or rent', 'rent or buy', 'buy', 'rent',   // en
        'kaufen oder leihen', 'kaufen', 'leihen', 'kostenpflichtig',   // de (leihen ⊂ ausleihen)
        'comprar o alquilar', 'comprar', 'alquilar', 'de pago',        // es
        'acheter ou louer', 'acheter', 'louer', 'payant',              // fr
        'noleggia o acquista', 'noleggia', 'acquista', 'a pagamento',  // it
        'alugar ou comprar', 'alugar', 'pago',                         // pt (comprar = es/pt)
        'huren of kopen', 'huren', 'kopen', 'betaald',                 // nl
        'kup lub wypożycz', 'wypożycz', 'kup', 'płatn',                // pl
        'купить или взять напрокат', 'напрокат', 'купить', 'платн',    // ru
        'satın al veya kirala', 'kirala', 'satın al', 'ücretli',       // tr
        '購入またはレンタル', 'レンタル', '購入', '有料',                  // ja
        '구매 또는 대여', '대여', '구매', '유료',                          // ko
        '购买或租借', '购买', '購買或租借', '購買', '租借', '付費', '付费', // zh
        'شراء أو استئجار', 'استئجار', 'شراء', 'مدفوع'                  // ar
    ];
    const PAID_FREE_TEXTS = [
        'free with ads', 'free to watch', 'watch for free',            // en
        'kostenlos',                                                   // de
        'gratis',                                                      // de/es/it/nl
        'gratuit',                                                     // fr (+ gratuite)
        'grátis', 'gratuito',                                          // pt
        'za darmo', 'darmow', 'bezpłat',                               // pl
        'бесплатно',                                                   // ru
        'ücretsiz',                                                    // tr
        '無料',                                                         // ja
        '무료',                                                         // ko
        '免费', '免費',                                                  // zh
        'مجان'                                                          // ar (مجاني/مجانًا)
    ];

    function isPaidBadgeText(raw) {
        if (!raw) return false;
        const t = raw.trim().toLowerCase();
        if (!t || t.length > 60) return false;
        if (PAID_FREE_TEXTS.some(s => t.includes(s))) return false;   // free: keep it
        return PAID_TEXTS.some(s => t.includes(s));
    }

    const SHORTS_CSS = `
        ytd-guide-entry-renderer:has(a[title="Shorts"]),
        ytd-mini-guide-entry-renderer:has(a[title="Shorts"]),
        ytd-guide-entry-renderer:has(a[href^="/shorts"]),
        ytd-mini-guide-entry-renderer:has(a[href^="/shorts"]),
        ytd-guide-entry-renderer a[title="Shorts"],
        ytd-mini-guide-entry-renderer a[title="Shorts"],
        yt-tab-shape[tab-title="Shorts"],
        yt-tab-shape[tab-title="ショート"],
        tp-yt-paper-tab[aria-label="Shorts"],
        tp-yt-paper-tab[aria-label="ショート"],
        tp-yt-paper-tab:has(> .tab-content[title="Shorts"]),
        tp-yt-paper-tab:has(> .tab-content[title="ショート"]),
        ytm-pivot-bar-item-renderer:has(.pivot-shorts),
        ytm-pivot-bar-item-renderer:has([tab-identifier="pivot-shorts"]),
        ytm-pivot-bar-item-renderer:has(a[href^="/shorts"]),
        ytm-reel-shelf-renderer,
        ytm-rich-section-renderer:has(ytm-reel-shelf-renderer) {
            display: none !important;
        }
    `;

    // Hide the related-sidebar infinite-scroll spinner. visibility:hidden keeps
    // the element's box so it still triggers loading of more recommendations.
    const SPINNER_CSS = `
        ytd-watch-next-secondary-results-renderer tp-yt-paper-spinner,
        ytd-watch-next-secondary-results-renderer tp-yt-paper-spinner-lite,
        ytd-watch-next-secondary-results-renderer yt-spinner,
        ytd-watch-next-secondary-results-renderer .yt-spinner-view-model,
        #secondary ytd-continuation-item-renderer tp-yt-paper-spinner,
        #secondary ytd-continuation-item-renderer tp-yt-paper-spinner-lite,
        #secondary ytd-continuation-item-renderer yt-spinner,
        #secondary ytd-continuation-item-renderer .yt-spinner-view-model {
            visibility: hidden !important;
        }
    `;

    // Remove the in-player suggested-video embeds: the end-screen "video wall"
    // shown when a video finishes (classic .html5-endscreen and the newer
    // .ytp-fullscreen-grid / .ytp-modern-videowall-still layout), plus the
    // pause-screen suggestions.
    const ENDSCREEN_CSS = `
        .html5-endscreen,
        .ytp-endscreen-content,
        .ytp-fullscreen-grid,
        .ytp-videowall-still,
        .ytp-modern-videowall-still,
        .ytp-pause-overlay,
        .ytp-pause-overlay-container {
            display: none !important;
        }
    `;

    /* ==================================================================
     * 0. State load / save / derive
     * ================================================================== */
    function cleanList(arr) {
        return Array.isArray(arr)
            ? [...new Set(arr.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim()))]
            : [];
    }

    function normalize(d) {
        d = d || {};
        return {
            hiddenVideoIds: Array.isArray(d.hiddenVideoIds) ? [...new Set(d.hiddenVideoIds)] : [],
            hiddenVideoMetadata: (d.hiddenVideoMetadata && typeof d.hiddenVideoMetadata === 'object' &&
                                  !Array.isArray(d.hiddenVideoMetadata))
                ? Object.fromEntries(Object.entries(d.hiddenVideoMetadata).slice(0, 2000))
                : {},
            blockedChannels: Array.isArray(d.blockedChannels)
                ? d.blockedChannels.filter(c => c && (c.handle || c.channelId || c.name))
                : [],
            blockedKeywords: cleanList(d.blockedKeywords),
            ytCommentKeywords: cleanList(d.ytCommentKeywords),
            sbWhitelist: Array.isArray(d.sbWhitelist)
                ? d.sbWhitelist.filter(c => c && (c.handle || c.channelId || c.name))
                : [],
            ytChannelSpeeds: (d.ytChannelSpeeds && typeof d.ytChannelSpeeds === 'object' &&
                              !Array.isArray(d.ytChannelSpeeds))
                ? Object.assign({}, d.ytChannelSpeeds)
                : {},
            inputBindings: d.inputBindings && typeof d.inputBindings === 'object'
                ? d.inputBindings : {},
            settings: Object.assign({}, DEFAULT_SETTINGS, d.settings || {})
        };
    }

    // Keywords are plain case-insensitive substrings, or /pattern/flags for
    // regex power users. A bad regex falls back to substring matching.
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
        keywordMatchers = compileMatcherList(state.blockedKeywords);
        commentMatchers = compileMatcherList(state.ytCommentKeywords);
    }

    function rebuildDerived() {
        hiddenSet = new Set(state.hiddenVideoIds);
        blockedIndex = { handles: new Set(), ids: new Set(), names: new Set() };
        for (const c of state.blockedChannels) {
            if (c.handle) blockedIndex.handles.add(c.handle.toLowerCase());
            if (c.channelId) blockedIndex.ids.add(c.channelId);
            if (c.name) blockedIndex.names.add(c.name.toLowerCase().trim());
        }
        sbWhitelistIndex = { handles: new Set(), ids: new Set(), names: new Set() };
        for (const c of state.sbWhitelist) {
            if (c.handle) sbWhitelistIndex.handles.add(c.handle.toLowerCase());
            if (c.channelId) sbWhitelistIndex.ids.add(c.channelId);
            if (c.name) sbWhitelistIndex.names.add(c.name.toLowerCase().trim());
        }
        settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
        sharedInputActionsEnabled = typeof YTBFeatures !== 'undefined' &&
            YTBFeatures.normalizeInputBindings(state.inputBindings).youtube.enabled;
        compileKeywords();

        // Only tile-affecting state invalidates the card cache. Player/chat
        // settings share the same storage record and should not make a 500-card
        // channel reclassify.
        const nextFilterSignature = JSON.stringify({
            hiddenVideoIds: state.hiddenVideoIds,
            blockedChannels: state.blockedChannels,
            blockedKeywords: state.blockedKeywords,
            ytCommentKeywords: state.ytCommentKeywords,
            settings: {
                enabled: settings.enabled,
                blockShorts: settings.blockShorts,
                hideWatched: settings.hideWatched,
                watchedThreshold: settings.watchedThreshold,
                watchedHome: settings.watchedHome,
                watchedSubs: settings.watchedSubs,
                watchedSearch: settings.watchedSearch,
                watchedRelated: settings.watchedRelated,
                watchedChannel: settings.watchedChannel,
                watchedPlaylists: settings.watchedPlaylists,
                revealHidden: settings.revealHidden,
                hidePromos: settings.hidePromos,
                hideMixes: settings.hideMixes,
                hidePlaylists: settings.hidePlaylists,
                hideNewsShelves: settings.hideNewsShelves,
                hideMembersOnly: settings.hideMembersOnly,
                hidePaidVideos: settings.hidePaidVideos
            }
        });
        const filterChanged = !!filterConfigSignature &&
            nextFilterSignature !== filterConfigSignature;
        if (filterChanged) resetTileFiltering();
        filterConfigSignature = nextFilterSignature;

        const on = settings.enabled;
        applyShortsCss(on && settings.blockShorts);
        applySpinnerCss(on && settings.hideSidebarSpinner);
        applyEndScreenCss(on && settings.hideEndScreen);
        if (on && settings.revealHidden) document.documentElement.dataset.ytbReveal = '1';
        else delete document.documentElement.dataset.ytbReveal;
        if (!configVersion || filterChanged) configVersion++;

        if (!shouldGateNewTiles()) endFilterBoot();

        // Category toggles may have changed. Invalidate only category-dependent
        // thumbnail results, and tag watch-page requests with the new generation.
        refreshSbCategoryGeneration();
        sbState = {
            vid: null, segments: null, pending: false,
            generation: sbCategoryGeneration
        };
    }

    async function persist() {
        state = normalize(state);
        rebuildDerived();
        runAll();
        await saveOnly();
    }

    // Persist without re-running the full pass (used by enrichment inside
    // runAll). Load-merge-save: this script only owns the YouTube fields, so
    // pull the full record first rather than clobbering the Twitch lists.
    async function saveOnly() {
        if (retired) return;
        try {
            const stored = await api.storage.local.get(STORAGE_KEY);
            const full = stored[STORAGE_KEY] || {};
            full.hiddenVideoIds = state.hiddenVideoIds;
            full.hiddenVideoMetadata = state.hiddenVideoMetadata;
            full.blockedChannels = state.blockedChannels;
            full.blockedKeywords = state.blockedKeywords;
            full.ytCommentKeywords = state.ytCommentKeywords;
            full.ytChannelSpeeds = state.ytChannelSpeeds;
            full.sbWhitelist = state.sbWhitelist;
            full.settings = Object.assign({}, full.settings, state.settings);
            lastSerialized = JSON.stringify(normalize(full));
            await api.storage.local.set({ [STORAGE_KEY]: full });
        } catch (e) {
            console.warn('[YT Blocker] Could not persist:', e);
        }
    }

    function migrateLegacyLocalStorage() {
        try {
            const raw = window.localStorage.getItem(LEGACY_HIDDEN_KEY);
            if (!raw) return false;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr) || !arr.length) return false;
            const before = hiddenSet.size;
            state.hiddenVideoIds = [...new Set([...state.hiddenVideoIds, ...arr])];
            rebuildDerived();
            return hiddenSet.size > before;
        } catch (e) {
            return false;
        }
    }

    /* ==================================================================
     * 1. Shorts CSS toggle
     * ================================================================== */
    function applyShortsCss(on) {
        let s = document.getElementById('ytb-shorts-style');
        if (on) {
            if (!s) {
                s = document.createElement('style');
                s.id = 'ytb-shorts-style';
                (document.head || document.documentElement).appendChild(s);
            }
            s.textContent = SHORTS_CSS;
        } else if (s) {
            s.remove();
        }
    }

    function applySpinnerCss(on) {
        let s = document.getElementById('ytb-spinner-style');
        if (on) {
            if (!s) {
                s = document.createElement('style');
                s.id = 'ytb-spinner-style';
                (document.head || document.documentElement).appendChild(s);
            }
            s.textContent = SPINNER_CSS;
        } else if (s) {
            s.remove();
        }
    }

    function applyEndScreenCss(on) {
        let s = document.getElementById('ytb-endscreen-style');
        if (on) {
            if (!s) {
                s = document.createElement('style');
                s.id = 'ytb-endscreen-style';
                (document.head || document.documentElement).appendChild(s);
            }
            s.textContent = ENDSCREEN_CSS;
        } else if (s) {
            s.remove();
        }
    }

    /* ==================================================================
     * 2. Redirect /shorts/<id> -> /watch?v=<id>
     * ================================================================== */
    function redirectShortsUrl() {
        if (retired || !settings.enabled || !settings.blockShorts) return;
        if (location.pathname.startsWith('/shorts/')) {
            const id = location.pathname.split('/')[2];
            // Keep the current host so m.youtube.com stays on the mobile site.
            if (id) location.replace(location.origin + '/watch?v=' + id);
        }
    }

    /* ==================================================================
     * 3. Tile helpers
     * ================================================================== */
    function canonicalTile(tile) {
        if (!tile || !tile.closest) return null;
        let target = tile.matches && tile.matches(INNER_CONTAINERS)
            ? tile
            : tile.closest(INNER_CONTAINERS);
        if (!target) return null;
        const outer = target.closest(OUTER_GRID_CELLS);
        return outer || target;
    }

    function observeFilterDetails(root) {
        if (!detailObserver || !root || detailObserved.has(root)) return;
        detailObserved.add(root);
        detailObserver.observe(root, {
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'title', 'class', 'aria-label', 'src'],
            attributeOldValue: true,
            characterData: true
        });
    }

    function removeTile(tile, reason) {
        const target = canonicalTile(tile);
        if (!target) return null;
        target.classList.add('ytb-removed');
        target.classList.remove(FILTER_PENDING_CLASS);
        target.dataset.ytbFilterReason = reason || 'other';
        return target;
    }

    function resetTileFiltering() {
        document.querySelectorAll('.ytb-removed').forEach(el => {
            el.classList.remove('ytb-removed');
            delete el.dataset.ytbFilterReason;
        });
        document.querySelectorAll('.' + FILTER_PENDING_CLASS)
            .forEach(el => el.classList.remove(FILTER_PENDING_CLASS));
        document.querySelectorAll('[data-ytb-keep]')
            .forEach(el => el.removeAttribute('data-ytb-keep'));
        tileCache = new WeakMap();
    }

    // Used by undo and the master switch. The next pass computes every card's
    // current reason again, so settings changes cannot strand stale hidden cards.
    function unhideAll() {
        resetTileFiltering();
    }

    function removeContainingTile(node, reason) {
        const target = node && node.closest && node.closest(INNER_CONTAINERS);
        if (target) removeTile(target, reason);
    }

    function getVideoIdFromNode(node) {
        if (!node) return null;
        const a = node.querySelector('a[href*="/watch?v="]');
        if (!a) return null;
        const href = a.getAttribute('href') || a.href || '';
        const m = href.match(/[?&]v=([^&]+)/);
        return m ? m[1] : null;
    }

    function videoIdFromHref(href) {
        const m = (href || '').match(/[?&]v=([^&]+)/) || (href || '').match(/youtu\.be\/([^?&/]+)/);
        return m ? m[1] : null;
    }

    function findTileFromTarget(target) {
        if (!target || !target.closest) return null;
        return target.closest(OUTER_GRID_CELLS) ||
               target.closest(INNER_CONTAINERS) ||
               null;
    }

    // Merge channel identifiers found across every channel-ish anchor in a tile.
    function getChannelInfoFromNode(node) {
        if (!node) return null;
        let handle = '', channelId = '', name = '';
        const anchors = node.querySelectorAll('a[href]');
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (!href || href.includes('/watch') || href.includes('/shorts/') || href.includes('list=')) continue;
            const idM = href.match(/\/channel\/(UC[\w-]+)/);
            const handleM = href.match(/\/@([\w.\-]+)/);
            const legacy = /^\/(c|user)\//.test(href);
            if (!idM && !handleM && !legacy) continue;
            if (idM && !channelId) channelId = idM[1];
            if (handleM && !handle) handle = handleM[1];
            const t = (a.textContent || '').trim();
            if (t && !name) name = t;
        }
        // Newer lockup tiles render the channel name as plain text (no link),
        // so fall back to reading it from the byline element.
        if (!name) name = getChannelNameFromTile(node);
        if (!handle && !channelId && !name) return null;
        return { handle, channelId, name };
    }

    function cleanText(s) {
        return (s || '').replace(/\s+/g, ' ').trim();
    }

    // Looks like a view-count / date / metadata line rather than a channel name.
    // Covers English plus the most common YouTube UI languages, and a generic
    // "mostly digits/punctuation" check (durations, counts) for the rest.
    const STATS_WORDS = new RegExp([
        // en
        '\\bviews?\\b', 'watching', '\\bago\\b', 'streamed', 'premier', 'subscribers?',
        // de / nl
        'aufrufe', 'abonnenten', 'vor \\d', 'weergaven', 'geleden', 'abonnees',
        // fr
        '\\bvues\\b', 'il y a', 'abonnés',
        // es / pt / it
        'visualizaciones', '\\bvistas\\b', 'hace \\d', 'suscriptores',
        'visualizações', 'há \\d', 'inscritos',
        'visualizzazioni', 'iscritti',
        // pl / ru / tr
        'wyświetl', '\\btemu\\b', 'subskryb',
        'просмотр', 'назад', 'подписчик',
        'görüntüleme', 'önce', '\\babone\\b',
        // ja / ko / zh
        '回視聴', '再生', '時間前', '日前', '週間前', 'か月前', '年前',
        '万 ?回', '視聴回数',
        '조회수', '구독자', '전\\b',
        '观看', '觀看', '订阅', '訂閱',
        // ar
        'مشاهدة', 'مشترك',
        // separators
        '•'
    ].join('|'), 'i');

    function looksLikeStats(t) {
        if (/\d/.test(t) && /^[\d\s.,:%kmb·•]+$/i.test(t)) return true;  // "1.2M", "12:34", "437,921"
        return /\d{1,3}[KMB]?\s*views/i.test(t) || STATS_WORDS.test(t);
    }

    // Video title from a tile, for keyword blocking. Tries the classic
    // renderers first, then the newer lockup view-models, then any heading.
    function getTitleFromNode(node) {
        const el = node.querySelector(
            '#video-title, a#video-title-link, ' +
            '[class*="lockupMetadataViewModelTitle" i], ' +
            'h3 a[title], h3, h4'
        );
        if (el) {
            const t = cleanText(el.getAttribute && el.getAttribute('title') || el.textContent);
            if (t) return t;
        }
        return '';
    }

    // Channel display name from a tile's byline when it isn't a link. Covers the
    // classic ytd-channel-name renderers and the newer view-model lockups, where
    // the channel is the first metadata row of plain text.
    function getChannelNameFromTile(node) {
        const direct = node.querySelector(
            'ytd-channel-name #text, ytd-channel-name yt-formatted-string, ' +
            '#channel-name #text, #channel-name yt-formatted-string, ' +
            '#channel-name a, ytd-channel-name a'
        );
        if (direct) {
            const t = cleanText(direct.textContent);
            if (t) return t;
        }
        // View-model lockups render the channel as the first of several plain
        // <span> metadata texts (channel, then "N views", "•", date). The class
        // is camelCase (ytContentMetadataViewModelMetadataText), so match it
        // case-insensitively and take the first span that isn't a stats line.
        const rows = node.querySelectorAll(
            '[class*="MetadataText" i], ' +
            '[class*="metadata-row" i], ' +
            '[class*="metadata-text" i]'
        );
        for (const r of rows) {
            const t = cleanText(r.textContent);
            if (t && !looksLikeStats(t)) return t;
        }
        return '';
    }

    function getChannelInfoFromAnchor(node) {
        const a = node && node.closest && node.closest('a[href]');
        if (!a) return null;
        const href = a.getAttribute('href') || '';
        const idM = href.match(/\/channel\/(UC[\w-]+)/);
        const handleM = href.match(/\/@([\w.\-]+)/);
        if (!idM && !handleM) return null;
        return {
            channelId: idM ? idM[1] : '',
            handle: handleM ? handleM[1] : '',
            name: (a.textContent || '').trim()
        };
    }

    // When sitting on a channel's own page, read its identity from the page,
    // not just the URL — so legacy custom URLs (/linustechtips, /c/x, /user/x)
    // resolve too. The canonical link gives the UC id for any URL form, and the
    // header gives the @handle + display name.
    function getChannelInfoFromChannelPage() {
        const browse = document.querySelector('ytd-browse[page-subtype="channels"]');
        const path = location.pathname;
        let handle = (path.match(/\/@([\w.\-]+)/) || [])[1] || '';
        let channelId = (path.match(/\/channel\/(UC[\w-]+)/) || [])[1] || '';
        if (!handle && !channelId && !browse) return null;   // not a channel page

        if (!channelId) {
            const canon = document.querySelector('link[rel="canonical"]');
            const cm = canon && (canon.getAttribute('href') || '').match(/\/channel\/(UC[\w-]+)/);
            if (cm) channelId = cm[1];
        }
        const header = document.querySelector(
            'yt-page-header-renderer, ytd-browse[page-subtype="channels"] #page-header, #channel-header, ' +
            'ytm-c4-tabbed-header-renderer, .c4-tabbed-header'
        );
        if (!handle && header) {
            const hLink = header.querySelector('a[href^="/@"]');
            if (hLink) handle = ((hLink.getAttribute('href') || '').match(/\/@([\w.\-]+)/) || [])[1] || '';
            if (!handle) {
                const metaRow = header.querySelector('yt-content-metadata-view-model') || header;
                const tm = (metaRow.textContent || '').match(/@([\w.\-]{2,})/);
                if (tm) handle = tm[1];
            }
        }
        const nameEl = document.querySelector(
            'yt-page-header-renderer h1, yt-dynamic-text-view-model h1, ' +
            'ytd-channel-name #text, #channel-name #text, #channel-header #text, ' +
            'ytm-c4-tabbed-header-renderer h1, .c4-tabbed-header-channel-name'
        );
        const name = nameEl ? cleanText(nameEl.textContent) : '';

        if (!handle && !channelId && !name) return null;
        return { handle, channelId, name };
    }

    // On a watch page, read the channel from the owner/uploader byline. Capture
    // the handle/ID from any owner link AND the display name from the channel
    // name text (the first link is often the text-less avatar), so name-only
    // blocks still match. Falls back to microdata early in the page lifecycle.
    function getWatchPageOwnerInfo() {
        const owner = document.querySelector('ytd-video-owner-renderer, ytm-slim-owner-renderer, #owner');
        if (owner) {
            let handle = '', channelId = '', name = '';
            const link = owner.querySelector('a[href*="/channel/"], a[href^="/@"]');
            if (link) {
                const href = link.getAttribute('href') || '';
                const idM = href.match(/\/channel\/(UC[\w-]+)/);
                const handleM = href.match(/\/@([\w.\-]+)/);
                if (idM) channelId = idM[1];
                if (handleM) handle = handleM[1];
            }
            const nameEl = owner.querySelector(
                'ytd-channel-name #text, #channel-name #text, ' +
                'ytd-channel-name yt-formatted-string, #channel-name a, ' +
                '.slim-owner-channel-name'
            );
            if (nameEl) name = cleanText(nameEl.textContent);
            if (!name) {
                for (const a of owner.querySelectorAll('a[href^="/@"], a[href*="/channel/"]')) {
                    const t = cleanText(a.textContent);
                    if (t) { name = t; break; }
                }
            }
            if (handle || channelId || name) return { handle, channelId, name };
        }
        const author = document.querySelector('span[itemprop="author"]');
        if (author) {
            const urlEl = author.querySelector('link[itemprop="url"]');
            const nameEl = author.querySelector('link[itemprop="name"]');
            const href = urlEl ? (urlEl.getAttribute('href') || '') : '';
            const idM = href.match(/\/channel\/(UC[\w-]+)/);
            const handleM = href.match(/\/@([\w.\-]+)/);
            const name = nameEl ? cleanText(nameEl.getAttribute('content') || '') : '';
            if (idM || handleM || name) {
                return { channelId: idM ? idM[1] : '', handle: handleM ? handleM[1] : '', name };
            }
        }
        return null;
    }

    function tileMatchesBlockedChannel(info) {
        if (!info) return false;
        if (info.channelId && blockedIndex.ids.has(info.channelId)) return true;
        if (info.handle && blockedIndex.handles.has(info.handle.toLowerCase())) return true;
        if (info.name) {
            const n = info.name.toLowerCase().trim();
            if (blockedIndex.names.has(n)) return true;
            // A handle is usually the display name without spaces
            // ("Linus Tech Tips" -> "linustechtips"), so match that too.
            const compact = n.replace(/\s+/g, '');
            if (compact.length >= 5 && blockedIndex.handles.has(compact)) return true;
        }
        return false;
    }

    function sameChannel(a, b) {
        if (a.channelId && b.channelId) return a.channelId === b.channelId;
        if (a.handle && b.handle) return a.handle.toLowerCase() === b.handle.toLowerCase();
        if (a.name && b.name) return a.name.toLowerCase().trim() === b.name.toLowerCase().trim();
        return false;
    }

    /* ==================================================================
     * 4. Removal passes
     * ================================================================== */
    function flattenRows() {
        document.querySelectorAll('ytd-rich-grid-renderer').forEach(grid => {
            const outerContents = grid.querySelector(':scope > #contents');
            if (!outerContents) return;
            grid.querySelectorAll(':scope > #contents > ytd-rich-grid-row').forEach(row => {
                const rowContents = row.querySelector(':scope > #contents');
                if (!rowContents) {
                    if (!row.children.length) row.remove();
                    return;
                }
                while (rowContents.firstChild) {
                    outerContents.insertBefore(rowContents.firstChild, row);
                }
                row.remove();
            });
        });
    }

    function hideEl(el) {
        if (el && !el.classList.contains('ytb-removed')) el.classList.add('ytb-removed');
    }

    // Rich sections (Shorts shelves, news, "Trending", topic rows). Hidden when
    // blocking Shorts (historic behaviour) or via the dedicated toggle.
    function removeRichSections() {
        document.querySelectorAll('ytd-rich-grid-renderer').forEach(grid => {
            grid.querySelectorAll(':scope > #contents > ytd-rich-section-renderer:not(.ytb-removed)')
                .forEach(hideEl);
        });
    }

    function removeShortsSurfaces() {
        document.querySelectorAll([
            'ytd-rich-shelf-renderer[is-shorts]:not(.ytb-removed)',
            'ytd-reel-shelf-renderer:not(.ytb-removed)',
            'ytd-reel-item-renderer:not(.ytb-removed)',
            'ytm-shorts-lockup-view-model:not(.ytb-removed)',
            'ytm-shorts-lockup-view-model-v2:not(.ytb-removed)',
            'ytm-reel-shelf-renderer:not(.ytb-removed)',
            'ytm-reel-item-renderer:not(.ytb-removed)'
        ].join(',')).forEach(hideEl);
        document.querySelectorAll('a[href*="/shorts/"]').forEach(a => {
            const cell = a.closest(OUTER_GRID_CELLS) || a.closest('yt-lockup-view-model');
            if (cell && !cell.classList.contains('ytb-removed')) hideEl(cell);
        });
    }

    function removeNonVideoCards() {
        document.querySelectorAll(NON_VIDEO_CARDS).forEach(card => {
            const cell = card.closest(OUTER_GRID_CELLS) || card;
            hideEl(cell);
        });
    }

    // Mixes (auto-generated radio) and playlist tiles in feeds. Skipped on
    // playlist-y pages so the playlist you're actually viewing survives, and
    // never applied to the watch-page queue panel (its rows aren't tiles).
    function removeMixesAndPlaylists() {
        if (settings.hideMixes) {
            document.querySelectorAll('a[href*="list=RD"], a[href*="start_radio=1"]').forEach(a => {
                const cell = a.closest(INNER_CONTAINERS) || a.closest(OUTER_GRID_CELLS);
                if (cell) removeTile(cell);
            });
        }
        if (settings.hidePlaylists &&
            !location.pathname.startsWith('/playlist') &&
            !location.pathname.startsWith('/feed/')) {
            document.querySelectorAll('a[href^="/playlist?"]').forEach(a => {
                const cell = a.closest(INNER_CONTAINERS) || a.closest(OUTER_GRID_CELLS);
                if (cell) removeTile(cell);
            });
            document.querySelectorAll(
                'ytd-playlist-renderer:not(.ytb-removed), ytd-grid-playlist-renderer:not(.ytb-removed), ytd-compact-playlist-renderer:not(.ytb-removed), ytd-radio-renderer:not(.ytb-removed), ytd-compact-radio-renderer:not(.ytb-removed), ytm-playlist-renderer:not(.ytb-removed), ytm-compact-playlist-renderer:not(.ytb-removed), ytm-radio-renderer:not(.ytb-removed), ytm-compact-radio-renderer:not(.ytb-removed)'
            ).forEach(hideEl);
        }
    }

    // Members-only videos, matched by their thumbnail/metadata badge. The
    // badge elements are few, so scanning them and walking up with closest()
    // is cheap (same pattern as the watched-progress passes).
    function removeMembersOnly() {
        document.querySelectorAll(MEMBERS_BADGE_CLASS_SEL).forEach(badge => {
            if (badge.closest('.ytb-removed')) return;   // tile already hidden
            removeContainingTile(badge);
        });
        document.querySelectorAll(MEMBERS_BADGE_TEXT_HOSTS).forEach(badge => {
            if (badge.closest('.ytb-removed')) return;
            if (!isMembersText(badge.textContent)) return;
            removeContainingTile(badge);
        });
    }

    // Paid / rental videos, matched by their commerce badge. Mirrors the
    // members-only pass: scan the badges, skip free-with-ads, hide the tile.
    function removePaidVideos() {
        document.querySelectorAll(PAID_BADGE_SEL).forEach(badge => {
            if (badge.closest('.ytb-removed')) return;   // tile already hidden
            if (!isPaidBadgeText(badge.getAttribute('aria-label') || badge.textContent)) return;
            removeContainingTile(badge);
        });
    }

    // Which surface are we on, and is watched-hiding enabled for it?
    function watchedAllowedHere() {
        const p = location.pathname;
        let key = null;
        if (p === '/watch') key = 'watchedRelated';
        else if (p === '/') key = 'watchedHome';
        else if (p.startsWith('/feed/subscriptions')) key = 'watchedSubs';
        else if (p.startsWith('/results')) key = 'watchedSearch';
        else if (p.startsWith('/playlist')) key = 'watchedPlaylists';
        else if (p.startsWith('/@') || p.startsWith('/channel/') ||
                 p.startsWith('/c/') || p.startsWith('/user/')) key = 'watchedChannel';
        return key === null ? true : !!settings[key];
    }

    // Record a tile YouTube's progress bar reports as watched into the local
    // database (migration: newly-detected watched videos are remembered so we
    // still hide them once YouTube inevitably drops the bar), and attribute it
    // to the current channel page for the "Watched X/Y" badge.
    function markTileWatched(node) {
        if (!WatchedDB || !node) return;
        const tile = node.closest(INNER_CONTAINERS) || node;
        const id = getVideoIdFromNode(tile);
        if (!id) return;
        // A video the user manually hid stays categorized as hidden, even if it
        // still shows a progress bar — the explicit hide wins over the tally.
        if (hiddenSet.has(id)) {
            if (curChannelInfo) WatchedDB.recordChannelHidden(curChannelInfo, id);
            return;
        }
        WatchedDB.markWatched(id);
        if (curChannelInfo) WatchedDB.recordChannelVideo(curChannelInfo, id);
    }

    function getTileWatchedPercent(tile) {
        let max = null;
        const readWidth = (el) => {
            const width = el && el.style && el.style.width;
            if (!width) return;
            const pct = parseFloat(width);
            if (!isNaN(pct)) max = max === null ? pct : Math.max(max, pct);
        };

        tile.querySelectorAll(PROGRESS_SELECTORS).forEach(readWidth);
        tile.querySelectorAll(WATCHED_BAR_CONTAINERS).forEach(container => {
            container.querySelectorAll('[style*="width"]').forEach(readWidth);
        });
        return max;
    }

    function processWatchedProgress() {
        if (!settings.hideWatched || !watchedAllowedHere()) return;
        const percentages = new Map();
        document.querySelectorAll(WATCHED_PROGRESS_MARKERS).forEach(marker => {
            const tile = canonicalTile(marker);
            if (!tile || tile.closest('.ytb-removed')) return;
            const pct = parseFloat(marker.style && marker.style.width);
            if (isNaN(pct)) return;
            const previous = percentages.get(tile);
            if (previous == null || pct > previous) percentages.set(tile, pct);
        });
        for (const [tile, pct] of percentages) {
            if (pct < settings.watchedThreshold) continue;
            markTileWatched(tile);
            removeTile(tile, 'watched-progress');
        }
    }

    function tileFilterContext() {
        const checkWatched = !!settings.hideWatched && watchedAllowedHere();
        const hidePlaylistsHere = !!settings.hidePlaylists &&
            !location.pathname.startsWith('/playlist') &&
            !location.pathname.startsWith('/feed/');
        return {
            // Per-surface watched rules and channel attribution can change on
            // SPA navigation even when YouTube reuses the exact same card node.
            version: configVersion + ':' +
                (WatchedDB && WatchedDB.revision ? WatchedDB.revision() : 0) +
                ':' + location.pathname + ':' +
                (curChannelInfo
                    ? (curChannelInfo.handle || curChannelInfo.channelId || curChannelInfo.name || '')
                    : ''),
            checkWatched,
            checkChannels: state.blockedChannels.length > 0,
            checkKeywords: keywordMatchers.length > 0,
            attributeChannel: !!(WatchedDB && curChannelInfo),
            blockShorts: !!settings.blockShorts,
            hideMixes: !!settings.hideMixes,
            hidePlaylists: hidePlaylistsHere,
            hideMembers: !!settings.hideMembersOnly,
            hidePaid: !!settings.hidePaidVideos,
            active: !!settings.enabled && (
                hiddenSet.size > 0 || checkWatched ||
                state.blockedChannels.length > 0 || keywordMatchers.length > 0 ||
                settings.blockShorts || settings.hideMixes || hidePlaylistsHere ||
                settings.hideMembersOnly || settings.hidePaidVideos
            )
        };
    }

    function shouldGateNewTiles() {
        if (!settings.enabled || settings.revealHidden || !settings.reduceFlashing) return false;
        return tileFilterContext().active;
    }

    function tileHasMembersBadge(tile) {
        if (tile.querySelector(MEMBERS_BADGE_CLASS_SEL)) return true;
        for (const badge of tile.querySelectorAll(MEMBERS_BADGE_TEXT_HOSTS)) {
            if (isMembersText(badge.textContent)) return true;
        }
        return false;
    }

    function tileHasPaidBadge(tile) {
        for (const badge of tile.querySelectorAll(PAID_BADGE_SEL)) {
            if (isPaidBadgeText(badge.getAttribute('aria-label') || badge.textContent)) return true;
        }
        return false;
    }

    function classifyTile(tile, id, ctx) {
        let cacheable = !!id;

        if (ctx.blockShorts &&
            (tile.matches('ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ' +
                          'ytm-shorts-lockup-view-model-v2, ytm-reel-item-renderer') ||
             tile.querySelector('a[href*="/shorts/"]'))) {
            return { reason: 'shorts', cacheable };
        }
        if (ctx.hideMixes && tile.querySelector('a[href*="list=RD"], a[href*="start_radio=1"]')) {
            return { reason: 'mix', cacheable };
        }
        if (ctx.hidePlaylists &&
            (tile.matches('ytd-playlist-renderer, ytd-grid-playlist-renderer, ' +
                          'ytd-compact-playlist-renderer, ytd-radio-renderer, ' +
                          'ytd-compact-radio-renderer, ytm-playlist-renderer, ' +
                          'ytm-compact-playlist-renderer, ytm-radio-renderer, ' +
                          'ytm-compact-radio-renderer') ||
             tile.querySelector('a[href^="/playlist?"]'))) {
            return { reason: 'playlist', cacheable };
        }
        if (ctx.hideMembers && tileHasMembersBadge(tile)) {
            return { reason: 'members-only', cacheable };
        }
        if (ctx.hidePaid && tileHasPaidBadge(tile)) {
            return { reason: 'paid', cacheable };
        }
        if (id && hiddenSet.has(id)) {
            if (ctx.attributeChannel) WatchedDB.recordChannelHidden(curChannelInfo, id);
            return { reason: 'hidden-id', cacheable };
        }
        if (ctx.checkWatched && id && WatchedDB && WatchedDB.isWatched(id)) {
            if (ctx.attributeChannel) WatchedDB.recordChannelVideo(curChannelInfo, id);
            return { reason: 'watched-history', cacheable };
        }
        if (ctx.checkWatched && ctx.checkProgress) {
            const pct = getTileWatchedPercent(tile);
            if (pct !== null && pct >= settings.watchedThreshold) {
                markTileWatched(tile);
                return { reason: 'watched-progress', cacheable };
            }
        }

        if (ctx.checkChannels) {
            const channel = getChannelInfoFromNode(tile);
            if (!channel) cacheable = false;
            else if (tileMatchesBlockedChannel(channel)) {
                return { reason: 'blocked-channel', cacheable };
            }
        }
        if (ctx.checkKeywords) {
            const title = getTitleFromNode(tile).toLowerCase();
            if (!title) cacheable = false;
            else if (keywordMatchers.some(fn => fn(title))) {
                return { reason: 'blocked-keyword', cacheable };
            }
        }
        return { reason: '', cacheable };
    }

    function evaluateTile(tile, ctx, force) {
        const target = canonicalTile(tile);
        if (!target) return;
        observeFilterDetails(target);

        const id = getVideoIdFromNode(target) || '';
        const previous = tileCache.get(target);
        if (!force && previous &&
            previous.version === ctx.version && previous.videoId === id) {
            // YouTube occasionally strips classes while reusing the same card.
            // Keep the cached decision cheap, but repair the managed DOM state.
            if (previous.reason &&
                (!target.classList.contains('ytb-removed') ||
                 target.dataset.ytbFilterReason !== previous.reason)) {
                removeTile(target, previous.reason);
            } else if (!previous.reason && target.dataset.ytbFilterReason) {
                target.classList.remove('ytb-removed');
                delete target.dataset.ytbFilterReason;
            }
            return;
        }

        // YouTube recycles renderer elements. A managed reason belongs to the
        // old video, not to the DOM node, so identity changes are reclassified.
        if (previous && previous.videoId !== id && target.dataset.ytbFilterReason) {
            target.classList.remove('ytb-removed');
            delete target.dataset.ytbFilterReason;
        }

        const result = classifyTile(target, id, ctx);
        if (result.reason) {
            removeTile(target, result.reason);
        } else if (target.dataset.ytbFilterReason) {
            target.classList.remove('ytb-removed');
            delete target.dataset.ytbFilterReason;
        }

        if (result.cacheable) {
            tileCache.set(target, { version: ctx.version, videoId: id, reason: result.reason });
        } else {
            tileCache.delete(target); // never freeze a partially hydrated shell
        }
    }

    function addTileCandidates(node, tiles) {
        if (!node || node.nodeType !== 1 || !node.closest) return;
        const ancestor = node.closest(INNER_CONTAINERS);
        if (ancestor) {
            const tile = canonicalTile(ancestor);
            if (tile) tiles.add(tile);
        }
        if (node.matches(INNER_CONTAINERS)) {
            const tile = canonicalTile(node);
            if (tile) tiles.add(tile);
        }
        node.querySelectorAll(INNER_CONTAINERS).forEach(inner => {
            const tile = canonicalTile(inner);
            if (tile) tiles.add(tile);
        });
    }

    function collectAllTiles() {
        const tiles = new Set();
        document.querySelectorAll(INNER_CONTAINERS).forEach(inner => {
            const tile = canonicalTile(inner);
            if (tile) tiles.add(tile);
        });
        return tiles;
    }

    function addClosestTileCandidate(node, tiles) {
        if (!node || node.nodeType !== 1 || !node.closest) return;
        const ancestor = node.closest(INNER_CONTAINERS);
        if (!ancestor) return;
        const tile = canonicalTile(ancestor);
        if (tile) tiles.add(tile);
    }

    function collectMutationTiles(records) {
        const tiles = new Set();

        for (const record of records) {
            if (record.type === 'attributes') {
                const target = record.target;
                if (record.attributeName === 'style' &&
                    !(target.matches && (target.matches(INNER_CONTAINERS) ||
                      target.matches(PROGRESS_SELECTORS))) &&
                    !(target.closest && target.closest(FILTER_DETAIL_PROGRESS_HOSTS))) continue;
                if ((record.attributeName === 'class' ||
                     record.attributeName === 'aria-label') &&
                    !(target.matches && target.matches(FILTER_DETAIL_BADGE_TARGETS)) &&
                    !(record.attributeName === 'class' &&
                      /badge-style-type-members-only|ytBadgeShapeCommerce/
                          .test(record.oldValue || ''))) continue;
                addClosestTileCandidate(target, tiles);
                continue;
            }
            if (record.type === 'characterData') {
                addClosestTileCandidate(record.target && record.target.parentElement, tiles);
                continue;
            }
            record.addedNodes.forEach(node => addTileCandidates(node, tiles));
            // A removed child can turn a recycled renderer into a new/incomplete
            // shell. Revisit only its nearest surviving card; querying the whole
            // parent grid here would turn a one-card append back into a full scan.
            addClosestTileCandidate(record.target, tiles);
        }
        return tiles;
    }

    function processTiles(tiles, force, checkProgress) {
        const ctx = tileFilterContext();
        ctx.checkProgress = checkProgress !== false;
        if (!ctx.active) {
            const managed = tiles
                ? [...tiles].filter(tile => tile.dataset && tile.dataset.ytbFilterReason)
                : document.querySelectorAll('[data-ytb-filter-reason]');
            managed.forEach(tile => {
                tile.classList.remove('ytb-removed');
                delete tile.dataset.ytbFilterReason;
                tileCache.delete(tile);
            });
            return tiles || null;
        }
        const candidates = tiles || collectAllTiles();
        for (const tile of candidates) evaluateTile(tile, ctx, !!force);
        return candidates;
    }

    function filterMutatedTiles(records) {
        const tiles = collectMutationTiles(records);
        if (retired || !settings.enabled || !tiles.size) return tiles;

        if (WatchedDB) curChannelInfo = getChannelInfoFromChannelPage();
        const gate = shouldGateNewTiles();
        if (gate) {
            tiles.forEach(tile => {
                if (!tile.classList.contains('ytb-removed')) tile.classList.add(FILTER_PENDING_CLASS);
            });
        }

        try {
            // MutationObserver callbacks run before the next paint. Only dirty
            // canonical cards are classified here; slower page/player work stays
            // in the trailing maintenance pass.
            processTiles(tiles, true);
        } finally {
            tiles.forEach(tile => tile.classList.remove(FILTER_PENDING_CLASS));
        }
        return tiles;
    }
    // The in-player end-screen "video wall" uses its own markup (not ytd-* tiles)
    // and has no watched indicator, so apply the hidden-id and blocked-channel
    // lists here. (Use Ctrl+right-click to hide an individual one.)
    function processEndScreen() {
        if (!hiddenSet.size && !state.blockedChannels.length) return;
        const stills = document.querySelectorAll('a.ytp-videowall-still, a.ytp-modern-videowall-still');
        for (const still of stills) {
            if (still.style.display === 'none') continue;
            const id = videoIdFromHref(still.getAttribute('href') || still.href || '');
            if (id && hiddenSet.has(id)) { still.style.display = 'none'; continue; }
            if (state.blockedChannels.length) {
                const author = still.querySelector('[class*="still-info-author"]');
                const name = author ? (author.textContent || '').split('•')[0].trim() : '';
                if (name && tileMatchesBlockedChannel({ handle: '', channelId: '', name })) {
                    still.style.display = 'none';
                }
            }
        }
    }

    const COMMENT_RENDERERS =
        'ytd-comment-view-model, ytd-comment-renderer, ytm-comment-renderer';

    // Hide comments (and single replies) whose text matches the comment
    // keyword list. Same syntax as title keywords; hidden with .ytb-removed
    // so audit mode reveals them dimmed like everything else.
    function processComments() {
        if (!commentMatchers.length || location.pathname !== '/watch') return;
        const comments = document.querySelectorAll(COMMENT_RENDERERS);
        for (const c of comments) {
            observeFilterDetails(c);
            if (c.closest('.ytb-removed')) continue;
            const key = 'c' + configVersion;
            if (c.dataset.ytbCchk === key) continue;
            const textEl = c.querySelector('#content-text');
            const text = textEl ? (textEl.textContent || '').toLowerCase() : '';
            if (text && commentMatchers.some(fn => fn(text))) {
                const thread = c.closest('ytd-comment-thread-renderer, ytm-comment-thread-renderer');
                // Top-level comment: drop the whole thread. Reply: just it.
                const top = thread && thread.querySelector(COMMENT_RENDERERS);
                hideEl(thread && c === top ? thread : c);
            } else {
                c.dataset.ytbCchk = key;
            }
        }
    }

    // Comment text is frequently hydrated without inserting a new renderer.
    // Invalidate only the affected comment cache, then let processComments skip
    // every unchanged renderer instead of scheduling the full page pipeline.
    function refreshMutatedComments(records) {
        if (!commentMatchers.length || location.pathname !== '/watch') return;
        const dirty = new Set();
        const add = node => {
            const el = node && node.nodeType === 1 ? node : node && node.parentElement;
            if (!el || !el.closest) return;
            const comment = el.matches && el.matches(COMMENT_RENDERERS)
                ? el : el.closest(COMMENT_RENDERERS);
            if (comment) dirty.add(comment);
            if (el.querySelectorAll) {
                el.querySelectorAll(COMMENT_RENDERERS).forEach(item => dirty.add(item));
            }
        };
        for (const record of records) {
            add(record.target);
            if (record.addedNodes) record.addedNodes.forEach(add);
        }
        if (!dirty.size) return;
        dirty.forEach(comment => { delete comment.dataset.ytbCchk; });
        processComments();
    }

    /* ---- watch-page conveniences ------------------------------------- */
    function watchVideoId() {
        return location.pathname === '/watch'
            ? new URLSearchParams(location.search).get('v')
            : null;
    }

    // "Video paused. Continue watching?" — YouTube fires this off an idle
    // timer it keeps in the page-global `_lact` (last activity, ms). Keeping
    // that fresh prevents the dialog outright (the YouTube NonStop trick);
    // clicking the confirm button is the fallback if one still appears.
    const PAUSE_DIALOG_TEXTS = [
        'continue watching', 'video paused',
        'wiedergabe fortsetzen', 'video pausiert',            // de
        'continuer la lecture', 'vidéo en pause',             // fr
        'continuar viendo', 'vídeo en pausa',                 // es
        'continuar assistindo', 'vídeo pausado',              // pt
        'continuare a guardare',                              // it
        'verder kijken',                                      // nl
        'kontynuować oglądanie',                              // pl
        'продолжить просмотр',                                // ru
        'izlemeye devam',                                     // tr
        '再生を続行', '動画が一時停止',                          // ja
        '계속 시청',                                           // ko
        '继续观看', '繼續觀看'                                  // zh
    ];
    let lastLactRefresh = 0;

    function preventIdlePause() {
        if (!settings.ytNoPauseDialog || location.pathname !== '/watch') return;
        try {
            if (Date.now() - lastLactRefresh > 30000) {
                lastLactRefresh = Date.now();
                const pw = window.wrappedJSObject;
                if (pw && typeof pw._lact === 'number') pw._lact = Date.now();
                // Chromium's isolated world cannot reach the page global;
                // page-quality.js refreshes _lact in the MAIN world.
                else window.postMessage({ type: 'ytb-lact' }, location.origin);
            }
        } catch (e) { /* page global unavailable */ }
        const dlg = document.querySelector('ytd-popup-container yt-confirm-dialog-renderer');
        if (!dlg || !isVisible(dlg)) return;
        const text = (dlg.textContent || '').toLowerCase();
        if (!PAUSE_DIALOG_TEXTS.some(s => text.includes(s))) return;
        const btn = dlg.querySelector('#confirm-button button') || dlg.querySelector('#confirm-button');
        if (!btn) return;
        try {
            btn.click();
            const v = playerVideo();
            if (v && v.paused) v.play().catch(() => {});
        } catch (e) { /* ignore */ }
    }

    // Keep YouTube's up-next autoplay toggle off. One click normally sticks
    // for the session/account; the guard stops a click loop if it doesn't.
    let autoplayClickAt = 0;
    function enforceAutoplayOff() {
        if (!settings.ytDisableAutoplay || location.pathname !== '/watch') return;
        if (Date.now() - autoplayClickAt < 5000) return;
        const btn = document.querySelector('#movie_player .ytp-autonav-toggle-button');
        if (btn && btn.getAttribute('aria-checked') === 'true') {
            autoplayClickAt = Date.now();
            try { btn.click(); } catch (e) { /* ignore */ }
        }
    }

    let expandedVideoId = null;
    function autoExpandDescription() {
        if (!settings.ytAutoExpandDesc || location.pathname !== '/watch') return;
        const vid = watchVideoId();
        if (!vid || vid === expandedVideoId) return;
        const expander = document.querySelector('ytd-text-inline-expander#description-inline-expander');
        if (!expander) return;
        if (expander.hasAttribute('is-expanded')) { expandedVideoId = vid; return; }
        const btn = expander.querySelector('tp-yt-paper-button#expand, #expand');
        if (btn && isVisible(btn)) {
            expandedVideoId = vid;
            try { btn.click(); } catch (e) { /* ignore */ }
        }
    }

    /* ==================================================================
     * 4a. Watched-video database: the robust, YouTube-independent signal.
     *   - A timeupdate hook on the main player records the video you're
     *     watching once playback passes the threshold, so the database is
     *     built from your actual viewing rather than the flaky progress bar.
     *   - On a channel page, a "Watched N / total" badge shows how many of
     *     that channel's videos are in the database (denominator scraped
     *     from the channel header).
     * ================================================================== */
    let watchedMarkedVid = null;      // last video already recorded this session

    function ensureWatchedHook(v) {
        if (!v || !WatchedDB || v.dataset.ytbWatchHook === INSTANCE_ID) return;
        v.dataset.ytbWatchHook = INSTANCE_ID;
        v.addEventListener('timeupdate', () => {
            if (retired || !settings.enabled || !settings.hideWatched) return;
            if (location.pathname !== '/watch' || isLivePlayer()) return;
            const vid = watchVideoId();
            if (!vid || vid === watchedMarkedVid) return;
            const dur = v.duration, cur = v.currentTime;
            if (!isFinite(dur) || dur <= 0) return;
            if ((cur / dur) * 100 >= settings.watchedThreshold) {
                watchedMarkedVid = vid;
                WatchedDB.markWatched(vid);
                const owner = getWatchPageOwnerInfo();
                if (owner) WatchedDB.recordChannelVideo(owner, vid);
            }
        });
    }

    // "513 videos" from the channel header, across the most common UI
    // languages, plus a CJK fallback. Thousands separators (',' '.' ' ')
    // are stripped so "1,234 videos" -> 1234. Returns null if not shown.
    const VIDEO_COUNT_RE = /([\d][\d., \s]*)\s*(?:videos?|vídeos?|vidéos?|videa|filmy|видео|βίντεο|video)\b/i;
    const VIDEO_COUNT_CJK = /([\d][\d., \s]*)\s*(?:本の動画|個の動画|動画|部影片|個影片|个视频|部视频|视频|동영상|개의\s*동영상)/;

    function channelHeaderEl() {
        return document.querySelector('yt-page-header-renderer') ||
               document.querySelector('ytd-browse[page-subtype="channels"] #page-header') ||
               document.querySelector('ytm-c4-tabbed-header-renderer, .c4-tabbed-header') ||
               document.querySelector('#channel-header');
    }

    function channelHeaderMetaEl() {
        const header = channelHeaderEl();
        if (!header) return null;
        return header.querySelector('yt-content-metadata-view-model') ||
               header.querySelector('#meta, #channel-header-container, .page-header-view-model-wiz__page-header-content') ||
               header;
    }

    function parseChannelVideoTotal() {
        // Read the metadata row (subscribers · videos), not the whole header —
        // the header also carries the "Videos" tab label, which would misfire.
        const header = channelHeaderMetaEl() || channelHeaderEl();
        if (!header) return null;
        const text = header.textContent || '';
        const m = text.match(VIDEO_COUNT_RE) || text.match(VIDEO_COUNT_CJK);
        if (!m) return null;
        const n = parseInt(m[1].replace(/[., \s]/g, ''), 10);
        return isNaN(n) ? null : n;
    }

    // The metadata row itself (handle · subscribers · videos). Used as the
    // insertion anchor so our stats line sits directly beneath it, left-aligned
    // and in the same font, rather than being crammed into the flex row.
    function channelMetaViewModel() {
        return document.querySelector('yt-page-header-renderer yt-content-metadata-view-model') ||
               document.querySelector('#page-header yt-content-metadata-view-model') ||
               null;
    }

    function removeChannelBadge() {
        const el = document.getElementById('ytb-channel-stats');
        if (el) el.remove();
    }

    function statSpan(label, value, tip) {
        const span = document.createElement('span');
        span.className = 'ytb-stat';
        if (tip) span.title = tip;
        span.appendChild(document.createTextNode(label + ' '));
        const b = document.createElement('b');
        b.textContent = value;
        span.appendChild(b);
        return span;
    }

    // A "Watched N / total  ·  Hidden M" line. Watched always shows on a channel
    // page; Hidden only when there is at least one, to avoid clutter.
    //
    // CRITICAL: this must be idempotent. runAll fires on every DOM mutation, and
    // this element lives inside the observed <body> subtree, so rebuilding it
    // unconditionally makes every render trigger another pass — a runaway loop
    // that pins the CPU and stops YouTube from loading thumbnails. So we only
    // touch the DOM when the values (cached in a data-* attribute the childList
    // observer ignores) or the placement actually change.
    function renderChannelStats(watched, total, hidden) {
        const meta = channelMetaViewModel();
        const host = channelHeaderMetaEl();
        if (!meta && !host) return;
        const sig = watched + '/' + (total == null ? '?' : total) + '|' + hidden;
        let el = document.getElementById('ytb-channel-stats');
        const placedOk = !!el && (meta
            ? (el.parentElement === meta.parentElement && el.previousElementSibling === meta)
            : (el.parentElement === host));
        if (el && el.dataset.ytbSig === sig && placedOk) return;   // nothing to do
        if (!el) {
            el = document.createElement('div');
            el.id = 'ytb-channel-stats';
        }
        if (!placedOk) {
            if (meta && meta.parentElement) meta.parentElement.insertBefore(el, meta.nextSibling);
            else if (host) host.appendChild(el);
        }
        if (el.dataset.ytbSig === sig) return;   // placement fixed, content already current
        el.dataset.ytbSig = sig;
        el.textContent = '';
        el.appendChild(statSpan('Watched',
            (total != null && total > 0) ? (watched + ' / ' + total) : String(watched),
            'Videos from this channel in your local watched history'));
        if (hidden > 0) {
            const sep = document.createElement('span');
            sep.className = 'ytb-stat-sep';
            sep.textContent = '•';
            el.appendChild(sep);
            el.appendChild(statSpan('Hidden', String(hidden),
                'Videos from this channel you have hidden'));
        }
    }

    function updateChannelWatchBadge() {
        if (!WatchedDB || !curChannelInfo) { removeChannelBadge(); return; }
        const total = parseChannelVideoTotal();
        if (total != null) WatchedDB.setChannelTotal(curChannelInfo, total);
        const stats = WatchedDB.getChannelStats(curChannelInfo) || { watched: 0, total: null, hidden: 0 };
        renderChannelStats(stats.watched, stats.total != null ? stats.total : total, stats.hidden || 0);
    }

    /* ==================================================================
     * 4b. Community data (opt-in): SponsorBlock skipping, DeArrow titles/
     * thumbnails, Return YouTube Dislike counts. All lookups go through
     * the background script (see background.js for API/licence notes).
     * ================================================================== */
    const SB_CATEGORIES = [
        ['sponsor', 'sbSkipSponsor', 'sponsor'],
        ['selfpromo', 'sbSkipSelfpromo', 'self-promo'],
        ['interaction', 'sbSkipInteraction', 'interaction reminder'],
        ['intro', 'sbSkipIntro', 'intro'],
        ['outro', 'sbSkipOutro', 'outro'],
        ['preview', 'sbSkipPreview', 'preview'],
        ['music_offtopic', 'sbSkipOfftopic', 'non-music section'],
        ['filler', 'sbSkipFiller', 'filler']
    ];
    let sbState = { vid: null, segments: null, pending: false, generation: 0 };
    let sbLastSkipAt = 0;

    function sbWantedCategories() {
        return SB_CATEGORIES.filter(([, key]) => settings[key]).map(([cat]) => cat);
    }

    function sbLabel(cat) {
        const hit = SB_CATEGORIES.find(([c]) => c === cat);
        return hit ? hit[2] : cat;
    }

    // ---- SponsorBlock per-channel whitelist ----------------------------
    // Whitelisted channels keep their segment markers but are never
    // auto-skipped (mirrors the official extension). The current watch
    // page's state is cached per video so the timeupdate hook stays cheap.
    let sbWl = { vid: null, on: false };

    function isSbWhitelisted(info) {
        if (!info) return false;
        if (info.channelId && sbWhitelistIndex.ids.has(info.channelId)) return true;
        if (info.handle && sbWhitelistIndex.handles.has(info.handle.toLowerCase())) return true;
        if (info.name) {
            const n = info.name.toLowerCase().trim();
            if (sbWhitelistIndex.names.has(n)) return true;
            const compact = n.replace(/\s+/g, '');
            if (compact.length >= 5 && sbWhitelistIndex.handles.has(compact)) return true;
        }
        return false;
    }

    function refreshSbWhitelist() {
        const vid = watchVideoId();
        if (location.pathname !== '/watch' || !vid) { sbWl = { vid: null, on: false }; return; }
        sbWl = { vid, on: isSbWhitelisted(getWatchPageOwnerInfo()) };
    }

    function currentChannelWhitelisted() {
        return sbWl.vid === watchVideoId() && sbWl.on;
    }

    // Add/remove the current watch-page channel from the whitelist (called
    // from the shield panel's toggle).
    function toggleSbWhitelist(info) {
        if (!info || (!info.handle && !info.channelId && !info.name)) return;
        const idx = state.sbWhitelist.findIndex(c => sameChannel(c, info));
        if (idx >= 0) {
            state.sbWhitelist.splice(idx, 1);
            toast('Removed from SponsorBlock whitelist');
        } else {
            state.sbWhitelist.push({
                name: info.name || '', handle: info.handle || '',
                channelId: info.channelId || '', addedAt: Date.now()
            });
            toast('Channel whitelisted', 'segments stay, no auto-skip');
        }
        // persist() rebuilds the index and forces a segment refetch; the
        // segments themselves don't change, so keep them shown to avoid a
        // "looking up…" flash in the open panel.
        const keepSb = sbState;
        persist();
        if (keepSb && keepSb.vid === watchVideoId() && keepSb.segments) sbState = keepSb;
        refreshSbWhitelist();
        renderSbPanel();
    }

    function ensureSbHook(v) {
        if (v.dataset.ytbSbHook === INSTANCE_ID) return;
        v.dataset.ytbSbHook = INSTANCE_ID;
        v.addEventListener('timeupdate', () => {
            if (retired || !settings.enabled || !settings.sbEnabled || v.paused) return;
            // One-shot local jump for the panel's "Test skip" — works before
            // the segment exists server-side.
            if (sbPreviewSeg && v.currentTime >= sbPreviewSeg.start && v.currentTime < sbPreviewSeg.end) {
                const end = sbPreviewSeg.end;
                sbPreviewSeg = null;
                sbLastSkipAt = Date.now();
                try { v.currentTime = end; } catch (e) { /* ignore */ }
                showVolumeOverlay('⏭ test skip');
                return;
            }
            if (sbState.vid !== watchVideoId()) return;
            const segs = sbState.segments;
            if (!segs || !segs.length) return;
            if (currentChannelWhitelisted()) return;   // whitelisted: markers stay, no auto-skip
            if (Date.now() - sbLastSkipAt < 500) return;   // let the seek land
            const t = v.currentTime;
            for (const s of segs) {
                if (s.noSkip) continue;   // user pressed Unskip on this one
                if (t >= s.start && t < s.end - 0.3) {
                    sbLastSkipAt = Date.now();
                    try { v.currentTime = s.end; } catch (e) { return; }
                    showSbNotice(s, v);
                    break;
                }
            }
        });
    }

    // Post-skip notice with an Unskip escape hatch (the ~1s volume-overlay
    // flash was too easy to miss and offered no way back). Unskip returns
    // to the start of the segment and stops auto-skipping it for this video.
    let sbNoticeTimer = null;
    function showSbNotice(seg, video) {
        const player = document.getElementById('movie_player');
        if (!player) return;
        let el = document.getElementById('ytb-sb-notice');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ytb-sb-notice';
            const text = document.createElement('span');
            text.className = 'ytb-sbn-text';
            el.appendChild(text);
            const unskip = document.createElement('button');
            unskip.className = 'ytb-sbn-unskip';
            unskip.type = 'button';
            unskip.textContent = 'Unskip';
            unskip.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const s = el._seg;
                if (s) {
                    s.noSkip = true;
                    try { if (el._video) el._video.currentTime = Math.max(0, s.start); } catch (err) { /* ignore */ }
                }
                el.classList.remove('ytb-show');
            });
            el.appendChild(unskip);
            const report = document.createElement('button');
            report.className = 'ytb-sbn-report';
            report.type = 'button';
            report.title = 'Bad segment? Downvotes it on SponsorBlock';
            report.textContent = 'Report';
            report.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const s = el._seg;
                if (s && s.uuid) {
                    api.runtime.sendMessage({ action: 'ytb-sb-vote', uuid: s.uuid, type: 0 })
                        .then(res => toast(res && res.ok ? 'Segment reported' : 'Report failed'))
                        .catch(() => toast('Report failed'));
                }
                el.classList.remove('ytb-show');
            });
            el.appendChild(report);
            const close = document.createElement('button');
            close.className = 'ytb-sbn-close';
            close.type = 'button';
            close.title = 'Dismiss';
            close.textContent = '✕';
            close.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove('ytb-show');
            });
            el.appendChild(close);
        }
        // Re-attach if the player was rebuilt.
        if (el.parentElement !== player) player.appendChild(el);
        el.querySelector('.ytb-sbn-text').textContent = '⏭ Skipped ' + sbLabel(seg.category);
        el.querySelector('.ytb-sbn-report').style.display = seg.uuid ? '' : 'none';
        el._seg = seg;
        el._video = video;
        el.classList.add('ytb-show');
        clearTimeout(sbNoticeTimer);
        sbNoticeTimer = setTimeout(() => el.classList.remove('ytb-show'), 7000);
    }

    /* ---- SponsorBlock creation & voting panel --------------------------
     * Opened from the ytb-sb-btn player button (present on every video
     * while SponsorBlock is enabled). Mark start/end at the playhead,
     * nudge by ±0.5s, test the jump locally, pick a category and submit;
     * existing segments can be voted on. Submissions and votes carry the
     * local SponsorBlock user ID (see background.js / options page).
     * ------------------------------------------------------------------ */
    let sbDraft = null;        // { vid, start, end|null, category }
    let sbPreviewSeg = null;   // one-shot local skip test

    function fmtSbTime(s) {
        s = Math.max(0, s || 0);
        return Math.floor(s / 60) + ':' + (s % 60).toFixed(1).padStart(4, '0');
    }

    function closeSbPanel() {
        const p = document.getElementById('ytb-sb-panel');
        if (p) p.remove();
    }

    function onSbBtnClick() {
        if (document.getElementById('ytb-sb-panel')) closeSbPanel();
        else renderSbPanel();
    }

    function sbNudge(which, delta) {
        if (!sbDraft) return;
        if (which === 'start') sbDraft.start = Math.max(0, +(sbDraft.start + delta).toFixed(1));
        else if (sbDraft.end != null) sbDraft.end = Math.max(0, +(sbDraft.end + delta).toFixed(1));
        renderSbPanel();
    }

    function sbTimeRow(label, which, value) {
        const row = document.createElement('div');
        row.className = 'ytb-sbp-time';
        const lab = document.createElement('span');
        lab.textContent = label + ' at ' + fmtSbTime(value);
        row.appendChild(lab);
        for (const [txt, d] of [['−0.5s', -0.5], ['+0.5s', 0.5]]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = txt;
            b.addEventListener('click', () => sbNudge(which, d));
            row.appendChild(b);
        }
        return row;
    }

    function renderSbPanel() {
        const player = document.getElementById('movie_player');
        if (!player) return;
        closeSbPanel();
        const panel = document.createElement('div');
        panel.id = 'ytb-sb-panel';

        const head = document.createElement('div');
        head.className = 'ytb-sbp-head';
        const title = document.createElement('b');
        title.textContent = 'SponsorBlock';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'ytb-sbp-x';
        close.textContent = '✕';
        close.addEventListener('click', closeSbPanel);
        head.append(title, close);
        panel.appendChild(head);

        // Per-channel whitelist toggle (segments stay visible; skipping off).
        const ownerInfo = getWatchPageOwnerInfo();
        if (ownerInfo && (ownerInfo.handle || ownerInfo.channelId || ownerInfo.name)) {
            const wlRow = document.createElement('div');
            wlRow.className = 'ytb-sbp-wl';
            const wlOn = isSbWhitelisted(ownerInfo);
            const who = ownerInfo.name || (ownerInfo.handle ? '@' + ownerInfo.handle : 'this channel');
            const wlBtn = document.createElement('button');
            wlBtn.type = 'button';
            if (wlOn) wlBtn.className = 'ytb-sbp-wl-on';
            wlBtn.textContent = (wlOn ? '✓ Whitelisted: ' : '⊘ Whitelist ') + who;
            wlBtn.title = wlOn
                ? 'Segments are shown but not skipped here. Click to auto-skip on this channel again.'
                : 'Stop auto-skipping on this channel (segment markers stay visible).';
            wlBtn.addEventListener('click', () => toggleSbWhitelist(ownerInfo));
            wlRow.appendChild(wlBtn);
            panel.appendChild(wlRow);
        }

        // Existing segments, with voting.
        const segs = (sbState.vid === watchVideoId() && sbState.segments) || [];
        if (segs.length) {
            const list = document.createElement('div');
            list.className = 'ytb-sbp-list';
            for (const s of segs) {
                const row = document.createElement('div');
                row.className = 'ytb-sbp-seg';
                const dot = document.createElement('span');
                dot.className = 'ytb-sbp-dot';
                dot.style.background = SB_COLORS[s.category] || '#00d400';
                const lab = document.createElement('span');
                lab.className = 'ytb-sbp-lab';
                lab.textContent = sbLabel(s.category) + ' · ' + fmtSbTime(s.start) + '–' + fmtSbTime(s.end);
                row.append(dot, lab);
                for (const [glyph, type, tip] of [['👍', 1, 'Vote up'], ['👎', 0, 'Vote down']]) {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = glyph;
                    b.title = tip;
                    b.addEventListener('click', () => {
                        b.disabled = true;
                        api.runtime.sendMessage({ action: 'ytb-sb-vote', uuid: s.uuid, type })
                            .then(res => toast(res && res.ok ? 'Vote sent' : 'Vote failed',
                                res && res.ok ? '' : String(res && res.error || '').slice(0, 80)))
                            .catch(() => toast('Vote failed'));
                    });
                    row.appendChild(b);
                }
                list.appendChild(row);
            }
            panel.appendChild(list);
        } else {
            const none = document.createElement('div');
            none.className = 'ytb-sbp-none';
            none.textContent = sbState.pending
                ? 'Looking up segments…'
                : 'No community segments on this video yet — you can submit the first.';
            panel.appendChild(none);
        }

        // Draft / creation area.
        const draft = document.createElement('div');
        draft.className = 'ytb-sbp-draft';
        const v = playerVideo();
        if (!sbDraft || sbDraft.vid !== watchVideoId()) {
            sbDraft = null;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ytb-sbp-primary';
            b.textContent = '▶ Segment starts now';
            b.title = 'Marks the current playhead as the start of a new segment';
            b.addEventListener('click', () => {
                if (!v) return;
                sbDraft = { vid: watchVideoId(), start: +v.currentTime.toFixed(1), end: null, category: 'sponsor' };
                renderSbPanel();
            });
            draft.appendChild(b);
        } else {
            draft.appendChild(sbTimeRow('Start', 'start', sbDraft.start));
            if (sbDraft.end == null) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'ytb-sbp-primary';
                b.textContent = '⏹ Segment ends now';
                b.addEventListener('click', () => {
                    if (!v) return;
                    sbDraft.end = +v.currentTime.toFixed(1);
                    if (sbDraft.end <= sbDraft.start) sbDraft.end = sbDraft.start + 1;
                    renderSbPanel();
                });
                draft.appendChild(b);
            } else {
                draft.appendChild(sbTimeRow('End', 'end', sbDraft.end));
                const cat = document.createElement('select');
                for (const [c, , label] of SB_CATEGORIES) {
                    const o = document.createElement('option');
                    o.value = c;
                    o.textContent = label;
                    cat.appendChild(o);
                }
                cat.value = sbDraft.category || 'sponsor';
                cat.addEventListener('change', () => { sbDraft.category = cat.value; });
                draft.appendChild(cat);
                const actions = document.createElement('div');
                actions.className = 'ytb-sbp-actions';
                const test = document.createElement('button');
                test.type = 'button';
                test.textContent = 'Test skip';
                test.title = 'Seeks 2s before the start and replays the jump once, locally';
                test.addEventListener('click', () => {
                    if (!v) return;
                    sbPreviewSeg = { start: sbDraft.start, end: sbDraft.end };
                    try {
                        v.currentTime = Math.max(0, sbDraft.start - 2);
                        v.play().catch(() => {});
                    } catch (e) { /* ignore */ }
                });
                const submit = document.createElement('button');
                submit.type = 'button';
                submit.className = 'ytb-sbp-primary';
                submit.textContent = 'Submit';
                submit.addEventListener('click', () => {
                    if (sbDraft.end - sbDraft.start < 0.5) { toast('Segment too short'); return; }
                    submit.disabled = true;
                    api.runtime.sendMessage({
                        action: 'ytb-sb-submit', videoId: sbDraft.vid,
                        start: sbDraft.start, end: sbDraft.end,
                        category: sbDraft.category || 'sponsor'
                    }).then(res => {
                        if (res && res.ok) {
                            toast('Segment submitted', 'thank you!');
                            sbDraft = null;
                            sbState = { vid: null, segments: null, pending: false };  // force refetch
                            renderSbPanel();
                        } else {
                            submit.disabled = false;
                            toast('Submission failed', String(res && res.error || 'network error').slice(0, 100));
                        }
                    }).catch(() => { submit.disabled = false; toast('Submission failed'); });
                });
                const discard = document.createElement('button');
                discard.type = 'button';
                discard.textContent = 'Discard';
                discard.addEventListener('click', () => { sbDraft = null; renderSbPanel(); });
                actions.append(test, submit, discard);
                draft.appendChild(actions);
            }
        }
        panel.appendChild(draft);
        player.appendChild(panel);
    }

    function ensureSponsorBlock() {
        if (!settings.sbEnabled || location.pathname !== '/watch') return;
        const vid = watchVideoId();
        if (!vid) return;
        refreshSbWhitelist();   // cache this channel's whitelist state for the skip hook
        if (sbState.vid !== vid && !sbState.pending) {
            const cats = sbWantedCategories();
            if (!cats.length) return;
            const generation = sbCategoryGeneration;
            sbState = { vid, segments: null, pending: true, generation };
            api.runtime.sendMessage({ action: 'ytb-sb-segments', videoId: vid, categories: cats })
                .then((segs) => {
                    if (retired || generation !== sbCategoryGeneration ||
                        sbState.vid !== vid || sbState.generation !== generation) return;
                    sbState = { vid, segments: segs || [], pending: false, generation };
                    if (segs && segs.length) {
                        showVolumeOverlay('⏭ ' + segs.length +
                            (segs.length === 1 ? ' segment' : ' segments') +
                            (currentChannelWhitelisted() ? ' (whitelisted)' : ' will be skipped'));
                        updateSbMarkers();
                    }
                    ensureExtraButtons();   // tint the shield green when segments exist
                    if (document.getElementById('ytb-sb-panel')) renderSbPanel();
                })
                .catch(() => {
                    if (generation === sbCategoryGeneration && sbState.vid === vid &&
                        sbState.generation === generation) {
                        sbState = { vid, segments: [], pending: false, generation };
                    }
                });
        }
        const v = playerVideo();
        if (v) ensureSbHook(v);
    }

    // Colored segment markers on the player's progress bar (the visual cue
    // SponsorBlock users expect), roughly matching SB's category colors.
    const SB_COLORS = {
        sponsor: '#00d400', selfpromo: '#ffff00', interaction: '#cc00ff',
        intro: '#00ffff', outro: '#0202ed', preview: '#008fd6',
        music_offtopic: '#ff9900', filler: '#7300ff'
    };

    function updateSbMarkers() {
        const bar = document.querySelector('#movie_player .ytp-progress-bar');
        let wrap = document.getElementById('ytb-sb-markers');
        const v = playerVideo();
        const want = settings.enabled && settings.sbEnabled && bar && v &&
            isFinite(v.duration) && v.duration > 0 &&
            sbState.vid === watchVideoId() &&
            sbState.segments && sbState.segments.length;
        if (!want) {
            if (wrap) wrap.remove();
            return;
        }
        if (wrap && (wrap.parentElement !== bar || wrap.dataset.vid !== sbState.vid)) {
            wrap.remove();
            wrap = null;
        }
        if (wrap) return;
        wrap = document.createElement('div');
        wrap.id = 'ytb-sb-markers';
        wrap.dataset.vid = sbState.vid;
        const dur = v.duration;
        for (const s of sbState.segments) {
            const d = document.createElement('div');
            d.className = 'ytb-sb-marker';
            d.style.left = (100 * s.start / dur) + '%';
            d.style.width = Math.max(0.3, 100 * (s.end - s.start) / dur) + '%';
            d.style.background = SB_COLORS[s.category] || '#00d400';
            d.title = sbLabel(s.category);
            wrap.appendChild(d);
        }
        bar.appendChild(wrap);
    }

    /* ---- SponsorBlock thumbnail badges --------------------------------
     * A small green shield in the top-left corner of any video tile whose
     * video already has community segments (mirrors the official
     * extension's thumbnail labels). Lookups reuse the k-anonymity segment
     * endpoint through the background, trickled a few per pass and cached,
     * so a busy feed does not burst the API.
     * ------------------------------------------------------------------ */
    const sbBadgeCache = new Map();     // vid -> { generation, value }
    const sbBadgeInFlight = new Set();  // "generation:vid"
    const SB_BADGE_MAX = 1000;
    const SB_BADGE_CONCURRENCY = 6;
    let sbCategorySignature = '';
    let sbCategoryGeneration = 0;

    function refreshSbCategoryGeneration() {
        const signature = sbWantedCategories().join('\u001f');
        if (signature === sbCategorySignature) return;
        sbCategorySignature = signature;
        sbCategoryGeneration++;
        sbBadgeCache.clear();
        // A badge from the previous category set is not evidence for the new set.
        document.querySelectorAll('.ytb-sb-badge').forEach(badge => badge.remove());
    }

    function sbBadgeValue(vid) {
        const hit = sbBadgeCache.get(vid);
        return hit && hit.generation === sbCategoryGeneration
            ? hit.value : undefined;
    }

    function currentSbBadgeRequests() {
        // Stale-generation requests still consume network capacity until their
        // promises settle; keep the advertised global six-request ceiling.
        return sbBadgeInFlight.size;
    }

    function sbBadgeLookup(vid, cats, tile) {
        const generation = sbCategoryGeneration;
        const requestKey = generation + ':' + vid;
        if (sbBadgeInFlight.has(requestKey)) return;
        if (sbBadgeCache.size >= SB_BADGE_MAX) sbBadgeCache.delete(sbBadgeCache.keys().next().value);
        sbBadgeCache.set(vid, { generation, value: 'pending' });
        sbBadgeInFlight.add(requestKey);
        api.runtime.sendMessage({ action: 'ytb-sb-segments', videoId: vid, categories: cats })
            .then(segs => {
                if (retired || generation !== sbCategoryGeneration) return;
                sbBadgeCache.set(vid, {
                    generation,
                    value: !!(segs && segs.length)
                });
                if (tile && getVideoIdFromNode(tile) === vid) {
                    processSbBadges([tile]);
                }
            })
            .catch(() => {
                if (!retired && generation === sbCategoryGeneration) {
                    sbBadgeCache.set(vid, { generation, value: false });
                }
            })
            .finally(() => {
                sbBadgeInFlight.delete(requestKey);
                // An old generation freeing a slot must also wake the current
                // queue, whose requests may have been waiting at the global cap.
                if (!retired) queueTileEnhancements();
            });
    }

    // The positioned box that hosts YouTube's own thumbnail overlays (the
    // duration pill), so the badge sits over the image on every tile variant.
    function sbBadgeContainer(tile) {
        return tile.querySelector('ytd-thumbnail a#thumbnail') ||
               tile.querySelector('a#thumbnail') ||
               tile.querySelector('ytd-thumbnail') ||
               tile.querySelector('yt-thumbnail-view-model, .ytThumbnailViewModelHost') ||
               tile.querySelector('a[href*="/watch?v="]');
    }

    function makeSbBadge(vid) {
        const badge = document.createElement('div');
        badge.className = 'ytb-sb-badge';
        badge.dataset.vid = vid;
        badge.title = 'Has SponsorBlock segments';
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        const shield = document.createElementNS(ns, 'path');
        shield.setAttribute('d', 'M12 2 4 5v6c0 4.8 3.4 9.1 8 10.2 4.6-1.1 8-5.4 8-10.2V5l-8-3Z');
        shield.setAttribute('class', 'ytb-sb-badge-shield');
        const check = document.createElementNS(ns, 'path');
        check.setAttribute('d', 'M10.4 15.2 7.1 11.9l1.2-1.2 2.1 2.1 4.3-4.3 1.2 1.2z');
        check.setAttribute('class', 'ytb-sb-badge-check');
        svg.append(shield, check);
        badge.appendChild(svg);
        return badge;
    }

    function addSbBadge(container, vid) {
        const existing = container.querySelector(':scope > .ytb-sb-badge');
        if (existing) {
            if (existing.dataset.vid === vid) return;   // already correct
            existing.remove();                          // tile recycled to a new video
        }
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        container.appendChild(makeSbBadge(vid));
    }

    function processSbBadges(tiles) {
        refreshSbCategoryGeneration();
        if (!settings.enabled || !settings.sbEnabled || !settings.sbThumbnailBadges ||
            !sbWantedCategories().length) {
            document.querySelectorAll('.ytb-sb-badge').forEach(badge => badge.remove());
            return;
        }
        const cats = sbWantedCategories();
        let available = Math.max(0, SB_BADGE_CONCURRENCY - currentSbBadgeRequests());
        const candidates = tiles || document.querySelectorAll(INNER_CONTAINERS);
        for (const tile of candidates) {
            const vid = getVideoIdFromNode(tile);
            const stale = tile.querySelector('.ytb-sb-badge');
            if (stale && (!vid || stale.dataset.vid !== vid)) stale.remove();
            if (!vid || tile.closest('.ytb-removed')) continue;
            const has = sbBadgeValue(vid);
            if (has === undefined) {
                if (available > 0) { available--; sbBadgeLookup(vid, cats, tile); }
                continue;
            }
            if (has === 'pending') continue;
            const container = sbBadgeContainer(tile);
            if (!container) continue;   // thumbnail not in the DOM yet; retry next pass
            if (has) addSbBadge(container, vid);
            else {
                const ex = container.querySelector(':scope > .ytb-sb-badge');
                if (ex) ex.remove();
            }
        }
    }

    /* ---- DeArrow: community titles (and optionally thumbnails) -------- */
    const deCache = new Map();          // vid -> {title, thumbTime} | 'pending'
    const deInFlight = new Set();
    const DE_CACHE_MAX = 800;
    const DE_CONCURRENCY = 6;
    const DE_WATCH_PLAYER_REQUEST_TIMEOUT_MS = 1000;
    const DE_WATCH_PLAYER_RETRY_DELAY_MS = 200;
    const DE_WATCH_PLAYER_RETRY_LIMIT = 12;
    const DE_WATCH_PLAYER_RETRY_COOLDOWN_MS = 10000;
    let deArrowAppliedTitles = !!document.querySelector(
        '[data-ytb-de-title], [data-ytb-de-watch-written]'
    );
    let deArrowAppliedThumbs = !!document.querySelector('img[data-ytb-de-thumb]');
    let deArrowWatchNavigating = false;
    let deArrowWatchNavigationTimer = null;
    let deArrowWatchPlayerData = null;
    let deArrowWatchPlayerRequestSeq = 0;
    let deArrowWatchPlayerPending = null;
    let deArrowWatchPlayerRetryTimer = null;
    let deArrowWatchPlayerRetryVid = null;
    let deArrowWatchPlayerRetryCount = 0;
    let deArrowWatchPlayerRetryCooldownUntil = 0;

    function deLookup(vid, tile) {
        if (deInFlight.has(vid)) return;
        if (deCache.size >= DE_CACHE_MAX) deCache.delete(deCache.keys().next().value);
        deCache.set(vid, 'pending');
        deInFlight.add(vid);
        api.runtime.sendMessage({ action: 'ytb-de-branding', videoId: vid })
            .then((res) => {
                deCache.set(vid, res || {});
                if (!retired && settings.enabled && tile &&
                    getVideoIdFromNode(tile) === vid) {
                    processDeArrow([tile]);
                }
            })
            .catch(() => deCache.set(vid, {}))
            .finally(() => {
                deInFlight.delete(vid);
                if (!retired) {
                    // Watch-page lookups are not part of the card queue. Apply a
                    // resolved title immediately instead of waiting for the
                    // low-frequency recovery pass.
                    if (settings.enabled && settings.deArrowTitles &&
                        watchVideoId() === vid) {
                        processDeArrowWatchPage();
                    }
                    queueTileEnhancements();
                }
            });
    }

    function deTitleTarget(node) {
        // Query in priority tiers (querySelector returns document order, not
        // selector order): the legacy #video-title, then the lockup title
        // LINK. Never the bare h3 heading-reset wrapper — it computes to
        // black, so writing text there leaves it dark and unreadable.
        return node.querySelector('#video-title, a#video-title-link') ||
               node.querySelector('a[class*="lockupMetadataViewModelTitle" i], [class*="lockupMetadataViewModelTitle" i]') ||
               node.querySelector('h3 a[title], h4');
    }

    function deArrowTextTarget(el) {
        return el.querySelector(
            '.yt-core-attributed-string, .ytAttributedStringHost, yt-formatted-string'
        ) || el;
    }

    function currentDeArrowVideoId(el) {
        const tile = el && el.closest && el.closest(INNER_CONTAINERS);
        if (tile) return getVideoIdFromNode(tile);
        return location.pathname === '/watch' ? watchVideoId() : null;
    }

    // YouTube recycles card elements. Compare against the exact value we wrote:
    // if YouTube already hydrated video B, preserve B instead of restoring A.
    function prepareDeArrowTitleIdentity(target, vid) {
        const applied = target.dataset.ytbDeTitle;
        if (applied && applied !== vid) {
            const current = target.textContent || '';
            const cached = deCache.get(applied);
            const replacement = target.dataset.ytbDeAppliedTitle ||
                (cached && cached !== 'pending' && cached.title) || '';
            const replacementKnown = !!replacement;
            const stillReplacement = replacementKnown && current === replacement;

            // Equality is ambiguous: video B's native title may legitimately
            // equal A's replacement. Leave it untouched and await hydration
            // rather than risk overwriting a fully hydrated B title with A.
            [
                'data-ytb-de-title', 'data-ytb-de-applied-title',
                'data-ytb-de-original-title', 'data-ytb-de-original-title-video',
                'data-ytb-de-await-title', 'data-ytb-de-stale-title'
            ].forEach(name => target.removeAttribute(name));

            if (!replacementKnown || stillReplacement) {
                target.dataset.ytbDeAwaitTitle = vid;
                target.dataset.ytbDeStaleTitle = target.textContent || '';
                return false;
            }
            return true; // current is already video B's native title
        }

        const awaiting = target.dataset.ytbDeAwaitTitle;
        if (!awaiting) return true;
        const current = target.textContent || '';
        if (awaiting !== vid) {
            target.dataset.ytbDeAwaitTitle = vid;
            target.dataset.ytbDeStaleTitle = current;
            return false;
        }
        if (current === (target.dataset.ytbDeStaleTitle || '')) return false;
        target.removeAttribute('data-ytb-de-await-title');
        target.removeAttribute('data-ytb-de-stale-title');
        return true;
    }

    function prepareDeArrowLinkIdentity(link, vid) {
        const applied = link.dataset.ytbDeLinkTitle;
        if (applied && applied !== vid) {
            const current = link.getAttribute('title') || '';
            const hasCurrent = link.hasAttribute('title') ? '1' : '0';
            const cached = deCache.get(applied);
            const replacement = link.dataset.ytbDeAppliedLinkTitle ||
                (cached && cached !== 'pending' && cached.title) || '';
            const replacementKnown = !!replacement;
            const stillReplacement = replacementKnown &&
                hasCurrent === '1' && current === replacement;

            // As with visible text, an equal tooltip can already belong to B.
            // Keep the current value until a later title mutation disambiguates it.
            [
                'data-ytb-de-link-title', 'data-ytb-de-applied-link-title',
                'data-ytb-de-had-link-title', 'data-ytb-de-original-link-title',
                'data-ytb-de-original-link-title-video',
                'data-ytb-de-await-link-title', 'data-ytb-de-stale-link-title',
                'data-ytb-de-stale-link-had-title'
            ].forEach(name => link.removeAttribute(name));

            if (!replacementKnown || stillReplacement) {
                link.dataset.ytbDeAwaitLinkTitle = vid;
                link.dataset.ytbDeStaleLinkTitle = link.getAttribute('title') || '';
                link.dataset.ytbDeStaleLinkHadTitle =
                    link.hasAttribute('title') ? '1' : '0';
                return false;
            }
            return true; // YouTube already supplied video B's link title
        }

        const awaiting = link.dataset.ytbDeAwaitLinkTitle;
        if (!awaiting) return true;
        const current = link.getAttribute('title') || '';
        const hasCurrent = link.hasAttribute('title') ? '1' : '0';
        if (awaiting !== vid) {
            link.dataset.ytbDeAwaitLinkTitle = vid;
            link.dataset.ytbDeStaleLinkTitle = current;
            link.dataset.ytbDeStaleLinkHadTitle = hasCurrent;
            return false;
        }
        if (current === (link.dataset.ytbDeStaleLinkTitle || '') &&
            hasCurrent === link.dataset.ytbDeStaleLinkHadTitle) return false;
        link.removeAttribute('data-ytb-de-await-link-title');
        link.removeAttribute('data-ytb-de-stale-link-title');
        link.removeAttribute('data-ytb-de-stale-link-had-title');
        return true;
    }

    function prepareDeArrowThumbIdentity(img, vid) {
        const applied = img.dataset.ytbDeThumb;
        if (applied && applied !== vid) {
            const current = img.src || '';
            const replacement = img.dataset.ytbDeAppliedSrc || '';
            const stillReplacement = current.includes('dearrow-thumb.ajay.app') &&
                (!replacement || current === replacement);

            if (stillReplacement) {
                const originalVideo = img.dataset.ytbDeOriginalSrcVideo;
                if (img.dataset.ytbDeOriginalSrc &&
                    (!originalVideo || originalVideo === applied)) {
                    img.src = img.dataset.ytbDeOriginalSrc;
                }
            }
            [
                'data-ytb-de-thumb', 'data-ytb-de-applied-src',
                'data-ytb-de-original-src', 'data-ytb-de-original-src-video',
                'data-ytb-de-thumb-failed', 'data-ytb-de-thumb-instance',
                'data-ytb-de-thumb-error-owner',
                'data-ytb-de-await-thumb', 'data-ytb-de-stale-src'
            ].forEach(name => img.removeAttribute(name));

            if (stillReplacement) {
                img.dataset.ytbDeAwaitThumb = vid;
                img.dataset.ytbDeStaleSrc = img.src || '';
                return false;
            }
            return true; // current is already video B's native thumbnail
        }

        const awaiting = img.dataset.ytbDeAwaitThumb;
        if (!awaiting) return true;
        const current = img.src || '';
        if (awaiting !== vid) {
            img.dataset.ytbDeAwaitThumb = vid;
            img.dataset.ytbDeStaleSrc = current;
            return false;
        }
        if (current === (img.dataset.ytbDeStaleSrc || '')) return false;
        img.removeAttribute('data-ytb-de-await-thumb');
        img.removeAttribute('data-ytb-de-stale-src');
        return true;
    }

    function applyDeArrowTitle(host, vid, title, titleElement) {
        const el = titleElement || deTitleTarget(host);
        if (!el) return;
        // Write to the innermost element that carries YouTube's text colour.
        const target = deArrowTextTarget(el);
        if (prepareDeArrowTitleIdentity(target, vid)) {
            const current = target.textContent || '';
            if (target.dataset.ytbDeTitle !== vid ||
                current !== target.dataset.ytbDeAppliedTitle) {
                target.dataset.ytbDeOriginalTitle = current;
                target.dataset.ytbDeOriginalTitleVideo = vid;
            }
            target.dataset.ytbDeTitle = vid;
            target.dataset.ytbDeAppliedTitle = title;
            if (current !== title) target.textContent = title;
            deArrowAppliedTitles = true;
        }

        const link = (el.matches && el.matches('a')) ? el
            : (el.querySelector && el.querySelector('a'));
        if (link && prepareDeArrowLinkIdentity(link, vid)) {
            const current = link.getAttribute('title') || '';
            if (link.dataset.ytbDeLinkTitle !== vid ||
                current !== link.dataset.ytbDeAppliedLinkTitle) {
                link.dataset.ytbDeHadLinkTitle = link.hasAttribute('title') ? '1' : '0';
                link.dataset.ytbDeOriginalLinkTitle = current;
                link.dataset.ytbDeOriginalLinkTitleVideo = vid;
            }
            link.dataset.ytbDeLinkTitle = vid;
            link.dataset.ytbDeAppliedLinkTitle = title;
            if (current !== title) link.setAttribute('title', title);
            deArrowAppliedTitles = true;
        }
    }

    function restoreDeArrowTitles() {
        if (!deArrowAppliedTitles) return;
        document.querySelectorAll(
            '[data-ytb-de-title], [data-ytb-de-await-title], ' +
            '[data-ytb-de-watch-written]'
        ).forEach(target => {
            const currentVideo = currentDeArrowVideoId(target);
            const originalVideo = target.dataset.ytbDeOriginalTitleVideo ||
                target.dataset.ytbDeTitle;
            if (target.hasAttribute('data-ytb-de-title') &&
                originalVideo && originalVideo === currentVideo &&
                target.hasAttribute('data-ytb-de-original-title')) {
                target.textContent = target.dataset.ytbDeOriginalTitle || '';
            }
            [
                'data-ytb-de-title', 'data-ytb-de-applied-title',
                'data-ytb-de-original-title',
                'data-ytb-de-original-title-video', 'data-ytb-de-await-title',
                'data-ytb-de-stale-title',
                'data-ytb-de-watch-written', 'data-ytb-de-watch-written-title'
            ].forEach(name => target.removeAttribute(name));
        });
        document.querySelectorAll(
            '[data-ytb-de-link-title], [data-ytb-de-await-link-title]'
        ).forEach(link => {
            const currentVideo = currentDeArrowVideoId(link);
            const originalVideo = link.dataset.ytbDeOriginalLinkTitleVideo ||
                link.dataset.ytbDeLinkTitle;
            if (link.hasAttribute('data-ytb-de-link-title') &&
                originalVideo && originalVideo === currentVideo) {
                if (link.dataset.ytbDeHadLinkTitle === '1') {
                    link.setAttribute('title', link.dataset.ytbDeOriginalLinkTitle || '');
                } else {
                    link.removeAttribute('title');
                }
            }
            [
                'data-ytb-de-link-title', 'data-ytb-de-applied-link-title',
                'data-ytb-de-had-link-title',
                'data-ytb-de-original-link-title',
                'data-ytb-de-original-link-title-video',
                'data-ytb-de-await-link-title', 'data-ytb-de-stale-link-title',
                'data-ytb-de-stale-link-had-title'
            ].forEach(name => link.removeAttribute(name));
        });
        document.querySelectorAll('[data-ytb-de]').forEach(el =>
            el.removeAttribute('data-ytb-de'));
        deArrowAppliedTitles = false;
    }

    function restoreDeArrowThumbs() {
        if (!deArrowAppliedThumbs) return;
        document.querySelectorAll(
            'img[data-ytb-de-thumb], img[data-ytb-de-await-thumb]'
        ).forEach(img => {
            const currentVideo = currentDeArrowVideoId(img);
            const originalVideo = img.dataset.ytbDeOriginalSrcVideo ||
                img.dataset.ytbDeThumb;
            if (img.hasAttribute('data-ytb-de-thumb') &&
                originalVideo && originalVideo === currentVideo &&
                img.dataset.ytbDeOriginalSrc) {
                img.src = img.dataset.ytbDeOriginalSrc;
            }
            [
                'data-ytb-de-thumb', 'data-ytb-de-applied-src',
                'data-ytb-de-original-src',
                'data-ytb-de-original-src-video', 'data-ytb-de-thumb-failed',
                'data-ytb-de-thumb-instance', 'data-ytb-de-thumb-error-owner',
                'data-ytb-de-await-thumb', 'data-ytb-de-stale-src'
            ].forEach(name => img.removeAttribute(name));
        });
        deArrowAppliedThumbs = false;
    }

    function prepareDeArrowTileIdentity(tile, vid) {
        if (settings.deArrowTitles) {
            const target = tile.querySelector(
                '[data-ytb-de-title], [data-ytb-de-await-title]'
            );
            if (target) prepareDeArrowTitleIdentity(target, vid);
            const link = tile.querySelector(
                '[data-ytb-de-link-title], [data-ytb-de-await-link-title]'
            );
            if (link) prepareDeArrowLinkIdentity(link, vid);
        }
        if (settings.deArrowThumbs) {
            const img = tile.querySelector(
                'img[data-ytb-de-thumb], img[data-ytb-de-await-thumb]'
            );
            if (img) prepareDeArrowThumbIdentity(img, vid);
        }
    }

    function applyDeArrowThumb(tile, vid, thumbTime) {
        const img = tile.querySelector(
            'ytd-thumbnail img, yt-image img, img.yt-core-image, img'
        );
        if (!img || !img.src || !prepareDeArrowThumbIdentity(img, vid) ||
            img.dataset.ytbDeThumbFailed === vid) return;

        const replacement =
            'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=' +
            encodeURIComponent(vid) + '&time=' + thumbTime;
        const current = img.src;
        if (!current.includes('dearrow-thumb.ajay.app')) {
            img.dataset.ytbDeOriginalSrc = current;
            img.dataset.ytbDeOriginalSrcVideo = vid;
        } else if (img.dataset.ytbDeOriginalSrc &&
                   !img.dataset.ytbDeOriginalSrcVideo) {
            // Adopt originals created by an older live content-script instance.
            img.dataset.ytbDeOriginalSrcVideo = vid;
        }
        img.dataset.ytbDeThumb = vid;
        img.dataset.ytbDeAppliedSrc = replacement;
        img.dataset.ytbDeThumbInstance = INSTANCE_ID;
        deArrowAppliedThumbs = true;

        const restoreFailedThumb = () => {
            if (!retired && img.dataset.ytbDeThumbInstance === INSTANCE_ID &&
                img.dataset.ytbDeThumb === vid &&
                getVideoIdFromNode(tile) === vid) {
                img.dataset.ytbDeThumbFailed = vid;
                if (img.dataset.ytbDeOriginalSrcVideo === vid &&
                    img.dataset.ytbDeOriginalSrc) {
                    img.src = img.dataset.ytbDeOriginalSrc;
                }
            }
        };
        if (img.dataset.ytbDeThumbErrorOwner !== INSTANCE_ID) {
            img.dataset.ytbDeThumbErrorOwner = INSTANCE_ID;
            img.addEventListener('error', restoreFailedThumb, { once: true });
        }
        if (current === replacement) {
            // A fresh instance may adopt an old in-flight URL. Re-own its error
            // handling, and repair immediately if the browser already failed it.
            if (img.complete && img.naturalWidth === 0) restoreFailedThumb();
            return;
        }
        img.src = replacement;
    }

    function applyDeArrowToTile(tile, vid, entry) {
        if (settings.deArrowTitles && entry.title) {
            applyDeArrowTitle(tile, vid, entry.title);
        }
        if (settings.deArrowThumbs && entry.thumbTime != null) {
            applyDeArrowThumb(tile, vid, entry.thumbTime);
        }
    }

    function processDeArrow(tiles) {
        if (!settings.deArrowTitles && !settings.deArrowThumbs) return;
        let available = Math.max(0, DE_CONCURRENCY - deInFlight.size);
        const candidates = tiles || document.querySelectorAll(INNER_CONTAINERS);
        for (const tile of candidates) {
            if (tile.closest('.ytb-removed')) continue;
            const vid = getVideoIdFromNode(tile);
            if (!vid) continue;
            prepareDeArrowTileIdentity(tile, vid);
            const entry = deCache.get(vid);
            if (entry === undefined) {
                if (available > 0) { available--; deLookup(vid, tile); }
                continue;
            }
            if (entry === 'pending' || (!entry.title && entry.thumbTime == null)) continue;
            applyDeArrowToTile(tile, vid, entry);
        }
    }

    function resetDeArrowWatchPlayerRetry() {
        if (deArrowWatchPlayerRetryTimer) {
            clearTimeout(deArrowWatchPlayerRetryTimer);
            deArrowWatchPlayerRetryTimer = null;
        }
        deArrowWatchPlayerRetryVid = null;
        deArrowWatchPlayerRetryCount = 0;
        deArrowWatchPlayerRetryCooldownUntil = 0;
        deArrowWatchPlayerPending = null;
    }

    function scheduleDeArrowWatchPlayerRetry(vid, delay, pendingToken) {
        if (deArrowWatchPlayerRetryTimer) {
            clearTimeout(deArrowWatchPlayerRetryTimer);
            deArrowWatchPlayerRetryTimer = null;
        }
        if (deArrowWatchPlayerRetryVid !== vid) {
            deArrowWatchPlayerRetryVid = vid;
            deArrowWatchPlayerRetryCount = 0;
            deArrowWatchPlayerRetryCooldownUntil = 0;
        }
        if (deArrowWatchPlayerRetryCount >= DE_WATCH_PLAYER_RETRY_LIMIT) {
            if (!deArrowWatchPlayerRetryCooldownUntil) {
                deArrowWatchPlayerRetryCooldownUntil =
                    Date.now() + DE_WATCH_PLAYER_RETRY_COOLDOWN_MS;
            }
            return;
        }
        deArrowWatchPlayerRetryTimer = setTimeout(() => {
            deArrowWatchPlayerRetryTimer = null;
            if (retired || !settings.enabled || !settings.deArrowTitles ||
                watchVideoId() !== vid) return;
            if (pendingToken) {
                if (!deArrowWatchPlayerPending ||
                    deArrowWatchPlayerPending.token !== pendingToken) return;
                deArrowWatchPlayerPending = null;
            }
            deArrowWatchPlayerRetryCount++;
            if (deArrowWatchPlayerRetryCount >= DE_WATCH_PLAYER_RETRY_LIMIT) {
                deArrowWatchPlayerRetryCooldownUntil =
                    Date.now() + DE_WATCH_PLAYER_RETRY_COOLDOWN_MS;
            }
            processDeArrowWatchPage();
        }, delay);
    }

    function readWatchPlayerData(vid) {
        const player = document.getElementById('movie_player');
        if (!player) return deArrowWatchPlayerData;
        try {
            // Keep the direct path for browsers that expose the page-world API.
            const playerApi = player.wrappedJSObject || player;
            if (playerApi && typeof playerApi.getVideoData === 'function') {
                const raw = playerApi.getVideoData();
                const data = raw && (raw.wrappedJSObject || raw);
                if (data) {
                    const playerData = {
                        videoId: cleanText(String(data.video_id || data.videoId || '')),
                        title: cleanText(String(data.title || ''))
                    };
                    if (playerData.videoId === vid && playerData.title) {
                        resetDeArrowWatchPlayerRetry();
                    }
                    return playerData;
                }
            }
        } catch (e) { /* bridge fallback below */ }

        if (!vid) return deArrowWatchPlayerData;
        if (deArrowWatchPlayerRetryVid !== vid) {
            resetDeArrowWatchPlayerRetry();
            deArrowWatchPlayerRetryVid = vid;
        }
        const now = Date.now();
        if (deArrowWatchPlayerRetryCount >= DE_WATCH_PLAYER_RETRY_LIMIT &&
            deArrowWatchPlayerRetryCooldownUntil &&
            now >= deArrowWatchPlayerRetryCooldownUntil) {
            deArrowWatchPlayerRetryCount = 0;
            deArrowWatchPlayerRetryCooldownUntil = 0;
        }
        const retryCoolingDown =
            deArrowWatchPlayerRetryCount >= DE_WATCH_PLAYER_RETRY_LIMIT;
        const cacheComplete = deArrowWatchPlayerData &&
            deArrowWatchPlayerData.videoId === vid &&
            !!deArrowWatchPlayerData.title;
        const requestFresh = deArrowWatchPlayerPending &&
            deArrowWatchPlayerPending.vid === vid &&
            now - deArrowWatchPlayerPending.sentAt <
                DE_WATCH_PLAYER_REQUEST_TIMEOUT_MS;
        if (!cacheComplete && !requestFresh && !retryCoolingDown) {
            const token = INSTANCE_ID + ':' + (++deArrowWatchPlayerRequestSeq);
            deArrowWatchPlayerPending = { token, vid, sentAt: now };
            try {
                window.postMessage({ type: 'ytb-get-video-data', token, vid },
                    location.origin);
                scheduleDeArrowWatchPlayerRetry(
                    vid, DE_WATCH_PLAYER_REQUEST_TIMEOUT_MS, token
                );
            } catch (e) {
                deArrowWatchPlayerPending = null;
            }
        }
        return deArrowWatchPlayerData;
    }

    function watchFlexyVideoId() {
        const flexy = document.querySelector('ytd-watch-flexy[video-id]');
        return cleanText(flexy && flexy.getAttribute &&
            flexy.getAttribute('video-id') || '');
    }

    function beginDeArrowWatchNavigation() {
        if (retired) return;
        resetDeArrowWatchPlayerRetry();
        deArrowWatchNavigating = true;
        if (deArrowWatchNavigationTimer) clearTimeout(deArrowWatchNavigationTimer);
        // A cancelled same-URL navigation may omit yt-navigate-finish. Fail open
        // after a bounded delay; route/flexy/player identity checks still prevent
        // an old title from being written onto a new video.
        deArrowWatchNavigationTimer = setTimeout(() => {
            deArrowWatchNavigationTimer = null;
            if (retired) return;
            deArrowWatchNavigating = false;
            refreshDeArrowWatchTitle();
        }, 3000);
    }

    function finishDeArrowWatchNavigation() {
        deArrowWatchNavigating = false;
        if (deArrowWatchNavigationTimer) {
            clearTimeout(deArrowWatchNavigationTimer);
            deArrowWatchNavigationTimer = null;
        }
    }

    function refreshDeArrowWatchTitle() {
        if (!retired && settings.enabled && settings.deArrowTitles) {
            processDeArrowWatchPage();
        }
    }

    // After a heading write, YouTube's next hydration can append its own text
    // or attributed-string node beside the foreign node we wrote instead of
    // replacing it, leaving the previous and current titles rendered together.
    // Remove exactly the node we wrote once YouTube has supplied any other
    // content, along with the now-stale write markers on that holder.
    function pruneDeArrowWatchDuplicate(holder) {
        if (!holder || !holder.dataset || !holder.childNodes ||
            holder.childNodes.length < 2) return false;
        const written = holder.dataset.ytbDeWatchWrittenTitle ||
            holder.dataset.ytbDeAppliedTitle || '';
        if (!written) return false;
        const children = [...holder.childNodes];
        const ours = children.filter(node => node.nodeType === 3 &&
            (node.textContent || '') === written);
        const theirs = children.some(node => (node.textContent || '').trim() &&
            (node.textContent || '') !== written);
        if (!ours.length || !theirs) return false;
        for (const node of ours) holder.removeChild(node);
        [
            'data-ytb-de-title', 'data-ytb-de-applied-title',
            'data-ytb-de-original-title', 'data-ytb-de-original-title-video',
            'data-ytb-de-await-title', 'data-ytb-de-stale-title',
            'data-ytb-de-watch-written', 'data-ytb-de-watch-written-title'
        ].forEach(name => holder.removeAttribute(name));
        return true;
    }

    function processDeArrowWatchPage() {
        if (!settings.deArrowTitles || location.pathname !== '/watch' ||
            deArrowWatchNavigating) return;

        const vid = watchVideoId();
        const h1 = document.querySelector(
            'ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata'
        );
        if (h1) observeFilterDetails(h1);

        // During SPA navigation YouTube can update the heading, route, flexy and
        // player in separate turns. Never write a title while those identities
        // disagree, or a late pass for video A can overwrite video B's heading.
        const flexyVideoId = watchFlexyVideoId();
        if (vid && flexyVideoId && flexyVideoId !== vid) return;
        const playerData = vid ? readWatchPlayerData(vid) : null;
        const playerMatches = !!(playerData && playerData.videoId === vid);
        // Player data can lag the watch metadata or temporarily identify an ad.
        // A matching flexy is enough to trust an already-hydrated DOM title, but
        // never use a mismatched player's title as the native fallback.
        if (!flexyVideoId && playerData && playerData.videoId &&
            !playerMatches) return;

        let titleReady = true;
        const target = h1 && deArrowTextTarget(h1);
        if (vid && target) {
            // The write may sit on the target itself or on its parent when
            // YouTube re-rendered the heading with a new inner text holder.
            pruneDeArrowWatchDuplicate(target);
            pruneDeArrowWatchDuplicate(target.parentElement);
            titleReady = prepareDeArrowTitleIdentity(target, vid);
            // A heading we wrote for another video can be reused with no
            // replacement markers left behind — a native repair below leaves
            // none, so a later end-screen navigation to a video without a
            // DeArrow title would otherwise keep the old text forever. Track
            // our own last write and treat an unchanged heading as stale.
            if (titleReady) {
                const written = target.dataset.ytbDeWatchWritten;
                if (written && written !== vid) {
                    if ((target.textContent || '') ===
                        (target.dataset.ytbDeWatchWrittenTitle || '')) {
                        titleReady = false;
                    } else {
                        // YouTube hydrated the heading since our last write.
                        target.removeAttribute('data-ytb-de-watch-written');
                        target.removeAttribute('data-ytb-de-watch-written-title');
                    }
                }
            }
            if (!titleReady && playerMatches && playerData.title) {
                // YouTube can reuse the watch heading without hydrating its text
                // again after our replacement. Player data is authoritative once
                // its video ID agrees with the URL, so use it to break the stale
                // A-title/awaiting-B deadlock and preserve B's real original.
                target.textContent = playerData.title;
                target.removeAttribute('data-ytb-de-await-title');
                target.removeAttribute('data-ytb-de-stale-title');
                target.dataset.ytbDeWatchWritten = vid;
                target.dataset.ytbDeWatchWrittenTitle = playerData.title;
                deArrowAppliedTitles = true;
                titleReady = true;
            }
        }

        const entry = vid && deCache.get(vid);
        if (vid && entry === undefined) {
            if (deInFlight.size < DE_CONCURRENCY) deLookup(vid);
            return;
        }
        if (!entry || entry === 'pending' || !entry.title) return;
        if (h1 && titleReady) {
            applyDeArrowTitle(h1, vid, entry.title, h1);
            if (target && target.dataset.ytbDeTitle === vid) {
                target.dataset.ytbDeWatchWritten = vid;
                target.dataset.ytbDeWatchWrittenTitle = target.textContent || '';
            }
        }
    }

    // Community integrations still need to decorate appended cards. Keep a
    // bounded dirty queue and keep no more than six lookups per integration in
    // flight; duplicate cards remain queued until their shared lookup resolves.
    function queueTileEnhancements(tiles, unresolvedOnly) {
        if (tiles && tiles.size) {
            tiles.forEach(tile => {
                const syncDecorations = settings.enabled && (
                    (settings.sbEnabled && settings.sbThumbnailBadges) ||
                    settings.deArrowTitles || settings.deArrowThumbs
                );
                let vid = null;
                if (syncDecorations) {
                    vid = getVideoIdFromNode(tile);
                    if (settings.sbEnabled && settings.sbThumbnailBadges) {
                        const stale = tile.querySelector('.ytb-sb-badge');
                        if (stale && (!vid || stale.dataset.vid !== vid)) stale.remove();
                    }
                    if (vid && (settings.deArrowTitles || settings.deArrowThumbs)) {
                        // Href recycling is observed page-wide; retire decorations
                        // for the previous identity in the same pre-paint microtask.
                        prepareDeArrowTileIdentity(tile, vid);
                    }
                }
                if (!unresolvedOnly) {
                    pendingTileEnhancements.add(tile);
                    return;
                }
                if (!vid) vid = getVideoIdFromNode(tile);
                if (!vid) return;
                const sbPending = settings.enabled && settings.sbEnabled &&
                    settings.sbThumbnailBadges && sbWantedCategories().length &&
                    (sbBadgeValue(vid) === undefined || sbBadgeValue(vid) === 'pending');
                const dePending = settings.enabled &&
                    (settings.deArrowTitles || settings.deArrowThumbs) &&
                    (!deCache.has(vid) || deCache.get(vid) === 'pending');
                if (sbPending || dePending) pendingTileEnhancements.add(tile);
            });
        }
        if (retired || tileEnhancementTimer || !pendingTileEnhancements.size) return;
        tileEnhancementTimer = setTimeout(() => {
            tileEnhancementTimer = null;
            if (retired) return;
            const runBadges = settings.enabled && settings.sbEnabled &&
                settings.sbThumbnailBadges && sbWantedCategories().length;
            const runDeArrow = settings.enabled &&
                (settings.deArrowTitles || settings.deArrowThumbs);
            if (!runBadges && !runDeArrow) {
                pendingTileEnhancements.clear();
                return;
            }

            const batch = [];
            for (const tile of pendingTileEnhancements) {
                batch.push(tile);
                if (batch.length >= 24) break;
            }
            if (runBadges) processSbBadges(batch);
            if (runDeArrow) processDeArrow(batch);

            for (const tile of batch) {
                const vid = getVideoIdFromNode(tile);
                const sbValue = sbBadgeValue(vid);
                const sbDone = !runBadges ||
                    (sbValue !== undefined && sbValue !== 'pending');
                const deDone = !runDeArrow ||
                    (deCache.has(vid) && deCache.get(vid) !== 'pending');
                if (tile.isConnected === false || tile.closest('.ytb-removed') || !vid ||
                    (sbDone && deDone)) {
                    pendingTileEnhancements.delete(tile);
                }
            }
            if (pendingTileEnhancements.size) queueTileEnhancements();
        }, 250);
    }
    /* ---- Return YouTube Dislike ---------------------------------------- */
    function formatCount(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
    }

    // Only the watch page's action-bar dislike buttons: the same view-model
    // is also used for comment dislikes, and YouTube keeps several hidden
    // sizing variants of the action bar around, so patch every match in the
    // metadata area (hidden ones are harmless, whichever shows carries it).
    function dislikeButtons() {
        // Everything scoped to ytd-watch-metadata: the same view-models and
        // the legacy #dislike-button id are ALSO used by comment toolbars
        // (verified live 2026-07 — an unscoped selector stamped the video's
        // count onto every comment).
        return [...document.querySelectorAll(
            'ytd-watch-metadata dislike-button-view-model button, ' +
            'ytd-watch-metadata #segmented-dislike-button button, ' +
            'ytd-watch-metadata ytd-toggle-button-renderer#dislike-button button'
        )];
    }

    function applyRydTo(b, vid, res) {
        b.dataset.ytbRyd = vid;
        const label = formatCount(res.dislikes);
        const txt = b.querySelector('.yt-spec-button-shape-next__button-text-content');
        if (txt) {
            txt.textContent = label;
        } else {
            // Icon-only button: append a count and widen it. YouTube pins the
            // button AND its view-model wrappers to a fixed width with
            // higher-specificity !important rules, so inline styles it is
            // (verified live 2026-07: stylesheet width:auto!important lost).
            let span = b.querySelector('.ytb-ryd-count');
            if (!span) {
                span = document.createElement('span');
                span.className = 'ytb-ryd-count';
                b.appendChild(span);
            }
            span.textContent = label;
            b.classList.add('ytb-ryd-btn');
            b.style.setProperty('padding-right', '16px', 'important');
            const stop = b.closest('segmented-like-dislike-button-view-model');
            let el = b;
            while (el && stop && el !== stop) {
                el.style.setProperty('width', 'auto', 'important');
                el = el.parentElement;
            }
            if (!stop) b.style.setProperty('width', 'auto', 'important');
        }
        b.title = res.dislikes.toLocaleString() + ' dislikes — Return YouTube Dislike';
    }

    let rydPendingVid = null;
    function processRyd() {
        if (!settings.rydEnabled || location.pathname !== '/watch') return;
        const vid = watchVideoId();
        if (!vid || rydPendingVid === vid) return;
        const btns = dislikeButtons();
        if (!btns.length || btns.every(b => b.dataset.ytbRyd === vid)) return;
        rydPendingVid = vid;
        api.runtime.sendMessage({ action: 'ytb-ryd-votes', videoId: vid }).then((res) => {
            rydPendingVid = null;
            if (!res || res.dislikes == null || watchVideoId() !== vid) return;
            dislikeButtons().forEach(b => applyRydTo(b, vid, res));
        }).catch(() => { rydPendingVid = null; });
    }

    // Merge any identifiers found on the current page into a matching block
    // entry, so a block made with only one identifier (e.g. an @handle) learns
    // the others (name, UC id) and starts matching every surface.
    function enrichBlockedChannel(info) {
        if (!info) return;
        let changed = false;
        for (const c of state.blockedChannels) {
            if (!sameChannel(c, info)) continue;
            if (info.handle && !c.handle) { c.handle = info.handle; changed = true; }
            if (info.channelId && !c.channelId) { c.channelId = info.channelId; changed = true; }
            if (info.name && !c.name) { c.name = info.name; changed = true; }
        }
        if (changed) { rebuildDerived(); saveOnly(); }
    }

    // Channel identity of the page itself (watch-page owner or channel page).
    // Computed once per pass in runAll and shared by enrichment + blackout.
    function getCurrentPageChannelInfo() {
        return location.pathname === '/watch'
            ? getWatchPageOwnerInfo()
            : getChannelInfoFromChannelPage();
    }

    function enrichFromCurrentPage(pageInfo) {
        if (pageInfo && tileMatchesBlockedChannel(pageInfo)) enrichBlockedChannel(pageInfo);
    }

    function runAll() {
        if (retired) return;
        try {
            // Master switch: undo our footprint and stop. The storage listener
            // stays live, so flipping it back on recovers without a reload.
            if (!settings.enabled) {
                clearBlackout();
                unhideAll();
                if (boostGain) boostGain.gain.value = 1;
                const slider = document.getElementById('ytb-boost-slider');
                if (slider) slider.remove();
                document.querySelectorAll('.ytb-cinema-btn, .ytb-extra-btn').forEach(b => b.remove());
                document.querySelectorAll('.ytb-sb-badge').forEach(b => b.remove());
                restoreDeArrowTitles();
                restoreDeArrowThumbs();
                removeChannelBadge();
                clearLoop();
                exitCinema();
                return;
            }
            // Channel identity of the current channel page (null elsewhere).
            // Resolved once per pass and shared by the watched-database
            // attribution and the "Watched N / total" badge.
            curChannelInfo = WatchedDB ? getChannelInfoFromChannelPage() : null;
            // flattenRows() intentionally not called: physically moving every
            // tile out of its row generated add/remove churn and fought the
            // renderer. The display:contents CSS already reflows the grid.
            if (settings.blockShorts) removeShortsSurfaces();
            if (settings.blockShorts || settings.hideNewsShelves) removeRichSections();
            if (settings.hidePromos) removeNonVideoCards();
            if (settings.hideMixes || settings.hidePlaylists) removeMixesAndPlaylists();
            if (settings.hideMembersOnly) removeMembersOnly();
            if (settings.hidePaidVideos) removePaidVideos();
            if (settings.hideWatched && watchedAllowedHere()) {
                processWatchedProgress();
            }
            // Page identity is only needed when channels are blocked; resolve it
            // once and share it between enrichment and blackout.
            const pageInfo = state.blockedChannels.length ? getCurrentPageChannelInfo() : null;
            enrichFromCurrentPage(pageInfo);   // learn missing identifiers, rebuild index if changed
            // Progress markers were handled by the single global marker pass
            // above; avoid two per-card selector queries during full recovery.
            const pageTiles = processTiles(null, false, false); // then apply ID/channel/title rules
            processEndScreen();                // and the in-player end-screen suggestions
            processComments();                 // comment keyword filtering (watch pages)
            // Menu scanning is expensive (*[role="menuitem"]); only do it shortly
            // after a press, when a menu may actually have opened.
            if (Date.now() - lastPointerDown < 3000) injectCustomMenuItems();
            processBlackout(pageInfo);
            if (settings.maxQuality && !blackoutActive) applyMaxQuality();
            applyVolumeBoost();
            ensureWheelListener();
            ensureBoostSlider();
            ensureCinemaButton();
            ensureExtraButtons();
            applyDefaultSpeed();
            preventIdlePause();
            enforceAutoplayOff();
            autoExpandDescription();
            ensureWatchedHook(playerVideo());   // record the video being watched
            updateChannelWatchBadge();          // "Watched N / total" on channel pages
            ensureSponsorBlock();
            updateSbMarkers();
            if (!settings.deArrowTitles) restoreDeArrowTitles();
            if (!settings.deArrowThumbs) restoreDeArrowThumbs();
            const wantsTileEnhancements =
                (settings.sbEnabled && settings.sbThumbnailBadges &&
                 sbWantedCategories().length) ||
                settings.deArrowTitles || settings.deArrowThumbs;
            const enhancementTiles = wantsTileEnhancements
                ? (pageTiles || collectAllTiles()) : null;
            processSbBadges(enhancementTiles || undefined);
            processDeArrowWatchPage(); // reserve a lookup slot for the visible video
            processDeArrow(enhancementTiles || undefined);
            if (enhancementTiles) queueTileEnhancements(enhancementTiles, true);
            processRyd();
        } catch (e) {
            console.warn('[YT Blocker] pass error:', e);
        }
    }

    /* ==================================================================
     * 5. Actions (hide video / block channel) + native don't-recommend
     * ================================================================== */
    function rememberHiddenVideo(id, node, channel) {
        if (!id) return;
        const image = node && node.querySelector &&
            node.querySelector('img[src], img[data-thumb], yt-image img');
        state.hiddenVideoMetadata[id] = {
            title: node ? getTitleFromNode(node) : '',
            channel: channel && (channel.name || channel.handle || channel.channelId) || '',
            thumbnail: image && (image.currentSrc || image.src) || '',
            addedAt: Date.now()
        };
        const entries = Object.entries(state.hiddenVideoMetadata);
        if (entries.length > 2000) {
            entries.sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0));
            state.hiddenVideoMetadata = Object.fromEntries(entries.slice(0, 2000));
        }
    }
    function undoHideVideo(id) {
        const i = state.hiddenVideoIds.indexOf(id);
        if (i >= 0) state.hiddenVideoIds.splice(i, 1);
        delete state.hiddenVideoMetadata[id];
        // Drop it from the per-channel "Hidden" tally too (hiding and watching
        // are tracked separately, so this never touches the watched database).
        if (WatchedDB) WatchedDB.removeHidden(id);
        unhideAll();   // pass re-hides anything that should stay hidden
        persist();
    }

    function undoBlockChannel(info) {
        state.blockedChannels = state.blockedChannels.filter(c => !sameChannel(c, info));
        unhideAll();
        persist();
    }

    function hideVideoAtTarget(target) {
        const tile = findTileFromTarget(target);
        if (!tile) { toast('No video tile under the cursor.'); return; }
        const id = getVideoIdFromNode(tile);
        if (!id) { toast('Could not read a video ID here.'); return; }
        if (!hiddenSet.has(id)) state.hiddenVideoIds.push(id);
        const chan = getChannelInfoFromNode(tile) || curChannelInfo;
        rememberHiddenVideo(id, tile, chan);
        // Count it against this video's channel (separate from watched).
        if (WatchedDB) {
            if (chan) WatchedDB.recordChannelHidden(chan, id);
        }
        removeTile(tile);
        persist();
        toast('Hid video', id, () => undoHideVideo(id));
    }

    // Add a video to the watched database (distinct from hiding it). Attributes
    // it to the video's channel so the channel-page "Watched N / total" grows.
    function markWatchedAtTarget(target) {
        if (!WatchedDB) return;
        const tile = findTileFromTarget(target);
        let id = tile ? getVideoIdFromNode(tile) : null;
        let chan = tile ? getChannelInfoFromNode(tile) : null;
        if (!id && location.pathname === '/watch') {
            id = watchVideoId();
            chan = getWatchPageOwnerInfo();
        }
        if (!id) { toast('Could not read a video ID here.'); return; }
        WatchedDB.markWatched(id);
        if (chan) WatchedDB.recordChannelVideo(chan, id);
        if (tile) removeTile(tile);   // watched videos are hidden
        toast('Marked as watched', id, () => {
            WatchedDB.remove(id);
            unhideAll();
            runAll();
        });
    }

    function channelLabel(info) {
        return info.name || (info.handle ? '@' + info.handle : info.channelId);
    }

    // Adds to the block list (no persist). Returns true if it was already present.
    function addChannelToList(info) {
        const already = state.blockedChannels.some(c => sameChannel(c, info));
        if (!already) {
            state.blockedChannels.push({
                name: info.name || '',
                handle: info.handle || '',
                channelId: info.channelId || '',
                addedAt: Date.now()
            });
        }
        return already;
    }

    // Right-click path (browser context menu). Opens the native menu fresh to
    // attempt "Don't recommend channel".
    function blockChannelAtTarget(target) {
        const tile = findTileFromTarget(target);
        // On a tile, attribute ONLY to that tile (never the watched video).
        // Off a tile, try a clicked channel link, the channel page, then the
        // watch-page owner.
        const info = tile
            ? getChannelInfoFromNode(tile)
            : (getChannelInfoFromAnchor(target) ||
               getChannelInfoFromChannelPage() ||
               getWatchPageOwnerInfo());
        if (!info || (!info.handle && !info.channelId && !info.name)) {
            toast('Could not detect a channel here. Try right-clicking the channel name.');
            return;
        }
        const already = addChannelToList(info);
        persist();
        toast(already ? 'Already blocking' : 'Blocked channel', channelLabel(info),
              already ? null : () => undoBlockChannel(info));
    }

    /* ==================================================================
     * 5b. Inject a "Block channel" item into YouTube's native 3-dot menu
     * ================================================================== */
    // Selector covering both the classic (ytd-*) and newer (view-model) menus.
    const MENU_ITEM_SELECTOR = [
        'ytd-menu-service-item-renderer',
        'ytd-menu-navigation-item-renderer',
        'yt-list-item-view-model',
        'tp-yt-paper-item',
        '*[role="menuitem"]',
        // m.youtube.com bottom-sheet menu entries
        'ytm-menu-service-item-renderer',
        'ytm-menu-navigation-item-renderer',
        'button.menu-item-button',
        '*[role="option"]'
    ].join(',');

    // "Don't recommend channel" in YouTube's most common UI languages — used
    // only to LOCATE the native item as an insertion anchor for our own
    // "Block channel" menu entry (never clicked). Lowercase, straight quotes.
    const DNR_TEXTS = [
        "don't recommend channel", 'dont recommend channel',
        'kanal nicht empfehlen',                          // de
        'no recomendar canal', 'no recomendar este canal',// es
        'ne pas recommander la chaîne',                   // fr
        'non consigliare il canale',                      // it
        'não recomendar canal', 'não recomendar o canal', // pt
        'kanaal niet aanbevelen',                         // nl
        'nie polecaj filmów z tego kanału',               // pl
        'не рекомендовать видео с этого канала',          // ru
        'kanalı önerme',                                  // tr
        'チャンネルをおすすめに表示しない',                  // ja
        '채널 추천 안함',                                  // ko
        '不再推荐此频道', '不再推薦此頻道'                    // zh
    ];

    function isDnrText(raw) {
        if (!raw) return false;
        const t = raw.replace(/[’‘]/g, "'").trim().toLowerCase();
        if (!t) return false;
        return DNR_TEXTS.some(s => t.includes(s));
    }

    function isVisible(el) {
        return el && el.offsetParent !== null;
    }

    // Locate the currently-open video action menu regardless of which menu
    // implementation YouTube is using. Returns the items container + the
    // "Don't recommend channel" node (if present) to anchor insertion.
    function findOpenVideoMenu() {
        const nodes = document.querySelectorAll(MENU_ITEM_SELECTOR);
        let dnr = null, signal = null;
        for (const it of nodes) {
            if (it.classList && it.classList.contains('ytb-menu-item')) continue;
            if (!isVisible(it)) continue;
            const t = (it.textContent || '').trim().toLowerCase();
            if (!t) continue;
            if (isDnrText(t)) {
                dnr = it;
            } else if (!signal &&
                       (t.includes('add to queue') || t.includes('save to watch later') ||
                        t.includes('save to playlist'))) {
                signal = it;
            }
        }
        let anchor = dnr || signal;
        // Non-English UIs won't match the English signal strings. If the menu
        // was opened from a tile's 3-dot button (menuOwnerTile), any visible
        // popup menu is the video menu, so anchor on its last item instead.
        // Desktop menus live in ytd-popup-container; mobile ones in a
        // bottom-sheet container.
        if (!anchor && menuOwnerTile) {
            const roots = document.querySelectorAll(
                'ytd-popup-container, bottom-sheet-container, .bottom-sheet-container, ytm-menu-popup-renderer'
            );
            for (const root of roots) {
                for (const it of root.querySelectorAll(MENU_ITEM_SELECTOR)) {
                    if (it.classList && it.classList.contains('ytb-menu-item')) continue;
                    if (isVisible(it) && (it.textContent || '').trim()) anchor = it;
                }
            }
        }
        if (!anchor || !anchor.parentNode) return null;
        return { container: anchor.parentNode, dnr };
    }

    function closeNativeMenu() {
        try {
            const dd = document.querySelector('ytd-popup-container tp-yt-iron-dropdown');
            if (dd && typeof dd.close === 'function') { dd.close(); return; }
        } catch (e) { /* fall through */ }
        // Mobile bottom sheet: tapping the dimmed backdrop closes it.
        const overlay = document.querySelector('c3-overlay, .c3-overlay, .bottom-sheet-overlay');
        if (overlay && isVisible(overlay)) { overlay.click(); return; }
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', keyCode: 27, which: 27, bubbles: true
        }));
    }

    // Channel for the menu that is currently open. When the menu was opened
    // from a tile, attribute ONLY to that tile — never fall back to the watch
    // page owner, or blocking from a recommendation would block the video you
    // are watching. The page owner is used only for the main video's own menu.
    function resolveMenuChannelInfo() {
        if (menuOwnerTile) return getChannelInfoFromNode(menuOwnerTile);
        if (menuOwnerIsMain) return getWatchPageOwnerInfo();
        return null;
    }

    function onInjectedBlockClick(e) {
        if (retired) return;
        e.preventDefault();
        e.stopPropagation();
        const info = e.currentTarget._info || resolveMenuChannelInfo();
        if (!info || (!info.handle && !info.channelId && !info.name)) {
            toast('Could not detect a channel for this menu.');
            // Diagnostic: expand this element in the console and share its markup
            // if a tile's channel still can't be read.
            console.warn('[YT Blocker] Could not detect channel. Menu owner tile:', menuOwnerTile);
            closeNativeMenu();
            return;
        }
        const already = addChannelToList(info);
        closeNativeMenu();
        persist();
        toast(already ? 'Already blocking' : 'Blocked channel', channelLabel(info),
              already ? null : () => undoBlockChannel(info));
    }

    function svgEl(name, attrs) {
        const e = document.createElementNS('http://www.w3.org/2000/svg', name);
        for (const k in attrs) e.setAttribute(k, attrs[k]);
        return e;
    }

    // Video the currently-open menu belongs to (its owner tile, or the main
    // watch video when the menu was opened from the video's own metadata).
    function resolveMenuVideoId() {
        if (menuOwnerTile) return getVideoIdFromNode(menuOwnerTile);
        if (menuOwnerIsMain) return watchVideoId();
        return null;
    }

    // Outline icons (stroked via .ytb-mi-icon svg CSS) matching native menu items.
    function drawBlockIcon(svg) {
        svg.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 9 }));
        svg.appendChild(svgEl('line', { x1: 5.6, y1: 5.6, x2: 18.4, y2: 18.4 }));
    }
    function drawWatchedIcon(svg) {   // check inside a circle
        svg.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 9 }));
        svg.appendChild(svgEl('polyline', { points: '7.8 12.4 10.8 15.4 16.2 9' }));
    }
    function drawHideIcon(svg) {      // eye with a slash through it
        svg.appendChild(svgEl('path', { d: 'M3 12s3.6-6 9-6 9 6 9 6-3.6 6-9 6-9-6-9-6Z' }));
        svg.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 2.6 }));
        svg.appendChild(svgEl('line', { x1: 4, y1: 4, x2: 20, y2: 20 }));
    }

    function buildMenuItem(label, drawIcon, onClick) {
        const el = document.createElement('div');
        el.className = 'ytb-menu-item';
        el.setAttribute('role', 'menuitem');
        el.tabIndex = 0;
        el._ownerTile = menuOwnerTile;
        el.dataset.ytbInstance = INSTANCE_ID;
        const icon = document.createElement('div');
        icon.className = 'ytb-mi-icon';
        const svg = svgEl('svg', {
            viewBox: '0 0 24 24', 'stroke-width': '2',
            'stroke-linecap': 'round', 'stroke-linejoin': 'round'
        });
        drawIcon(svg);
        icon.appendChild(svg);
        const text = document.createElement('div');
        text.className = 'ytb-mi-text';
        text.textContent = label;
        el.appendChild(icon);
        el.appendChild(text);
        el.addEventListener('click', onClick);
        el.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') onClick(ev);
        });
        return el;
    }

    function onInjectedMarkWatchedClick(e) {
        if (retired) return;
        e.preventDefault();
        e.stopPropagation();
        const id = resolveMenuVideoId();
        const chan = resolveMenuChannelInfo();
        closeNativeMenu();
        if (!WatchedDB || !id) { toast('Could not read a video for this menu.'); return; }
        WatchedDB.markWatched(id);
        if (chan) WatchedDB.recordChannelVideo(chan, id);
        if (menuOwnerTile) removeTile(menuOwnerTile);
        toast('Marked as watched', id, () => { WatchedDB.remove(id); unhideAll(); runAll(); });
    }

    function onInjectedHideClick(e) {
        if (retired) return;
        e.preventDefault();
        e.stopPropagation();
        const id = resolveMenuVideoId();
        const chan = resolveMenuChannelInfo();
        closeNativeMenu();
        if (!id) { toast('Could not read a video for this menu.'); return; }
        if (!hiddenSet.has(id)) state.hiddenVideoIds.push(id);
        rememberHiddenVideo(id, menuOwnerTile, chan);
        if (WatchedDB && chan) WatchedDB.recordChannelHidden(chan, id);
        if (menuOwnerTile) removeTile(menuOwnerTile);
        persist();
        toast('Hid video', id, () => undoHideVideo(id));
    }

    // Our custom rows, in display order. "Mark as watched" / "Hide video" are
    // omitted from the main watch video's own menu (you can't usefully hide the
    // video you're on); "Block channel" applies everywhere.
    function injectCustomMenuItems() {
        const menu = findOpenVideoMenu();
        if (!menu) {
            // No video menu open — drop any stray injected items.
            document.querySelectorAll('.ytb-menu-item').forEach(el => el.remove());
            return;
        }
        const existing = menu.container.querySelector('.ytb-menu-item');
        if (existing) {
            if (existing.dataset.ytbInstance === INSTANCE_ID &&
                existing._ownerTile === menuOwnerTile) return;   // still the same menu
            menu.container.querySelectorAll('.ytb-menu-item').forEach(el => el.remove());
        }
        const items = [];
        if (WatchedDB && menuOwnerTile) {
            items.push(buildMenuItem('Mark as watched', drawWatchedIcon, onInjectedMarkWatchedClick));
        }
        if (menuOwnerTile) {
            items.push(buildMenuItem('Hide video', drawHideIcon, onInjectedHideClick));
        }
        items.push(buildMenuItem('Block channel', drawBlockIcon, onInjectedBlockClick));
        const anchor = (menu.dnr && menu.dnr.parentNode === menu.container) ? menu.dnr.nextSibling : null;
        for (const item of items) {
            if (anchor) menu.container.insertBefore(item, anchor);
            else menu.container.appendChild(item);
        }
    }

    /* ==================================================================
     * 5c. Blackout: if the current page is a blocked channel (its channel
     *     page, or a watch page for one of its videos), stop playback and
     *     hide the content behind a black panel — keeping the recommendations
     *     rail. Best-effort at preventing a view from being registered.
     * ================================================================== */
    function ensureNoPlayHook(v) {
        if (v.dataset.ytbHook === INSTANCE_ID) return;
        v.dataset.ytbHook = INSTANCE_ID;
        // YouTube reuses one <video> across SPA navigations, so the guard must
        // read the live flag rather than pausing unconditionally.
        const guard = () => { if (blackoutActive && !retired) { try { v.pause(); } catch (e) {} } };
        v.addEventListener('play', guard, true);
        v.addEventListener('playing', guard, true);
        v.addEventListener('loadeddata', guard, true);
    }

    function stopPlayback() {
        const v = document.querySelector('video');
        if (!v) return;
        ensureNoPlayHook(v);
        try { v.pause(); } catch (e) {}
    }

    function blackoutLabel(info) {
        return info.name || (info.handle ? '@' + info.handle : info.channelId) || 'This channel';
    }

    function buildBlackoutPanel() {
        const panel = document.createElement('div');
        panel.id = 'ytb-blackout-panel';
        panel.dataset.ytbOwner = INSTANCE_ID;
        const icon = document.createElement('div');
        icon.className = 'ytb-bo-icon';
        icon.textContent = '🚫';
        const title = document.createElement('div');
        title.className = 'ytb-bo-title';
        title.textContent = 'Channel blocked';
        const sub = document.createElement('div');
        sub.className = 'ytb-bo-sub';
        const actions = document.createElement('div');
        actions.className = 'ytb-bo-actions';
        const unblock = document.createElement('button');
        unblock.className = 'ytb-bo-btn';
        unblock.textContent = 'Unblock this channel';
        unblock.addEventListener('click', () => {
            if (panel._info) unblockChannel(panel._info);
        });
        actions.appendChild(unblock);
        panel.appendChild(icon);
        panel.appendChild(title);
        panel.appendChild(sub);
        panel.appendChild(actions);
        return panel;
    }

    function setPanelInfo(panel, info) {
        panel._info = info;
        const sub = panel.querySelector('.ytb-bo-sub');
        if (sub) {
            sub.textContent = blackoutLabel(info) +
                ' is on your block list — its video, thumbnail and view count are not loaded.';
        }
    }

    function placePanel(container, info, asFirstChild) {
        if (!container) return;
        let panel = document.getElementById('ytb-blackout-panel');
        // Rebuild a panel left by a previous instance — its button listeners
        // point at a dead sandbox.
        if (panel && panel.dataset.ytbOwner !== INSTANCE_ID) { panel.remove(); panel = null; }
        if (!panel) panel = buildBlackoutPanel();
        if (panel.parentNode !== container) {
            if (asFirstChild) container.insertBefore(panel, container.firstChild);
            else container.appendChild(panel);
        }
        setPanelInfo(panel, info);
    }

    function currentBlockedPage(pageInfo) {
        if (!pageInfo || !tileMatchesBlockedChannel(pageInfo)) return null;
        return { type: location.pathname === '/watch' ? 'watch' : 'channel', info: pageInfo };
    }

    function clearBlackout() {
        if (retired) return;
        if (!blackoutActive && !document.getElementById('ytb-blackout-panel')) return;
        blackoutActive = false;
        document.querySelectorAll('.ytb-blackout').forEach(el => el.classList.remove('ytb-blackout'));
        const p = document.getElementById('ytb-blackout-panel');
        if (p) p.remove();
    }

    function processBlackout(pageInfo) {
        if (!settings.blackoutBlockedChannels) { clearBlackout(); return; }
        const hit = currentBlockedPage(pageInfo);
        if (!hit) { clearBlackout(); return; }
        blackoutActive = true;
        stopPlayback();
        if (hit.type === 'watch') {
            // Desktop watch page, or the single-column m.youtube.com one.
            const flexy = document.querySelector('ytd-watch-flexy') ||
                          document.querySelector('ytm-watch');
            if (flexy) flexy.classList.add('ytb-blackout');
            const primaryInner = document.querySelector('ytd-watch-flexy #primary-inner') ||
                                 document.querySelector('#primary-inner');
            placePanel(primaryInner || flexy || document.body, hit.info, true);
        } else {
            const browse = document.querySelector('ytd-browse[page-subtype="channels"]') ||
                           document.querySelector('ytd-browse, ytm-browse');
            if (browse) browse.classList.add('ytb-blackout');
            placePanel(browse || document.querySelector('#page-manager') || document.body, hit.info, true);
        }
    }

    async function unblockChannel(info) {
        state.blockedChannels = state.blockedChannels.filter(c => !sameChannel(c, info));
        await persist();
        // Content was never loaded, so reload to bring the page back cleanly.
        location.reload();
    }

    /* ==================================================================
     * 5d. Chromium player bridge and highest available quality.
     *     Firefox exposes the page-world player API via wrappedJSObject.
     *     Chromium uses page-quality.js in the MAIN world and relays requests
     *     and completion messages through postMessage.
     * ================================================================== */
    function onPageQualityMessage(e) {
        if (retired || e.source !== window || !e.data) return;
        if (e.data.type === 'ytb-max-quality-done' && e.data.vid) {
            lastQualityVideoId = e.data.vid;
            return;
        }
        if (e.data.type !== 'ytb-video-data') return;

        const pending = deArrowWatchPlayerPending;
        if (!pending || e.data.token !== pending.token ||
            e.data.requestedVid !== pending.vid) return;
        if (deArrowWatchPlayerRetryTimer) {
            clearTimeout(deArrowWatchPlayerRetryTimer);
            deArrowWatchPlayerRetryTimer = null;
        }
        deArrowWatchPlayerPending = null;

        const videoId = cleanText(typeof e.data.videoId === 'string'
            ? e.data.videoId : '');
        const title = cleanText(typeof e.data.title === 'string'
            ? e.data.title : '');
        if (videoId) deArrowWatchPlayerData = { videoId, title };

        if (videoId === watchVideoId() && title) {
            resetDeArrowWatchPlayerRetry();
            refreshDeArrowWatchTitle();
        } else {
            // The bridge can answer while the player still identifies the old
            // video or an ad. Retry briefly without creating a synchronous
            // message loop; navigation and the recovery pass remain fallbacks.
            scheduleDeArrowWatchPlayerRetry(
                pending.vid, DE_WATCH_PLAYER_RETRY_DELAY_MS, null
            );
        }
    }
    window.addEventListener('message', onPageQualityMessage);

    function applyMaxQuality() {
        if (location.pathname !== '/watch') return;
        const vid = new URLSearchParams(location.search).get('v');
        if (!vid || vid === lastQualityVideoId) return;   // already done this video
        const player = document.getElementById('movie_player');
        if (!player) return;
        const pApi = player.wrappedJSObject || player;
        if (typeof pApi.getAvailableQualityLevels !== 'function') {
            window.postMessage({ type: 'ytb-max-quality', vid }, location.origin);
            return;
        }
        let levels;
        try { levels = pApi.getAvailableQualityLevels(); } catch (e) { return; }
        if (!levels || !levels.length) return;            // player not ready yet
        const best = levels[0];                           // ordered highest -> lowest
        try {
            if (typeof pApi.setPlaybackQualityRange === 'function') pApi.setPlaybackQualityRange(best, best);
            if (typeof pApi.setPlaybackQuality === 'function') pApi.setPlaybackQuality(best);
            lastQualityVideoId = vid;
        } catch (e) { /* ignore */ }
    }

    /* ==================================================================
     * 5e. Volume boost (Web Audio gain on top of YouTube's own volume).
     *     The graph is ONLY built once boost is turned up, and only from a
     *     user gesture — so default users keep untouched native audio, and we
     *     never route the element through a suspended context (which would mute
     *     it). createMediaElementSource can run once per element; YouTube reuses
     *     one <video>, so the graph persists across navigations.
     * ================================================================== */
    let audioCtx = null, boostGain = null, boostSrc = null, compNode = null;

    // Audio compressor (FFZ-style leveller): evens out quiet dialogue and
    // loud passages. Sits between the media source and the boost gain.
    function rewireBoostChain() {
        if (!boostSrc || !boostGain) return;
        try { boostSrc.disconnect(); } catch (e) { /* ignore */ }
        if (compNode) { try { compNode.disconnect(); } catch (e) { /* ignore */ } }
        if (settings.ytCompressorOn) {
            if (!compNode) {
                compNode = audioCtx.createDynamicsCompressor();
                compNode.threshold.value = -50;
                compNode.knee.value = 40;
                compNode.ratio.value = 12;
                compNode.attack.value = 0;
                compNode.release.value = 0.25;
            }
            boostSrc.connect(compNode);
            compNode.connect(boostGain);
        } else {
            boostSrc.connect(boostGain);
        }
    }

    function ensureBoostGraph() {
        const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (!v) return false;
        // Only trust a wired flag WE set: a flag from a previous (updated-away)
        // instance means the graph belongs to a dead sandbox — try to re-wire.
        if (v.dataset.ytbBoostWired === INSTANCE_ID) return !!boostGain;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            if (!audioCtx) audioCtx = new AC();
            boostSrc = audioCtx.createMediaElementSource(v);
            boostGain = audioCtx.createGain();
            rewireBoostChain();
            boostGain.connect(audioCtx.destination);
            v.dataset.ytbBoostWired = INSTANCE_ID;
            return true;
        } catch (e) {
            // Typically: the element is still claimed by a dead instance's
            // AudioContext after an in-place update. A page reload fixes it.
            console.warn('[YT Blocker] volume boost unavailable (reload the page if the addon just updated):', e);
            return false;
        }
    }

    // Keep the gain synced. Never wires the graph itself (that needs a gesture).
    function applyVolumeBoost() {
        if (!boostGain) return;
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        boostGain.gain.value = settings.volumeBoost || 1;
    }

    // Called from user gestures (wheel / slider) so the AudioContext can run.
    let boostSaveTimer = null;
    function setVolumeBoost(mult) {
        mult = Math.min(5, Math.max(1, mult));
        state.settings.volumeBoost = mult;
        settings.volumeBoost = mult;
        if (mult > 1) ensureBoostGraph();
        applyVolumeBoost();
        // Debounce persistence — wheel scrolling fires many times.
        clearTimeout(boostSaveTimer);
        boostSaveTimer = setTimeout(saveOnly, 500);
    }

    function showVolumeOverlay(text) {
        let el = document.getElementById('ytb-vol-overlay');
        const player = document.getElementById('movie_player');
        if (!player) return;
        if (!el) {
            el = document.createElement('div');
            el.id = 'ytb-vol-overlay';
            player.appendChild(el);
        }
        el.textContent = text;
        el.classList.add('ytb-show');
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove('ytb-show'), 900);
    }

    // Attach the wheel handler to the player itself (not document): a
    // non-passive document-level wheel listener forces every scroll on the
    // page through JS and janks scrolling everywhere. YouTube reuses one
    // #movie_player across SPA navigations, so this wires at most once.
    function ensureWheelListener() {
        const player = document.getElementById('movie_player');
        if (!player || player.dataset.ytbWheel === INSTANCE_ID) return;
        player.dataset.ytbWheel = INSTANCE_ID;
        player.addEventListener('wheel', onPlayerWheel, { capture: true, passive: false });
    }

    // Scroll over the player to change volume (0-100 native, 100-500 boosted).
    function onPlayerWheel(e) {
        if (retired) return;
        if (!settings.enabled || !settings.wheelVolume) return;
        if (location.pathname !== '/watch') return;
        if (!e.target.closest || !e.target.closest('#movie_player')) return;
        const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (!v) return;
        e.preventDefault();
        e.stopPropagation();
        const cur = Math.round((settings.volumeBoost > 1) ? settings.volumeBoost * 100 : (v.muted ? 0 : v.volume) * 100);
        let next = cur + (e.deltaY < 0 ? 5 : -5);
        next = Math.min(500, Math.max(0, Math.round(next)));
        if (next <= 100) {
            if (v.muted) v.muted = false;
            v.volume = next / 100;
            setVolumeBoost(1);
        } else {
            if (v.muted) v.muted = false;
            v.volume = 1;
            setVolumeBoost(next / 100);
        }
        showVolumeOverlay('🔊 ' + next + '%');
        updateBoostUI();
    }

    // Visible in-player control: a second slider inline next to YouTube's own
    // volume control. It only appears once native volume sits at 100% and
    // extends it to 500% (Web Audio boost). Pulling the native slider back
    // below 100% resets the boost to off and hides the slider again.
    function playerVideo() {
        return document.querySelector('video.html5-main-video') || document.querySelector('video');
    }

    function nativeAtMax(v) {
        return !!v && !v.muted && v.volume >= 0.999;
    }

    function updateBoostUI() {
        if (retired) return;
        const wrap = document.getElementById('ytb-boost-slider');
        if (!wrap || wrap.dataset.ytbOwner !== INSTANCE_ID) return;
        const v = playerVideo();
        const boosting = (settings.volumeBoost || 1) > 1;
        // While a boost is active the element is pinned to 100% and the gain
        // rides on top. Native volume can still fall below 100% two ways:
        //   - the user deliberately drags YouTube's own slider down (or hits the
        //     volume keys) -> honour it and switch the boost off, matching the
        //     "pull the slider back below 100% to reset" behaviour; or
        //   - YouTube re-applies its stored volume on its own -> a spurious drop
        //     (it fires when the volume panel wakes up as the controls fade in
        //     on hover) that must NOT wipe the user's boost.
        // A mute is neither: keep the boost and let it return on unmute.
        if (v && boosting && !v.muted && v.volume < 0.999) {
            const userDriven = nativeVolPointerDown ||
                               (Date.now() - lastNativeVolGesture < 1500);
            if (userDriven) setVolumeBoost(1);   // deliberate: turn boost off
            else v.volume = 1;                    // spurious: re-pin, keep boosting
        }
        const atMax = nativeAtMax(playerVideo());
        wrap.classList.toggle('ytb-hide', !atMax);
        const input = wrap.querySelector('input');
        const label = wrap.querySelector('.ytb-bs-label');
        const pct = Math.round((settings.volumeBoost || 1) * 100);
        if (input && document.activeElement !== input) input.value = pct;
        if (label) label.textContent = pct + '%';
        wrap.classList.toggle('ytb-boosting', pct > 100);
    }

    function ensureBoostSlider() {
        let existing = document.getElementById('ytb-boost-slider');
        // A slider built by a previous (updated-away) instance has listeners
        // bound to a dead sandbox — rebuild it as ours.
        if (existing && existing.dataset.ytbOwner !== INSTANCE_ID) {
            existing.remove();
            existing = null;
        }
        if (location.pathname !== '/watch' || !settings.wheelVolume) {
            if (existing) existing.remove();
            return;
        }
        const volArea = document.querySelector('#movie_player .ytp-volume-area') ||
                        document.querySelector('#movie_player .ytp-volume-panel');
        if (!volArea || !volArea.parentNode) return;
        let wrap = existing;
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'ytb-boost-slider';
            wrap.dataset.ytbOwner = INSTANCE_ID;
            wrap.title = 'Volume boost — shown while volume is at 100%. Click the % to reset.';
            const input = document.createElement('input');
            input.type = 'range';
            input.min = '100';
            input.max = '500';
            input.step = '5';
            const label = document.createElement('span');
            label.className = 'ytb-bs-label';
            wrap.appendChild(input);
            wrap.appendChild(label);
            input.addEventListener('input', (e) => {
                e.stopPropagation();
                const pct = parseInt(input.value, 10) || 100;
                const v = playerVideo();
                if (v) { if (v.muted) v.muted = false; v.volume = 1; }
                setVolumeBoost(pct / 100);
                updateBoostUI();
                showVolumeOverlay('🔊 ' + pct + '%');
            });
            label.addEventListener('click', (e) => {
                e.stopPropagation();
                setVolumeBoost(1);
                updateBoostUI();
            });
        }
        if (wrap.parentNode !== volArea.parentNode || wrap.previousElementSibling !== volArea) {
            volArea.parentNode.insertBefore(wrap, volArea.nextSibling);
        }
        const v = playerVideo();
        if (v && v.dataset.ytbVolListener !== INSTANCE_ID) {
            v.dataset.ytbVolListener = INSTANCE_ID;
            v.addEventListener('volumechange', updateBoostUI);
        }
        updateBoostUI();
    }

    // Playback profiles are applied by the shared player-controls module.
    // A profile boost is session-scoped: it updates the live graph/UI without
    // overwriting the user's base per-device boost setting.
    function onPlaybackProfile(event) {
        if (retired || !event.detail || event.detail.site !== 'youtube') return;
        if (event.detail.speed == null) {
            lastSpeedVideoId = null;
            speedTries = 0;
            setTimeout(applyDefaultSpeed, 0);
        } else {
            const speed = Number(event.detail.speed);
            if (Number.isFinite(speed) && speed >= 0.1 && speed <= 8) {
                const video = playerVideo();
                if (video && !isLivePlayer()) setPlaybackRate(video, speed);
                lastSpeedVideoId = watchVideoId();
                speedTries = 0;
            }
        }
        const profileBoost = event.detail.volumeBoost;
        const boost = profileBoost == null
            ? Number(state.settings.volumeBoost || 1) : Number(profileBoost);
        if (!Number.isFinite(boost)) return;
        settings.volumeBoost = Math.min(5, Math.max(1, boost));
        const video = playerVideo();
        if (video && settings.volumeBoost > 1) {
            video.volume = 1;
            ensureBoostGraph();
        }
        applyVolumeBoost();
        ensureBoostSlider();
        updateBoostUI();
    }
    document.addEventListener('ytb-apply-playback-profile', onPlaybackProfile);
    /* ==================================================================
     * 5c. Cinema mode: a ◐ button in the player's right controls darkens
     * everything around the player. Esc or clicking the dark area exits.
     * Implemented as four dark strips laid around the player's rectangle
     * (geometry inline, tracked while active) — raising the player above
     * one overlay fails whenever an ancestor creates a stacking context.
     * ================================================================== */
    let cinemaTimer = null;

    function cinemaEscHandler(e) {
        if (e.key === 'Escape') exitCinema();
    }

    function updateCinema() {
        const wrap = document.getElementById('ytb-dim');
        if (!wrap) return;
        const p = document.getElementById('movie_player');
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

    function exitCinema() {
        const wrap = document.getElementById('ytb-dim');
        if (wrap) wrap.remove();
        clearInterval(cinemaTimer);
        cinemaTimer = null;
        window.removeEventListener('resize', updateCinema);
        document.removeEventListener('scroll', updateCinema, true);
        document.removeEventListener('keydown', cinemaEscHandler, true);
    }

    function toggleCinema() {
        if (document.getElementById('ytb-dim')) { exitCinema(); return; }
        if (!document.getElementById('movie_player') || !document.body) return;
        const wrap = document.createElement('div');
        wrap.id = 'ytb-dim';
        for (let i = 0; i < 4; i++) wrap.appendChild(document.createElement('div'));
        wrap.addEventListener('click', exitCinema);
        document.body.appendChild(wrap);
        updateCinema();
        cinemaTimer = setInterval(updateCinema, 250);
        window.addEventListener('resize', updateCinema);
        document.addEventListener('scroll', updateCinema, true);
        document.addEventListener('keydown', cinemaEscHandler, true);
    }

    function ensureCinemaButton() {
        let existing = document.querySelector('.ytb-cinema-btn');
        if (existing && existing.dataset.ytbOwner !== INSTANCE_ID) {
            existing.remove();
            existing = null;
        }
        if (location.pathname !== '/watch' || !settings.ytCinemaButton) {
            if (existing) existing.remove();
            if (location.pathname !== '/watch') exitCinema();
            return;
        }
        // Desktop player only — the m.youtube.com player has no ytp controls.
        const controls = playerRightControls();
        if (!controls) return;
        if (existing && existing.parentElement === controls) return;
        if (existing) existing.remove();
        const btn = document.createElement('button');
        btn.className = 'ytp-button ytb-extra-btn ytb-cinema-btn';
        btn.dataset.ytbOwner = INSTANCE_ID;
        btn.title = 'Cinema mode — darken everything around the player (Esc to exit)';
        btn.appendChild(ytpIcon(YTB_ICONS.cinema));
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleCinema();
        });
        controls.insertBefore(btn, controls.firstChild);
    }

    /* ==================================================================
     * 5f. Playback speed suite: default speed per new video, optional
     * per-channel memory, and [ ] \ hotkeys. Live streams are skipped.
     * ================================================================== */
    let lastSpeedVideoId = null;
    let speedTries = 0;
    let speedSaveTimer = null;

    function isLivePlayer() {
        const p = document.getElementById('movie_player');
        return !!(p && p.classList.contains('ytp-live'));
    }

    function channelSpeedKey(info) {
        if (!info) return null;
        if (info.handle) return '@' + info.handle.toLowerCase();
        if (info.channelId) return info.channelId;
        if (info.name) return info.name.toLowerCase().trim();
        return null;
    }

    function setPlaybackRate(v, rate) {
        try {
            // Within the range YouTube's own API accepts, go through it so the
            // player UI stays in sync; the element rate covers the rest.
            // Chromium delegates the page-world call to page-quality.js.
            const p = document.getElementById('movie_player');
            const pApi = p && (p.wrappedJSObject || p);
            if (rate >= 0.25 && rate <= 2) {
                if (pApi && typeof pApi.setPlaybackRate === 'function') pApi.setPlaybackRate(rate);
                else window.postMessage({ type: 'ytb-set-rate', rate }, location.origin);
            }
        } catch (e) { /* element rate below still applies */ }
        try { v.playbackRate = rate; } catch (e) { /* ignore */ }
    }

    function fmtClock(s) {
        s = Math.max(0, Math.floor(s));
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function applyDefaultSpeed() {
        const vid = watchVideoId();
        if (!vid || vid === lastSpeedVideoId) return;
        const v = playerVideo();
        if (!v || v.readyState < 1) return;   // metadata not there yet
        if (isLivePlayer()) { lastSpeedVideoId = vid; return; }
        let target = settings.ytSpeedDefault || 1;
        if (settings.ytSpeedPerChannel) {
            const key = channelSpeedKey(getWatchPageOwnerInfo());
            // The owner byline can render after the video; retry a few passes
            // before falling back to the default speed.
            if (!key && speedTries < 10) { speedTries++; return; }
            if (key && state.ytChannelSpeeds[key]) target = state.ytChannelSpeeds[key];
        }
        lastSpeedVideoId = vid;
        speedTries = 0;
        if (target !== 1) setPlaybackRate(v, target);
    }

    function rememberChannelSpeed(rate) {
        if (!settings.ytSpeedPerChannel || location.pathname !== '/watch') return;
        const key = channelSpeedKey(getWatchPageOwnerInfo());
        if (!key) return;
        if (rate === 1) delete state.ytChannelSpeeds[key];
        else state.ytChannelSpeeds[key] = rate;
        clearTimeout(speedSaveTimer);
        speedSaveTimer = setTimeout(saveOnly, 800);
    }

    function setSpeedTo(rate) {
        const v = playerVideo();
        if (!v) return;
        rate = Math.min(8, Math.max(0.1, Math.round(rate * 100) / 100));
        setPlaybackRate(v, rate);
        showVolumeOverlay('⏩ ' + rate + '×');
        rememberChannelSpeed(rate);
    }

    document.addEventListener('keydown', (e) => {
        if (retired || sharedInputActionsEnabled || !settings.enabled || !settings.ytSpeedHotkeys) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key !== '[' && e.key !== ']' && e.key !== '\\') return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''))) return;
        if (location.pathname !== '/watch') return;
        const v = playerVideo();
        if (!v) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === '\\') setSpeedTo(1);
        else setSpeedTo((v.playbackRate || 1) + (e.key === ']' ? 0.25 : -0.25));
    }, true);

    /* ==================================================================
     * 5g. Extra player buttons: compressor, A-B loop, screenshot.
     * Same lifecycle rules as the cinema button (owner-tagged, rebuilt
     * after an in-place update, removed when their toggle is off).
     * ================================================================== */
    // The 2026 player splits the right controls into -left/-right sections
    // behind an overflow expander; buttons must live INSIDE a section to
    // take part in its flex layout (direct children of the old container
    // overlap the native buttons on narrow players). Older players still
    // have the flat .ytp-right-controls only.
    function playerRightControls() {
        return document.querySelector('#movie_player .ytp-right-controls-left') ||
               document.querySelector('#movie_player .ytp-right-controls');
    }

    // Flat white SVG icons matching the native ytp buttons (24x24 viewBox,
    // scaled by CSS to the button box) — emoji glyphs render as color font
    // at inconsistent sizes next to YouTube's icons.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function ytpIcon(paths) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        for (const d of paths) {
            const p = document.createElementNS(SVG_NS, 'path');
            p.setAttribute('d', d);
            p.setAttribute('fill', '#fff');
            p.setAttribute('fill-rule', 'evenodd');
            p.setAttribute('clip-rule', 'evenodd');
            svg.appendChild(p);
        }
        return svg;
    }

    const YTB_ICONS = {
        // camera body + lens ring
        shot: ['M9.2 4.5 8 6.3H4.9c-1 0-1.9.8-1.9 1.9v9.3c0 1 .8 1.9 1.9 1.9h14.2c1 0 1.9-.8 1.9-1.9V8.2c0-1-.8-1.9-1.9-1.9H16l-1.2-1.8H9.2ZM12 8.9a3.9 3.9 0 1 1 0 7.8 3.9 3.9 0 0 1 0-7.8Zm0 1.7a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z'],
        // repeat arrows
        loop: ['M7 7h10v3l4.5-4L17 2v3H5v6.5h2V7Zm10 10H7v-3l-4.5 4L7 22v-3h12v-6.5h-2V17Z'],
        // mixer: three tracks with fader knobs at different heights
        comp: ['M6.2 3.5h1.6v17H6.2zM11.2 3.5h1.6v17h-1.6zM16.2 3.5h1.6v17h-1.6z',
               'M4.5 8h5v3h-5zM9.5 13.5h5v3h-5zM14.5 6h5v3h-5z'],
        // half-filled circle (cinema)
        cinema: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z',
                 'M12 5a7 7 0 0 0 0 14V5Z'],
        // shield with a skip-forward glyph (SponsorBlock panel)
        sb: ['M12 2 4 5v6c0 4.8 3.4 9.1 8 10.2 4.6-1.1 8-5.4 8-10.2V5l-8-3Zm0 2.15 6 2.25V11c0 3.8-2.6 7.2-6 8.2-3.4-1-6-4.4-6-8.2V6.4l6-2.25Z',
             'M9.2 8.8v6.4l4.2-3.2-4.2-3.2Zm5.2 0h1.6v6.4h-1.6V8.8Z']
    };

    function ensurePlayerButton(cls, want, title, icon, onClick) {
        let btn = document.querySelector('.' + cls);
        if (btn && btn.dataset.ytbOwner !== INSTANCE_ID) { btn.remove(); btn = null; }
        if (location.pathname !== '/watch' || !want) {
            if (btn) btn.remove();
            return null;
        }
        const controls = playerRightControls();
        if (!controls) return null;
        // Re-mount when the player swaps control-bar variants (btn parented
        // to the old flat container while a sectioned one now exists).
        if (btn && btn.parentElement === controls) return btn;
        if (btn) btn.remove();
        btn = document.createElement('button');
        btn.className = 'ytp-button ytb-extra-btn ' + cls;
        btn.dataset.ytbOwner = INSTANCE_ID;
        btn.title = title;
        btn.appendChild(ytpIcon(YTB_ICONS[icon]));
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick(btn);
        });
        controls.insertBefore(btn, controls.firstChild);
        return btn;
    }

    function onCompClick(btn) {
        const next = !settings.ytCompressorOn;
        settings.ytCompressorOn = next;
        state.settings.ytCompressorOn = next;
        if (next && !ensureBoostGraph()) {
            settings.ytCompressorOn = false;
            state.settings.ytCompressorOn = false;
            toast('Compressor unavailable — reload the page if the addon just updated.');
            return;
        }
        rewireBoostChain();
        saveOnly();
        if (btn) btn.classList.toggle('ytb-on', next);
        showVolumeOverlay(next ? '🎚 comp on' : '🎚 comp off');
    }

    /* ---- A-B loop ---- */
    let loopState = { mode: 0, a: 0, b: 0, vid: null };   // 0 off, 1 A set, 2 looping

    function clearLoop() {
        loopState = { mode: 0, a: 0, b: 0, vid: null };
    }

    function ensureLoopHook(v) {
        if (v.dataset.ytbLoopHook === INSTANCE_ID) return;
        v.dataset.ytbLoopHook = INSTANCE_ID;
        v.addEventListener('timeupdate', () => {
            if (retired || loopState.mode !== 2) return;
            if (watchVideoId() !== loopState.vid) { clearLoop(); return; }
            if (v.currentTime > loopState.b || v.currentTime < loopState.a - 1) {
                try { v.currentTime = loopState.a; } catch (e) { /* ignore */ }
            }
        });
    }

    function onLoopClick(btn) {
        const v = playerVideo();
        if (!v) return;
        if (loopState.mode === 0) {
            loopState = { mode: 1, a: v.currentTime, b: 0, vid: watchVideoId() };
            showVolumeOverlay('🔁 A = ' + fmtClock(loopState.a));
        } else if (loopState.mode === 1) {
            let a = loopState.a, b = v.currentTime;
            if (b < a) { const t = a; a = b; b = t; }
            if (b - a < 0.5) b = a + 0.5;
            loopState = { mode: 2, a, b, vid: loopState.vid };
            ensureLoopHook(v);
            showVolumeOverlay('🔁 ' + fmtClock(a) + '–' + fmtClock(b));
        } else {
            clearLoop();
            showVolumeOverlay('🔁 off');
        }
        if (btn) btn.classList.toggle('ytb-on', loopState.mode !== 0);
    }

    /* ---- screenshot ---- */
    function onShotClick() {
        const v = playerVideo();
        if (!v || !v.videoWidth) { toast('No frame to capture yet.'); return; }
        try {
            const c = document.createElement('canvas');
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            c.getContext('2d').drawImage(v, 0, 0);
            const title = (document.title || 'youtube')
                .replace(/ - YouTube$/, '')
                .replace(/[\\/:*?"<>|]+/g, '_')
                .trim().slice(0, 80) || 'youtube';
            const name = title + ' @' + fmtClock(v.currentTime).replace(':', 'm') + 's.png';
            c.toBlob((blob) => {
                if (!blob) { toast('Screenshot failed.'); return; }
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
                showVolumeOverlay('📷 saved');
            }, 'image/png');
        } catch (e) {
            toast('Screenshot failed.');
        }
    }

    function ensureExtraButtons() {
        // Loop dropped on navigation to another video.
        if (loopState.vid && watchVideoId() !== loopState.vid) clearLoop();
        const shot = ensurePlayerButton('ytb-shot-btn', settings.ytShotButton,
            'Save a screenshot of the current frame (PNG)', 'shot', onShotClick);
        const loop = ensurePlayerButton('ytb-loop-btn', settings.ytLoopButton,
            'A-B loop — 1st click sets the start, 2nd the end (loops), 3rd clears', 'loop', onLoopClick);
        const comp = ensurePlayerButton('ytb-comp-btn', settings.ytCompressorButton,
            'Audio compressor — evens out quiet dialogue and loud passages', 'comp', onCompClick);
        // SponsorBlock is present on EVERY video while the feature is on —
        // it's the entry point for creating segments where none exist yet.
        const sbBtn = ensurePlayerButton('ytb-sb-btn', settings.sbEnabled,
            'SponsorBlock — create a segment or vote on this video\'s segments', 'sb', onSbBtnClick);
        if (comp) comp.classList.toggle('ytb-on', !!settings.ytCompressorOn);
        if (loop) loop.classList.toggle('ytb-on', loopState.mode !== 0);
        if (sbBtn) {
            // Green shield when this video has community segments (the cue
            // SponsorBlock users expect); amber while the panel is open.
            const sbSegs = (sbState.vid === watchVideoId() && sbState.segments) || [];
            sbBtn.classList.toggle('ytb-sb-has', sbSegs.length > 0);
            sbBtn.classList.toggle('ytb-on', !!document.getElementById('ytb-sb-panel'));
            sbBtn.title = sbSegs.length
                ? ('SponsorBlock: ' + sbSegs.length + (sbSegs.length === 1 ? ' segment' : ' segments') +
                   ' on this video' + (currentChannelWhitelisted() ? ' (channel whitelisted)' : ''))
                : 'SponsorBlock — create a segment or vote on this video\'s segments';
        }
        if (sbDraft && sbDraft.vid !== watchVideoId()) sbDraft = null;
        void shot;
    }

    /* ==================================================================
     * 6. Toast
     * ================================================================== */
    let toastTimer = null;
    function toast(message, accent, onUndo) {
        let el = document.getElementById('ytb-toast');
        if (!el) {
            if (!document.body) return;
            el = document.createElement('div');
            el.id = 'ytb-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        if (accent) {
            el.appendChild(document.createTextNode(' '));
            const span = document.createElement('span');
            span.className = 'ytb-toast-accent';
            span.textContent = accent;
            el.appendChild(span);
        }
        if (onUndo) {
            const btn = document.createElement('button');
            btn.className = 'ytb-undo';
            btn.textContent = 'Undo';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove('ytb-show');
                try { onUndo(); } catch (err) { /* ignore */ }
            });
            el.appendChild(btn);
        }
        // force reflow so the transition replays
        void el.offsetWidth;
        el.classList.add('ytb-show');
        clearTimeout(toastTimer);
        // Leave more time to hit Undo when it's offered.
        toastTimer = setTimeout(() => el.classList.remove('ytb-show'), onUndo ? 5000 : 2600);
    }

    /* ==================================================================
     * 7. Wiring: context-menu target tracking + background messages
     * ================================================================== */
    document.addEventListener('contextmenu', (e) => {
        if (retired) return;
        lastContextTarget = e.target;
        // Ctrl+right-click = hide this video immediately (works on normal tiles
        // AND in-player end-screen suggestions). Ctrl is used rather than plain
        // right-click so the normal menu still works, and rather than Shift
        // because Firefox bypasses page handlers when Shift is held.
        if (!e.ctrlKey || !e.target.closest) return;
        const still = e.target.closest('a.ytp-videowall-still, a.ytp-modern-videowall-still');
        const tile = still ? null : findTileFromTarget(e.target);
        if (!still && !tile) return;
        const id = still
            ? videoIdFromHref(still.getAttribute('href') || still.href || '')
            : getVideoIdFromNode(tile);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        if (!hiddenSet.has(id)) state.hiddenVideoIds.push(id);
        const chan = tile ? getChannelInfoFromNode(tile) : curChannelInfo;
        rememberHiddenVideo(id, tile || still, chan);
        if (WatchedDB) {   // count against the channel (separate from watched)
            if (chan) WatchedDB.recordChannelHidden(chan, id);
        }
        if (still) still.style.display = 'none';
        else removeTile(tile);
        persist();
        toast('Hid video', id, () => {
            if (still) still.style.display = '';
            undoHideVideo(id);
        });
    }, true);

    // Record which tile a menu is opened from. The 3-dot button lives inside
    // the tile, so closest(INNER_CONTAINERS) on the pressed element gives the
    // owning tile — independent of the (changing) menu-button markup. If the
    // press is in the main watch video's metadata instead, flag that so we
    // attribute to the page owner rather than a stale tile.
    document.addEventListener('pointerdown', (e) => {
        if (retired) return;
        lastPointerDown = Date.now();
        // A press that lands on YouTube's own volume control marks the volume
        // changes that follow as user-driven, so updateBoostUI can tell a
        // deliberate slider drag from YouTube re-applying its stored volume.
        // Our boost slider sits as a sibling *after* .ytp-volume-area, so it
        // never matches here.
        if (e.target.closest &&
            e.target.closest('.ytp-volume-area, .ytp-volume-panel, .ytp-mute-button')) {
            nativeVolPointerDown = true;
            lastNativeVolGesture = Date.now();
        }
        // First user gesture: if a boost or the compressor was persisted, wire
        // the graph now (so the AudioContext can run rather than muting the
        // element).
        if (((settings.volumeBoost || 1) > 1 || settings.ytCompressorOn) && !boostGain) {
            ensureBoostGraph();
            applyVolumeBoost();
        }
        if (!e.target.closest) return;
        const tile = e.target.closest(INNER_CONTAINERS);
        if (tile) {
            menuOwnerTile = tile;
            menuOwnerIsMain = false;
        } else if (e.target.closest('ytd-watch-metadata, #above-the-fold, ' +
                                    'ytm-slim-video-metadata-section-renderer, ytm-slim-owner-renderer')) {
            menuOwnerTile = null;
            menuOwnerIsMain = true;
        }
        // Anything else (e.g. our own popup item) leaves the attribution intact.
    }, true);

    // Close out a native volume-slider drag; stamp the release so a trailing
    // volumechange is still credited to the user.
    document.addEventListener('pointerup', () => {
        if (retired || !nativeVolPointerDown) return;
        nativeVolPointerDown = false;
        lastNativeVolGesture = Date.now();
    }, true);
    document.addEventListener('pointercancel', () => { nativeVolPointerDown = false; }, true);
    // YouTube's own volume hotkeys (Arrow Up/Down, m) count as deliberate too.
    document.addEventListener('keydown', (e) => {
        if (retired) return;
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'm' || e.key === 'M') &&
            !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') &&
            !(e.target && e.target.isContentEditable)) {
            lastNativeVolGesture = Date.now();
        }
    }, true);

    api.runtime.onMessage.addListener((msg) => {
        if (retired || !msg || !msg.action) return;
        switch (msg.action) {
            case 'ytb-block-channel': blockChannelAtTarget(lastContextTarget); break;
            case 'ytb-hide-video':    hideVideoAtTarget(lastContextTarget); break;
            case 'ytb-mark-watched':  markWatchedAtTarget(lastContextTarget); break;
        }
    });

    api.storage.onChanged.addListener((changes, area) => {
        if (retired || area !== 'local' || !changes[STORAGE_KEY]) return;
        const incoming = JSON.stringify(normalize(changes[STORAGE_KEY].newValue));
        if (incoming === lastSerialized) return;     // our own write echoing back
        lastSerialized = incoming;
        state = normalize(changes[STORAGE_KEY].newValue);
        rebuildDerived();
        runAll();
    });

    // watched-db.js emits after cross-tab additions/removals and generation
    // resets. Its revision joins the cache key so existing cards reconcile.
    document.addEventListener('ytb-watched-db-change', () => {
        if (!retired && settings.enabled) runAll();
    });

    /* ==================================================================
     * 8. Console helpers (parity with the old userscript, on YouTube pages)
     * ================================================================== */
    window.ytsbListHidden = () => [...hiddenSet];
    window.ytsbListChannels = () => state.blockedChannels.slice();
    window.ytsbUnhide = (id) => {
        const i = state.hiddenVideoIds.indexOf(id);
        if (i < 0) return false;
        state.hiddenVideoIds.splice(i, 1);
        delete state.hiddenVideoMetadata[id];
        persist();
        return true;
    };
    window.ytsbResetHidden = () => {
        const n = state.hiddenVideoIds.length;
        state.hiddenVideoIds = [];
        state.hiddenVideoMetadata = {};
        persist();
        return n;
    };

    /* ==================================================================
     * 9. Boot
     * ================================================================== */
    function isExtensionMutationNode(node) {
        const el = node && node.nodeType === 1 ? node : node && node.parentElement;
        return !!(el && el.closest &&
            el.closest('[id^="ytb-"], .ytb-menu-item, .ytb-sb-badge'));
    }

    function addLegacyMutationCandidates(node, candidates, includeDescendants) {
        const el = node && node.nodeType === 1 ? node : node && node.parentElement;
        if (!el) return;
        if (el.matches && el.matches(LEGACY_MUTATION_CONTAINERS)) candidates.add(el);
        const closest = el.closest && el.closest(LEGACY_MUTATION_CONTAINERS);
        if (closest) candidates.add(closest);
        if (includeDescendants && el.querySelectorAll) {
            el.querySelectorAll(LEGACY_MUTATION_CONTAINERS)
                .forEach(candidate => candidates.add(candidate));
        }
    }

    // Shelves and promo renderers are outside the normal video-card selector.
    // Hide matching insertions in this observer turn so they cannot paint during
    // the 250 ms legacy maintenance debounce.
    function processLegacyMutationFilters(records) {
        if (!settings.enabled) return;
        const candidates = new Set();
        for (const record of records) {
            if (record.type !== 'childList') continue;
            addLegacyMutationCandidates(record.target, candidates, false);
            record.addedNodes.forEach(node =>
                addLegacyMutationCandidates(node, candidates, true));
        }
        for (const candidate of candidates) {
            if (candidate.matches(NON_VIDEO_CARDS)) {
                if (settings.hidePromos) {
                    hideEl(candidate.closest(OUTER_GRID_CELLS) || candidate);
                }
                continue;
            }
            if (candidate.matches('ytd-rich-section-renderer')) {
                if (settings.blockShorts || settings.hideNewsShelves) hideEl(candidate);
                continue;
            }
            if (settings.blockShorts && candidate.matches(
                'ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer, ' +
                'ytm-reel-shelf-renderer'
            )) hideEl(candidate);
        }
    }
    function mutationTouchesLegacyContainer(node) {
        const el = node && node.nodeType === 1 ? node : node && node.parentElement;
        if (!el) return false;
        if (el.matches && el.matches(LEGACY_MUTATION_CONTAINERS)) return true;
        if (el.closest && el.closest(LEGACY_MUTATION_CONTAINERS)) return true;
        return !!(el.querySelector && el.querySelector(LEGACY_MUTATION_CONTAINERS));
    }

    function isLocallyHandledMutationNode(node) {
        if (isExtensionMutationNode(node)) return true;
        const el = node && node.nodeType === 1 ? node : node && node.parentElement;
        if (el && el.closest &&
            (el.closest(INNER_CONTAINERS) || el.closest(COMMENT_RENDERERS))) return true;
        if (el && el.matches &&
            (el.matches(INNER_CONTAINERS) || el.matches(COMMENT_RENDERERS))) return true;
        return !!(node && node.querySelector &&
            (node.querySelector(INNER_CONTAINERS) || node.querySelector(COMMENT_RENDERERS)));
    }

    function mutationNeedsMaintenance(records) {
        for (const record of records) {
            if (record.type === 'attributes') {
                // Tile href/title/style changes are fully handled by the pre-paint
                // classifier. An href elsewhere can affect end screens or menus.
                if (record.attributeName === 'href' &&
                    !isLocallyHandledMutationNode(record.target)) return true;
                continue;
            }
            if (record.type === 'characterData') {
                if (!isLocallyHandledMutationNode(record.target)) return true;
                continue;
            }
            let hasNodes = false;
            for (const node of record.addedNodes) {
                hasNodes = true;
                if (mutationTouchesLegacyContainer(node) ||
                    !isLocallyHandledMutationNode(node)) return true;
            }
            for (const node of record.removedNodes) {
                hasNodes = true;
                if (!isLocallyHandledMutationNode(node) &&
                    !isLocallyHandledMutationNode(record.target)) return true;
            }
            if (!hasNodes && !isLocallyHandledMutationNode(record.target)) return true;
        }
        return false;
    }

    function retireInstance() {
        retired = true;
        window.removeEventListener('message', onPageQualityMessage);
        if (pageObserver) {
            pageObserver.disconnect();
            pageObserver = null;
        }
        if (detailObserver) {
            detailObserver.disconnect();
            detailObserver = null;
        }
        detailObserved = new WeakSet();
        if (maintenanceTimer) {
            clearTimeout(maintenanceTimer);
            maintenanceTimer = null;
        }
        if (tileEnhancementTimer) {
            clearTimeout(tileEnhancementTimer);
            tileEnhancementTimer = null;
        }
        if (deArrowWatchNavigationTimer) {
            clearTimeout(deArrowWatchNavigationTimer);
            deArrowWatchNavigationTimer = null;
        }
        resetDeArrowWatchPlayerRetry();
        pendingTileEnhancements.clear();
        document.removeEventListener('ytb-apply-playback-profile', onPlaybackProfile);
        document.querySelectorAll('.ytb-menu-item').forEach(el => {
            if (el.dataset.ytbInstance === INSTANCE_ID) el.remove();
        });
        while (lifecycleIntervals.length) clearInterval(lifecycleIntervals.pop());
        if (boostSaveTimer) { clearTimeout(boostSaveTimer); boostSaveTimer = null; }
        if (speedSaveTimer) { clearTimeout(speedSaveTimer); speedSaveTimer = null; }
        if (sbNoticeTimer) { clearTimeout(sbNoticeTimer); sbNoticeTimer = null; }
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        ['ytb-sb-notice', 'ytb-sb-panel', 'ytb-toast'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });
        exitCinema();
        endFilterBoot();
    }

    function bootObserver() {
        if (retired) {
            endFilterBoot();
            return;
        }
        if (!document.body) {
            requestAnimationFrame(bootObserver);
            return;
        }

        let pendingWhileHidden = false;
        const mustRunHidden = () =>
            settings.enabled &&
            settings.blackoutBlockedChannels &&
            state.blockedChannels.length &&
            location.pathname === '/watch';

        const scheduleMaintenance = (records) => {
            if (retired) return;

            // Fast path: classify only changed cards during the observer
            // microtask, before Firefox can paint them.
            if (!document.hidden) {
                processLegacyMutationFilters(records);
                const dirtyTiles = filterMutatedTiles(records);
                refreshMutatedComments(records);
                queueTileEnhancements(dirtyTiles);
            }

            if (document.hidden) {
                pendingWhileHidden = true;
                if (!mustRunHidden()) return;
            }
            if (!mutationNeedsMaintenance(records)) return;

            // A real trailing debounce lets a Polymer stamping burst settle.
            // The periodic safety pass below prevents starvation on a page that
            // mutates continuously.
            if (maintenanceTimer) clearTimeout(maintenanceTimer);
            maintenanceTimer = setTimeout(() => {
                maintenanceTimer = null;
                runAll();
            }, 250);
        };

        // High-frequency style/text changes are observed only inside known cards
        // and comments. The page-wide observer keeps href recycling plus inserts.
        detailObserver = new MutationObserver(scheduleMaintenance);
        pageObserver = new MutationObserver(scheduleMaintenance);
        pageObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href']
        });

        try {
            runAll();
        } finally {
            endFilterBoot();
        }

        // Normal mutations and navigation events do the immediate work. This is
        // only a low-frequency recovery pass for markup changes YouTube makes
        // without inserting nodes.
        lifecycleIntervals.push(setInterval(() => {
            if (!document.hidden || mustRunHidden()) runAll();
        }, 10000));


        document.addEventListener('visibilitychange', () => {
            if (retired || document.hidden) return;
            if (pendingWhileHidden) {
                pendingWhileHidden = false;
                runAll();
            }
        });

        // Shorts redirect lifecycle
        redirectShortsUrl();
        document.addEventListener('yt-navigate-start', redirectShortsUrl, true);
        document.addEventListener('yt-navigate-finish', redirectShortsUrl, true);

        // Blackout lifecycle: drop it optimistically when navigation starts so a
        // good video isn't held paused, then re-evaluate when the page settles.
        document.addEventListener('yt-navigate-start', () => {
            beginDeArrowWatchNavigation();
            clearBlackout();
        }, true);
        document.addEventListener('yt-navigate-finish', () => {
            finishDeArrowWatchNavigation();
            runAll();
        }, true);
        document.addEventListener('yt-page-data-updated',
            refreshDeArrowWatchTitle, true);
        let lastHref = location.href;
        lifecycleIntervals.push(setInterval(() => {
            if (retired || location.href === lastHref) return;
            lastHref = location.href;
            finishDeArrowWatchNavigation();
            redirectShortsUrl();
            if (!retired) runAll();
        }, 500));
    }
    async function init() {
        // Tell any previous (orphaned) instance to stand down, THEN start
        // listening so a future update can retire us the same way. The
        // dispatch is synchronous, so ordering avoids retiring ourselves.
        try {
            document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
            document.addEventListener(TAKEOVER_EVENT, retireInstance, true);
        } catch (e) { /* ignore */ }

        // Start both storage reads together. Settings can release the boot gate
        // immediately when filtering is disabled, while enabled installs wait
        // for the in-memory watched set before the first visible classification.
        const watchedReady = WatchedDB
            ? WatchedDB.whenReady().catch(() => {})
            : Promise.resolve();
        try {
            const stored = await api.storage.local.get(STORAGE_KEY);
            state = normalize(stored[STORAGE_KEY]);
        } catch (e) {
            state = normalize(null);
        }
        if (retired) return;
        lastSerialized = JSON.stringify(state);
        rebuildDerived();
        await watchedReady;
        if (retired) return;
        if (migrateLegacyLocalStorage()) persist();   // one-time import of old list
        bootObserver();
    }

    init();
})();
