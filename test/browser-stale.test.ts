// Pi's browser on pages that change under it, with a Chrome on the machine (CI): a layout that shifts between Pi's
// check of a control and its click (PP-447); a list whose options a portal renders a moment after it opens (PP-448); an
// address that differs only in its #part (PP-449).
import { cleanUp, cleanUpAll } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { type Decider, readAnswers } from "../src/server/browser/run.ts";
import { NO_CARD } from "./no-card.ts";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const skip = chrome === undefined ? "no Chrome on this machine (CI runs it)" : false;

/** Two buttons under a loading line; `moves` says when the line goes or comes, as data that comes in steps would. */
const shifting = (moves: string) => `<!doctype html><title>Shift</title><meta name="viewport" content="width=device-width">
    <style>body{margin:0;font:16px sans-serif} button{display:block;width:240px;height:48px;margin:0;border:1px solid #888}</style>
    <div id="bar" style="height:48px;background:#fd8">Loading</div>
    <button id="match" onclick="out.textContent='Clicked Match again'">Match again</button>
    <button id="handoff" onclick="out.textContent='Clicked Human handoff'">Human handoff</button>
    <p id="out">Nothing clicked</p>
    <script>${moves}</script>`;

const PAGES: Record<string, string> = {
    // The loading line goes on the first pointer move: the point Pi checked is now over the button below.
    "/shift": shifting("addEventListener('mousemove', () => bar.remove(), { once: true });"),
    // The line goes and comes on every pointer move: the button never holds still under the pointer.
    "/jumpy": shifting("addEventListener('mousemove', () => { bar.hidden = !bar.hidden; });"),
    // A combobox button (as auton-ui's FilterSelect) that the page draws again when it opens and when a choice is made,
    // whose options a portal renders at the end of the body 800 ms after it opens (they come with data); and one that
    // never opens. A link above, which a stray click would follow.
    "/combo": `<!doctype html><title>Combo</title><meta name="viewport" content="width=device-width">
        <style>body{font:16px sans-serif} [role=listbox]{position:fixed;left:8px;top:120px;background:#fff;border:1px solid #888} [role=option]{padding:8px 16px;cursor:pointer}</style>
        <a href="#/reviews" style="display:block">Reviews</a>
        <span id="slot"></span> <button role="combobox" aria-expanded="false" aria-haspopup="listbox">Status: Any</button>
        <p id="out">Showing all</p>
        <script>
            let value = 'All';
            function render(open) {
                const b = document.createElement('button');
                b.setAttribute('role', 'combobox'); b.setAttribute('aria-haspopup', 'listbox');
                b.setAttribute('aria-expanded', String(open)); b.textContent = 'Show: ' + value;
                b.onclick = () => {
                    render(true);
                    setTimeout(() => {
                        const list = document.createElement('div');
                        list.setAttribute('role', 'listbox');
                        for (const name of ['All', 'Approved', 'Rejected']) {
                            const o = document.createElement('div');
                            o.setAttribute('role', 'option'); o.textContent = name;
                            o.onclick = () => { value = name; list.remove(); render(false); out.textContent = 'Showing ' + name.toLowerCase(); };
                            list.append(o);
                        }
                        document.body.append(list);
                    }, 800);
                };
                slot.replaceChildren(b);
            }
            render(false);
        </script>`,
    // The same combobox, its options `?delay=` ms after it opens (PP-457: 1.2 s on the fixture Jev judged wrong), each
    // click opening another list, as the page did; how many lists it opened is kept in the body's `data-opened` (read
    // from browser_eval's world of its own, which does not see the page's variables).
    "/late-combo": `<!doctype html><title>Late combo</title><meta name="viewport" content="width=device-width">
        <style>body{font:16px sans-serif} [role=listbox]{position:fixed;left:8px;top:120px;background:#fff;border:1px solid #888} [role=option]{padding:8px 16px;cursor:pointer}</style>
        <span id="slot"></span>
        <p id="out">Show: All</p>
        <script>
            const delay = Number(new URLSearchParams(location.search).get('delay'));
            let value = 'All';
            document.body.dataset.opened = '0';
            function render(open) {
                const b = document.createElement('button');
                b.setAttribute('role', 'combobox'); b.setAttribute('aria-haspopup', 'listbox');
                b.setAttribute('aria-expanded', String(open)); b.textContent = 'Show: ' + value;
                b.onclick = () => {
                    render(true);
                    setTimeout(() => {
                        document.body.dataset.opened = String(Number(document.body.dataset.opened) + 1);
                        const list = document.createElement('div');
                        list.setAttribute('role', 'listbox');
                        for (const name of ['All', 'Approved', 'Rejected']) {
                            const o = document.createElement('div');
                            o.setAttribute('role', 'option'); o.textContent = name;
                            o.onclick = () => { value = name; list.remove(); render(false); out.textContent = 'Shown: ' + name; };
                            list.append(o);
                        }
                        document.body.append(list);
                    }, delay);
                };
                slot.replaceChildren(b);
            }
            render(false);
        </script>`,
    // The first page in a frame of the page's own.
    "/framed": `<!doctype html><title>Framed</title><meta name="viewport" content="width=device-width">
        <style>body{margin:0} iframe{display:block;width:300px;height:220px;border:0}</style><iframe src="/shift"></iframe>`,
};

