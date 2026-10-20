/**
 * A measured layout check for screenshots (PP-10; the owner, 2026-10-20: "how can you make sure you don't miss that when
 * you verify?"). The renderer runs `LAYOUT_CHECK` in the page just before it draws it, and Pi gets numbers with the
 * picture: elements whose content spills out of their own box, elements that stick out of their parent's, and a page
 * that is wider than its viewport. A picture can mislead; sizes do not.
 */

/** One thing out of place: what it is, and the boxes that show it (x and width, CSS pixels). */
export type LayoutIssue = {
    kind: "spills" | "outside-parent" | "page-wider";
    what: string;
    box: [number, number];
    limit: [number, number];
};

export type LayoutReport = { width: number; height: number; checked: number; issues: LayoutIssue[]; more: number };

/**
 * The script for a page laid out `width` CSS pixels wide (the width asked for: a mobile page wider than its screen
 * stretches `innerWidth` to fit; the renderer's WebView is exactly as wide as asked, so it leaves it out), as one expression that returns the report as JSON text. Elements inside a box that scrolls or clips
 * sideways may run wider (a code block's long lines): only that box is checked. Fixed and absolutely placed elements
 * (menus, toasts) are left out of "outside its parent".
 */
export const layoutCheck = (width?: number) => `(() => {
  const W = ${width === undefined ? "innerWidth" : Math.round(width)}, issues = [];
  let checked = 0, more = 0;
  const name = (e) => {
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('') : '';
    const text = (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + cls + (text ? ' "' + text + '"' : '');
  };
  const clipsX = (e) => { const o = getComputedStyle(e).overflowX; return o !== 'visible'; };
  const add = (issue) => { if (issues.length < 12) issues.push(issue); else more++; };
  const round = (r) => [Math.round(r.left), Math.round(r.width)];
  for (const e of document.body ? document.body.querySelectorAll('*') : []) {
    if (++checked > 4000) break;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const style = getComputedStyle(e);
    if (style.visibility === 'hidden' || style.display === 'contents') continue;
    let inside = false;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (clipsX(a)) { inside = true; break; }
    if (inside) continue;
    if (style.overflowX === 'visible' && e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && !['svg', 'img', 'canvas', 'video', 'iframe'].includes(e.tagName.toLowerCase())) {
      add({ kind: 'spills', what: name(e), box: [Math.round(r.left), e.scrollWidth], limit: [Math.round(r.left), e.clientWidth] });
    }
    const p = e.parentElement;
    if (p && p !== document.body && style.position !== 'fixed' && style.position !== 'absolute') {
      const q = p.getBoundingClientRect();
      if (r.left < q.left - 1 || r.right > q.right + 1) add({ kind: 'outside-parent', what: name(e), box: round(r), limit: round(q) });
    }
  }
  const wide = document.documentElement.scrollWidth;
  if (wide > W + 1) add({ kind: 'page-wider', what: 'the page', box: [0, wide], limit: [0, W] });
  return JSON.stringify({ width: W, height: innerHeight, checked: Math.min(checked, 4000), issues, more });
})()`;

/** The report in words for Pi: one line when all is in place, else each issue with its numbers. */
export function describeLayout(report: LayoutReport): string {
    const head = `Layout check at ${report.width} px (${report.checked} elements)`;

    if (report.issues.length === 0) {
        return `${head}: nothing spills out of its box or its parent, and the page is no wider than the screen.`;
    }

    const words: Record<LayoutIssue["kind"], string> = {
        spills: "its content is wider than its box",
        "outside-parent": "sticks out of its parent",
        "page-wider": "is wider than the screen",
    };

    return [
        `${head}: ${report.issues.length + report.more} out of place.`,
        ...report.issues.map(
            (issue) =>
                `- ${issue.what}: ${words[issue.kind]} (${issue.kind === "spills" || issue.kind === "page-wider" ? `${issue.box[1]} px in ${issue.limit[1]}` : `x ${issue.box[0]}–${issue.box[0] + issue.box[1]} in x ${issue.limit[0]}–${issue.limit[0] + issue.limit[1]}`})`,
        ),
        ...(report.more > 0 ? [`- … and ${report.more} more`] : []),
    ].join("\n");
}

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

        if (typeof value.width !== "number" || !Array.isArray(value.issues)) {
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
