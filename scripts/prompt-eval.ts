/**
 * Does Pi still pick the right tools after a prompt change (PP-452)? test/prompt-budget.test.ts holds the prompt's size;
 * this checks its behaviour. It builds the real first request of a new session (sections and tool schemas, a session on
 * the phone and one on a machine: `prompt-eval-capture.ts`), puts each scenario's message in it
 * (`prompt-eval-scenarios.ts`), sends it to a real Anthropic model on a subscription account, and checks the first tool
 * call (or the answer) the model gives (`prompt-eval-check.ts`). No tool runs: read-only lead-ins the prompt asks for
 * first (a skill's file, the wiki, the secrets' list) get a stand-in result and the model is asked again, at most 3
 * times (a scenario's `rounds`); the next call is the one checked. The wiki scenarios (PP-463) check the wiki call
 * that is a lead-in elsewhere: did Pi consult the wiki before acting?
 *
 *   EVAL_ANTHROPIC_TOKEN=… node scripts/prompt-eval.ts [--compare <git ref>] [--model <anthropic id>] [--runs 3]
 *       [--only core | id,id] [--jobs 4] [--account anthropic~han-acc] [--dry-run] [--out report.md]
 *
 * Evals never run on OpenRouter (the owner's rule, PP-476: it is too expensive). EVAL_ANTHROPIC_TOKEN is a short-lived
 * OAuth access token of a Claude subscription (`sk-ant-oat…`), which the owner approves for one run;
 * `scripts/eval-on-devbox.sh` brings it to the devbox and takes it away again. It is never refreshed: once it expires
 * the run stops and says so. `--account` names whose token it is, for the report: it is that account's quota.
 * `--dry-run` prints the requests a run would make and exits, without the token: the owner is asked with that number
 * before every run.
 *
 * `--compare <ref>` builds the request from that ref too (a checkout of it in a temporary worktree, with this tree's
 * node_modules and capture script) and reports both, before → after; a scenario that passes less often after makes it
 * exit 1; runs the provider kept failing (left out of the passes) exit 2. Real model, real quota: not in CI. Run it on
 * the devbox (the machine variant needs /usr/sbin/sshd).
 */
import { judge, type Offered, type Outcome, nextStep, dropped, type Scenario, stubsFor, type Tally, type Trace, type Call } from "./prompt-eval-check.ts";
import { SCENARIOS } from "./prompt-eval-scenarios.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AssistantMessage, Context, Credential, CredentialInfo, CredentialStore, Message } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installClaudeCodeBilling } from "../src/server/claude-billing.ts";
import { PhoneSettingsFile } from "../src/server/phone-settings.ts";

/** The owner's Opus in Pi's catalog for Anthropic; `--model` takes other Anthropic models. */
const DEFAULT_MODEL = "claude-opus-5-5";
/** Whose subscription the token is: printed in the report, so the owner knows whose quota the run used. */
const DEFAULT_ACCOUNT = "anthropic~han-acc";
/** Rounds of lead-ins answered before the run stops without a call to check. */
const MAX_LEAD_INS = 3;
/** Tries of one request when the provider fails in passing (a 429, a dropped stream). */
const TRIES = 5;
const EXPIRED = "The eval token expired: ask the owner for a new one (EVAL_ANTHROPIC_TOKEN, PP-476).";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Stop before any request, with what to do instead. */
function refuse(message: string): never {
    console.error(`prompt-eval: ${message}`);
    process.exit(1);
}

const { values } = parseArgs({
    options: {
        compare: { type: "string" },
        model: { type: "string", default: DEFAULT_MODEL },
        account: { type: "string", default: DEFAULT_ACCOUNT },
        runs: { type: "string", default: "3" },
        only: { type: "string" },
        jobs: { type: "string", default: "4" },
        "dry-run": { type: "boolean", default: false },
        out: { type: "string" },
    },
});
const NEVER_OPENROUTER = "evals never run on OpenRouter (the owner's rule, PP-476: it is too expensive)";
// `anthropic/claude-opus-5-5` is Anthropic's model written as OpenRouter names it: taken as `claude-opus-5-5`.
const MODEL = values.model.startsWith("anthropic/") ? values.model.slice("anthropic/".length) : values.model;

