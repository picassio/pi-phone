// The world browser_eval's scripts run in (PP-244; `BrowserPage.evaluateIsolated`): an isolated world of each frame,
// which shares the page's DOM but none of its scripts' objects. Before a script runs there, this makes the world one
// that reads the page and nothing else, in that world only (the page's own world keeps everything):
// - nothing that holds tokens: document.cookie, cookieStore, storage (local, session, IndexedDB, caches, shared);
// - nothing that sends or reaches out: fetch, XMLHttpRequest, WebSocket, EventSource, WebTransport, WebRTC, sendBeacon,
//   workers, windows (open, opener, postMessage), service workers, credentials, the clipboard, devices;
// - nothing that changes the page or runs later: every setter of the DOM's interfaces, and every method but the
//   reading ones (`READS`), so no HTML, attribute, node or style goes in (an `onerror` would run in the page's own world),
//   and no listener, observer, timer or promise of the page's is left to run after the script;
// - of the window, only what reading needs (`KEEP`), and of the navigator only what it says about the browser;
// - the value of a password field, and of any field holding a value the person typed on a card (`hide`), reads as "".
// Called with the person's card values (a list, added to those kept), again before each script: it answers what it
// could not make unavailable (`failed`), and the script is then not run. Every frame of the page gets it in its own
// world of that name (a same-origin `window[0]`'s globals are another realm). Plain JavaScript: Chrome runs it.
function harden(hidden) {
    "use strict";
    const KEY = "__piEvalWorld";
    const kept = Object.getOwnPropertyDescriptor(window, KEY);

    if (kept !== undefined) {
        kept.value.hide(hidden);

        return kept.value.failed;
    }

    const failed = [];
    const values = new Set();
    // The functions put in place here: a property already holding one is done.
    const mine = new WeakSet();
    const hide = (list) => {
        for (const value of Array.isArray(list) ? list : []) {
            if (typeof value === "string" && value !== "") {
                values.add(value);
            }
        }
    };
    const refuse = (what) => {
        const stop = function () {
            throw new Error(`${what} is not available in browser_eval: it reads the page, and does nothing else.`);
        };

        mine.add(stop);

        return stop;
    };
    const define = (target, name, descriptor, label) => {
        for (const part of [descriptor.get, descriptor.set, descriptor.value]) {
            if (typeof part === "function") {
                mine.add(part);
            }
        }

        try {
            Object.defineProperty(target, name, { ...descriptor, configurable: false });
        } catch {
            failed.push(label);
        }
    };
    const deny = (target, name, label) => {
        const stop = refuse(label);

        define(target, name, { get: stop, set: stop, enumerable: false }, label);
    };

    // ECMAScript's own globals: no page, no network, no time (but FinalizationRegistry, Atomics and WebAssembly, which
    // call back later).
    const LANGUAGE = new Set([
        "Object", "Function", "Array", "Number", "parseFloat", "parseInt", "Infinity", "NaN", "undefined", "Boolean", "String", "Symbol",
        "Date", "Promise", "RegExp", "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError",
        "URIError", "globalThis", "JSON", "Math", "Intl", "ArrayBuffer", "Uint8Array", "Int8Array", "Uint16Array", "Int16Array",
        "Uint32Array", "Int32Array", "Float16Array", "Float32Array", "Float64Array", "Uint8ClampedArray", "BigUint64Array",
        "BigInt64Array", "DataView", "Map", "BigInt", "Set", "WeakMap", "WeakSet", "WeakRef", "Proxy", "Reflect", "Iterator",
        "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape", "eval", "isFinite", "isNaN",
        "SuppressedError", "DisposableStack", "AsyncDisposableStack",
    ]);
    // The window's own that reading needs; everything else on it is refused.
    const KEEP = new Set([
        "window", "self", "document", "location", "top", "parent", "navigator", "screen", "visualViewport", "devicePixelRatio",
        "innerWidth", "innerHeight", "outerWidth", "outerHeight", "scrollX", "scrollY", "pageXOffset", "pageYOffset", "screenX",
        "screenY", "screenLeft", "screenTop", "getComputedStyle", "matchMedia", "getSelection", "CSS", "performance", "origin",
        "isSecureContext", "crossOriginIsolated", "console", "atob", "btoa", "structuredClone", "closed", "length", "event",
    ]);
    // Interfaces kept as globals besides the DOM's nodes (for instanceof, NodeFilter's constants, parsing an address).
    const INTERFACES = new Set([
        "NodeList", "HTMLCollection", "NamedNodeMap", "DOMTokenList", "DOMStringMap", "DOMRect", "DOMRectReadOnly", "DOMRectList",
        "CSSStyleDeclaration", "CSSRule", "CSSStyleRule", "CSSMediaRule", "CSSFontFaceRule", "CSSImportRule", "CSSKeyframesRule",
        "CSSKeyframeRule", "CSSSupportsRule", "CSSLayerBlockRule", "CSSContainerRule", "CSSPageRule", "CSSNamespaceRule",
        "CSSGroupingRule", "CSSConditionRule", "CSSPropertyRule", "CSSRuleList", "CSSStyleSheet", "StyleSheet", "StyleSheetList",
        "MediaList", "MediaQueryList", "Range", "StaticRange", "AbstractRange", "Selection", "TreeWalker", "NodeIterator",
        "NodeFilter", "XPathResult", "XPathExpression", "XPathEvaluator", "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
        "DOMException", "FontFaceSet", "ValidityState", "Screen", "VisualViewport", "Navigator", "Performance", "Location",
    ]);
    // Element constructors that make an element of this document, which then loads what it is given.
    const MAKERS = new Set(["Image", "Audio", "Option"]);
    // The methods of the DOM's interfaces a script may call: they read.
    const READS = new Set([
        "querySelector", "querySelectorAll", "getElementById", "getElementsByClassName", "getElementsByTagName", "getElementsByTagNameNS",
        "getElementsByName", "getAttribute", "getAttributeNS", "getAttributeNames", "getAttributeNode", "getAttributeNodeNS",
        "hasAttribute", "hasAttributeNS", "hasAttributes", "hasChildNodes", "hasFocus", "closest", "matches", "webkitMatchesSelector",
        "contains", "compareDocumentPosition", "isEqualNode", "isSameNode", "isDefaultNamespace", "lookupNamespaceURI", "lookupPrefix",
        "getRootNode", "getBoundingClientRect", "getClientRects", "checkVisibility", "computedStyleMap", "getHTML", "getPropertyValue",
        "getPropertyPriority", "item", "namedItem", "getNamedItem", "getNamedItemNS", "forEach", "entries", "keys", "values", "toString",
        "toJSON", "valueOf", "elementFromPoint", "elementsFromPoint", "evaluate", "createTreeWalker", "createNodeIterator",
        "createExpression", "createNSResolver", "nextNode", "previousNode", "parentNode", "firstChild", "lastChild", "previousSibling",
        "nextSibling", "iterateNext", "snapshotItem", "createRange", "getSelection", "getRangeAt", "containsNode", "setStart", "setEnd",
        "setStartBefore", "setStartAfter", "setEndBefore", "setEndAfter", "selectNode", "selectNodeContents", "cloneRange",
        "compareBoundaryPoints", "comparePoint", "isPointInRange", "intersectsNode", "supports", "escape", "check", "now", "getEntries",
        "getEntriesByType", "getEntriesByName", "encode", "decode", "encodeInto", "has", "get", "getAll", "composedPath",
        "getModifierState", "assignedNodes", "assignedElements",
    ]);
    // Getters that give a promise the page settles later: a script awaiting one would run on after it was answered.
    const LATER = new Set(["ready", "finished", "loaded", "closed", "committed", "released", "updated"]);
    // What the navigator may say: about the browser, nothing it reaches.
    const NAVIGATOR = new Set([
        "userAgent", "language", "languages", "platform", "vendor", "maxTouchPoints", "hardwareConcurrency", "deviceMemory", "onLine",
        "webdriver", "pdfViewerEnabled", "appName", "appVersion", "appCodeName", "product", "productSub", "vendorSub", "cookieEnabled",
    ]);

    // Named in the refusal even where the page lacks them (a page over http has no caches, cookieStore or service
    // workers): a script hears the same wherever it runs.
    const NAMED = [
        "localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "sharedStorage", "fetch", "fetchLater",
        "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport", "RTCPeerConnection", "Worker",
        "SharedWorker", "BroadcastChannel", "open", "opener", "postMessage",
    ];
    const NAMED_NAVIGATOR = ["sendBeacon", "serviceWorker", "credentials", "clipboard", "storage", "locks", "geolocation", "mediaDevices"];

    // Fields' values: captured before anything is locked.
    const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const inputType = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "type");
    const areaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    const typed = (text) => {
        if (typeof text !== "string" || text === "") {
            return false;
        }

        for (const value of values) {
            if (text.includes(value)) {
                return true;
            }
        }

        return false;
    };
    const secretInput = (input) => inputType.get.call(input) === "password" || typed(inputValue.get.call(input));
    const blank = (proto, name, original, empty, secret) =>
        define(
            proto,
            name,
            {
                get() {
                    return secret(this) ? empty : original.get.call(this);
                },
                set: refuse(`Setting ${name}`),
                enumerable: original.enumerable,
            },
            name,
        );
    /** A property that cannot be changed: one put in place here, a constant, or else what could not be made unavailable. */
    const fixed = (descriptor, label) => {
        if (descriptor.configurable) {
            return false;
        }

        const parts = [descriptor.get, descriptor.set, descriptor.value].filter((part) => part !== undefined);
        const constant = descriptor.get === undefined && descriptor.set === undefined && (descriptor.value === null || typeof descriptor.value !== "object") && typeof descriptor.value !== "function";

        if (!constant && !parts.every((part) => typeof part === "function" && mine.has(part))) {
            failed.push(label);
        }

        return true;
    };

    blank(HTMLInputElement.prototype, "value", inputValue, "", secretInput);
    blank(HTMLInputElement.prototype, "valueAsNumber", Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "valueAsNumber"), Number.NaN, secretInput);
    blank(HTMLInputElement.prototype, "valueAsDate", Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "valueAsDate"), null, secretInput);
    blank(HTMLTextAreaElement.prototype, "value", areaValue, "", (area) => typed(areaValue.get.call(area)));

    // Tokens, and the realms of frames (each made so itself, but not reached through these).
    deny(Document.prototype, "cookie", "document.cookie");

    for (const proto of [HTMLIFrameElement.prototype, HTMLFrameElement.prototype, HTMLObjectElement.prototype]) {
        deny(proto, "contentWindow", "A frame's window");
        deny(proto, "contentDocument", "A frame's document");
    }

    // The navigator: what it says about the browser; nothing else.
    const navigatorProto = Navigator.prototype;

    for (const name of new Set([...Object.getOwnPropertyNames(navigatorProto), ...NAMED_NAVIGATOR])) {
        if (name !== "constructor" && !NAVIGATOR.has(name)) {
            deny(navigatorProto, name, `navigator.${name}`);
        }
    }

    // Every interface's prototype (and those it inherits from): setters refuse, only reading methods stay.
    const seen = new Set([navigatorProto, Object.prototype, Function.prototype]);
    const lock = (proto) => {
        for (let at = proto; at !== null && !seen.has(at); at = Object.getPrototypeOf(at)) {
            seen.add(at);

            for (const name of Object.getOwnPropertyNames(at)) {
                const descriptor = Object.getOwnPropertyDescriptor(at, name);

                const label = `${at.constructor?.name ?? "the page"}.${name}`;

                if (name === "constructor" || descriptor === undefined || fixed(descriptor, label)) {
                    continue;
                }

                if (descriptor.get !== undefined || descriptor.set !== undefined) {
                    if (LATER.has(name)) {
                        deny(at, name, label);
                    } else if (descriptor.set !== undefined) {
                        define(at, name, { get: descriptor.get, set: refuse(`Setting ${label}`), enumerable: descriptor.enumerable }, label);
                    }
                } else if (typeof descriptor.value === "function" && !READS.has(name)) {
                    define(at, name, { value: refuse(label), writable: false, enumerable: descriptor.enumerable }, label);
                }
            }
        }
    };
    const globals = Object.getOwnPropertyNames(window);

    for (const name of globals) {
        const descriptor = Object.getOwnPropertyDescriptor(window, name);
        const value = descriptor?.value;

        if (!LANGUAGE.has(name) && typeof value === "function" && value.prototype !== null && typeof value.prototype === "object") {
            lock(value.prototype);
        }
    }

    lock(EventTarget.prototype);
    // CSS's namespace: supports and escape.
    lock(CSS);

    // The window: what reading needs, the language's own, and the DOM's interfaces; everything else refused.
    for (const name of new Set([...globals, ...NAMED])) {
        // A child frame by its number (`window[0]`): its realm is made so itself, in its own frame.
        if (name === KEY || LANGUAGE.has(name) || KEEP.has(name) || /^\d+$/.test(name)) {
            continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(window, name);
        const value = descriptor?.value;
        const nodeInterface = typeof value === "function" && value.prototype instanceof Node && !MAKERS.has(name);

        if (nodeInterface || INTERFACES.has(name) || name === "Node" || name === "EventTarget" || (descriptor !== undefined && fixed(descriptor, name))) {
            continue;
        }

        deny(window, name, name);
    }

    define(window, KEY, { value: Object.freeze({ hide, failed: Object.freeze([...failed]) }), enumerable: false, writable: false }, KEY);
    hide(hidden);

    return failed;
}
