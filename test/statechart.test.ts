// Formal checks (PP-316): pstack's statechart skill bundled in third_party/pstack-statechart with statechart-art's boba
// models as its examples; TLC as an opt-in machine tool (Temurin's JRE 21 and tla2tools.jar, sha256-pinned, TLA2TOOLS
// and JAVA for sessions there); the Formal checks extension lists the skill, off hides it, and setting_change switches
// it. Where TLC is (TLA2TOOLS set: CI, a machine with the tool), the skill's own script checks the four examples and
// writes what statechart-art's repo holds, byte for byte. Checked by hand on tuanlh-devbox-01 (linux-x64, 2026-11-01):
// the tool's install script installed it, and the script ran there with the tool's TLA2TOOLS and JAVA.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { installScript, sessionEnvOf, TLC_TOOL, TOOLS, toolOffer, toolsNote } from "../src/server/machine-tools.ts";
import { FORMAL_MODULE } from "../src/server/formal-checks.ts";
import type { Machine } from "../src/server/machines.ts";
import { ART_COMMIT, EXAMPLES, NOTE, PSTACK_COMMIT, SKILL, TARGET, withPiPhone } from "../scripts/sync-statechart.ts";

test("the skill ships with pstack's MIT licence, pi-phone's note, no tests, and the boba examples with statechart-art's", () => {
    const markdown = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const readme = readFileSync(join(TARGET, "README.md"), "utf8");

    assert.match(readFileSync(join(TARGET, "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 Lauren Tan/);
    assert.match(readFileSync(join(SKILL, "examples", "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 Kevin T\. Ngo/);
    assert.match(markdown, /^---\nname: statechart\ndescription: "Check a TLA\+ model[^\n]*\n---\n\n<!-- pi-phone: added \(third_party\/pstack-statechart\/README\.md\) -->\n/);
    assert.doesNotMatch(markdown, /disable-model-invocation/, "Pi may pick it, not only /statechart");
    assert.ok(markdown.includes(NOTE.join("\n")));
    assert.ok(readme.includes(PSTACK_COMMIT) && readme.includes(ART_COMMIT), "the README names both commits");
    assert.equal(existsSync(join(SKILL, "scripts", "test")), false, "no tests");
    assert.ok(existsSync(join(SKILL, "scripts", "statechart")) && existsSync(join(SKILL, "references", "render.md")));
    assert.deepEqual(readdirSync(join(SKILL, "examples")).sort(), ["LICENSE", ...EXAMPLES.map((example) => example.folder)].sort());

    for (const example of EXAMPLES) {
        for (const file of [`${example.spec}.tla`, `${example.spec}.cfg`, "view.mjs", "chart/chart.mmd", "chart/report.md"]) {
            assert.ok(existsSync(join(SKILL, "examples", example.folder, file)), `${example.folder}/${file}`);
        }
    }

    // The Bug model's chart marks its broken rule and the path to it, which the app colours (web/style.css).
    assert.match(readFileSync(join(SKILL, "examples", "bug", "chart", "chart.mmd"), "utf8"), /class s5 breaks\n {2}class s5 bugPath/);
});

test("pi-phone's note goes after the front matter, and only disable-model-invocation leaves it", () => {
    assert.equal(
        withPiPhone("---\nname: s\ndescription: \"d\"\ndisable-model-invocation: true\n---\n\n# S\n", ["<!-- note -->"]),
        '---\nname: s\ndescription: "d"\n---\n\n<!-- note -->\n\n# S\n',
    );
    assert.throws(() => withPiPhone("# no front matter\n", []), /no front matter/);
});

test("TLC: Temurin's JRE 21 and tla2tools.jar 1.7.4, pinned, opt-in, no Android build; the wrapper runs TLC", () => {
    assert.ok(TOOLS.includes(TLC_TOOL));
    assert.equal(toolOffer(TLC_TOOL).optIn, true);
    assert.deepEqual(Object.keys(TLC_TOOL.assets).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"]);
    assert.equal(TLC_TOOL.files![0]!.sha256, "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88", "the sum the skill's run.ts pins");
    assert.ok(readFileSync(join(SKILL, "scripts", "run.ts"), "utf8").includes(`checksum=sha256:${TLC_TOOL.files![0]!.sha256}]@1.7.4`));
    assert.equal(TLC_TOOL.skills, "third_party/pstack-statechart/skills");
    assert.equal(TLC_TOOL.skillsModule, FORMAL_MODULE);

    for (const [target, asset] of Object.entries(TLC_TOOL.assets)) {
        assert.match(asset!.url, /^https:\/\/github\.com\/adoptium\/temurin21-binaries\/releases\/download\/jdk-21\.0\.13%2B9\/OpenJDK21U-jre_(x64|aarch64)_(linux|mac|windows)_hotspot_21\.0\.13_9\.(tar\.gz|zip)$/, target);
        assert.match(asset!.sha256, /^[0-9a-f]{64}$/, target);
        assert.match(asset!.member!, /^jdk-21\.0\.13\+9-jre\/(Contents\/Home\/)?bin\/java(\.exe)?$/, target);
    }

    const script = installScript(TLC_TOOL, TLC_TOOL.assets["linux-x64"]!, "/home/me");
    const dir = "/home/me/.pi/mobile/tools/tlc/1.7.4";

    assert.equal(script.match(/^fetch /gm)?.length, 2, "the JRE and the jar");
    assert.ok(script.includes("got=$(sum \"$tmp/file-0\")\nif [ \"$got\" != '936a2620"), script);
    assert.ok(script.indexOf("cp \"$tmp/file-0\" \"$T/tlc/1.7.4\"/tla2tools.jar") > script.lastIndexOf("got=$(sum"), "kept only after both are checked");
    assert.match(script, /tar -xzf "\$tmp\/download" -C "\$T\/tlc\/1\.7\.4"\/files/);
    assert.ok(script.includes(`exec '${dir}/files/jdk-21.0.13+9-jre/bin/java' '-XX:+UseParallelGC' '-cp' '${dir}/tla2tools.jar' 'tlc2.TLC' "$@"`), script);
    assert.match(script, /"\$T\/bin\/tlc" --version \| head -n 1$/);

    const windows = installScript(TLC_TOOL, TLC_TOOL.assets["windows-x64"]!, "C:/Users/me", true);

    assert.ok(windows.includes("exec 'C:/Users/me/.pi/mobile/tools/tlc/1.7.4/files/jdk-21.0.13+9-jre/bin/java.exe' '-XX:+UseParallelGC' '-cp' 'C:/Users/me/.pi/mobile/tools/tlc/1.7.4/tla2tools.jar'"), windows);
});

test("TLA2TOOLS and JAVA for sessions on a machine with TLC at its version, and the environment says so", () => {
    const machine = (platform: string, arch: string, tools: Record<string, string>, home = "/home/me") =>
        ({ id: "m1", name: "box", user: "me", host: "box", remote: { platform, arch, home }, tools }) as unknown as Machine;

    assert.deepEqual(sessionEnvOf(machine("linux", "x64", { tlc: "1.7.4" })), {
        TLA2TOOLS: "/home/me/.pi/mobile/tools/tlc/1.7.4/tla2tools.jar",
        JAVA: "/home/me/.pi/mobile/tools/tlc/1.7.4/files/jdk-21.0.13+9-jre/bin/java",
    });
    assert.equal(sessionEnvOf(machine("darwin", "arm64", { tlc: "1.7.4" }, "/Users/me")).JAVA, "/Users/me/.pi/mobile/tools/tlc/1.7.4/files/jdk-21.0.13+9-jre/Contents/Home/bin/java");
    assert.equal(sessionEnvOf(machine("windows", "x64", { tlc: "1.7.4" }, "C:/Users/me")).JAVA, "C:/Users/me/.pi/mobile/tools/tlc/1.7.4/files/jdk-21.0.13+9-jre/bin/java.exe");
    assert.deepEqual(sessionEnvOf(machine("linux", "x64", { tlc: "1.7.3" })), {}, "another version: none");
    assert.deepEqual(sessionEnvOf(machine("linux", "x64", {})), {});
    assert.deepEqual(sessionEnvOf(machine("android", "arm64", { tlc: "1.7.4" })), {}, "no build for the phone");
    assert.match(toolsNote({ tlc: "1.7.4" })!, /TLC checks TLA\+ models there: bash has TLA2TOOLS \(tla2tools\.jar\) and JAVA .* never use mise/);
});

// ---- The extension, in a running app ------------------------------------------------------------------------------

const calls: Record<string, [string, Record<string, unknown>]> = {
    "formal off": ["setting_change", { id: "extensions.formal.ts", value: "off", reason: "Not needed" }],
    "formal on": ["setting_change", { id: "extensions.formal.ts", value: "on", reason: "Back" }],
};
let prompt = "";
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    prompt = JSON.stringify((request.messages as { role: string; sections?: Record<string, string> }[]).filter((message) => message.role === "system").map((message) => message.sections ?? {}));

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

async function turn(id: number, text: string, answer?: boolean): Promise<string> {
    const { submissionId } = await app!.commands.submit(id as never, owner(app!), { text, requestId: crypto.randomUUID() });

    if (answer !== undefined) {
        await until(() => app!.approvals.forConversation(id as never).length > 0, "the card");
        await app!.answerApproval(app!.approvals.forConversation(id as never)[0]!.id, answer, owner(app!));
    }

    await (await app!.harness.submission(submissionId, context))!.wait(context);
    await app!.harness.waitForIdle(context);

    return (await modelTexts(app!, id as never)).at(-1)!;
}

test("Formal checks lists the statechart skill; setting_change turns it off, which hides it, and on again", async () => {
    app = await openApp(scriptedModel(route));
    const id = await newSession(app);
    const listed = () => app!.skillCommands(id).some((each) => each.name === "statechart");

    assert.equal(app.loader.list().find((module) => module.file === FORMAL_MODULE)?.title, "Formal checks");
    assert.equal(app.loader.enabled(FORMAL_MODULE), true, "on by default");
    assert.equal(listed(), true);
    await turn(id, "hello");
    assert.match(prompt, /<name>statechart<\/name>[^]*third_party\/pstack-statechart\/skills\/statechart\/SKILL\.md/);

    assert.match(await turn(id, "formal off", true), /Changed extensions\.formal\.ts: on → off/);
    assert.equal(app.loader.enabled(FORMAL_MODULE), false);
    assert.equal(listed(), false);

    // A session's skills section is made with its first prompt (as Design & video's): a new session's has none.
    const off = await newSession(app);

    await turn(off, "hello");
    assert.doesNotMatch(prompt, /<name>statechart<\/name>/);
    assert.match(prompt, /<name>html<\/name>/, "the other skills stay");

    assert.match(await turn(off, "formal on", true), /Changed extensions\.formal\.ts: off → on/);
    assert.equal(listed(), true);
    await turn(await newSession(app), "hello");
    assert.match(prompt, /<name>statechart<\/name>/);
});

// ---- Where TLC is: the skill's own script on the four examples -----------------------------------------------------

const tlc = process.env.TLA2TOOLS;
const where = { skip: tlc === undefined || tlc === "" ? "no TLC here (TLA2TOOLS unset): CI and machines with the TLC tool run it" : false } as const;

test("the skill's script checks the four boba models: Bug breaks its rule (exit 1), the others hold, as their charts say", where, () => {
    for (const example of EXAMPLES) {
        const out = mkdtempSync(join(tmpdir(), `statechart-${example.folder}-`));
        const folder = join(SKILL, "examples", example.folder);

        try {
            const run = spawnSync("sh", [join(SKILL, "scripts", "statechart"), join(folder, `${example.spec}.tla`), "--view", join(folder, "view.mjs"), "--out", out], {
                encoding: "utf8",
                timeout: 180_000,
            });

            assert.equal(run.status, example.folder === "bug" ? 1 : 0, `${example.folder}: ${run.stdout}\n${run.stderr}`);
            assert.equal(readFileSync(join(out, "chart.mmd"), "utf8"), readFileSync(join(folder, "chart", "chart.mmd"), "utf8"), example.folder);
            assert.equal(readFileSync(join(out, "report.md"), "utf8"), readFileSync(join(folder, "chart", "report.md"), "utf8"), example.folder);
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    }
});
