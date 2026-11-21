/**
 * A measured layout check for screenshots (PP-10; the owner, 2026-10-20: "how can you make sure you don't miss that when
 * you verify?"). The renderer runs `LAYOUT_CHECK` in the page just before it draws it, and Pi gets numbers with the
 * picture: elements whose content spills out of their own box, elements that stick out of their parent's, and a page
 * that is wider than its viewport. A picture can mislead; sizes do not.
 *
 * Since PP-395 it also measures what makes a page look unfinished (the rules a script can measure, PP-394): text cut by
 * a box that hides its overflow, an element covering another's text or control, tap targets under 40 px at a phone's
 * width, sizes off the 4 px grid or not whole pixels, text under WCAG AA contrast against its background (over a linear
 * or radial gradient, measured where the words sit, PP-414), text under 12 px, emoji and symbol glyphs used as icons, gradient text, uppercase labels, tight tracking on small text, long
 * lines, and how many font sizes, text colours, font families and icon sizes the page uses. Findings come grouped (the
 * same kind of element with the same numbers once, with a count) so the report stays short. Pi's browser runs the same
 * check (`browser_screenshot`, `browser_layout_check`).
 *
 * Since PP-415 it also finds nine tells of a page assembled rather than designed: broken images, skipped heading levels,
 * cards inside cards, side-tab accent stripes, glowing shadows, pulsing dots, justified text in a narrow column, tight
 * line height on body text, and the same words repeated in one card. These rules are adapted from Impeccable's
 * detector (https://github.com/pbakaus/impeccable, commit c8891a9ae865d6ee311836ae5199bfce0fe115b1, Copyright Paul
 * Bakaus, licensed under the Apache License 2.0; see third_party/impeccable/LICENSE and README.md): reimplemented here
 * in a page script with fewer exceptions, their thresholds kept where they apply.
 *
 * Since PP-430 it also takes the rules auton-ui proved on its fixtures (the owner's Auton UI library, from jakubkrehel/skills'
 * better-ui and better-typography, MIT, and heydamir/unslop's signs, CC BY 4.0; see third_party/jakubkrehel-skills/):
 * nested surfaces whose corners are not concentric, numbers people compare without tabular figures, gradient surfaces,
 * side stripes drawn as a vertical inset shadow or a ::before/::after bar, and the static CSS tells a computed style
 * can show (transition: all, line height 1 on wrapping text, a field under 16 px on a phone, a scrolling dialog that
 * chains its scroll to the page, a viewport that blocks zoom, font-feature-settings "tnum"). A pulsing dot is one whose
 * keyframes change its opacity or scale, never a spinner (PP-425). Since PP-432, a child's corner that pokes out of a
 * rounded parent that does not clip it (a progress fill in a rounded bar).
 *
 * Since PP-501, a box of display: contents (which has none) is passed over for the nearest ancestor with a box, and an
 * open modal dialog is measured alone, as the page behind it cannot be reached; the report names it (`modal`). A modal
 * is a <dialog> opened with showModal(), a dialog marked aria-modal, or a dialog whose page around it is shut: the
 * other children of body hidden (aria-hidden, as react-aria does) or inert (Headless UI), the page out of a pointer's
 * reach while the dialog is not (Radix sets pointer-events: none on body), or the points around the dialog covered by
 * an overlay with no words and no control. Since PP-433, under text zoom (Android's font scale in a WebView) control heights are measured on the grid as at 100 %.
 * Since PP-406, a layer laid over a box to make it one tap target is measured with that box's lines, and a control as
 * tall as its one picture at the picture's own shape (a lone thumbnail) is not measured on the grid: its height is the
 * picture's. Since PP-537, a height CSS sets (a height, a min-height that holds the box, a max-height that caps it) has
 * no lines' part to take back, and nested corners are checked for concentric radii only when the inset is under the
 * outer radius (further in, the inner corner lies outside the outer curve).
 *
 * Since PP-519, a target in a sentence is WCAG 2.5.8's inline exception: a link, button or chip laid out inline whose
 * line holds words that are not its own is no tap target under 40 px. A chip drawn as a box there (inline-flex or
 * inline-block) under 24 px tall with no hit area of its own laid past it is its own kind, `inline-target`.
 *
 * Since PP-520, what a zoomed canvas draws (React Flow's viewport, scaled by a CSS transform) is measured at its own
 * scale: control heights and icons divided by the zoom, a finding that remains saying "at zoom 0.7"; a tap target as
 * drawn, its hit area at the zoom too; and what is drawn on a canvas is not a card inside the card that frames it.
 *
 * Since PP-521, a render finishes the animations still running after its wait before the page measures itself
 * (`FINISH_ANIMATIONS`), and words at opacity 0 in flow and in view are a finding (`hidden`): an entrance an observer
 * or a script never started leaves its content out of the picture, which a page drawn off screen showed.
 *
 * Since PP-536, a tabindex makes a control only with no role or a widget role, and with no role only up to 200 px tall:
 * a focusable tabpanel, region or scrolling box is no control, so its height is no control height off the grid. Gradient
 * text that shimmers (an endless animation of its background's position, auton-ui's "Thinking…") or sits under
 * [aria-busy=true], [role=status] or [data-allow-gradient] is a running state, not a gradient-text finding.
 */

/** One thing out of place: what it is, and the boxes that show it (x and width, CSS pixels). */
export type LayoutIssue = {
    kind: "spills" | "outside-parent" | "page-wider";
    what: string;
    box: [number, number];
    limit: [number, number];
};

/** A finding of the PP-395 checks: the same kind of element with the same numbers is one, `count` times. */
export type LayoutFind =
    | { kind: "cut"; what: string; axis: "x" | "y"; shown: number; full: number; ellipsis: boolean; count: number }
    | { kind: "covered"; what: string; by: string; points: number; of: number; count: number }
    | { kind: "small-target"; what: string; size: [number, number]; count: number }
    | { kind: "inline-target"; what: string; size: [number, number]; count: number }
    | { kind: "off-grid"; what: string; property: string; value: number; zoom?: number; count: number }
    | { kind: "contrast"; what: string; color: string; background: string; ratio: number; needs: number; gradient?: string; count: number }
    | { kind: "small-text"; what: string; size: number; count: number }
    | { kind: "emoji"; what: string; glyphs: string; count: number }
    | { kind: "gradient-text"; what: string; count: number }
    | { kind: "uppercase"; what: string; transform: string; tracking: number; count: number }
    | { kind: "tight-tracking"; what: string; size: number; tracking: number; count: number }
    | { kind: "long-lines"; what: string; chars: number; count: number }
    // PP-415, adapted from Impeccable's detector (third_party/impeccable/README.md).
    | { kind: "broken-image"; what: string; src: string; count: number }
    | { kind: "skipped-heading"; what: string; from: number; to: number; count: number }
    | { kind: "nested-cards"; what: string; in: string; count: number }
    | { kind: "side-tab"; what: string; side: "left" | "right" | "top" | "bottom"; width: number; how: "border" | "inset shadow" | "::before" | "::after"; count: number }
    | { kind: "glow"; what: string; property: string; color: string; blur: number; count: number }
    | { kind: "pulsing-dot"; what: string; size: number; animation: string; count: number }
    | { kind: "justified"; what: string; chars: number; count: number }
    | { kind: "tight-leading"; what: string; size: number; ratio: number; count: number }
    | { kind: "repeated-text"; what: string; text: string; times: number; count: number }
    // PP-430, from auton-ui's doctor (third_party/jakubkrehel-skills/README.md).
    | { kind: "concentric"; what: string; in: string; inner: number; gap: number; border: number; outer: number; want: number; count: number }
    | { kind: "corner-bleed"; what: string; in: string; inner: number; outer: number; count: number }
    | { kind: "tabular"; what: string; text: string; count: number }
    | { kind: "gradient"; what: string; area: number; image: string; count: number }
    | { kind: "css-tell"; what: string; rule: string; count: number }
    // PP-521: words at opacity 0 at the picture.
    | { kind: "hidden"; what: string; opacity: number; animation?: string; count: number };

export type LayoutFindKind = LayoutFind["kind"];

/** What the page's visible text and icons use, for the summary line. */
export type LayoutSummary = { fontSizes: number[]; colors: string[]; families: string[]; icons: string[]; strokes: string[] };

export type LayoutReport = {
    width: number;
    height: number;
    checked: number;
    issues: LayoutIssue[];
    more: number;
    /** At most `FINDS_KEPT` of each kind, the most frequent first. */
    found: LayoutFind[];
    /** Elements found of each kind, all of them (`found` keeps the first groups only). */
    totals: Partial<Record<LayoutFindKind, number>>;
    summary: LayoutSummary;
    /**
     * The box the page scrolls in (an app shell's main area, PP-440), when it still hides content below: the picture
     * shows `shown` of its `full` CSS pixels.
     */
    scroller?: { what: string; shown: number; full: number };
    /** The page's uncaught errors, as a file page keeps them (`file-pages.ts`'s `PAGE_SHIM`, PP-440). */
    errors?: string[];
    /**
     * HTML-in-Canvas the page uses and the renderer lacks (PP-454): what showed it (`canvas[layoutsubtree]`,
     * `canvas[content=drawable]`, or `a call to drawElementImage`: the error a call threw, kept by a file page; a page that
     * only feature-detects it is not one, PP-459), and the renderer's Chrome version.
     */
    canvas?: { uses: string; chrome: string };
    /** A password field shows (PP-500): a sign-in screen, maybe, which a render without the site's sign-in gets. */
    password?: boolean;
    /** An open modal dialog, by name (PP-501): only it was measured, as the page behind it cannot be reached. */
    modal?: string;
    /**
     * The page's text zoom when it is not 1 (PP-433): Android's font scale in a WebView (1.08 at 108 %). Control heights
     * are then measured on the grid as at 100 %.
     */
    textZoom?: number;
    /**
     * Animations still running when the page was measured, after the render's wait, that `FINISH_ANIMATIONS` finished
     * first (PP-521): the picture shows where they end.
     */
    finished?: number;
};

/**
 * Run by a render before its page's script (PP-521, `screenshots.ts` `renderRequest`): finish the page's finite
 * animations still running after the render's wait (CSS animations and transitions, and the Web Animations scripts
 * start, a stagger's delays too), so the picture and the measure show where they end, not a frame half faded. A page
 * drawn off screen may run no animation clock (measured 2026-11-20: a rail's cards at 0.7 and 0 opacity after 2 s).
 * Endless ones (a spinner, a pulse), paused ones and scroll-driven ones are left as they are. Keeps the count in
 * `window.__piFinished`, which the layout check reports (`finished`). Never run on a live tab (browser_layout_check):
 * finishing changes the page.
 */
export const FINISH_ANIMATIONS = String.raw`window.__piFinished = document.getAnimations().filter((a) => {
  if (a.timeline !== document.timeline || a.playState !== 'running' || a.playbackRate === 0 || !a.effect) return false;
  return Number.isFinite(a.effect.getComputedTiming().endTime);
}).map((a) => a.finish()).length;`;

/** An expression: whether a password field shows on the page (PP-500), for the layout check and the redlines' measure. */
export const PASSWORD_SHOWN =
    "[...document.querySelectorAll('input[type=password]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })";

/** Groups the page keeps of each kind; the words show fewer (`SHOWN`). */
const FINDS_KEPT = 20;
/** Groups shown in words, of each kind. */
const SHOWN = 3;
/** The narrowest tap target at a phone's width, and the widest screen that is a phone's. */
export const TAP_MIN = 40;
export const PHONE_MAX = 480;
/** WCAG 2.5.8's minimum, for a chip in a sentence with no hit area (PP-519). */
export const INLINE_MIN = 24;
/** The smallest text, in CSS pixels. */
export const TEXT_MIN = 12;

/**
 * The script for a page laid out `width` CSS pixels wide (the width asked for: a mobile page wider than its screen
 * stretches `innerWidth` to fit; the renderer's WebView is exactly as wide as asked, so it leaves it out, and whether
 * the page is a phone's then goes by the root's `clientWidth`, which does not stretch, PP-414), as one
 * expression that returns the report as JSON text. Elements inside a box that scrolls or clips sideways may run wider
 * (a code block's long lines): only that box is checked. Fixed and absolutely placed elements (menus, toasts) are left
 * out of "outside its parent".
 *
 * The PP-395 checks look at what shows: elements hidden, transparent, or wholly clipped away by a box that hides its
 * overflow (a closed panel, a drawer off screen) are left out. Overlaps are measured where the page is in view
 * (`elementFromPoint`); a layer over the page (a dialog, a menu, a sheet over half the view) and a bar that content
 * scrolls under are not overlaps.
 */
/**
 * What the page scripts share (the layout check, PP-395; the redlines, PP-398), in a script that defined `W` (the width
 * the page is laid out at), `VW` and `VH`: element names, computed styles, opacity, the region an element's content
 * shows in (its ancestors' boxes that hide overflow), whether an element shows, colours as Chrome writes them, the
 * background behind an element, what a control is, and the open modal dialogs (`modals()`, PP-501).
 */
