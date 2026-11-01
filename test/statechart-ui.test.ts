// The statechart skill end to end in a real browser (PP-316): Pi runs the skill's script on statechart-art's boba Bug
// model with the TLC that TLA2TOOLS and JAVA name (exit 1: a rule breaks), and its reply shows chart.mmd as a mermaid
// block, which the chat draws with pele: the states on the shortest path to the bug have the theme's bug-path border,
// the state that breaks the rule the theme's red, and the legend says which is which. Without Chromium or TLC (the
// phone) it is skipped; CI runs it with both, as did tuanlh-devbox-01. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, context, home, lastText, newSession, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { SKILL } from "../scripts/sync-statechart.ts";

const { PocketApp } = await import("../src/server/app.ts");

const chromium = findBrowser();
const tlc = process.env.TLA2TOOLS;
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : tlc === undefined || tlc === "" ? "no TLC here (TLA2TOOLS unset)" : false,
} as const;
const SHOTS = process.env.PHONE_SHOTS;
const out = join(work, "bug-chart");
const bug = join(SKILL, "examples", "bug");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what);

before(async () => {
    if (real.skip !== false) {
        return;
    }

    // Pi as the skill says: run the command, then report the verdict by its exit code, with the chart as a mermaid block.
    const route: FauxResponseStep = (request) => {
        const { role, text } = lastText(request as never);

        if (role === "user" && text.endsWith("check the boba bug")) {
            return fauxAssistantMessage(
                [fauxToolCall("bash", { command: `sh ${SKILL}/scripts/statechart ${bug}/Bug.tla --view ${bug}/view.mjs --out ${out}; echo "exit $?"` })],
                { stopReason: "toolUse" },
            );
        }

        if (role === "toolResult") {
            const code = /exit (\d+)/.exec(text)?.[1];

            return fauxAssistantMessage([
                fauxText(
                    `TLC ran (exit ${code}): a rule breaks. NeverServeOldPearls (never serve a cup of old pearls) breaks after 6 steps: just boiled, chewy, chewy, getting firm, too old, a rush starts, then a cup is served in a rush.\n\n\`\`\`mermaid\n${readFileSync(join(out, "chart.mmd"), "utf8").trim()}\n\`\`\``,
                ),
            ]);
        }

        return fauxAssistantMessage([fauxText("ok")]);
    };
    const faux = scriptedModel(route);

    app = await PocketApp.open({
        dataDir: join(root, "statechart-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        officecli: { runs: false },
    });
    pastWelcome(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // PI_CHROME_NO_SANDBOX=1 where the sandbox cannot start (Ubuntu's AppArmor on a devbox), as the server image sets it.
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "statechart-ui-browser-")),
        ...(process.env.PI_CHROME_NO_SANDBOX === "1" ? { args: ["--no-sandbox"] } : {}),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 600));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

test("Pi checks the boba Bug model (exit 1), and the chat draws its chart with the bug path and the broken rule marked", real, async () => {
    const id = await newSession(app);
    const owner = app.config.users.find((user) => user.role === "owner")!;
    const { submissionId } = await app.commands.submit(id, owner, { text: "check the boba bug", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    assert.equal(readFileSync(join(out, "chart.mmd"), "utf8"), readFileSync(join(bug, "chart", "chart.mmd"), "utf8"), "the chart statechart-art's repo holds");

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
    await page.evaluate(`(await import("/store.js")).navigate(${id}); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('.rich-diagram-canvas svg .pele-node').length > 6)`, "the chart drawn");

    // Each mark's colour as the browser draws it, against the theme's own colour for it.
    const marks = await inPage<{ said: boolean; path: string[]; pathWidth: string[]; breaks: { stroke: string; fill: string; text: string }; legend: string[]; blue: string; red: string; plain: string; surface: string }>(`
        const canvas = document.querySelector(".rich-diagram-canvas");
        const color = (value) => { const probe = document.createElement("i"); probe.style.color = value; canvas.append(probe); const got = getComputedStyle(probe).color; probe.remove(); return got; };
        const rect = (id) => getComputedStyle(canvas.querySelector('.pele-node[data-id="' + id + '"] > rect'));
        const nodes = [...canvas.querySelectorAll(".pele-node.bugPath")];
        return JSON.stringify({
            said: [...document.querySelectorAll(".md p")].some((p) => p.textContent.includes("(exit 1): a rule breaks")),
            path: nodes.map((node) => getComputedStyle(node.querySelector("rect")).stroke),
            pathWidth: nodes.map((node) => getComputedStyle(node.querySelector("rect")).strokeWidth),
            breaks: { stroke: rect("s5").stroke, fill: rect("s5").fill, text: getComputedStyle(canvas.querySelector('.pele-node[data-id="s5"] > text')).fill },
            legend: [...canvas.querySelectorAll('.pele-node[data-id^="lg"]')].map((node) => node.dataset.id + " " + [...node.classList].filter((name) => !name.startsWith("pele-")).join(" ") + ": " + node.textContent.replace(/\\s+/g, "")),
            blue: color("var(--pele-series-8)"),
            red: color("var(--pele-series-7)"),
            plain: rect("s4").stroke,
            surface: color("var(--pele-surface)"),
        });
    `);

    assert.equal(marks.said, true, "the verdict: exit 1 is a broken rule");
    // s0, s1, s2, s3 and s5, and the legend's sample: the bug path's border, over the broken state's red one too.
    assert.equal(marks.path.length, 6, JSON.stringify(marks));
    assert.deepEqual(new Set(marks.path), new Set([marks.blue]), JSON.stringify(marks));
    assert.deepEqual(new Set(marks.pathWidth), new Set(["2.5px"]));
    assert.notEqual(marks.plain, marks.blue, "a state off the path keeps the plain border");
    assert.equal(marks.breaks.text, marks.red, "the broken state's words in the theme's red, not the chart's own #cd2834");
    assert.notEqual(marks.breaks.fill, "rgb(255, 236, 238)", "nor the chart's light fill on a dark theme");
    assert.deepEqual(marks.legend, ["lg0 breaks: BreaksNeverServeOldPearls", "lg1 bugPath: PathtotheNeverServeOldPearlsbug"]);
    await page.evaluate(`document.querySelector(".rich-diagram").scrollIntoView({ block: "start" }); return "true";`);
    await shot("statechart-bug-390.png");
    await page.setViewport(VIEWPORTS.desktop);
    await see(`return JSON.stringify(document.querySelector('.rich-diagram-canvas svg') !== null)`, "drawn at desktop width");
    await page.evaluate(`document.querySelector(".rich-diagram").scrollIntoView({ block: "start" }); return "true";`);
    await shot("statechart-bug-1280.png");
});
