// prompt-eval's judging (PP-452), without the network: which calls are lead-ins, which call is checked, and whether it
// passes its scenario. The runner itself (scripts/prompt-eval.ts) calls a real model and runs by hand on the devbox.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    type Call,
    DEFAULT_STUBS,
    defaultWidths,
    dropped,
    equals,
    ifOffered,
    judge,
    leadIn,
    matches,
    nextStep,
    type Offered,
    step,
} from "../scripts/prompt-eval-check.ts";
import { SCENARIOS } from "../scripts/prompt-eval-scenarios.ts";

const none: Offered = () => false;
const call = (name: string, args: Record<string, unknown> = {}): Call => ({ name, arguments: args });
const files = { "/app/skills/ui-verify/SKILL.md": "---\nname: ui-verify\n---" };

test("a skill's file, the wiki and the secrets' list are lead-ins; another read is the call to check", () => {
    const skill = nextStep({ calls: [call("read", { path: "/app/skills/ui-verify/SKILL.md" }), call("wiki_query", { query: "ui" })], text: "" }, files, DEFAULT_STUBS);

    assert.deepEqual(skill, { more: true, results: ["---\nname: ui-verify\n---", "No pages match."] });

    const other = nextStep({ calls: [call("secrets_list"), call("read", { path: "/home/site/index.html" })], text: "" }, files, DEFAULT_STUBS);

    assert.equal(other.more, false);
    assert.ok(!other.more);
    assert.deepEqual(other.leadIns.map((each) => each.name), ["secrets_list"]);
    assert.equal(other.call?.name, "read");

    // A scenario that stands in the page a person names: reading it is a lead-in too.
    const page = nextStep({ calls: [call("read", { path: "/home/site/index.html" }), call("screenshot", { path: "/home/site/index.html" })], text: "" }, files, { ...DEFAULT_STUBS, read: "<html></html>" });

    assert.ok(!page.more);
    assert.deepEqual(page.leadIns.map((each) => each.name), ["read"]);
    assert.equal(page.call?.name, "screenshot");

    // A stand-in made from the call: a stylesheet read gets CSS.
    const css = (args: Record<string, unknown>) => (String(args.path).endsWith(".css") ? ".card{}" : "<html></html>");

    assert.equal(leadIn(call("read", { path: "/home/site/style.css" }), files, { read: css }), ".card{}");
    assert.equal(leadIn(call("read", { path: "/app/skills/ui-verify/SKILL.md" }), files, { read: css }), "---\nname: ui-verify\n---", "a skill's file stays itself");
    assert.equal(leadIn(call("bash", { command: "ls" }), files, DEFAULT_STUBS), undefined, "bash is checked unless a scenario stands it in");

    const answer = nextStep({ calls: [], text: "Turn on plan mode first." }, files, DEFAULT_STUBS);

    assert.deepEqual(answer, { more: false, leadIns: [], call: undefined });
});

test("screenshot passes with its widths left out or all three, and fails with fewer", () => {
    const expect = { tool: ["screenshot"], args: { screenshot: { artifact: matches(/pricing/), widths: defaultWidths } } };
    const run = (args: Record<string, unknown>) => judge(expect, { leadIns: [], call: call("screenshot", args), text: "" }, none);

    assert.equal(run({ artifact: "pricing-table" }).pass, true);
    assert.equal(run({ artifact: "pricing-table", widths: [1920, 390, 1280] }).pass, true);
    assert.equal(run({ artifact: "pricing-table", widths: "[390,1280,1920]" }).pass, true, "a model that sends the array as JSON text");

    const narrow = run({ artifact: "pricing-table", widths: [390, 1280] });

    assert.equal(narrow.pass, false);
    assert.match(narrow.why, /screenshot\.widths is \[390,1280\]/);
    assert.equal(run({ url: "https://example.com" }).pass, false, "the artifact is missing");
});

