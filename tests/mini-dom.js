/* eslint-env node */
'use strict';

// A small DOM for tests whose behaviour depends on real selector semantics
// (document order, attribute operators, :not) rather than per-test string
// matching. Supports compound selectors joined by descendant and child
// combinators; anything else throws so a test can't pass by accident.

const NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4 };
const IDENT = /^-?[_a-zA-Z -￿][-_a-zA-Z0-9 -￿]*/;
const parsed = new Map();

function findClose(s, start, open, close) {
    let depth = 0;
    let quote = '';
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === open) depth++;
        else if (ch === close && --depth === 0) return i;
    }
    throw new Error('mini-dom: unbalanced ' + open + ' in ' + s);
}

function splitList(s) {
    const parts = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(s.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(s.slice(start));
    return parts.map(part => part.trim());
}

function parseAttr(body) {
    const m = body.match(
        /^\s*([-\w]+)\s*(?:([*^$~|]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]]+)))?\s*([iIsS])?\s*$/
    );
    if (!m) throw new Error('mini-dom: cannot parse [' + body + ']');
    const value = (m[3] ?? m[4] ?? m[5] ?? '').replace(/\\(.)/g, '$1');
    return { name: m[1].toLowerCase(), op: m[2] || '', value, ci: /i/i.test(m[6] || '') };
}

function parseCompound(s, start) {
    const c = { tag: null, ids: [], classes: [], attrs: [], nots: [], scope: false };
    let i = start;
    if (s[i] === '*') i++;
    else {
        const m = s.slice(i).match(IDENT);
        if (m) {
            c.tag = m[0].toLowerCase();
            i += m[0].length;
        }
    }
    while (i < s.length) {
        const ch = s[i];
        if (ch === '#' || ch === '.') {
            const m = s.slice(i + 1).match(IDENT);
            if (!m) throw new Error('mini-dom: bad ' + ch + ' in ' + s);
            (ch === '#' ? c.ids : c.classes).push(m[0]);
            i += 1 + m[0].length;
        } else if (ch === '[') {
            const end = findClose(s, i, '[', ']');
            c.attrs.push(parseAttr(s.slice(i + 1, end)));
            i = end + 1;
        } else if (ch === ':') {
            const m = s.slice(i + 1).match(/^[-a-z]+/i);
            const name = m ? m[0].toLowerCase() : '';
            i += 1 + name.length;
            if (name === 'scope') c.scope = true;
            else if (name === 'not' && s[i] === '(') {
                const end = findClose(s, i, '(', ')');
                c.nots.push(parseList(s.slice(i + 1, end)));
                i = end + 1;
            } else {
                throw new Error('mini-dom: unsupported :' + name + ' in ' + s);
            }
        } else {
            break;
        }
    }
    return { compound: c, end: i };
}

// [{ compound, combinator }], combinator joining a step to the one before it.
function parseComplex(s) {
    const steps = [];
    let combinator = null;
    let i = 0;
    while (i < s.length) {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (i >= s.length) break;
        if (s[i] === '>') {
            combinator = '>';
            i++;
            continue;
        }
        if (s[i] === '+' || s[i] === '~') throw new Error('mini-dom: unsupported combinator in ' + s);
        const { compound, end } = parseCompound(s, i);
        if (end === i) throw new Error('mini-dom: cannot parse ' + JSON.stringify(s) + ' at ' + i);
        steps.push({ compound, combinator: steps.length ? combinator || ' ' : null });
        combinator = null;
        i = end;
    }
    if (!steps.length) throw new Error('mini-dom: empty selector');
    return steps;
}

function parseList(selector) {
    if (!parsed.has(selector)) parsed.set(selector, splitList(selector).map(parseComplex));
    return parsed.get(selector);
}

function matchesAttr(el, a) {
    const raw = el.getAttribute(a.name);
    if (raw == null) return false;
    if (!a.op) return true;
    const v = a.ci ? raw.toLowerCase() : raw;
    const want = a.ci ? a.value.toLowerCase() : a.value;
    switch (a.op) {
    case '=': return v === want;
    case '*=': return want !== '' && v.includes(want);
    case '^=': return want !== '' && v.startsWith(want);
    case '$=': return want !== '' && v.endsWith(want);
    case '~=': return v.split(/\s+/).includes(want);
    case '|=': return v === want || v.startsWith(want + '-');
    default: return false;
    }
}

