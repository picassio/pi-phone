// Pi's browser, PP-462, with a Chrome on the machine (CI): a list whose rows are clickable by their look only (a pointer
// cursor, no role, no tabindex), each with buttons of its own ("Reorder", "more"), and its clicks heard by a handler
// further up (as React's are): Confluence's database view switcher, in a frame of the page's. Each row's name was never
// a control: the row holds controls, so it was left out, and its words were left out as their parent has the pointer.
// Now the element holding each row's words is a control by them, in the page, in a frame of another origin of the
// page's site, and in a frame of another site (in a process of its own); a click on it selects the row, never its
// buttons; and a row whose name may delete asks the owner first (PP-455). Build #471 named each row by its layout icon
// ("Table layout", "Default view"), and a click there, by the drag handle, was refused: the press started a drag that
// drew the icon again, so the release landed on another node. The rows here have such icons and such a drag.
import { cleanUp, cleanUpAll } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { answering, NO_CARD } from "./no-card.ts";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const skip = chrome === undefined ? "no Chrome on this machine (CI runs it)" : false;

/** The views, as Confluence lists them: each row's name, its "Reorder" handle and its "more" button. */
const VIEWS = ["Pre-live readiness", "Go / No Go", "Rollback plan", "Delete requests"];

/**
 * The view switcher, built as Atlassian's is (ViewPicker's ListItem and ViewCard): an li, a flex box (a drag source)
 * with the drag handle's button, the card (a pointer cursor) with a labelled layout icon (a span with role img around an
 * svg with a title, an svg with an aria-label for the default view, or a label only a screen reader gets), the name and the "more" button; a click on the
 * card selects the view, heard on the list's root; a press in the row starts a drag, which draws its icon again (React
 * does so on the drag's state). Below, a list box whose options hold a button each; a card whose title is a link
 * (the link goes where the card does, so the card's other words stay words); and words that only look like a list (no
 * cursor, no role): those stay words.
 */
const VIEWS_PAGE = `<!doctype html><title>Views</title><meta name="viewport" content="width=device-width">
    <style>
        body{margin:0;font:14px sans-serif} ul{list-style:none;margin:0;padding:0} li>div{display:flex;align-items:center}
        .card{display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;padding:4px 0} .inline{display:flex;flex:1;justify-content:space-between}
        button{height:28px} [role=option]{display:flex;justify-content:space-between;padding:4px}
    </style>
    <div id="root">
        <h2>All views</h2>
        <ul>${VIEWS.map((view, index) => `<li><div class="item" draggable="true"><div><button aria-label="Reorder" draggable="true">::</button></div><div style="flex:1"><div class="card" data-view="${view}">${index === 2 ? `<svg class="icon" role="img" aria-label="Default view" width="16" height="16"><rect width="16" height="16"/></svg>` : index === 3 ? `<span class="icon"><svg aria-hidden="true" width="16" height="16"><rect width="16" height="16"/></svg><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Table layout</span></span>` : `<span class="icon" role="img" aria-label="Table layout"><svg width="16" height="16"><title>Table layout</title><rect width="16" height="16"/></svg></span>`}<div class="inline"><div><span>${view}</span></div><div><button aria-label="more">...</button></div></div></div></div></div></li>`).join("")}</ul>
        <div role="listbox" aria-label="Layouts"><div role="option" aria-selected="false" data-layout="Board">Board <button aria-label="Board settings">*</button></div></div>
        <div style="cursor:pointer"><a href="#card">Launch checklist</a><div>2 attachments</div><button>Edit</button></div>
        <div><div>Plain words</div><div>More plain words</div></div>
        <p id="out">Current view: none</p>
    </div>
    <script>
        for (const item of document.querySelectorAll('.item')) {
            item.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button')) return;
                item.dataset.dragging = 'true';
                const icon = item.querySelector('.icon');
                icon.replaceWith(icon.cloneNode(true));
            });
            item.addEventListener('pointerup', () => { delete item.dataset.dragging; });
        }
        root.addEventListener('click', (e) => {
            const button = e.target.closest('button');
            if (button) { out.textContent = button.getAttribute('aria-label') + ' of ' + (button.closest('[data-view]')?.dataset.view ?? button.closest('li')?.textContent.trim() ?? button.closest('[data-layout]')?.dataset.layout); return; }
            const card = e.target.closest('[data-view]');
            if (card) out.textContent = 'Current view: ' + card.dataset.view;
            const option = e.target.closest('[data-layout]');
            if (option) out.textContent = 'Layout: ' + option.dataset.layout;
        });
    </script>`;

/** The port the frame of the page's site names (the browser maps it to the frame's server). */
const ROWS = 8462;
let top: Server;
let rows: Server;
let topPort = 0;
let rowsPort = 0;

