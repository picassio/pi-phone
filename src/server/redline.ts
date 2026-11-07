/**
 * Redlines (PP-398): a page measured from its DOM and the numbers drawn on its picture, as designers mark up a design.
 * The page runs `redlineScript` (in the screenshot tool's renderer, or in Pi's browser) and answers its blocks: their
 * boxes, padding, corner radii, the gap to the next block beside or below them, and the type of the words in them;
 * `planRedline` turns that into shapes (`markup.ts`'s `drawRedlines` draws them) and a legend of the values used, and,
 * given a spec (a design system's tokens.css, or a plain list such as "padding 16, radius 24/12/20, font 22/13/12"),
 * the values that are off it, in red with the spec's nearest value.
 *
 * Auto mode measures the page's main blocks: its surfaces (a background, a border or a shadow of their own) and its
 * controls; a selector measures the elements it finds. Coordinates are CSS pixels of the view the picture shows.
 */
import { PAGE_HELPERS, PHONE_MAX, TAP_MIN } from "./layout-check.ts";
import { drawRedlines } from "./markup.ts";

/** Most blocks a page answers, of each kind. */
const SURFACES = 24;
const CONTROLS = 24;
const CHOSEN = 40;
/** Most type styles labelled on the picture; the legend lists up to `TYPES_LISTED`. */
const TYPE_LABELS = 10;
const TYPES_LISTED = 8;
/** Most mismatches named in words. */
const MISSES_SHOWN = 20;

/** A box: x, y, width, height in CSS pixels. */
export type Box = [number, number, number, number];

export type TypeStyle = { size: number; weight: number; line: number | null; color: string; what: string; box: Box; count: number };

export type RedlineBlock = {
    what: string;
    kind: "surface" | "control" | "chosen";
    box: Box;
    /** Top, right, bottom, left. */
    padding: [number, number, number, number];
    border: [number, number, number, number];
    /** Top left, top right, bottom right, bottom left. */
    radius: [number, number, number, number];
    pill: boolean;
    /** A control (a button, a link, a field): its size is a tap target. */
    control?: boolean;
    /** To the next sibling beside or below it, and the space between them; `auto` where the layout spreads it. */
    gap?: { axis: "x" | "y"; value: number; area: Box; auto?: boolean };
    type?: Omit<TypeStyle, "count" | "what">;
};

export type RedlineMeasure = {
    width: number;
    height: number;
    mode: "auto" | "selector";
    selector?: string;
    /** The sheet or dialog open over the page that auto mode measured instead of the page under it. */
    layer?: string;
    blocks: RedlineBlock[];
    types: TypeStyle[];
    found: number;
};

/**
 * The script that measures a page laid out `width` CSS pixels wide (when not given, the root's clientWidth: a phone
 * page wider than its screen stretches innerWidth to its content, 616 in a 412 px view, PP-424), as one expression that
 * returns its JSON text. `selector`: the elements to measure instead of the main blocks.
 */
