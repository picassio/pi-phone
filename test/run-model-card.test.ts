// Pi's run model on a real site (PP-456): browser_run with a `model` other than the setting's asks the owner on a card
// at the run's first step on a real site; on a test site (localhost, private addresses, reserved test names, file:,
// the owner's browser.testSites) it does not; nor without `model`, or with the setting's own. Deny runs with the
// setting's model, said in the answer; a run that moves from a test site to a real one asks there. computer_run's app
// window is never a test site. And the setting itself: the owner's, checked, in Settings › Pi's browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Approvals } from "../src/server/host.ts";
import type { Decider, Question } from "../src/server/browser/run.ts";
import createBrowser from "../src/server/extensions/browser.ts";
import createComputer from "../src/server/extensions/computer.ts";
import { isTestSite, parseTestSites, siteOf } from "../src/server/test-sites.ts";
import { cleanUp, openApp, owner, scriptedModel } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

test("test sites: this machine and private networks, reserved test names, file: pages, and the owner's list; everything else is real", () => {
    for (const url of [
        "http://127.0.0.1:5299/",
        "http://localhost:3000/app",
        "http://[::1]:8787/",
        "http://192.168.1.50/",
        "http://10.0.0.2/",
        "http://172.20.1.1/",
        "http://100.119.9.4/",
        "https://shop.test/cart",
        "https://app.localhost/",
        "http://printer.local/",
        "https://www.example/",
        "https://x.invalid/",
        "https://grafana.internal/",
        "file:///home/me/page.html",
        "about:blank",
    ]) {
        assert.equal(isTestSite(url, []), true, url);
    }

    for (const url of ["https://example.com/", "https://shop.example.com/cart", "https://box.tail1234.ts.net/", "http://8.8.8.8/", "https://172.32.0.1/", "app:demo_app.py", "not an address"]) {
        assert.equal(isTestSite(url, []), false, url);
    }

    assert.equal(isTestSite("https://box.tail1234.ts.net/", ["*.ts.net"]), true);
    assert.equal(isTestSite("https://staging.example.com/", ["staging.example.com"]), true);
    assert.equal(isTestSite("https://www.example.com/", ["staging.example.com"]), false);
    assert.deepEqual(parseTestSites("*.ts.net, Staging.Example.com\n*.ts.net"), { sites: ["*.ts.net", "staging.example.com"] });
    assert.deepEqual(parseTestSites("none"), { sites: [] });
    assert.deepEqual(parseTestSites("https://x.com, a b"), { bad: ["https://x.com"] });
    assert.deepEqual(parseTestSites("*.ts.net, *bad"), { bad: ["*bad"] });
    assert.equal(siteOf("https://example.com:8443/a"), "example.com:8443");
});

const QUESTIONS: Record<string, Question> = {
    operation: { type: "choice", criteria: { DONE: "Done", BLOCKED: "Blocked" }, instructions: "Next" },
    goal_achieved: { type: "noul", criteria: { true: "Yes", false: "No" }, instructions: "Met?" },
};
const DONE = '{"operation": {"choice": "DONE"}, "goal_achieved": {"noul": 0.9}}';

/**
 * browser_run against a stand-in host and browser (real `Approvals`): the run decides one step on each page of
 * `pages`; the session's model and Jev (OpenRouter's route, stood in) answer DONE and are recorded. `answer` answers
 * a card that comes, if one does.
 */
