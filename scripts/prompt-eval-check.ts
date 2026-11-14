/**
 * How prompt-eval (PP-452, `scripts/prompt-eval.ts`) judges a model's reply to a scenario, without the network: which
 * calls it answers with a stand-in result (lead-ins: reading a skill, the wiki, the secrets' list), which call it checks,
 * and whether that call (or the plain answer) is what the scenario expects. A scenario that expects one of those calls
 * (the wiki scenarios, PP-463: did Pi consult the wiki before acting?) checks it instead of standing it in.
 */

/** One tool call of a reply. */
export type Call = { name: string; arguments: Record<string, unknown> };

/** A reply as the runner reads it: its tool calls in order, and its text. */
export type Reply = { calls: readonly Call[]; text: string };

/** Whether the request offered a tool's parameter (a newer prompt may add one, as PP-451 adds browser_run's model). */
export type Offered = (tool: string, parameter: string) => boolean;

/** A check on one argument's value, with the words the report gives when it fails. */
export type Matcher = { says: string; test: (value: unknown, offered: Offered) => boolean };

/** What a scenario expects of the first call that is not a lead-in. */
export type Expect = {
    /** The tool names that pass; `answer` passes a reply with no tool call. */
    tool: readonly string[];
    /** Per accepted tool, checks on its arguments by name. */
    args?: Readonly<Record<string, Readonly<Record<string, Matcher>>>>;
    /** With `answer`: words the reply must say. */
    text?: RegExp;
    /** Words no reply text may say (asking for a key in the chat). */
    notText?: RegExp;
    /** Tools never called, lead-ins included. */
    forbid?: readonly string[];
    /** Calls never made, lead-ins included: per tool, an argument's pattern (bash running `gh auth token`). */
    forbidArgs?: Readonly<Record<string, Readonly<Record<string, RegExp>>>>;
    /** Calls made at most so many times, lead-ins included: one look at a subagent's status is a check, two are polling (PP-512). */
    most?: Readonly<Record<string, number>>;
    /** A file the model reads before the call checked (a skill's SKILL.md: did it open the skill?), by its path. */
    reads?: RegExp;
};

/**
 * A scenario: a person's first message in a new session on the phone or on a machine, or on the phone with a skill of
 * the owner's library pinned to it (`pinned`, prompt-eval-capture.ts's `PINNED_SKILL`), and what it expects.
 */
export type Scenario = {
    id: string;
    variant: "phone" | "machine" | "pinned";
    message: string;
    expect: Expect;
    /** One of the few run on an expensive model. */
    core?: boolean;
    /** Stand-in results for this scenario's lead-ins, by tool name, over the defaults. */
    stubs?: Stubs;
    /** Rounds of lead-ins answered (default 3): more for a request whose first move is to gather context ("what we did"). */
    rounds?: number;
};

/** A lead-in's stand-in result: a text, or one made from the call's arguments (a `.css` read gets CSS). */
export type Stub = string | ((args: Record<string, unknown>) => string);
export type Stubs = Readonly<Record<string, Stub>>;

/** What the runner saw of one run: the lead-ins answered, then the call checked (none: a plain answer). */
export type Trace = { leadIns: readonly Call[]; call: Call | undefined; text: string };

export type Outcome = { pass: boolean; path: string; why: string };

/** Lead-ins answered when a scenario names no stand-in of its own: read-only looks the prompt asks for first. */
export const DEFAULT_STUBS: Stubs = {
    wiki_query: "No pages match.",
    wiki_read: "No such page.",
    secrets_list:
        "DEEPSEEK_API_KEY: DeepSeek API key (no approval needed)\nOPENAI_API_KEY: OpenAI API key (no approval needed)\nNPM_TOKEN: npm publish token (no approval needed)",
};

/**
 * The stand-ins of a scenario's runs: the defaults, less those of a tool the scenario expects (there that call is the one
 * to check, PP-463), then the scenario's own, which it names on purpose and keeps.
 */
export function stubsFor(scenario: Pick<Scenario, "expect" | "stubs">): Stubs {
    const defaults = Object.fromEntries(Object.entries(DEFAULT_STUBS).filter(([tool]) => !scenario.expect.tool.includes(tool)));

    return { ...defaults, ...scenario.stubs };
}

/**
 * The stand-in result of a lead-in call, or undefined when the call is the one to check. A `read` is a lead-in for a
 * file the capture kept (the skills the prompt lists), answered with that file; another file only when the scenario
 * stands one in (`stubs.read`: the page a person names, as it would be there), else it is a real first step.
 */
export function leadIn(call: Call, files: Readonly<Record<string, string>>, stubs: Stubs): string | undefined {
    const path = call.arguments.path;

    if (call.name === "read" && typeof path === "string" && files[path] !== undefined) {
        return files[path];
    }

    const stub = stubs[call.name];

    return typeof stub === "function" ? stub(call.arguments) : stub;
}

/**
 * The runner's next move after a reply: answer its lead-ins and ask again (`more`), or stop at its first call that is
 * not one (lead-ins in the same reply before it are kept), or at a reply with no call.
 */
export function nextStep(
    reply: Reply,
    files: Readonly<Record<string, string>>,
    stubs: Stubs,
): { more: true; results: string[] } | { more: false; leadIns: Call[]; call: Call | undefined } {
    const leadIns: Call[] = [];
    const results: string[] = [];

    for (const call of reply.calls) {
        const result = leadIn(call, files, stubs);

        if (result === undefined) {
            return { more: false, leadIns, call };
        }

        leadIns.push(call);
        results.push(result);
    }

    return reply.calls.length === 0 ? { more: false, leadIns, call: undefined } : { more: true, results };
}

