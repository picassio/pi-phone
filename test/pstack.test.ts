// pstack commands (PP-550, PP-551): thirteen of pstack's skills in third_party/pstack/, slash commands only, adapted to pi-phone's
// tools by pi-phone.patch with each change marked; the extension, on by default (PP-551), lists them as /skill:
// commands, and with it on the system prompt is the same, character for character, as with it off
// (disable-model-invocation keeps every one out of the skills section).
import { type App, cleanUp, context, lastText, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUNDLED, MARK_CLOSE, MARK_OPEN, PATCH, PSTACK_COMMIT, renamed, SKILLS, TARGET } from "../scripts/sync-pstack.ts";
import { PSTACK_MODULE } from "../src/server/pstack.ts";

const names = BUNDLED.map((skill) => skill.name);
const fileOf = (name: string) => join(SKILLS, name, "SKILL.md");
/** What a skill written for Cursor would say, which pi-phone's adapted text must not. */
const CURSOR = /subagent_type|generalPurpose|AskQuestion|readonly: true|\.cursor\/|plugins\/cache|claude-(opus|fable)|gemini-\d|\barena\b|\/visualize|Task subagent|Task tool|Bugbot/;

test("the thirteen skills, with pstack's MIT licence, each a slash command only, named as its folder", () => {
    assert.match(readFileSync(join(TARGET, "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 Lauren Tan/);
    assert.ok(readFileSync(join(TARGET, "README.md"), "utf8").includes(PSTACK_COMMIT), "the README names the commit");
    assert.deepEqual(readdirSync(SKILLS).sort(), [...names].sort());
    assert.equal(names.length, 13);

    for (const name of names) {
        const { frontmatter, body } = parseFrontmatter(readFileSync(fileOf(name), "utf8")) as { frontmatter: Record<string, unknown>; body: string };

        assert.equal(frontmatter.name, name);
        assert.equal(typeof frontmatter.description, "string", name);
        assert.ok((frontmatter.description as string).length > 10 && (frontmatter.description as string).length <= 1024, name);
        assert.equal(frontmatter["disable-model-invocation"], true, `${name}: a slash command only`);
        assert.doesNotMatch(body, CURSOR, name);
    }
});

test("every pi-phone change is marked, and the marks pair up", () => {
    for (const name of names) {
        const markdown = readFileSync(fileOf(name), "utf8");
        const opens = markdown.match(MARK_OPEN)?.length ?? 0;
        const closes = markdown.split(MARK_CLOSE).length - 1;

        assert.equal(opens, closes, name);

        let open = false;

        for (const line of markdown.split("\n")) {
            for (const mark of line.match(new RegExp(`${MARK_OPEN.source}|${MARK_CLOSE}`, "g")) ?? []) {
                assert.equal(open, mark === MARK_CLOSE, `${name}: ${line}`);
                open = mark !== MARK_CLOSE;
            }
        }

        assert.equal(open, false, `${name} ends inside a mark`);
    }

    // Each line the patch adds is a mark, inside a block of them, carries its own, or is blank.
    const patch = readFileSync(PATCH, "utf8");
    let inside = false;

    for (const line of patch.split("\n")) {
        if (line.startsWith("@@") || line.startsWith("diff ")) {
            assert.equal(inside, false, "a hunk ends inside a mark");
        }

        if (line.startsWith("+++") || line.startsWith("---") || !(line.startsWith("+") || line.startsWith(" "))) {
            continue;
        }

        const text = line.slice(1);
        const blockOpen = new RegExp(`^${MARK_OPEN.source}$`).test(text);

        if (blockOpen || text === MARK_CLOSE) {
            inside = blockOpen;
            continue;
        }

        // A blank line that sets a block apart carries nothing.
        if (line.startsWith("+") && text.trim() !== "") {
            assert.ok(inside || new RegExp(`${MARK_OPEN.source}.*${MARK_CLOSE}`).test(text), `unmarked: ${text}`);
        }
    }

    assert.ok(patch.includes("+++ b/skills/interrogate/SKILL.md"));
});

test("the committed skills are pstack's at the commit with pi-phone.patch applied", () => {
    const root = resolve(TARGET, "..", "..");
    const check = spawnSync("git", ["apply", "-R", "--check", "-p1", "--directory=third_party/pstack", PATCH], { cwd: root, encoding: "utf8" });

    assert.equal(check.status, 0, check.stderr);
});

test("unslop is renamed in its front matter only; a SKILL.md without one is refused", () => {
    assert.equal(renamed("---\nname: unslop\ndescription: d\n---\n\n# Unslop\n", "unslop-writing"), "---\nname: unslop-writing\ndescription: d\n---\n\n# Unslop\n");
    assert.throws(() => renamed("# none\n", "x"), /no front matter/);
});

test("the adapted skills use pi-phone's tools: interview for models and calls, subagent with worktrees, the library", () => {
    const text = (name: string) => readFileSync(fileOf(name), "utf8");
    const interrogate = text("interrogate");

    // Models: only those the owner ticks on one interview card, none swapped in.
    assert.match(interrogate, /Call `models` with `available: true`\. Then ask on one `interview` card, as a `multi` question/);
    assert.match(interrogate, /Spawn only on the models ticked on that card\. Never add, pick, or swap a model yourself\./);
    assert.match(interrogate, /git worktree add --detach "\$wt" HEAD/);
    assert.match(interrogate, /rerun its exact command in that adversary's worktree/);
    assert.match(interrogate, /git worktree remove --force/);
    // worker.md's rules, in the briefs only.
    for (const name of ["interrogate", "how"]) {
        assert.match(text(name), /> - Never call a tool that shows a person a question, such as `interview`/, name);
    }

    assert.match(text("how"), /`subagent` with action `spawn`[^\n]*`tools: \["read", "bash"\]`\. Pass no `model`/);
    assert.match(text("ketchup"), /one `interview` card with `async: true`/);
    // The video (PP-551): narrated, on a machine with HyperFrames, only after the owner picks Render on a card.
    assert.match(text("ketchup-video"), /ask the owner on one `interview` card, a `single` question with the options Render and Not now/);
    assert.match(text("ketchup-video"), /Make nothing before the owner picks Render\./);
    assert.match(text("ketchup-video"), /Make one `audio_speak` file per slide/);
    assert.match(text("ketchup-video"), /`hyperframes render <folder> -o <file>\.mp4`/);
    assert.match(text("ketchup-video"), /!\[what it shows\]\(videos\/<name>\.mp4\)/);
    assert.match(text("reflect"), /save each edit with `skill_save`/);
    assert.match(text("reflect"), /goes to the wiki instead/);
    assert.match(text("blast-radius"), /`unslop-writing`/);
    assert.match(text("teach"), /\*\*unslop-writing\*\* skill/);
});

// ---- The extension, in a running app ------------------------------------------------------------------------------

const calls: Record<string, [string, Record<string, unknown>]> = {
    "pstack on": ["setting_change", { id: "extensions.pstack.ts", value: "on", reason: "The owner wants them" }],
    "pstack off": ["setting_change", { id: "extensions.pstack.ts", value: "off", reason: "Not needed" }],
};
let prompt = "";
let asked = "";
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    prompt = JSON.stringify((request.messages as { role: string; sections?: Record<string, string> }[]).filter((message) => message.role === "system").map((message) => message.sections ?? {}));

    if (role === "user") {
        asked = text;
    }

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText("ok")]);
};
let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

async function turn(id: number, text: string, answer?: boolean): Promise<void> {
    const { submissionId } = await app!.commands.submit(id as never, owner(app!), { text, requestId: crypto.randomUUID() });

    if (answer !== undefined) {
        await until(() => app!.approvals.forConversation(id as never).length > 0, "the card");
        await app!.answerApproval(app!.approvals.forConversation(id as never)[0]!.id, answer, owner(app!));
    }

    await (await app!.harness.submission(submissionId, context))!.wait(context);
    await app!.harness.waitForIdle(context);
}

/** The system prompt with each run of digits as N: sessions differ only in their numbers. */
const same = (text: string) => text.replace(/\d+/g, "N");

test("on by default, every session lists the thirteen as /skill: commands and the prompt is the one with it off", async () => {
    app = await openApp(scriptedModel(route));

    const listed = (id: number) => app!.skillCommands(id as never).map((each) => each.name).filter((name) => names.includes(name)).sort();
    const on = await newSession(app);

    assert.equal(app.loader.list().find((module) => module.file === PSTACK_MODULE)?.title, "pstack commands");
    assert.equal(app.loader.enabled(PSTACK_MODULE), true, "on by default (the owner's choice, PP-551)");
    assert.deepEqual(listed(on), [...names].sort(), "each in the / list");
    await turn(on, "hello");

    const withIt = prompt;

    assert.ok(withIt.length > 1000 && withIt.includes("<name>statechart</name>"), "the skills section is there, with the others");

    for (const name of names) {
        assert.doesNotMatch(withIt, new RegExp(`<name>${name}</name>`), name);
    }

    await turn(on, "pstack off", true);
    assert.equal(app.loader.enabled(PSTACK_MODULE), false);

    const off = await newSession(app);

    assert.deepEqual(listed(off), [], "off: no session lists them");
    await turn(off, "hello");
    assert.equal(same(prompt), same(withIt), "the system prompt with the extension on is the one with it off");

    await turn(off, "pstack on", true);
    assert.equal(app.loader.enabled(PSTACK_MODULE), true);

    const again = await newSession(app);

    assert.deepEqual(listed(again), [...names].sort(), "on again, each in the / list again");

    // A command loads its adapted text into the message.
    await turn(again, "/skill:why why is the day chart redrawn?");
    assert.match(asked, /^<skill name="why" location="[^"]*third_party\/pstack\/skills\/why\/SKILL\.md">/);
    assert.match(asked, /In pi-phone the record also holds the wiki[^]*\n\nwhy is the day chart redrawn\?$/);

    await turn(again, "pstack off", true);
    assert.deepEqual(listed(await newSession(app)), []);
});
