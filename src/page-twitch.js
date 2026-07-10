/* ==================================================================
 * Chromium-only MAIN-world helper for Twitch page-internals features.
 *
 * Chromium content scripts cannot see page-world objects — React
 * fibers, the Apollo cache, or the page's WebSocket — so twitch.js
 * relays this work here over postMessage (on Firefox it reaches them
 * directly via wrappedJSObject; this file is not in the Firefox
 * manifest).
 *
 * Installed synchronously at document_start:
 *   Anonymous chat — when twitch.js has mirrored the toggle into
 *   localStorage ("ytbtw-anon" = "1"), WebSocket.prototype.send is
 *   patched before Twitch's own scripts run so the chat connection
 *   authenticates as an anonymous justinfan user.
 *
 * Message handlers (all answered on the same window):
 *   ytbtw-chat-insert    { token, text }       insert text through the
 *                                              Slate editor on the chat
 *                                              input's React fiber.
 *   ytbtw-chat-complete  { token, del, text }  delete `del` characters
 *                                              back, then insert `text`
 *                                              (emote tab-completion).
 *                        Both answer { type: "ytbtw-chat-done", token, ok }.
 *   ytbtw-channel-id-req                       numeric channel id off the
 *                                              chat input's fiber; answers
 *                                              { type: "ytbtw-channel-id", id }.
 *   ytbtw-stream-start-req { login }           stream start time from the
 *                                              Apollo cache; answers
 *                                              { type: "ytbtw-stream-start",
 *                                                login, start }.
 *
 * Runs in the page world: no extension APIs, no storage access.
 * ================================================================== */
(function () {
    'use strict';

    /* ---- anonymous chat (must run before Twitch's own scripts) ---- */
    try {
        if (localStorage.getItem('ytbtw-anon') === '1') {
            const proto = WebSocket.prototype;
            const origSend = proto.send;
            const anonNick = 'justinfan' + (10000 + Math.floor(Math.random() * 80000));
            proto.send = function (data) {
                try {
                    if (typeof data === 'string' && /irc-ws\.chat\.twitch\.tv/.test(this.url || '')) {
                        if (/^PASS /m.test(data)) data = data.replace(/^PASS .+$/m, 'PASS SCHMOOPIIE');
                        if (/^NICK /m.test(data)) data = data.replace(/^NICK .+$/m, 'NICK ' + anonNick);
                    }
                } catch (e) { /* fall through with original data */ }
                return origSend.call(this, data);
            };
        }
    } catch (e) { /* localStorage unavailable; feature silently off */ }

    /* ---- Slate editor via the chat input's React fiber ---- */
    function chatEditor() {
        try {
            const input = document.querySelector('div[data-a-target="chat-input"]');
            if (!input) return null;
            const fiberKey = Object.keys(input).find(k => k.startsWith('__reactFiber$'));
            if (!fiberKey) return null;
            let node = input[fiberKey];
            for (let i = 0; i < 30 && node; i++) {
                const props = node.memoizedProps;
                if (props && props.editor && typeof props.editor.insertText === 'function') {
                    return props.editor;
                }
                node = node.return;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function getChannelId() {
        try {
            const input = document.querySelector('div[data-a-target="chat-input"]');
            if (!input) return null;
            const fk = Object.keys(input).find(k => k.startsWith('__reactFiber$'));
            if (!fk) return null;
            let node = input[fk];
            for (let i = 0; i < 60 && node; i++) {
                const p = node.memoizedProps;
                if (p && (p.channelID || p.channelId)) return String(p.channelID || p.channelId);
                node = node.return;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function streamStartFromApollo(login) {
        try {
            const rootEl = document.querySelector('#root');
            if (!rootEl) return 0;
            const fk = Object.keys(rootEl).find(k =>
                k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
            if (!fk) return 0;
            // Breadth-first over the fiber tree for the ApolloProvider client.
            let client = null;
            const queue = [rootEl[fk]];
            for (let i = 0; i < 2000 && queue.length && !client; i++) {
                const node = queue.shift();
                if (!node) continue;
                const p = node.memoizedProps;
                if (p && p.client && p.client.cache && typeof p.client.cache.extract === 'function') {
                    client = p.client;
                    break;
                }
                if (node.child) queue.push(node.child);
                if (node.sibling) queue.push(node.sibling);
            }
            if (!client) return 0;
            const entries = client.cache.extract();
            for (const key of Object.keys(entries)) {
                const val = entries[key];
                if (!val || val.__typename !== 'User' || (val.login || '').toLowerCase() !== login) continue;
                const ref = val.stream && val.stream.__ref;
                const stream = ref && entries[ref];
                const t = stream && stream.createdAt && Date.parse(stream.createdAt);
                if (t) return t;
            }
        } catch (e) { /* page internals moved; chip just stays hidden */ }
        return 0;
    }

    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data || typeof e.data.type !== 'string') return;
        const d = e.data;

        if (d.type === 'ytbtw-chat-insert' || d.type === 'ytbtw-chat-complete') {
            let ok = false;
            try {
                const editor = chatEditor();
                if (editor) {
                    if (d.type === 'ytbtw-chat-complete') {
                        if (typeof editor.deleteBackward !== 'function') throw new Error('no deleteBackward');
                        const del = Math.max(0, Math.min(200, Number(d.del) || 0));
                        for (let i = 0; i < del; i++) editor.deleteBackward('character');
                    }
                    editor.insertText(String(d.text || ''));
                    ok = true;
                }
            } catch (err) { ok = false; }
            window.postMessage({ type: 'ytbtw-chat-done', token: d.token, ok }, location.origin);
            return;
        }

        if (d.type === 'ytbtw-channel-id-req') {
            const id = getChannelId();
            if (id) window.postMessage({ type: 'ytbtw-channel-id', id }, location.origin);
            return;
        }

        if (d.type === 'ytbtw-stream-start-req' && typeof d.login === 'string') {
            const login = d.login.toLowerCase();
            const start = streamStartFromApollo(login);
            if (start) window.postMessage({ type: 'ytbtw-stream-start', login, start }, location.origin);
        }
    });
})();
