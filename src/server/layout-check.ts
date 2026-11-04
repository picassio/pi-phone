/**
 * A measured layout check for screenshots (PP-10; the owner, 2026-10-20: "how can you make sure you don't miss that when
 * you verify?"). The renderer runs `LAYOUT_CHECK` in the page just before it draws it, and Pi gets numbers with the
 * picture: elements whose content spills out of their own box, elements that stick out of their parent's, and a page
 * that is wider than its viewport. A picture can mislead; sizes do not.
 *
 * Since PP-395 it also measures what makes a page look unfinished (the rules a script can measure, PP-394): text cut by
 * a box that hides its overflow, an element covering another's text or control, tap targets under 40 px at a phone's
 * width, sizes off the 4 px grid or not whole pixels, text under WCAG AA contrast against its background, text under
 * 12 px, emoji and symbol glyphs used as icons, gradient text, uppercase labels, tight tracking on small text, long
 * lines, and how many font sizes, text colours, font families and icon sizes the page uses. Findings come grouped (the
 * same kind of element with the same numbers once, with a count) so the report stays short. Pi's browser runs the same
 * check (`browser_screenshot`, `browser_layout_check`).
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
    | { kind: "off-grid"; what: string; property: string; value: number; count: number }
    | { kind: "contrast"; what: string; color: string; background: string; ratio: number; needs: number; count: number }
    | { kind: "small-text"; what: string; size: number; count: number }
    | { kind: "emoji"; what: string; glyphs: string; count: number }
    | { kind: "gradient-text"; what: string; count: number }
    | { kind: "uppercase"; what: string; transform: string; tracking: number; count: number }
    | { kind: "tight-tracking"; what: string; size: number; tracking: number; count: number }
    | { kind: "long-lines"; what: string; chars: number; count: number };

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
};

/** Groups the page keeps of each kind; the words show fewer (`SHOWN`). */
const FINDS_KEPT = 20;
/** Groups shown in words, of each kind. */
const SHOWN = 3;
/** The narrowest tap target at a phone's width, and the widest screen that is a phone's. */
export const TAP_MIN = 40;
export const PHONE_MAX = 480;
/** The smallest text, in CSS pixels. */
export const TEXT_MIN = 12;