export const PAGE_HELPERS = String.raw`
  const trim = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; };
  const classes = (e) => (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('');
  const sig = (e) => e.tagName.toLowerCase() + classes(e);
  const name = (e) => {
    const text = trim(e.textContent, 30);
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + classes(e) + (text ? ' "' + text + '"' : '');
  };
  const styles = new Map();
  const css = (e) => { let s = styles.get(e); if (!s) { s = getComputedStyle(e); styles.set(e, s); } return s; };
  const r1 = (n) => Math.round(n * 10) / 10;
  const r2 = (n) => Math.round(n * 100) / 100;
  const opacities = new Map();
  const opacityOf = (e) => {
    if (!e || e.nodeType !== 1) return 1;
    let v = opacities.get(e);
    if (v === undefined) { v = Number(css(e).opacity) * opacityOf(e.parentElement); opacities.set(e, v); }
    return v;
  };
  const ALL = { l: -1e9, t: -1e9, r: 1e9, b: 1e9 };
  const meet = (a, b) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const empty = (a) => a.r - a.l < 1 || a.b - a.t < 1;
  // A box of display: contents has none (0 x 0): its overflow hides nothing, and its children are laid out in its
  // parent's box (PP-501).
  const clips = (e) => { const s = css(e); return s.display !== 'contents' && (s.overflowX !== 'visible' || s.overflowY !== 'visible'); };
  const padBox = (e) => {
    const r = e.getBoundingClientRect(), s = css(e);
    return { l: r.left + parseFloat(s.borderLeftWidth), t: r.top + parseFloat(s.borderTopWidth), r: r.right - parseFloat(s.borderRightWidth), b: r.bottom - parseFloat(s.borderBottomWidth) };
  };
  // Where an element's content shows: its ancestors' boxes that hide overflow, and its own.
  const regions = new Map();
  const inside = (e) => {
    if (!e || e.nodeType !== 1 || e === document.documentElement) return ALL;
    let v = regions.get(e);
    if (v === undefined) {
      const from = css(e).position === 'fixed' ? ALL : inside(e.parentElement);
      v = clips(e) && e !== document.body ? meet(from, padBox(e)) : from;
      regions.set(e, v);
    }
    return v;
  };
  // The box an absolutely placed ::before or ::after is laid out in: its element's padding box when the element is
  // positioned (or transformed), else its nearest positioned ancestor's; none when nothing is (it would cover the page).
  const placedIn = (e) => {
    for (let a = e; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const s = css(a);
      if (s.position !== 'static' || s.transform !== 'none') return a;
    }
    return null;
  };
  // The scale an element is drawn at (PP-520): its own transform's and its ancestors', multiplied (React Flow's viewport,
  // transform matrix(0.7, 0, 0, 0.7, x, y), draws its nodes at 0.7), along x, from the computed transform matrix and
  // the scale property. Its rect is drawn at that scale; its computed lengths are not.
  const ownScale = (s) => {
    const m = /^matrix(3d)?\(([^)]*)\)$/.exec(s.transform);
    const v = m ? m[2].split(',').map(Number) : null;
    return (v ? Math.hypot(v[0], v[1]) : 1) * (s.scale && s.scale !== 'none' ? parseFloat(s.scale) : 1);
  };
  const scales = new Map();
  const scaleOf = (e) => {
    if (!e || e.nodeType !== 1) return 1;
    let v = scales.get(e);
    if (v === undefined) { v = scaleOf(e.parentElement) * ownScale(css(e)); scales.set(e, v); }
    return v;
  };
  // A ::before or ::after that takes taps: shown, absolutely placed, its insets given.
  const tapLayers = (e) => ['::before', '::after'].map((which) => getComputedStyle(e, which)).filter((s) => s.content !== 'none' && s.content !== 'normal' && s.display !== 'none' && s.pointerEvents !== 'none' && s.position === 'absolute' && ![s.left, s.top, s.right, s.bottom].map(parseFloat).some(Number.isNaN));
  // A stretched link (PP-436): a control whose ::before or ::after is absolute with all four insets 0 over the box it
  // is placed in (its card), so the whole card is its target. Gives that box, or null. Read from the computed style,
  // never from a class name.
  const stretchedOver = (e) => {
    if (css(e).pointerEvents === 'none') return null;
    const block = placedIn(e);
    return block && block !== e && tapLayers(e).some((s) => [s.left, s.top, s.right, s.bottom].every((v) => Math.abs(parseFloat(v)) < 0.5)) ? block : null;
  };
  // Where a tap lands on a control: its box, and a ::before or ::after laid over it and past its edges (a hit area
  // that keeps a small control's look), absolutely placed with its insets given, in the box it is placed in (a
  // stretched link's covers its card, PP-436); a field's label, which focuses it.
  const hitBox = (e, r) => {
    let l = r.left, t = r.top, rr = r.right, b = r.bottom;
    const label = /^(input|textarea|select)$/i.test(e.tagName) ? e.closest('label') : null;
    if (label) {
      const q = label.getBoundingClientRect();
      l = Math.min(l, q.left); t = Math.min(t, q.top); rr = Math.max(rr, q.right); b = Math.max(b, q.bottom);
    }
    const block = css(e).pointerEvents !== 'none' ? placedIn(e) : null;
    if (block) {
      // Its insets are drawn at the scale of the box it is placed in (PP-520: a pin in a zoomed canvas).
      const pb = padBox(block), k = scaleOf(block);
      for (const s of tapLayers(e)) {
        const [L, T, R, B] = [s.left, s.top, s.right, s.bottom].map((v) => parseFloat(v) * k);
        const q = { l: pb.l + L, t: pb.t + T, r: pb.r - R, b: pb.b - B };
        // Placed in an ancestor, a layer counts when it lies over the control (a stretched link's), not when it sits
        // elsewhere in that box (a badge).
        if (block !== e && (q.l > r.left + 1 || q.t > r.top + 1 || q.r < r.right - 1 || q.b < r.bottom - 1)) continue;
        l = Math.min(l, q.l); t = Math.min(t, q.t); rr = Math.max(rr, q.r); b = Math.max(b, q.b);
      }
    }
    return { width: rr - l, height: b - t };
  };
  const docW = Math.max(W, document.documentElement.scrollWidth);
  // Visually hidden (PP-436): content kept for screen readers off the picture (a chart's data table), by the element or
  // an ancestor: a box of 1 x 1 px or less that hides its overflow, a clip of no area, a clip-path inset that meets
  // itself, opacity 0; or visibility hidden on the element (computed: it inherits, and a child set visible shows). Its
  // own box keeps its size (a cell in a 1 px box measures 56 x 20), so the ancestors tell.
  const insetMeets = (v, r) => {
    const m = /^inset\(([^)]*)\)/.exec(v || '');
    if (!m) return false;
    const n = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
    const [t, rr, b, l] = n.length === 1 ? [n[0], n[0], n[0], n[0]] : n.length === 2 ? [n[0], n[1], n[0], n[1]] : n.length === 3 ? [n[0], n[1], n[2], n[1]] : n;
    const len = (x, size) => x.endsWith('%') ? parseFloat(x) / 100 * size : px(x);
    return len(t, r.height) + len(b, r.height) >= r.height || len(l, r.width) + len(rr, r.width) >= r.width;
  };
  const clipless = (s) => {
    const m = /^rect\(([^)]*)\)$/.exec(s.clip || '');
    if (!m || !/absolute|fixed/.test(s.position)) return false;
    const [t, rr, b, l] = m[1].split(/[\s,]+/).filter(Boolean).map((x, i) => x === 'auto' ? (i === 1 || i === 2 ? Infinity : -Infinity) : px(x));
    return rr - l <= 0 || b - t <= 0;
  };
  const concealments = new Map();
  const concealedBox = (e) => {
    if (!e || e.nodeType !== 1 || e === document.documentElement) return false;
    let v = concealments.get(e);
    if (v === undefined) {
      const s = css(e), r = e.getBoundingClientRect();
      v = (r.width <= 1 && r.height <= 1 && s.display !== 'contents' && /hidden|clip/.test(s.overflowX + ' ' + s.overflowY)) || clipless(s) || insetMeets(s.clipPath, r) || Number(s.opacity) === 0 || concealedBox(e.parentElement);
      concealments.set(e, v);
    }
    return v;
  };
  const concealed = (e) => css(e).visibility === 'hidden' || css(e).visibility === 'collapse' || concealedBox(e);
  const shows = (e, r) => {
    const s = css(e);
    if (s.visibility === 'hidden' || s.visibility === 'collapse' || opacityOf(e) < 0.05 || concealedBox(e)) return false;
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= docW) return false;
    return !empty(meet(inside(e.parentElement), { l: r.left, t: r.top, r: r.right, b: r.bottom }));
  };
  // Colours: rgb(), color(srgb), oklab() and oklch() as Chrome writes them; anything else is not measured.
  const lin = (c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  const fromOklab = (L, a, b) => {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3), m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3), s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((c) => Math.max(0, Math.min(255, lin(c) * 255)));
  };
  const colour = (v) => {
    const n = (x, scale) => x.endsWith('%') ? parseFloat(x) / 100 * scale : parseFloat(x);
    const alpha = (x) => x === undefined ? 1 : n(x, 1);
    let m = /^rgba?\(([^)]*)\)$/.exec(v);
    if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean); return [n(p[0], 255), n(p[1], 255), n(p[2], 255), alpha(p[3])]; }
    m = /^color\(srgb ([^)]*)\)$/.exec(v);
    if (m) { const p = m[1].split(/[\s\/]+/).filter(Boolean); return [n(p[0], 1) * 255, n(p[1], 1) * 255, n(p[2], 1) * 255, alpha(p[3])]; }
    m = /^oklab\(([^)]*)\)$/.exec(v);
    if (m) { const p = m[1].split(/[\s\/]+/).filter(Boolean); return fromOklab(n(p[0], 1), n(p[1], 0.4), n(p[2], 0.4)).concat([alpha(p[3])]); }
    m = /^oklch\(([^)]*)\)$/.exec(v);
    if (m) { const p = m[1].split(/[\s\/]+/).filter(Boolean), c = n(p[1], 0.4), h = parseFloat(p[2]) * Math.PI / 180; return fromOklab(n(p[0], 1), c * Math.cos(h), c * Math.sin(h)).concat([alpha(p[3])]); }
    return null;
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat([1]);
  const hex = (c) => '#' + c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  // The background behind an element's text when it is the same everywhere: its ancestors' colours, composited; a
  // picture or gradient on the way gives null here (backAt measures a gradient at a point).
  const backgrounds = new Map();
  const backdrop = (e) => {
    if (!e || e.nodeType !== 1) return [255, 255, 255, 1];
    let v = backgrounds.get(e);
    if (v === undefined) {
      const s = css(e);
      if (s.backgroundImage !== 'none') v = null;
      else {
        const c = colour(s.backgroundColor);
        if (c === null) v = null;
        else if (c[3] >= 0.999) v = c;
        else { const under = backdrop(e.parentElement); v = under === null ? null : c[3] <= 0.001 ? under : over(c, under); }
      }
      backgrounds.set(e, v);
    }
    return v;
  };
  // Gradients (PP-414): what a linear or radial gradient paints at a point, from its computed style, over the box its
  // background-origin names at that box's size (no background-size). A picture (url), a repeating or conic gradient, a
  // colour hint, a calc() stop, a fixed background or a background-size is not measured (null), never guessed.
  const splitTop = (v) => {
    const out = [];
    let depth = 0, from = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] === '(') depth++;
      else if (v[i] === ')') depth--;
      else if (v[i] === ',' && depth === 0) { out.push(v.slice(from, i).trim()); from = i + 1; }
    }
    out.push(v.slice(from).trim());
    return out;
  };
  // Colour stops along the gradient line (0 to 1), positions filled in as CSS does.
  const stopsOf = (parts, length) => {
    const stops = [];
    for (const part of parts) {
      const m = /^([a-z]+\([^()]*\))((?:\s+-?[\d.]+(?:%|px))*)$/i.exec(part);
      const c = m ? colour(m[1]) : null;
      if (!c) return null;
      const at = m[2].trim() ? m[2].trim().split(/\s+/).map((x) => x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x) / length) : [null];
      for (const t of at) stops.push({ c, t });
    }
    if (stops.length < 2) return null;
    if (stops[0].t === null) stops[0].t = 0;
    if (stops[stops.length - 1].t === null) stops[stops.length - 1].t = 1;
    let most = stops[0].t;
    for (const s of stops) if (s.t !== null) { s.t = Math.max(s.t, most); most = s.t; }
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].t !== null) continue;
      let j = i;
      while (stops[j].t === null) j++;
      for (let k = i; k < j; k++) stops[k].t = stops[i - 1].t + (stops[j].t - stops[i - 1].t) * (k - i + 1) / (j - i + 1);
      i = j;
    }
    return stops;
  };
  // The colour at t, mixed with premultiplied alpha as browsers do.
  const stopAt = (stops, t) => {
    if (t <= stops[0].t) return stops[0].c;
    for (let i = 1; i < stops.length; i++) {
      if (t > stops[i].t) continue;
      const a = stops[i - 1].c, b = stops[i].c, d = stops[i].t - stops[i - 1].t, f = d < 1e-9 ? 1 : (t - stops[i - 1].t) / d;
      const alpha = a[3] + (b[3] - a[3]) * f;
      return alpha <= 0.0001 ? [0, 0, 0, 0] : [0, 1, 2].map((k) => (a[k] * a[3] + (b[k] * b[3] - a[k] * a[3]) * f) / alpha).concat([alpha]);
    }
    return stops[stops.length - 1].c;
  };
  const SIDES = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  // One gradient layer's colour at (x, y), painted on box {l, t, r, b}.
  const layerAt = (v, box, x, y) => {
    const m = /^(linear|radial)-gradient\((.*)\)$/.exec(v);
    const w = box.r - box.l, h = box.b - box.t;
    if (!m || w < 1 || h < 1) return null;
    const parts = splitTop(m[2]);
    const lead = /^[a-z]+\(/i.test(parts[0]) ? null : parts.shift();
    if (m[1] === 'linear') {
      let dx = 0, dy = 1;
      const angle = lead && /^(-?[\d.]+)(deg|turn|rad|grad)$/.exec(lead);
      if (angle) {
        const n = parseFloat(angle[1]), deg = angle[2] === 'deg' ? n : angle[2] === 'turn' ? n * 360 : angle[2] === 'rad' ? n * 180 / Math.PI : n * 0.9;
        dx = Math.sin(deg * Math.PI / 180); dy = -Math.cos(deg * Math.PI / 180);
      } else if (lead && /^to( (left|right|top|bottom)){1,2}$/.test(lead)) {
        const sx = /right/.test(lead) ? 1 : /left/.test(lead) ? -1 : 0, sy = /bottom/.test(lead) ? 1 : /top/.test(lead) ? -1 : 0;
        // To a corner: perpendicular to the line between the two corners next to it.
        if (sx && sy) { dx = sx * h; dy = sy * w; } else { dx = sx; dy = sy; }
        const n = Math.hypot(dx, dy);
        dx /= n; dy /= n;
      } else if (lead) return null;
      const length = Math.abs(w * dx) + Math.abs(h * dy);
      const stops = stopsOf(parts, length);
      return stops && stopAt(stops, ((x - (box.l + box.r) / 2) * dx + (y - (box.t + box.b) / 2) * dy) / length + 0.5);
    }
    // Radial: [circle | ellipse] [size] [at x y].
    const [shapeSize, place] = lead === null ? ['', ''] : (' ' + lead).split(/ at /).map((s) => s.trim());
    const words = shapeSize ? shapeSize.split(/\s+/) : [];
    const where = place ? place.split(/\s+/) : [];
    if (where.length > 2 || (lead !== null && (' ' + lead).split(/ at /).length > 2)) return null;
    if (where.length === 2 && /^(top|bottom)$/.test(where[0])) where.reverse();
    if (where.length === 1 && /^(top|bottom)$/.test(where[0])) where.unshift('center');
    const pos = (token, size) => token === undefined ? size / 2 : token in SIDES ? SIDES[token] * size : /^-?[\d.]+%$/.test(token) ? parseFloat(token) / 100 * size : /^-?[\d.]+px$/.test(token) ? parseFloat(token) : NaN;
    const cx = pos(where[0], w), cy = pos(where[1], h);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    const lengths = words.filter((s) => /^[\d.]+(px|%)$/.test(s));
    const circle = words.includes('circle') || (!words.includes('ellipse') && lengths.length === 1);
    const keyword = words.find((s) => /^(closest|farthest)-(side|corner)$/.test(s)) || 'farthest-corner';
    if (words.some((s) => !/^(circle|ellipse|(closest|farthest)-(side|corner)|[\d.]+(px|%))$/.test(s))) return null;
    const near = [Math.min(cx, w - cx), Math.min(cy, h - cy)], far = [Math.max(cx, w - cx), Math.max(cy, h - cy)];
    let rx, ry;
    if (lengths.length > 0) {
      rx = /%$/.test(lengths[0]) ? parseFloat(lengths[0]) / 100 * w : parseFloat(lengths[0]);
      ry = circle ? rx : lengths[1] === undefined ? NaN : /%$/.test(lengths[1]) ? parseFloat(lengths[1]) / 100 * h : parseFloat(lengths[1]);
    } else {
      const sides = keyword.startsWith('closest') ? near : far;
      if (circle) rx = ry = keyword.endsWith('side') ? (keyword.startsWith('closest') ? Math.min(...sides) : Math.max(...sides)) : Math.hypot(sides[0], sides[1]);
      else { const k = keyword.endsWith('corner') ? Math.SQRT2 : 1; rx = sides[0] * k; ry = sides[1] * k; }
    }
    if (!(rx > 0) || !(ry > 0)) return null;
    const stops = stopsOf(parts, rx);
    return stops && stopAt(stops, Math.hypot((x - box.l - cx) / rx, (y - box.t - cy) / ry));
  };
  // Two colours with alpha, one over the other.
  const mix = (top, under) => {
    const a = top[3] + under[3] * (1 - top[3]);
    return a <= 0.0001 ? [0, 0, 0, 0] : [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat([a]);
  };
  // What an element's background images paint at (x, y), bottom layer first; null when one is not measured.
  const paintAt = (e, s, x, y) => {
    if (/url\(|repeating-|conic-|image-set|cross-fade|element\(|paint\(/.test(s.backgroundImage) || /fixed/.test(s.backgroundAttachment) || !/^auto( auto)?(, auto( auto)?)*$/.test(s.backgroundSize)) return null;
    const r = e.getBoundingClientRect(), origin = s.backgroundOrigin.split(',')[0].trim();
    const border = origin === 'border-box' ? [0, 0, 0, 0] : [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(px);
    const pad = origin === 'content-box' ? [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(px) : [0, 0, 0, 0];
    const box = { l: r.left + border[3] + pad[3], t: r.top + border[0] + pad[0], r: r.right - border[1] - pad[1], b: r.bottom - border[2] - pad[2] };
    let paint = [0, 0, 0, 0];
    for (const layer of splitTop(s.backgroundImage).reverse()) {
      const c = layerAt(layer, box, x, y);
      if (c === null) return null;
      paint = mix(c, paint);
    }
    return paint;
  };
  // The background at a point of the page behind element e: backdrop where it is the same everywhere, else its
  // ancestors' colours and gradients composited at that point; null when a picture or something unmeasured is on the way.
  const backAt = (e, x, y) => {
    if (!e || e.nodeType !== 1) return [255, 255, 255, 1];
    const same = backdrop(e);
    if (same) return same;
    const s = css(e);
    // Gradient text paints its background in its letters, not behind them.
    if (/text/.test(s.backgroundClip) || /text/.test(s.webkitBackgroundClip || '')) return backAt(e.parentElement, x, y);
    const c = colour(s.backgroundColor);
    if (c === null) return null;
    let base = c;
    if (c[3] < 0.999) {
      const under = backAt(e.parentElement, x, y);
      if (under === null) return null;
      base = c[3] <= 0.001 ? under : over(c, under);
    }
    if (s.backgroundImage === 'none') return base;
    const paint = paintAt(e, s, x, y);
    return paint === null ? null : paint[3] <= 0.001 ? base : over(paint, base);
  };
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  // Controls. A tabindex alone makes one only with no role or a widget role (PP-536): a tabpanel, a region, a dialog, an
  // article or main takes the focus so the keyboard reaches it (WAI-ARIA's tabs pattern), and its height is its content's.
  // Neither is one an element with a tabindex alone and no role taller than 200 px (a scrolling box made focusable);
  // control(e) and controlOf(e) hold that rule, CONTROL is the selector without it.
  const WIDGET_ROLES = ['button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'];
  const NATIVE_CONTROL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[role=option],[role=radio],' + WIDGET_ROLES.map((role) => '[tabindex]:not([tabindex="-1"])[role=' + role + ']').join(',');
  const FOCUSABLE_BOX = '[tabindex]:not([tabindex="-1"]):not([role])';
  const CONTROL = NATIVE_CONTROL + ',' + FOCUSABLE_BOX;
  const control = (e) => e.matches(NATIVE_CONTROL) || (e.matches(FOCUSABLE_BOX) && e.getBoundingClientRect().height <= 200);
  const controlOf = (e) => { for (let p = e; p; p = p.parentElement) if (control(p)) return p; return null; };
  // Open modal dialogs (PP-501), in the page's order, for the layout check and the redlines alike: a <dialog> opened
  // with showModal(), a dialog marked aria-modal, or a dialog whose page around it is shut (sealed), that shows.
  // Shut, any of three ways (a dialog with the page around it reachable, data-state=open alone, is no modal):
  // - hidden: each other child of body is aria-hidden=true (react-aria) or inert (Headless UI), or bare;
  // - out of reach: the dialog takes a pointer while body, or each other child of body, takes none (Radix's
  //   DismissableLayer sets pointer-events:none on body; it leaves the page's root unhidden when that holds an
  //   aria-live region, as visa-dashboard's case page does: live on Build #492);
  // - covered: points just outside the dialog's four edges land on one bare element outside it (the dimmed overlay).
  // Bare: shows no words and no control, the dialog's own left out (an underlay that holds the dialog is bare).
  const shut = (e) => e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('inert');
  const bare = (e, dialog) => {
    const text = e.contains(dialog) ? (e.textContent || '').replace(dialog.textContent || '', '') : e.textContent || '';
    return !/\S/.test(text) && !control(e) && ![...e.querySelectorAll(CONTROL)].some((c) => control(c) && !dialog.contains(c));
  };
  const sealed = (dialog) => {
    let top = dialog;
    while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
    const others = top.parentElement !== document.body ? [] : [...document.body.children].filter((e) => e !== top && !/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|LINK|META)$/.test(e.tagName));
    if (others.length && others.some(shut) && others.every((e) => shut(e) || bare(e, dialog))) return true;
    if (css(dialog).pointerEvents !== 'none' && (css(document.body).pointerEvents === 'none' || (others.length && others.every((e) => css(e).pointerEvents === 'none')))) return true;
    const r = dialog.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const hits = [[r.left - 2, cy], [r.right + 2, cy], [cx, r.top - 2], [cx, r.bottom + 2]].filter(([x, y]) => x >= 0 && y >= 0 && x < VW && y < VH).map(([x, y]) => document.elementFromPoint(x, y));
    return hits.length > 0 && hits.every((h) => h && h === hits[0]) && !dialog.contains(hits[0]) && hits[0] !== document.body && hits[0] !== document.documentElement && bare(hits[0], dialog);
  };
  const modals = () => document.body ? [...document.querySelectorAll(':modal,[aria-modal=true],[role=dialog],[role=alertdialog]')].filter((e) => (e.matches(':modal,[aria-modal=true]') || sealed(e)) && shows(e, e.getBoundingClientRect())) : [];
`;

