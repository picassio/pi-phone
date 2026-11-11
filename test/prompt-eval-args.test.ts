// Evals run on a Claude subscription, never on OpenRouter (PP-476): what the eval scripts refuse before any request,
// what they default to, and the request count the owner is asked with. No network: every case stops before a request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "../scripts/prompt-eval-scenarios.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A script run with only the variables given: no key of this machine reaches it. */
function run(command: string, args: string[], env: Record<string, string> = {}) {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? "", HOME: mkdtempSync(join(tmpdir(), "prompt-eval-args-")), ...env },
        encoding: "utf8",
        timeout: 60_000,
    });

    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const promptEval = (args: string[], env?: Record<string, string>) => run(process.execPath, [join(ROOT, "scripts", "prompt-eval.ts"), ...args], env);

test("an OpenRouter model or another provider's is refused before any request", () => {
    for (const model of ["openrouter/anthropic/claude-opus-5.5", "openai/gpt-5.5"]) {
        const result = promptEval(["--dry-run", "--model", model]);

        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /is not an Anthropic model, and evals never run on OpenRouter/);
    }

    const unknown = promptEval(["--dry-run", "--model", "gpt-5.5"]);

    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Anthropic has no model gpt-5\.5 in Pi's catalog/);
});

test("a run without the subscription's token is refused: none, OpenRouter's key alone, or an API key", () => {
    const none = promptEval(["--only", "no-such-scenario"]);

    assert.equal(none.status, 1);
    assert.match(none.stderr, /EVAL_ANTHROPIC_TOKEN is needed: a short-lived OAuth token of anthropic~han-acc's Claude subscription/);

    // `--only` names no scenario, so the script before PP-476 stopped there too, before any request.
    const openRouter = promptEval(["--only", "no-such-scenario"], { OPENROUTER_API_KEY: "sk-or-v1-test" });

    assert.equal(openRouter.status, 1);
    assert.match(openRouter.stderr, /OPENROUTER_API_KEY is set but evals never run on OpenRouter/);

    const apiKey = promptEval(["--only", "no-such-scenario"], { EVAL_ANTHROPIC_TOKEN: "sk-ant-api03-test" });

    assert.equal(apiKey.status, 1);
    assert.match(apiKey.stderr, /not a subscription OAuth token/);
});

test("the default is the owner's Opus on Anthropic, on the account anthropic~han-acc", () => {
    const result = promptEval(["--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Model claude-opus-5-5 on Anthropic, account anthropic~han-acc\./);
    assert.doesNotMatch(result.stdout + result.stderr, /openrouter/i);
});

test("--dry-run prints the requests a run makes, and only that", () => {
    const core = SCENARIOS.filter((scenario) => scenario.core === true);
    const most = core.reduce((sum, scenario) => sum + ((scenario.rounds ?? 3) + 1) * 2 * 2, 0);
    const result = promptEval(["--dry-run", "--only", "core", "--runs", "2", "--compare", "origin/master", "--account", "anthropic~tuan-dw"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
        result.stdout.trim(),
        `Planned: ${core.length * 4} requests (${core.length} scenarios × 2 runs × 2 trees), at most ${most} with lead-ins; ` +
            "a provider's passing error is tried again, at most 4 times a request. Model claude-opus-5-5 on Anthropic, account anthropic~tuan-dw.",
    );
});

test("wiki-eval refuses its ways that need OpenRouter, and the devbox runner refuses to start without the token", () => {
    const wiki = run(process.execPath, [join(ROOT, "scripts", "wiki-eval.ts"), "--configs", "A,B"]);

    assert.notEqual(wiki.status, 0);
    assert.match(wiki.stderr, /--configs B: embeddings and Jev run on OpenRouter only, and evals never run on OpenRouter/);

    const runner = run("bash", [join(ROOT, "scripts", "eval-on-devbox.sh"), "scripts/prompt-eval.ts", "--compare", "origin/master"]);

    assert.equal(runner.status, 1);
    assert.match(runner.stderr, /EVAL_ANTHROPIC_TOKEN is needed: ask the owner/);
});