let server: Server;
let port = 0;
/** The single-page app's (`/app`): the signed-in person's role on the server, and how many times its document loaded. */
let role = "viewer";
let loads = 0;

before(async () => {
    server = createServer((request, response) => {
        const path = (request.url ?? "/").split("?")[0]!;

        if (path === "/api/me") {
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({ role }));

            return;
        }

        // A single-page app with routes in the #part; its role comes from the server when its document loads.
        if (path === "/app") {
            loads += 1;
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
            response.end(`<!doctype html><title>App</title><p id="who">Loading</p><p id="route"></p><p>Document load ${loads}</p>
                <script>
                    fetch('/api/me', { cache: 'no-store' }).then((r) => r.json()).then((me) => { who.textContent = 'Role ' + me.role; });
                    const show = () => { route.textContent = 'Route ' + (location.hash || '#/'); };
                    addEventListener('hashchange', show); show();
                </script>`);

            return;
        }

        const page = PAGES[path];

        response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
        response.end(page ?? "not here");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => cleanUpAll(() => server?.close(), () => cleanUp()));

function browserHere(): PiBrowser {
    return new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });
}

/** The number of the control a pattern finds in a read. */
const number = (page: string, pattern: RegExp) => Number(pattern.exec(page)?.[1] ?? assert.fail(`${pattern} not in:\n${page}`));

test("with Chrome: a click whose control moves just before it lands on that control, not on what is there now; one that keeps moving clicks nothing (PP-447)", { skip }, async () => {
    const browser = browserHere();

    try {
        // The line goes as the pointer comes: the old point is over "Human handoff" now. Pi points again.
        const page = await browser.open(1, "http://pi.test/shift");

        assert.match(page, /Loading/);

        const clicked = await browser.click(1, number(page, /\[(\d+)\] button "Match again"/), NO_CARD);

        assert.match(clicked, /Clicked Match again/);
        assert.doesNotMatch(clicked, /Clicked Human handoff/);

        // A double click and a right click are guarded too.
        const twice = await browser.open(1, "http://pi.test/shift?double");
        const doubled = await browser.click(1, number(twice, /\[(\d+)\] button "Match again"/), NO_CARD, false, { how: "double" });

        assert.doesNotMatch(doubled, /Clicked Human handoff/);
        assert.match(doubled, /Clicked Match again/);

        // It moves on every pointer move: refused, and nothing on the page was clicked.
        const jumpy = await browser.open(1, "http://pi.test/jumpy");

        await assert.rejects(browser.click(1, number(jumpy, /\[(\d+)\] button "Match again"/), NO_CARD), /\[\d+\] Match again kept moving \(the click would have landed on (button "Human handoff"|div "Loading")\): nothing was clicked\./);
        assert.match(await browser.snapshot(1), /Nothing clicked/);

        // In a frame: the guard is in the frame, and the page around it.
        const framed = await browser.open(1, "http://pi.test/framed");
        const inFrame = await browser.click(1, number(framed, /\[(\d+)\] button "Match again" \(in a frame/), NO_CARD);

        assert.match(inFrame, /Clicked Match again/);
        assert.doesNotMatch(inFrame, /Clicked Human handoff/);
    } finally {
        await browser.close();
    }
});

test("with Chrome: browser_select opens a combobox whose options a portal renders a moment later, and picks one by name; one that does not open is refused, nothing else clicked (PP-448)", { skip }, async () => {
    const browser = browserHere();

    try {
        const page = await browser.open(1, "http://pi.test/combo");
        const chosen = await browser.select(1, number(page, /\[(\d+)\] combobox "Show: All"/), "Approved");

        assert.match(chosen, /^Chose "Approved"\./);
        assert.match(chosen, /combobox "Show: Approved" expanded=false/);
        assert.match(chosen, /Showing approved/);

        // Never opens: said so, with the page now; the link above was not followed.
        await assert.rejects(browser.select(1, number(chosen, /\[(\d+)\] combobox "Status: Any"/), "Open"), /\[\d+\] Status: Any did not open: no list of options showed within 3 s of the click, and nothing else was clicked\./);
        assert.match(await browser.snapshot(1), /^Combo — http:\/\/pi\.test\/combo\n/);
    } finally {
        await browser.close();
    }
});

/**
 * A run model as Jev judged the late combobox (PP-457), never a model: it picks the option "Approved" when one is offered,
 * else clicks the "Show" combobox (again, if it is still there); done once the page shows "Shown: Approved".
 */
const lateComboDecider: Decider = {
    label: "a stub",
    async decide(state, questions) {
        const offered = Object.entries((questions.click_target as { criteria: Record<string, string> } | undefined)?.criteria ?? {});
        const approved = offered.find(([, label]) => /\] Approved$/.test(label));
        const show = offered.find(([, label]) => /\] Show: /.test(label));
        const done = state.page.text.includes("Shown: Approved");
        const answers: Record<string, unknown> = { operation: { choice: done ? "DONE" : "CLICK" }, goal_achieved: { noul: done ? 0.95 : 0 } };

        if (questions.click_target) {
            answers.click_target = { choice: (approved ?? show ?? offered[0]!)[0] };
        }

        if (questions.prev_ok) {
            answers.prev_ok = { noul: 0.9 };
        }

        return { answers: readAnswers(questions, answers), cost: 0, tokens: { input: 0, output: 0 } };
    },
};