export const layoutCheck = (width?: number) => String.raw`(() => {
  const W = ${width === undefined ? "innerWidth" : String(Math.round(width))}, VW = innerWidth, VH = innerHeight;
  // The width the page is laid out for (PP-414): a phone page wider than its screen stretches innerWidth to its content
  // (570 in a 390 px WebView), while the root's clientWidth and the media queries stay the screen's.
  const PW = ${width === undefined ? "Math.min(innerWidth, document.documentElement.clientWidth || innerWidth)" : "W"};
  const issues = [];
  let checked = 0, more = 0;
${PAGE_HELPERS}
  const clipsX = (e) => css(e).display !== 'contents' && css(e).overflowX !== 'visible';
  // An open modal dialog (PP-501, PAGE_HELPERS' modals): the page behind it cannot be reached, so only the dialog is
  // measured: the last one in the page's order, which holds a dialog opened from inside it.
  const modal = modals().pop() || null;
  const measuredAll = !document.body ? [] : modal ? [modal, ...modal.querySelectorAll('*')] : [...document.body.querySelectorAll('*')];
  // Android's font scale reaches a WebView as text zoom (PP-433): every px font size and line height computes that much
  // larger (at 108 %, 14 px is 15.12), after CSS has rounded, so a row as tall as its lines leaves the 4 px grid there
  // while it holds at 100 %. A probe set to 100 px reads the zoom; 1 in a browser without one.
  const TEXT_ZOOM = (() => {
    if (!document.body) return 1;
    const probe = document.createElement('span');
    probe.setAttribute('data-pi-text-zoom', '');
    probe.setAttribute('style', 'position:absolute;visibility:hidden;font-size:100px;line-height:100px');
    document.body.appendChild(probe);
    const zoom = Math.round(parseFloat(getComputedStyle(probe).fontSize)) / 100;
    probe.remove();
    return zoom;
  })();
  // The part of a box's height its lines of text make, which text zoom scales (PP-433). A box of lines (its own words,
  // with inline elements) gives its content height, unless it is taller than its lines (a min-height or a fixed height:
  // its height is its own); a line clamp shows its count of lines. A box of boxes gives its children's rows: those side
  // by side give the tallest's (a 24 px icon beside a 21.6 px line makes the row, with no text part), the rows add up;
  // a box taller than its children's extent gives none; words beside boxes count as a box of their lines (PP-538).
  // Pictures and icons give none; fields their own line (fieldPart, PP-538).
  // A height CSS sets (PP-537): a height of its own (auton-ui's h-4 chip, 16 px), a min-height that holds the box, or a
  // max-height that caps it. No lines make it, so text zoom takes nothing back from it (16 px read as 14.8 at 108 %).
  // The computed value (Typed OM) keeps auto as auto, where getComputedStyle gives the px it resolves to.
  const cssHeight = (e, s, r) => {
    if (!e.computedStyleMap || s.display === 'inline') return false;
    const m = e.computedStyleMap(), set = (p) => { const v = m.get(p); return v !== null && v !== undefined && !/^(auto|none|min-content|max-content|fit-content)/.test(String(v)); };
    return set('height') || (set('min-height') && r.height <= px(s.minHeight) + 0.5) || (set('max-height') && r.height >= px(s.maxHeight) - 0.5);
  };
  const lineRange = document.createRange();
  // The lines a range's words make: their count, and their first line's box (PP-538).
  const linesOf = () => {
    let lines = 0, bottom = -1e9, first = null;
    for (const q of [...lineRange.getClientRects()].filter((q) => q.width > 0 && q.height > 0).sort((a, b) => a.top - b.top)) {
      if (q.top >= bottom - 1) { lines++; bottom = q.bottom; if (!first) first = q; } else bottom = Math.max(bottom, q.bottom);
    }
    return { lines, first };
  };
  // A field's height its own line makes (PP-538): an input or a select as tall as its line (the playbook's title field,
  // no padding: 20 px, 21.6 at 108 %), unless CSS sets its height or it is taller than its line (auton-ui's SearchInput,
  // stretched to its frame's 36 px); a textarea as tall as whole lines, unless a stylesheet
  // sets its height. A height its script writes in its style (an autosize: style.height = scrollHeight, auton-ui's
  // MentionInput) is its lines' too, and a whole pixel (41.92 written as 42): its part is what text zoom added to the
  // whole pixel it would be at 100 % (40), so the check takes back that.
  const NO_LINE = /^(checkbox|radio|range|color|image|file|hidden)$/i;
  const fieldPart = (e, s, r, content) => {
    const pitch = px(s.lineHeight);
    if (!/^textarea$/i.test(e.tagName)) return NO_LINE.test(e.type) || cssHeight(e, s, r) || (pitch > 0 && content > pitch + 1) ? 0 : content;
    const lines = pitch > 0 ? Math.round(content / pitch) : 0;
    if (lines < 1 || Math.abs(content - lines * pitch) > 1) return 0;
    if (!cssHeight(e, s, r) || TEXT_ZOOM === 1) return content;
    if (!e.style.height || Math.abs(e.scrollHeight - e.clientHeight) > 1) return 0;
    const whole = Math.round(r.height - lines * pitch * (1 - 1 / TEXT_ZOOM));
    return (r.height - whole) * TEXT_ZOOM / (TEXT_ZOOM - 1);
  };
  const boxKids = (e) => [...e.children].flatMap((c) => css(c).display === 'contents' ? boxKids(c) : [c]).filter((c) => css(c).display !== 'none' && !/absolute|fixed/.test(css(c).position));
  const textParts = new Map();
  const textPart = (e) => {
    let v = textParts.get(e);
    if (v !== undefined) return v;
    const s = css(e), r = e.getBoundingClientRect();
    const content = r.height - px(s.paddingTop) - px(s.paddingBottom) - px(s.borderTopWidth) - px(s.borderBottomWidth);
    const kids = boxKids(e);
    const words = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    // A layer laid over the box it is placed in, to make all of it one tap target (the top bar's title): no lines of its
    // own, as tall as that box, whose lines make its height (PP-406).
    const holder = s.position === 'absolute' && kids.length === 0 && !words ? e.offsetParent : null;
    const held = holder ? holder.getBoundingClientRect().height - px(css(holder).borderTopWidth) - px(css(holder).borderBottomWidth) : 0;
    if (holder && Math.abs(r.height - held) < 0.5) v = textPart(holder);
    else if (content < 1) v = 0;
    else if (/^(input|select|textarea)$/i.test(e.tagName)) v = fieldPart(e, s, r, content);
    else if (REPLACED.test(e.tagName) || cssHeight(e, s, r)) v = 0;
    else if ((words && kids.every((c) => css(c).display.startsWith('inline'))) || (kids.length > 0 && kids.every((c) => css(c).display === 'inline'))) {
      lineRange.selectNodeContents(e);
      let { lines } = linesOf();
      const clamp = parseInt(s.webkitLineClamp, 10);
      if (clamp > 0) lines = Math.min(lines, clamp);
      const pitch = px(s.lineHeight);
      v = pitch > 0 && content > lines * pitch + 1 ? 0 : content;
    } else {
      const boxes = kids.map((c) => { const q = c.getBoundingClientRect(), cs = css(c); return { c, t: q.top - px(cs.marginTop), b: q.bottom + px(cs.marginBottom) }; });
      // Words beside boxes are a box of lines of their own (PP-538): in a flex button, "Amount" beside the 14 px icon of
      // auton-ui's DataTable sort makes the row (29.6 at 108 %, 28 at 100 %), though no element holds them.
      for (const n of e.childNodes) {
        if (n.nodeType !== 3 || n.textContent.trim() === '') continue;
        lineRange.selectNodeContents(n);
        const { lines, first } = linesOf();
        if (!first) continue;
        const pitch = px(s.lineHeight) || first.height, t = first.top - (pitch - first.height) / 2;
        boxes.push({ c: null, part: lines * pitch, t, b: t + lines * pitch });
      }
      boxes.sort((a, b) => a.t - b.t);
      let sum = 0, row = [], end = -1e9;
      const close = () => { if (row.length === 0) return; const h = Math.max(...row.map((k) => k.b - k.t)); sum += Math.max(...row.filter((k) => k.b - k.t >= h - 0.5).map((k) => k.c ? textPart(k.c) : k.part)); row = []; };
      for (const k of boxes) { if (k.t >= end - 1) close(); row.push(k); end = Math.max(row.length === 1 ? -1e9 : end, k.b); }
      close();
      const extent = boxes.length === 0 ? 0 : Math.max(...boxes.map((k) => k.b)) - boxes[0].t;
      v = boxes.length === 0 || content > extent + 1 ? 0 : sum;
    }
    textParts.set(e, v);
    return v;
  };
  // A control as tall as its one picture at the picture's own shape (a lone image thumbnail: height auto, under its
  // max-height): its height is the picture's, not a size of the design, so it is not measured on the grid (PP-406).
  const pictured = (e, r) => {
    const kids = boxKids(e), s = css(e);
    if (kids.length !== 1 || kids[0].tagName !== 'IMG' || [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '')) return false;
    const img = kids[0], is = css(img), q = img.getBoundingClientRect();
    const inner = r.height - px(s.paddingTop) - px(s.paddingBottom) - px(s.borderTopWidth) - px(s.borderBottomWidth);
    return String(img.computedStyleMap().get('height')) === 'auto' && (is.maxHeight === 'none' || q.height < px(is.maxHeight) - 0.5) && Math.abs(q.height - inner) < 0.5;
  };
  const add = (issue) => { if (issues.length < 12) issues.push(issue); else more++; };
  const round = (r) => [Math.round(r.left), Math.round(r.width)];
  const groups = new Map();
  const group = (kind, key, make) => {
    const k = kind + '|' + key, had = groups.get(k);
    if (had) had.count++; else groups.set(k, Object.assign({ kind }, make(), { count: 1 }));
  };
  const clipper = (e) => { for (let a = e; a && a !== document.body && a !== document.documentElement; a = a.parentElement) if (clips(a)) return a; return null; };
  const scrolls = (e) => { const s = css(e); return (/auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1) || (/auto|scroll/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1); };
  const scroller = (e) => {
    for (let a = e.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) if (scrolls(a)) return a;
    const d = document.scrollingElement || document.documentElement;
    return d.scrollHeight > d.clientHeight + 1 ? d : null;
  };
  const lum = (c) => { const f = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
  const onGrid = (v) => v === 0 || v === 1 || v === 2 || (Math.abs(v - Math.round(v)) < 0.01 && Math.round(v) % 4 === 0);
  // A size drawn at a zoom (PP-520) is measured at its own scale: the drawn size divided by the zoom, which the finding
  // says.
  const offGrid = (e, property, v, zoom = 1) => {
    v = r2(v);
    if (onGrid(v)) return;
    const at = Math.abs(zoom - 1) > 0.01 ? r2(zoom) : undefined;
    group('off-grid', property + '|' + v + '|' + at, () => Object.assign({ what: name(e), property, value: v }, at === undefined ? {} : { zoom: at }));
  };
  const LAYER = 'dialog,[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=tooltip],[aria-modal=true],[popover]';
  // Whether something at the point shows over the target: a background, a picture, a control's face or words of its own
  // (a transparent box laid over a title to make it one tap target hides nothing).
  const REPLACED = /^(img|svg|canvas|video|iframe|input|select|textarea|object|embed)$/i;
  const hides = (hit, target) => {
    for (let a = hit; a && !a.contains(target); a = a.parentElement) {
      const s = css(a), c = colour(s.backgroundColor);
      if (s.backgroundImage !== 'none' || c === null || c[3] > 0.05 || REPLACED.test(a.tagName)) return true;
      for (const n of a.childNodes) if (n.nodeType === 3 && n.textContent.trim() !== '') return true;
    }
    return false;
  };
  // Whether the element at a point covers the target, or is the target's own (itself, inside it, around it), or a layer over the page.
  // Words under a stretched link's layer in the card it stretches over are that link's on purpose (PP-436); a control
  // under it is still covered (it cannot be tapped).
  const coveredBy = (target, x, y, words) => {
    if (x < 0 || y < 0 || x >= VW || y >= VH) return undefined;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === target || target.contains(hit) || hit.contains(target)) return null;
    const link = words ? controlOf(hit) : null;
    const over = link && stretchedOver(link);
    if (over && over.contains(target)) {
      const own = link.getBoundingClientRect();
      if (x < own.left || x > own.right || y < own.top || y > own.bottom) return null;
    }
    // Inside an open modal (PP-501), the modal is the page: a layer in it is still one, the modal itself is not.
    const around = hit.closest(LAYER);
    if ((around && !(modal && around.contains(modal))) || !hides(hit, target)) return null;
    let layer = null;
    for (let a = hit; a && a !== document.body && a !== modal; a = a.parentElement) if (/fixed|absolute|sticky/.test(css(a).position)) { layer = a; break; }
    if (layer) {
      const r = layer.getBoundingClientRect();
      if (r.width * r.height >= 0.4 * VW * VH) return null;
      const s = scroller(target);
      if (s && !(s.contains(layer))) return null;
    }
    return hit;
  };
  const sizes = new Set(), colours = new Set(), families = new Set(), icons = new Set(), strokes = new Set();
  const long = [];
  // PP-415, rules adapted from Impeccable's detector (Apache-2.0, third_party/impeccable/README.md): what a page that
  // was assembled rather than designed shows. A colour with chroma: its channels at least 30 apart.
  const chroma = (c) => c !== null && c[3] > 0.1 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) >= 30;
  // Shadow layers as Chrome computes them: a colour, then lengths (x, y, blur, spread), and inset.
  const shadows = (v) => v === 'none' || !v ? [] : splitTop(v).map((layer) => {
    const m = /^([a-z]+\([^()]*\))\s*(.*)$/i.exec(layer);
    if (!m) return null;
    const n = m[2].replace('inset', '').trim().split(/\s+/).map(px);
    return { c: colour(m[1]), x: n[0] || 0, y: n[1] || 0, blur: n[2] || 0, spread: n[3] || 0, inset: /\binset\b/.test(m[2]) };
  }).filter(Boolean);
  const corners = (style) => [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(px);
  const SIDE = ['Top', 'Right', 'Bottom', 'Left'];
  const borderWidths = (style) => SIDE.map((k) => colour(style['border' + k + 'Color']) !== null && style['border' + k + 'Style'] !== 'none' ? px(style['border' + k + 'Width']) : 0);
  // A card: a border on three sides or more, or a shadow, with rounded corners or a background of its own.
  const card = (x) => {
    const st = css(x), bg = colour(st.backgroundColor);
    const edged = borderWidths(st).filter((w) => w >= 1).length >= 3 || shadows(st.boxShadow).some((l) => !l.inset && l.c && l.c[3] > 0.05);
    return edged && (corners(st).some((v) => v > 0) || (bg !== null && bg[3] > 0.05) || st.backgroundImage !== 'none');
  };
  const BORDER_SAFE = /^(blockquote|nav|a|input|textarea|select|pre|code|span|th|td|tr|li|button|hr|img|svg)$/;
  const nestedCandidates = [], headings = [], containers = [];
  // PP-430, auton-ui's rules (better-ui, better-typography, unslop; third_party/jakubkrehel-skills/README.md). A surface
  // is painted: a background, a border or a shadow. Corners as drawn: CSS shrinks radii that do not fit their box, so a
  // pill in a pill compares as pills. A scaled box (a zoomed canvas) scales its rect, not its radii.
  const painted = (st) => { const bg = colour(st.backgroundColor); return (bg !== null && bg[3] > 0.05) || st.backgroundImage !== 'none' || borderWidths(st).some((w) => w >= 1) || shadows(st.boxShadow).some((l) => l.c !== null && l.c[3] > 0.05); };
  const drawnRadii = (st, r) => {
    const v = [st.borderTopLeftRadius, st.borderTopRightRadius, st.borderBottomRightRadius, st.borderBottomLeftRadius].map((x) => { const first = x.split(' ')[0]; return first.endsWith('%') ? parseFloat(first) / 100 * r.width : px(first); });
    const f = Math.min(1, r.width / (v[0] + v[1] || 1), r.width / (v[3] + v[2] || 1), r.height / (v[0] + v[3] || 1), r.height / (v[1] + v[2] || 1));
    return v.map((x) => x * f);
  };
  const unscaled = (e, r) => Math.abs(r.width / (e.offsetWidth || r.width) - 1) <= 0.02;
  const surfaces = new Set();
  // One colour drawn as a gradient (a tint over a fill, corner marks) is a fill, not a gradient.
  // A shimmer (PP-536): an endless animation running on where its background sits (background-position, its x or y, or
  // the background shorthand), a band sweeping over the words.
  const shimmer = (e) => e.getAnimations().some((a) => a.playState === 'running' && a.effect && a.effect.getTiming().iterations === Infinity && a.effect.getKeyframes().some((k) => Object.keys(k).some((p) => /^background(Position[XY]?)?$/.test(p))));
  const flatGradient = (v) => splitTop(v).every((layer) => !/gradient\(/.test(layer) || new Set(layer.match(/(?:rgba?|color|oklab|oklch|hsla?|lab|lch)\([^()]*\)|transparent/g) || []).size <= 1);
  const MONO = /mono|menlo|consolas|courier/i;
  const TABULAR = 'td,th,[role=cell],[role=gridcell],[role=timer],[role=progressbar],[role=meter],output,[aria-live],[role=status]';
  const NUMERIC = /^[\s$€£¥₫+\-−~≈<>]*\d[\d.,:\s]*(%|ms|s|k|K|M|B|h|m|d|px)?$/;
  const FIELD = 'input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],input[type=tel],input[type=password],input[type=number],textarea,select';
  const SCROLL_LAYER = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true]';
  const tell = (e, rule) => group('css-tell', sig(e) + '|' + rule, () => ({ what: name(e), rule }));
  // A target in a sentence (PP-519, WCAG 2.5.8's inline exception): laid out inline, its line holds words that are not
  // its own (nor another control's). 'text' for one inline as words are (a link), 'box' for a chip drawn as a box
  // (inline-flex, inline-block); null when it is not in a sentence (a chip alone in a cell, one in a flex row, which
  // makes it a block).
  const lineRangeOf = document.createRange();
  const inSentence = (e, r) => {
    const display = css(e).display;
    if (!display.startsWith('inline')) return null;
    let block = e.parentElement;
    while (block && block !== document.body && /^(inline|contents)/.test(css(block).display)) block = block.parentElement;
    if (!block) return null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let t = walker.nextNode(); t && seen < 400; t = walker.nextNode()) {
      seen++;
      const owner = t.parentElement, own = owner && controlOf(owner);
      if (!owner || e.contains(t) || !/\S/.test(t.textContent) || (own && !own.contains(e)) || /^(script|style|noscript|template|textarea|option|title)$/i.test(owner.tagName)) continue;
      lineRangeOf.selectNodeContents(t);
      for (const q of lineRangeOf.getClientRects()) if (q.width > 0 && q.height > 0 && q.top < r.bottom - 1 && q.bottom > r.top + 1) return display === 'inline' ? 'text' : 'box';
    }
    return null;
  };

  // How wide a box's content is (PP-534). scrollWidth counts an absolute ::before or ::after, and auton-ui's .hit-area
  // and .hit-area-inline widen a touch area with one that draws nothing: content "", no background, border, shadow or
  // outline. Where there is one, the children's boxes and the words' lines say how wide the content is; a child whose
  // pseudo-element draws (a badge, a dot) reaches as far as its own scrollWidth, and the box's own keeps scrollWidth.
  const blankPseudo = (e, which) => {
    const p = getComputedStyle(e, which);
    if (p.content === 'none' || p.content === 'normal' || p.display === 'none') return null;
    if (p.visibility === 'hidden' || parseFloat(p.opacity) < 0.05) return true;
    const bg = colour(p.backgroundColor);
    return (p.content === '""' || p.content === "''") && (p.backgroundColor === 'transparent' || (bg !== null && bg[3] < 0.05)) && p.backgroundImage === 'none' && p.boxShadow === 'none'
      && ['Top', 'Right', 'Bottom', 'Left'].every((side) => p['border' + side + 'Style'] === 'none' || parseFloat(p['border' + side + 'Width']) === 0)
      && (p.outlineStyle === 'none' || parseFloat(p.outlineWidth) === 0);
  };
  const widthRange = document.createRange();
  const contentWidth = (e, r) => {
    let blanks = 0, drawn = false, seen = 0, lo = Infinity, hi = -Infinity;
    const reach = (q) => { if (q.width > 0 || q.height > 0) { lo = Math.min(lo, q.left); hi = Math.max(hi, q.right); } };
    const pseudos = (d) => { let draws = false; for (const which of ['::before', '::after']) { const blank = blankPseudo(d, which); if (blank === true) blanks++; else if (blank === false) draws = true; } return draws; };
    const visit = (node) => {
      for (let c = node.firstChild; c && !drawn && seen < 400; c = c.nextSibling) {
        if (c.nodeType === 3) {
          if (!/\S/.test(c.textContent)) continue;
          widthRange.selectNodeContents(c);
          for (const q of widthRange.getClientRects()) reach(q);
        } else if (c.nodeType === 1) {
          seen++;
          const s = css(c);
          if (s.display === 'none' || s.position === 'fixed') continue;
          if (c.shadowRoot) { drawn = true; return; }
          const q = c.getBoundingClientRect();
          if (s.display !== 'contents') reach(q);
          if (clipsX(c) || /^(svg|img|canvas|video|iframe|object|embed|select|textarea|input)$/i.test(c.tagName)) continue;
          if (pseudos(c) && s.display !== 'contents') {
            const z = scaleOf(c), wide = c.scrollWidth * z;
            if (s.direction === 'rtl') { const end = q.right - parseFloat(s.borderRightWidth) * z; reach({ left: end - wide, right: end, width: wide, height: 1 }); }
            else { const start = q.left + c.clientLeft * z; reach({ left: start, right: start + wide, width: wide, height: 1 }); }
          }
          visit(c);
        }
      }
    };
    if (e.shadowRoot || pseudos(e)) return e.scrollWidth;
    visit(e);
    if (drawn || seen >= 400 || blanks === 0) return e.scrollWidth;
    const zoom = scaleOf(e), left = r.left + e.clientLeft * zoom;
    const wide = css(e).direction === 'rtl' ? left + e.clientWidth * zoom - lo : hi - left;
    return lo === Infinity ? e.clientWidth : Math.max(e.clientWidth, Math.round(wide / zoom));
  };

  for (const e of measuredAll) {
    if (++checked > 4000) break;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const style = css(e);
    if (style.visibility === 'hidden' || style.display === 'contents' || concealed(e)) continue;
    const tag = e.tagName.toLowerCase();
    let sideways = false;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (clipsX(a)) { sideways = true; break; }
    if (!sideways) {
      if (style.overflowX === 'visible' && e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && !['svg', 'img', 'canvas', 'video', 'iframe'].includes(tag)) {
        const wide = contentWidth(e, r);
        if (wide > e.clientWidth + 1) add({ kind: 'spills', what: name(e), box: [Math.round(r.left), wide], limit: [Math.round(r.left), e.clientWidth] });
      }
      // Against the nearest ancestor with a box: one of display: contents has none (PP-501).
      let p = e.parentElement;
      while (p && p !== document.body && css(p).display === 'contents') p = p.parentElement;
      if (p && p !== document.body && e !== modal && style.position !== 'fixed' && style.position !== 'absolute') {
        const q = p.getBoundingClientRect();
        if (r.left < q.left - 1 || r.right > q.right + 1) add({ kind: 'outside-parent', what: name(e), box: round(r), limit: round(q) });
      }
    }
    if (!shows(e, r) || e.closest('svg') && tag !== 'svg') continue;
    // Spacing and corners on the 4 px grid, in whole pixels (0, 1 and 2 px are hairlines and nudges).
    for (const v of new Set([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(px))) offGrid(e, 'padding', v);
    if (/flex|grid/.test(style.display)) for (const v of new Set([style.rowGap, style.columnGap].filter((g) => g !== 'normal').map(px))) offGrid(e, 'gap', v);
    for (const corner of new Set([style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius])) {
      if (corner.includes('%')) continue;
      const v = px(corner);
      if (v >= Math.min(r.width, r.height) / 2 - 0.5) continue;
      offGrid(e, 'radius', v);
    }
    // Icons at their own scale (PP-520): a 16 px icon in a canvas at zoom 0.7 is drawn 11.2 px.
    const zoom = scaleOf(e);
    if (tag === 'svg' && r.width / zoom <= 48 && r.height / zoom <= 48) {
      const w = r.width / zoom, h = r.height / zoom;
      icons.add(r2(w) + 'x' + r2(h));
      if (style.stroke !== 'none' && style.strokeWidth) strokes.add(style.strokeWidth);
      const at = Math.abs(zoom - 1) > 0.01 ? r2(zoom) : undefined;
      if (Math.abs(w - Math.round(w)) > 0.01 || Math.abs(h - Math.round(h)) > 0.01) group('off-grid', 'icon|' + r2(w) + '|' + at, () => Object.assign({ what: name(e), property: 'icon width', value: r2(w) }, at === undefined ? {} : { zoom: at }));
    }
    // A shimmer (PP-536: auton-ui's "Thinking…") is a running state, as a Live dot is: an endless animation of where the
    // gradient sits, or words in a busy or status region, or [data-allow-gradient].
    if ((style.webkitBackgroundClip === 'text' || style.backgroundClip === 'text') && /gradient\(/.test(style.backgroundImage)) {
      if (!shimmer(e) && !e.closest('[aria-busy=true],[role=status],[data-allow-gradient]')) group('gradient-text', sig(e), () => ({ what: name(e) }));
    }
    // Gradient surfaces (PP-430): a gradient of two colours or more on 1600 px² or more; [data-allow-gradient] marks one
    // the design asks for (a fade over folded content).
    else if (/gradient\(/.test(style.backgroundImage) && r.width * r.height >= 1600 && !e.hasAttribute('data-allow-gradient') && !flatGradient(style.backgroundImage)) group('gradient', sig(e), () => ({ what: name(e), area: Math.round(r.width * r.height), image: trim(style.backgroundImage, 60) }));
    if (tag !== 'svg' && painted(style)) surfaces.add(e);
    // Broken images: loaded, with nothing to draw.
    if (tag === 'img' && e.complete && e.naturalWidth === 0 && (e.currentSrc || e.getAttribute('src'))) group('broken-image', sig(e) + '|' + (e.currentSrc || e.getAttribute('src')), () => ({ what: name(e), src: trim(e.currentSrc || e.getAttribute('src'), 80) }));
    if (/^h[1-6]$/.test(tag)) headings.push(e);
    const radii = corners(style);
    const circle = Math.abs(r.width - r.height) <= Math.max(r.width, r.height) * 0.1 && radii.every((v) => v >= Math.min(r.width, r.height) / 2 - 0.5);
    // Side-tab: a coloured stripe down one side of a card (border-left or -right of 2 px or more on a rounded box, 3 px
    // or more on a square one, the other sides at most 1 px or half as wide), or an inset shadow drawn as one on any side,
    // or a ::before or ::after bar (PP-430). A tab's underline and a separator are not stripes.
    if (!BORDER_SAFE.test(tag) && !circle && (e.textContent || '').trim() && !e.matches('[role=tab],[role=separator]')) {
      const widths = borderWidths(style);
      for (const i of [1, 3]) {
        const w = widths[i], others = Math.max(...widths.filter((_, j) => j !== i));
        if (w >= 2 && (others <= 1 || w >= others * 2) && chroma(colour(style['border' + SIDE[i] + 'Color'])) && (radii.some((v) => v > 0) || w >= 3)) group('side-tab', sig(e) + '|' + i + '|' + w, () => ({ what: name(e), side: i === 1 ? 'right' : 'left', width: r1(w), how: 'border' }));
      }
      for (const l of shadows(style.boxShadow)) {
        if (!l.inset || l.blur !== 0 || l.spread !== 0 || !chroma(l.c)) continue;
        const along = l.y === 0 ? Math.abs(l.x) : l.x === 0 ? Math.abs(l.y) : 0;
        const side = l.y === 0 ? (l.x > 0 ? 'left' : 'right') : (l.y > 0 ? 'top' : 'bottom');
        if (along >= 2 && along <= 12) group('side-tab', sig(e) + '|inset|' + l.x + '|' + l.y, () => ({ what: name(e), side, width: r1(along), how: 'inset shadow' }));
      }
      // A bar: absolute, 4 px or thinner along half the box or more, in a colour, on a rounded or painted box.
      if (radii.some((v) => v > 0) || painted(style)) for (const which of ['::before', '::after']) {
        const ps = getComputedStyle(e, which);
        if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none' || ps.position !== 'absolute' || !chroma(colour(ps.backgroundColor))) continue;
        const w = px(ps.width), h = px(ps.height);
        const upright = w > 0 && w <= 4 && h >= r.height * 0.5, lying = h > 0 && h <= 4 && w >= r.width * 0.5;
        if (!upright && !lying) continue;
        const side = upright ? (px(ps.left) <= px(ps.right) ? 'left' : 'right') : (px(ps.top) <= px(ps.bottom) ? 'top' : 'bottom');
        group('side-tab', sig(e) + '|' + which, () => ({ what: name(e), side, width: r1(upright ? w : h), how: which }));
        break;
      }
    }
    // Glow: a coloured shadow with a soft blur and no offset, or any on a dark background; a halo many times its
    // element's size is an indicator's light, and a faint one is not seen.
    const dark = (() => { const b = backdrop(e); return b !== null && lum(b) < 0.1; });
    for (const [prop, value] of [['box-shadow', style.boxShadow], ['text-shadow', style.textShadow]]) {
      const glow = shadows(value).find((l) => {
        if (l.inset || !chroma(l.c) || l.blur < 6 || l.blur * l.c[3] * opacityOf(e) < 3) return false;
        const reach = l.blur / 2 + l.spread, area = r.width * r.height;
        if (reach <= 0 || (r.width + 2 * reach) * (r.height + 2 * reach) - area > area * 2) return false;
        return (l.x === 0 && l.y === 0) || dark();
      });
      if (glow) { group('glow', sig(e) + '|' + hex(glow.c), () => ({ what: name(e), property: prop, color: hex(glow.c), blur: r1(glow.blur) })); break; }
    }
    // A pulsing dot: a small round dot that animates for ever, its keyframes changing its opacity or scale; a spinner
    // turns, it does not pulse (PP-425).
    if (r.width <= 16 && r.height <= 16 && circle) {
      const pulse = e.getAnimations().find((a) => a.effect && a.effect.getTiming().iterations === Infinity && a.effect.getKeyframes().some((k) => 'opacity' in k || 'scale' in k || /scale/.test(k.transform || '')));
      if (pulse) group('pulsing-dot', sig(e), () => ({ what: name(e), size: r1(Math.max(r.width, r.height)), animation: trim(pulse.animationName || style.animationName, 30) }));
    }
    // Static CSS tells a computed style shows (PP-430): a transition on every property; font-feature-settings "tnum"
    // where it is set, not font-variant-numeric; a field under 16 px on a phone (iOS zooms the page into it); a scroller
    // in a dialog that passes its scroll on to the page.
    const durations = style.transitionDuration.split(',').map(px);
    if (style.transitionProperty.split(',').some((p, i) => p.trim() === 'all' && durations[i % durations.length] > 0)) tell(e, 'transition: all');
    if (/tnum/.test(style.fontFeatureSettings) && !/tabular-nums/.test(style.fontVariantNumeric) && !(e.parentElement && /tnum/.test(css(e.parentElement).fontFeatureSettings))) tell(e, 'font-feature-settings "tnum" instead of font-variant-numeric: tabular-nums');
    if (PW <= ${PHONE_MAX} && e.matches(FIELD) && px(style.fontSize) < 16) tell(e, 'field text ' + r1(px(style.fontSize)) + ' px on a phone (under 16 px iOS zooms in)');
    if (/auto|scroll/.test(style.overflowY) && e.scrollHeight > e.clientHeight + 1 && style.overscrollBehaviorY === 'auto' && e.closest(SCROLL_LAYER)) tell(e, 'scrolling dialog without overscroll-behavior: contain');
    // Candidates for the passes after this loop: cards in cards, and boxes whose words repeat.
    // A control or a list item drawn as a card (a board's task button) is not a card that holds others.
    if (card(e)) {
      if (/^(div|section|article|aside|main|figure|form|fieldset|details|li)$/.test(tag)) containers.push(e);
      if (!/^(blockquote|nav|a|button|label|li|span|pre|code|th|td|tr|input|textarea|select|img|video|canvas|picture)$/.test(tag) && !control(e)) nestedCandidates.push(e);
    }
    if (['p', 'li', 'blockquote', 'dd'].includes(tag) && (e.textContent || '').length >= 200) long.push(e);
    if (control(e)) {
      const nested = e.parentElement && controlOf(e.parentElement);
      const labelled = tag === 'input' && /checkbox|radio/.test(e.type) && e.labels && e.labels.length > 0;
      // A link in a sentence is as tall as its words: no tap target, grid or cover of its own (PP-519: any control, not
      // only an a). A chip there keeps the rest of its checks.
      const inline = nested || labelled ? null : inSentence(e, r);
      if (!nested && !labelled && inline !== 'text') {
        if (PW <= ${PHONE_MAX} && !e.disabled && e.getAttribute('aria-disabled') !== 'true') {
          const hit = hitBox(e, r);
          // A chip in a sentence (PP-519): under 24 px tall with no hit area laid past its box is a finding of its own.
          if (inline === 'box') {
            if (hit.height < ${INLINE_MIN} - 0.01 && hit.height <= r.height + 0.5 && hit.width <= r.width + 0.5) group('inline-target', sig(e) + '|' + Math.round(hit.width) + 'x' + Math.round(hit.height), () => ({ what: name(e), size: [r1(hit.width), r1(hit.height)] }));
          } else if (hit.width < ${TAP_MIN} - 0.01 || hit.height < ${TAP_MIN} - 0.01) group('small-target', sig(e) + '|' + Math.round(hit.width) + 'x' + Math.round(hit.height), () => ({ what: name(e), size: [r1(hit.width), r1(hit.height)] }));
        }
        // Under text zoom, as at 100 %: the part its lines make taken back to their size there (PP-433).
        // In a zoomed canvas, at its own scale (PP-520).
        if (pictured(e, r)) {
          // Its height is its picture's.
        } else if (TEXT_ZOOM === 1) offGrid(e, 'control height', r.height / zoom, zoom);
        else if (textPart(e) === 0) offGrid(e, 'control height', r.height / zoom, zoom);
        else offGrid(e, 'control height at 100 % text', r1((r.height - textPart(e) * (1 - 1 / TEXT_ZOOM)) / zoom), zoom);
        if (style.pointerEvents !== 'none') {
          const by = coveredBy(e, r.left + r.width / 2, r.top + r.height / 2);
          if (by) group('covered', sig(e) + '|' + sig(by), () => ({ what: name(e), by: name(by), points: 1, of: 1 }));
        }
      }
    }
  }

  // Cards inside cards (Impeccable's nested-cards): the innermost card, in flow, with words, at least 50 x 30, that is
  // not a one-line label, a field's box, or a band along its card's edges; the outer card is not a page frame (as tall
  // as the view), a dialog or a layer over the page. A canvas is a surface (PP-520): what is drawn on it (a diagram's
  // nodes in React Flow's viewport, scaled or not, or under [data-canvas]) is not a card inside the card that frames
  // the canvas; a card inside a node still is.
  const CANVAS = '.react-flow,[data-canvas]';
  const canvasOf = (e) => {
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (a.matches(CANVAS) || Math.abs(ownScale(css(a)) - 1) > 0.01) return a;
    return null;
  };
  const nested = [];
  for (const e of nestedCandidates) {
    const st = css(e), r = e.getBoundingClientRect();
    if (/absolute|fixed/.test(st.position) || /^(inline|contents)$/.test(st.display) || e.closest('[role=menu],[role=listbox],[role=tablist],[role=radiogroup],[role=toolbar]')) continue;
    if ((e.textContent || '').trim().length < 10 || r.width < 50 || r.height < 40) continue;
    if (e.querySelector('input:not([type=hidden]),select,textarea') && (e.textContent || '').trim().length < 30) continue;
    let outer = null;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (nestedCandidates.includes(a)) { outer = a; break; }
    if (!outer || outer.matches(LAYER)) continue;
    const canvas = canvasOf(e);
    if (canvas && !canvas.contains(outer)) continue;
    const q = outer.getBoundingClientRect();
    if (q.height >= VH * 0.8 && q.width >= VW * 0.2) continue;
    const edges = [Math.abs(r.top - q.top), Math.abs(r.right - q.right), Math.abs(r.bottom - q.bottom), Math.abs(r.left - q.left)].filter((d) => d <= 2).length;
    if (edges >= 2) continue;
    nested.push([e, outer]);
  }
  for (const [e, outer] of nested) if (!nested.some(([x]) => x !== e && e.contains(x))) group('nested-cards', sig(e) + '|' + sig(outer), () => ({ what: name(e), in: name(outer) }));
  // Concentric radii (PP-430; better-ui: "outer radius equals inner radius plus padding"): a painted surface in a
  // painted surface with an even gap (the same on three sides or more within 1 px, 1 to 12 px; wider, they read as two
  // surfaces) curves with it in each corner it sits in: outer = inner + gap + border, within 2 px. Children under 20 px,
  // square inner corners, corners of 4 px or less on both (no curve to see, PP-432), fixed children and scaled boxes are
  // left out. Corner bleed (PP-432): a child flush in a rounded corner of a parent that does not clip it, with a tighter
  // curve than the parent's inside edge (a progress fill in a rounded bar), pokes its corner out of the parent's.
  const CORNER_SIDES = [[0, 3], [0, 1], [2, 1], [2, 3]];
  for (const outer of surfaces) {
    const os = css(outer), or = outer.getBoundingClientRect();
    if (or.width < 16 || or.height < 16 || !unscaled(outer, or)) continue;
    const orad = drawnRadii(os, or);
    if (Math.max(...orad) < 2) continue;
    const ob = SIDE.map((k) => px(os['border' + k + 'Width']));
    for (const inner of outer.children) {
      if (!surfaces.has(inner)) continue;
      const is = css(inner), ir = inner.getBoundingClientRect();
      if (is.position === 'fixed' || inner.offsetWidth < 20 || inner.offsetHeight < 20 || !unscaled(inner, ir)) continue;
      const d = [ir.top - or.top - ob[0], or.right - ob[1] - ir.right, or.bottom - ob[2] - ir.bottom, ir.left - or.left - ob[3]];
      const g = Math.min(...d), near = (x) => Math.abs(x - g) <= 1;
      const irad = drawnRadii(is, ir);
      if (g < 1) {
        if (os.overflowX !== 'visible' || os.overflowY !== 'visible') continue;
        // Only what the child paints at that corner shows: its background, its shadow, or a border on a side that meets
        // there (a footer's divider along its top does not reach the card's bottom corners).
        const bg = colour(is.backgroundColor), iw = borderWidths(is);
        const filled = (bg !== null && bg[3] > 0.05) || is.backgroundImage !== 'none' || shadows(is.boxShadow).some((l) => !l.inset && l.c !== null && l.c[3] > 0.05);
        const c = CORNER_SIDES.findIndex(([s1, s2], k) => d[s1] < 1 && d[s2] < 1 && (filled || iw[s1] >= 1 || iw[s2] >= 1) && orad[k] - (ob[s1] + ob[s2]) / 2 - irad[k] > 2);
        if (c >= 0) group('corner-bleed', sig(inner) + '|' + sig(outer) + '|' + Math.round(irad[c]) + '|' + Math.round(orad[c]), () => ({ what: name(inner), in: name(outer), inner: r1(irad[c]), outer: r1(orad[c]) }));
        continue;
      }
      if (g > 12 || d.filter(near).length < 3) continue;
      for (let c = 0; c < 4; c++) {
        const [s1, s2] = CORNER_SIDES[c];
        if (!near(d[s1]) || !near(d[s2]) || irad[c] < 1 || (orad[c] <= 4 && irad[c] <= 4)) continue;
        const b = (ob[s1] + ob[s2]) / 2, want = irad[c] + g + b;
        // Inset as far as the outer radius or further, the inner corner lies outside the outer curve: nothing to follow
        // (PP-537: auton-ui's ChoiceCards, a radius 8 tile 12 px into a radius 12 card).
        if (g + b >= orad[c] - 0.01) continue;
        if (Math.abs(orad[c] - want) > 2) { group('concentric', sig(inner) + '|' + sig(outer) + '|' + Math.round(irad[c]) + '|' + Math.round(orad[c]), () => ({ what: name(inner), in: name(outer), inner: r1(irad[c]), gap: r1(g), border: r1(b), outer: r1(orad[c]), want: r1(want) })); break; }
      }
    }
  }
  // A viewport that blocks zoom.
  const viewport = document.querySelector('meta[name=viewport]');
  const zoom = viewport && /maximum-scale\s*=\s*(0*1(\.0*)?|0?\.\d+)(?![\d.])|user-scalable\s*=\s*(no|0)\b/i.exec(viewport.getAttribute('content') || '');
  if (zoom) tell(viewport, 'viewport ' + zoom[0].replace(/\s+/g, '') + ' blocks zoom');
  // Skipped heading levels: an h1 followed by an h3, outside a footer.
  for (let i = 1; i < headings.length; i++) {
    const from = Number(headings[i - 1].tagName[1]), to = Number(headings[i].tagName[1]);
    if (to > from + 1 && !headings[i].closest('footer,[role=contentinfo]')) group('skipped-heading', 'h' + from + '|h' + to + '|' + sig(headings[i]), () => ({ what: name(headings[i]), from, to }));
  }
  // The same words in three or more different spots of one card (Impeccable's repeated-container-text): the card's own
  // elements, not those of a card inside it, 4 to 48 characters with a letter, outside tables, menus and navigation.
  const SKIP_REPEAT = 'table,select,datalist,nav,menu,[role=navigation],[role=menu],[role=menubar],[role=listbox],[role=grid],[role=tablist],[role=radiogroup],[aria-hidden=true]';
  for (const box of containers) {
    if (box.closest(SKIP_REPEAT)) continue;
    const inside = box.querySelectorAll('*');
    if (inside.length > 250) continue;
    const spots = new Map();
    for (const d of inside) {
      let owner = d.parentElement;
      while (owner && owner !== box && !containers.includes(owner)) owner = owner.parentElement;
      if (owner !== box || d.closest(SKIP_REPEAT) || !shows(d, d.getBoundingClientRect())) continue;
      const own = [...d.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (own.length < 4 || own.length > 48 || !/\p{L}/u.test(own)) continue;
      const path = [];
      for (let c = d; c && c !== box; c = c.parentElement) path.push(c.tagName.toLowerCase() + [...c.classList].sort().map((k) => '.' + k).join(''));
      if (!spots.has(own)) spots.set(own, new Set());
      spots.get(own).add(path.join('>'));
    }
    for (const [text, paths] of spots) if (paths.size >= 3) group('repeated-text', sig(box) + '|' + text, () => ({ what: name(box), text, times: paths.size }));
  }

  // Text: what each run of words shows, its size, colour and contrast, and what covers it.
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'option', 'title']);
  const EMOJI = /(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}\uFE0F?|[\u2713\u2717\u2718\u2605\u2606\u25A0-\u25FF]/gu;
  const walker = document.body ? document.createTreeWalker(modal || document.body, NodeFilter.SHOW_TEXT) : null;
  const range = document.createRange(), whole = document.createRange();
  const cutBoxes = new Set();
  let texts = 0;
  for (let node = walker ? walker.nextNode() : null; node && texts < 3000; node = walker.nextNode()) {
    const words = node.textContent.trim();
    const p = node.parentElement;
    if (!words || !p || SKIP.has(p.tagName.toLowerCase()) || p.closest('svg')) continue;
    const s = css(p);
    if (s.visibility !== 'visible' || opacityOf(p) < 0.05 || concealed(p)) continue;
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0);
    if (rects.length === 0) continue;
    const b = range.getBoundingClientRect();
    if (b.right <= 0 || b.bottom <= 0 || b.left >= docW) continue;
    const region = inside(p);
    if (empty(meet(region, { l: b.left, t: b.top, r: b.right, b: b.bottom }))) continue;
    texts++;
    const size = parseFloat(s.fontSize);
    sizes.add(r1(size));
    families.add(s.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''));
    // Cut: the text runs past the nearest box that hides its overflow (a scroller is not a cut). Once a box: its
    // numbers are the box's and all of its words' (a title of several runs of words, the last one past the edge, is
    // one cut, not each run measured against the box).
    const a = clipper(p);
    if (a && !cutBoxes.has(a)) {
      const as = css(a), box = padBox(a);
      if (box.r - box.l > 2 && box.b - box.t > 2 && as.clip === 'auto' && as.clipPath === 'none') {
        const dx = Math.max(0, b.right - box.r) + Math.max(0, box.l - b.left), dy = Math.max(0, b.bottom - box.b) + Math.max(0, box.t - b.top);
        const ellipsis = as.textOverflow === 'ellipsis' || (as.webkitLineClamp && as.webkitLineClamp !== 'none');
        const x = /hidden|clip/.test(as.overflowX) && dx > 2, y = !x && /hidden|clip/.test(as.overflowY) && dy > size / 2;
        if (x || y) {
          cutBoxes.add(a);
          whole.selectNodeContents(a);
          const w = whole.getBoundingClientRect();
          const full = x ? Math.max(w.right, box.r) - Math.min(w.left, box.l) : Math.max(w.bottom, box.b) - Math.min(w.top, box.t);
          group('cut', sig(a) + (x ? '|x|' : '|y|') + ellipsis, () => ({ what: name(a), axis: x ? 'x' : 'y', shown: Math.round(x ? box.r - box.l : box.b - box.t), full: Math.round(full), ellipsis: !!ellipsis }));
        }
      }
    }
    // Covered: three points along its first line, where it shows.
    if (s.pointerEvents !== 'none') {
      const first = rects[0], v = meet(region, { l: first.left, t: first.top, r: first.right, b: first.bottom });
      if (!empty(v)) {
        let points = 0, of = 0, by = null;
        for (const f of [0.25, 0.5, 0.75]) {
          const hit = coveredBy(p, v.l + (v.r - v.l) * f, (v.t + v.b) / 2, true);
          if (hit === undefined) continue;
          of++;
          if (hit) { points++; by = by || hit; }
        }
        if (by) group('covered', sig(p) + '|' + sig(by), () => ({ what: name(p), by: name(by), points, of }));
      }
    }
    if (size < ${TEXT_MIN} - 0.01) group('small-text', sig(p) + '|' + r1(size), () => ({ what: name(p), size: r1(size) }));
    const glyphs = words.match(EMOJI);
    if (glyphs) group('emoji', sig(p) + '|' + glyphs.join(''), () => ({ what: name(p), glyphs: [...new Set(glyphs)].join(' ') }));
    const tracking = s.letterSpacing === 'normal' ? 0 : r2(px(s.letterSpacing));
    const letters = words.replace(/[^\p{L}]/gu, '');
    if ((s.textTransform === 'uppercase' || s.textTransform === 'capitalize') && letters) group('uppercase', sig(p) + '|' + s.textTransform, () => ({ what: name(p), transform: s.textTransform, tracking }));
    else if (letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase() && tracking > 0.5) group('uppercase', sig(p) + '|caps', () => ({ what: name(p), transform: 'capitals', tracking }));
    if (tracking < 0 && size < 16) group('tight-tracking', sig(p) + '|' + tracking, () => ({ what: name(p), size: r1(size), tracking }));
    // Justified text in a narrow column (45 characters a line or fewer) without hyphens, and body text over more than
    // one line set tighter than 1.3 (not headings, display type from 24 px, bold titles or code).
    const lineTops = new Set(rects.map((q) => Math.round(q.top)));
    if (s.textAlign === 'justify' && lineTops.size >= 2 && (s.hyphens || s.webkitHyphens) !== 'auto') {
      const chars = Math.round(p.getBoundingClientRect().width / (size * 0.5));
      if (chars <= 45) group('justified', sig(p), () => ({ what: name(p), chars }));
    }
    const pitch = px(s.lineHeight);
    let tight = false;
    if (pitch > 0 && size < 24 && lineTops.size >= 2 && words.length > 50 && Number(s.fontWeight) < 600 && !p.closest('h1,h2,h3,h4,h5,h6,[role=heading],pre,code,samp')) {
      const ratio = Math.round(pitch / size * 100) / 100;
      if (ratio < 1.3) { tight = true; group('tight-leading', sig(p) + '|' + ratio, () => ({ what: name(p), size: r1(size), ratio })); }
    }
    // Leading 1 on text that wraps, headings too (PP-430): the lines touch.
    if (!tight && pitch > 0 && pitch / size <= 1.05 && lineTops.size >= 2 && !p.closest('pre,code,samp')) tell(p, 'line height ' + r2(pitch / size) + '× on wrapping text');
    // Numbers people compare or watch change (cells, timers, live regions, progress) in tabular figures (PP-430,
    // better-typography); a monospace face is tabular, and "tnum" is its own tell above.
    if (NUMERIC.test(words) && (words.match(/\d/g) || []).length >= 2 && p.closest(TABULAR) && !/tabular-nums/.test(s.fontVariantNumeric) && !/tnum/.test(s.fontFeatureSettings) && !MONO.test(s.fontFamily.split(',')[0])) group('tabular', sig(p), () => ({ what: name(p), text: trim(words, 16) }));
    // Contrast, WCAG AA: 4.5, or 3 for large text (24 px, or 18.66 px bold); disabled controls are exempt.
    // Over a gradient (PP-414): measured where the words sit (three points on the first line, the middle of the last),
    // the lowest of them, with the element that paints it.
    const fill = colour(s.webkitTextFillColor || s.color);
    if (fill && fill[3] > 0.001) colours.add(hex(fill));
    if (fill && fill[3] > 0.001 && !p.closest('[disabled],[aria-disabled=true]')) {
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      const needs = large ? 3 : 4.5;
      const score = (under) => {
        const ink = over([fill[0], fill[1], fill[2], fill[3] * opacityOf(p)], under);
        const hi = Math.max(lum(ink), lum(under)), lo = Math.min(lum(ink), lum(under));
        return { ratio: (hi + 0.05) / (lo + 0.05), ink, under };
      };
      const same = backdrop(p);
      let worst = same ? score(same) : null, painter = null;
      if (!same) {
        for (let a = p; a && a.nodeType === 1; a = a.parentElement) if (css(a).backgroundImage !== 'none') { painter = a; break; }
        const first = rects[0], last = rects[rects.length - 1];
        const points = [0.25, 0.5, 0.75].map((f) => [first.left + first.width * f, first.top + first.height / 2]);
        if (rects.length > 1) points.push([last.left + last.width / 2, last.top + last.height / 2]);
        for (const [x, y] of points) {
          const under = painter && backAt(p, x, y);
          if (!under) { worst = null; break; }
          const each = score(under);
          if (!worst || each.ratio < worst.ratio) worst = each;
        }
      }
      if (worst && worst.ratio < needs - 0.005) {
        const w = worst;
        group('contrast', hex(w.ink) + '|' + hex(w.under) + '|' + needs, () => Object.assign({ what: name(p), color: hex(w.ink), background: hex(w.under), ratio: r2(w.ratio), needs }, painter ? { gradient: painter.tagName.toLowerCase() + (painter.id ? '#' + painter.id : '') + classes(painter) } : {}));
      }
    }
  }

  // Content hidden at the picture (PP-521): an element with words, in flow and in view, at opacity 0 of its own while
  // its parent shows. An entrance that has not run (one an observer or a script starts, which a page drawn off screen
  // may never start), or content a script has yet to show: the picture leaves it out, so it is a finding, never passed
  // over as hidden on purpose. A layer (a menu, a tooltip, a dialog), a placed element (absolute or fixed: a hover
  // card, a screen reader's text), one under 40 x 24 px or with fewer than 12 letters (a control shown on hover) are
  // left out.
  for (const e of measuredAll.slice(0, 4000)) {
    const s = css(e);
    if (Number(s.opacity) >= 0.05 || /absolute|fixed/.test(s.position) || s.visibility !== 'visible' || s.display === 'contents') continue;
    const p = e.parentElement;
    if (!p || opacityOf(p) < 0.05 || concealed(p) || e.closest(LAYER + ',[aria-hidden=true],[inert]')) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 40 || r.height < 24 || r.right <= 0 || r.bottom <= 0 || r.left >= docW || empty(meet(inside(p), { l: r.left, t: r.top, r: r.right, b: r.bottom }))) continue;
    if ((e.textContent || '').replace(/\s+/g, '').length < 12) continue;
    const running = e.getAnimations().find((a) => a.playState !== 'finished' && a.effect && a.effect.getKeyframes().some((k) => 'opacity' in k));
    const animation = running ? trim(running.animationName || running.id || 'an animation', 30) : undefined;
    group('hidden', sig(e) + '|' + animation, () => Object.assign({ what: name(e), opacity: r2(Number(s.opacity)) }, animation === undefined ? {} : { animation }));
  }

  // Long lines: characters a line in paragraphs of three lines or more.
  for (const e of long) {
    range.selectNodeContents(e);
    const tops = [...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0).map((q) => q.top).sort((x, y) => x - y);
    const size = parseFloat(css(e).fontSize);
    let lines = 0, last = -1e9;
    for (const t of tops) if (t - last > size / 2) { lines++; last = t; }
    const chars = Math.round(e.textContent.replace(/\s+/g, ' ').trim().length / Math.max(1, lines));
    if (lines >= 3 && chars > 90) group('long-lines', sig(e), () => ({ what: name(e), chars }));
  }

  const wide = document.documentElement.scrollWidth;
  if (wide > W + 1) add({ kind: 'page-wider', what: 'the page', box: [0, wide], limit: [0, W] });
  const totals = {}, kept = {}, found = [];
  for (const g of [...groups.values()].sort((x, y) => y.count - x.count)) {
    totals[g.kind] = (totals[g.kind] || 0) + g.count;
    kept[g.kind] = (kept[g.kind] || 0) + 1;
    if (kept[g.kind] <= ${FINDS_KEPT}) found.push(g);
  }
  const summary = { fontSizes: [...sizes].sort((x, y) => x - y), colors: [...colours], families: [...families], icons: [...icons], strokes: [...strokes] };
  // A page that does not scroll itself but inside a box, half a screen or more (the view is as tall as the picture now),
  // that still hides content below (an app shell, PP-440): the most hidden one.
  let shellBox;
  for (const e of document.body && document.documentElement.scrollHeight <= innerHeight + 1 ? measuredAll : []) {
    if (e.clientHeight < Math.min(VH, 800) / 2 || e.clientWidth < W / 2 || e.scrollHeight <= e.clientHeight + 2 || !/^(auto|scroll|overlay)$/.test(css(e).overflowY)) continue;
    if (!shellBox || e.scrollHeight - e.clientHeight > shellBox.full - shellBox.shown) shellBox = { what: name(e), shown: e.clientHeight, full: e.scrollHeight };
  }
  const errors = Array.isArray(window.__piPageErrors) ? window.__piPageErrors.slice(0, 5).map((x) => String(x).slice(0, 300)) : [];
  // HTML-in-Canvas (PP-454) that this renderer lacks: the page's canvases then show what it draws without it.
  let canvasUse;
  if (typeof CanvasRenderingContext2D === 'undefined' || typeof CanvasRenderingContext2D.prototype.drawElementImage !== 'function') {
    if (document.querySelector('canvas[layoutsubtree]')) canvasUse = 'canvas[layoutsubtree]';
    else if (document.querySelector('canvas[content=drawable]')) canvasUse = 'canvas[content=drawable]';
    // A real call: where the renderer lacks it, a call throws ("...drawElementImage is not a function"), which a file page
    // keeps; a page that only feature-detects it (its typeof, its name in a script) does not count (PP-459).
    else if (Array.isArray(window.__piPageErrors) && window.__piPageErrors.some((x) => /\bdrawElementImage\b/.test(String(x)))) canvasUse = 'a call to drawElementImage';
  }
  const canvas = canvasUse ? { uses: canvasUse, chrome: (/Chrome\/(\d+)/.exec(navigator.userAgent) || [, 'unknown'])[1] } : undefined;
  return JSON.stringify(Object.assign({ width: W, height: innerHeight, checked: Math.min(checked, 4000), issues, more, found, totals, summary }, modal ? { modal: name(modal) } : {}, TEXT_ZOOM !== 1 ? { textZoom: TEXT_ZOOM } : {}, shellBox ? { scroller: shellBox } : {}, errors.length ? { errors } : {}, canvas ? { canvas } : {}, ${PASSWORD_SHOWN} ? { password: true } : {}, window.__piFinished > 0 ? { finished: window.__piFinished } : {}));
})()`;

