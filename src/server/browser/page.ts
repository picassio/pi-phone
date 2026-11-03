/**
 * What Pi does on a page (`browser/pi-browser.ts`), over one DevTools connection: read it as numbered elements and visible
 * text (`snapshot.js`), and act on an element it read: click, type, select. Every target is an observed DOM node, never a
 * selector or a script the model wrote; just before input the element is checked to be the one observed, still in view,
 * and not covered, or the action is refused as stale and the page read again. Input is real (DevTools input events).
 * The loop's shape and the act-time checks follow jev-ultrafast (MIT, Browser Use).
 */
import { readFileSync } from "node:fs";
import type { Cdp } from "./cdp.ts";

const SNAPSHOT = readFileSync(new URL("./snapshot.js", import.meta.url), "utf8");
/** What makes the world browser_eval's scripts run in one that only reads the page (PP-244; `eval-world.js`). */
const EVAL_WORLD = readFileSync(new URL("./eval-world.js", import.meta.url), "utf8");
/** The isolated world browser_eval's scripts run in, by name: one per frame, shared by the frames of an origin. */
export const EVAL_WORLD_NAME = "pi-eval";
/** How long a browser_eval script may take, awaiting included. */
export const EVAL_MS = 10_000;

type FrameTree = { frame: { id: string; parentId?: string; url?: string }; childFrames?: FrameTree[] };

/** The isolated world Pi reads a frame other than the main one in (PP-376): it shares the frame's DOM, not its scripts. */
export const READ_WORLD_NAME = "pi-read";
/**
 * A control's number in a frame (PP-376): the frame's slot times this, plus its number there. The main frame's slot is 0,
 * so its numbers are as they were.
 */
export const FRAME_SPAN = 10_000_000;
/** Frames read with the page at most (those in view), and frames looked at to find them. */
const MAX_FRAMES = 12;
const MAX_FRAMES_LISTED = 40;
/** Each frame's visible text in a read, at most. */
const FRAME_TEXT = 3000;

/** A frame of the page besides the main one (PP-376): the connection its scripts run on, its parent, and its address. */
type ChildFrame = { frameId: string; parentId: string; cdp: Cdp; url: string };
/** Where a frame's content is in the main frame's view (CSS pixels): its top left, and the part of it in view. */
type FrameBox = { x: number; y: number; clip: { left: number; top: number; right: number; bottom: number }; owner?: number };
/**
 * A frame's content box in its parent's view, whether it is shown, and a point in it as the parent's, if it is not covered
 * there; and its frame element's node in the parent (`owner`, DevTools' backend id).
 */
type OwnerBox = { x: number; y: number; w: number; h: number; shown: boolean; hit: { x: number; y: number } | null; owner?: number };

/**
 * Run on a frame's element in its parent (`DOM.getFrameOwner`): where its content is in the parent's view, whether it is
 * shown, and, given a point of the frame, that point in the parent's view if the frame element is what is there.
 */
const OWNER_BOX = `function (point) {
  if (!this.isConnected) return null;
  const r=this.getBoundingClientRect(), s=getComputedStyle(this), px=v=>parseFloat(v)||0;
  const x=r.left+this.clientLeft+px(s.paddingLeft), y=r.top+this.clientTop+px(s.paddingTop);
  const w=this.clientWidth-px(s.paddingLeft)-px(s.paddingRight), h=this.clientHeight-px(s.paddingTop)-px(s.paddingBottom);
  const shown=this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && !this.closest('[aria-hidden="true"],[inert]');
  let hit=null;
  if (point) {
    const at={x:x+point.x, y:y+point.y}, root=this.getRootNode();
    hit=(root.elementFromPoint ? root : document).elementFromPoint(at.x, at.y)===this ? at : null;
  }
  return {x,y,w,h,shown,hit};
}`;

/** The document's and its open shadow roots' (PP-376), outermost first, in a script of its own: 200 at most. */
const ROOTS = `(() => { const found=[document]; for (let i=0; i<found.length && found.length<200; i++) for (const e of found[i].querySelectorAll('*')) if (e.shadowRoot && found.length<200) found.push(e.shadowRoot); return found; })()`;

/** All of a document's text (browser_text): its body's, and its open shadow roots' that the body's does not have. */
const TEXT_OF = `(() => {
  const body=document.body ? document.body.innerText : '';
  const more=${ROOTS}.slice(1).map(root=>[...root.children].map(e=>e.innerText ?? e.textContent ?? '').join('\\n').trim()).filter(text=>text && !body.includes(text));
  return [body, ...more].join('\\n');
})()`;

/**
 * Where things are in a frame's view (`BrowserPage.areasOf`): a control by its node (-1: none here), or every place a
 * text shows (in its open shadow roots and fields too).
 */
function areasScript(targets: readonly ({ node: number } | { text: string })[], whole?: number): string {
    // `whole`: the page's first so many pixels, in its own coordinates (a whole-page picture); else the view's.
    return `(targets => { const roots=${ROOTS}, H=${whole === undefined ? "null" : String(whole)}; return targets.map(t => {
            const seen = r => r.width>0 && r.height>0 && r.right>0 && r.left<innerWidth &&
              (H===null ? r.bottom>0 && r.top<innerHeight : r.bottom+scrollY>0 && r.top+scrollY<H);
            const box = r => ({x:r.left, y:r.top+(H===null ? 0 : scrollY), width:r.width, height:r.height});
            if ('node' in t) {
              const e=t.node<0 ? undefined : window.__piBrowser?.nodes.get(t.node);
              if (!e?.isConnected) return null;
              const r=e.getBoundingClientRect();
              return seen(r) ? [box(r)] : null;
            }
            const found=[], range=document.createRange();
            for (const root of roots) {
              const walker=document.createTreeWalker(root===document ? (document.body || document) : root, NodeFilter.SHOW_TEXT);
              let n;
              while ((n=walker.nextNode()) && found.length<50) {
                const s=n.textContent;
                for (let at=s.indexOf(t.text); at>=0 && found.length<50; at=s.indexOf(t.text, at+t.text.length)) {
                  range.setStart(n, at); range.setEnd(n, at+t.text.length);
                  for (const r of range.getClientRects()) if (seen(r)) found.push(box(r));
                }
              }
            }
            // A value in a field (an input's text is no text node).
            for (const f of roots.flatMap(root=>[...root.querySelectorAll('input,textarea')])) {
              if (found.length>=50) break;
              if (f.type!=='password' && typeof f.value==='string' && t.text && f.value.includes(t.text)) {
                const r=f.getBoundingClientRect();
                if (seen(r)) found.push(box(r));
              }
            }
            return found;
          }); })(${JSON.stringify(targets)})`;
}

/** A frame's name for Pi: its site, or what it is when it has none (an inline frame). */
export function frameName(url: string): string {
    try {
        return new URL(url).host || "an inline frame";
    } catch {
        return "an inline frame";
    }
}

/** Addresses Pi's browser never loads (Fetch patterns): the app itself, this device, and the local network (a page could act as you). */
export const BLOCKED_URLS = [
    "*://127.*",
    "*://localhost*",
    "*://[::1]*",
    "*://0.0.0.0*",
    "*://10.*",
    "*://192.168.*",
    "*://169.254.*",
    ...Array.from({ length: 16 }, (_each, index) => `*://172.${16 + index}.*`),
    // Tailscale's addresses (100.64.0.0/10), where the owner's machines and this app's other address are.
    ...Array.from({ length: 64 }, (_each, index) => `*://100.${64 + index}.*`),
];

/** This device or its local network, by the address written (as PiBrowser.java's check): never opened. */
export function isLocalAddress(url: string): boolean {
    let host: string;

    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }

    if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "0.0.0.0") {
        return true;
    }

    const octets = host.split(".").map(Number);

    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
        return false;
    }

    const [a, b] = octets as [number, number, number, number];

    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

type RawAction = {
    node: number;
    role: string;
    label: string;
    rect: { x: number; y: number; w: number; h: number };
    kind: "click" | "fill" | "select";
    value?: string;
    option?: string;
    current_value?: string;
    checked?: string;
    selected?: string;
    expanded?: string;
    /** The frame it is in, by its site (PP-376); none in the main frame. */
    frame?: string;
    /** "true": it can be dragged (browser_drag): draggable, a slider, or a grab cursor. */
    draggable?: string;
};

/** The page as read: its controls (raw, per action) and the guards that tell whether it changed since. */
export type Observed = {
    url: string;
    title: string;
    w: number;
    h: number;
    text: string;
    scroll: { y: number; height: number };
    actions: RawAction[];
    marker: unknown;
    page_key: unknown;
    guards: Record<string, unknown>;
    omitted: number;
    /** Each frame read besides the main one (PP-376), by its slot: its page key, as `page_key` is the main frame's. */
    frame_keys?: Record<string, unknown>;
    /** The listed control that has the focus (PP-376), by its node; and whether a frame has it instead. */
    focused?: number;
    active_frame?: boolean;
};

/** A control on the page, numbered for Pi: what it is, what it holds, and what can be done with it. */
export type Element = {
    index: number;
    node: number;
    role: string;
    label: string;
    value?: string;
    checked?: string;
    selected?: string;
    expanded?: string;
    click: boolean;
    fill: boolean;
    /** A drop-down list's other choices (the chosen one is `value`). */
    options?: { label: string; value: string }[];
    /** The frame it is in, by its site (PP-376); none in the main frame. */
    frame?: string;
    /** It can be dragged (browser_drag). */
    draggable?: boolean;
    /** It has the focus (PP-376): keys go to it. */
    focused?: boolean;
};

/** A file a page downloads (PP-376), as DevTools tells it: its id, the name the page gives it, where from, and how far it is. */
export type Download = { guid: string; name: string; url: string; state: "inProgress" | "completed" | "canceled"; received: number; total: number; told?: boolean };

/**
 * What to select (PP-376: `browser_select_text`): a text (the first place it shows in view, else the first), every
 * character (`all`), or characters `start` to `end`; on the page, or in a control (in a field, its own selection).
 */
export type TextSelection = { text?: string; all?: boolean; start?: number; end?: number };

/**
 * Select in a frame's document (`node` -1: its text; else in that control): `{from, to, length}` in characters of the
 * field's value or the text's, or why not. Text across elements is matched with any white space between.
 */
