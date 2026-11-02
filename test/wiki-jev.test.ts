// The wiki's search ranked by Jev (PP-312): the pages that come with a message and wiki_query keep what Jev judges to
// help (at least 0.6, best first); a short query keeps the page its title names; Vietnamese words count; Jev off is the
// search's own order, and a Jev failure keeps that order and says so, in the log and in what wiki_query answers.
import { type App, cleanUp, openApp, owner, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { excerpt, fold, tellingWords, titleWords } from "../src/server/para.ts";

type Question = { instructions: string };
/** What the fake Jev was asked: the query, and the notes (each page's title line). */
const asked: { query: string; titles: string[] }[] = [];
/** How the fake OpenRouter answers decisions now. */
let mode: "judge" | "402" = "judge";
/**
 * The fake Jev's judgement: the words that make a page right for a query (in its title line, or anywhere in what Jev
 * reads of it), and the score for a bare keyword.
 */
const RIGHT: [RegExp, string, number, "title" | "note"][] = [
    [/printer/i, "Office printer", 0.93, "title"],
    [/đối tác|dong a|đông á/i, "Đông Á", 0.95, "title"],
    [/^zalo$/i, "Zalo", 0.42, "title"],
    [/trial cluster/i, "dw-aks-np-trial-eastus-provisioning", 0.9, "note"],
];
const lines: string[] = [];

const fakeOpenRouter = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);

    if (address.startsWith("https://openrouter.ai/api/v1/models")) {
        return Response.json({
            data: [
                { id: "typesafe/jev-1.14", name: "TypeSafe: Jev 1.14", pricing: { prompt: "0.000000042" } },
                { id: "typesafe/jev-1.13", name: "TypeSafe: Jev 1.13", pricing: { prompt: "0.000000042" } },
                { id: "liquid/d1", name: "LiquidAI: d1", pricing: { prompt: "0.00000002" } },
            ],
        });
    }

    assert.equal(address, "https://openrouter.ai/api/alpha/decisions");

    if (mode === "402") {
        return Response.json({ error: { message: "Insufficient credits" } }, { status: 402 });
    }

    const body = JSON.parse(String(init?.body)) as { state: { query: string }; questions: Record<string, Question> };
    const notes = Object.values(body.questions).map((question) => /"""\n([\s\S]*?)\n"""/.exec(question.instructions)?.[1] ?? "");
    const titles = notes.map((note) => note.split("\n")[0] ?? "");
    const rule = RIGHT.find(([query]) => query.test(body.state.query));

    asked.push({ query: body.state.query, titles });

    return Response.json({
        answers: Object.fromEntries(notes.map((note, index) => [`P${index}`, { noul: rule !== undefined && (rule[3] === "note" ? note : titles[index]!).includes(rule[1]) ? rule[2] : 0.12 }])),
        usage: { cost: 0.00002, input_tokens: 400 },
    });
}) as typeof fetch;

let app: App;
/** A long page's first sections: patching notes, no word of the trial cluster. */
const LONG = Array.from({ length: 40 }, (_, index) => `- Patching note ${index}: node image refresh dry run, PDBs ready, StatefulSets ready, no Warning events.`).join("\n");

const PAGES: [string, string, string][] = [
    ["resources/office-printer", "Office printer", "The printer is on the third floor of the office; paper is in the grey cabinet."],
    ["resources/door-codes", "Office door codes", "The night code opens the office door; the printer room has its own code."],
    ["areas/gui-ho-so-dong-a", "Gửi hồ sơ visa Nhật cho đối tác Đông Á", "Gửi trước 15h thứ Năm, kèm bảng kê theo mẫu Excel."],
    ["areas/quy-tac-zalo", "Quy tắc soạn tin Zalo cho khách", "Xưng em, ký tên Tiệm XuShi ở cuối tin."],
    ["areas/ca-lam-viec", "Giờ làm việc", "Thứ Hai đến thứ Bảy 8h–17h30. Trực Zalo buổi tối đến 21h."],
];