/** Each kind's heading, in the order the words give them. */
const KINDS: [LayoutFindKind, string][] = [
    ["cut", "Cut text"],
    ["covered", "Covered: an element on top of another's text or control"],
    ["small-target", `Tap targets under ${TAP_MIN} px`],
    ["inline-target", `Chips in a sentence under ${INLINE_MIN} px tall with no hit area (WCAG 2.5.8)`],
    ["contrast", "Text under WCAG AA contrast"],
    ["small-text", `Text under ${TEXT_MIN} px`],
    ["off-grid", "Sizes off the 4 px grid or not whole pixels"],
    ["emoji", "Emoji or symbols as icons"],
    ["gradient-text", "Gradient text"],
    ["uppercase", "Uppercase labels (not sentence case)"],
    ["tight-tracking", "Negative letter spacing on small text"],
    ["long-lines", "Long lines"],
    ["broken-image", "Broken images"],
    ["skipped-heading", "Skipped heading levels"],
    ["nested-cards", "Cards inside cards"],
    ["side-tab", "Side-tab accent stripes"],
    ["glow", "Glowing shadows"],
    ["pulsing-dot", "Pulsing dots"],
    ["justified", "Justified text in a narrow column"],
    ["tight-leading", "Tight line height on body text"],
    ["repeated-text", "The same words repeated in one card"],
    ["concentric", "Corners not concentric (outer radius = inner + gap + border)"],
    ["corner-bleed", "Corners poking out of a rounded parent that does not clip them"],
    ["tabular", "Numbers without tabular figures"],
    ["gradient", "Gradient surfaces"],
    ["css-tell", "Static CSS tells"],
    ["hidden", "Words hidden at the picture (opacity 0)"],
];