export const redlineScript = ({ width, selector }: { width?: number; selector?: string } = {}) => String.raw`(() => {
  const W = ${width === undefined ? "Math.min(innerWidth, document.documentElement.clientWidth || innerWidth)" : String(Math.round(width))}, VW = innerWidth, VH = innerHeight;
  const SELECTOR = ${JSON.stringify(selector ?? null)};
${PAGE_HELPERS}
  const box = (r) => [r1(r.left), r1(r.top), r1(r.width), r1(r.height)];
  const placed = (e) => { const r = e.getBoundingClientRect(), s = css(e); return r.width >= 1 && r.height >= 1 && !/absolute|fixed/.test(s.position) && shows(e, r); };
  const firstText = (e) => {
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(), k = 0; n && k < 200; n = walker.nextNode(), k++) {
      if (!n.textContent.trim() || !n.parentElement || /^(script|style|noscript|template)$/i.test(n.parentElement.tagName)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const q = [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0);
      if (q && shows(n.parentElement, n.parentElement.getBoundingClientRect())) return { node: n, rect: q };
    }
    return null;
  };
  const typeOf = (p, rect) => {
    const s = css(p), c = colour(s.color);
    const line = s.lineHeight === 'normal' ? null : r1(px(s.lineHeight));
    return { size: r1(px(s.fontSize)), weight: Number(s.fontWeight), line, color: c ? hex(c) : s.color, box: box(rect) };
  };
  const block = (e, kind) => {
    const r = e.getBoundingClientRect(), s = css(e);
    const radius = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map((v) => v.includes('%') ? r1(parseFloat(v) / 100 * Math.min(r.width, r.height)) : r1(px(v)));
    const out = {
      what: name(e), kind, box: box(r),
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map((v) => r2(px(v))),
      border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map((v) => r2(px(v))),
      radius, pill: Math.max(...radius) >= Math.min(r.width, r.height) / 2 - 0.5, control: e.matches(CONTROL),
    };
    // The gap to the next block: not across words between them (inline code in a sentence), and "auto" where the
    // layout spreads the space (justify-content, or an auto margin), as no spacing token sets it.
    // An empty filler between them (flex: 1) spreads the space too.
    let n = e.nextElementSibling, words = false, filler = false;
    while (n && !placed(n)) { if (Number(css(n).flexGrow) > 0) filler = true; n = n.nextElementSibling; }
    for (let k = e.nextSibling; n && k && k !== n; k = k.nextSibling) if (k.nodeType === 3 && k.textContent.trim() !== '') words = true;
    if (n && !words && !/absolute|fixed/.test(s.position)) {
      const q = n.getBoundingClientRect();
      const across = Math.min(r.right, q.right) - Math.max(r.left, q.left), along = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
      const margin = (el, side) => { try { return String(el.computedStyleMap().get('margin-' + side)) === 'auto'; } catch { return false; } };
      const spread = filler || (/space-|center|end|right/.test(css(e.parentElement).justifyContent) && /flex|grid/.test(css(e.parentElement).display));
      if (q.top >= r.bottom - 0.5 && across > 0) out.gap = { axis: 'y', value: r2(Math.max(0, q.top - r.bottom)), area: [r1(Math.max(r.left, q.left)), r1(r.bottom), r1(across), r1(Math.max(0, q.top - r.bottom))], auto: spread || margin(e, 'bottom') || margin(n, 'top') };
      else if (q.left >= r.right - 0.5 && along > 0) out.gap = { axis: 'x', value: r2(Math.max(0, q.left - r.right)), area: [r1(r.right), r1(Math.max(r.top, q.top)), r1(Math.max(0, q.left - r.right)), r1(along)], auto: spread || margin(e, 'right') || margin(n, 'left') };
    }
    const t = firstText(e);
    if (t) out.type = typeOf(t.node.parentElement, t.rect);
    return out;
  };
  // A sheet or dialog open over the page (a modal: dialog:modal, aria-modal): auto mode measures that top layer only, not
  // the page under its backdrop. The topmost is the one whose middle shows at its middle; else the last open.
  const modal = (e) => { try { if (e.matches('dialog:modal')) return true; } catch {} return e.getAttribute('aria-modal') === 'true'; };
  const layers = document.body ? [...document.body.querySelectorAll('dialog, [aria-modal="true"]')].filter((e) => modal(e) && shows(e, e.getBoundingClientRect())) : [];
  let top = null;
  for (const e of [...layers].reverse()) {
    const r = e.getBoundingClientRect(), hit = document.elementFromPoint(Math.min(VW - 1, Math.max(0, r.left + r.width / 2)), Math.min(VH - 1, Math.max(0, r.top + r.height / 2)));
    if (hit && e.contains(hit)) { top = e; break; }
  }
  if (!top && layers.length > 0) top = layers[layers.length - 1];
  const scope = SELECTOR === null && top ? top : document.body;
  const all = scope ? [...(scope === document.body ? [] : [scope]), ...scope.querySelectorAll('*')].slice(0, 4000) : [];
  const page = Math.max(W, document.documentElement.scrollWidth) * Math.max(VH, document.documentElement.scrollHeight);
  let blocks = [], found = 0;
  if (SELECTOR !== null) {
    const chosen = [...document.querySelectorAll(SELECTOR)].filter((e) => shows(e, e.getBoundingClientRect()));
    found = chosen.length;
    blocks = chosen.slice(0, ${CHOSEN}).map((e) => block(e, 'chosen'));
  } else {
    const surfaces = [], controls = [];
    for (const e of all) {
      const r = e.getBoundingClientRect();
      if (r.width < 16 || r.height < 12 || !shows(e, r) || e.closest('svg') || r.width * r.height > 0.9 * page) continue;
      if (e.parentElement && e.parentElement.closest(CONTROL)) continue;
      if (e.matches(CONTROL)) { controls.push(e); continue; }
      const s = css(e), bg = colour(s.backgroundColor), under = backdrop(e.parentElement);
      const own = bg && bg[3] > 0.05 && (!under || hex(over(bg, under)) !== hex(under));
      const lined = ['Top', 'Right', 'Bottom', 'Left'].some((side) => { const w = px(s['border' + side + 'Width']), c = colour(s['border' + side + 'Color']); return w >= 1 && c && c[3] > 0.05; });
      if (own || lined || s.boxShadow !== 'none' || s.backgroundImage !== 'none') surfaces.push(e);
    }
    found = surfaces.length + controls.length;
    const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
    blocks = [...surfaces.sort((a, b) => area(b) - area(a)).slice(0, ${SURFACES}).map((e) => block(e, 'surface')), ...controls.slice(0, ${CONTROLS}).map((e) => block(e, 'control'))];
  }
  // Type: each style of the words that show, how often, and where it first shows.
  const types = new Map();
  const walker = scope ? document.createTreeWalker(scope, NodeFilter.SHOW_TEXT) : null;
  const range = document.createRange();
  let texts = 0;
  for (let node = walker ? walker.nextNode() : null; node && texts < 3000; node = walker.nextNode()) {
    const p = node.parentElement;
    if (!node.textContent.trim() || !p || /^(script|style|noscript|template|textarea|option|title)$/i.test(p.tagName) || p.closest('svg')) continue;
    if (!shows(p, p.getBoundingClientRect())) continue;
    range.selectNodeContents(node);
    const q = [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0);
    if (!q || empty(meet(inside(p), { l: q.left, t: q.top, r: q.right, b: q.bottom }))) continue;
    texts++;
    const t = typeOf(p, q), key = t.size + '|' + t.weight + '|' + t.line + '|' + t.color;
    const had = types.get(key);
    if (had) had.count++; else types.set(key, Object.assign(t, { what: name(p), count: 1 }));
  }
  return JSON.stringify({ width: W, height: Math.max(VH, document.documentElement.scrollHeight), mode: SELECTOR === null ? 'auto' : 'selector', selector: SELECTOR === null ? undefined : SELECTOR, layer: scope && scope !== document.body ? name(scope) : undefined, blocks, types: [...types.values()].sort((a, b) => b.count - a.count).slice(0, 30), found });
})()`;