const show = (value: unknown) => {
    const text = JSON.stringify(value) ?? "undefined";

    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

/** Judge one run against its scenario's expectation. */
export function judge(expect: Expect, trace: Trace, offered: Offered): Outcome {
    const names = [...trace.leadIns.map((call) => call.name), trace.call?.name ?? "answer"];
    const path = names.join(" → ");
    const fail = (why: string): Outcome => ({ pass: false, path, why });
    const forbidden = [...trace.leadIns, ...(trace.call === undefined ? [] : [trace.call])].find(
        (call) =>
            (expect.forbid ?? []).includes(call.name) ||
            Object.entries(expect.forbidArgs?.[call.name] ?? {}).some(([name, pattern]) => pattern.test(typeof call.arguments[name] === "string" ? (call.arguments[name] as string) : JSON.stringify(call.arguments[name] ?? ""))),
    );

    if (forbidden !== undefined) {
        return fail(`called ${forbidden.name} ${show(forbidden.arguments)}, which it must not`);
    }

    const made = [...trace.leadIns, ...(trace.call === undefined ? [] : [trace.call])];
    const over = Object.entries(expect.most ?? {}).find(([tool, most]) => made.filter((call) => call.name === tool).length > most);

    if (over !== undefined) {
        return fail(`called ${over[0]} ${made.filter((call) => call.name === over[0]).length} times, at most ${over[1]}`);
    }

    if (expect.reads !== undefined && !trace.leadIns.some((call) => call.name === "read" && expect.reads!.test(String(call.arguments.path ?? "")))) {
        return fail(`never read a file matching ${expect.reads} first`);
    }

    if (expect.notText !== undefined && expect.notText.test(trace.text)) {
        return fail(`said ${show(expect.notText.exec(trace.text)?.[0])}`);
    }

    if (trace.call === undefined) {
        if (!expect.tool.includes("answer")) {
            return fail(`answered without a tool: ${show(trace.text)}`);
        }

        return expect.text === undefined || expect.text.test(trace.text) ? { pass: true, path, why: "" } : fail(`the answer does not match ${expect.text}: ${show(trace.text)}`);
    }

    if (!expect.tool.includes(trace.call.name)) {
        return fail(`called ${trace.call.name} ${show(trace.call.arguments)}, expected ${expect.tool.join(" or ")}`);
    }

    for (const [name, matcher] of Object.entries(expect.args?.[trace.call.name] ?? {})) {
        const value = trace.call.arguments[name];

        if (!matcher.test(value, offered)) {
            return fail(`${trace.call.name}.${name} is ${show(value)}, expected ${matcher.says}`);
        }
    }

    return { pass: true, path, why: "" };
}

/** Argument checks for scenarios. */
export const absent: Matcher = { says: "left out", test: (value) => value === undefined };

export const equals = (expected: unknown): Matcher => ({ says: show(expected), test: (value) => JSON.stringify(value) === JSON.stringify(expected) });

/** A string (or, for another value, its JSON) that matches. */
export const matches = (pattern: RegExp): Matcher => ({
    says: `to match ${pattern}`,
    test: (value) => value !== undefined && pattern.test(typeof value === "string" ? value : JSON.stringify(value)),
});

/** An array (or its JSON text) holding each of these values. */
export const holds = (...items: readonly unknown[]): Matcher => ({
    says: `to hold ${items.map((item) => show(item)).join(", ")}`,
    test: (value) => {
        const list = typeof value === "string" ? (JSON.parse(value.startsWith("[") ? value : "[]") as unknown[]) : value;

        return Array.isArray(list) && items.every((item) => list.some((each) => JSON.stringify(each) === JSON.stringify(item)));
    },
});

export const anyOf = (...matchers: readonly Matcher[]): Matcher => ({
    says: matchers.map((matcher) => matcher.says).join(", or "),
    test: (value, offered) => matchers.some((matcher) => matcher.test(value, offered)),
});

/** screenshot's widths: left out (390, 1280 and 1920 by default) or all three named. */
export const defaultWidths = anyOf(absent, holds(390, 1280, 1920));

/** A steps list (or its JSON text) with a step of this kind whose value matches: `{ click: "#menu" }`. */
export const step = (kind: string, pattern: RegExp): Matcher => ({
    says: `a ${kind} step matching ${pattern}`,
    test: (value) => {
        const list = typeof value === "string" ? (JSON.parse(value.startsWith("[") ? value : "[]") as unknown[]) : value;

        return Array.isArray(list) && list.some((each) => typeof each === "object" && each !== null && pattern.test(String((each as Record<string, unknown>)[kind] ?? "")));
    },
});

/** Checked only when the request offers the tool's parameter; passes otherwise. */
export const ifOffered = (tool: string, parameter: string, matcher: Matcher): Matcher => ({
    says: `${matcher.says} (as ${tool} offers ${parameter})`,
    test: (value, offered) => !offered(tool, parameter) || matcher.test(value, offered),
});

/** One scenario's runs in one tree. */
export type Tally = { passed: number; runs: number; fails: Outcome[] };

/** Scenarios whose passes dropped from `before` to `after` (the AGENTS.md rule: none may). */
export function dropped(before: Readonly<Record<string, Tally>>, after: Readonly<Record<string, Tally>>): string[] {
    return Object.keys(after).filter((id) => before[id] !== undefined && after[id]!.passed / after[id]!.runs < before[id]!.passed / before[id]!.runs);
}
