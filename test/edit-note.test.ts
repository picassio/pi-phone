// Changes made by scripts in bash show no diff in the app (PP-100): Pi's prompt says to change files with edit or write
// only, and a bash command that writes files by script still runs, with a one-line reminder in its result: for project
// files, not for scratch ones (under /tmp or $TMPDIR, *.local.*, or ignored by git there; PP-206).
import { type App, cleanUp, context, home, lastText, modelTexts, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { EDIT_NOTE, scratchFile, scriptTargets, writesByScript, writesProjectFiles } from "../src/server/extensions/prompt.ts";

const file = join(work, "edit-note.txt");
let guidelines = "";

const calls: Record<string, string> = {
    // By its name in the session's folder: the tests' folders are under $TMPDIR, whose files get no reminder (PP-206).
    "change it by script": "sed -i 's/old/new/' edit-note.txt",
    "just look": `cat ${file} > /dev/null; ls ${work} > /dev/null 2>&1; echo looked`,
    // PP-206: in a git repository (`repo`), a project file, a scratch file, a .local. one, and an ignored one.
    "write a project file": "cat > src/x.ts <<'EOF'\nexport const x = 1;\nEOF\necho wrote",
    "write a scratch file": "cat > $TMPDIR/pp206-check.mjs <<'EOF'\nconsole.log(1)\nEOF\necho wrote",
    "write a local file": "cat > settings.local.json <<'EOF'\n{}\nEOF\necho wrote",
    "write an ignored file": "mkdir -p build && cat > build/out.txt <<'EOF'\nout\nEOF\necho wrote",
};
const repo = join(work, "edit-note-repo");

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
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    execFileSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
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

test("the files a command writes by script, and which are scratch files (PP-206)", async () => {
    assert.deepEqual(scriptTargets("cat > src/x.ts <<EOF\nx\nEOF"), { files: ["src/x.ts"], unknown: false });
    assert.deepEqual(scriptTargets("cat >> '/tmp/a b.txt' <<'EOF'"), { files: ["/tmp/a b.txt"], unknown: false });
    assert.deepEqual(scriptTargets("echo hi | tee -a out.txt notes.md > /dev/null"), { files: ["out.txt", "notes.md"], unknown: false });
    assert.deepEqual(scriptTargets("sed -i 's/a/b/' x.ts y.ts"), { files: ["x.ts", "y.ts"], unknown: false });
    assert.deepEqual(scriptTargets("sed -E -i.bak -e 's/a/b/' x.ts"), { files: ["x.ts"], unknown: false });
    assert.deepEqual(scriptTargets("perl -pi -e 's/a/b/' x.ts"), { files: ["x.ts"], unknown: false });
    assert.deepEqual(scriptTargets(`node -e 'require("fs").writeFileSync("a.json", "{}")'`), { files: ["a.json"], unknown: false });
    assert.deepEqual(scriptTargets(`node -e 'fs.writeFileSync(path, "{}")'`), { files: [], unknown: true }, "a name the command builds");
    assert.deepEqual(scriptTargets(`python3 -c 'open("a.txt", "w").write("x")'`), { files: ["a.txt"], unknown: false });

    for (const path of ["/tmp/x.mjs", "$TMPDIR/x.cjs", "${TMPDIR}/y", "/data/tmp/z", "settings.local.json", "src/.env.local.ts"]) {
        assert.ok(scratchFile(path, "/data/tmp"), path);
    }

    for (const path of ["src/x.ts", "tmp/x.ts", "/data/tmpfile", "local.json", "/tmpx/y"]) {
        assert.ok(!scratchFile(path, "/data/tmp"), path);
    }

    const none = async () => new Set<string>();
    const build = async (files: string[]) => new Set(files.filter((each) => each.startsWith("build/")));

    assert.equal(await writesProjectFiles("cat > src/x.ts <<EOF\nx\nEOF", none), true);
    assert.equal(await writesProjectFiles("cat > /tmp/x.mjs <<EOF\nx\nEOF", none), false);
    assert.equal(await writesProjectFiles("cat > config.local.json <<EOF\n{}\nEOF", none), false);
    assert.equal(await writesProjectFiles("cat > build/out.txt <<EOF\nx\nEOF", build), false);
    assert.equal(await writesProjectFiles("tee build/a src/b < x", build), true, "one project file is enough");
    assert.equal(await writesProjectFiles(`node -e 'fs.writeFileSync(name, "")'`, none), true, "a write naming no file keeps it");
    assert.equal(await writesProjectFiles("cat README.md", none), false);
});

test("the reminder in a session: for a project file, not for /tmp or $TMPDIR, a .local. name, or a file git ignores (PP-206)", async () => {
    const id = await newSession(app, repo);

    for (const [ask, noted] of [
        ["write a project file", true],
        ["write a scratch file", false],
        ["write a local file", false],
        ["write an ignored file", false],
    ] as const) {
        const said = await turn(id, ask);

        assert.match(said, /wrote/, ask);
        assert.equal(said.includes(EDIT_NOTE), noted, `${ask}: ${said}`);
    }

    assert.equal(readFileSync(join(repo, "build", "out.txt"), "utf8"), "out\n");
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