const SELECT_TEXT = `(async (node, spec) => {
  const visible=e=>e && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const textNodes=root=>{
    const out=[], roots=[root];
    for (let i=0; i<roots.length && roots.length<200; i++) {
      const walker=document.createTreeWalker(roots[i], NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n=walker.nextNode())) {
        if (n.nodeType===1) { if (n.shadowRoot) roots.push(n.shadowRoot); continue; }
        const p=n.parentElement;
        if (p && !p.closest('script,style,noscript,template') && visible(p)) out.push(n);
      }
    }
    return out;
  };
  // A start at a node's end is the next node's start (not across a block's edge), an end there is that node's end.
  const at=(nodes, offset, end)=>{
    let seen=0;
    for (const n of nodes) { const length=n.textContent.length; if (offset<seen+length || (offset===seen+length && end)) return [n, offset-seen]; seen+=length; }
    return offset===seen && nodes.length ? [nodes[nodes.length-1], nodes[nodes.length-1].textContent.length] : null;
  };
  const find=(whole, text)=>{
    const pattern=new RegExp(text.trim().replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&').replace(/\\s+/g,'\\\\s+'),'g');
    return [...whole.matchAll(pattern)].map(m=>[m.index, m.index+m[0].length]);
  };
  const e=node<0 ? null : window.__piBrowser?.nodes.get(node);
  if (node>=0 && !e?.isConnected) return {error:'it is gone'};
  if (e && e.tagName==='INPUT' && e.type==='password') return {error:'it is a password field'};
  if (e && (e.tagName==='TEXTAREA' || (e.tagName==='INPUT' && typeof e.selectionStart==='number'))) {
    const length=e.value.length;
    let range;
    if (spec.all) range=[0,length];
    else if (spec.text!==undefined) range=find(e.value, spec.text)[0];
    else { const from=Math.max(0,Math.min(spec.start ?? 0,length)); range=[from, Math.max(from,Math.min(spec.end ?? length,length))]; }
    if (!range) return {error:'its value does not have that text'};
    e.focus({preventScroll:true});
    e.setSelectionRange(range[0], range[1]);
    return {from:range[0], to:range[1], length};
  }
  const nodes=textNodes(e ?? document.body);
  const whole=nodes.map(n=>n.textContent).join('');
  const shown=r=>{ const b=r.getBoundingClientRect(); return b.width>0 && b.bottom>0 && b.top<innerHeight && b.right>0 && b.left<innerWidth; };
  const rangeOf=([from, to])=>{ const s=at(nodes, from, false), t=at(nodes, to, true); if (!s || !t) return null; const r=document.createRange(); r.setStart(s[0], s[1]); r.setEnd(t[0], t[1]); return r; };
  let range;
  if (spec.all) range=[0, whole.length];
  else if (spec.text!==undefined) { const all=find(whole, spec.text); range=all.find(each=>{ const r=rangeOf(each); return r && shown(r); }) ?? all[0]; }
  else { const from=Math.max(0,Math.min(spec.start ?? 0,whole.length)); range=[from, Math.max(from,Math.min(spec.end ?? whole.length,whole.length))]; }
  const chosen=range && rangeOf(range);
  if (!chosen) return {error: e ? 'its text does not have that' : 'the page does not show that text'};
  if (e && e.isContentEditable) e.focus({preventScroll:true});
  if (!shown(chosen)) chosen.startContainer.parentElement?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  getSelection().setBaseAndExtent(chosen.startContainer, chosen.startOffset, chosen.endContainer, chosen.endOffset);
  return {from:range[0], to:range[1], length:whole.length};
})`;

/** How a control is clicked (PP-376): once, twice, with the right button, or a long press. */
export type ClickKind = "single" | "double" | "right" | "long";
/** A long press's length by default, and its bounds, in ms. */
export const LONG_PRESS_MS = 800;
export const LONG_PRESS_RANGE = { min: 300, max: 5000 } as const;

/** The shortest value text hiding (`Page.hideTyped`) covers: a shorter one would hide every "42" on the page. */
export const MIN_TYPED_HIDDEN = 3;

/** A field the person filled from a sign-in or code card (PP-228): its node, what they typed, and whether it is a password field. */
export type CardFill = { node: number; value: string; password: boolean };

/**
 * Whether a value the person typed on a card that text hiding cannot cover (under `MIN_TYPED_HIDDEN` characters, in a
 * field that is not a password field) still shows on the page as read: its field is there, holding it (PP-228). Then Pi
 * gets no page, neither text nor picture, only a fixed note (`SHORT_VALUE_NOTE`).
 */
export function shortCardValueShowing(fills: readonly CardFill[], observed: Observed): boolean {
    return fills.some(
        (fill) =>
            !fill.password &&
            fill.value.length < MIN_TYPED_HIDDEN &&
            observed.actions.some((action) => action.node === fill.node && (action.value === fill.value || action.current_value === fill.value)),
    );
}

/**
 * What a picture of the page sent to a model has blacked out (PP-228): every field the person filled from a card (by
 * its node), and every place a value they typed shows (by its text, in fields and on the page: "Welcome tuan@…"), for
 * values text hiding covers; a shorter one withholds the page instead (`shortCardValueShowing`).
 */
export function cardHideTargets(fills: readonly CardFill[]): ({ node: number } | { text: string })[] {
    const texts = [...new Set(fills.map((fill) => fill.value).filter((value) => value.length >= MIN_TYPED_HIDDEN))];

    return [...fills.map((fill) => ({ node: fill.node })), ...texts.map((text) => ({ text }))];
}

/** What Pi gets instead of the page while a short value the person typed shows (`shortCardValueShowing`). */
export const SHORT_VALUE_NOTE =
    "The page is not shown: a field shows what the person typed on the card, too short to hide from you. Submit it with browser_press Enter (the field has the focus), or ask the person to with browser_ask_user; then read the page again.";

/** The page changed (or the element moved, or something covers it) since it was read: read it again. */
/**
 * In every document Pi's browser loads (PP-79): alert, confirm and prompt answer at once, as Pi asked for the click or
 * key press under way (`__piDialogs.accept`), and keep what they showed (the last five) for the next read.
 */
/** The DevTools binding a page's input reaches pi-phone by (PP-274), and the listeners that call it. */
export const INPUT_BINDING = "__piPhoneInput";
export const INPUT_WATCH = `(() => {
  if (window.__piPhoneInputWatch) return;
  window.__piPhoneInputWatch = true;
  let last = 0;
  const heard = (event) => {
    if (!event.isTrusted || typeof window.${INPUT_BINDING} !== 'function') return;
    const now = Date.now();
    if (now - last < 400) return;
    last = now;
    try { window.${INPUT_BINDING}(event.type); } catch {}
  };
  for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, heard, { capture: true, passive: true });
})()`;

const DIALOGS = `(() => {
    if (window.__piDialogs) return;
    const state = { accept: false, shown: [] };
    Object.defineProperty(window, "__piDialogs", { value: state });
    const show = (type, message, accepted) => {
        state.shown.push({ text: type + ": " + String(message ?? "").slice(0, 300), accepted });
        if (state.shown.length > 5) state.shown.shift();
    };
    window.alert = function (message) { show("alert", message, true); };
    window.confirm = function (message) { show("confirm", message, state.accept); return state.accept; };
    window.prompt = function (message, value) { show("prompt", message, state.accept); return state.accept ? String(value ?? "") : null; };
})()`;

export class StalePage extends Error {}

/** One element per observed node, in page order, numbered from 1. */
export function elementsOf(observed: Observed): Element[] {
    const byNode = new Map<number, Element>();

    for (const action of observed.actions) {
        let element = byNode.get(action.node);

        if (element === undefined) {
            element = {
                index: byNode.size + 1,
                node: action.node,
                role: action.role,
                label: action.label,
                click: false,
                fill: false,
                ...(action.checked === undefined ? {} : { checked: action.checked }),
                ...(action.selected === undefined ? {} : { selected: action.selected }),
                ...(action.expanded === undefined ? {} : { expanded: action.expanded }),
                ...(action.frame === undefined ? {} : { frame: action.frame }),
                ...(action.draggable === "true" ? { draggable: true } : {}),
                ...(observed.focused === action.node ? { focused: true } : {}),
            };
            byNode.set(action.node, element);
        }

        if (action.kind === "select") {
            element.options = [...(element.options ?? []), { label: action.option ?? action.value ?? "", value: action.value ?? "" }];
            element.value = action.current_value ?? "";
        } else {
            element[action.kind] = true;

            if (action.value !== undefined && action.value !== "") {
                element.value = action.value;
            }
        }
    }

    return [...byNode.values()];
}

const quote = (text: string) => JSON.stringify(text);

/** The page in words for Pi: where it is, its numbered controls, and its visible text. */
export function describe(observed: Observed, elements: Element[]): string {
    const below = observed.scroll.height - (observed.scroll.y + observed.h);
    const lines = [
        `${observed.title || "(no title)"} — ${observed.url}`,
        observed.scroll.height > observed.h + 2
            ? `Scrolled ${Math.round(observed.scroll.y)} of ${Math.round(observed.scroll.height)} px${below > 2 ? ", more below" : ""}${observed.scroll.y > 0 ? ", more above" : ""}.`
            : "",
        "",
        elements.length === 0 ? "No controls in view." : "Controls in view:",
        ...elements.map((element) => {
            const parts = [`[${element.index}] ${element.role} ${quote(element.label)}`];

            if (element.options !== undefined) {
                parts.push(`chosen ${quote(element.value ?? "")}, other options: ${element.options.slice(0, 12).map((option) => quote(option.label)).join(", ")}${element.options.length > 12 ? `, … (${element.options.length - 12} more)` : ""}`);
            } else if ((element.fill && element.role !== "password") || element.role === "slider") {
                parts.push(`value ${quote(element.value ?? "")}`);
            }

            for (const state of ["checked", "selected", "expanded"] as const) {
                if (element[state] !== undefined) {
                    parts.push(`${state}=${element[state]}`);
                }
            }

            if (element.draggable === true) {
                parts.push("draggable");
            }

            if (element.focused === true) {
                parts.push("focused");
            }

            if (element.frame !== undefined) {
                parts.push(`(in a frame: ${element.frame})`);
            }

            return parts.join(" ");
        }),
        observed.omitted > 0 ? `(${observed.omitted} more controls not listed: scroll, or open the section first)` : "",
        "",
        "Visible text:",
        observed.text || "(none)",
    ];

    return lines.filter((line, index, all) => line !== "" || (all[index - 1] ?? "") !== "").join("\n").trim();
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
    Escape: { code: "Escape", keyCode: 27 },
    Tab: { code: "Tab", keyCode: 9 },
    Backspace: { code: "Backspace", keyCode: 8 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    PageDown: { code: "PageDown", keyCode: 34 },
    PageUp: { code: "PageUp", keyCode: 33 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    Delete: { code: "Delete", keyCode: 46 },
    Space: { code: "Space", keyCode: 32, text: " " },
};

export const PRESSABLE = Object.keys(KEYS);

/** Modifiers a key may be pressed with (PP-376), by name, as DevTools' bits: Alt 1, Ctrl 2, Meta (Cmd) 4, Shift 8. */
const MODIFIERS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, win: 4, shift: 8 };

/** A part of the view, in CSS pixels. */
export type PictureClip = { x: number; y: number; width: number; height: number };
/** How to take a picture of a page: PNG instead of JPEG, and only a part of the view. */
/**
 * `surface: false`: not from a desktop Chrome's surface (the CSS pixels, not twice them). The panel's first picture before
 * its screencast is taken so (PP-126): one from the surface just before a screencast left that Chrome's input at half
 * the coordinates, once another tab was open in it.
 */
export type PictureOptions = { png?: boolean; clip?: PictureClip & { scale?: number }; surface?: boolean; beyond?: boolean };

/** A whole-page picture's height at most (PP-376), in CSS pixels: twice that in a phone's pixels, 8,000, as models take. */
export const FULL_PAGE_MAX = 4000;

/**
 * A key to press: a named one, or one printable character (a list's type-ahead: "G" goes to Global Payments). Keys
 * without text go down raw, as a keyboard's do, so a page's own key handlers see them (PP-116).
 */
/**
 * A key as `keyOf` reads it: what DevTools gets (`modifiers`: `MODIFIERS`' bits) and its text, which it types (none
 * with Ctrl, Alt or Meta held: a shortcut types nothing).
 */
export type Key = { key: string; code: string; keyCode: number; text?: string; modifiers: number };

/**
 * A key or a chord to press (PP-376): a key (`keyOf`'s), after modifiers joined by "+" ("Ctrl+A", "Ctrl+Enter",
 * "Shift+Tab", "Meta+K" or "Cmd+K", "Ctrl+Shift+P"; "Ctrl++" for the plus key). Undefined for what is neither.
 */
export function chordOf(chord: string): Key | undefined {
    const plus = chord.endsWith("++");
    const parts = (plus ? chord.slice(0, -2) : chord).split("+");
    const base = plus ? "+" : chord.length > 1 && parts.length > 1 ? parts.pop()! : chord;
    const names = plus || (chord.length > 1 && chord.includes("+")) ? parts : [];
    let modifiers = 0;

    for (const name of names) {
        const bit = MODIFIERS[name.trim().toLowerCase()];

        if (bit === undefined) {
            return undefined;
        }

        modifiers |= bit;
    }

    const key = keyOf(base);

    if (key === undefined) {
        return undefined;
    }

    // A letter in a chord is the key's own ("a"), capital with Shift; Ctrl, Alt or Meta make a shortcut, which types nothing.
    const letter = names.length > 0 && /^[a-z]$/i.test(key.key) ? (modifiers & 8 ? key.key.toUpperCase() : key.key.toLowerCase()) : undefined;
    const shifted = letter === undefined ? {} : { key: letter, text: letter };
    const { text, ...rest } = { ...key, ...shifted };

    return { ...rest, modifiers, ...(text === undefined || modifiers & 7 ? {} : { text }) };
}

export function keyOf(key: string): { key: string; code: string; keyCode: number; text?: string } | undefined {
    const known = KEYS[key];

    if (known !== undefined) {
        return { key: key === "Space" ? " " : key, ...known };
    }

    if ([...key].length !== 1 || /[\p{C}]/u.test(key)) {
        return undefined;
    }

    const upper = key.toUpperCase();

    if (/^[A-Z]$/.test(upper)) {
        return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
    }

    if (/^[0-9]$/.test(key)) {
        return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
    }

    return key === " " ? { key, code: "Space", keyCode: 32, text: key } : { key, code: "", keyCode: 0, text: key };
}

/** An address as typed: words become a search, a bare name gets https. Only http and https pages. */
export function addressOf(input: string): string {
    const typed = input.trim();

    if (typed === "") {
        throw new Error("Give an address, or words to search for.");
    }

    if (/^https?:\/\//i.test(typed)) {
        return new URL(typed).href;
    }

    // A dev server as typed (localhost:3000, 10.0.0.5:8080/app): plain http, as they serve.
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/\S*)?$/i.test(typed)) {
        return new URL(`http://${typed}`).href;
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(typed) && !/^[^\s/]+\.[^\s/]+:\d/.test(typed)) {
        throw new Error("Pi's browser opens http and https pages only.");
    }

    if (/\s/.test(typed) || !typed.includes(".")) {
        return `https://duckduckgo.com/?q=${encodeURIComponent(typed)}`;
    }

    return new URL(`https://${typed}`).href;
}

