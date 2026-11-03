// Running now as a board (PP-355, after pi-pocket 0.28 #232 and its "keeps time" fix): the sessions at work with the
// message they work on and when each task started, every scheduled message with its next times and whether it is held,
// only what each person may see; and in a real Chromium, the timeline, the countdowns that tick between answers, and a
// held schedule that says it is cancelled at its time. With PHONE_SHOTS, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { runningBoard } from "../src/server/running.ts";

const SHOTS = process.env.PHONE_SHOTS;

/** Asked to wait, the model runs a slow command; then it answers. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done waiting")]);
    }

    if (text.endsWith("wait a while")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 6" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let server: Server;
let base: string;

before(async () => {
    app = await openApp(scriptedModel(route, { contextWindow: 1_000_000 }));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the board has the sessions at work with their message and tasks' start, and every schedule with its next times", async () => {
    const busy = await newSession(app);
    const quiet = await newSession(app);
    const once = await app.commands.schedule(quiet, owner(app), { when: "in 2h look again", zone: "UTC" });
    const hourly = await app.commands.schedule(quiet, owner(app), { when: "every 1h check the build", zone: "UTC" });

    await app.commands.submit(busy, owner(app), { text: "please wait a while", requestId: "board-1" });
    await until(async () => (await runningBoard(app, owner(app))).sessions.some((each) => each.tasks.some((task) => task.label === "running bash")), "the tool call");

    const board = await runningBoard(app, owner(app));
    const working = board.sessions.find((each) => each.id === Number(busy))!;
    const task = working.tasks.find((each) => each.label === "running bash")!;

    assert.equal(working.prompt?.text, "please wait a while");
    assert.ok(task.since !== undefined && task.since <= Date.now() && Date.now() - task.since < 60_000, "when it was first seen");
    assert.equal(typeof working.spent, "number");

    const first = board.schedules.find((each) => each.id === once.id)!;
    const repeat = board.schedules.find((each) => each.id === hourly.id)!;

    assert.deepEqual(first.upcoming, [first.next]);
    assert.equal(first.repeat, undefined);
    assert.equal(repeat.repeat, "every hour");
    assert.equal(repeat.upcoming.length, 24, "a day of hours, at most 24");
    assert.equal(repeat.upcoming[1]! - repeat.upcoming[0]!, 3_600_000);
    assert.ok(board.schedules.indexOf(repeat) < board.schedules.indexOf(first), "soonest first");

    // Someone who sees only the busy session sees none of the other's schedules.
    const scoped = app.config.addUser("Sam", "guest", [String(busy)]).user;

    try {
        assert.deepEqual((await runningBoard(app, scoped)).schedules, []);
    } finally {
        app.config.removeUser(scoped.id);
    }

    await until(() => !app.isBusy(busy), "the run's end");
});

test("a schedule set by someone who can no longer steer is held, and says why", async () => {
    const id = await newSession(app);
    const { user } = app.config.addUser("Vee", "guest", [String(id)]);
    const schedule = await app.commands.schedule(id, user, { when: "in 3h say hi", zone: "UTC" });

    app.config.updateUser(user.id, { role: "viewer" });

    try {
        assert.match((await runningBoard(app, owner(app))).schedules.find((each) => each.id === schedule.id)?.held ?? "", /can no longer steer/);
    } finally {
        await app.commands.cancelSchedule(id, owner(app), schedule.id);
        app.config.removeUser(user.id);
    }
});

test(
    "the sheet draws the schedules on a timeline, and its countdowns tick between answers",
    { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false },
    async () => {
        const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "running-board-ui-")), load: async () => undefined, save: () => {} });
        const busy = await newSession(app);

        try {
            const page = await browsers.open(1);
            const inPage = async <T>(script: string) => JSON.parse(await page.evaluate(script)) as T;
            const shot = async (name: string) => {
                if (SHOTS !== undefined) {
                    mkdirSync(SHOTS, { recursive: true });
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
                }
            };

            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".rail-running") !== null)`), "the rail", 20_000);
            await app.commands.submit(busy, owner(app), { text: "now wait a while", requestId: "board-ui-1" });
            await page.evaluate(`document.querySelector(".rail-running").click(); return "null";`);
            await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelectorAll('[data-part="running-mark"]').length > 3 && document.querySelector('[data-part="running-session"] [data-part="running-prompt"]') !== null)`), "the board");

            // The hourly schedule's marks on its lane, and the countdowns move between the server's answers.
            const countdown = () => inPage<string>(`return JSON.stringify(document.querySelector('[data-part="running-countdown"]').textContent)`);
            const before = await countdown();

            await until(async () => (await countdown()) !== before, "the countdown to move");
            await shot("running-390.jpg");
            await inPage(`document.querySelector('[data-part="running-scheduled"]').scrollIntoView({ block: "start" }); return "null";`);
            await shot("running-scheduled-390.jpg");
            await page.setViewport(VIEWPORTS.desktop);
            await shot("running-1280.jpg");
            await until(() => !app.isBusy(busy), "the run's end", 20_000);
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);
