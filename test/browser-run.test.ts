// browser_run's loop (src/server/browser/run.ts): the questions each step asks, answers checked against what was
// offered, and how a run ends: done (only with the goal visibly met), or stopped with a reason Pi can act on.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observed } from "../src/server/browser/page.ts";
import { actionSpace, buildQuestions, type Decider, type Question, readAnswers, report, runGoal, type RunPage } from "../src/server/browser/run.ts";

const rect = { x: 0, y: 0, w: 10, h: 10 };

/** A page: a search field, a sort list, a Go button; `results` once searched. */
function page(state: { query: string; searched: boolean; scrollY?: number }): Observed {
    return {
        url: "https://shop.test/",
        title: state.searched ? "Results" : "Shop",
        w: 412,
        h: 860,
        text: state.searched ? `Results for ${state.query}` : "Welcome",
        scroll: { y: state.scrollY ?? 0, height: 3000 },
        actions: [
            { node: 1, role: "searchbox", label: "Search", rect, kind: "fill", value: state.query },
            { node: 1, role: "searchbox", label: "Search", rect, kind: "click", value: state.query },
            { node: 2, role: "combobox", label: "Sort", rect, kind: "select", value: "new", option: "Newest", current_value: "Popular" },
            { node: 3, role: "button", label: "Go", rect, kind: "click", value: "" },
        ],
        marker: [state.query, state.searched, state.scrollY ?? 0],
        page_key: [],
        guards: {},
        omitted: 0,
    };
}

/** A shop the loop drives: typing sets the query, Go searches; `frozen` changes nothing whatever is done. */
function shop(frozen = false) {
    const state = { query: "", searched: false, scrollY: 0 };
    const done: string[] = [];
    const runPage: RunPage = {
        observe: async () => page(state),
        click: async (_observed, node) => {
            done.push(`click ${node}`);

            if (!frozen && node === 3) {
                state.searched = true;
            }
        },
        type: async (_observed, node, text) => {
            done.push(`type ${node} ${text}`);

            if (!frozen) {
                state.query = text;
            }
        },
        select: async (_observed, node, option) => void done.push(`select ${node} ${option}`),
        scroll: async (direction) => {
            done.push(`scroll ${direction}`);

            if (!frozen) {
                state.scrollY += direction === "down" ? 500 : -500;
            }
        },
        wait: async () => void done.push("wait"),
        stale: () => false,
    };

    return { runPage, done };
}

/** A decider that answers a script, one step at a time: [operation, target, value?, goalAchieved]. */
function scripted(steps: [string, string?, string?, number?][]): Decider & { asked: Record<string, Question>[] } {
    const asked: Record<string, Question>[] = [];

    return {
        label: "a script",
        asked,
        async decide(_state, questions) {
            asked.push(questions);

            const [operation, target, value, achieved] = steps[asked.length - 1] ?? ["BLOCKED"];
            const answers: Record<string, unknown> = { operation: { choice: operation }, goal_achieved: { noul: achieved ?? 0 } };

            for (const name of Object.keys(questions)) {
                if (name.endsWith("_target")) {
                    answers[name] = { choice: name === `${operation.toLowerCase()}_target` ? target : Object.keys((questions[name] as { criteria: object }).criteria)[0] };
                }
            }

            if (questions.value_for_field) {
                answers.value_for_field = { choice: value ?? "none" };
            }

            if (questions.prev_ok) {
                answers.prev_ok = { noul: 0.9 };
            }

            return { answers: readAnswers(questions, answers), cost: 0.0002, tokens: { input: 100, output: 10 } };
        },
    };
}

const options = (values: Record<string, string> = {}) => ({ goal: "Search the shop for lamps", values, maxSteps: 10, timeMs: 60_000, progress: () => {} });