/**
 * The script for a page laid out `width` CSS pixels wide (the width asked for: a mobile page wider than its screen
 * stretches `innerWidth` to fit; the renderer's WebView is exactly as wide as asked, so it leaves it out), as one
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
 * background behind an element, and what a control is.
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
  const clips = (e) => { const s = css(e); return s.overflowX !== 'visible' || s.overflowY !== 'visible'; };
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
  const docW = Math.max(W, document.documentElement.scrollWidth);
  const shows = (e, r) => {
    const s = css(e);
    if (s.visibility === 'hidden' || s.visibility === 'collapse' || opacityOf(e) < 0.05) return false;
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
  // The background behind an element's text: its ancestors' colours, composited; a picture or gradient on the way is not measured.
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
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const CONTROL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[role=option],[role=radio],[tabindex]:not([tabindex="-1"])';
`;

export const layoutCheck = (width?: number) => String.raw`(() => {
  const W = ${width === undefined ? "innerWidth" : String(Math.round(width))}, VW = innerWidth, VH = innerHeight;
  const issues = [];
  let checked = 0, more = 0;
${PAGE_HELPERS}
  const clipsX = (e) => { const o = css(e).overflowX; return o !== 'visible'; };
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
  const offGrid = (e, property, v) => { v = r2(v); if (!onGrid(v)) group('off-grid', property + '|' + v, () => ({ what: name(e), property, value: v })); };
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
  const coveredBy = (target, x, y) => {
    if (x < 0 || y < 0 || x >= VW || y >= VH) return undefined;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === target || target.contains(hit) || hit.contains(target)) return null;
    if (hit.closest(LAYER) || !hides(hit, target)) return null;
    let layer = null;
    for (let a = hit; a && a !== document.body; a = a.parentElement) if (/fixed|absolute|sticky/.test(css(a).position)) { layer = a; break; }
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

  for (const e of document.body ? document.body.querySelectorAll('*') : []) {
    if (++checked > 4000) break;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const style = css(e);
    if (style.visibility === 'hidden' || style.display === 'contents') continue;
    const tag = e.tagName.toLowerCase();
    let sideways = false;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (clipsX(a)) { sideways = true; break; }
    if (!sideways) {
      if (style.overflowX === 'visible' && e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && !['svg', 'img', 'canvas', 'video', 'iframe'].includes(tag)) {
        add({ kind: 'spills', what: name(e), box: [Math.round(r.left), e.scrollWidth], limit: [Math.round(r.left), e.clientWidth] });
      }
      const p = e.parentElement;
      if (p && p !== document.body && style.position !== 'fixed' && style.position !== 'absolute') {
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
    if (tag === 'svg' && r.width <= 48 && r.height <= 48) {
      icons.add(r2(r.width) + 'x' + r2(r.height));
      if (style.stroke !== 'none' && style.strokeWidth) strokes.add(style.strokeWidth);
      if (Math.abs(r.width - Math.round(r.width)) > 0.01 || Math.abs(r.height - Math.round(r.height)) > 0.01) group('off-grid', 'icon|' + r2(r.width), () => ({ what: name(e), property: 'icon width', value: r2(r.width) }));
    }
    if ((style.webkitBackgroundClip === 'text' || style.backgroundClip === 'text') && style.backgroundImage !== 'none') group('gradient-text', sig(e), () => ({ what: name(e) }));
    if (['p', 'li', 'blockquote', 'dd'].includes(tag) && (e.textContent || '').length >= 200) long.push(e);
    if (e.matches(CONTROL)) {
      const inline = tag === 'a' && style.display === 'inline' && [...(e.parentElement ? e.parentElement.childNodes : [])].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      const nested = e.parentElement && e.parentElement.closest(CONTROL);
      const labelled = tag === 'input' && /checkbox|radio/.test(e.type) && e.labels && e.labels.length > 0;
      if (!inline && !nested && !labelled) {
        if (W <= ${PHONE_MAX} && (r.width < ${TAP_MIN} - 0.01 || r.height < ${TAP_MIN} - 0.01)) group('small-target', sig(e) + '|' + Math.round(r.width) + 'x' + Math.round(r.height), () => ({ what: name(e), size: [r1(r.width), r1(r.height)] }));
        offGrid(e, 'control height', r.height);
        if (style.pointerEvents !== 'none') {
          const by = coveredBy(e, r.left + r.width / 2, r.top + r.height / 2);
          if (by) group('covered', sig(e) + '|' + sig(by), () => ({ what: name(e), by: name(by), points: 1, of: 1 }));
        }
      }
    }
  }

  // Text: what each run of words shows, its size, colour and contrast, and what covers it.
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'option', 'title']);
  const EMOJI = /(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}\uFE0F?|[\u2713\u2717\u2718\u2605\u2606\u25A0-\u25FF]/gu;
  const walker = document.body ? document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT) : null;
  const range = document.createRange();
  let texts = 0;
  for (let node = walker ? walker.nextNode() : null; node && texts < 3000; node = walker.nextNode()) {
    const words = node.textContent.trim();
    const p = node.parentElement;
    if (!words || !p || SKIP.has(p.tagName.toLowerCase()) || p.closest('svg')) continue;
    const s = css(p);
    if (s.visibility !== 'visible' || opacityOf(p) < 0.05) continue;
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
    // Cut: the text runs past the nearest box that hides its overflow (a scroller is not a cut).
    const a = clipper(p);
    if (a) {
      const as = css(a), box = padBox(a);
      if (box.r - box.l > 2 && box.b - box.t > 2 && as.clip === 'auto' && as.clipPath === 'none') {
        const dx = Math.max(0, b.right - box.r) + Math.max(0, box.l - b.left), dy = Math.max(0, b.bottom - box.b) + Math.max(0, box.t - b.top);
        const ellipsis = as.textOverflow === 'ellipsis' || (as.webkitLineClamp && as.webkitLineClamp !== 'none');
        if (/hidden|clip/.test(as.overflowX) && dx > 2) group('cut', sig(a) + '|x|' + ellipsis, () => ({ what: name(a), axis: 'x', shown: Math.round(box.r - box.l), full: Math.round(b.width), ellipsis: !!ellipsis }));
        else if (/hidden|clip/.test(as.overflowY) && dy > size / 2) group('cut', sig(a) + '|y|' + ellipsis, () => ({ what: name(a), axis: 'y', shown: Math.round(box.b - box.t), full: Math.round(b.height), ellipsis: !!ellipsis }));
      }
    }
    // Covered: three points along its first line, where it shows.
    if (s.pointerEvents !== 'none') {
      const first = rects[0], v = meet(region, { l: first.left, t: first.top, r: first.right, b: first.bottom });
      if (!empty(v)) {
        let points = 0, of = 0, by = null;
        for (const f of [0.25, 0.5, 0.75]) {
          const hit = coveredBy(p, v.l + (v.r - v.l) * f, (v.t + v.b) / 2);
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
    // Contrast, WCAG AA: 4.5, or 3 for large text (24 px, or 18.66 px bold); disabled controls are exempt.
    const fill = colour(s.webkitTextFillColor || s.color);
    const under = backdrop(p);
    if (fill && fill[3] > 0.001) colours.add(hex(fill));
    if (fill && under && fill[3] > 0.001 && !p.closest('[disabled],[aria-disabled=true]')) {
      const ink = over([fill[0], fill[1], fill[2], fill[3] * opacityOf(p)], under);
      const hi = Math.max(lum(ink), lum(under)), lo = Math.min(lum(ink), lum(under));
      const ratio = (hi + 0.05) / (lo + 0.05);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      const needs = large ? 3 : 4.5;
      if (ratio < needs - 0.005) group('contrast', hex(ink) + '|' + hex(under) + '|' + needs, () => ({ what: name(p), color: hex(ink), background: hex(under), ratio: r2(ratio), needs }));
    }
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
  return JSON.stringify({ width: W, height: innerHeight, checked: Math.min(checked, 4000), issues, more, found, totals, summary });
})()`;

/** Each kind's heading, in the order the words give them. */
const KINDS: [LayoutFindKind, string][] = [
    ["cut", "Cut text"],
    ["covered", "Covered: an element on top of another's text or control"],
    ["small-target", `Tap targets under ${TAP_MIN} px`],
    ["contrast", "Text under WCAG AA contrast"],
    ["small-text", `Text under ${TEXT_MIN} px`],
    ["off-grid", "Sizes off the 4 px grid or not whole pixels"],
    ["emoji", "Emoji or symbols as icons"],
    ["gradient-text", "Gradient text"],
    ["uppercase", "Uppercase labels (not sentence case)"],
    ["tight-tracking", "Negative letter spacing on small text"],
    ["long-lines", "Long lines"],
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
            return `${find.what}: ${find.size[0]}×${find.size[1]} px${times}`;
        case "off-grid":
            return `${find.property} ${find.value} px: ${find.count} element${find.count === 1 ? "" : "s"}, such as ${find.what}`;
        case "contrast":
            return `${find.what}: ${find.color} on ${find.background}, ${find.ratio}:1 (needs ${find.needs})${times}`;
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

/** The report in words for Pi: one line when all is in place, else each issue with its numbers, grouped and capped. */
export function describeLayout(report: LayoutReport): string {
    const head = `Layout check at ${report.width} px (${report.checked} elements)`;
    const total = report.issues.length + report.more + Object.values(report.totals).reduce((sum, n) => sum + (n ?? 0), 0);
    const summary = summaryWords(report.summary);

    if (total === 0) {
        return [
            `${head}: nothing spills out of its box or its parent, the page is no wider than the screen, and no text is cut, covered, too small or too faint; tap targets and sizes are in order.`,
            ...(summary === undefined ? [] : [summary]),
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

    return lines.join("\n");
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

        if (value.width > width + 1 && !value.issues.some((issue) => issue.kind === "page-wider")) {
            return { ...value, width, issues: [...value.issues, { kind: "page-wider", what: "the page", box: [0, value.width], limit: [0, width] }] };
        }

        return value;
    } catch {
        return undefined;
    }
}
