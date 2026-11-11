// The measured layout check screenshots carry (src/server/layout-check.ts), run in a real Chrome (CI has one): a page
// in place reports nothing; a code block whose long lines scroll inside it is in place; a box whose content spills, a
// child that sticks out of its parent, and a page wider than the screen are reported, with their sizes. Since PP-395 a
// page with one fault each: text cut by its box (an ellipsis, lines cut at the bottom), an element over a button, a
// small tap target, sizes off the 4 px grid, faint text, small text, emoji as icons, gradient text, uppercase labels,
// tight tracking and long lines; a sheet over the page is no overlap. Pi's browser gives the same check.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
import { describeLayout, type LayoutFind, layoutCheck, type LayoutReport, parseLayout } from "../src/server/layout-check.ts";

after(() => cleanUp());

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const skip = chrome === undefined ? "no Chrome on this machine (CI runs it)" : false;

/**
 * auton-ui's doctor fixtures (PP-430; /home/ubuntu/frontend-design/scripts/doctor-selftest.mjs on the owner's devbox),
 * as they are: 10 that must be found, 9 that must pass (19 since PP-432 added the corner bleed pair). Its kinds by
 * pi-phone's names: side-stripe is side-tab.
 */
const card = "border:1px solid #ddd;background:#fff;border-radius:12px;padding:16px;width:300px;height:80px";
const AUTON: { name: string; html: string; want: LayoutFind["kind"][] }[] = [
    { name: "border-left stripe on a rounded card", html: `<div style="${card};border-left:3px solid #d97706">Pending</div>`, want: ["side-tab"] },
    { name: "inset-shadow stripe on a rounded card", html: `<div style="${card};box-shadow:inset 3px 0 0 #2563eb">Running</div>`, want: ["side-tab"] },
    { name: "::before bar on a rounded card", html: `<style>.q{position:relative}.q::before{content:"";position:absolute;left:8px;top:8px;bottom:8px;width:2px;background:#2563eb}</style><div class="q" style="${card}">Quote</div>`, want: ["side-tab"] },
    { name: "blockquote rule (no radius, no fill) passes", html: `<blockquote style="border-left:2px solid #999;padding-left:12px;margin:0">A quote</blockquote>`, want: [] },
    { name: "a plain neutral hairline card passes", html: `<div style="${card}">Fine</div>`, want: [] },
    { name: "purple gradient card", html: `<div style="${card};background:linear-gradient(135deg,#667eea,#764ba2)">Hero</div>`, want: ["gradient"] },
    { name: "allowed gradient (data-allow-gradient) passes", html: `<div data-allow-gradient style="width:300px;height:48px;background:linear-gradient(to top,#f8f8f8,transparent)"></div>`, want: [] },
    { name: "gradient text", html: `<h1 style="background:linear-gradient(90deg,#6366f1,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent;width:300px">Supercharge</h1>`, want: ["gradient-text"] },
    { name: "coloured glow", html: `<div style="${card};box-shadow:0 0 20px rgba(139,92,246,.5)">Glow</div>`, want: ["glow"] },
    { name: "neutral drop shadow passes", html: `<div style="${card};box-shadow:0 4px 12px rgba(0,0,0,.08)">Lift</div>`, want: [] },
    { name: "same radius nested with a 4px gap", html: `<div style="display:flex;width:240px;height:44px;padding:4px;border:1px solid #ddd;border-radius:12px;background:#f2f2f2"><div style="width:120px;border-radius:12px;background:#fff"></div></div>`, want: ["concentric"] },
    { name: "concentric pair (20 = 15 + 4 + 1) passes", html: `<div style="display:flex;width:240px;height:44px;padding:4px;border:1px solid #ddd;border-radius:20px;background:#f2f2f2"><div style="width:120px;border-radius:15px;background:#fff"></div></div>`, want: [] },
    { name: "pill in a pill passes (radii clamp to half the height)", html: `<div style="display:flex;width:240px;height:44px;padding:4px;border:1px solid #ddd;border-radius:999px;background:#f2f2f2"><div style="width:120px;border-radius:999px;background:#fff"></div></div>`, want: [] },
    { name: "wide padding reads as separate surfaces", html: `<div style="width:300px;padding:20px;border:1px solid #ddd;border-radius:16px;background:#fff"><div style="height:60px;border-radius:16px;background:#f2f2f2"></div></div>`, want: [] },
    { name: "proportional digits in a table cell", html: `<table><tbody><tr><td style="font-family:sans-serif">48,213</td></tr></tbody></table>`, want: ["tabular"] },
    { name: "tabular digits in a table cell pass", html: `<table><tbody><tr><td style="font-family:sans-serif;font-variant-numeric:tabular-nums">48,213</td></tr></tbody></table>`, want: [] },
    { name: "a timer without tabular-nums", html: `<span role="timer" style="font-family:sans-serif">03:40</span>`, want: ["tabular"] },
    { name: "square progress fill in a rounded bar", html: `<div style="position:relative;width:200px;height:24px;border:1px solid #999;border-radius:12px;background:#f8f8f8"><span style="position:absolute;top:0;bottom:0;left:0;width:30px;border-radius:4px 0 0 4px;background:#fde4dc"></span></div>`, want: ["corner-bleed"] },
    { name: "fill clipped by an overflow-hidden bar passes", html: `<div style="position:relative;width:200px;height:24px;border:1px solid #999;border-radius:12px;background:#f8f8f8;overflow:hidden"><span style="position:absolute;top:0;bottom:0;left:0;width:30px;background:#fde4dc"></span></div>`, want: [] },
];
/**
 * PP-432's concentric thresholds: corners of 4 px or less on both have no curve to see; a fixed child is not nested in
 * the box it sits over (left out before too, its test guards that); a placed (absolute) child is checked now. A footer
 * whose only paint is a divider along its top, flush at a card's bottom, paints nothing in the card's corners (the
 * board's task cards).
 */
