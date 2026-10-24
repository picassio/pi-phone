/**
 * How much main-thread work opening a long session from the list, and going Back to the list, costs on a slow phone
 * (PP-133). The app runs from this checkout with the tests' scripted model; a headless Chromium at phone size (390x844,
 * touch) has its CPU slowed 4x and 130 ms added to every request. One session has a long transcript (Pi's calls, their
 * results, and answers with code blocks and tables), among others in the list. Each run opens it from the list, waits until its rows show and the
 * page is quiet, then goes Back and waits the same: the change in Chromium's TaskDuration and ScriptDuration
 * (Performance.getMetrics) across each is that step's main-thread time. Prints the median of the runs, as JSON too.
 *
 *   node scripts/bench-open.ts                 5 runs, after one to warm up
 *   node scripts/bench-open.ts --runs 9 --turns 120 --sessions 60
 *
 * Needs a Chromium-based browser (as the UI tests do); not for the phone.
 */
import { cleanUp, newSession, openApp, root, say, scriptedModel, until } from "../test/helpers.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Chromium, type Json } from "../test/support/browser/cdp.ts";
import { findBrowser } from "../test/support/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const { values } = parseArgs({
    options: {
        runs: { type: "string", default: "5" },
        // Each turn is 4 entries: the message, Pi's call, its result, and Pi's answer.
        turns: { type: "string", default: "80" },
        // Other sessions in the list, each with one turn: what Back draws.
        sessions: { type: "string", default: "40" },
        cpu: { type: "string", default: "4" },
        latency: { type: "string", default: "130" },
        // How long the page must stay on the new screen before its work is read: what it does after the rows show.
        settle: { type: "string", default: "1500" },
    },
});
const runs = Number(values.runs);
const turns = Number(values.turns);
const others = Number(values.sessions);
const settleMs = Number(values.settle);
const executable = findBrowser();

if (executable === undefined) {
    throw new Error("No Chromium-based browser on this machine: the benchmark needs one.");
}

/** An answer as Pi writes them: a paragraph, a code block, a list, and a small table. */
function answer(n: number): string {
    return [
        `Turn ${n}: the change is in **web/transcript.js**, and the check passes. Here is the part that matters:`,
        "```ts",
        `export function step${n}(items: readonly number[]): number {`,
        "    let total = 0;",
        "",
        "    for (const item of items) {",
        `        total += item * ${n};`,
        "    }",
        "",
        "    return total;",
        "}",
        "```",
        "- the rows are built once",
        "- the list keeps its order",
        `- \`npm run check\` took ${n % 7} s`,
        "",
        "| file | lines |",
        "| --- | --- |",
        `| web/a.js | ${n * 3} |`,
        `| web/b.js | ${n * 5} |`,
    ].join("\n");
}

/** A message: Pi calls bash; its result: Pi answers. */
const route: FauxResponseStep = (context) => {
    const messages = (context as { messages: readonly { role: string }[] }).messages;
    const last = messages.at(-1);
    const n = messages.filter((message) => message.role === "user").length;

    return last?.role === "toolResult"
        ? fauxAssistantMessage([fauxText(answer(n))])
        : fauxAssistantMessage(
              [fauxToolCall("bash", { command: `printf 'line %s\\n' $(seq 1 12); echo turn ${n}` })],
              { stopReason: "toolUse" },
          );
};

const model = scriptedModel(route);

model.setResponses(Array.from({ length: (turns + others) * 2 + 20 }, () => route));
const app = await openApp(model);
writeFileSync(join(root, "work", "README.md"), "# Bench\n");

for (let n = 0; n < others; n++) {
    await say(app, await newSession(app), `Session ${n}: hello`);
}

const long = await newSession(app);

for (let n = 0; n < turns; n++) {
    await say(app, long, `Question ${n}: what changed in step ${n}?`);
}

