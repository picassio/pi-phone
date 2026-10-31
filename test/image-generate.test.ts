// image_generate (PP-275, src/server/image-gen.ts, extensions/images.ts): Pi makes and edits images with the model the
// owner picked (image.model) from the providers signed in. Stand-ins for ChatGPT's Codex images endpoint and for
// OpenRouter's model list and chat completions answer here. The images are saved in the session's folder (images/ and
// images/latest.png), the chat shows them from those files, and Pi gets paths, the model and the cost, never the pictures.
// OpenRouter's cost goes into the session's spend; ChatGPT's images are a count on the plan. A real person's picture asks
// first. The setting lists the signed-in image models, changes on a card, and a call may name another.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { UsageDoc } from "@earendil-works/pi-durable";
import createImages, { ownModelNote, slugOf } from "../src/server/extensions/images.ts";
import { ImageGen, openRouterImageModels } from "../src/server/image-gen.ts";
import { pathsOf } from "../src/server/extensions/secrets.ts";

/** A picture of one colour, as a PNG or a JPEG. */
const picture = (width: number, height: number, png: boolean, value = 200) => {
    const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as {
        PhotonImage: new (raw: Uint8Array, width: number, height: number) => { get_bytes(): Uint8Array; get_bytes_jpeg(quality: number): Uint8Array; free(): void };
    };
    const image = new photon.PhotonImage(new Uint8Array(width * height * 4).fill(value), width, height);

    try {
        return Buffer.from(png ? image.get_bytes() : image.get_bytes_jpeg(80));
    } finally {
        image.free();
    }
};
const CODEX_PNG = picture(24, 16, true, 120);
const OPENROUTER_JPEG = picture(20, 20, false, 60);
const PHOTO = picture(10, 10, true, 30);
/** A Codex token as ChatGPT signs one: its claim names the account. */
const CODEX_TOKEN = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-42" } })).toString("base64url")}.y`;
const NANO = "google/gemini-2.5-flash-image";

