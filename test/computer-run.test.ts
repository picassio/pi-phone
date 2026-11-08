// computer_run (PP-180): one goal in an app's window, a decision a step, with browser_run's run models. The window's
// elements become the run's targets by role (Linux's AT-SPI names and Windows' UI Automation names), a run fills a
// field with a supplied value, presses keys, scrolls, waits, and ends done only when the goal shows; a secret goes in
// by name and the run model never gets its value; a window that changed under a step is read again; it stops on a
// missing value, three steps that change nothing, an unverified done. The tool is a control session's, blocked in plan
// mode, and its secrets ask the owner as browser_run's do.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { type Answers, type Decider, type DecisionState, type Question, report } from "../src/server/browser/run.ts";
import { parseOutline } from "../src/server/computer-outline.ts";
import { type ComputerRunAction, computerQuestions, computerSpace, runOnComputer } from "../src/server/computer-run.ts";
import { COMPUTER_TOOLS } from "../src/server/deferred-tools.ts";
import createComputer from "../src/server/extensions/computer.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";
import { browserSecretNames } from "../src/server/extensions/secrets.ts";
import { fencedScreen } from "../src/server/fence.ts";
import { BUILT_IN_TOOLS } from "../src/server/reload.ts";

after(() => cleanUp());

/** A Linux app's window (AT-SPI roles), with a name field, a password field, a button, a disabled one and a list. */
const linux = (name = "", greeting = "") =>
    [
        "App=demo_app.py (pid 27702)",
        'Window: "Pi OCU Demo", App: demo_app.py.',
        "\t0 frame Pi OCU Demo Frame: {x: 0, y: 0, width: 420, height: 320}",
        "\t\t1 label Name Frame: {x: 12, y: 10, width: 80, height: 20}",
        `\t\t2 text ${name === "" ? "" : ` Value: ${name}`} Secondary Actions: activate Frame: {x: 12, y: 30, width: 396, height: 24}`,
        "\t\t3 password text [password] Secondary Actions: activate Frame: {x: 12, y: 60, width: 396, height: 24}",
        "\t\t4 push button Greet Secondary Actions: click Frame: {x: 12, y: 90, width: 80, height: 30}",
        "\t\t5 push button Delete States: disabled Frame: {x: 100, y: 90, width: 80, height: 30}",
        "\t\t6 list Frame: {x: 12, y: 130, width: 396, height: 150}",
        "\t\t\t7 list item First Frame: {x: 12, y: 130, width: 396, height: 20}",
        ...(greeting === "" ? [] : [`\t\t8 label ${greeting} Frame: {x: 12, y: 290, width: 300, height: 20}`]),
    ].join("\n");

test("the window's elements become targets by role, on Linux and on Windows (PP-180)", () => {
    const space = computerSpace(parseOutline(linux("Ada")));

    assert.deepEqual(Object.keys(space.targets.SET_VALUE), ["2", "3"], "the text field holding a value, and the password field");
    // Containers do nothing when clicked; a disabled button is left out.
    assert.deepEqual(Object.keys(space.targets.CLICK), ["1", "2", "3", "4", "7"]);
    assert.equal(space.scroller, 6, "the list scrolls");
    // A password field's value never goes to the run model.
    assert.deepEqual(space.elements.find((each) => each.index === "3"), { index: "3", role: "password text", label: "password text [password]", operations: ["SET_VALUE", "CLICK"] });

    const windows = computerSpace(
        parseOutline(
            [
                "App=notepad.exe (pid 4412)",
                'Window: "Untitled - Notepad", App: notepad.exe.',
                "\t0 window Untitled - Notepad Frame: {x: 0, y: 0, width: 800, height: 600}",
                "\t\t1 text Find what: Frame: {x: 10, y: 10, width: 70, height: 20}",
                "\t\t2 edit Find what: Value: hello Frame: {x: 90, y: 10, width: 200, height: 20}",
                "\t\t3 button Find Next Frame: {x: 300, y: 10, width: 80, height: 24}",
                "\t\t4 check box Match case States: checked Frame: {x: 10, y: 40, width: 120, height: 20}",
                "\t\t5 document Text editor Value: notes Frame: {x: 0, y: 70, width: 800, height: 500}",
            ].join("\n"),
        ),
    );

    // Windows' "text" is a label: clicked, never filled; "edit" is a field.
    assert.deepEqual(Object.keys(windows.targets.SET_VALUE), ["2"]);
    assert.deepEqual(Object.keys(windows.targets.CLICK), ["1", "2", "3", "4", "5"]);
    assert.equal(windows.scroller, 5);
    assert.match((computerQuestions(windows, "goal", {}, false).click_target!.criteria as Record<string, string>)["4"]!, /check box Match case \(checked\)/);
});