/** The page's measure, checked: undefined when the text is not one. */
export function parseRedline(text: unknown): RedlineMeasure | undefined {
    if (typeof text !== "string") {
        return undefined;
    }

    try {
        const value = JSON.parse(text) as RedlineMeasure;

        return typeof value.width === "number" && Array.isArray(value.blocks) && Array.isArray(value.types) ? value : undefined;
    } catch {
        return undefined;
    }
}

/** What a spec allows, by property; a property it leaves out is not checked. */
export type RedlineSpec = { source: string; padding?: number[]; gap?: number[]; radius?: number[]; font?: number[]; weight?: number[]; line?: number[]; target?: number };

const SPEC_KEYS: Record<string, (keyof RedlineSpec)[]> = {
    padding: ["padding"],
    gap: ["gap"],
    spacing: ["padding", "gap"],
    space: ["padding", "gap"],
    radius: ["radius"],
    radii: ["radius"],
    font: ["font"],
    size: ["font"],
    text: ["font"],
    weight: ["weight"],
    line: ["line"],
    "line-height": ["line"],
    leading: ["line"],
    target: ["target"],
};

const addValues = (spec: RedlineSpec, keys: (keyof RedlineSpec)[], values: number[]) => {
    for (const key of keys) {
        if (key === "target") {
            spec.target = values[0];
        } else if (key !== "source") {
            spec[key] = [...new Set([...(spec[key] ?? []), ...values])].sort((a, b) => a - b);
        }
    }
};