if (MODEL.toLowerCase().startsWith("openrouter") || MODEL.includes("/")) {
    refuse(`${values.model} is not an Anthropic model, and ${NEVER_OPENROUTER}. Give an Anthropic id such as ${DEFAULT_MODEL}.`);
}

if (!anthropicProvider().getModels().some((each) => each.id === MODEL)) {
    refuse(`Anthropic has no model ${values.model} in Pi's catalog. Give an Anthropic id such as ${DEFAULT_MODEL}.`);
}

if (!/^anthropic(~[a-z0-9-]+)?$/.test(values.account)) {
    refuse(`--account ${values.account} is not a subscription account of Anthropic (like ${DEFAULT_ACCOUNT}), and ${NEVER_OPENROUTER}.`);
}

/** The subscription's token, or a refusal: OpenRouter's key alone, no token, or an API key in its place. */
function subscriptionToken(): string {
    const token = process.env.EVAL_ANTHROPIC_TOKEN ?? "";

    if (token === "" && (process.env.OPENROUTER_API_KEY ?? "") !== "") {
        refuse(`OPENROUTER_API_KEY is set but ${NEVER_OPENROUTER}. Give a subscription token in EVAL_ANTHROPIC_TOKEN (scripts/eval-on-devbox.sh).`);
    }

    if (token === "") {
        refuse(`EVAL_ANTHROPIC_TOKEN is needed: a short-lived OAuth token of ${values.account}'s Claude subscription, which the owner approves for this run (scripts/eval-on-devbox.sh).`);
    }

    if (!token.startsWith("sk-ant-oat")) {
        refuse("EVAL_ANTHROPIC_TOKEN is not a subscription OAuth token (sk-ant-oat…): an API key is billed by the token.");
    }

    return token;
}

// `--dry-run` sends nothing, so it needs no token: the owner approves one only after seeing its count.
const TOKEN = values["dry-run"] ? "" : subscriptionToken();

// Nothing this run starts (the captures, the model runtime) gets another way to a model.
for (const name of ["OPENROUTER_API_KEY", "EVAL_ANTHROPIC_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]) {
    delete process.env[name];
}

const RUNS = Number(values.runs);
const JOBS = Number(values.jobs);

if (!Number.isInteger(RUNS) || RUNS < 1 || !Number.isInteger(JOBS) || JOBS < 1) {
    throw new Error("--runs and --jobs take a whole number from 1");
}

const only = values.only?.split(",");
const scenarios = SCENARIOS.filter((scenario) => only === undefined || (only.includes("core") && scenario.core === true) || only.includes(scenario.id));

if (scenarios.length === 0) {
    throw new Error(`--only ${values.only} names no scenario`);
}

// The requests the run will make, for the owner before every run (`--dry-run`): one a run, and one more for each
// round of lead-ins the model asks for; a provider's passing error is tried again on top.
const TREES = values.compare === undefined ? 1 : 2;
const planned = scenarios.length * RUNS * TREES;
const most = scenarios.reduce((sum, scenario) => sum + ((scenario.rounds ?? MAX_LEAD_INS) + 1) * RUNS * TREES, 0);

console.log(
    `Planned: ${planned} requests (${scenarios.length} scenarios × ${RUNS} runs × ${TREES} tree${TREES === 1 ? "" : "s"}), at most ${most} with lead-ins; ` +
        `a provider's passing error is tried again, at most ${TRIES - 1} times a request. Model ${MODEL} on Anthropic, account ${values.account}.`,
);

if (values["dry-run"]) {
    process.exit(0);
}

type Captured = { message: string; phone: Context; machine: Context; pinned: Context; files: Record<string, string> };
type Tree = { label: string; captured: Captured };

const work = mkdtempSync(join(tmpdir(), "prompt-eval-"));
const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();

/** Run the capture in `tree` (its own app and test helpers), in a home of its own, without the key. */
function capture(tree: string, name: string): Captured {
    const file = join(work, `${name}.json`);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: mkdtempSync(join(tmpdir(), "prompt-eval-home-")) };
    const result = spawnSync(process.execPath, [join(tree, "scripts", "prompt-eval-capture.ts"), file], { cwd: tree, env, stdio: ["ignore", "ignore", "inherit"], timeout: 300_000 });

    if (result.status !== 0) {
        throw new Error(`The capture in ${tree} failed (exit ${result.status ?? result.signal})`);
    }

    return JSON.parse(readFileSync(file, "utf8")) as Captured;
}