/** A decider that answers each step from a script, and keeps what it was given. */
function scripted(steps: ((state: DecisionState, questions: Record<string, Question>) => Answers)[]): Decider & { seen: string[] } {
    const seen: string[] = [];
    let at = 0;

    return {
        label: "a script",
        seen,
        async decide(state, questions) {
            seen.push(JSON.stringify({ state, questions }));

            return { answers: steps[Math.min(at++, steps.length - 1)]!(state, questions), cost: 0.001, tokens: { input: 10, output: 2 } };
        },
    };
}

/** The demo window as a running app: a name typed in, Greet shows a greeting. */
function demoWindow(options: { staleOnce?: boolean } = {}) {
    let name = "";
    let greeting = "";
    let stale = options.staleOnce === true;
    const acted: ComputerRunAction[] = [];

    return {
        acted,
        window: {
            read: async () => linux(name, greeting),
            act: async (action: ComputerRunAction) => {
                if (stale) {
                    stale = false;
                    throw new Error("[2] in Pi OCU Demo is no longer what you read (the window changed): read it again with computer_screen.");
                }

                acted.push(action);

                if (action.op === "set_value" && action.index === 2) {
                    name = action.value;
                } else if (action.op === "click" && action.index === 4) {
                    greeting = `Hello ${name}`;
                }

                return { did: action.op === "set_value" ? `Set [${action.index}] to ${action.secret === undefined ? JSON.stringify(action.value) : `[secret ${action.secret}]`}.` : `Did ${action.op}.`, text: linux(name, greeting) };
            },
            wait: async () => {},
        },
    };
}

const choose = (operation: string, extra: Answers = {}, achieved = 0): Answers => ({ operation: { choice: operation }, goal_achieved: { noul: achieved }, ...extra });

test("a run fills a field with a supplied value, clicks, and ends done when the goal shows; its report is fenced as a window's (PP-180)", async () => {
    const demo = demoWindow({ staleOnce: true });
    const decider = scripted([
        () => choose("SET_VALUE", { set_value_target: { choice: "2" }, value_for_field: { choice: "name" } }),
        () => choose("SET_VALUE", { set_value_target: { choice: "2" }, value_for_field: { choice: "name" }, prev_ok: { noul: 1 } }),
        () => choose("CLICK", { click_target: { choice: "4" }, prev_ok: { noul: 1 } }),
        (state) => choose("DONE", { prev_ok: { noul: 1 } }, state.page.text.includes("Hello Ada") ? 0.95 : 0),
    ]);
    const result = await runOnComputer(demo.window, decider, { goal: "Greet Ada", values: { name: "Ada" }, maxSteps: 10, timeMs: 60_000, progress: () => {} });

    assert.equal(result.status, "done");
    // The first set_value met a window that changed: read again, decided again, then done.
    assert.deepEqual(demo.acted, [{ op: "set_value", index: 2, value: "Ada" }, { op: "click", index: 4 }]);
    assert.equal(result.decisions, 4);
    assert.deepEqual(
        result.steps.map((each) => each.did),
        ['Set [2] to "Ada"', "Did click"],
    );
    assert.match(result.window, /label Hello Ada/);
    // The run model was offered the window's operations, keys among them, and the supplied value by name.
    const first = JSON.parse(decider.seen[0]!) as { state: DecisionState; questions: Record<string, Question> };

    assert.deepEqual(Object.keys(first.questions.operation!.criteria), ["CLICK", "SET_VALUE", "PRESS_ENTER", "PRESS_TAB", "PRESS_ESCAPE", "SCROLL_DOWN", "SCROLL_UP", "WAIT", "DONE", "BLOCKED"]);
    assert.equal(first.state.page.title, "Pi OCU Demo");

    const text = report(result, decider.label, result.window, fencedScreen, "The window now:");

    assert.match(text, /^Done in 2 steps\. [\d.]+ s, 4 decisions by a script, \$0\.00400\./);
    assert.match(text, /The window now:\n[^]*Hello Ada/);
    assert.equal(text.includes(fencedScreen("x").split("x")[0]!.trim().split("\n")[0]!), true, "fenced as a window's");
});