/**
 * A spec from a plain list ("padding 16, gap 8/16, radius 24/12/20, font 22/13/12, weight 400/500, line 20, target
 * 44"; "spacing" sets padding and gap) or from a design system's tokens.css (`--space-*`, `--radius-*`, `--text-*`,
 * `--leading-*` in px, `--weight-*`; px and rem at 16 px, `var()` followed). A name it does not know, or a file with
 * none of these, fails saying so.
 */
export function parseSpec(text: string, source: string): RedlineSpec {
    const spec: RedlineSpec = { source };

    if (/--[\w-]+\s*:/.test(text)) {
        const tokens = new Map<string, string>();

        for (const match of text.matchAll(/--([\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
            tokens.set(match[1]!, match[2]!.trim());
        }

        const valueOf = (raw: string, depth = 0): number | undefined => {
            const named = /^var\(--([\w-]+)\)$/.exec(raw);

            if (named !== null) {
                const next = tokens.get(named[1]!);

                return next === undefined || depth > 8 ? undefined : valueOf(next, depth + 1);
            }

            const number = /^(-?[\d.]+)(px|rem)?$/.exec(raw);

            return number === null ? undefined : Number(number[1]) * (number[2] === "rem" ? 16 : 1);
        };

        for (const [name, raw] of tokens) {
            const value = valueOf(raw);
            const key = /^(space|spacing|gap)-/.test(name)
                ? "spacing"
                : /^radius-/.test(name)
                  ? "radius"
                  : /^(text|font-size|fs)-/.test(name)
                    ? "font"
                    : /^(leading|line-height)-/.test(name) && /px$/.test(raw)
                      ? "line"
                      : /^(weight|font-weight)-/.test(name)
                        ? "weight"
                        : undefined;

            // A pill's 9999px is no size to match: pills pass anyway.
            if (key === undefined || value === undefined || (key === "radius" && value >= 999)) {
                continue;
            }

            addValues(spec, SPEC_KEYS[key]!, [value]);
        }

        if (spec.padding === undefined && spec.radius === undefined && spec.font === undefined) {
            throw new Error(`${source} has no spacing, radius or type tokens (--space-*, --radius-*, --text-*) in px or rem.`);
        }

        return spec;
    }

    for (const part of text.split(/[,;\n]+/).map((each) => each.trim()).filter(Boolean)) {
        const match = /^([a-z-]+)\s*:?\s*(.+)$/i.exec(part);
        const keys = match === null ? undefined : SPEC_KEYS[match[1]!.toLowerCase()];

        if (match === null || keys === undefined) {
            throw new Error(`"${part}" is not a spec entry: write a name and its values, such as "padding 16", "gap 8/16", "radius 24/12/20", "font 22/13/12", "weight 400/500", "line 20", "spacing 4/8/16", "target 44".`);
        }

        const values = match[2]!.split(/[\s/|]+/).filter(Boolean).map((value) => Number(value.replace(/px$/i, "")));

        if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
            throw new Error(`"${part}" has a value that is not a number of pixels.`);
        }

        addValues(spec, keys, values);
    }

    if (Object.keys(spec).length === 1) {
        throw new Error("The spec is empty: give values, such as \"padding 16, radius 24/12/20, font 22/13/12\".");
    }

    return spec;
}

type RGB = [number, number, number];

/** The redlines' colours, as designers use them: padding green, gaps magenta, radii blue, sizes orange, type purple, off the spec red. */
export const REDLINE_COLORS: Record<"padding" | "gap" | "radius" | "size" | "type" | "off", RGB> = {
    padding: [46, 160, 67],
    gap: [216, 27, 196],
    radius: [30, 136, 229],
    size: [230, 120, 0],
    type: [142, 68, 173],
    off: [229, 57, 53],
};

/** What `drawRedlines` draws, in CSS pixels of the page's view. */
export type RedlineShape =
    | { kind: "fill"; box: Box; color: RGB; alpha: number }
    | { kind: "frame"; box: Box; color: RGB }
    /**
     * A number on a coloured tag: centred on the point, its top left on it (corner), its bottom right (end), or its
     * bottom left (above: over a line of text, not on it); `first` ones are placed before the rest, which make way.
     */
    | { kind: "label"; x: number; y: number; text: string; color: RGB; arc?: boolean; anchor: "center" | "corner" | "end" | "above"; first?: boolean };

export type LegendLine = { color: RGB; text: string };

export type RedlineMiss = { what: string; property: string; value: number; spec: number };

export type RedlinePlan = { shapes: RedlineShape[]; legend: LegendLine[]; misses: RedlineMiss[]; targets: number };

const n = (value: number) => String(Math.round(value * 10) / 10);
const typeWords = (type: { size: number; weight: number; line: number | null; color: string }) =>
    `${n(type.size)}/${type.line === null ? "normal" : n(type.line)} ${type.weight} ${type.color}`;

/** The spec's nearest value to `value` (other than none); undefined when it allows it (within half a pixel), or does not say. */
function offSpec(allowed: number[] | undefined, value: number, zero: boolean): number | undefined {
    if (allowed === undefined || allowed.length === 0 || (zero && value < 0.5) || allowed.some((each) => Math.abs(each - value) < 0.5)) {
        return undefined;
    }

    const sizes = allowed.filter((each) => each > 0);

    return (sizes.length === 0 ? allowed : sizes).reduce((best, each) => (Math.abs(each - value) < Math.abs(best - value) ? each : best));
}

/**
 * The shapes for a page's measure, the legend of the values it uses, and, with a spec, what is off it. `view`: the
 * part of the page the picture shows (CSS pixels from its top left); blocks wholly outside it are left out.
 */
export function planRedline(measure: RedlineMeasure, spec: RedlineSpec | undefined, view: { width: number; height: number }): RedlinePlan {
    const shapes: RedlineShape[] = [];
    const misses: RedlineMiss[] = [];
    const used = { gap: new Set<number>(), padding: new Set<number>(), radius: new Set<string>() };
    const phone = measure.width <= PHONE_MAX;
    const minTarget = spec?.target ?? TAP_MIN;
    let targets = 0;
    const inView = (box: Box) => box[0] < view.width && box[1] < view.height && box[0] + box[2] > 0 && box[1] + box[3] > 0;
    // Against a spec the picture numbers only what is off it (the strips keep their colours); the legend has the rest.
    const quiet = spec !== undefined;
    // One element's padding of 6 on two sides is one miss.
    let named = new Set<string>();
    const miss = (what: string, property: string, value: number, allowed: number[] | undefined, zero = true): number | undefined => {
        const nearest = offSpec(allowed, value, zero);

        if (nearest !== undefined && !named.has(`${property}|${value}`)) {
            named.add(`${property}|${value}`);
            misses.push({ what, property, value, spec: nearest });
        }

        return nearest;
    };

    for (const block of measure.blocks.filter((each) => inView(each.box))) {
        named = new Set();
        const [x, y, w, h] = block.box;
        const [bt, br, bb, bl] = block.border;
        const [pt, pr, pb, pl] = block.padding;

        shapes.push({ kind: "frame", box: block.box, color: REDLINE_COLORS.size });

        // Padding: a green strip inside each edge, numbered on the top and left, and on the bottom and right when they differ.
        const strips: [number, Box, boolean][] = [
            [pt, [x + bl, y + bt, w - bl - br, pt], true],
            [pl, [x + bl, y + bt, pl, h - bt - bb], true],
            [pb, [x + bl, y + h - bb - pb, w - bl - br, pb], Math.abs(pb - pt) >= 0.5],
            [pr, [x + w - br - pr, y + bt, pr, h - bt - bb], Math.abs(pr - pl) >= 0.5],
        ];

        for (const [value, area, numbered] of strips) {
            if (value < 0.5) {
                continue;
            }

            used.padding.add(Math.round(value * 10) / 10);
            const off = miss(block.what, "padding", value, spec?.padding);

            shapes.push({ kind: "fill", box: area, color: off === undefined ? REDLINE_COLORS.padding : REDLINE_COLORS.off, alpha: 0.32 });

            if ((numbered && !quiet) || off !== undefined) {
                shapes.push({
                    kind: "label",
                    x: area[0] + area[2] / 2,
                    y: area[1] + area[3] / 2,
                    text: off === undefined ? n(value) : `padding ${n(value)}, spec ${n(off)}`,
                    color: off === undefined ? REDLINE_COLORS.padding : REDLINE_COLORS.off,
                    anchor: "center",
                    first: off !== undefined,
                });
            }
        }

        if (block.gap !== undefined && block.gap.value >= 0.5) {
            const { value, area } = block.gap;
            // Space the layout spreads (justify-content, an auto margin) is no spacing value: drawn, said, not checked.
            const spread = block.gap.auto === true;

            if (!spread) {
                used.gap.add(Math.round(value * 10) / 10);
            }

            const off = spread ? undefined : miss(block.what, "gap", value, spec?.gap);
            const color = off === undefined ? REDLINE_COLORS.gap : REDLINE_COLORS.off;

            shapes.push({ kind: "fill", box: area, color, alpha: spread ? 0.2 : 0.45 });

            if (!quiet || off !== undefined) {
                shapes.push({
                    kind: "label",
                    x: area[0] + area[2] / 2,
                    y: area[1] + area[3] / 2,
                    text: off !== undefined ? `gap ${n(value)}, spec ${n(off)}` : spread ? `${n(value)} auto` : n(value),
                    color,
                    anchor: "center",
                    first: off !== undefined,
                });
            }
        }

        const corners = [...new Set(block.radius.map((each) => Math.round(each * 10) / 10))];

        if (block.pill) {
            used.radius.add("pill");

            if (!quiet) {
                shapes.push({ kind: "label", x, y, text: "pill", color: REDLINE_COLORS.radius, arc: true, anchor: "corner" });
            }
        } else if (corners.some((each) => each >= 0.5)) {
            for (const each of corners) {
                used.radius.add(n(each));
            }

            const offs = corners.map((each) => miss(block.what, "radius", each, spec?.radius));
            const off = offs.find((each) => each !== undefined);
            const text = corners.length === 1 ? n(corners[0]!) : block.radius.map(n).join("/");

            if (!quiet || off !== undefined) {
                shapes.push({
                    kind: "label",
                    x,
                    y,
                    text: off === undefined ? text : `${text}, spec ${n(off)}`,
                    color: off === undefined ? REDLINE_COLORS.radius : REDLINE_COLORS.off,
                    arc: true,
                    anchor: "corner",
                    first: off !== undefined,
                });
            }
        }

        // Sizes: of controls (a tap target under the minimum on a phone in red), and of the elements a selector chose.
        if (block.kind !== "surface") {
            const small = (block.kind === "control" || block.control === true) && phone && (w < minTarget - 0.01 || h < minTarget - 0.01);

            if (small) {
                targets++;
            }

            if (quiet && !small) {
                continue;
            }

            shapes.push({
                kind: "label",
                x: x + w,
                y: y + h,
                text: `${n(w)}x${n(h)}${small ? ` < ${minTarget}` : ""}`,
                color: small ? REDLINE_COLORS.off : REDLINE_COLORS.size,
                anchor: "end",
                first: small,
            });
        }
    }

    // Type: a label on where each style first shows, the most used first; the spec's sizes, weights and line heights.
    let typeLabels = 0;
    const types = typesOf(measure);

    named = new Set();

    for (const type of types) {
        const offSize = miss(type.what, "font size", type.size, spec?.font, false);
        const offWeight = miss(type.what, "font weight", type.weight, spec?.weight, false);
        const offLine = type.line === null ? undefined : miss(type.what, "line height", type.line, spec?.line, false);
        const off = [offSize === undefined ? "" : `size spec ${n(offSize)}`, offWeight === undefined ? "" : `weight spec ${offWeight}`, offLine === undefined ? "" : `line spec ${n(offLine)}`].filter(Boolean);

        // The most used styles, or (against a spec) the ones off it; a few, so they stay readable.
        if (typeLabels < TYPE_LABELS && (quiet ? off.length > 0 : true) && inView(type.box)) {
            typeLabels++;
            shapes.push({
                kind: "label",
                x: type.box[0],
                y: type.box[1],
                text: off.length === 0 ? typeWords(type) : `${typeWords(type)}, ${off.join(", ")}`,
                color: off.length === 0 ? REDLINE_COLORS.type : REDLINE_COLORS.off,
                anchor: "above",
                first: off.length > 0,
            });
        }
    }

    const sorted = (values: Set<number>) => [...values].sort((a, b) => a - b).map(n).join(", ");
    const radii = [...used.radius].sort((a, b) => (a === "pill" ? 1 : b === "pill" ? -1 : Number(a) - Number(b))).join(", ");
    const legend: LegendLine[] = [
        ...(used.gap.size > 0 ? [{ color: REDLINE_COLORS.gap, text: `Spacing (gaps) ${sorted(used.gap)}` }] : []),
        ...(used.padding.size > 0 ? [{ color: REDLINE_COLORS.padding, text: `Padding ${sorted(used.padding)}` }] : []),
        ...(used.radius.size > 0 ? [{ color: REDLINE_COLORS.radius, text: `Radius ${radii}` }] : []),
        ...(types.length > 0 ? [{ color: REDLINE_COLORS.type, text: `Type ${types.slice(0, TYPES_LISTED).map(typeWords).join("; ")}` }] : []),
        ...(phone && measure.blocks.some((block) => block.kind === "control") ? [{ color: targets > 0 ? REDLINE_COLORS.off : REDLINE_COLORS.size, text: `Tap targets under ${minTarget} px: ${targets}` }] : []),
        ...(spec === undefined ? [] : [{ color: misses.length > 0 ? REDLINE_COLORS.off : REDLINE_COLORS.padding, text: `Against the spec: ${misses.length} off` }]),
    ];

    return { shapes, legend, misses, targets };
}

/** The type styles a measure is about: the page's, or with a selector those of the elements it chose (the first words of each). */
export function typesOf(measure: RedlineMeasure): TypeStyle[] {
    if (measure.mode !== "selector") {
        return measure.types;
    }

    const styles = new Map<string, TypeStyle>();

    for (const block of measure.blocks) {
        if (block.type === undefined) {
            continue;
        }

        const key = `${block.type.size}|${block.type.weight}|${block.type.line}|${block.type.color}`;
        const had = styles.get(key);

        if (had === undefined) {
            styles.set(key, { ...block.type, what: block.what, count: 1 });
        } else {
            had.count++;
        }
    }

    return [...styles.values()].sort((a, b) => b.count - a.count);
}

/** What the spec checks, in words. */
const specWords = (spec: RedlineSpec) =>
    [
        spec.padding === undefined ? "" : `padding ${spec.padding.join("/")}`,
        spec.gap === undefined ? "" : `gap ${spec.gap.join("/")}`,
        spec.radius === undefined ? "" : `radius ${spec.radius.join("/")}`,
        spec.font === undefined ? "" : `font ${spec.font.join("/")}`,
        spec.weight === undefined ? "" : `weight ${spec.weight.join("/")}`,
        spec.line === undefined ? "" : `line ${spec.line.join("/")}`,
        spec.target === undefined ? "" : `target ${spec.target}`,
    ]
        .filter(Boolean)
        .join("; ");

/** The redlines in words for Pi: what was measured, the legend, and what is off the spec. */
export function describeRedline(measure: RedlineMeasure, plan: RedlinePlan, spec: RedlineSpec | undefined): string {
    const kinds = measure.mode === "selector"
        ? `${measure.blocks.length} of the ${measure.found} elements ${measure.selector} finds`
        : `${measure.blocks.filter((block) => block.kind === "surface").length} surfaces and ${measure.blocks.filter((block) => block.kind === "control").length} controls (the main blocks${measure.layer === undefined ? "" : ` of the top layer, ${measure.layer}; the page under it is left out`})`;
    const lines = [`Redlines at ${measure.width} px: ${kinds}; ${typesOf(measure).length} type styles.`, ...plan.legend.map((line) => `- ${line.text}`)];

    if (spec !== undefined) {
        // Elements alike (the rail's buttons) with the same miss are one line, with a count.
        const grouped = new Map<string, number>();

        for (const each of plan.misses) {
            const line = `${each.what}: ${each.property} ${n(each.value)}, spec ${n(each.spec)}`;

            grouped.set(line, (grouped.get(line) ?? 0) + 1);
        }

        const shown = [...grouped].slice(0, MISSES_SHOWN);
        const rest = plan.misses.length - shown.reduce((sum, [, count]) => sum + count, 0);

        lines.push(
            plan.misses.length === 0 ? `Everything measured matches the spec (${spec.source}: ${specWords(spec)}).` : `Off the spec (${spec.source}: ${specWords(spec)}), ${plan.misses.length}:`,
            ...shown.map(([line, count]) => `- ${line}${count > 1 ? ` (×${count})` : ""}`),
            ...(rest > 0 ? [`- and ${rest} more`] : []),
        );
    }

    return lines.join("\n");
}

/**
 * The spec a tool was given: a tokens.css file's path (read with `read`), or a plain list. None: no spec, auto values
 * only.
 */
export async function specFrom(given: string | undefined, read: (path: string) => Promise<string>): Promise<RedlineSpec | undefined> {
    const text = given?.trim() ?? "";

    if (text === "") {
        return undefined;
    }

    return /\.css$/i.test(text) && !/[\n,;]/.test(text) ? parseSpec(await read(text), text) : parseSpec(text, "the spec given");
}

/**
 * A page's picture with its redlines: each part (a tall page comes in parts, `top` CSS pixels down the page, at
 * `cssWidth` CSS pixels wide) drawn on, the legend under the last; and the words for Pi.
 */
export function redlinePictures(
    parts: { bytes: Uint8Array; top: number }[],
    measure: RedlineMeasure,
    spec: RedlineSpec | undefined,
    { cssWidth, cssHeight, png }: { cssWidth: number; cssHeight: number; png: boolean },
): { pictures: Uint8Array[]; text: string } {
    const plan = planRedline(measure, spec, { width: cssWidth, height: cssHeight });
    let dropped = 0;
    const pictures = parts.map((part, index) => {
        const drawn = drawRedlines(part.bytes, plan.shapes, index === parts.length - 1 ? plan.legend : [], { png, cssWidth, top: part.top });

        dropped += drawn.dropped;

        return drawn.bytes;
    });
    const text = describeRedline(measure, plan, spec);

    return { pictures, text: dropped === 0 ? text : `${text}\n(${dropped} numbers had no room on the picture; a selector shows fewer blocks at a time.)` };
}

/** What a picture with no page behind it gets. */
export const NO_DOM =
    "A picture has no page to measure: redlines need the page itself (an artifact, its HTML file, a URL, or Pi's browser's page with browser_redline). To check a picture against a reference picture, use image_compare.";

/** Whether a path names a picture file rather than a page. */
export const isPicturePath = (path: string) => /\.(png|jpe?g|webp|gif|bmp|heic|avif)$/i.test(path);