test("a wrong tool, a forbidden tool among the lead-ins, or an answer where a call was expected fails, saying why", () => {
    const expect = { tool: ["secret_save", "tool_search"], args: { tool_search: { query: matches(/secret/i) } }, forbid: ["bash"] };

    assert.equal(judge(expect, { leadIns: [], call: call("tool_search", { query: "secret save" }), text: "" }, none).pass, true);
    assert.equal(judge(expect, { leadIns: [], call: call("bash", { command: "gh auth token" }), text: "" }, none).why, 'called bash {"command":"gh auth token"}, which it must not');
    assert.match(judge(expect, { leadIns: [call("bash")], call: call("secret_save"), text: "" }, none).why, /called bash \{\}, which it must not/);
    assert.match(judge(expect, { leadIns: [], call: call("tool_search", { query: "github" }), text: "" }, none).why, /tool_search\.query/);

    // A call never made, by its arguments: a look at gh is fine, running what makes the value is not.
    const careful = { ...expect, forbid: [], forbidArgs: { bash: { command: /gh auth token/ } } };

    assert.equal(judge(careful, { leadIns: [call("bash", { command: "gh auth status" })], call: call("tool_search", { query: "secret_save" }), text: "" }, none).pass, true);
    assert.match(judge(careful, { leadIns: [call("bash", { command: "gh auth token > /tmp/t" })], call: call("tool_search", { query: "secret_save" }), text: "" }, none).why, /called bash .*gh auth token.*which it must not/);

    const answered = judge(expect, { leadIns: [call("secrets_list")], call: undefined, text: "Run it yourself." }, none);

    assert.equal(answered.pass, false);
    assert.equal(answered.path, "secrets_list → answer");
    assert.match(answered.why, /answered without a tool/);
});

test("an answer passes when its words match, and words it must not say fail it", () => {
    const plan = { tool: ["answer"], text: /plan mode/i, forbid: ["edit"] };

    assert.equal(judge(plan, { leadIns: [], call: undefined, text: "This is big: turn on plan mode first." }, none).pass, true);
    assert.equal(judge(plan, { leadIns: [], call: undefined, text: "Sure, starting now." }, none).pass, false);
    assert.equal(judge(plan, { leadIns: [], call: call("edit"), text: "" }, none).pass, false);

    const ask = { tool: ["secret_request"], notText: /paste/i };

    assert.match(judge(ask, { leadIns: [], call: call("secret_request", { name: "GROQ_API_KEY" }), text: "Please paste your key." }, none).why, /said "paste"/);
});

test("steps and a parameter only a newer prompt offers", () => {
    const menu = step("click", /#menu-btn/);

    assert.equal(menu.test([{ click: "#menu-btn" }, { wait: 300 }], none), true);
    assert.equal(menu.test([{ press: "Escape" }], none), false);
    assert.equal(menu.test(undefined, none), false);

    const jev = ifOffered("browser_run", "model", equals("jev"));
    const offered: Offered = (tool, parameter) => tool === "browser_run" && parameter === "model";

    assert.equal(jev.test(undefined, none), true, "not offered: not checked");
    assert.equal(jev.test(undefined, offered), false);
    assert.equal(jev.test("jev", offered), true);
});

test("a scenario that passes less often after a change is a drop", () => {
    const tally = (passed: number) => ({ passed, runs: 3, fails: [] });

    assert.deepEqual(dropped({ a: tally(3), b: tally(1), c: tally(2) }, { a: tally(2), b: tally(3), c: tally(2) }), ["a"]);
});

test("at least 30 scenarios, unique, covering what recent prompt changes touched", () => {
    assert.ok(SCENARIOS.length >= 30, `${SCENARIOS.length} scenarios`);
    assert.equal(new Set(SCENARIOS.map((each) => each.id)).size, SCENARIOS.length);
    assert.ok(SCENARIOS.some((each) => each.variant === "machine"));

    const tools = new Set(SCENARIOS.flatMap((each) => each.expect.tool));

    for (const tool of ["screenshot", "secret_save", "bash", "secret_request", "browser_run", "codemode", "interview", "answer"]) {
        assert.ok(tools.has(tool), tool);
    }

    assert.ok(SCENARIOS.filter((each) => each.core === true).length >= 10);
});