/** The request from another ref: a checkout of it beside this tree's node_modules, with this tree's capture script. */
function captureRef(ref: string): Tree {
    const checkout = join(work, "ref");

    git("worktree", "add", "--detach", "--quiet", checkout, ref);

    try {
        symlinkSync(join(ROOT, "node_modules"), join(checkout, "node_modules"));
        copyFileSync(join(ROOT, "scripts", "prompt-eval-capture.ts"), join(checkout, "scripts", "prompt-eval-capture.ts"));

        return { label: `${ref} (${git("rev-parse", "--short", ref)})`, captured: capture(checkout, "before") };
    } finally {
        git("worktree", "remove", "--force", checkout);
    }
}

const changed = git("status", "--porcelain") !== "";
const trees: Tree[] = [
    ...(values.compare === undefined ? [] : [captureRef(values.compare)]),
    { label: `this tree (${git("rev-parse", "--short", "HEAD")}${changed ? " + changes" : ""})`, captured: capture(ROOT, "after") },
];

/**
 * The run's sign-in: the token as Anthropic's OAuth sign-in in a temporary auth.json, read only. Pi refreshes a sign-in
 * five minutes before it expires, which writes here: the token has no refresh token, so that write is the token
 * expiring, and stops the run.
 */
class EvalCredentials implements CredentialStore {
    expired = false;
    readonly #path: string;

    constructor(path: string, access: string) {
        this.#path = path;
        writeFileSync(path, JSON.stringify({ anthropic: { type: "oauth", access, refresh: "", expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
    }

    async read(providerId: string): Promise<Credential | undefined> {
        return (JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, Credential>)[providerId];
    }

    async list(): Promise<readonly CredentialInfo[]> {
        return [{ providerId: "anthropic", type: "oauth" }];
    }

    async modify(): Promise<Credential | undefined> {
        this.expired = true;
        throw new Error(EXPIRED);
    }

    async delete(): Promise<void> {
        throw new Error("The eval's sign-in is read only");
    }
}

const credentials = new EvalCredentials(join(work, "auth.json"), TOKEN);
const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });

// As the app does: a subscription's requests carry Claude Code's billing line (src/server/claude-billing.ts).
installClaudeCodeBilling(runtime, new PhoneSettingsFile(work));
const model = runtime.getModel("anthropic", MODEL);

if (model === undefined) {
    throw new Error(`Anthropic has no model ${MODEL} in Pi's catalog`);
}

/** The token is no longer good: stop the whole run, and say what to do. */
function stopIfExpired(message: string): void {
    if (credentials.expired || /authentication_error|OAuth token has expired|\b401\b/i.test(message)) {
        console.error(`prompt-eval: ${EXPIRED} (${message.slice(0, 200)})`);
        rmSync(work, { recursive: true, force: true });
        process.exit(3);
    }
}

/** The scenario's request: the variant's first request with the scenario's message in place of the capture's. */
function requestFor(captured: Captured, scenario: Scenario): Context {
    const request = structuredClone(captured[scenario.variant]);
    const user = request.messages.find((message) => message.role === "user" && message.content === captured.message);

    if (user === undefined || user.role !== "user") {
        throw new Error(`The ${scenario.variant} request has no message to replace`);
    }

    user.content = scenario.message;

    return request;
}

const offeredIn =
    (request: Context): Offered =>
    (tool, parameter) =>
        request.messages.some(
            (message) =>
                message.role === "system" &&
                (message.toolsAdded ?? []).some((each) => each.name === tool && parameter in (((each.parameters as { properties?: object }).properties ?? {}) as object)),
        );

type Run = { trace: Trace; requests: number; error?: string };

/** Every request's tokens, for the report: whether the provider's prompt cache held. */
const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

async function ask(messages: Message[]): Promise<AssistantMessage> {
    let reply: AssistantMessage | undefined;

    // A provider's passing error (a 429 upstream, a dropped stream) is tried again after a wait, 5 tries in all; a run
    // still failing then is an error, left out of its scenario's passes and listed (the report says it is incomplete).
    // An expired token stops the run at once.
    for (let attempt = 0; attempt < TRIES; attempt++) {
        if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 3000 * 2 ** attempt));
        }

