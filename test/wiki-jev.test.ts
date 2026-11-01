// The wiki's search ranked by Jev (PP-312): the pages that come with a message and wiki_query keep what Jev judges to
// help (at least 0.6, best first); a short query keeps the page its title names; Vietnamese words count; Jev off is the
// search's own order, and a Jev failure keeps that order and says so, in the log and in what wiki_query answers.
import { type App, cleanUp, openApp, owner, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { fold, tellingWords, titleWords } from "../src/server/para.ts";

type Question = { instructions: string };
/** What the fake Jev was asked: the query, and the notes (each page's title line). */
const asked: { query: string; titles: string[] }[] = [];
/** How the fake OpenRouter answers decisions now. */
let mode: "judge" | "402" = "judge";
/** The fake Jev's judgement: the title words that make a page right for a query, and the score for a bare keyword. */
const RIGHT: [RegExp, string, number][] = [
    [/printer/i, "Office printer", 0.93],
    [/đối tác|dong a|đông á/i, "Đông Á", 0.95],
    [/^zalo$/i, "Zalo", 0.42],
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
    const titles = Object.values(body.questions).map((question) => /"""\n(.*)\n/.exec(question.instructions)?.[1] ?? "");
    const rule = RIGHT.find(([query]) => query.test(body.state.query));

    asked.push({ query: body.state.query, titles });

    return Response.json({
        answers: Object.fromEntries(titles.map((title, index) => [`P${index}`, { noul: rule !== undefined && title.includes(rule[1]) ? rule[2] : 0.12 }])),
        usage: { cost: 0.00002, input_tokens: 400 },
    });
}) as typeof fetch;

let app: App;

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

    assert.match(none, /No wiki pages found for "office door night"\. Jev \(typesafe\/jev-1\.14\) read the \d+ the search found and judged none to help with it \(each under 0\.6\)\. Nearest: /);
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