const THRESHOLDS: { name: string; html: string; want: LayoutFind["kind"][] }[] = [
    { name: "2 px in 2 px with a 4 px gap passes", html: `<div style="display:flex;width:240px;height:44px;padding:4px;border:1px solid #ddd;border-radius:2px;background:#f2f2f2"><div style="width:120px;border-radius:2px;background:#fff"></div></div>`, want: [] },
    { name: "a fixed child over a rounded box passes", html: `<div style="width:240px;height:44px;padding:4px;border:1px solid #ddd;border-radius:12px;background:#f2f2f2"><div style="position:fixed;top:29px;left:29px;width:120px;height:44px;border-radius:12px;background:#fff"></div></div>`, want: [] },
    { name: "a footer with only a top divider, flush in a card's bottom corners, passes", html: `<div style="width:240px;padding:12px 12px 0;border:1px solid #ddd;border-radius:12px;background:#fff">Card words<div style="margin:8px -12px 0;padding:8px 12px;border-top:1px solid #ddd">pp-3</div></div>`, want: [] },
    { name: "a fill painted only by its shadow, flush in a rounded bar, is found", html: `<div style="position:relative;width:200px;height:24px;border:1px solid #999;border-radius:12px;background:#f8f8f8"><span style="position:absolute;top:0;bottom:0;left:0;width:30px;box-shadow:0 0 0 1px #2563eb"></span></div>`, want: ["corner-bleed"] },
    { name: "an absolute child, same radius with a 4 px gap, is found", html: `<div style="position:relative;width:240px;height:44px;padding:4px;border:1px solid #ddd;border-radius:12px;background:#f2f2f2"><div style="position:absolute;top:4px;left:4px;bottom:4px;width:120px;border-radius:12px;background:#fff"></div></div>`, want: ["concentric"] },
];
/** The kinds auton-ui's fixtures speak to: the tells of an assembled page, old and new. */
const TELLS = new Set<LayoutFind["kind"]>(["side-tab", "gradient", "gradient-text", "glow", "concentric", "corner-bleed", "tabular", "css-tell", "nested-cards", "pulsing-dot"]);
const fixturePage = (html: string) => `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:24px;font:14px sans-serif">${html}</body>`;
const AUTON_PAGES = Object.fromEntries([
    ...AUTON.map((fixture, i) => [`/auton/${i}`, fixturePage(fixture.html)]),
    ...THRESHOLDS.map((fixture, i) => [`/thresholds/${i}`, fixturePage(fixture.html)]),
]);