before(async () => {
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])), undefined, undefined, {
        jev: { fetch: fakeOpenRouter },
        log: (line) => lines.push(line),
    });
    await app.models.setRuntimeApiKey("openrouter", "or-test-key");

    for (const [path, title, body] of PAGES) {
        const category = path.split("/")[0]!;

        await app.para.save(path, `---\ntitle: ${title}\npara: ${category}\nscope:\n  - work\ntags: []\n---\n\n## Key facts\n\n${body}\n`, true);
    }

    // A long page of another scope whose fact is in a section added at its end (PP-361, PP-362).
    await app.para.save("projects/aks-test-cluster", `---\ntitle: "AKS test cluster: disable auto-patching"\npara: projects\nscope:\n  - psn\ntags: []\n---\n\n## Key facts\n\n${LONG}\n\n## Trial cluster for the patch step\n\n- New cluster dw-aks-np-trial-eastus-provisioning in dataweavers-aks-test, created with create-aks-resource.ps1 from main.\n`, true);

    await until(async () => (await app.para.searchKeywords("printer")).length >= 2 && (await app.para.searchKeywords("Zalo")).length >= 2, "indexed", 20_000);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("telling words keep Vietnamese syllables and leave out plain words; a short query's words are folded", () => {
    assert.deepEqual(tellingWords("gửi hồ sơ cho đối tác Đông Á").sort(), ["gửi", "hồ", "sơ", "tác", "đông", "đối"].sort());
    assert.deepEqual(tellingWords("Làm đi"), []);
    assert.deepEqual(tellingWords("ok, do it"), []);
    assert.deepEqual(tellingWords("why does the shell outlive its socket"), ["outlive", "socket", "shell"]);
    assert.deepEqual(titleWords("Zalo"), ["zalo"]);
    assert.deepEqual(titleWords("Đông Á"), ["dong"]);
    assert.equal(titleWords("where is the office printer on which floor"), undefined, "a question, not a keyword");
    assert.equal(fold("Đông Á"), "dong a");
});

test("by default with OpenRouter signed in, Jev ranks the pages that come with a message: only those that help, its cost in Spend", async () => {
    assert.deepEqual(await app.para.rerank(), { model: "typesafe/jev-1.14", chosen: undefined, default: "typesafe/jev-1.14", signedIn: true, last: null });
    const spent = app.spend.summary(owner(app)).wiki?.requests ?? 0;
    const pages = await app.para.relevant("where is the office printer, which floor", work);

    assert.deepEqual(pages.map((page) => page.path), ["resources/office-printer"], "the door codes page mentions the printer, but does not help");
    assert.equal(asked.at(-1)!.query, "where is the office printer, which floor");
    assert.ok(asked.at(-1)!.titles.includes("Office door codes"), "the door codes page was a candidate Jev read");
    assert.equal(app.spend.summary(owner(app)).wiki?.requests, spent + 1, "Jev's request is counted in Spend");

    const last = (await app.para.rerank()).last;

    assert.ok(last !== null && "kept" in last && last.kept === 1 && last.read >= 2 && last.model === "typesafe/jev-1.14", JSON.stringify(last));
});

test("a Vietnamese message finds its page by its short words; a bare keyword keeps the page its title names", async () => {
    assert.deepEqual((await app.para.relevant("gửi hồ sơ cho đối tác thế nào", work)).map((page) => page.path), ["areas/gui-ho-so-dong-a"]);
    // Jev gives the page named Zalo 0.42 for the bare word: its title keeps it; the working hours page mentions Zalo only.
    assert.deepEqual((await app.para.relevant("Zalo", work)).map((page) => page.path), ["areas/quy-tac-zalo"]);
    assert.deepEqual((await app.para.relevant("Đông Á", work)).map((page) => page.path), ["areas/gui-ho-so-dong-a"]);
});

test("wiki_query ranked by Jev: the pages that help with Jev's score, or none with the nearest named", async () => {
    const found = await app.para.query({ query: "office printer floor" }, work, true);
    const text = found.content.map((part) => part.text).join("\n");

    assert.match(text, /Ranked by Jev \(typesafe\/jev-1\.14\): 1 of the \d+ pages the search found help with the query/);
    assert.match(text, /### Result 1: Office printer \(resources\/office-printer\.md\)/);
    assert.match(text, /Score: 0\.930/);
    assert.doesNotMatch(text, /door-codes/);
    assert.equal((found.details as { rankedBy?: string }).rankedBy, "typesafe/jev-1.14");

    const none = (await app.para.query({ query: "office door night" }, work, true)).content[0]!.text;

    assert.match(none, /No wiki pages found for "office door night" in this scope \([^)]+\)\. Jev \(typesafe\/jev-1\.14\) read the \d+ the search found and judged none to help with it \(each under 0\.6\)\. Nearest: /);
});