/** One finding in words, with its numbers. */
function findWords(find: LayoutFind): string {
    const times = find.count > 1 ? ` (×${find.count})` : "";

    switch (find.kind) {
        case "cut":
            return `${find.what}: cut ${find.axis === "x" ? "at the side" : "at the bottom"}${find.ellipsis ? ", ends in …" : ""} (shows ${find.shown} of ${find.full} px ${find.axis === "x" ? "wide" : "tall"})${times}`;
        case "covered":
            return `${find.what}: under ${find.by} (${find.points} of ${find.of} points)${times}`;
        case "small-target":
        case "inline-target":
            return `${find.what}: ${find.size[0]}×${find.size[1]} px${times}`;
        case "off-grid":
            return `${find.property} ${find.value} px${find.zoom === undefined ? "" : ` at zoom ${find.zoom}`}: ${find.count} element${find.count === 1 ? "" : "s"}, such as ${find.what}`;
        case "contrast":
            return `${find.what}: ${find.color} on ${find.background}${find.gradient === undefined ? "" : ` (gradient on ${find.gradient})`}, ${find.ratio}:1 (needs ${find.needs})${times}`;
        case "small-text":
            return `${find.what}: ${find.size} px${times}`;
        case "emoji":
            return `${find.what}: ${find.glyphs}${times}`;
        case "gradient-text":
            return `${find.what}${times}`;
        case "uppercase":
            return `${find.what}: ${find.transform}${find.tracking !== 0 ? `, letter spacing ${find.tracking} px` : ""}${times}`;
        case "tight-tracking":
            return `${find.what}: ${find.tracking} px at ${find.size} px${times}`;
        case "long-lines":
            return `${find.what}: about ${find.chars} characters a line${times}`;
        case "broken-image":
            return `${find.what}: ${find.src} has nothing to draw${times}`;
        case "skipped-heading":
            return `${find.what}: h${find.from} then h${find.to}, no h${find.from + 1}${times}`;
        case "nested-cards":
            return `${find.what}: inside ${find.in}${times}`;
        case "side-tab":
            return `${find.what}: ${find.width} px ${find.side} ${find.how === "border" || find.how === "inset shadow" ? find.how : `${find.how} bar`}${times}`;
        case "glow":
            return `${find.what}: ${find.property} ${find.color}, blur ${find.blur} px${times}`;
        case "pulsing-dot":
            return `${find.what}: ${find.size} px, animation ${find.animation}${times}`;
        case "justified":
            return `${find.what}: about ${find.chars} characters a line${times}`;
        case "tight-leading":
            return `${find.what}: line height ${find.ratio}× at ${find.size} px (needs 1.3)${times}`;
        case "repeated-text":
            return `${find.what}: "${find.text}" ${find.times} times${times}`;
        case "concentric":
            return `${find.what}: radius ${find.inner} + gap ${find.gap}${find.border > 0 ? ` + border ${find.border}` : ""} in ${find.in}, whose radius is ${find.outer} (wants ${find.want})${times}`;
        case "corner-bleed":
            return `${find.what}: radius ${find.inner}, flush in a corner of ${find.in} (radius ${find.outer}), which does not clip it; clip it with overflow: hidden on the parent, or wrap the fill in an absolute inset-0 overflow-hidden layer with border-radius: inherit${times}`;
        case "tabular":
            return `${find.what}: "${find.text}" without tabular-nums${times}`;
        case "gradient":
            return `${find.what}: ${find.image} on ${find.area} px²${times}`;
        case "css-tell":
            return `${find.what}: ${find.rule}${times}`;
        case "hidden":
            return `${find.what}: opacity ${find.opacity}, ${find.animation === undefined ? "no animation running: an entrance waiting for an observer or a script that has not run, or content never shown" : `animation ${find.animation} not run`}; show it without the script, and animate it in from there${times}`;
    }
}