        try {
            reply = await runtime.completeSimple(model!, { messages }, { maxTokens: 8192, cacheRetention: "short" });
        } catch (error) {
            stopIfExpired(error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error));
            throw error;
        }

        if (reply.stopReason === "error") {
            stopIfExpired(reply.errorMessage ?? "");
        }

        for (const key of ["input", "cacheRead", "cacheWrite", "output"] as const) {
            tokens[key] += reply.usage[key];
        }

        if (reply.stopReason !== "error" && reply.stopReason !== "aborted") {
            return reply;
        }
    }

    return reply!;
}

/** One run: ask, answer lead-ins, stop at the call to check. */
async function runOnce(captured: Captured, scenario: Scenario): Promise<Run> {
    const messages = [...requestFor(captured, scenario).messages];
    const stubs = stubsFor(scenario);
    const leadIns: Call[] = [];
    const rounds = scenario.rounds ?? MAX_LEAD_INS;
    let text = "";
    let requests = 0;

    for (let round = 0; round <= rounds; round++) {
        const reply = await ask(messages);

        requests++;

        if (reply.stopReason === "error" || reply.stopReason === "aborted") {
            return { trace: { leadIns, call: undefined, text }, requests, error: reply.errorMessage ?? reply.stopReason };
        }

        const toolCalls = reply.content.flatMap((part) => (part.type === "toolCall" ? [part] : []));
        const calls = toolCalls.map((part) => ({ name: part.name, arguments: part.arguments as Record<string, unknown> }));

        text += reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
        const next = nextStep({ calls, text }, captured.files, stubs);

        if (!next.more) {
            return { trace: { leadIns: [...leadIns, ...next.leadIns], call: next.call, text }, requests };
        }

        leadIns.push(...calls);
        messages.push(
            reply,
            ...toolCalls.map((part, index) => ({
                role: "toolResult" as const,
                toolCallId: part.id,
                toolName: part.name,
                content: [{ type: "text" as const, text: next.results[index]! }],
                isError: false,
                timestamp: Date.now(),
            })),
        );
    }

    return { trace: { leadIns, call: undefined, text: `${text}\n(stopped after ${rounds} rounds of lead-ins)` }, requests };
}

type Job = { tree: number; scenario: Scenario; run: number };
type Result = { job: Job; outcome: Outcome; requests: number; ms: number; error: boolean };

// Both trees' runs of a scenario side by side: what the provider does at a time (its upstream, its load) falls on both.
const jobs: Job[] = scenarios.flatMap((scenario) => Array.from({ length: RUNS }, (_, run) => trees.map((_, tree) => ({ tree, scenario, run }))).flat());
// Each tree's and variant's first request alone first: it writes the provider's prompt cache the rest then read.
const firsts = jobs.filter((job, index) => jobs.findIndex((each) => each.tree === job.tree && each.scenario.variant === job.scenario.variant) === index);
const rest = jobs.filter((job) => !firsts.includes(job));
const results: Result[] = [];

async function perform(job: Job): Promise<void> {
    const started = Date.now();
    const captured = trees[job.tree]!.captured;
    const run = await runOnce(captured, job.scenario);
    const outcome = run.error === undefined ? judge(job.scenario.expect, run.trace, offeredIn(captured[job.scenario.variant])) : { pass: false, path: "error", why: `error: ${run.error}` };

    results.push({ job, outcome, requests: run.requests, ms: Date.now() - started, error: run.error !== undefined });
    console.error(`${outcome.pass ? "pass" : "FAIL"} ${trees[job.tree]!.label} ${job.scenario.id} #${job.run + 1}: ${outcome.path}${outcome.pass ? "" : ` (${outcome.why})`}`);
}

