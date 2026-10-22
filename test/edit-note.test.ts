// Changes made by scripts in bash show no diff in the app (PP-100): Pi's prompt says to change files with edit or write
// only, and a bash command that writes files by script still runs, with a one-line reminder in its result.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { EDIT_NOTE, writesByScript } from "../src/server/extensions/prompt.ts";

const file = join(work, "edit-note.txt");
let guidelines = "";

const calls: Record<string, string> = {
    "change it by script": `sed -i 's/old/new/' ${file}`,
    "just look": `cat ${file} > /dev/null; ls ${work} > /dev/null 2>&1; echo looked`,
};

const route: FauxResponseStep = (request) => {
    for (const message of (request as { messages: { role: string; sections?: Record<string, string | null> }[] }).messages) {
        if (message.role === "system" && message.sections?.guidelines) {
            guidelines = message.sections.guidelines;
        }
    }

    const { role, text } = lastText(request as never);

    for (const [ask, command] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : `heard: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
    mkdirSync(work, { recursive: true });
    writeFileSync(file, "old\n");
});

after(async () => {
    await app.close();
    cleanUp();
});

async function turn(id: Parameters<App["commands"]["submit"]>[0], text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return (await modelTexts(app, id)).at(-1)!;
}

test("which commands write files by script", () => {
    for (const command of [
        "sed -i 's/a/b/' x.ts",
        "sed -E -i.bak 's/a/b/' x.ts",
        "perl -pi -e 's/a/b/' x.ts",
        "cat > $TMPDIR/x.cjs <<'EOF'\nconsole.log(1)\nEOF",
        "cat >>notes.md <<EOF",
        "node -e 'require(\"fs\").writeFileSync(\"a.json\", \"{}\")'",
        "python3 -c 'open(\"a.txt\", \"w\").write(\"x\")'",
        "echo hi | tee out.txt",
    ]) {
        assert.ok(writesByScript(command), command);
    }

    for (const command of [
        "npm test > $TMPDIR/test.log 2>&1",
        "cat README.md",
        "cat a.txt > /dev/null",
        "rg -n 'sed -i' docs",
        "git status --short",
        "node --test test/x.test.ts 2>&1 | tail -5",
        "sed -n 1,20p file.ts",
    ]) {
        assert.ok(!writesByScript(command), command);
    }
});

test("Pi is told to change files with edit, and a bash edit by script runs with a reminder; other commands get none", async () => {
    const id = await newSession(app);
    const changed = await turn(id, "change it by script");

    assert.equal(readFileSync(file, "utf8"), "new\n", "the command still ran");
    assert.ok(changed.includes(EDIT_NOTE), changed);
    assert.match(guidelines, /Change files only with edit \(or write for a new file or a full rewrite\); never with scripts, heredocs, or sed -i in bash: those edits show no diff\./);

    const looked = await turn(id, "just look");

    assert.match(looked, /looked/);
    assert.ok(!looked.includes(EDIT_NOTE));
});