test("each step asks one set of questions: the operations the page offers, a target for each, which value, and whether the goal is met", () => {
    const space = actionSpace(page({ query: "", searched: false }));
    const questions = buildQuestions(space, "Search for lamps", { query: "lamp" }, true);

    assert.deepEqual(Object.keys((questions.operation as { criteria: object }).criteria), ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
    assert.deepEqual(Object.keys((questions.click_target as { criteria: object }).criteria), ["1", "3"]);
    assert.deepEqual(Object.keys((questions.type_text_target as { criteria: object }).criteria), ["1"]);
    assert.deepEqual(Object.keys((questions.select_target as { criteria: object }).criteria), ["2:1"]);
    assert.deepEqual(Object.keys((questions.value_for_field as { criteria: object }).criteria), ["query", "none"]);
    assert.ok(questions.prev_ok && questions.goal_achieved);
    assert.equal(buildQuestions(space, "x", {}, false).value_for_field, undefined, "no values: no value question");
    assert.equal(buildQuestions(space, "x", {}, false).prev_ok, undefined, "the first step has no previous step");
});

test("an answer that was not offered refuses the whole reply", () => {
    const questions = buildQuestions(actionSpace(page({ query: "", searched: false })), "x", {}, false);

    assert.throws(() => readAnswers(questions, { operation: { choice: "HACK" }, click_target: { choice: "1" }, type_text_target: { choice: "1" }, select_target: { choice: "2:1" }, goal_achieved: { noul: 0 } }), /not offered/);
    assert.throws(() => readAnswers(questions, { operation: { choice: "CLICK" } }), /did not answer/);
});

test("a run types only a supplied value, clicks, and is done when the goal is visibly met", async () => {
    const { runPage, done } = shop();
    const decider = scripted([["TYPE_TEXT", "1", "query"], ["CLICK", "3"], ["DONE", undefined, undefined, 0.95]]);
    const result = await runGoal(runPage, decider, options({ query: "lamp" }));

    assert.equal(result.status, "done");
    assert.deepEqual(done, ["type 1 lamp", "click 3"]);
    assert.deepEqual(result.steps.map((step) => step.did), ["typed query into [1] Search", "clicked [3] Go"]);
    assert.equal(result.decisions, 3);
    assert.ok(Math.abs(result.cost - 0.0006) < 1e-12);
    assert.match(report(result, "a script", "the page"), /^Done in 2 steps\. .*3 decisions by a script, \$0\.00060\.\n1\. typed query into \[1\] Search\n2\. clicked \[3\] Go/);
});

test("a run stops with a reason: a field needing a value nobody supplied, done without visible proof, blocked", async () => {
    const needs = await runGoal(shop().runPage, scripted([["TYPE_TEXT", "1"]]), options({}));

    assert.equal(needs.status, "stopped");
    assert.equal(needs.reason, "needs_value");
    assert.match(needs.detail ?? "", /\[1\] Search needs a value/);

    const unverified = await runGoal(shop().runPage, scripted([["DONE", undefined, undefined, 0.2]]), options());

    assert.equal(unverified.reason, "unverified_done");

    const blocked = await runGoal(shop().runPage, scripted([["BLOCKED"]]), options());

    assert.equal(blocked.reason, "blocked");
});

test("a run that changes nothing three times stops as stuck; one past its steps stops on its budget; a refused decision says why", async () => {
    const stuck = await runGoal(shop(true).runPage, scripted([["CLICK", "3"], ["CLICK", "3"], ["CLICK", "3"], ["CLICK", "3"]]), options());

    assert.equal(stuck.reason, "stuck_loop");
    assert.equal(stuck.steps.length, 3);

    const budget = await runGoal(shop().runPage, scripted(Array.from({ length: 20 }, () => ["SCROLL_DOWN"] as [string])), { ...options(), maxSteps: 4 });

    assert.equal(budget.reason, "budget");
    assert.equal(budget.steps.length, 4);

    const refusing: Decider = {
        label: "a refusing model",
        decide: async () => {
            throw new Error("OpenRouter refused the run model's decision (HTTP 404): No allowed providers are available");
        },
    };
    const refused = await runGoal(shop().runPage, refusing, options());

    assert.equal(refused.reason, "decision_error");
    assert.match(refused.detail ?? "", /No allowed providers/);
});
