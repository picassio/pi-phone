// Documents in the chat and for Pi: an attached PDF or spreadsheet goes with its Markdown (markit, our fork's Android
// build on the phone), Pi converts files with file_to_markdown, and the shared module knows a document when it sees one.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { documentKind, toMarkdown } from "../src/server/documents.ts";

/** A one-page PDF saying `text`. */
function pdf(text: string): Buffer {
    const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;

    return Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${stream.length}>>stream
${stream}
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`);
}

const sheet = join(work, "budget.csv");
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("convert it")) {
        return fauxAssistantMessage([fauxToolCall("file_to_markdown", { path: "budget.csv" })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("ingest it")) {
        return fauxAssistantMessage([fauxToolCall("wiki_ingest", { source: join(work, "spec.pdf"), category: "resources", scope: ["work"] })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("convert text")) {
        return fauxAssistantMessage([fauxToolCall("file_to_markdown", { path: "notes.txt" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : `heard: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("markit reads documents on this platform, and documents are known by name or type", async () => {
    assert.equal(documentKind("Report.PDF"), ".pdf");
    assert.equal(documentKind("upload", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), ".docx");
    assert.equal(documentKind("notes.txt", "text/plain"), undefined);
    assert.equal(documentKind("photo.png", "image/png"), undefined);
    assert.match((await toMarkdown(pdf("Quarterly numbers"), ".pdf")).markdown, /Quarterly numbers/);
    assert.equal((await toMarkdown(Buffer.from("a,b\n1,2\n"), ".csv")).markdown, "| a | b |\n| --- | --- |\n| 1 | 2 |");
});

test("an attached document goes with its Markdown, saved beside it", async () => {
    const id = await newSession(app);
    const folder = app.workspace.uploadDirectory(id);
    const file = join(folder, "report.pdf");

    writeFileSync(file, pdf("Revenue grew"));
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text: "summarise this",
        requestId: crypto.randomUUID(),
        attachments: [{ path: file, name: "report.pdf", mime: "application/pdf", size: 400 }],
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    const said = (await modelTexts(app, id)).find((each) => each.includes("summarise this"))!;

    assert.match(said, new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(report\\.pdf, application/pdf, 400 bytes\\) → as Markdown: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.md`));
    assert.match(readFileSync(`${file}.md`, "utf8"), /Revenue grew/);
});

test("Pi converts a document with file_to_markdown, saved beside it; other files are for read", async () => {
    mkdirSync(work, { recursive: true });
    writeFileSync(sheet, "item,cost\nphone,900\n");
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "convert it", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    const answer = (await modelTexts(app, id)).at(-1)!;

    assert.match(answer, /\| item \| cost \|/);
    assert.ok(existsSync(`${sheet}.md`));

    const second = await app.commands.submit(id, owner(app), { text: "convert text", requestId: crypto.randomUUID() });

    await (await app.harness.submission(second.submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    assert.match((await modelTexts(app, id)).at(-1)!, /is not a document file_to_markdown reads/);
});

test("wiki_ingest takes a document as its Markdown", async () => {
    writeFileSync(join(work, "spec.pdf"), pdf("The relay holds sessions for fifteen minutes"));
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "ingest it", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    const answer = (await modelTexts(app, id)).at(-1)!;

    assert.doesNotMatch(answer, /%PDF|endobj/, answer.slice(0, 300));
    assert.match(answer, /relay holds sessions|spec\.pdf\.md/, answer.slice(0, 600));
    assert.match(readFileSync(join(work, "spec.pdf.md"), "utf8"), /relay holds sessions/);
});