const head = `<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;font:14px sans-serif} .col{width:300px;margin:0 20px}</style>`;
const words = "Words that wrap in their column, as a reply's do, line after line after line. ";
const PAGES: Record<string, string> = {
    "/clean": `${head}<div class="col"><p>Words that wrap in their column, as a reply's do.</p><pre style="overflow-x:auto;background:#eee"><code>${"a very long line of code ".repeat(20)}</code></pre></div>`,
    "/spill": `${head}<div class="col" id="box" style="overflow:visible"><div style="width:500px;background:#ccc">Wide</div></div>`,
    "/wide": `${head}<div style="width:2000px;height:20px;background:#ccc"></div>`,
    "/ellipsis": `${head}<div class="col"><div id="title" style="width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A long session title that does not fit</div></div>`,
    // A lead of two runs of words, the second past the edge (pi-phone's "ui-polish: Working…" read "shows 134 of 62 px").
    "/runs": `${head}<div class="col"><div id="lead" style="width:134px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><b>ui-polish:</b> <span>Working on it now…</span></div></div>`,
    "/lines": `${head}<div class="col"><div id="note" style="width:200px;height:40px;overflow:hidden;line-height:20px">${words.repeat(3)}</div></div>`,
    "/covered": `${head}<div class="col" style="position:relative"><button id="send" style="width:120px;height:48px;padding:0">Send now</button><div id="toast" style="position:absolute;left:0;top:0;width:100px;height:48px;background:#eee"></div></div><div class="col" style="position:relative;margin-top:16px"><span id="name">A title the whole row opens</span><button aria-label="Open" style="position:absolute;left:0;top:0;right:0;bottom:0;background:transparent;border:0"></button></div>`,
    "/sheet": `${head}<div class="col"><p>Under the sheet</p><button style="width:120px;height:48px;padding:0">Behind</button></div><div role="dialog" style="position:fixed;left:0;top:0;right:0;bottom:0;background:#fff"><p class="col">The sheet's words</p></div>`,
    "/target": `${head}<style>#chip,#short{position:relative}#chip::before{content:"";position:absolute;inset:-6px -4px}#short::after{content:"";position:absolute;inset:-2px}</style><div class="col"><button id="close" style="width:32px;height:32px;padding:0;border:0">Go</button><button id="chip" style="width:60px;height:30px;padding:0;border:0">Plan</button><button id="short" style="width:60px;height:30px;padding:0;border:0">Copy</button><button id="off" disabled style="width:30px;height:30px">Off</button><label style="display:block;padding:6px 0"><input id="find" style="height:30px;width:200px"></label></div>`,
    "/grid": `${head}<div class="col"><div id="row" style="padding:6px;border-radius:10px;display:flex;gap:5.5px;background:#eee"><span>One</span><span>Two</span></div></div>`,
    "/faint": `${head}<div class="col" style="background:#1a1b26;padding:8px"><span id="meta" style="color:#3b3f55">Two minutes ago</span> <span id="dim" style="color:rgba(255,255,255,0.3)">Muted</span> <span style="color:#c0caf5">Readable</span></div>`,
    "/small": `${head}<div class="col"><p id="fine" style="font-size:10px">Fine print</p></div>`,
    "/emoji": `${head}<div class="col"><p id="state">\u{1F680} Launched</p><p id="done">\u2713 Done</p><p id="react">\u263A+ © 2026</p><p id="look">\u25A3 Looks at</p></div>`,
    "/gradient": `${head}<div class="col"><p id="hype" style="background:linear-gradient(90deg,#a855f7,#3b82f6);-webkit-background-clip:text;background-clip:text;color:transparent">Supercharge</p></div>`,
    "/caps": `${head}<div class="col"><p id="label" style="text-transform:uppercase;letter-spacing:2px">Navigation</p><p id="tight" style="letter-spacing:-0.5px">Squeezed words</p></div>`,
    "/long": `${head}<div style="overflow-x:auto"><p id="essay" style="width:760px;margin:0">${words.repeat(8)}</p></div>`,
    // The nine tells adapted from Impeccable's detector (PP-415), each with one that passes beside it: a grey rule down
    // a quote, a neutral elevation shadow, a dot that pulses once, a heading skip inside the footer, justified text with
    // hyphens, a heading set tight.
    "/slop": `${head}<style>@keyframes pulse{50%{opacity:.3}} @keyframes grow{50%{transform:scale(1.4)}} @keyframes spin{to{transform:rotate(360deg)}} .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block} .box{border:1px solid #cccccc;border-radius:8px;padding:8px;margin:8px 0}</style><div class="col">
      <h1>Title</h1><h3 id="sub">Sub</h3>
      <div id="tab" style="border-left:4px solid #8b5cf6;border-radius:12px;background:#15151f;color:#eeeeee;padding:16px">A card with a stripe</div>
      <div id="inset" style="box-shadow:inset 3px 0 0 #e0af68;padding:8px">Critical question here</div>
      <div style="border-left:3px solid #888888;padding:8px">Grey quote rule</div>
      <div id="glowcard" style="box-shadow:0 0 40px rgba(139,92,246,0.5);border-radius:16px;width:200px;height:100px">Glow</div>
      <div style="box-shadow:0 4px 12px rgba(0,0,0,0.3);width:200px;height:60px">Lifted</div>
      <div id="outer" class="box">Outer card words<div id="inner" class="box" style="height:40px">Inner card words here</div></div>
      <span id="dot" class="dot" style="animation:pulse 1.5s infinite"></span> <span class="dot" style="animation:pulse 1s 1"></span>
      <span id="grow" class="dot grow" style="animation:grow 2s infinite"></span> <span id="spin" style="display:inline-block;width:8px;height:8px;border:2px solid #888888;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite paused"></span>
      <img id="broken" src="/missing.png" alt="Shot" width="80" height="40">
      <p id="just" style="width:160px;text-align:justify">${words}</p><p style="width:160px;text-align:justify;hyphens:auto" lang="en">${words}</p>
      <p id="tight" style="line-height:1.1">${words}</p><h2 style="line-height:1.1">${words}</h2>
      <div id="list" class="box"><p class="a">Read more</p><div class="b">Read more</div><span class="c">Read more</span></div>
      <footer><h5>Links</h5></footer></div>`,
    // A phone page wider than its screen (PP-414): the browser stretches innerWidth to the content, the page is still a phone's.
    // A stretched link (PP-436): a card's title link whose ::after, absolute with inset 0, covers the card (the card is
    // its target, the description under the layer is its own). Beside it, a real overlay over words, and a 20 px link
    // with no layer.
    "/stretched": `${head}<style>.title::after{content:"";position:absolute;inset:0}</style><div class="col"><div id="card" style="position:relative;padding:16px;border:1px solid #cccccc;border-radius:12px"><a id="title" class="title" href="#" style="display:block;line-height:20px">Blueprint Bank</a><p id="desc" style="margin:8px 0 0">A description of the bank under its title.</p><p id="meta" style="margin:4px 0 0">Updated two days ago</p></div><div style="position:relative;margin-top:16px"><p id="under" style="margin:0">Words under a box</p><div id="overlay" style="position:absolute;inset:0;background:#eeeeee"></div></div><div style="margin-top:16px"><a id="plain" href="#" style="display:inline-block;line-height:20px">Plain link</a></div></div>`,
    // Visually hidden content (PP-436, part 2): a chart's screen-reader table under its SVG, hidden four ways (auton-ui's
    // 1 px box with clip-path inset(50%), a zero clip rect, a 1 px box with overflow clip, an ancestor at opacity 0).
    // Nothing of it is a finding; the same cell shown is. The cells sit at their box's corner, so the old check saw
    // their words in the 1 px region.
    "/sr-only": `${head}<div class="col" style="position:relative"><svg width="200" height="100"><rect width="200" height="100" fill="#e0e7ff"/></svg><div style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);top:0;left:0"><table style="border-spacing:0"><tr><td style="padding:0">48,213</td></tr></table></div><div style="position:absolute;top:20px;left:0;clip:rect(0,0,0,0)"><table><tr><td>12,345</td></tr></table></div><div style="position:absolute;top:40px;left:0;width:1px;height:1px;overflow:clip"><table style="border-spacing:0"><tr><td style="padding:0">90,210</td></tr></table></div><div style="position:absolute;top:60px;left:0;opacity:0"><div><table><tr><td>77,001</td></tr></table></div></div></div>`,
    "/sr-shown": `${head}<div class="col"><svg width="200" height="100"><rect width="200" height="100" fill="#e0e7ff"/></svg><table><tr><td id="cell">48,213</td></tr></table></div>`,
    "/overflow": `${head}<div style="width:600px;white-space:nowrap">A row wider than the phone</div><button id="tiny" style="width:28px;height:28px;padding:0">A</button>`,
    // Words over gradients (PP-414): one colour drawn as a gradient, the dark half of a hard-stop band, and a radial
    // glow in the far corner that has faded to nothing where the words are (no worst-stop guess).
    "/gradient-bg": `${head}<div class="col"><div id="flat" style="background:linear-gradient(#777777,#777777);padding:8px"><span id="grey" style="color:#888888">Grey on grey</span></div><div id="band" style="background:linear-gradient(90deg,#1a1b26 0%,#1a1b26 50%,#ffffff 50%,#ffffff 100%);padding:8px 0"><span id="left" style="color:#3b3f55">Dark</span></div><div id="glow" style="background-color:#1a1b26;background-image:radial-gradient(circle at 100% 0%,#ffffff,rgba(255,255,255,0) 40px);padding:8px"><span id="calm" style="color:#c0caf5">Calm words</span></div><div id="photo" style="background:#1a1b26 url(data:image/gif;base64,R0lGODlhAQABAAAAACw=);padding:8px"><span style="color:#3b3f55">Over a picture</span></div></div>`,
    // The static CSS tells (PP-430), each with one that passes beside it, and side stripes in their other disguises: an
    // inset shadow along the top, a bar drawn by ::after; a tab's underline is not one.
    "/tells": `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"><style>body{margin:0;font:14px sans-serif} .col{width:300px;margin:0 20px} .bar,.tab{position:relative;border-radius:8px;padding:8px} .bar::after,.tab::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:#2563eb}</style><div class="col">
      <div id="all" style="transition:all .2s">Moves</div><div style="transition:opacity .2s">Fades</div>
      <p id="tnum" style="font-feature-settings:'tnum'">12,345</p><p style="font-variant-numeric:tabular-nums">12,345</p>
      <input id="small" style="font-size:14px;height:40px"> <input style="font-size:16px;height:40px">
      <div id="scroll" role="dialog" style="height:80px;overflow-y:auto"><p style="height:240px">Long</p></div><div role="dialog" style="height:80px;overflow-y:auto;overscroll-behavior:contain"><p style="height:240px">Held</p></div>
      <h2 id="one" style="line-height:1;width:120px">A heading that wraps over lines</h2><h2 style="line-height:1">Short</h2>
      <div id="top" style="box-shadow:inset 0 3px 0 #2563eb;padding:8px">Top stripe</div><div id="bar" class="bar">Bar under</div><div class="tab" role="tab">Tab</div></div>`,
    // display: contents (PP-501): a definition list's rows wrapped in a box-less div, as visa-dashboard's case page has
    // them; the words are laid out in the list's box. One such div hides its overflow, which it cannot: its words show.
    "/contents": `${head}<dl class="col" style="margin:0 20px"><div style="display:contents"><dt id="term">Appointment</dt><dd id="date" style="margin:0 0 0 16px">12 November 2026</dd></div><div style="display:contents;overflow:hidden"><dt id="fine" style="font-size:10px">Fine print</dt></div></dl>`,
    // An open modal dialog (PP-501): the page behind it has faults of its own (small text, a small button), which the
    // person cannot reach; inside, small text and a button under a box. A dialog opened with showModal(), one marked
    // aria-modal, and one marked so but hidden, which leaves the page measured.
    "/modal": `${head}<div class="col"><p id="behind" style="font-size:10px">Behind the dialog</p><button id="tiny" style="width:24px;height:24px;padding:0">x</button></div><dialog id="add" style="width:300px;padding:16px;border:0"><p id="inside" style="font-size:10px;margin:0">Inside the dialog</p><div style="position:relative;margin-top:16px"><button id="save" style="width:120px;height:48px;padding:0">Save</button><div id="veil" style="position:absolute;left:0;top:0;width:100px;height:48px;background:#eeeeee"></div></div></dialog><script>document.getElementById("add").showModal();</script>`,
    "/aria-modal": `${head}<div class="col"><p id="behind" style="font-size:10px">Behind the sheet</p></div><div id="sheet" role="dialog" aria-modal="true" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#ffffff"><p id="inside" style="font-size:10px;margin:0">Inside the sheet</p></div>`,
    "/aria-modal-hidden": `${head}<div class="col"><p id="behind" style="font-size:10px">Behind the sheet</p></div><div role="dialog" aria-modal="true" hidden style="position:fixed;inset:0;background:#ffffff"><p style="font-size:10px">Not open</p></div>`,
    // Text zoom (PP-433): Android's font scale makes a WebView compute every px font size and line height 8 % larger
    // (14 px as 15.12, line height 20 as 21.6). Chrome on a computer has no text zoom (CDP's OS text scale does not act
    // as it), so the page plays it: its sizes as such a WebView computes them, and the check's probe (100 px) as 108.
    // The Skills & commands row (PP-471: 114.08, 108 at 100 %), a session row of three lines and an icon (72.16, 68),
    // an icon button and a row with a min-height (40 and 44, no text part), and one off the grid at 100 % too (35.6, 34).
    "/text-zoom": `${head}<style>[data-pi-text-zoom]{font-size:108px!important;line-height:108px!important} button{display:block;width:300px;margin:0 20px 8px;border:0;font:15.12px/21.6px sans-serif;text-align:left} .small{font-size:12.96px;line-height:17.28px}</style>
      <button id="lib" style="display:flex;flex-direction:column;gap:4px;padding:12px 16px"><span>ssp-notes</span><span style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14.04px">${words.repeat(2)}</span><span class="small" style="display:flex;flex-wrap:wrap;gap:4px 12px"><span>1 session</span><span>2 versions</span></span></button>
      <button id="session" style="padding:8px 12px"><div class="small">~/work/pi-phone</div><div>pi-phone dev</div><div class="small" style="display:flex;align-items:center;gap:4px"><svg width="16" height="16"></svg><span>master</span></div></button>
      <button id="icon" aria-label="Close" style="width:40px;height:40px;padding:8px"><svg width="24" height="24"></svg></button>
      <button id="tall" style="min-height:44px;padding:0 12px">One line</button>
      <button id="off" style="padding:7px 12px">Seven</button>`,
    ...AUTON_PAGES,
};
let server: Server;
let port = 0;