test("a secret goes into the field by name: the run model never gets its value, even when the window shows it (PP-180)", async () => {
    let shown = "";
    const acted: ComputerRunAction[] = [];
    const decider = scripted([
        () => choose("SET_VALUE", { set_value_target: { choice: "3" }, value_for_field: { choice: "password" } }),
        () => choose("PRESS_ENTER", { prev_ok: { noul: 1 } }),
        () => choose("DONE", { prev_ok: { noul: 1 } }, 0.9),
    ]);
    const result = await runOnComputer(
        {
            read: async () => linux(shown),
            act: async (action) => {
                acted.push(action);

                if (action.op === "set_value") {
                    // A window that echoes it in a plain field.
                    shown = action.value;
                }

                return { did: `Did ${action.op}.`, text: linux(shown) };
            },
            wait: async () => {},
        },
        decider,
        { goal: "Sign in", values: { password: "hunter2-very-secret" }, secrets: { password: "hunter2-very-secret" }, maxSteps: 10, timeMs: 60_000, progress: () => {} },
    );

    assert.equal(result.status, "done");
    assert.deepEqual(acted, [{ op: "set_value", index: 3, value: "hunter2-very-secret", secret: "password" }, { op: "press_key", key: "Return" }]);
    assert.equal(decider.seen.some((each) => each.includes("hunter2")), false, "never sent to the run model");
    assert.match(decider.seen[0]!, /password: a secret \(its value is never shown\)/);
    assert.match(decider.seen[1]!, /\[secret password\]/);
});

test("a run stops on a missing value, on three steps that change nothing, on an unverified done; it waits and scrolls (PP-180)", async () => {
    const run = (decider: Decider, values: Record<string, string> = {}) => runOnComputer(demoWindow().window, decider, { goal: "g", values, maxSteps: 10, timeMs: 60_000, progress: () => {} });

    const missing = await run(scripted([() => choose("SET_VALUE", { set_value_target: { choice: "2" }, value_for_field: { choice: "none" } })]), { other: "x" });

    assert.equal(missing.reason, "needs_value");
    assert.match(missing.detail!, /\[2\] text needs a value/);

    const scrolling = demoWindow();
    const stuck = await runOnComputer(scrolling.window, scripted([() => choose("SCROLL_DOWN")]), { goal: "g", values: {}, maxSteps: 10, timeMs: 60_000, progress: () => {} });

    assert.equal(stuck.reason, "stuck_loop");
    assert.deepEqual(scrolling.acted[0], { op: "scroll", index: 6, direction: "down" });

    const unverified = await run(scripted([() => choose("WAIT"), () => choose("DONE", {}, 0.2)]));

    assert.equal(unverified.reason, "unverified_done");
    assert.deepEqual(unverified.steps.map((each) => each.did), ["waited"]);

    const budget = await run(scripted([() => choose("PRESS_TAB")]));

    assert.equal(budget.reason, "stuck_loop");
});

test("computer_run is a control session's tool, blocked in plan mode, and its secrets ask the owner as browser_run's do (PP-180)", () => {
    assert.ok((COMPUTER_TOOLS as readonly string[]).includes("computer_run"));
    assert.ok(BUILT_IN_TOOLS.has("computer_run"));
    assert.notEqual(blockedInPlanMode("computer_run", { goal: "g" }), undefined);
    assert.deepEqual(browserSecretNames("computer_run", { goal: "Sign in to the app", values: { user: "ada", password: { secret: "APP_PW" } } }), {
        names: ["APP_PW"],
        subject: 'Computer run "Sign in to the app" types [secret APP_PW]',
    });
});