export class BrowserPage {
    readonly cdp: Cdp;
    /** The element Pi typed into or clicked last, waited on before the next read (menus, suggestions). */
    #afterInput: RawAction | undefined;
    /** The last dialog the page opened (alert, confirm, prompt), dismissed: told to Pi with the next read. */
    dialog: string | undefined;
    /** The main frame's id, and whether it is loading a document now; how many loads it started. */
    #mainFrame = "";
    #loading = false;
    #loads = 0;
    /** Sessions of the page's frames in other processes (another site's: `Target.setAutoAttach`, PP-376), by frame id. */
    readonly #oopifs = new Map<string, Cdp>();
    /** The page's other frames as last listed, by id; and each one's slot (`FRAME_SPAN`), kept while the tab lives. */
    #known = new Map<string, ChildFrame>();
    readonly #slots = new Map<string, number>();
    readonly #slotFrames = new Map<number, string>();
    /** The files this page began to download and Pi has not been told the end of, by id (PP-376). */
    readonly #downloads = new Map<string, Download>();
    /** Where the browser saves them (each named by its id), when this page has them kept (`keepDownloads`). */
    downloadDir: string | undefined;

    constructor(cdp: Cdp) {
        this.cdp = cdp;
    }

    /** Hear of the downloads a connection's page (or frame) begins, and how they go. */
    #watchDownloads(cdp: Cdp): void {
        cdp.on("Page.downloadWillBegin", (params) => {
            const guid = String(params.guid);

            this.#downloads.set(guid, { guid, name: String(params.suggestedFilename ?? ""), url: String(params.url ?? ""), state: "inProgress", received: 0, total: 0 });
        });