/** The summary's parts that go past what a designed page uses: a few sizes, three text roles, two families, one icon set. */
function summaryWords(summary: LayoutSummary): string | undefined {
    const parts = [
        ...(summary.fontSizes.length > 6 ? [`${summary.fontSizes.length} font sizes (${summary.fontSizes.join(", ")} px)`] : []),
        ...(summary.colors.length > 6 ? [`${summary.colors.length} text colours (${summary.colors.slice(0, 8).join(", ")}${summary.colors.length > 8 ? ", …" : ""})`] : []),
        ...(summary.families.length > 2 ? [`${summary.families.length} font families (${summary.families.join(", ")})`] : []),
        ...(summary.icons.length > 2 ? [`icons in ${summary.icons.length} sizes (${summary.icons.slice(0, 6).join(", ")} px)`] : []),
        ...(summary.strokes.length > 1 ? [`icon strokes of ${summary.strokes.length} widths (${summary.strokes.join(", ")})`] : []),
    ];

    return parts.length === 0 ? undefined : `Type and colour: ${parts.join("; ")}.`;
}

/**
 * The animations finished before the picture (PP-521); the text zoom the page was measured under (PP-433); what the
 * picture leaves out (PP-440): the rest of the box the page scrolls in, and the errors the page threw; and
 * HTML-in-Canvas the renderer lacks (PP-454).
 */