function matchesCompound(el, c, scope) {
    if (c.tag && el.localName !== c.tag) return false;
    if (c.scope && el !== scope) return false;
    for (const id of c.ids) if (el.getAttribute('id') !== id) return false;
    if (c.classes.length) {
        const own = (el.getAttribute('class') || '').split(/\s+/);
        for (const name of c.classes) if (!own.includes(name)) return false;
    }
    for (const a of c.attrs) if (!matchesAttr(el, a)) return false;
    for (const list of c.nots) if (matchesList(el, list, scope)) return false;
    return true;
}

function matchesComplex(el, steps, scope) {
    function from(node, index) {
        if (!matchesCompound(node, steps[index].compound, scope)) return false;
        if (index === 0) return true;
        if (steps[index].combinator === '>') {
            return !!node.parentElement && from(node.parentElement, index - 1);
        }
        for (let p = node.parentElement; p; p = p.parentElement) {
            if (from(p, index - 1)) return true;
        }
        return false;
    }
    return from(el, steps.length - 1);
}

function matchesList(el, list, scope) {
    return list.some(steps => matchesComplex(el, steps, scope));
}

function eachElement(root, fn) {
    for (const child of root.childNodes) {
        if (child.nodeType !== 1) continue;
        if (fn(child) === false) return false;
        if (eachElement(child, fn) === false) return false;
    }
    return true;
}

function detach(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
}

function insertAt(parent, node, index) {
    if (node.nodeType === 11) {
        const kids = node.childNodes.splice(0);
        kids.forEach(kid => { kid.parentNode = parent; });
        parent.childNodes.splice(index, 0, ...kids);
        return node;
    }
    node.parentNode = parent;
    parent.childNodes.splice(index, 0, node);
    return node;
}

class MiniNode {
    constructor(nodeType) {
        this.nodeType = nodeType;
        this.parentNode = null;
        this.childNodes = [];
    }
    get parentElement() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    get firstChild() { return this.childNodes[0] || null; }
    appendChild(node) {
        detach(node);
        return insertAt(this, node, this.childNodes.length);
    }
    insertBefore(node, ref) {
        detach(node);
        const index = ref ? this.childNodes.indexOf(ref) : -1;
        return insertAt(this, node, index < 0 ? this.childNodes.length : index);
    }
    removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index >= 0) {
            this.childNodes.splice(index, 1);
            node.parentNode = null;
        }
        return node;
    }
    replaceChild(node, old) {
        const index = this.childNodes.indexOf(old);
        if (index < 0) throw new Error('mini-dom: replaceChild of a non-child');
        detach(node);
        this.childNodes.splice(index, 1);
        old.parentNode = null;
        insertAt(this, node, index);
        return old;
    }
    remove() { detach(this); }
}

class MiniText extends MiniNode {
    constructor(data) {
        super(3);
        this.data = String(data);
    }
    get textContent() { return this.data; }
    set textContent(value) { this.data = String(value); }
    get nodeValue() { return this.data; }
}

class MiniFragment extends MiniNode {
    constructor() { super(11); }
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
}

function datasetOf(el) {
    const attr = prop => 'data-' + String(prop).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    return new Proxy({}, {
        get: (_, prop) => (typeof prop === 'string' ? el.getAttribute(attr(prop)) ?? undefined : undefined),
        set: (_, prop, value) => { el.setAttribute(attr(prop), value); return true; },
        deleteProperty: (_, prop) => { el.removeAttribute(attr(prop)); return true; },
        has: (_, prop) => el.hasAttribute(attr(prop))
    });
}

// Plain properties work as before; the CSSStyleDeclaration methods are kept
// apart from them.
function styleOf() {
    const declared = new Map();
    return {
        setProperty(name, value, priority) { declared.set(name, { value: String(value), priority: priority || '' }); },
        getPropertyValue(name) { return declared.has(name) ? declared.get(name).value : ''; },
        getPropertyPriority(name) { return declared.has(name) ? declared.get(name).priority : ''; },
        removeProperty(name) {
            const old = declared.has(name) ? declared.get(name).value : '';
            declared.delete(name);
            return old;
        }
    };
}

function classListOf(el) {
    const read = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const write = names => el.setAttribute('class', names.join(' '));
    return {
        add(...names) { write([...new Set([...read(), ...names])]); },
        remove(...names) { write(read().filter(name => !names.includes(name))); },
        contains(name) { return read().includes(name); },
        toggle(name, force) {
            const on = force === undefined ? !read().includes(name) : !!force;
            if (on) this.add(name);
            else this.remove(name);
            return on;
        }
    };
}