test("with Chrome: browser_run waits for what a click opens late, and never clicks an open combobox again while its options come (PP-457)", { skip }, async () => {
    const browser = browserHere();
    const run = () => browser.run(1, { goal: "Set Show to Approved", values: {}, maxSteps: 6, decider: lateComboDecider, approve: NO_CARD });

    try {
        // Options 1.2 s after the click: the next step reads them, and picks one; one list opened.
        await browser.open(1, "http://pi.test/late-combo?delay=1200");
        const late = await run();

        assert.equal(late.result.status, "done", late.page);
        assert.deepEqual(late.result.steps.map((step) => step.did.replace(/\[\d+\] /, "")), ["clicked Show: All", "clicked Approved"]);
        assert.deepEqual(await browser.evaluate(1, "document.body.dataset.opened", false), { json: '"1"' });

        // Later than the run waits (3.6 s): the combobox is open with nothing in it; the run waits for its options rather
        // than click it again (a second list), then picks one.
        await browser.open(1, "http://pi.test/late-combo?delay=3600");
        const later = await run();

        assert.equal(later.result.status, "done", later.page);
        assert.match(later.result.steps[1]!.did, /^waited for the options of \[\d+\] Show: All, which is open \(not clicked again\)$/);
        assert.equal(later.result.steps.at(-1)!.did.replace(/\[\d+\] /, ""), "clicked Approved");
        assert.deepEqual(await browser.evaluate(1, "document.body.dataset.opened", false), { json: '"1"' });
    } finally {
        await browser.close();
    }
});

test("with Chrome: browser_open loads the page anew when only the address's #part differs, or nothing does, as when the query differs (PP-449)", { skip }, async () => {
    const browser = browserHere();
    /** The page once the app has asked the server who is signed in. */
    const settled = async (page: string) => (/Role \w+/.test(page) ? page : browser.wait(1, { text: "Role " }));

    try {
        role = "viewer";
        loads = 0;

        const first = await settled(await browser.open(1, "http://pi.test/app?v=22#/reviews"));

        assert.match(first, /Role viewer\nRoute #\/reviews\nDocument load 1/);

        // The role changes on the server; only the #part of the address differs.
        role = "admin";

        const hash = await settled(await browser.open(1, "http://pi.test/app?v=22#/trace"));

        assert.match(hash, /Role admin\nRoute #\/trace\nDocument load 2/);

        // The same address again, and one whose query differs.
        role = "reviewer";
        assert.match(await settled(await browser.open(1, "http://pi.test/app?v=22#/trace")), /Role reviewer\nRoute #\/trace\nDocument load 3/);
        role = "owner";
        assert.match(await settled(await browser.open(1, "http://pi.test/app?v=23#/trace")), /Role owner\nRoute #\/trace\nDocument load 4/);
    } finally {
        await browser.close();
    }
});