before(async () => {
    const serve = (page: (path: string) => string | undefined) =>
        createServer((request, response) => {
            const body = page((request.url ?? "/").split("?")[0]!);

            response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
            response.end(body ?? "not here");
        });

    top = serve((path) => {
        if (path === "/views") {
            return VIEWS_PAGE;
        }

        const frame = path === "/same-site" ? `http://pi.test:${ROWS}/views` : path === "/other-site" ? "http://views.test/views" : undefined;

        return frame === undefined
            ? undefined
            : `<!doctype html><title>Runsheet</title><meta name="viewport" content="width=device-width"><h1>Runsheet</h1><iframe src="${frame}" style="width:380px;height:600px;border:0"></iframe>`;
    });
    rows = serve((path) => (path === "/views" ? VIEWS_PAGE : undefined));
    await new Promise<void>((resolve) => top.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => rows.listen(0, "127.0.0.1", resolve));
    topPort = (top.address() as { port: number }).port;
    rowsPort = (rows.address() as { port: number }).port;
});

after(() => cleanUpAll(() => top?.close(), () => rows?.close(), () => cleanUp()));

/**
 * A browser on a headless Chrome: pi.test is the page's server; pi.test on port `ROWS` (the page's site, another origin)
 * and views.test (another site) the frame's.
 */
function browserHere(): PiBrowser {
    return new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test:${ROWS} 127.0.0.1:${rowsPort},MAP pi.test 127.0.0.1:${topPort},MAP views.test 127.0.0.1:${rowsPort}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });
}

const number = (page: string, pattern: RegExp) => Number(pattern.exec(page)?.[1] ?? assert.fail(`${pattern} not in:\n${page}`));
const quoted = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

for (const [where, address, frameOf] of [
    ["in the page", () => "http://pi.test/views", () => ""],
    ["in a frame of another origin of the page's site", () => "http://pi.test/same-site", () => ` \\(in a frame: pi\\.test:${ROWS}\\)`],
    ["in a frame of another site", () => "http://pi.test/other-site", () => " \\(in a frame: views\\.test\\)"],
] as const) {
    test(`with Chrome: each row of a list clickable by its look, with buttons of its own, is a control by its name ${where}; a click selects it, not its buttons (PP-462)`, { skip }, async () => {
        const browser = browserHere();
        const frame = frameOf();

        try {
            const page = await browser.open(1, address());
            const controls = page.split("Visible text:")[0]!;

            // Each view once, by its name; its buttons as before.
            for (const view of VIEWS) {
                assert.equal(controls.match(new RegExp(`\\] clickable "${quoted(view)}"${frame}\\n`, "g"))?.length, 1, `${view} once in:\n${controls}`);
            }

            // Never by an icon's label.
            assert.doesNotMatch(controls, /"(Table layout|Default view)"/);
            assert.equal(controls.match(/\] button "Reorder" draggable/g)?.length, VIEWS.length);
            assert.equal(controls.match(/\] button "more"/g)?.length, VIEWS.length);
            // A role=option row with a button is the option itself, as before; a card's link is its control; words with no
            // cursor and no role stay words.
            assert.match(controls, new RegExp(`\\] option "Board Board settings" selected=false${frame}\\n`));
            assert.match(controls, new RegExp(`\\] link "Launch checklist"${frame}\\n`));
            assert.equal(controls.match(/clickable/g)?.length, VIEWS.length, controls);

            const chosen = await browser.click(1, number(page, /\[(\d+)\] clickable "Go \/ No Go"/), NO_CARD);

            assert.match(chosen, /Current view: Go \/ No Go/);

            const option = await browser.click(1, number(chosen, /\[(\d+)\] option "Board Board settings"/), NO_CARD);

            assert.match(option, /Layout: Board/);
            assert.match(await browser.click(1, number(option, /\[(\d+)\] clickable "Rollback plan"/), NO_CARD), /Current view: Rollback plan/);
        } finally {
            await browser.close();
        }
    });
}

test("with Chrome: a row named so that it may delete, in a frame of another site, asks the owner first; Deny clicks nothing (PP-462, PP-455)", { skip }, async () => {
    const browser = browserHere();

    try {
        const page = await browser.open(1, "http://pi.test/other-site");
        const row = number(page, /\[(\d+)\] clickable "Delete requests"/);
        const denied = answering("Tuan denied it on the card:");

        await assert.rejects(browser.click(1, row, denied), /^Error: Tuan denied it on the card: \[\d+\] Delete requests was not clicked \(it may pay, send, book or delete: delete\)\.$/);
        assert.deepEqual(
            denied.asked.map((step) => [step.tool, step.control, step.risk.word]),
            [["browser_click", "Delete requests", "delete"]],
        );
        assert.match(await browser.snapshot(1), /Current view: none/, "nothing was clicked");

        const approve = answering();

        assert.match(await browser.click(1, row, approve), /Current view: Delete requests/);
        assert.equal(approve.asked.length, 1);
    } finally {
        await browser.close();
    }
});