type Seen = { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };
const seen: Seen[] = [];
let failOpenRouter = false;
/** ChatGPT's images endpoint and OpenRouter's API, as far as image_generate uses them. */
const stub = createServer((request, response) => {
    let raw = "";

    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
        const path = request.url ?? "";

        if (path === "/api/v1/models") {
            response.end(
                JSON.stringify({
                    data: [
                        { id: "anthropic/claude-x", name: "Claude", architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000003" } },
                        { id: NANO, name: "Google: Nano Banana", architecture: { output_modalities: ["image", "text"] }, pricing: { prompt: "0.0000003", completion: "0.0000025", image_output: "0.00003" } },
                        { id: "openrouter/auto", name: "Auto", architecture: { output_modalities: ["text", "image"] }, pricing: { prompt: "-1", completion: "-1" } },
                    ],
                }),
            );

            return;
        }

        seen.push({ path, headers: request.headers, body: JSON.parse(raw) as Record<string, unknown> });

        if (path === "/codex/images/generations" || path === "/codex/images/edits") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ b64_json: CODEX_PNG.toString("base64") }], background: "opaque", size: "1536x1024", usage: { input_tokens: 18, output_tokens: 343 } }));

            return;
        }

        if (path === "/api/v1/chat/completions") {
            if (failOpenRouter) {
                response.statusCode = 402;
                response.end(JSON.stringify({ error: { message: "Insufficient credits" } }));

                return;
            }

            response.end(
                JSON.stringify({
                    choices: [{ message: { role: "assistant", content: "Here it is.", images: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${OPENROUTER_JPEG.toString("base64")}` } }] } }],
                    usage: { prompt_tokens: 120, completion_tokens: 1290, cost: 0.0387 },
                }),
            );

            return;
        }

        response.statusCode = 404;
        response.end("{}");
    });
});

const calls: Record<string, Record<string, unknown>> = {
    "draw a boat": { prompt: "A red paper boat on calm water", aspect: "16:9" },
    "edit the photos": { prompt: "Make the sky purple", images: ["photo.png", join(work, "photo2.png")], model: `openrouter/${NANO}`, aspect: "1:1", n: 2 },
    "an unknown model": { prompt: "A cat", model: "openrouter/nope/none" },
    "edit Tuan's photo": { prompt: "Give him a hat", images: ["photo.png"], person: "Tuan, in the photo" },
    "a picture again": { prompt: "A small blue kite" },
};
const toolResults: { images: number; text: string }[] = [];
/** The system prompt of the newest request. */
let system = "";
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    system = JSON.stringify((request as { messages: { role: string; sections?: Record<string, string> }[] }).messages.filter((message) => message.role === "system").map((message) => message.sections ?? {}));
    const last = (request as { messages: { role: string; content?: unknown }[] }).messages.at(-1);

    if (last?.role === "toolResult" && Array.isArray(last.content)) {
        toolResults.push({ images: (last.content as { type: string }[]).filter((part) => part.type === "image").length, text });
    }

    for (const [ask, args] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall("image_generate", args as never)], { stopReason: "toolUse" });
        }
    }

    if (role === "user" && text.endsWith("use nano banana")) {
        return fauxAssistantMessage([fauxToolCall("setting_change", { id: "image.model", value: `openrouter/${NANO}`, reason: "The owner likes it" })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("list image settings")) {
        return fauxAssistantMessage([fauxToolCall("settings", { area: "images" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text.slice(0, 4000)}` : "ok")]);
};
let app: App;
let base = "";

before(async () => {
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    // The ChatGPT sign-in stood in as voice's tests do; OpenRouter's key as the app keeps one.
    app = await openApp(scriptedModel(route), undefined, undefined, {
        images: { endpoints: { codex: `${base}/codex`, openRouter: `${base}/api/v1` }, codexAuth: async () => ({ token: CODEX_TOKEN }) },
    });
    await app.models.setRuntimeApiKey("openrouter", "or-test-key");
    writeFileSync(join(work, "photo.png"), PHOTO);
    writeFileSync(join(work, "photo2.png"), PHOTO);
});

after(async () => {
    await app?.close();
    stub.close();
    cleanUp();
});

/** One turn; with `answer`, the card it waits on is answered so. */
async function turn(id: number, text: string, answer?: boolean): Promise<{ said: string; card?: { subject: string; reason?: string } }> {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });
    let card: { subject: string; reason?: string } | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card");
        const asked = app.approvals.forConversation(id as never)[0]!;

        card = { subject: asked.subject, ...(asked.reason === undefined ? {} : { reason: asked.reason }) };
        await app.answerApproval(asked.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return { said: (await modelTexts(app, id as never)).at(-1)!, ...(card === undefined ? {} : { card }) };
}

/** The newest image_generate result as the chat gets it. */
async function lastResult(id: number) {
    const entries = await app.transcripts.allEntries(id as never, true);
    const result = entries.filter((entry) => entry.kind === "toolResult").at(-1) as unknown as { details?: { model: string; images: { path: string; width: number; height: number }[]; latest: string; cost?: number; plan?: string }; images?: number; isError?: boolean };

    return result;
}

test("the setting lists the image models of the providers signed in, ChatGPT's first, with OpenRouter's prices; the default is ChatGPT's", async () => {
    const { models, problems } = await app.images.models();

    assert.deepEqual(problems, []);
    assert.deepEqual(
        models.map((model) => model.id),
        ["openai-codex/gpt-image-2.5", `openrouter/${NANO}`],
        "image models only, the router with no set price left out",
    );
    assert.deepEqual(models[1]!.price, { imageOut: 30, input: 0.3 });
    assert.equal(ImageGen.defaultOf(models)?.id, "openai-codex/gpt-image-2.5");
    assert.equal(app.config.imageModel, null);
});

test("generate with the ChatGPT sign-in: Codex's request, the file saved under images/ with latest.png, shown in the chat, and Pi gets paths, not pictures", async () => {
    const id = await newSession(app);
    const before = seen.length;
    const { said } = await turn(id, "draw a boat");
    const request = seen.slice(before);

    assert.equal(request.length, 1);
    assert.equal(request[0]!.path, "/codex/images/generations");
    assert.equal(request[0]!.headers.authorization, `Bearer ${CODEX_TOKEN}`);
    assert.equal(request[0]!.headers["chatgpt-account-id"], "acct-42");
    assert.equal(request[0]!.headers.originator, "codex_cli_rs");
    assert.deepEqual({ ...request[0]!.body, prompt: undefined }, { prompt: undefined, model: "gpt-image-2.5", background: "opaque", quality: "auto", size: "auto" });
    assert.equal(request[0]!.body.prompt, "A red paper boat on calm water\n\nAspect ratio 16:9.");

    const images = readdirSync(join(work, "images"));
    const made = images.find((name) => /^\d{4}-\d\d-\d\d-\d{6}-a-red-paper-boat-on-calm\.png$/.test(name));

    assert.ok(made, images.join(", "));
    assert.deepEqual(readFileSync(join(work, "images", made)), CODEX_PNG);
    assert.deepEqual(readFileSync(join(work, "images", "latest.png")), CODEX_PNG);

    // Pi's result: text only, the path, model and where it is paid; no picture, no base64.
    const told = toolResults.at(-1)!;

    assert.equal(told.images, 0);
    assert.match(told.text, new RegExp(`Made 1 image with openai-codex/gpt-image-2\\.5, on the ChatGPT plan`));
    assert.match(told.text, new RegExp(join(work, "images", made).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(!said.includes(CODEX_PNG.toString("base64").slice(0, 40)), "no base64 in Pi's context");

    // The chat: the result carries the saved files, which the session's file route serves.
    const result = await lastResult(id);

    assert.equal(result.images ?? 0, 0);
    assert.equal(result.details?.model, "openai-codex/gpt-image-2.5");
    assert.equal(result.details?.plan, "chatgpt");
    assert.deepEqual(result.details?.images, [{ path: join(work, "images", made), width: 24, height: 16 }]);
    assert.equal(app.workspace.conversationFile(owner(app), id as never, result.details!.images[0]!.path), join(work, "images", made));

    // Counted on the plan, not in money.
    await app.spend.voiceStored();
    assert.deepEqual(app.spend.summary(owner(app)).images, { today: 1, month: 1 });
    assert.equal(app.spend.sessionSpent(id as never), 0);
});

test("edit with OpenRouter (the call's own model): the input images as image_url parts, two images, its cost in the session's spend", async () => {
    const id = await newSession(app);
    const before = seen.length;

    await turn(id, "edit the photos");

    const requests = seen.slice(before);

    assert.equal(requests.length, 2, "n: 2 is two requests");

    for (const request of requests) {
        assert.equal(request.path, "/api/v1/chat/completions");
        assert.equal(request.headers.authorization, "Bearer or-test-key");
        assert.equal(request.body.model, NANO);
        assert.deepEqual(request.body.modalities, ["image", "text"]);
        assert.deepEqual(request.body.image_config, { aspect_ratio: "1:1" });

        const content = (request.body.messages as { content: { type: string; text?: string; image_url?: { url: string } }[] }[])[0]!.content;

        assert.deepEqual(content[0], { type: "text", text: "Make the sky purple" });
        assert.deepEqual(
            content.slice(1).map((part) => part.image_url?.url),
            [`data:image/png;base64,${PHOTO.toString("base64")}`, `data:image/png;base64,${PHOTO.toString("base64")}`],
        );
    }

    const result = await lastResult(id);

    assert.equal(result.details?.model, `openrouter/${NANO}`);
    assert.equal(result.details?.images.length, 2);
    assert.ok(Math.abs((result.details?.cost ?? 0) - 0.0774) < 1e-9);

    // The JPEG OpenRouter sent is saved as a PNG, the second with -2.
    for (const [index, image] of result.details!.images.entries()) {
        assert.match(image.path, index === 0 ? /make-the-sky-purple\.png$/ : /make-the-sky-purple-2\.png$/);
        assert.equal(readFileSync(image.path).subarray(1, 4).toString(), "PNG");
        assert.deepEqual([image.width, image.height], [20, 20]);
    }

    const told = toolResults.at(-1)!;

    assert.equal(told.images, 0);
    assert.match(told.text, /Edited 2 images with openrouter\/google\/gemini-2\.5-flash-image, cost \$0\.08/);
    assert.match(told.text, /The model said: Here it is\./);

    // In the session's spend, as the result's usage.
    const usage = await app.harness.snapshot(UsageDoc, id as never, context);

    assert.ok(Math.abs((usage?.tools?.image_generate?.cost.total ?? 0) - 0.0774) < 1e-9, JSON.stringify(usage?.tools));
    await until(() => Math.abs(app.spend.sessionSpent(id as never) - 0.0774) < 1e-9, "the session's spend");
});

test("a model that is not one of the signed-in image models fails, naming the setting; a provider's error names the provider and the setting", async () => {
    const id = await newSession(app);
    const unknown = (await turn(id, "an unknown model")).said;

    assert.match(unknown, /The image model openrouter\/nope\/none is not one of the image models signed in now: openai-codex\/gpt-image-2\.5, openrouter\/google\/gemini-2\.5-flash-image\. Change it in Settings › Images \(setting image\.model\)/);

    failOpenRouter = true;

    try {
        const failed = (await turn(id, "edit the photos")).said;

        assert.match(failed, /OpenRouter failed to make an image with openrouter\/google\/gemini-2\.5-flash-image \(HTTP 402: Insufficient credits\)\. Another image model: Settings › Images \(setting image\.model\)/);
    } finally {
        failOpenRouter = false;
    }
});

test("a real person's picture asks the owner on a card first; a no makes nothing", async () => {
    const id = await newSession(app);
    const before = seen.length;
    const no = await turn(id, "edit Tuan's photo", false);

    assert.equal(no.card?.subject, "Give him a hat");
    assert.match(no.card?.reason ?? "", /Edits photo\.png of a real person \(Tuan, in the photo\) with openai-codex\/gpt-image-2\.5/);
    assert.match(no.said, /said no: no picture of Tuan, in the photo was made/);
    assert.equal(seen.length, before, "nothing sent");

    await turn(id, "edit Tuan's photo", true);
    assert.equal(seen.at(-1)?.path, "/codex/images/edits");
    assert.deepEqual(seen.at(-1)?.body.images, [{ image_url: `data:image/png;base64,${PHOTO.toString("base64")}` }]);
});

test("Pi changes image.model on a card, listed with its choices; the tool then uses it", async () => {
    const id = await newSession(app);
    const listed = (await turn(id, "list image settings")).said;

    assert.match(listed, /image\.model: auto \(now openai-codex\/gpt-image-2\.5\)/);
    assert.match(listed, /openrouter\/google\/gemini-2\.5-flash-image \(\$30\/M image tokens\)/);

    const changed = await turn(id, "use nano banana", true);

    assert.match(changed.card?.subject ?? "", /auto \(now openai-codex\/gpt-image-2\.5\) → openrouter\/google\/gemini-2\.5-flash-image/);
    assert.equal(app.config.imageModel, `openrouter/${NANO}`);

    const before = seen.length;

    await turn(id, "a picture again");
    assert.equal(seen.slice(before)[0]?.path, "/api/v1/chat/completions");
    assert.equal((await lastResult(id)).details?.model, `openrouter/${NANO}`);

    await assert.rejects(app.setImageModel(owner(app), "openrouter/nope"), /openrouter\/nope is not an image model of a provider signed in now/);
    await app.setImageModel(owner(app), null);
    assert.equal(app.config.imageModel, null);
});

test("the prompt tells Pi when the session's own model can make images, and why image_generate is still how to make one", async () => {
    // The section, with the OpenRouter list above: Nano Banana writes images, Claude does not.
    const extension = createImages({ images: app.images } as never);
    const section = extension.sections![0]!;
    const render = (provider: string, modelId: string) => section.render({ agent: { model: { provider, modelId } } } as never, context);

    assert.equal(await render("openrouter", NANO), ownModelNote(`openrouter/${NANO}`));
    assert.match(ownModelNote("openrouter/x"), /only the text of a model's answer.*an image in an answer is dropped.*image_generate.*model: "openrouter\/x"/s);
    assert.equal(await render("openrouter", "anthropic/claude-x"), undefined);
    assert.equal(await render("faux", "faux-1"), undefined);
    assert.equal(await app.images.makesImages("openrouter", NANO), true);

    // A session on a model that does not write images hears nothing of it.
    const id = await newSession(app);

    await turn(id, "hello");
    assert.match(system, /"seeing"/, "the prompt's sections were seen");
    assert.ok(!system.includes("can make images itself"));
});

test("OpenRouter's list keeps image models only, priced per million tokens; a file name is the prompt's first words", () => {
    assert.deepEqual(
        openRouterImageModels({ data: [{ id: "a/b", architecture: { output_modalities: ["image"] }, pricing: { image_output: "0.00012" } }, { id: "c/d", architecture: { output_modalities: ["text"] } }] }),
        [{ id: "a/b", name: "a/b", text: false, price: { imageOut: 120 } }],
    );
    assert.equal(slugOf("Một con thuyền giấy đỏ, trên mặt nước!"), "mot-con-thuyen-giay-do-tren");
    assert.equal(slugOf("!!!"), "image");
    // The images to edit are files the call reads: the app's key stores stay out of reach.
    assert.deepEqual(pathsOf("image_generate", { prompt: "x", images: ["a.png", "/b.png"] }), { read: ["a.png", "/b.png"], write: [] });
    assert.ok(existsSync(work));
});