        // Both: the browser's (its downloads, with their events on) and the page's own, whichever comes.
        for (const event of ["Browser.downloadProgress", "Page.downloadProgress"]) {
            cdp.on(event, (params) => {
                const download = this.#downloads.get(String(params.guid));

                if (download !== undefined && download.state === "inProgress") {
                    download.state = params.state === "completed" || params.state === "canceled" ? params.state : "inProgress";
                    download.received = Number(params.receivedBytes ?? download.received);
                    download.total = Number(params.totalBytes ?? download.total);
                }
            });
        }
    }

    /**
     * Have the browser save what this page downloads in `dir` (on the browser's computer), each file named by its id,
     * with its progress told (`Browser.setDownloadBehavior`; for the browser's whole profile, which is pi-phone's own).
     */
    async keepDownloads(dir: string): Promise<void> {
        await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
        this.downloadDir = dir;
    }

    /** The downloads begun and not yet forgotten, oldest first. */
    downloads(): Download[] {
        return [...this.#downloads.values()];
    }

    /** Done with a download: Pi was told how it ended. */
    forgetDownload(guid: string): void {
        this.#downloads.delete(guid);
    }

    /** Stop a download (one too big to keep). */
    async cancelDownload(guid: string): Promise<void> {
        await this.cdp.send("Browser.cancelDownload", { guid });
    }

    /** A frame's slot: given the first time it is seen, the same after. */
    #slotOf(frameId: string): number {
        let slot = this.#slots.get(frameId);

        if (slot === undefined) {
            slot = this.#slots.size + 1;
            this.#slots.set(frameId, slot);
            this.#slotFrames.set(slot, frameId);
        }

        return slot;
    }

    /** The frame of a slot, as last listed: a frame gone since is a page that changed. */
    #frameOfSlot(slot: number): ChildFrame {
        const frame = this.#known.get(this.#slotFrames.get(slot) ?? "");

        if (frame === undefined || frame.cdp.closed) {
            throw new StalePage("The frame that control was in is gone: read the page again.");
        }

        return frame;
    }

    /**
     * The page's frames besides the main one (PP-376), parents first: those in its own process (`Page.getFrameTree`:
     * same-site frames, and every frame on the phone's WebView), and those in other processes with their frames, by
     * their sessions. Kept for acting on their controls.
     */
    async #childFrames(): Promise<ChildFrame[]> {
        const found: ChildFrame[] = [];
        const walk = (node: FrameTree, cdp: Cdp, parentId: string | undefined) => {
            if (parentId !== undefined) {
                found.push({ frameId: node.frame.id, parentId, cdp, url: node.frame.url ?? "" });
            }

            for (const child of node.childFrames ?? []) {
                walk(child, cdp, node.frame.id);
            }
        };
        const main = (await this.cdp.send<{ frameTree: FrameTree }>("Page.getFrameTree")).frameTree;

        this.#mainFrame = main.frame.id;
        walk(main, this.cdp, undefined);

        // A frame's session that ends meanwhile (the frame went away) lists nothing.
        const others = await Promise.all(
            [...this.#oopifs.values()].map((cdp) => cdp.send<{ frameTree: FrameTree }>("Page.getFrameTree").then((tree) => ({ cdp, tree: tree.frameTree }), () => undefined)),
        );

        for (const other of others) {
            if (other !== undefined && other.tree.frame.parentId !== undefined) {
                walk(other.tree, other.cdp, other.tree.frame.parentId);
            }
        }

        const listed = found.slice(0, MAX_FRAMES_LISTED);

        this.#known = new Map(listed.map((frame) => [frame.frameId, frame]));

        return listed;
    }

    /** The connection a frame's document is on: the page's, or the session of the process it is in. */
    #cdpOfFrame(frameId: string): Cdp | undefined {
        return frameId === this.#mainFrame ? this.cdp : this.#known.get(frameId)?.cdp;
    }

    /** A frame's element in its parent, asked `OWNER_BOX` (with a point of the frame, whether it is covered there). */
    async #ownerBox(frame: ChildFrame, point: { x: number; y: number } | null): Promise<OwnerBox | null> {
        const parent = this.#cdpOfFrame(frame.parentId);

        if (parent === undefined) {
            return null;
        }

        const { backendNodeId } = await parent.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: frame.frameId });
        const { object } = await parent.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId });

        if (object.objectId === undefined) {
            return null;
        }

        try {
            const answer = await parent.send<{ result?: { value?: OwnerBox | null } }>("Runtime.callFunctionOn", {
                objectId: object.objectId,
                functionDeclaration: OWNER_BOX,
                arguments: [{ value: point }],
                returnByValue: true,
            });

            const box = answer.result?.value ?? null;

            return box === null ? null : { ...box, owner: backendNodeId };
        } finally {
            void parent.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
        }
    }

    /** The element with the focus in a frame (the main one without `frame`), inside open shadow roots too: its backend node id. */
    async #activeNode(frame: ChildFrame | undefined): Promise<number | undefined> {
        const cdp = frame?.cdp ?? this.cdp;
        const world = frame === undefined ? undefined : (await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frame.frameId, worldName: READ_WORLD_NAME })).executionContextId;
        const { result } = await cdp.send<{ result: { objectId?: string } }>("Runtime.evaluate", {
            expression: "(() => { let e=document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e=e.shadowRoot.activeElement; return e; })()",
            ...(world === undefined ? {} : { contextId: world }),
        });

        if (result.objectId === undefined) {
            return undefined;
        }

        try {
            return (await cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId: result.objectId })).node.backendNodeId;
        } finally {
            void cdp.send("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
        }
    }

    /**
     * Where each frame's content is in the main frame's view (`view`: its size), and the part of it in view; null for a
     * frame not shown, out of view, or whose parent is not (by its parents' boxes, one level at a time).
     */
    async #frameBoxes(frames: readonly ChildFrame[], view: { w: number; h: number; top?: number; bottom?: number }): Promise<Map<string, FrameBox | null>> {
        // A frame that went away meanwhile has no box.
        const owners = await Promise.all(frames.map((frame) => this.#ownerBox(frame, null).catch(() => null)));
        // `top` and `bottom`: more of the page than the view (a whole-page picture's), in the view's coordinates.
        const boxes = new Map<string, FrameBox | null>([[this.#mainFrame, { x: 0, y: 0, clip: { left: 0, top: view.top ?? 0, right: view.w, bottom: view.bottom ?? view.h } }]]);
        const at = new Map(frames.map((frame, index) => [frame.frameId, index]));
        const resolve = (frameId: string, depth: number): FrameBox | null => {
            const known = boxes.get(frameId);

            if (known !== undefined) {
                return known;
            }

            const index = at.get(frameId);
            const owner = index === undefined ? null : owners[index];
            const parent = index === undefined || depth > 8 ? null : resolve(frames[index]!.parentId, depth + 1);
            let box: FrameBox | null = null;

            if (owner !== null && owner !== undefined && owner.shown && parent !== null) {
                const x = parent.x + owner.x;
                const y = parent.y + owner.y;
                const clip = {
                    left: Math.max(parent.clip.left, x),
                    top: Math.max(parent.clip.top, y),
                    right: Math.min(parent.clip.right, x + owner.w),
                    bottom: Math.min(parent.clip.bottom, y + owner.h),
                };

                box = clip.right - clip.left >= 1 && clip.bottom - clip.top >= 1 ? { x, y, clip, ...(owner.owner === undefined ? {} : { owner: owner.owner }) } : null;
            }

            boxes.set(frameId, box);

            return box;
        };

        for (const frame of frames) {
            resolve(frame.frameId, 0);
        }

        return boxes;
    }

    /** The box of the frame of a slot now (`#frameBoxes`), with its parents listed again; null when it is not in view. */
    async #boxOf(slot: number): Promise<FrameBox | null> {
        const frames = await this.#childFrames();
        const frameId = this.#slotFrames.get(slot);
        const view = await this.evaluate<{ w: number; h: number }>("({w: innerWidth, h: innerHeight})");

        return (await this.#frameBoxes(frames, view)).get(frameId ?? "") ?? null;
    }

    /**
     * A point of a frame's view as a point of the main frame's view, if every frame element on the way is what is there
     * (not covered in its parent, nor out of its view); null otherwise.
     */
    async #toMain(slot: number, point: { x: number; y: number }): Promise<{ x: number; y: number } | null> {
        let frame = this.#frameOfSlot(slot);
        let at = point;

        for (let depth = 0; depth < 8; depth++) {
            const owner = await this.#ownerBox(frame, at);

            if (owner === null || !owner.shown || owner.hit === null) {
                return null;
            }

            at = owner.hit;

            if (frame.parentId === this.#mainFrame) {
                return at;
            }

            const parent = this.#known.get(frame.parentId);

            if (parent === undefined) {
                return null;
            }

            frame = parent;
        }

        return null;
    }

    /** Run an expression in a frame's isolated world (`READ_WORLD_NAME`), as `evaluate` does in the main frame. */
    async #evaluateIn<T>(frame: ChildFrame, expression: string, { awaitPromise = false, userGesture = false }: { awaitPromise?: boolean; userGesture?: boolean } = {}): Promise<T> {
        const world = await frame.cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frame.frameId, worldName: READ_WORLD_NAME }).catch((error: unknown) => {
            throw new StalePage(`The frame changed while it was read (${error instanceof Error ? error.message : String(error)}).`);
        });
        const answer = await frame.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", {
            expression,
            contextId: world.executionContextId,
            returnByValue: true,
            awaitPromise,
            userGesture,
        });

        if (answer.exceptionDetails !== undefined) {
            throw new StalePage(`The frame changed while it was read (${answer.exceptionDetails.exception?.description?.split("\n")[0] ?? answer.exceptionDetails.text ?? "an error"}).`);
        }

        return answer.result?.value as T;
    }

    /**
     * Run a script about a control, in the frame it is in (`build` gets its number there): the main frame's own world, or
     * another frame's isolated world. `userGesture` in another frame: a frame of another site takes the focus only so.
     */
    async #evaluateAt<T>(node: number, build: (local: number) => string, { awaitPromise = false, userGesture = false }: { awaitPromise?: boolean; userGesture?: boolean } = {}): Promise<T> {
        const slot = Math.floor(node / FRAME_SPAN);

        if (slot === 0) {
            return this.evaluate<T>(build(node), awaitPromise);
        }

        return this.#evaluateIn<T>(this.#frameOfSlot(slot), build(node % FRAME_SPAN), { awaitPromise, userGesture });
    }

    /**
     * The page read with its frames in view (PP-376): each frame's controls numbered with its slot, placed in the main
     * frame's view, and listed only where the frame shows them; its visible text after the page's, under its site.
     */
    async #withFrames(main: Observed): Promise<Observed> {
        const frames = await this.#childFrames();

        if (frames.length === 0) {
            return main;
        }

        const boxes = await this.#frameBoxes(frames, { w: main.w, h: main.h });
        const shown = frames.filter((frame) => (boxes.get(frame.frameId) ?? null) !== null).slice(0, MAX_FRAMES);
        // A frame that navigates or goes away while it is read is left out of this read.
        const reads = await Promise.all(shown.map((frame) => this.#evaluateIn<Observed | null>(frame, SNAPSHOT).catch(() => null)));
        const actions = [...main.actions];
        const guards = { ...main.guards };
        const frameKeys: Record<string, unknown> = {};
        const markers: unknown[] = [main.marker];
        const texts = [main.text];
        let omitted = main.omitted;

        shown.forEach((frame, index) => {
            const read = reads[index];
            const box = boxes.get(frame.frameId);

            if (read === null || read === undefined || box === null || box === undefined) {
                return;
            }

            const slot = this.#slotOf(frame.frameId);
            const name = frameName(read.url);

            for (const action of read.actions) {
                const x = box.x + action.rect.x;
                const y = box.y + action.rect.y;
                const cx = x + action.rect.w / 2;
                const cy = y + action.rect.h / 2;

                if (cx < box.clip.left || cx >= box.clip.right || cy < box.clip.top || cy >= box.clip.bottom) {
                    continue;
                }

                actions.push({ ...action, node: slot * FRAME_SPAN + action.node, rect: { ...action.rect, x, y }, frame: name });
            }

            for (const [node, guard] of Object.entries(read.guards)) {
                guards[String(slot * FRAME_SPAN + Number(node))] = guard;
            }

            frameKeys[String(slot)] = read.page_key;
            markers.push(read.marker);
            omitted += read.omitted;

            if (read.text !== "") {
                texts.push(`[In a frame: ${name}]\n${read.text.slice(0, FRAME_TEXT)}`);
            }
        });

        omitted += Math.max(0, actions.length - 250);
        actions.splice(250);

        // The focus in a frame: down from the main frame, each time to the frame whose element has its parent's focus.
        let focused = main.focused;
        let within: ChildFrame | undefined;
        let inFrame = main.active_frame === true;

        for (let depth = 0; depth < 4 && focused === undefined && inFrame; depth++) {
            const active = await this.#activeNode(within).catch(() => undefined);
            const parentId = within?.frameId ?? this.#mainFrame;
            const at = shown.findIndex((frame) => frame.parentId === parentId && active !== undefined && boxes.get(frame.frameId)?.owner === active);
            const read = reads[at];

            if (at < 0 || read === null || read === undefined) {
                break;
            }

            within = shown[at]!;
            focused = read.focused === undefined ? undefined : this.#slotOf(within.frameId) * FRAME_SPAN + read.focused;
            inFrame = read.active_frame === true;
        }

        return { ...main, actions, guards, frame_keys: frameKeys, marker: markers, text: texts.join("\n"), omitted, ...(focused === undefined ? {} : { focused }) };
    }

    /**
     * What a person typed into this page through a card (a username, a password, a one-time code), kept in memory only,
     * with what it reads as instead: everything Pi reads of the page has `[typed by the person]`, or a username's
     * `[username for <site>]` (PP-93; the username too since pi-pocket's review, TannerMidd/pi-pocket-extensions#29). A
     * code in a plain text field would otherwise show in the next read.
     */
    readonly #typed = new Map<string, string>();
    /** The fields filled from a card on this page, as they were filled (PP-228): for pictures and short values. */
    readonly #cardFills: CardFill[] = [];

    /** The fields filled from a card on this page (`CardFill`). */
    cardFills(): readonly CardFill[] {
        return this.#cardFills;
    }

    /** `text` with what the person typed through a card taken out, longest first. */
    hideTyped(text: string): string {
        let result = text;

        for (const [value, shown] of [...this.#typed].sort(([a], [b]) => b.length - a.length)) {
            result = result.split(value).join(shown);
        }

        return result;
    }

    /**
     * JSON text with what the person typed through a card taken out (`hideTyped`), as written in it too: a value with a
     * quote or a backslash is escaped in JSON, and reads as what it reads as, in JSON.
     */
    hideTypedJson(text: string): string {
        let result = text;

        for (const [value, shown] of [...this.#typed].sort(([a], [b]) => b.length - a.length)) {
            const written = JSON.stringify(value).slice(1, -1);
            const replacement = JSON.stringify(shown).slice(1, -1);

            result = result.split(written).join(replacement).split(value).join(replacement);
        }

        return result;
    }

    /** Whether the world browser_eval runs in is made so in this tab's documents to come (`EVAL_WORLD`). */
    #evalWorld = false;

    /**
     * Run a script that reads the page (browser_eval, PP-244), in an isolated world of the main frame: it shares the DOM,
     * not the page's scripts. First every frame of the page gets that world made one that reads the page and
     * nothing else (`eval-world.js`: no cookies, storage, network, timers, events, windows, or changing anything; the
     * fields holding `hidden`, and password fields, read as empty), and the documents to come too. While it runs, the
     * page's own scripts are off, so a `javascript:` address it navigates to never runs in the page's world (a
     * navigation it starts is dropped then, not kept for later). Answers its value as JSON text (`undefined`, or a
     * number JSON has no word for, as written); throws a clear error when it throws, takes over `EVAL_MS`, or the world
     * could not be made so.
     */
    async evaluateIsolated(expression: string, { awaitPromise, hidden }: { awaitPromise: boolean; hidden: readonly string[] }): Promise<string> {
        if (!this.#evalWorld) {
            await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${EVAL_WORLD})([])`, worldName: EVAL_WORLD_NAME });
            this.#evalWorld = true;
        }

        type Answer = {
            result?: { type?: string; subtype?: string; value?: unknown; unserializableValue?: string };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
        let answer: Answer;

        // The page's scripts are off before its frames are listed, so none is added by them meanwhile.
        await this.cdp.send("Emulation.setScriptExecutionDisabled", { value: true });

        try {
            const context = await this.#evalWorlds(hidden);

            try {
                answer = await this.cdp.send<Answer>(
                    "Runtime.evaluate",
                    { expression, contextId: context, returnByValue: true, awaitPromise, timeout: EVAL_MS, userGesture: false },
                    EVAL_MS + 1000,
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);

                throw new Error(/took longer than|Execution was terminated/.test(message) ? `The script did not finish within ${EVAL_MS / 1000} seconds.` : `The script could not run: ${message}`);
            }
        } finally {
            await this.cdp.send("Emulation.setScriptExecutionDisabled", { value: false });
        }

        if (answer.exceptionDetails !== undefined) {
            const description = answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "an error";

            if (/Execution was terminated/.test(description)) {
                throw new Error(`The script did not finish within ${EVAL_MS / 1000} seconds.`);
            }

            const message = description
                .split("\n")
                .filter((line) => !/^\s+at /.test(line))
                .join("\n")
                .slice(0, 1000);

            throw new Error(`The script threw: ${this.hideTyped(message)}`);
        }

        const result = answer.result ?? {};

        if (result.unserializableValue !== undefined) {
            return result.unserializableValue;
        }

        if (result.value === undefined) {
            return result.type === "undefined" ? "undefined" : `(a ${result.subtype ?? result.type ?? "value"} that is not plain data: return strings, numbers, booleans, arrays or objects of them)`;
        }

        return JSON.stringify(result.value);
    }

    /**
     * Make the world browser_eval runs in one that only reads (`EVAL_WORLD`) in every frame of the page, with the
     * person's card values `hidden`; answers the main frame's world. Throws when a frame's could not be made so.
     */
    async #evalWorlds(hidden: readonly string[]): Promise<number> {
        // Every frame of the page in this renderer, the main one first: a script reaches a same-origin frame's globals
        // (`window[0]`), another realm each, whose origin DevTools does not always say (an about:srcdoc frame's is "://").
        // Frames in other processes (another site's) are not in this tree, and a script cannot reach into them.
        const frames: string[] = [];
        const walk = (node: FrameTree) => {
            frames.push(node.frame.id);

            for (const child of node.childFrames ?? []) {
                walk(child);
            }
        };

        walk((await this.cdp.send<{ frameTree: FrameTree }>("Page.getFrameTree")).frameTree);

        let context: number | undefined;

        for (const frameId of frames) {
            const world = await this.cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId, worldName: EVAL_WORLD_NAME });
            const made = await this.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.callFunctionOn", {
                functionDeclaration: EVAL_WORLD,
                executionContextId: world.executionContextId,
                arguments: [{ value: [...hidden] }],
                returnByValue: true,
            });

            if (made.exceptionDetails !== undefined) {
                throw new Error(`browser_eval could not prepare the page: ${made.exceptionDetails.exception?.description?.split("\n")[0] ?? "an error"}.`);
            }

            const failed = Array.isArray(made.result?.value) ? (made.result.value as unknown[]).map(String) : [];

            if (failed.length > 0) {
                throw new Error(`browser_eval does not run on this page: it could not make ${failed.slice(0, 10).join(", ")} unavailable to the script.`);
            }

            context ??= world.executionContextId;
        }

        if (context === undefined) {
            throw new StalePage("The page has no frame to run the script in: read it again.");
        }

        return context;
    }

    /** A read with the person's typing hidden in what Pi is told; its guards stay, so a stale read is still seen. */
    #hidden(observed: Observed): Observed {
        if (this.#typed.size === 0) {
            return observed;
        }

        const hide = (text: string | undefined) => (text === undefined ? undefined : this.hideTyped(text));

        return {
            ...observed,
            url: this.hideTyped(observed.url),
            title: this.hideTyped(observed.title),
            text: this.hideTyped(observed.text),
            actions: observed.actions.map((action) => ({
                ...action,
                label: this.hideTyped(action.label),
                ...(action.value === undefined ? {} : { value: hide(action.value) }),
                ...(action.current_value === undefined ? {} : { current_value: hide(action.current_value) }),
            })),
        };
    }

    /**
     * Hear of a person's input in the page (a press, a key, a wheel: trusted events, at most one in 400 ms), for a window
     * on a machine's screen (PP-274). Pi's own input through DevTools is trusted too: the caller tells them apart by when
     * Pi acted. Every document gets the listeners, through a DevTools binding.
     */
    async watchInput(heard: () => void): Promise<void> {
        this.cdp.on("Runtime.bindingCalled", (params) => {
            if (params.name === INPUT_BINDING) {
                heard();
            }
        });
        // A binding's calls reach DevTools only with the Runtime domain on (tuanlh-sandbox-01, Chrome 156: none came without).
        await this.cdp.send("Runtime.enable");
        await this.cdp.send("Runtime.addBinding", { name: INPUT_BINDING });
        await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INPUT_WATCH });
        await this.evaluate<unknown>(INPUT_WATCH).catch(() => {});
    }

    /** Whether pictures come from the GPU surface (a desktop Chrome: at the device scale) or the view (the phone's WebView). */
    #fromSurface = false;

    /** Whether local addresses are refused: on the phone, where the app's own server is; not on a machine's own Chrome. */
    #blockLocal = true;

    /**
     * Turn on what reading and acting need, block the local addresses (unless `local`: a machine's Chrome may open that
     * machine's dev servers), and dismiss dialogs (accepted only when asked).
     */
    /**
     * `oopif`: a Chrome, whose frames of other sites run in processes of their own: each is attached as it comes, so Pi
     * reads and acts on them (PP-376). The phone's WebView keeps every frame in the page's process.
     */
    async init(
        viewport: { width: number; height: number; mobile: boolean },
        { local = false, phone = false, oopif = false }: { local?: boolean; phone?: boolean; oopif?: boolean } = {},
    ): Promise<void> {
        await this.cdp.send("Page.enable");
        this.#blockLocal = !local;
        this.#watchDownloads(this.cdp);

        if (phone) {
            await this.#actAsPhone();
        }

        this.#fromSurface = phone;
        this.#touch = viewport.mobile;

        if (!local) {
            // Requests to the local addresses pause (only those) and fail: navigations, frames, scripts, fetches alike.
            // (Network.setBlockedURLs no longer blocks in Chrome 155.)
            this.cdp.on("Fetch.requestPaused", (params) => {
                void this.cdp.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
            });
            await this.cdp.send("Fetch.enable", { patterns: BLOCKED_URLS.map((urlPattern) => ({ urlPattern })) });
        }

        this.#ownAgent = await this.evaluate<string>("navigator.userAgent").catch(() => "");
        await this.#metrics(viewport, phone);

        if (!viewport.mobile) {
            await this.#actAsDesktop();
        }

        await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
        this.#mainFrame = ((await this.cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree")).frameTree.frame.id);
        this.cdp.on("Page.frameStartedLoading", (params) => {
            if (params.frameId === this.#mainFrame) {
                this.#loading = true;
                this.#loads += 1;
            }
        });
        this.cdp.on("Page.frameStoppedLoading", (params) => {
            if (params.frameId === this.#mainFrame) {
                this.#loading = false;
            }
        });
        // Dialogs are answered in the page (PP-79): the phone's WebView has no dialog UI, and answers confirm() with false
        // before DevTools hears of it. Every document gets alert, confirm and prompt that answer as Pi asked and say what
        // they showed; DevTools' dialogs (beforeunload, a page that kept the originals) are still answered below.
        await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: DIALOGS }).catch(() => {});
        await this.evaluate<unknown>(DIALOGS).catch(() => {});
        this.cdp.on("Page.javascriptDialogOpening", (params) => {
            this.dialog = `${String(params.type)}: ${String(params.message ?? "").slice(0, 300)}`;
            void this.cdp.send("Page.handleJavaScriptDialog", { accept: this.acceptDialogs }).catch(() => {});
        });

        if (oopif) {
            await this.#attachFrames(this.cdp);
        }
    }

    /**
     * Attach the frames of other sites a connection's page (or frame) has and will have, each paused until it is set up
     * as the page is: the local addresses refused, its dialogs answered, its own such frames attached (PP-376).
     */
    async #attachFrames(cdp: Cdp): Promise<void> {
        cdp.on("Target.attachedToTarget", (params) => {
            const info = params.targetInfo as { type?: string; targetId?: string } | undefined;
            const child = cdp.adopt(String(params.sessionId));

            void (async () => {
                if (info?.type !== "iframe" || info.targetId === undefined) {
                    await child.send("Runtime.runIfWaitingForDebugger");
                    child.close();

                    return;
                }

                const frameId = info.targetId;

                this.#oopifs.set(frameId, child);
                child.onClose = () => {
                    if (this.#oopifs.get(frameId) === child) {
                        this.#oopifs.delete(frameId);
                    }
                };

                // A frame whose setup fails stays paused (it never loads unblocked); one that went away has failed it.
                await child.send("Page.enable");

                if (this.#blockLocal) {
                    child.on("Fetch.requestPaused", (paused) => {
                        void child.send("Fetch.failRequest", { requestId: paused.requestId, errorReason: "BlockedByClient" }).catch(() => {});
                    });
                    await child.send("Fetch.enable", { patterns: BLOCKED_URLS.map((urlPattern) => ({ urlPattern })) });
                }

                this.#watchDownloads(child);
                child.on("Page.javascriptDialogOpening", (dialog) => {
                    this.dialog = `${String(dialog.type)}: ${String(dialog.message ?? "").slice(0, 300)}`;
                    void child.send("Page.handleJavaScriptDialog", { accept: this.acceptDialogs }).catch(() => {});
                });
                await this.#attachFrames(child);
                await child.send("Runtime.runIfWaitingForDebugger");
            })().catch(() => {
                // The frame went away while it was set up: its session ended with it.
            });
        });
        await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe", exclude: false }] });
    }

    /**
     * A desktop Chrome (a machine's, CI's) presents itself as Chrome on an Android phone, as the phone's own WebView is:
     * sites then serve their phone pages to the 412-pixel viewport, not a desktop page shrunk to fit (Wikipedia's is
     * 1120 wide). Its own version, with the user agent, client hints, and touch a phone has.
     */
    async #actAsPhone(): Promise<void> {
        const version = /\/([\d.]+)/.exec((await this.cdp.send<{ product: string }>("Browser.getVersion")).product)?.[1] ?? "155.0.0.0";
        const major = version.split(".")[0]!;
        const brands = [
            { brand: "Chromium", version: major },
            { brand: "Google Chrome", version: major },
            { brand: "Not.A/Brand", version: "99" },
        ];

        await this.cdp.send("Emulation.setUserAgentOverride", {
            userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
            platform: "Linux armv8l",
            userAgentMetadata: {
                brands,
                fullVersionList: brands.map((brand) => ({ ...brand, version: brand.brand === "Not.A/Brand" ? "99.0.0.0" : version })),
                fullVersion: version,
                platform: "Android",
                platformVersion: "14.0.0",
                architecture: "",
                model: "Pixel 8",
                mobile: true,
            },
        });
        await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }

    /** The browser's own user agent, before any override: the phone's WebView's, to go back to it from Desktop. */
    #ownAgent = "";
    /** Lay the page out at `viewport` (a desktop Chrome at twice its CSS pixels, as a phone has them). */
    async #metrics(viewport: { width: number; height: number; mobile: boolean }, phone: boolean): Promise<void> {
        await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: phone ? 2 : 0, mobile: viewport.mobile });
    }

    /**
     * Lay the page out at another size (PP-15): a phone's (`mobile`, touch, a phone's user agent) or a desktop's (no touch,
     * a desktop Chrome's user agent). An open page loads again, so its site serves the page for that size.
     */
    /** Whether the page is laid out as a phone's, with touch: a long press is then a finger's. */
    #touch = true;

    async resize(viewport: { width: number; height: number; mobile: boolean }, { phone = false }: { phone?: boolean } = {}): Promise<void> {
        this.#touch = viewport.mobile;
        await this.#metrics(viewport, phone);

        if (!viewport.mobile) {
            await this.#actAsDesktop();
        } else if (phone) {
            await this.#actAsPhone();
        } else {
            await this.cdp.send("Emulation.setUserAgentOverride", { userAgent: this.#ownAgent });
            await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        }

        const url = await this.evaluate<string>("location.href").catch(() => "");

        if (/^https?:/.test(url)) {
            await this.cdp.send("Page.reload", {});
            await this.settle(1500);
        }
    }

    /** Present as Chrome on a Windows desktop, without touch: sites serve their desktop pages. */
    async #actAsDesktop(): Promise<void> {
        const version = /\/([\d.]+)/.exec((await this.cdp.send<{ product: string }>("Browser.getVersion").catch(() => ({ product: "Chrome/155.0.0.0" }))).product)?.[1] ?? "155.0.0.0";
        const major = version.split(".")[0]!;
        const brands = [
            { brand: "Chromium", version: major },
            { brand: "Google Chrome", version: major },
            { brand: "Not.A/Brand", version: "99" },
        ];

        await this.cdp.send("Emulation.setUserAgentOverride", {
            userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
            platform: "Win32",
            userAgentMetadata: {
                brands,
                fullVersionList: brands.map((brand) => ({ ...brand, version: brand.brand === "Not.A/Brand" ? "99.0.0.0" : version })),
                fullVersion: version,
                platform: "Windows",
                platformVersion: "15.0.0",
                architecture: "x86",
                model: "",
                mobile: false,
            },
        });
        await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }

    /** Whether the next dialog is accepted (a click or key press Pi asked to accept them for); declined otherwise. */
    acceptDialogs = false;

    /** Accept dialogs (or not) from now: here, for DevTools' dialogs, and in the page, for its own. */
    async setAcceptDialogs(accept: boolean): Promise<void> {
        this.acceptDialogs = accept;
        await this.evaluate<unknown>(`window.__piDialogs && (window.__piDialogs.accept = ${accept})`).catch(() => {});
    }

    /** The dialogs the page showed since the last time, each with how it was answered; then none. */
    async takeDialogs(): Promise<{ text: string; accepted: boolean }[]> {
        const shown = await this.evaluate<{ text: string; accepted: boolean }[] | null>("(() => { const d = window.__piDialogs; if (!d) return null; const s = d.shown.slice(); d.shown.length = 0; return s; })()").catch(() => null);

        return shown ?? [];
    }

    async evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
        const answer = await this.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
        });

        if (answer.exceptionDetails !== undefined) {
            throw new StalePage(`The page changed while it was read (${answer.exceptionDetails.exception?.description?.split("\n")[0] ?? answer.exceptionDetails.text ?? "an error"}).`);
        }

        return answer.result?.value as T;
    }

    /** Open an address, and wait for it to load (15 seconds at most; a slow page is read as it is). */
    async navigate(url: string): Promise<void> {
        if (this.#blockLocal && isLocalAddress(url)) {
            throw new Error(`Pi's browser does not open ${url}: it is this device or its local network.`);
        }

        const answer = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url });

        if (answer.errorText !== undefined && answer.errorText !== "") {
            throw new Error(answer.errorText === "net::ERR_BLOCKED_BY_CLIENT" ? `Pi's browser does not open ${url}: it is this device or its local network.` : `Could not open ${url}: ${answer.errorText}`);
        }

        await this.settle(15_000);
    }

    /** Wait until the document is loaded, up to `ms`. */
    async settle(ms: number): Promise<void> {
        const until = Date.now() + ms;

        while (Date.now() < until) {
            const state = await this.evaluate<string>("document.readyState").catch(() => "loading");

            if (state === "complete") {
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    /** Read the page: retried while it navigates (a read that finds no document, or one that changes under it). */
    async observe(): Promise<Observed> {
        const after = this.#afterInput;

        this.#afterInput = undefined;

        if (after !== undefined) {
            // Menus and suggestions a click or typing opens: two frames, or up to 200 ms for a combobox's options.
            await this.#evaluateAt(
                after.node,
                (local) => `(action => new Promise(resolve => {
                    const field=window.__piBrowser?.nodes.get(action.node);
                    const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
                    let frames=0, stopped=false;
                    const finish=()=>{stopped=true;resolve()};
                    setTimeout(finish,autocomplete ? 200 : 50);
                    const ready=()=>{
                      if (stopped) return;
                      const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
                      const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
                      const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
                      if (++frames>=2 && (!autocomplete || options.some(e=>{const r=e.getBoundingClientRect();
                        return r.width && r.height && r.bottom>0 && r.top<innerHeight && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});}))) finish();
                      else requestAnimationFrame(ready);
                    };
                    requestAnimationFrame(ready);
                  }))(${JSON.stringify({ node: local, kind: after.kind })})`,
                { awaitPromise: true },
            ).catch(() => {});
        }

        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                const observed = await this.evaluate<Observed | null>(SNAPSHOT);

                if (observed !== null && observed !== undefined) {
                    return this.#hidden(await this.#withFrames(observed));
                }
            } catch (error) {
                if (!(error instanceof StalePage)) {
                    throw error;
                }
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        throw new StalePage("The page did not settle: it is still loading or changing.");
    }

    /** Whether the element (or, for none, the page) is as it was read. */
    async #fresh(observed: Observed, node: number | undefined): Promise<boolean> {
        if (node === undefined) {
            return true;
        }

        const slot = Math.floor(node / FRAME_SPAN);
        const now = await this.#evaluateAt<unknown>(node, (local) => `(() => { const c=window.__piBrowser; return c ? [c.pageKey(), c.guard(c.nodes.get(${local}))] : null; })()`);
        const key = slot === 0 ? observed.page_key : observed.frame_keys?.[String(slot)];

        return JSON.stringify(now) === JSON.stringify([key, observed.guards[String(node)] ?? null]);
    }

    /**
     * The element's centre now, if it is still there, in view, enabled, and not covered. One out of view (below the fold
     * of a list with its own scroll area, PP-116) is scrolled into view first, as a person would, and as Playwright does.
     */
    async #point(element: Element): Promise<{ x: number; y: number }> {
        let point = await this.#evaluateAt<{ x: number; y: number } | null>(
            element.node,
            (local) => `(async node => {
            const e=window.__piBrowser?.nodes.get(node);
            if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
                !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
            const at=()=>{
              const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
              if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
              // Inside a shadow root, its own hit test: the document's names only the host.
              const root=e.getRootNode(), hit=(root.elementFromPoint ? root : document).elementFromPoint(x,y);
              return e.contains(hit) || (e.shadowRoot && e.shadowRoot.contains(hit)) ? {x,y} : null;
            };
            const now=at();
            if (now) return now;
            e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
            await new Promise(done=>{ requestAnimationFrame(()=>requestAnimationFrame(done)); setTimeout(done,150); });
            return at();
          })(${local})`,
            { awaitPromise: true },
        );
        const slot = Math.floor(element.node / FRAME_SPAN);

        // In a frame: the point in the main frame's view, if the frame shows it (nothing over the frame there either).
        if (slot !== 0 && point !== null && point !== undefined) {
            point = await this.#toMain(slot, point).catch(() => null);
        }

        if (point === null || point === undefined) {
            throw new StalePage(`[${element.index}] ${element.label} changed, moved out of view, or is covered: read the page again.`);
        }

        return point;
    }

    /**
     * Put the focus on a control (PP-376: `browser_focus`), without clicking it: it must be there, shown, enabled, and
     * take the focus. Keys pressed next go to it.
     */
    async focus(observed: Observed, element: Element): Promise<void> {
        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        const why = await this.#takeFocus(element, false);

        if (why !== null) {
            throw new Error(`[${element.index}] ${element.label} did not take the focus (${why}): click it, or focus another control.`);
        }

        this.#afterInput = { node: element.node, kind: "click" } as RawAction;
    }

    /** Put the focus in a field to type into: it must be there, shown, enabled, not read-only, and take the focus. */
    async #focus(element: Element): Promise<void> {
        const why = await this.#takeFocus(element, true);

        if (why !== null) {
            throw new StalePage(`[${element.index}] ${element.label} did not take the typing (${why}): nothing was typed. Read the page again.`);
        }
    }

    /** Focus a control (one to type into: not read-only, with `typing`): null when it has the focus, else why not. */
    async #takeFocus(element: Element, typing: boolean): Promise<string | null> {
        return this.#evaluateAt<string | null>(
            element.node,
            (local) => `(async (node, typing) => {
            const e=window.__piBrowser?.nodes.get(node);
            if (!e?.isConnected) return 'gone';
            if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')) return 'disabled';
            if (!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return 'hidden';
            if (typing && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return 'read-only';
            e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
            e.focus({preventScroll:true});
            await new Promise(done=>{ requestAnimationFrame(()=>requestAnimationFrame(done)); setTimeout(done,150); });
            let active=document.activeElement;
            while (active && active.shadowRoot && active.shadowRoot.activeElement) active=active.shadowRoot.activeElement;
            return active===e || e.contains(active) || (e.shadowRoot && e.shadowRoot.contains(active)) ? null : 'focus went to '+(active?.tagName?.toLowerCase() ?? 'nothing');
          })(${local}, ${typing})`,
            // A frame of another site takes the focus only with a gesture.
            { awaitPromise: true, userGesture: true },
        );
    }

    async #click(point: { x: number; y: number }): Promise<void> {
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });

        for (const type of ["mousePressed", "mouseReleased"]) {
            await this.cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
        }
    }

    /**
     * After input that may navigate (a link, a submit, Enter): if the main frame starts loading within a moment, wait
     * for it to finish (15 seconds at most), so the next read is of the new page, not the old one.
     */
    async #followNavigation(before: number): Promise<void> {
        const until = Date.now() + 300;

        while (Date.now() < until && this.#loads === before) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        if (this.#loads === before) {
            return;
        }

        const done = Date.now() + 15_000;

        while (Date.now() < done && this.#loading) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        await this.settle(Math.max(0, done - Date.now()));
    }

    /**
     * Click a control: once (the default), twice (`double`: a double click), with the right button (`right`: its context
     * menu), or a long press (`long`, held `ms`: a finger's, with touch, as a phone's page is laid out; else the mouse's).
     */
    async click(observed: Observed, element: Element, { how = "single", ms = LONG_PRESS_MS }: { how?: ClickKind; ms?: number } = {}): Promise<void> {
        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        const before = this.#loads;
        const point = await this.#point(element);

        if (how === "single") {
            await this.#click(point);
        } else if (how === "double") {
            await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });

            for (const clickCount of [1, 2]) {
                for (const type of ["mousePressed", "mouseReleased"]) {
                    await this.cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount });
                }
            }
        } else if (how === "right") {
            await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });

            for (const type of ["mousePressed", "mouseReleased"]) {
                await this.cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "right", buttons: type === "mousePressed" ? 2 : 0, clickCount: 1 });
            }
        } else if (this.#touch) {
            await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
            await new Promise((resolve) => setTimeout(resolve, ms));
            await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
            await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
            await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, ms));
            await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
        }

        this.#afterInput = { node: element.node, kind: "click" } as RawAction;
        await this.#followNavigation(before);
    }

    /** Move the pointer over the element (menus and tooltips that open on hover), without clicking. */
    async hover(observed: Observed, element: Element): Promise<void> {
        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        const point = await this.#point(element);

        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        this.#afterInput = { node: element.node, kind: "click" } as RawAction;
    }

    /**
     * Drag a control onto another, or by an offset in CSS pixels (a slider's handle, a card to a column, an item in a
     * sortable list, a map), as Playwright's dragTo does (PP-376): the pointer goes down on it, moves there in steps, and
     * comes up. When the page starts an HTML5 drag (a `draggable` element), Chrome hands it over (`Input.dragIntercepted`)
     * and the rest goes as drag events with its DataTransfer: dragenter and dragover where the pointer is, drop at the end.
     * Answers whether it was an HTML5 drag.
     */
    async drag(observed: Observed, from: Element, to: { element: Element } | { dx: number; dy: number }): Promise<boolean> {
        if (!(await this.#fresh(observed, from.node)) || ("element" in to && !(await this.#fresh(observed, to.element.node)))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        let start = await this.#point(from);
        let end: { x: number; y: number };

        if ("element" in to) {
            end = await this.#point(to.element);

            const again = await this.#point(from);

            // Bringing the target into view moved the source: the target's point is taken again from there.
            if (Math.abs(again.x - start.x) > 1 || Math.abs(again.y - start.y) > 1) {
                start = again;
                end = await this.#point(to.element);
            }
        } else {
            end = { x: start.x + to.dx, y: start.y + to.dy };

            const view = await this.evaluate<{ w: number; h: number }>("({w: innerWidth, h: innerHeight})");

            if (end.x < 0 || end.y < 0 || end.x >= view.w || end.y >= view.h) {
                throw new Error(`Dragging [${from.index}] by ${to.dx}, ${to.dy} px would end outside the view (${view.w}×${view.h}): drag by less, or scroll first.`);
            }
        }

        let data: Record<string, unknown> | undefined;
        const off = this.cdp.on("Input.dragIntercepted", (params) => {
            data = params.data as Record<string, unknown>;
        });
        const steps = 12;
        const pause = () => new Promise((resolve) => setTimeout(resolve, 16));
        let entered = false;

        await this.cdp.send("Input.setInterceptDrags", { enabled: true });

        try {
            await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y });
            await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1 });
            await pause();

            for (let step = 1; step <= steps; step++) {
                const x = start.x + ((end.x - start.x) * step) / steps;
                const y = start.y + ((end.y - start.y) * step) / steps;

                if (data === undefined) {
                    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
                } else {
                    await this.cdp.send("Input.dispatchDragEvent", { type: entered ? "dragOver" : "dragEnter", x, y, data });
                    entered = true;
                }

                await pause();
            }

            if (data !== undefined) {
                if (!entered) {
                    await this.cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: end.x, y: end.y, data });
                }

                await this.cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: end.x, y: end.y, data });
                await this.cdp.send("Input.dispatchDragEvent", { type: "drop", x: end.x, y: end.y, data });
            }

            await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1 });
        } finally {
            off();
            await this.cdp.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
        }

        this.#afterInput = { node: from.node, kind: "click" } as RawAction;

        return data !== undefined;
    }

    /**
     * Give files (paths the browser can read) to a file field, or to the button that opens one (a styled "Upload" that
     * hides its field): the button is clicked with the file chooser caught, and the files go to the field it opened.
     */
    async upload(observed: Observed, element: Element, paths: string[]): Promise<void> {
        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        // The connection of the frame the control is in (PP-376): files and the file chooser are that frame's.
        const slot = Math.floor(element.node / FRAME_SPAN);
        const frame = slot === 0 ? undefined : this.#frameOfSlot(slot);
        const cdp = frame?.cdp ?? this.cdp;

        if (element.role === "file") {
            await this.#point(element);

            const world =
                frame === undefined ? undefined : (await frame.cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frame.frameId, worldName: READ_WORLD_NAME })).executionContextId;
            const field = await cdp.send<{ result: { objectId?: string } }>("Runtime.evaluate", {
                expression: `window.__piBrowser?.nodes.get(${element.node % FRAME_SPAN})`,
                ...(world === undefined ? {} : { contextId: world }),
            });
            const multiple = await this.#evaluateAt<boolean>(element.node, (local) => `!!window.__piBrowser?.nodes.get(${local})?.multiple`);

            if (field.result.objectId === undefined) {
                throw new StalePage(`[${element.index}] ${element.label} is gone: read the page again.`);
            }

            if (paths.length > 1 && !multiple) {
                throw new Error(`[${element.index}] ${element.label} takes one file.`);
            }

            await cdp.send("DOM.setFileInputFiles", { files: paths, objectId: field.result.objectId });
        } else {
            const point = await this.#point(element);
            let off = () => {};
            const opened = new Promise<{ backendNodeId: number; mode: string } | undefined>((resolve) => {
                const timer = setTimeout(() => resolve(undefined), 3000);

                off = cdp.on("Page.fileChooserOpened", (params) => {
                    clearTimeout(timer);
                    resolve(params as { backendNodeId: number; mode: string });
                });
            });
            let chooser: { backendNodeId: number; mode: string } | undefined;

            await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });

            try {
                await this.#click(point);
                chooser = await opened;
            } finally {
                off();
                await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
            }

            if (chooser === undefined) {
                throw new Error(`Clicking [${element.index}] ${element.label} did not ask for a file: name the page's upload button or its file field.`);
            }

            if (paths.length > 1 && chooser.mode !== "selectMultiple") {
                throw new Error(`[${element.index}] ${element.label} takes one file.`);
            }

            await cdp.send("DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId });
        }

        this.#afterInput = { node: element.node, kind: "click" } as RawAction;
    }

    async type(observed: Observed, element: Element, text: string, { clear = true, submit = false }: { clear?: boolean; submit?: boolean } = {}): Promise<void> {
        if (element.role === "password") {
            throw new Error(`[${element.index}] ${element.label} is a password field: type a saved secret into it (browser_type with secret: NAME), or ask the person with browser_sign_in.`);
        }

        await this.fill(observed, element, text, { clear, submit });
    }

    /**
     * Type into a field, password fields too: Pi's own typing goes through `type`, which refuses passwords; this is for
     * what the person typed on a sign-in or code card, which goes into the page without passing through Pi.
     */
    /**
     * `hide`: the person typed it on a card (a username, a password, a code), so Pi's reads of this page never show it
     * (`hideTyped`): `true` reads as `[typed by the person]`, a string as itself.
     */
    async fill(
        observed: Observed,
        element: Element,
        text: string,
        { clear = true, submit = false, hide = false }: { clear?: boolean; submit?: boolean; hide?: boolean | string } = {},
    ): Promise<void> {
        if (!element.fill) {
            throw new Error(`[${element.index}] ${element.label} is not a field to type into.`);
        }

        // Kept before it is typed: a read the typing sets off already hides it. Very short values would hide too much:
        // those withhold the page instead, while they show (`shortCardValueShowing`).
        if (hide !== false && text.length >= MIN_TYPED_HIDDEN) {
            this.#typed.set(text, hide === true ? "[typed by the person]" : hide);
        }

        if (hide !== false) {
            this.#cardFills.push({ node: element.node, value: text, password: element.role === "password" });
        }

        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        // The field itself takes the focus, as Playwright's fill does, not a click at where it was read: a dialog still
        // opening or a form still loading moves things between a read and a click, which then landed on something else
        // (a breadcrumb link: the page went away), and Select All then took the whole page. Only once the focus is in
        // the field do the keys go.
        await this.#focus(element);

        if (clear) {
            for (const type of ["keyDown", "keyUp"]) {
                await this.cdp.send("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, ...(type === "keyDown" ? { commands: ["selectAll"] } : {}) });
            }
        }

        await this.cdp.send("Input.insertText", { text });
        this.#afterInput = { node: element.node, kind: "fill" } as RawAction;

        if (submit) {
            await this.press("Enter");
        }
    }

    /** Choose an option of a drop-down list, by its text (or value), as a person picking it would. */
    async select(observed: Observed, element: Element, option: string): Promise<string> {
        const wanted = option.trim().toLowerCase();
        const match =
            element.options?.find((each) => each.label.trim().toLowerCase() === wanted) ??
            element.options?.find((each) => each.value.trim().toLowerCase() === wanted) ??
            element.options?.find((each) => each.label.toLowerCase().includes(wanted));

        if (match === undefined) {
            throw new Error(
                element.options === undefined
                    ? `[${element.index}] ${element.label} is not a drop-down list.`
                    : `[${element.index}] ${element.label} has no option ${quote(option)}: its options are ${element.options.map((each) => quote(each.label)).join(", ")}.`,
            );
        }

        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        await this.#point(element);

        const done = await this.#evaluateAt<boolean>(
            element.node,
            (local) => `((node, value) => {
            const e=window.__piBrowser?.nodes.get(node);
            if (!e || e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===value && !o.disabled)) return false;
            e.value=value;
            e.dispatchEvent(new Event('input',{bubbles:true}));
            e.dispatchEvent(new Event('change',{bubbles:true}));
            return true;
          })(${local}, ${JSON.stringify(match.value)})`,
        );

        if (!done) {
            throw new StalePage(`[${element.index}] ${element.label} changed: read the page again.`);
        }

        this.#afterInput = { node: element.node, kind: "click" } as RawAction;

        return match.label;
    }

    /**
     * Scroll by screens, down or up: a wheel over the middle of the page, or, given a control, over the part in view of
     * what scrolls around it (an open list's own scroll area, PP-116), by its height.
     */
    async scroll(direction: "up" | "down", screens: number, within?: { observed: Observed; element: Element }): Promise<void> {
        let area: { x: number; y: number; h: number } | null;

        if (within === undefined) {
            area = await this.evaluate<{ x: number; y: number; h: number }>("({x: innerWidth/2, y: innerHeight/2, h: innerHeight})");
        } else {
            const { observed, element } = within;

            if (!(await this.#fresh(observed, element.node))) {
                throw new StalePage("The page changed since it was read: read it again.");
            }

            area = await this.#evaluateAt<{ x: number; y: number; h: number } | null>(
                element.node,
                (local) => `((node, down) => {
                const e=window.__piBrowser?.nodes.get(node);
                if (!e?.isConnected) return null;
                for (let s=e; s && s!==document.body && s!==document.documentElement; s=s.parentElement) {
                  const style=getComputedStyle(s);
                  if (!/(auto|scroll|overlay)/.test(style.overflowY) || s.scrollHeight<=s.clientHeight+1) continue;
                  if (down ? s.scrollTop+s.clientHeight>=s.scrollHeight-1 : s.scrollTop<=0) continue;
                  const r=s.getBoundingClientRect(), top=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom);
                  const left=Math.max(0,r.left), right=Math.min(innerWidth,r.right);
                  if (bottom-top<4 || right-left<4) continue;
                  return {x:(left+right)/2, y:(top+bottom)/2, h:s.clientHeight};
                }
                return {x: innerWidth/2, y: innerHeight/2, h: innerHeight};
              })(${local}, ${direction === "down"})`,
            );

            const slot = Math.floor(element.node / FRAME_SPAN);

            // In a frame: its point in the main frame's view, where the wheel goes.
            if (slot !== 0 && area !== null && area !== undefined) {
                const box = await this.#boxOf(slot);

                area = box === null ? null : { x: Math.min(Math.max(box.x + area.x, box.clip.left + 1), box.clip.right - 1), y: Math.min(Math.max(box.y + area.y, box.clip.top + 1), box.clip.bottom - 1), h: area.h };
            }

            if (area === null || area === undefined) {
                throw new StalePage(`[${element.index}] ${element.label} is gone: read the page again.`);
            }
        }

        const delta = Math.round(area.h * 0.85 * screens) * (direction === "down" ? 1 : -1);

        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(area.x), y: Math.round(area.y), deltaX: 0, deltaY: delta });
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    /**
     * Press a key. `follow` (Pi's presses): wait for a navigation it starts. A person's keys from the panel do not wait
     * (they see the page; each key otherwise held the next 300 ms, PP-200), and both events go at once, in order.
     */
    async press(key: string, { follow = true }: { follow?: boolean } = {}): Promise<void> {
        const known = chordOf(key);

        if (known === undefined) {
            throw new Error(
                `Pi's browser presses ${PRESSABLE.join(", ")}, or one character (a list's type-ahead), each with modifiers if needed (Ctrl+A, Ctrl+Enter, Shift+Tab, Meta+K, Alt+ArrowDown); for text, type it.`,
            );
        }

        const before = this.#loads;
        const keys = { key: known.key, code: known.code, windowsVirtualKeyCode: known.keyCode, modifiers: known.modifiers };
        // Select All as a field's own command too, as typing's clearing does: a page's editor takes it so on every system.
        const commands = known.modifiers & 6 && known.code === "KeyA" ? { commands: ["selectAll"] } : {};
        const down = this.cdp.send("Input.dispatchKeyEvent", known.text === undefined ? { type: "rawKeyDown", ...keys, ...commands } : { type: "keyDown", ...keys, text: known.text });

        if (follow) {
            await down;
            await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...keys });
            await this.#followNavigation(before);

            return;
        }

        await Promise.all([down, this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...keys })]);
    }

    /**
     * Select text (PP-376): on the page (the main frame's, then each frame in view), or in a control (a field's own
     * selection, focused; another control's text). Never in a password field or a field the person filled from a card,
     * nor a text that is (part of) what they typed there: whether it is found would tell it. Answers the characters
     * selected and how many the field or text has; the selection's own text is not read back.
     */
    async selectText(observed: Observed, element: Element | undefined, spec: TextSelection): Promise<{ from: number; to: number; length: number; frame?: string }> {
        if (spec.text !== undefined) {
            const text = spec.text.trim();
            const typed = [...this.#typed.keys()];

            if (text === "" || this.hideTyped(text) !== text || (text.length >= MIN_TYPED_HIDDEN && typed.some((value) => value.includes(text)))) {
                throw new Error(text === "" ? "Give the text to select." : "That text is what the person typed on a card: Pi does not look for it.");
            }
        }

        if (element !== undefined) {
            if (element.role === "password" || this.#cardFills.some((fill) => fill.node === element.node)) {
                throw new Error(`[${element.index}] holds what the person typed (a password, or a card's value): Pi does not select in it.`);
            }

            if (!(await this.#fresh(observed, element.node))) {
                throw new StalePage("The page changed since it was read: read it again.");
            }

            const done = await this.#evaluateAt<{ from: number; to: number; length: number } | { error: string }>(element.node, (local) => `${SELECT_TEXT}(${local}, ${JSON.stringify(spec)})`, {
                awaitPromise: true,
                userGesture: true,
            });

            if ("error" in done) {
                throw new Error(`Could not select in [${element.index}] ${element.label}: ${done.error}.`);
            }

            this.#afterInput = { node: element.node, kind: "click" } as RawAction;

            return done;
        }

        const here = await this.evaluate<{ from: number; to: number; length: number } | { error: string }>(`${SELECT_TEXT}(-1, ${JSON.stringify(spec)})`, true);

        if (!("error" in here) || spec.text === undefined) {
            if ("error" in here) {
                throw new Error(`Could not select on the page: ${here.error}.`);
            }

            return here;
        }

        // Not in the page's own text: in the frames in view (their text is in the read too).
        const frames = await this.#childFrames();
        const boxes = await this.#frameBoxes(frames, { w: observed.w, h: observed.h });

        for (const frame of frames) {
            if ((boxes.get(frame.frameId) ?? null) === null) {
                continue;
            }

            const there = await this.#evaluateIn<{ from: number; to: number; length: number } | { error: string }>(frame, `${SELECT_TEXT}(-1, ${JSON.stringify(spec)})`, { awaitPromise: true }).catch(() => null);

            if (there !== null && !("error" in there)) {
                return { ...there, frame: frameName(frame.url) };
            }
        }

        throw new Error(`Could not select on the page: ${here.error}.`);
    }

    /**
     * Whether the focus is in a password field (PP-376: Pi never presses a character into one): in the main frame, inside
     * its open shadow roots, or, when a frame has it, in any of the page's frames (one read as focused when unsure).
     */
    async focusedPassword(): Promise<boolean> {
        const deep = `(() => { let e=document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e=e.shadowRoot.activeElement;
            return {password: !!e && e.tagName==='INPUT' && e.type==='password', frame: !!e && (e.tagName==='IFRAME' || e.tagName==='FRAME')}; })()`;
        const main = await this.evaluate<{ password: boolean; frame: boolean }>(deep);

        if (main.password || !main.frame) {
            return main.password;
        }

        const frames = await this.#childFrames();
        const each = await Promise.all(frames.map((frame) => this.#evaluateIn<{ password: boolean }>(frame, deep).catch(() => ({ password: false }))));

        return each.some((focus) => focus.password);
    }

    /** Back or forward in this tab's history; false when there is nothing that way. */
    async history(step: -1 | 1): Promise<boolean> {
        const history = await this.cdp.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
        const entry = history.entries[history.currentIndex + step];

        if (entry === undefined) {
            return false;
        }

        const before = this.#loads;

        await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        await this.#followNavigation(before);

        return true;
    }

    /** All of the page's text at once (an article, docs, a table), up to `max` characters. */
    async text(max: number): Promise<{ title: string; url: string; text: string; cut: boolean }> {
        const page = await this.evaluate<{ title: string; url: string; text: string }>(`({title: document.title, url: location.href, text: ${TEXT_OF}})`);
        // Each frame's text after the page's, under its site (PP-376); one that goes away meanwhile has none.
        const frames = (await this.#childFrames()).slice(0, MAX_FRAMES);
        const reads = await Promise.all(frames.map((frame) => this.#evaluateIn<{ url: string; text: string }>(frame, `({url: location.href, text: ${TEXT_OF}})`).catch(() => null)));
        const parts = [page.text, ...reads.flatMap((read) => (read === null || read.text.trim() === "" ? [] : [`[In a frame: ${frameName(read.url)}]\n${read.text.trim()}`]))];
        const text = this.hideTyped(parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim());

        return { title: this.hideTyped(page.title), url: this.hideTyped(page.url), text: text.slice(0, max), cut: text.length > max };
    }

    /**
     * What is in view now, as a JPEG or PNG (base64), by DevTools: a Chrome's (`BrowserEngine.picture`); `clip`, a part
     * of the view in CSS pixels. The phone's WebView answers a capture only every other time (PP-114): its pictures come
     * from its display's frames instead.
     */
    /** `beyond`: `clip` is of the page, past the view too (a whole-page picture, PP-376). */
    async screenshot(quality = 70, timeoutMs?: number, { png = false, clip, surface = true, beyond = false }: PictureOptions = {}): Promise<string> {
        // A desktop Chrome from its surface, which alone has the device scale (twice the CSS pixels: sharp text).
        const shot = await this.cdp.send<{ data: string }>(
            "Page.captureScreenshot",
            {
                format: png ? "png" : "jpeg",
                ...(png ? {} : { quality }),
                fromSurface: this.#fromSurface && surface,
                ...(clip === undefined ? {} : { clip: { ...clip, scale: clip.scale ?? 1 } }),
                ...(beyond ? { captureBeyondViewport: true } : {}),
            },
            timeoutMs,
        );

        return shot.data;
    }

    /**
     * Where things are in the view now, in CSS pixels (PP-119): a control by its node, or every place a text shows
     * (in view, case as written). Null for a control that is gone or out of view; an empty list for a text not shown.
     */
    /**
     * `whole` (a whole-page picture, PP-376): anywhere in the page's first `height` CSS pixels, in the page's own
     * coordinates (from its top left), not only in view.
     */
    async areasOf(targets: ({ node: number } | { text: string })[], whole?: { height: number }): Promise<({ x: number; y: number; width: number; height: number }[] | null)[]> {
        type Area = { x: number; y: number; width: number; height: number };
        const found = await this.evaluate<(Area[] | null)[]>(areasScript(targets.map((target) => ("node" in target && target.node >= FRAME_SPAN ? { node: -1 } : target)), whole?.height));
        const slots = new Set(targets.flatMap((target) => ("node" in target && target.node >= FRAME_SPAN ? [Math.floor(target.node / FRAME_SPAN)] : [])));
        const texts = targets.some((target) => "text" in target);

        if (slots.size === 0 && !texts) {
            return found;
        }

        // In the frames in view too (PP-376): a control there, and every place a text shows, within the frame's part in view
        // (in the page's first `whole.height` pixels, for a whole page: placed in the page's coordinates).
        const frames = await this.#childFrames();
        const view = await this.evaluate<{ w: number; h: number; y: number }>("({w: innerWidth, h: innerHeight, y: scrollY})");
        const boxes = await this.#frameBoxes(frames, whole === undefined ? view : { ...view, top: -view.y, bottom: whole.height - view.y });
        const down = whole === undefined ? 0 : view.y;

        for (const frame of frames) {
            const box = boxes.get(frame.frameId) ?? null;
            const slot = this.#slotOf(frame.frameId);

            if (box === null || (!texts && !slots.has(slot))) {
                continue;
            }

            const there = await this.#evaluateIn<(Area[] | null)[]>(
                frame,
                areasScript(targets.map((target) => ("node" in target ? (Math.floor(target.node / FRAME_SPAN) === slot ? { node: target.node % FRAME_SPAN } : { node: -1 }) : target))),
            ).catch(() => null);

            targets.forEach((target, index) => {
                const areas = there?.[index];

                if (areas === null || areas === undefined) {
                    return;
                }

                const shown = areas.flatMap((area) => {
                    const left = Math.max(box.clip.left, box.x + area.x);
                    const top = Math.max(box.clip.top, box.y + area.y);
                    const right = Math.min(box.clip.right, box.x + area.x + area.width);
                    const bottom = Math.min(box.clip.bottom, box.y + area.y + area.height);

                    return right - left > 0 && bottom - top > 0 ? [{ x: left, y: top + down, width: right - left, height: bottom - top }] : [];
                });

                if ("node" in target) {
                    found[index] = shown.length > 0 ? shown : null;
                } else {
                    found[index] = [...(found[index] ?? []), ...shown].slice(0, 50);
                }
            });
        }

        return found;
    }

    /**
     * The part of the view to picture for a control (PP-118): the dialog, menu or list it is in, or else the control,
     * scrolled into view, with a little room around it, within the window (CSS pixels).
     */
    async area(observed: Observed, element: Element): Promise<{ clip: PictureClip; whole: string }> {
        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        let found = await this.#evaluateAt<{ x: number; y: number; width: number; height: number; whole: string } | null>(
            element.node,
            (local) => `(async node => {
            const c=window.__piBrowser?.nodes.get(node);
            if (!c?.isConnected) return null;
            const e=c.closest('dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]') || c;
            const r0=e.getBoundingClientRect();
            if (r0.top<0 || r0.left<0 || r0.bottom>innerHeight || r0.right>innerWidth) {
              e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
              await new Promise(done=>{ requestAnimationFrame(()=>requestAnimationFrame(done)); setTimeout(done,150); });
            }
            const r=e.getBoundingClientRect(), pad=8;
            const x=Math.max(0,r.left-pad), y=Math.max(0,r.top-pad);
            const width=Math.min(innerWidth,r.right+pad)-x, height=Math.min(innerHeight,r.bottom+pad)-y;
            if (width<4 || height<4) return null;
            const role=e===c ? 'control' : (e.getAttribute('role') || e.tagName.toLowerCase());
            return {x:Math.floor(x),y:Math.floor(y),width:Math.ceil(width),height:Math.ceil(height),whole:role};
          })(${local})`,
            { awaitPromise: true },
        );
        const slot = Math.floor(element.node / FRAME_SPAN);

        // In a frame (PP-376): placed in the main frame's view, within the frame's part in view.
        if (slot !== 0 && found !== null && found !== undefined) {
            const box = await this.#boxOf(slot);

            if (box === null) {
                found = null;
            } else {
                const x = Math.max(box.clip.left, box.x + found.x);
                const y = Math.max(box.clip.top, box.y + found.y);
                const width = Math.min(box.clip.right, box.x + found.x + found.width) - x;
                const height = Math.min(box.clip.bottom, box.y + found.y + found.height) - y;

                found = width < 4 || height < 4 ? null : { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(width), height: Math.ceil(height), whole: found.whole };
            }
        }

        if (found === null || found === undefined) {
            throw new StalePage(`[${element.index}] ${element.label} is gone or not in view: read the page again.`);
        }

        const { whole, ...clip } = found;

        return { clip, whole };
    }

    /** Wait until the text shows (up to 30 s), or for some seconds (up to 10); true when the text showed. */
    async wait({ text, seconds }: { text?: string; seconds?: number }): Promise<boolean> {
        if (text !== undefined && text !== "") {
            const until = Date.now() + 30_000;

            const has = `(${TEXT_OF}).toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;

            while (Date.now() < until) {
                // The page's text, then its frames' (PP-376).
                if (await this.evaluate<boolean>(has).catch(() => false)) {
                    return true;
                }

                const frames = (await this.#childFrames().catch(() => [])).slice(0, MAX_FRAMES);

                if ((await Promise.all(frames.map((frame) => this.#evaluateIn<boolean>(frame, has).catch(() => false)))).includes(true)) {
                    return true;
                }

                await new Promise((resolve) => setTimeout(resolve, 250));
            }

            return false;
        }

        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(0, seconds ?? 1)) * 1000));

        return true;
    }
}