function pageNotes(report: LayoutReport): string[] {
    const { scroller, errors = [], canvas, textZoom, finished } = report;

    return [
        ...(finished === undefined
            ? []
            : [
                  `${finished} animation${finished === 1 ? " was" : "s were"} still running after the wait and finished before the picture, which shows where ${finished === 1 ? "it ends" : "they end"}.`,
              ]),
        ...(textZoom === undefined
            ? []
            : [
                  `Text zoom ${Math.round(textZoom * 100)} % (the system's font size): control heights are measured on the 4 px grid as at 100 %, the part their lines of text make taken back to its size there; a height CSS sets is measured as it is.`,
              ]),
        ...(scroller === undefined ? [] : [`The page scrolls inside ${scroller.what}: the picture shows ${scroller.shown} of its ${scroller.full} px, the rest is not in it.`]),
        ...(errors.length === 0 ? [] : [`The page threw: ${errors.join("; ")}`]),
        ...(canvas === undefined
            ? []
            : [
                  `The page uses HTML-in-Canvas (${canvas.uses}), which this renderer (Chrome ${canvas.chrome}) lacks: its canvas shows what the page draws without it. Pi's browser on a machine draws it when the setting browser.chromeFeatures has CanvasDrawElement.`,
              ]),
    ];
}