const started = Date.now();

for (const job of firsts) {
    await perform(job);
}

await Promise.all(
    Array.from({ length: JOBS }, async () => {
        for (let job = rest.shift(); job !== undefined; job = rest.shift()) {
            await perform(job);
        }
    }),
);
const elapsed = Date.now() - started;

const tallies = trees.map((_, tree) =>
    Object.fromEntries(
        scenarios.map((scenario) => {
            const mine = results.filter((result) => result.job.tree === tree && result.job.scenario.id === scenario.id && !result.error);

            return [scenario.id, { passed: mine.filter((result) => result.outcome.pass).length, runs: mine.length, fails: mine.filter((result) => !result.outcome.pass).map((result) => result.outcome) } satisfies Tally];
        }),
    ),
);
const drops = trees.length === 2 ? dropped(tallies[0]!, tallies[1]!) : [];
const errors = results.filter((result) => result.error);
const total = (tree: number) => Object.values(tallies[tree]!).reduce((sum, tally) => ({ passed: sum.passed + tally.passed, runs: sum.runs + tally.runs }), { passed: 0, runs: 0 });
const pct = (passed: number, runs: number) => `${passed}/${runs} (${Math.round((passed / runs) * 100)}%)`;
const requests = (tree: number) => results.filter((result) => result.job.tree === tree).reduce((sum, result) => sum + result.requests, 0);
const report = [
    `# prompt-eval, ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Model ${MODEL} on Anthropic, subscription account ${values.account}, ${RUNS} run${RUNS === 1 ? "" : "s"} of each of ${scenarios.length} scenarios (${(["phone", "machine", "pinned"] as const).map((variant) => `${scenarios.filter((each) => each.variant === variant).length} ${variant}`).join(", ")}).`,
    "",
    `| Scenario | Variant | ${trees.map((tree) => tree.label).join(" | ")} |`,
    `|---|---|${trees.map(() => "---|").join("")}`,
    ...scenarios.map((scenario) => `| ${scenario.id} | ${scenario.variant} | ${tallies.map((tally, tree) => `${tally[scenario.id]!.passed}/${tally[scenario.id]!.runs}${tree === 1 && drops.includes(scenario.id) ? " (dropped)" : ""}`).join(" | ")} |`),
    `| All | | ${trees.map((_, tree) => pct(total(tree).passed, total(tree).runs)).join(" | ")} |`,
    "",
    ...trees.map((tree, index) => `- ${tree.label}: ${requests(index)} requests.`),
    `- ${values.account}'s quota: ${trees.reduce((sum, _, index) => sum + requests(index), 0)} requests of ${planned} planned (at most ${most}), ${Math.round(elapsed / 1000)} s. Tokens: ${tokens.input} input, ${tokens.cacheRead} read from the cache, ${tokens.cacheWrite} written to it, ${tokens.output} output.`,
    "",
    ...(errors.length === 0 ? [] : [`Incomplete: ${errors.length} runs failed with the provider's error, left out of the passes above: ${errors.map((result) => `${trees[result.job.tree]!.label} ${result.job.scenario.id} (${result.outcome.why.slice(0, 80)})`).join("; ")}.`, ""]),
    ...(trees.length === 2 ? [drops.length === 0 ? "No scenario dropped." : `Dropped: ${drops.join(", ")}. With few runs a drop is often the model's chance: confirm with --only ${drops.join(",")} --runs 10.`, ""] : []),
    "## Failures",
    "",
    ...trees.flatMap((tree, index) => {
        const lines = scenarios.flatMap((scenario) => tallies[index]![scenario.id]!.fails.map((fail) => `- ${scenario.id}: ${fail.path}: ${fail.why}`));

        return [`### ${tree.label}`, "", ...(lines.length === 0 ? ["- (none)"] : lines), ""];
    }),
].join("\n");

if (values.out !== undefined) {
    writeFileSync(values.out, report);
}

console.log(report);
rmSync(work, { recursive: true, force: true });
process.exit(drops.length > 0 ? 1 : errors.length > 0 ? 2 : 0);