before(async () => {
    server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGES[request.url ?? "/"] ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => server?.close());

/** An empty report at `width`, to build reports from. */
const report = (width: number, more: Partial<LayoutReport> = {}): LayoutReport => ({
    width,
    height: 844,
    checked: 6,
    issues: [],
    more: 0,
    found: [],
    totals: {},
    summary: { fontSizes: [14], colors: ["#000000"], families: ["sans-serif"], icons: [], strokes: [] },
    ...more,
});

test("a page laid out wider than the picture is reported as wider than the screen, at the width asked for", () => {
    const parsed = parseLayout(JSON.stringify({ ...report(520) }), 390);

    assert.equal(parsed?.width, 390);
    assert.deepEqual(parsed?.issues, [{ kind: "page-wider", what: "the page", box: [0, 520], limit: [0, 390] }]);
    assert.match(describeLayout(parsed!), /- the page: is wider than the screen \(520 px in 390\)/);
    assert.equal(parseLayout("not json", 390), undefined);
    assert.equal(parseLayout(JSON.stringify(report(390)), 390)?.issues.length, 0);
    // A report without the PP-395 findings is not one.
    assert.equal(parseLayout(JSON.stringify({ width: 390, height: 844, checked: 6, issues: [], more: 0 }), 390), undefined);
});

test("the words keep the report short: three of each kind with their numbers, a count of the rest, and the summary past a designed page's few sizes and colours", () => {
    const targets: LayoutFind[] = [
        { kind: "small-target", what: 'button.icon "Close"', size: [32, 32], count: 9 },
        { kind: "small-target", what: 'a.chip "Docs"', size: [60, 24], count: 4 },
        { kind: "small-target", what: "input.check", size: [16, 16], count: 2 },
        { kind: "small-target", what: 'button.more "More"', size: [36, 36], count: 1 },
    ];
    const text = describeLayout(
        report(390, {
            found: [
                ...targets,
                { kind: "contrast", what: 'span.meta "2 min ago"', color: "#3b3f55", background: "#1a1b26", ratio: 1.62, needs: 4.5, count: 3 },
                { kind: "off-grid", what: 'div.row "One"', property: "padding", value: 6, count: 14 },
            ],
            totals: { "small-target": 16, contrast: 3, "off-grid": 14 },
            summary: { fontSizes: [11, 12, 13, 13.6, 14, 15, 16, 20], colors: ["#c0caf5", "#a9b1d6"], families: ["Inter", "JetBrains Mono", "Georgia"], icons: ["16x16", "18x18", "20x20"], strokes: ["1.5px", "2px"] },
        }),
    );

    assert.match(text, /^Layout check at 390 px \(6 elements\): 33 out of place\./);
    assert.match(text, /\nTap targets under 40 px \(16\):\n- button\.icon "Close": 32×32 px \(×9\)\n- a\.chip "Docs": 60×24 px \(×4\)\n- input\.check: 16×16 px \(×2\)\n- and 1 more\n/);
    assert.match(text, /\nText under WCAG AA contrast \(3\):\n- span\.meta "2 min ago": #3b3f55 on #1a1b26, 1\.62:1 \(needs 4\.5\) \(×3\)\n/);
    assert.match(text, /\nSizes off the 4 px grid or not whole pixels \(14\):\n- padding 6 px: 14 elements, such as div\.row "One"\n/);
    assert.match(text, /\nType and colour: 8 font sizes \(11, 12, 13, 13\.6, 14, 15, 16, 20 px\); 3 font families \(Inter, JetBrains Mono, Georgia\); icons in 3 sizes \(16x16, 18x18, 20x20 px\); icon strokes of 2 widths \(1\.5px, 2px\)\.$/);
    assert.doesNotMatch(text, /More/);
});

/** The page's report, as the renderer measures it. */
async function measured(page: BrowserPage, path: string, width = 390): Promise<LayoutReport> {
    await page.navigate(`http://pi.test${path}`);

    const report = parseLayout(await page.evaluate<string>(layoutCheck(width)), width);

    assert.ok(report !== undefined, `${path} gave a report`);

    return report;
}

/** The page's report as the renderers measure it: the script without a width, the page's own (PP-414). */
async function rendered(page: BrowserPage, path: string, width = 390): Promise<LayoutReport> {
    await page.navigate(`http://pi.test${path}`);

    const report = parseLayout(await page.evaluate<string>(layoutCheck()), width);

    assert.ok(report !== undefined, `${path} gave a report`);

    return report;
}

const of = <K extends LayoutFind["kind"]>(report: LayoutReport, kind: K) => report.found.filter((find): find is Extract<LayoutFind, { kind: K }> => find.kind === kind);

test("the layout check reports what is out of place, with sizes, and nothing on a page in place", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const clean = await measured(page, "/clean");

        assert.deepEqual(clean.issues, [], JSON.stringify(clean.issues));
        assert.deepEqual(clean.found, [], JSON.stringify(clean.found));
        assert.match(describeLayout(clean), /^Layout check at 390 px \(\d+ elements\): nothing spills/);

        const spill = await measured(page, "/spill");

        assert.ok(spill.issues.some((issue) => issue.kind === "spills" && issue.what.startsWith("div#box") && issue.box[1] === 500 && issue.limit[1] === 300), JSON.stringify(spill.issues));
        assert.ok(spill.issues.some((issue) => issue.kind === "outside-parent" && issue.what.includes('"Wide"')), JSON.stringify(spill.issues));
        assert.match(describeLayout(spill), /div#box\.col "Wide": its content is wider than its box \(500 px in 300\)/);

        const wide = await measured(page, "/wide");

        assert.ok(wide.issues.some((issue) => issue.kind === "page-wider" && issue.box[1] === 2000 && issue.limit[1] === 390), JSON.stringify(wide.issues));
    } finally {
        await engine.close();
    }
});

test("the layout check finds cut text, overlaps, small tap targets, off-grid sizes, low contrast, small text, emoji, gradient text, uppercase labels, tight tracking and long lines, each with its numbers (PP-395)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        // Cut text: an ellipsis that truncates, and lines cut at the bottom of a box that hides its overflow.
        const ellipsis = await measured(page, "/ellipsis");
        const [title] = of(ellipsis, "cut");

        assert.ok(title !== undefined && title.what.startsWith("div#title") && title.axis === "x" && title.ellipsis && title.shown === 120 && title.full > 200, JSON.stringify(ellipsis.found));
        assert.match(describeLayout(ellipsis), /Cut text \(1\):\n- div#title "A long session title that does": cut at the side, ends in … \(shows 120 of \d+ px wide\)/);

        // Several runs of words in one cut box: one cut, the box's width against all its words'.
        const runs = of(await measured(page, "/runs"), "cut");

        assert.equal(runs.length, 1, JSON.stringify(runs));
        assert.ok(runs[0]!.what.startsWith("div#lead") && runs[0]!.count === 1 && runs[0]!.shown === 134 && runs[0]!.full > 134, JSON.stringify(runs));

        const lines = await measured(page, "/lines");
        const [note] = of(lines, "cut");

        assert.ok(note !== undefined && note.what.startsWith("div#note") && note.axis === "y" && !note.ellipsis && note.shown === 40 && note.full >= 80, JSON.stringify(lines.found));

        // An element over a button; a dialog over the whole page is a layer, not an overlap.
        const covered = await measured(page, "/covered");
        const [send, ...others] = of(covered, "covered");

        // A transparent button laid over a title (one tap target for the row) hides nothing.
        assert.deepEqual(others, []);
        assert.ok(send !== undefined && send.what.startsWith("button#send") && send.by.startsWith("div#toast"), JSON.stringify(covered.found));
        assert.match(describeLayout(covered), /Covered: an element on top of another's text or control \(\d\):\n- button#send "Send now": under div#toast/);
        assert.deepEqual(of(await measured(page, "/sheet"), "covered"), []);

        // A tap target under 40 px at a phone's width; at a desktop's it is not one. A ::before laid past a small
        // control's edges is its hit area (PP-400): 30 px tall with 6 px above and below is 42; with 2 px, 34. A field's
        // label takes its taps too (42 px tall around a 30 px field), and a disabled control takes none.
        const target = await measured(page, "/target");

        assert.deepEqual(of(target, "small-target").map((find) => [find.what, find.size]), [['button#close "Go"', [32, 32]], ['button#short "Copy"', [64, 34]]]);
        assert.deepEqual(of(await measured(page, "/target", 1280), "small-target"), []);

        // Padding, radius and gap off the 4 px grid, and a gap that is not a whole pixel.
        const grid = await measured(page, "/grid");

        assert.deepEqual(
            of(grid, "off-grid").map((find) => [find.property, find.value]).sort(),
            [["gap", 5.5], ["padding", 6], ["radius", 10]],
            JSON.stringify(grid.found),
        );

        // Faint text, with the numbers: #3b3f55 on #1a1b26, and white at 30% over it.
        const faint = await measured(page, "/faint");
        const contrast = of(faint, "contrast");

        assert.equal(contrast.length, 2, JSON.stringify(faint.found));
        assert.ok(contrast.some((find) => find.what.startsWith("span#meta") && find.color === "#3b3f55" && find.background === "#1a1b26" && find.ratio < 2 && find.needs === 4.5), JSON.stringify(contrast));
        assert.ok(contrast.some((find) => find.what.startsWith("span#dim") && find.ratio < 4.5), JSON.stringify(contrast));

        assert.deepEqual(of(await measured(page, "/small"), "small-text").map((find) => [find.what, find.size]), [['p#fine "Fine print"', 10]]);
        assert.deepEqual(of(await measured(page, "/emoji"), "emoji").map((find) => find.glyphs).sort(), ["\u25A3", "\u263A", "\u2713", "\u{1F680}"]);
        assert.deepEqual(of(await measured(page, "/gradient"), "gradient-text").map((find) => find.what), ['p#hype "Supercharge"']);

        const caps = await measured(page, "/caps");

        assert.deepEqual(of(caps, "uppercase").map((find) => [find.what, find.transform, find.tracking]), [['p#label "Navigation"', "uppercase", 2]]);
        assert.deepEqual(of(caps, "tight-tracking").map((find) => [find.what, find.tracking, find.size]), [['p#tight "Squeezed words"', -0.5, 14]]);

        const [essay] = of(await measured(page, "/long"), "long-lines");

        assert.ok(essay !== undefined && essay.what.startsWith("p#essay") && essay.chars > 90, JSON.stringify(essay));
    } finally {
        await engine.close();
    }
});

test("an element in a display: contents box is measured against the nearest box, and an open modal dialog is measured alone, which the words say (PP-501)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));
        const short = (what: string) => what.replace(/ ".*$/, "");

        await page.init({ width: 390, height: 844, mobile: true });

        // The <dt> and <dd> sit in the list's box, not outside the wrapper's 0 x 0; the wrapper's overflow hides nothing.
        const contents = await measured(page, "/contents");

        assert.deepEqual(contents.issues, [], JSON.stringify(contents.issues));
        assert.deepEqual(of(contents, "small-text").map((find) => short(find.what)), ["dt#fine"]);

        // showModal(): only the dialog, with its own faults; a box over its button is a cover there.
        const dialog = await measured(page, "/modal");

        assert.equal(dialog.modal, 'dialog#add "Inside the dialogSave"');
        assert.deepEqual(of(dialog, "small-text").map((find) => short(find.what)), ["p#inside"]);
        assert.deepEqual(of(dialog, "small-target"), []);
        assert.deepEqual(of(dialog, "covered").map((find) => [short(find.what), short(find.by)]), [["button#save", "div#veil"]]);
        assert.match(describeLayout(dialog), /^Layout check at 390 px \(\d+ elements, measured inside the open dialog dialog#add "Inside the dialogSave"; the page behind it is left out\): \d+ out of place\./);

        // aria-modal: the same; hidden, it is not open, and the page is measured.
        const sheet = await measured(page, "/aria-modal");

        assert.match(sheet.modal ?? "", /^div#sheet /);
        assert.deepEqual(of(sheet, "small-text").map((find) => short(find.what)), ["p#inside"]);

        const closed = await measured(page, "/aria-modal-hidden");

        assert.equal(closed.modal, undefined);
        assert.deepEqual(of(closed, "small-text").map((find) => short(find.what)), ["p#behind"]);
        assert.doesNotMatch(describeLayout(closed), /measured inside/);
        assert.equal(parseLayout(JSON.stringify({ ...report(390), modal: 3 }), 390)?.modal, undefined);
    } finally {
        await engine.close();
    }
});

test("under text zoom (Android's font scale), control heights are measured on the grid as at 100 %: the part their lines make taken back, and the report says so (PP-433)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const zoomed = await measured(page, "/text-zoom");
        const heights = of(zoomed, "off-grid").filter((find) => /height/.test(find.property));

        assert.equal(zoomed.textZoom, 1.08);
        assert.deepEqual(heights.map((find) => [find.what.replace(/ ".*$/, ""), find.property, find.value]), [["button#off", "control height at 100 % text", 34]]);
        assert.match(describeLayout(zoomed), /\nText zoom 108 % \(the system's font size\): control heights are measured on the 4 px grid as at 100 %/);
        // Without text zoom, nothing is said and heights are measured as they are.
        const plain = await measured(page, "/clean");

        assert.equal(plain.textZoom, undefined);
        assert.doesNotMatch(describeLayout(plain), /Text zoom/);
        assert.equal(parseLayout(JSON.stringify({ ...report(390), textZoom: "108%" }), 390)?.textZoom, undefined);
    } finally {
        await engine.close();
    }
});

test("a stretched link's layer over its card is its tap target and covers no words of the card; a real overlay and a small link are still reported (PP-436)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const stretched = await measured(page, "/stretched");
        const short = (what: string) => what.replace(/ ".*$/, "");

        assert.deepEqual(of(stretched, "small-target").map((find) => [short(find.what), find.size[1]]), [["a#plain", 20]]);
        assert.deepEqual(of(stretched, "covered").map((find) => [short(find.what), short(find.by)]), [["p#under", "div#overlay"]]);
    } finally {
        await engine.close();
    }
});

test("visually hidden content (a chart's screen-reader table) gives no finding of any kind; the same cell shown still does (PP-436)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const hidden = await measured(page, "/sr-only");

        assert.deepEqual([hidden.found, hidden.issues], [[], []]);
        assert.deepEqual(of(await measured(page, "/sr-shown"), "tabular").map((find) => [find.what, find.text]), [['td#cell "48,213"', "48,213"]]);
    } finally {
        await engine.close();
    }
});

test("a phone page wider than its screen keeps its tap-target check, and words over a gradient are measured where they sit (PP-414)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        // As the renderers run it (no width given): innerWidth is stretched to the 600 px row, the page is a phone's.
        const overflow = await rendered(page, "/overflow");

        assert.ok(overflow.issues.some((issue) => issue.kind === "page-wider"), JSON.stringify(overflow.issues));
        assert.deepEqual(of(overflow, "small-target").map((find) => [find.what, find.size]), [['button#tiny "A"', [28, 28]]]);
        assert.match(describeLayout(overflow), /Tap targets under 40 px \(1\):\n- button#tiny "A": 28×28 px/);

        // Gradients: the colour under the words, with the element that paints it; a faded glow and a picture are not findings.
        const gradient = await rendered(page, "/gradient-bg");
        const contrast = of(gradient, "contrast").map((find) => [find.what, find.color, find.background, find.ratio, find.gradient]);

        assert.deepEqual(contrast.sort(), [
            ['span#grey "Grey on grey"', "#888888", "#777777", 1.26, "div#flat"],
            ['span#left "Dark"', "#3b3f55", "#1a1b26", 1.65, "div#band"],
        ]);
        assert.match(describeLayout(gradient), /- span#left "Dark": #3b3f55 on #1a1b26 \(gradient on div#band\), 1\.65:1 \(needs 4\.5\)/);
    } finally {
        await engine.close();
    }
});

test("the layout check finds the tells adapted from Impeccable: broken images, skipped headings, nested cards, side-tabs, glows, pulsing dots, narrow justified text, tight leading and repeated words (PP-415)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const slop = await measured(page, "/slop");
        const short = (what: string) => what.replace(/ ".*$/, "");

        assert.deepEqual(of(slop, "broken-image").map((find) => [short(find.what), find.src]), [["img#broken", "http://pi.test/missing.png"]]);
        assert.deepEqual(of(slop, "skipped-heading").map((find) => [short(find.what), find.from, find.to]), [["h3#sub", 1, 3]]);
        assert.deepEqual(of(slop, "nested-cards").map((find) => [short(find.what), short(find.in)]), [["div#inner.box", "div#outer.box"]]);
        assert.deepEqual(
            of(slop, "side-tab").map((find) => [short(find.what), find.side, find.width, find.how]).sort(),
            [["div#inset", "left", 3, "inset shadow"], ["div#tab", "left", 4, "border"]],
        );
        assert.deepEqual(of(slop, "glow").map((find) => [short(find.what), find.property, find.color, find.blur]), [["div#glowcard", "box-shadow", "#8b5cf6", 40]]);
        // A dot whose opacity or scale pulses; a 12 px spinner turns, it does not pulse (PP-425).
        assert.deepEqual(of(slop, "pulsing-dot").map((find) => short(find.what)), ["span#dot.dot", "span#grow.dot.grow"]);
        assert.deepEqual(of(slop, "justified").map((find) => short(find.what)), ["p#just"]);
        assert.deepEqual(of(slop, "tight-leading").map((find) => [short(find.what), find.ratio]), [["p#tight", 1.1]]);
        assert.deepEqual(of(slop, "repeated-text").map((find) => [short(find.what), find.text, find.times]), [["div#list.box", "Read more", 3]]);

        const text = describeLayout(slop);

        assert.match(text, /\nSide-tab accent stripes \(2\):\n/);
        assert.match(text, /- div#tab "A card with a stripe": 4 px left border/);
        assert.match(text, /\nSkipped heading levels \(1\):\n- h3#sub "Sub": h1 then h3, no h2\n/);
        assert.match(text, /\nCards inside cards \(1\):\n- div#inner\.box "Inner card words here": inside div#outer\.box/);
        assert.match(text, /\nThe same words repeated in one card \(1\):\n- div#list\.box "Read moreRead moreRead more": "Read more" 3 times(\n|$)/);
        // Pages in place stay in place.
        assert.deepEqual((await measured(page, "/clean")).found, []);
    } finally {
        await engine.close();
    }
});

test("auton-ui's fixtures behave: 10 found, 9 passed, as its doctor proved them (PP-430, PP-432), and the concentric thresholds hold (PP-432)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const wrong: string[] = [];

        for (const [path, fixture] of [...AUTON.map((fixture, i) => [`/auton/${i}`, fixture] as const), ...THRESHOLDS.map((fixture, i) => [`/thresholds/${i}`, fixture] as const)]) {
            const report = await measured(page, path);
            const kinds = [...new Set(report.found.map((find) => find.kind).filter((kind) => TELLS.has(kind)))].sort();

            if (JSON.stringify(kinds) !== JSON.stringify([...fixture.want].sort())) {
                wrong.push(`${fixture.name}: wants [${fixture.want.join(", ")}], found [${kinds.join(", ")}] ${JSON.stringify(report.found.filter((find) => TELLS.has(find.kind)))}`);
            }
        }

        assert.deepEqual(wrong, []);
        assert.equal(AUTON.filter((fixture) => fixture.want.length > 0).length, 10);
        assert.equal(AUTON.filter((fixture) => fixture.want.length === 0).length, 9);

        // The corner bleed with its numbers: the fill's 4 px corner in the bar's 12 px one.
        const bar = await measured(page, "/auton/17");

        assert.deepEqual(of(bar, "corner-bleed").map((find) => [find.what, find.in, find.inner, find.outer]), [["span", "div", 4, 12]]);
        assert.match(describeLayout(bar), /\nCorners poking out of a rounded parent that does not clip them \(1\):\n- span: radius 4, flush in a corner of div \(radius 12\), which does not clip it; clip it with overflow: hidden on the parent, or wrap the fill in an absolute inset-0 overflow-hidden layer with border-radius: inherit(\n|$)/);

        // The numbers: the corner it found and the radius it wants, the digits, the gradient.
        const [corner] = of(await measured(page, "/auton/10"), "concentric");

        assert.deepEqual(corner && [corner.inner, corner.gap, corner.border, corner.outer, corner.want], [12, 4, 1, 12, 17]);

        const ring = describeLayout(await measured(page, "/auton/10"));

        assert.match(ring, /\nCorners not concentric \(outer radius = inner \+ gap \+ border\) \(1\):\n- div: radius 12 \+ gap 4 \+ border 1 in div, whose radius is 12 \(wants 17\)/);
        assert.deepEqual(of(await measured(page, "/auton/14"), "tabular").map((find) => [find.what, find.text]), [['td "48,213"', "48,213"]]);
        assert.deepEqual(of(await measured(page, "/auton/2"), "side-tab").map((find) => [find.side, find.width, find.how]), [["left", 2, "::before"]]);
        assert.match(describeLayout(await measured(page, "/auton/5")), /\nGradient surfaces \(1\):\n- div "Hero": linear-gradient\(135deg, rgb\(102, 126, 234\), rgb\(118, 75, 1.* on \d+ px²/);
    } finally {
        await engine.close();
    }
});

test("the layout check finds the static CSS tells a computed style shows, and side stripes along the top or drawn by ::after (PP-430)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const tells = await measured(page, "/tells");
        const short = (what: string) => what.replace(/ ".*$/, "");

        assert.deepEqual(of(tells, "css-tell").map((find) => [short(find.what), find.rule]).sort(), [
            ["div#all", "transition: all"],
            ["div#scroll", "scrolling dialog without overscroll-behavior: contain"],
            ["h2#one", "line height 1× on wrapping text"],
            ["input#small", "field text 14 px on a phone (under 16 px iOS zooms in)"],
            ["meta", "viewport maximum-scale=1 blocks zoom"],
            ["p#tnum", 'font-feature-settings "tnum" instead of font-variant-numeric: tabular-nums'],
        ]);
        assert.deepEqual(of(tells, "side-tab").map((find) => [short(find.what), find.side, find.width, find.how]).sort(), [
            ["div#bar.bar", "bottom", 2, "::after"],
            ["div#top", "top", 3, "inset shadow"],
        ]);
        assert.match(describeLayout(tells), /\nStatic CSS tells \(6\):\n/);
        assert.match(describeLayout(tells), /- div#bar\.bar "Bar under": 2 px bottom ::after bar/);
        // At a desktop's width a small field is no tell.
        assert.ok(!of(await measured(page, "/tells", 1280), "css-tell").some((find) => find.what.startsWith("input")));
    } finally {
        await engine.close();
    }
});

test("Pi's browser gives the same check: browser_layout_check on the page in front, and with browser_screenshot's picture (PP-395)", { skip }, async () => {
    const browser = new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });

    try {
        await browser.open(1, "http://pi.test/covered");

        const layout = await browser.layoutCheck(1);

        assert.ok(!("withheld" in layout));
        assert.ok(of(layout, "covered").some((find) => find.what.startsWith("button#send") && find.by.startsWith("div#toast")), JSON.stringify(layout.found));

        const shot = await browser.screenshot(1);

        assert.ok("data" in shot && shot.layout !== undefined && !("error" in shot.layout));
        assert.ok(of(shot.layout, "covered").length === 1, JSON.stringify(shot.layout));
        // A picture of one control comes without it.
        await browser.open(1, "http://pi.test/target");

        const one = await browser.screenshot(1, { index: 1 });

        assert.ok("data" in one && one.layout === undefined);
    } finally {
        await browser.close();
    }
});
