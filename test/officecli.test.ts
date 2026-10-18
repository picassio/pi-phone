// OfficeCLI on the phone (src/server/officecli.ts): Pi's bash has `officecli`, a wrapper that runs the bundled binary as
// it must run on Android; OfficeCLI's skills are Pi's; the Files viewer shows Office files as OfficeCLI renders them.
// The binary is Android's (bionic), so these tests stand in a script of their own for it, which echoes what it was run with.
import { cleanUp, context, home, lastText, modelTexts, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PocketApp } from "../src/server/app.ts";
import { OfficeCli } from "../src/server/officecli.ts";

type App = Awaited<ReturnType<typeof PocketApp.open>>;

const stub = join(root, "officecli-stub", "officecli");
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("use office")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "command -v officecli; officecli --version" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `saw: ${text}` : "ok")]);
};
const model = scriptedModel(route);
let app: App;

before(async () => {
    mkdirSync(join(root, "officecli-stub"), { recursive: true });
    // Stands in for OfficeCLI: --version prints what it runs with; `view <file> html -o <out>` writes a page naming the file.
    writeFileSync(
        stub,
        [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then echo "1.0.157 lib=$LD_LIBRARY_PATH skip=$OFFICECLI_SKIP_UPDATE noinstall=$OFFICECLI_NO_AUTO_INSTALL"; exit 0; fi',
            'if [ "$1" = "view" ] && [ "$3" = "html" ]; then',
            '  case "$2" in *broken*) echo "Error: not a valid package" >&2; exit 1;; esac',
            '  printf "<html><body><h1>Rendered %s</h1><p>resident=%s</p></body></html>" "$(basename "$2")" "$OFFICECLI_NO_AUTO_RESIDENT" > "$5"; exit 0',
            "fi",
            "exit 2",
        ].join("\n") + "\n",
    );
    chmodSync(stub, 0o755);
    app = await PocketApp.open({
        dataDir: join(root, "data-officecli"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(model.provider),
        home,
        officecli: { binary: stub, prefix: "/opt/termux", runs: true },
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("where it cannot run, there is no officecli, no skills, and no preview", () => {
    const off = new OfficeCli({ dataDir: join(root, "data-office-off"), binary: stub, runs: false });

    off.install();
    assert.equal(off.available(), false);
    assert.equal(existsSync(join(off.binDir, "officecli")), false);
    return assert.rejects(off.renderHtml(join(work, "a.docx")), /not available here/);
});

test("Pi's bash has officecli, run with OpenSSL from Termux, no self-update, and no self-install", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "use office", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    const said = (await modelTexts(app, id)).at(-1)!;

    assert.match(said, new RegExp(join(app.officecli.binDir, "officecli").replace(/[/.]/g, "\\$&")));
    assert.match(said, /1\.0\.157 lib=\/opt\/termux\/lib skip=1 noinstall=1/);
    assert.equal((await app.hello(owner(app))).server.officecli, true);
});

test("OfficeCLI's skills are Pi's, after any of the owner's by the same name", () => {
    const names = app.skills(work).map((skill) => skill.name);

    for (const name of ["officecli", "officecli-docx", "officecli-xlsx", "officecli-pptx"]) {
        assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
    }

    const main = app.skills(work).find((skill) => skill.name === "officecli")!;

    assert.match(main.filePath, /third_party\/officecli\/skills\/officecli\/SKILL\.md$/);
});

test("the Files viewer's preview: an Office file as OfficeCLI renders it, in the artifacts' sandbox; what it cannot show says why", async () => {
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { id } = await app.commands.createSession(owner(app), { cwd: work });
    const get = (path: string) =>
        fetch(`${base}/a/office/${String(id)}?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${app.config.ownerToken}` } });

    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "Report.docx"), "PK fake docx");
    writeFileSync(join(work, "broken.xlsx"), "not a zip");
    writeFileSync(join(work, "notes.txt"), "plain");

    try {
        const page = await get(join(work, "Report.docx"));

        assert.equal(page.status, 200);
        assert.match(page.headers.get("content-security-policy") ?? "", /^sandbox /);
        assert.match(await page.text(), /<h1>Rendered Report\.docx<\/h1><p>resident=1<\/p>/, "one command, no resident left behind");

        const broken = await get(join(work, "broken.xlsx"));

        assert.equal(broken.status, 422);
        assert.match(await broken.text(), /OfficeCLI could not show broken\.xlsx: Error: not a valid package/);
        assert.equal((await get(join(work, "notes.txt"))).status, 400);
        assert.equal((await get(join(work, "missing.pptx"))).status, 404);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