async function browserRun(options: { setting: string; model?: "jev" | "session"; pages: string[]; sites?: string[]; answer?: boolean }) {
    const approvals = new Approvals(() => "u1");
    const cards: { subject: string; form: unknown }[] = [];
    const decided: string[] = [];
    const charged: string[] = [];
    const browser = {
        open: async () => {},
        run: async (_session: number, run: { decider: Decider }) => {
            let cost = 0;

            for (const url of options.pages) {
                cost += (await run.decider.decide({ page: { url, title: "A page", text: "" }, elements: [], recent_actions: [] }, QUESTIONS)).cost;
            }

            return { result: { status: "done", steps: [], decisions: options.pages.length, cost, tokens: { input: 10, output: 1 }, ms: 1000 }, page: "the page" };
        },
        windowAsks: () => [],
        permissionAsks: () => [],
    };
    const host = {
        approvals,
        requesterOf: () => "u1",
        people: () => [{ id: "u1", name: "Tuan", role: "owner" }],
        browserFor: () => browser,
        browserRunModel: () => options.setting,
        browserTestSites: () => options.sites ?? [],
        apiKey: async () => "sk-or-test",
        askSessionModel: async () => {
            decided.push("session");

            return DONE;
        },
        chargeSession: async (_id: unknown, key: string) => void charged.push(key),
        secrets: { value: () => undefined, used: () => {} },
    };
    const tool = (createBrowser(host as never) as unknown as { tools: { name: string; execute(args: unknown, api: unknown, context: unknown): Promise<{ output: { text: string }[] }> }[] }).tools.find(
        (each) => each.name === "browser_run",
    )!;
    const fetching = globalThis.fetch;

    globalThis.fetch = (async (_url: string, init: { body: string }) => {
        decided.push((JSON.parse(init.body) as { model: string }).model);

        return new Response(JSON.stringify({ answers: JSON.parse(DONE), usage: { cost: 0.0001, input_tokens: 10, output_tokens: 1 } }));
    }) as unknown as typeof fetch;

    // The owner answers each card as it comes.
    const answering = setInterval(() => {
        for (const card of approvals.all()) {
            cards.push({ subject: card.subject, form: card.form });
            approvals.answer(card.id, { allow: options.answer === true, by: "Tuan" });
        }
    }, 5);

    try {
        const done = await tool.execute(
            { goal: "Search the shop for lamps", ...(options.model === undefined ? {} : { model: options.model }) },
            // A model's call (PP-469: browser calls run in their batch's order, and know their message by their tool task).
            { conversationId: 7, taskId: "t1", callId: "c1", agent: async () => ({ cwd: "/work" }), snapshot: async () => undefined, getTask: async () => ({ input: { kind: "model", assistant: 1, callId: "c1" } }) },
            BACKGROUND_CONTEXT,
        );

        return { cards, decided, charged, text: done.output[0]!.text };
    } finally {
        clearInterval(answering);
        globalThis.fetch = fetching;
    }
}

test("Pi's model on a test site (http://127.0.0.1:5299): no card, Pi's model decides", async () => {
    const run = await browserRun({ setting: "session", model: "jev", pages: ["http://127.0.0.1:5299/"] });

    assert.deepEqual(run.cards, []);
    assert.deepEqual(run.decided, ["typesafe/jev-1.14"]);
    assert.deepEqual(run.charged, ["openrouter/typesafe/jev-1.14"]);
    assert.match(run.text, /1 decision by Jev \(typesafe\/jev-1\.14\) as Pi asked, \$0\.00010\./);
});

test("Pi's model on a real site (https://example.com): the owner's card; Deny runs with the setting's model and says so; Approve once runs with Pi's", async () => {
    const denied = await browserRun({ setting: "session", model: "jev", pages: ["https://example.com/"] });

    assert.deepEqual(denied.cards, [{ subject: "example.com", form: { type: "run-model", site: "example.com", setting: "session", asked: "typesafe/jev-1.14", provider: "openrouter", place: "browser" } }]);
    assert.deepEqual(denied.decided, ["session"], "the setting's model decided; nothing went to OpenRouter");
    assert.deepEqual(denied.charged, []);
    assert.match(denied.text, /1 decision by this session's model as the setting says, after the owner's card for Jev \(typesafe\/jev-1\.14\) on example\.com \(Tuan denied it on the card\)\./);

    const approved = await browserRun({ setting: "session", model: "jev", pages: ["https://example.com/", "https://example.com/next"], answer: true });

    assert.equal(approved.cards.length, 1, "one card for the run");
    assert.deepEqual(approved.decided, ["typesafe/jev-1.14", "typesafe/jev-1.14"]);
    assert.match(approved.text, /2 decisions by Jev \(typesafe\/jev-1\.14\) as Pi asked/);

    // The session's model over a Jev setting: its provider gets the page, the card says so.
    const session = await browserRun({ setting: "typesafe/jev-1.13", model: "session", pages: ["https://example.com/"] });

    assert.deepEqual(session.cards.map((card) => card.form), [{ type: "run-model", site: "example.com", setting: "typesafe/jev-1.13", asked: "session", provider: "session", place: "browser" }]);
    assert.deepEqual(session.decided, ["typesafe/jev-1.13"], "denied: the setting's Jev decided");
    assert.deepEqual(session.charged, ["openrouter/typesafe/jev-1.13"]);
});