class MiniElement extends MiniNode {
    constructor(tag) {
        super(1);
        this.localName = String(tag).toLowerCase();
        this.tagName = this.localName.toUpperCase();
        this.attributes = new Map();
        this.dataset = datasetOf(this);
        this.classList = classListOf(this);
        this.style = styleOf();
        this.clicks = 0;
        this.rendered = true;
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) {
        if (value) this.setAttribute('disabled', '');
        else this.removeAttribute('disabled');
    }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) {
        this.childNodes.forEach(node => { node.parentNode = null; });
        this.childNodes = [];
        if (value != null && value !== '') this.appendChild(new MiniText(value));
    }
    get alt() { return this.getAttribute('alt') || ''; }
    set alt(value) { this.setAttribute('alt', value); }
    get src() { return this.getAttribute('src') || ''; }
    set src(value) { this.setAttribute('src', value); }
    get title() { return this.getAttribute('title') || ''; }
    set title(value) { this.setAttribute('title', value); }
    getAttribute(name) {
        const key = String(name).toLowerCase();
        return this.attributes.has(key) ? this.attributes.get(key) : null;
    }
    setAttribute(name, value) { this.attributes.set(String(name).toLowerCase(), String(value)); }
    hasAttribute(name) { return this.attributes.has(String(name).toLowerCase()); }
    removeAttribute(name) { this.attributes.delete(String(name).toLowerCase()); }
    contains(node) {
        for (let n = node; n; n = n.parentNode) if (n === this) return true;
        return false;
    }
    matches(selector) { return matchesList(this, parseList(selector), null); }
    closest(selector) {
        const list = parseList(selector);
        for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
            if (matchesList(n, list, null)) return n;
        }
        return null;
    }
    querySelectorAll(selector) {
        const list = parseList(selector);
        const out = [];
        eachElement(this, el => { if (matchesList(el, list, this)) out.push(el); });
        return out;
    }
    querySelector(selector) {
        const list = parseList(selector);
        let hit = null;
        eachElement(this, el => {
            if (!matchesList(el, list, this)) return true;
            hit = el;
            return false;
        });
        return hit;
    }
    click() { this.clicks++; }
    getClientRects() { return this.rendered ? [{ width: 1, height: 1 }] : []; }
    getBoundingClientRect() {
        return this.rendered ? { width: 100, height: 20 } : { width: 0, height: 0 };
    }
    addEventListener() {}
    removeEventListener() {}
}

// h('a', { href: '/x', class: 'y' }, 'text', h('span', {}, 'more'))
function h(tag, attrs, ...children) {
    const el = new MiniElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
        if (value != null && value !== false) el.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        el.appendChild(typeof child === 'object' ? child : new MiniText(child));
    }
    return el;
}

function createDocument(...bodyChildren) {
    const listeners = new Map();
    const documentElement = h('html', {}, h('head'), h('body', {}, ...bodyChildren));
    const document = {
        nodeType: 9,
        hidden: true,
        documentElement,
        head: documentElement.children[0],
        body: documentElement.children[1],
        createElement: tag => new MiniElement(tag),
        createTextNode: text => new MiniText(text),
        createDocumentFragment: () => new MiniFragment(),
        createTreeWalker(root, whatToShow) {
            const nodes = [];
            (function walk(node) {
                for (const child of node.childNodes) {
                    if ((child.nodeType === 3 && whatToShow & NodeFilter.SHOW_TEXT) ||
                        (child.nodeType === 1 && whatToShow & NodeFilter.SHOW_ELEMENT)) nodes.push(child);
                    walk(child);
                }
            })(root);
            let index = -1;
            return {
                root,
                get currentNode() { return index >= 0 ? nodes[Math.min(index, nodes.length - 1)] : root; },
                nextNode() {
                    if (index < nodes.length) index++;
                    return nodes[index] || null;
                }
            };
        },
        querySelector: selector => documentElement.matches(selector)
            ? documentElement : documentElement.querySelector(selector),
        querySelectorAll: selector => [
            ...(documentElement.matches(selector) ? [documentElement] : []),
            ...documentElement.querySelectorAll(selector)
        ],
        getElementById(id) {
            let hit = null;
            eachElement(documentElement, el => {
                if (el.getAttribute('id') !== id) return true;
                hit = el;
                return false;
            });
            return hit;
        },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            if (listeners.has(type)) listeners.set(type, listeners.get(type).filter(item => item !== fn));
        },
        dispatchEvent(event) {
            for (const fn of (listeners.get(event.type) || []).slice()) fn(event);
            return true;
        }
    };
    return document;
}

module.exports = { NodeFilter, MiniElement, MiniText, MiniFragment, h, createDocument };