/** The report in words for Pi: one line when all is in place, else each issue with its numbers, grouped and capped. */
export function describeLayout(report: LayoutReport): string {
    const head = `Layout check at ${report.width} px (${report.checked} elements${report.modal === undefined ? "" : `, measured inside the open dialog ${report.modal}; the page behind it is left out`})`;
    const total = report.issues.length + report.more + Object.values(report.totals).reduce((sum, n) => sum + (n ?? 0), 0);
    const summary = summaryWords(report.summary);

    if (total === 0) {
        return [
            `${head}: nothing spills out of its box or its parent, the page is no wider than the screen, and no text is cut, covered, too small or too faint; tap targets and sizes are in order.`,
            ...(summary === undefined ? [] : [summary]),
            ...pageNotes(report),
        ].join("\n");
    }

    const words: Record<LayoutIssue["kind"], string> = {
        spills: "its content is wider than its box",
        "outside-parent": "sticks out of its parent",
        "page-wider": "is wider than the screen",
    };
    const lines = [
        `${head}: ${total} out of place.`,
        ...report.issues.map(
            (issue) =>
                `- ${issue.what}: ${words[issue.kind]} (${issue.kind === "spills" || issue.kind === "page-wider" ? `${issue.box[1]} px in ${issue.limit[1]}` : `x ${issue.box[0]}–${issue.box[0] + issue.box[1]} in x ${issue.limit[0]}–${issue.limit[0] + issue.limit[1]}`})`,
        ),
        ...(report.more > 0 ? [`- … and ${report.more} more`] : []),
    ];

    for (const [kind, heading] of KINDS) {
        const finds = report.found.filter((find) => find.kind === kind);
        const all = report.totals[kind] ?? 0;

        if (finds.length === 0) {
            continue;
        }

        const shown = finds.slice(0, SHOWN);
        const rest = all - shown.reduce((sum, find) => sum + find.count, 0);

        lines.push(`${heading} (${all}):`, ...shown.map((find) => `- ${findWords(find)}`));

        if (rest > 0) {
            lines.push(`- and ${rest} more`);
        }
    }

    if (summary !== undefined) {
        lines.push(summary);
    }

    return [...lines, ...pageNotes(report)].join("\n");
}

const isFind = (value: unknown): value is LayoutFind =>
    typeof value === "object" && value !== null && KINDS.some(([kind]) => kind === (value as { kind?: unknown }).kind) && typeof (value as { what?: unknown }).what === "string";

/**
 * A report the renderer sent for a picture `width` CSS pixels wide, checked: undefined when it is not one. A page whose
 * content is wider than the screen stretches the WebView's layout (innerWidth 520 in a 390 px WebView): the report is
 * then put at the width asked for, with the page's own width as an issue.
 */
export function parseLayout(text: unknown, width: number): LayoutReport | undefined {
    if (typeof text !== "string") {
        return undefined;
    }

    try {
        const value = JSON.parse(text) as LayoutReport;

        if (
            typeof value.width !== "number" ||
            !Array.isArray(value.issues) ||
            !Array.isArray(value.found) ||
            !value.found.every(isFind) ||
            typeof value.totals !== "object" ||
            value.totals === null ||
            typeof value.summary !== "object" ||
            value.summary === null
        ) {
            return undefined;
        }

        const { scroller, errors } = value;

        if (scroller !== undefined && (typeof scroller?.what !== "string" || typeof scroller.shown !== "number" || typeof scroller.full !== "number")) {
            delete value.scroller;
        }

        if (errors !== undefined && !(Array.isArray(errors) && errors.every((each) => typeof each === "string"))) {
            delete value.errors;
        }

        if (value.canvas !== undefined && (typeof value.canvas?.uses !== "string" || typeof value.canvas.chrome !== "string")) {
            delete value.canvas;
        }

        if (value.password !== undefined && value.password !== true) {
            delete value.password;
        }

        if (value.modal !== undefined && typeof value.modal !== "string") {
            delete value.modal;
        }

        if (value.textZoom !== undefined && !(typeof value.textZoom === "number" && value.textZoom > 0)) {
            delete value.textZoom;
        }

        if (value.finished !== undefined && !(typeof value.finished === "number" && value.finished > 0)) {
            delete value.finished;
        }

        if (value.width > width + 1 && !value.issues.some((issue) => issue.kind === "page-wider")) {
            return { ...value, width, issues: [...value.issues, { kind: "page-wider", what: "the page", box: [0, value.width], limit: [0, width] }] };
        }

        return value;
    } catch {
        return undefined;
    }
}