test("a run that moves from a test site to a real one asks at its first real-site step; what was decided before stays Pi's model's", async () => {
    const run = await browserRun({ setting: "session", model: "jev", pages: ["http://localhost:3000/", "https://shop.example.com/cart"] });

    assert.deepEqual(run.cards.map((card) => card.subject), ["shop.example.com"]);
    assert.deepEqual(run.decided, ["typesafe/jev-1.14", "session"]);
    assert.deepEqual(run.charged, ["openrouter/typesafe/jev-1.14"], "Spend gets the one Jev decision");
});

test("the owner's test sites (*.ts.net) need no card; no model, or the setting's own, never asks anywhere", async () => {
    const tailnet = await browserRun({ setting: "session", model: "jev", pages: ["https://box.tail1234.ts.net/"], sites: ["*.ts.net"] });

    assert.deepEqual(tailnet.cards, []);
    assert.deepEqual(tailnet.decided, ["typesafe/jev-1.14"]);

    const none = await browserRun({ setting: "typesafe/jev-1.14", pages: ["https://example.com/"] });

    assert.deepEqual([none.cards, none.decided], [[], ["typesafe/jev-1.14"]]);

    const same = await browserRun({ setting: "typesafe/jev-1.14", model: "jev", pages: ["https://example.com/"] });

    assert.deepEqual([same.cards, same.decided], [[], ["typesafe/jev-1.14"]]);
    assert.match(same.text, /as Pi asked/);
});

test("computer_run with Pi's model: an app's window is never a test site, so the owner's card first", async () => {
    const approvals = new Approvals(() => "u1");
    const session = { machine: "m1", machineName: "box", conversationId: 7, session: 7, approvedBy: "Tuan", apps: [], reason: "test", startedAt: 0, until: Date.now() + 600_000 };
    const host = {
        approvals,
        requesterOf: () => "u1",
        person: () => ({ role: "owner" }),
        people: () => [{ id: "u1", name: "Tuan", role: "owner" }],
        computer: {
            unavailable: () => undefined,
            sessionOfConversation: () => session,
            screen: async () => ({ text: ["App=mail (pid 1)", 'Window: "Mail", App: mail.', "\t0 frame Mail Frame: {x: 0, y: 0, width: 420, height: 220}"].join("\n") }),
        },
        browserRunModel: () => "typesafe/jev-1.14",
        browserTestSites: () => ["*.ts.net"],
        apiKey: async () => "sk-or-test",
        askSessionModel: async () => DONE,
        chargeSession: async () => {},
        secrets: { value: () => undefined, used: () => {} },
    };
    const tool = (createComputer(host as never) as unknown as { tools: { name: string; execute(args: unknown, api: unknown, context: unknown): Promise<{ output: { text: string }[] }> }[] }).tools.find(
        (each) => each.name === "computer_run",
    )!;
    const done = tool.execute({ goal: "Read the mail", model: "session" }, { conversationId: 7, taskId: "t2", callId: "c2" }, BACKGROUND_CONTEXT);

    for (let tries = 0; approvals.all().length === 0 && tries < 200; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const card = approvals.all()[0]!;

    assert.deepEqual(card.form, { type: "run-model", site: "mail on box", setting: "typesafe/jev-1.14", asked: "session", provider: "session", place: "computer" });
    approvals.answer(card.id, { allow: true, by: "Tuan" });
    assert.match((await done).output[0]!.text, /by this session's model as Pi asked/);
});

test("browser.testSites: the owner's, checked, kept; in the settings Pi changes with a card", async () => {
    const app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));

    try {
        const guest = app.config.addUser("Lan", "guest").user;

        assert.throws(() => app.setBrowserTestSites(guest, "*.ts.net"), /Only the owner can do that/);
        assert.throws(() => app.setBrowserTestSites(owner(app), "https://x.com"), /not https:\/\/x\.com/);
        assert.equal(app.setBrowserTestSites(owner(app), "*.ts.net, Staging.Example.com"), "");
        assert.deepEqual(app.config.browserTestSites, ["*.ts.net", "staging.example.com"]);
        assert.equal(app.setBrowserTestSites(owner(app), "*.ts.net staging.example.com"), "Unchanged.");
        assert.equal(app.setBrowserTestSites(owner(app), "none"), "Only the built-in test sites now.");
        assert.deepEqual(app.config.browserTestSites, []);
    } finally {
        await app.close();
        cleanUp();
    }
});