test("Jev reads a long page's start and the lines holding the query's words, so a fact in a later section is kept (PP-361)", async () => {
    const body = `## Key facts\n\n${LONG}\n\n## Trial cluster\n\n- New cluster dw-aks-np-trial-eastus-provisioning, created with create-aks-resource.ps1.\n`;
    const read = excerpt("AKS test cluster", body, tellingWords("create-aks-resource.ps1 trial cluster"));

    assert.ok(read.startsWith("AKS test cluster\nKey facts\n- Patching note 0"), "its start");
    assert.match(read, /…\nTrial cluster\n- New cluster dw-aks-np-trial-eastus-provisioning, created with create-aks-resource\.ps1\./, "the lines holding the words, its heading too");
    assert.ok(read.length <= 2000, String(read.length));
    assert.equal(excerpt("Short", "One line."), "Short\nOne line.", "a short page whole");

    const found = (await app.para.query({ query: "create-aks-resource.ps1 trial cluster", global: true }, work, true)).content[0]!.text;

    assert.match(found, /### Result 1: AKS test cluster: disable auto-patching \(projects\/aks-test-cluster\.md\)[\s\S]*Score: 0\.900/);
});

test("a scoped wiki_query also names the good pages in other scopes, also when this scope has none (PP-362)", async () => {
    const scoped = await app.para.query({ query: "create-aks-resource.ps1 trial cluster" }, work, true);
    const text = scoped.content[0]!.text;

    assert.match(text, /^No wiki pages found for "create-aks-resource\.ps1 trial cluster" in this scope \([^)]+\)\./);
    assert.doesNotMatch(text, /may not have content/);
    assert.match(text, /## Also in other scopes \(1\)\n.*\n- projects\/aks-test-cluster: AKS test cluster: disable auto-patching \(scope: psn; Score 0\.90\)/);
    assert.equal((scoped.details as { otherScopes?: number }).otherScopes, 1);

    // In scope, and nothing elsewhere: no such section.
    assert.doesNotMatch((await app.para.query({ query: "office printer floor" }, work, true)).content[0]!.text, /Also in other scopes/);
});

test("a Jev failure keeps the search's own order and says so: in the log, in wiki_query's answer, and in Menu › Wiki", async () => {
    mode = "402";

    try {
        lines.length = 0;
        const pages = await app.para.relevant("where is the office printer, which floor", work);

        assert.ok(pages.some((page) => page.path === "resources/office-printer"), "the search's own order");
        assert.ok(lines.some((line) => /wiki pages for a message: Jev \(typesafe\/jev-1\.14\) failed: OpenRouter answered 402: Insufficient credits; the search's own order is kept/.test(line)), lines.join("\n"));

        const text = (await app.para.query({ query: "printer" }, work, true)).content.map((part) => part.text).join("\n");

        assert.match(text, /^Ranked by the search's own scores: Jev \(typesafe\/jev-1\.14\) failed: OpenRouter answered 402: Insufficient credits\. Menu › Wiki › Rank with Jev\./);
        assert.match(text, /office-printer/);

        const last = (await app.para.rerank()).last;

        assert.ok(last !== null && "error" in last && /402/.test(last.error), JSON.stringify(last));
    } finally {
        mode = "judge";
    }
});

test("Rank with Jev is a setting: a listed Jev model, off (the search's own order, no Jev asked), or the default", async () => {
    await app.setWikiRerankModel(owner(app), "typesafe/jev-1.13");
    assert.equal((await app.para.rerank()).model, "typesafe/jev-1.13");
    await app.para.relevant("where is the office printer", work);
    assert.match(lines.join("\n") + JSON.stringify((await app.para.rerank()).last), /jev-1\.13/);

    await assert.rejects(app.setWikiRerankModel(owner(app), "typesafe/jev-9"), /not one of the Jev models OpenRouter offers \(typesafe\/jev-1\.14, typesafe\/jev-1\.13\)/);
    await assert.rejects(app.setWikiRerankModel(owner(app), "liquid/d1"), /a Jev model's OpenRouter id/);

    await app.setWikiRerankModel(owner(app), "off");
    assert.equal(app.config.wikiRerankModel, null);
    const before = asked.length;
    const text = (await app.para.query({ query: "printer" }, work, true)).content.map((part) => part.text).join("\n");

    assert.doesNotMatch(text, /Ranked by/);
    assert.match(text, /office-printer/);
    assert.ok((await app.para.relevant("where is the office printer", work)).some((page) => page.path === "resources/office-printer"));
    assert.equal(asked.length, before, "Jev off: nothing asked of it");

    await app.setWikiRerankModel(owner(app), "default");
    assert.equal(app.config.wikiRerankModel, undefined);
    assert.equal((await app.para.rerank()).model, "typesafe/jev-1.14");
});