const server = createServer(
    createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const chromium = await Chromium.launch(executable, mkdtempSync(join(root, "bench-")), []);
const { connection } = chromium;
const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
const send = (method: string, params: Record<string, unknown> = {}): Promise<Json> =>
    connection.send(method, params, sessionId, 60_000);

/** Run an expression in the page and return its value. */
async function evaluate<T>(expression: string): Promise<T> {
    const reply = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });

    if (reply.exceptionDetails !== undefined) {
        throw new Error(String(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text));
    }

    return reply.result.value as T;
}

const waitFor = (expression: string, what: string) =>
    until(async () => (await evaluate<boolean>(expression)) === true, what, 60_000);

/** The main thread's busy time so far, in ms: all its tasks, and the script among them. */
async function busy(): Promise<{ task: number; script: number }> {
    const { metrics } = await send("Performance.getMetrics");
    const of = (name: string) =>
        1000 * Number((metrics as { name: string; value: number }[]).find((each) => each.name === name)?.value ?? 0);

    return { task: of("TaskDuration"), script: of("ScriptDuration") };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const agent = (await connection.send("Browser.getVersion")).userAgent as string;
const version = /Chrome\/([\d.]+)/.exec(agent)?.[1] ?? "130.0.0.0";

await Promise.all([
    send("Page.enable"),
    send("Runtime.enable"),
    send("Network.enable"),
    // Wall time of each task, so the time the slowed CPU takes counts as it would on the phone.
    send("Performance.enable", { timeDomain: "timeTicks" }),
    send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
    }),
    send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }),
    send("Emulation.setUserAgentOverride", {
        userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`,
    }),
]);
await send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}` });
const row = `.home-list .session-row[data-id="${long}"] .session`;
const onList = `location.pathname === "/" && document.querySelector(${JSON.stringify(row)}) !== null`;

await waitFor(onList, "the session list");
await send("Emulation.setCPUThrottlingRate", { rate: Number(values.cpu) });
await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: Number(values.latency),
    downloadThroughput: -1,
    uploadThroughput: -1,
});

/** The session's rows on screen, the newest at the bottom. */
const opened = `location.pathname === "/s/${long}" &&
    document.querySelectorAll(".pane > .scroller .transcript [id^='entry-']").length > 20 &&
    !document.querySelector(".pane > .scroller .boot")`;

type Step = { task: number; script: number; wall: number };

/** Do `act`, wait for `done`, then for the page to settle: its main-thread work across all of it. */
async function measure(act: string, done: string, what: string): Promise<Step> {
    await pause(1500);
    const before = await busy();
    const started = performance.now();

    await evaluate(act);
    await waitFor(done, what);
    const wall = performance.now() - started;

    await pause(settleMs);
    const after = await busy();

    return { task: after.task - before.task, script: after.script - before.script, wall };
}

const results: { open: Step[]; back: Step[] } = { open: [], back: [] };

for (let run = 0; run <= runs; run++) {
    const open = await measure(
        `document.querySelector(${JSON.stringify(row)}).click()`,
        opened,
        "the session's rows",
    );
    const back = await measure("history.back()", onList, "the session list again");

    // The first run warms the page up (modules, fonts, the highlighter): not counted.
    if (run > 0) {
        results.open.push(open);
        results.back.push(back);
    }
}

const median = (list: number[]) => {
    const sorted = [...list].sort((a, b) => a - b);

    return Math.round(sorted[Math.floor(sorted.length / 2)] ?? Number.NaN);
};
const summary = (steps: Step[]) => ({
    taskMs: median(steps.map((step) => step.task)),
    scriptMs: median(steps.map((step) => step.script)),
    wallMs: median(steps.map((step) => step.wall)),
    runs: steps.map((step) => Math.round(step.task)),
});
const entries = await evaluate<number>(
    `import("/store.js").then(({ store }) => store.state.sessions.length)`,
);

console.log(
    JSON.stringify(
        {
            turns,
            entries: turns * 4,
            sessions: entries,
            cpu: Number(values.cpu),
            latency: Number(values.latency),
            open: summary(results.open),
            back: summary(results.back),
        },
        null,
        2,
    ),
);
chromium.kill();
server.closeAllConnections();
server.close();
await app.close();
cleanUp();