/**
 * computer_run against a stand-in host (PP-451): the run model `setting`, OpenRouter signed in or not, one control
 * session on a Linux window. The session's model answers DONE; Jev's route (fetch) is recorded and refuses.
 */
async function computerRun(setting: string, openRouter: boolean, model?: "jev" | "session") {
    const asked: string[] = [];
    const jev: string[] = [];
    const charged: string[] = [];
    const session = { machine: "m1", machineName: "box", conversationId: 7, session: 7, approvedBy: "Tuan", apps: [], reason: "test", startedAt: 0, until: Date.now() + 600_000 };
    const host = {
        computer: { unavailable: () => undefined, sessionOfConversation: () => session, screen: async () => ({ text: linux("Ada", "Hello Ada") }) },
        requesterOf: () => "u1",
        person: () => ({ role: "owner" }),
        browserRunModel: () => setting,
        apiKey: async (provider: string) => (openRouter && provider === "openrouter" ? "sk-or-test" : undefined),
        askSessionModel: async (_id: unknown, prompt: string) => {
            asked.push(prompt);

            return '{"operation": {"choice": "DONE"}, "goal_achieved": {"noul": 0.95}}';
        },
        chargeSession: async (_id: unknown, key: string) => void charged.push(key),
        secrets: { value: () => undefined, used: () => {} },
    };
    const tool = (createComputer(host as never) as unknown as { tools: { name: string; execute(args: unknown, api: unknown, context: unknown): Promise<{ output: { text: string }[]; isError?: boolean }> }[] }).tools.find(
        (each) => each.name === "computer_run",
    )!;
    const fetching = globalThis.fetch;

    globalThis.fetch = (async (url: string, init: { body: string }) => {
        jev.push(`${url} ${(JSON.parse(init.body) as { model: string }).model}`);

        return new Response(JSON.stringify({ error: { message: "stand-in" } }), { status: 503 });
    }) as typeof fetch;

    try {
        const done = await tool.execute({ goal: "Greet Ada", ...(model === undefined ? {} : { model }) }, { conversationId: 7, taskId: "t1", callId: "c1" }, {});

        return { asked, jev, charged, text: done.output[0]!.text, isError: done.isError === true };
    } finally {
        globalThis.fetch = fetching;
    }
}

test("computer_run takes Pi's model for one call over the setting; left out, the setting decides; jev without OpenRouter says what to do (PP-451)", async () => {
    const jev = await computerRun("session", true, "jev");

    assert.deepEqual(jev.jev, ["https://openrouter.ai/api/alpha/decisions typesafe/jev-1.14"], "Jev decided, the default Jev while the setting is session");
    assert.deepEqual(jev.asked, []);
    assert.match(jev.text, /decisions? by Jev \(typesafe\/jev-1\.14\) as Pi asked\./);

    const session = await computerRun("typesafe/jev-1.13", false, "session");

    assert.equal(session.asked.length, 1, "the session's model decided, OpenRouter not needed");
    assert.deepEqual(session.jev, []);
    assert.match(session.text, /^Done in 0 steps\. [\d.]+ s, 1 decision by this session's model as Pi asked\./);

    const setting = await computerRun("typesafe/jev-1.13", true);

    assert.deepEqual(setting.jev, ["https://openrouter.ai/api/alpha/decisions typesafe/jev-1.13"]);
    assert.match(setting.text, /by Jev \(typesafe\/jev-1\.13\) as the setting says\./);

    const refused = await computerRun("session", false, "jev");

    assert.equal(refused.isError, true);
    assert.equal(refused.text, 'model "jev" runs typesafe/jev-1.14 through OpenRouter, which is not signed in: sign in to OpenRouter in Settings › Providers, or call again with model "session".');
    assert.deepEqual([refused.asked, refused.jev], [[], []], "no quiet switch to the session's model");
});
