/**
 * `image_generate` (PP-275): Pi makes and edits images with the image model the owner picked (Settings › Images,
 * `image.model`), or one it names, from the providers signed in (`image-gen.ts`). The pictures are saved where the
 * session works, on the phone or on a machine, under `images/` with a readable name and `images/latest.png`; the chat
 * shows them from those files. Pi gets their paths, the model and the cost, never the pictures themselves, so a picture
 * costs no context; it reads one with `read` when it must look.
 *
 * A picture of a real person (a photo of someone to edit, or a named person's likeness) asks the owner on a card first.
 *
 * When the session's own model can write images (OpenRouter says so, or the owner marked it), the prompt says so, and
 * says why the tool is still how to make one: Pi's model layer keeps only text, thinking and tool calls from an answer,
 * so an image a chat model writes never reaches the chat.
 */
import { Type, type Usage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { imageType } from "../image-meta.ts";
import { ASPECTS, type Aspect, CODEX_PROVIDER, type ImageInput, MAX_COUNT, MAX_INPUT_IMAGES } from "../image-gen.ts";
import { isPng, markUp } from "../markup.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
/** The most an image to edit may be. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const FOLDER = "images";

const DESCRIPTION =
    "Make or edit images with the image model the owner picked (Settings › Images, setting image.model), from a signed-in provider: ChatGPT (gpt-image-2.5), OpenRouter (Nano Banana, google/gemini-*-image, and others) or the owner's own provider. " +
    `To edit, give up to ${MAX_INPUT_IMAGES} image paths (PNG, JPEG, GIF or WebP) in images. The pictures are saved where this session works, in images/ with a readable name, the first also as images/latest.png, and show in the chat; you get their paths, the model and the cost, not the pictures: read a path to look at one. ` +
    "When the prompt or an image shows a real, identifiable person (a photo of someone, a named person's likeness), say who in person: the owner is asked on a card first. model overrides the setting for this call, one of the models the settings tool lists for image.model.";

/** The prompt's first words, as a file name: lower case ASCII, joined by `-`. */
export function slugOf(prompt: string): string {
    const words = prompt
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/gi, "d")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== "")
        .slice(0, 6)
        .join("-")
        .slice(0, 48)
        .replace(/-+$/, "");

    return words === "" ? "image" : words;
}

/** A moment as `2026-10-31-143205`, in the server's time. */
function stamp(at: Date): string {
    const two = (value: number) => String(value).padStart(2, "0");

    return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

/** A PNG's size from its header. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    return { width: view.getUint32(16), height: view.getUint32(20) };
}

const money = (amount: number) => (amount > 0 && amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`);

/** In every prompt while the module is on and the session's model can write images itself. */
export function ownModelNote(model: string): string {
    return `Images: your model (${model}) can make images itself, but this app's chat shows only the text of a model's answer (Pi's model layer keeps text, thinking and tool calls; an image in an answer is dropped). So make every image with image_generate, and pass model: "${model}" to make it with your own model rather than the image model the owner set (image.model).`;
}

export default function createImages(host: PocketHost) {
    const generate = defineTool({
        name: "image_generate",
        description: DESCRIPTION,
        parameters: Type.Object({
            prompt: Type.String({ description: "What to make, or what to change in the images" }),
            images: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_INPUT_IMAGES, description: `Images to edit: paths, absolute or relative to this session's folder (at most ${MAX_INPUT_IMAGES})` })),
            aspect: Type.Optional(Type.Union(ASPECTS.map((aspect) => Type.Literal(aspect)), { description: "Shape: 1:1, 16:9, 9:16, 4:3 or 3:4" })),
            n: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COUNT, description: `How many to make, 1 to ${MAX_COUNT} (default 1)` })),
            model: Type.Optional(Type.String({ description: "provider/model for this call only, instead of the setting image.model" })),
            person: Type.Optional(Type.String({ description: "The real person it shows or edits (a name, or 'the person in the photo'): the owner approves first" })),
        }),
        execute: async (args, api, context) => {
            const cwd = (await api.agent(context)).cwd ?? "";
            const env = host.envOf(cwd);
            const paths = args.images ?? [];

            if (paths.length > MAX_INPUT_IMAGES) {
                return reply(`At most ${MAX_INPUT_IMAGES} images to edit at once.`, true);
            }

            if (args.prompt.trim() === "") {
                return reply("Give a prompt: what to make, or what to change.", true);
            }

            let choice;

            try {
                choice = await host.images.resolve(args.model);
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            const inputs: ImageInput[] = [];

            for (const path of paths) {
                const absolute = await env.absolutePath(path, context);
                const bytes = absolute.ok ? await env.readBinaryFile(absolute.value, context) : absolute;

                if (!bytes.ok) {
                    return reply(`Could not read ${path}: ${bytes.error.message}`, true);
                }

                const mimeType = imageType(bytes.value);

                if (mimeType === undefined) {
                    return reply(`${path} is not a PNG, JPEG, GIF or WebP image.`, true);
                }

                if (bytes.value.length > MAX_INPUT_BYTES) {
                    return reply(`${path} is ${Math.round(bytes.value.length / 1024 / 1024)} MB; images to edit are at most ${MAX_INPUT_BYTES / 1024 / 1024} MB.`, true);
                }

                inputs.push({ mimeType, data: bytes.value });
            }

            // A real person's picture or likeness: the owner decides first.
            if (args.person !== undefined && args.person.trim() !== "") {
                const answer = await host.approvals.request(
                    {
                        id: `image_generate-${String(api.taskId)}-${String(api.callId)}`,
                        conversationId: api.conversationId as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "image_generate",
                        subject: args.prompt,
                        reason: `${paths.length > 0 ? `Edits ${paths.join(", ")}` : "Makes a picture"} of a real person (${args.person.trim()}) with ${choice.id}.`,
                        createdAt: Date.now(),
                    },
                    context as never,
                );

                if (!answer.allow) {
                    return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said no`}: no picture of ${args.person.trim()} was made.`, true);
                }
            }

            let made;

            try {
                made = await host.images.generate(choice, {
                    prompt: args.prompt,
                    inputs,
                    ...(args.aspect === undefined ? {} : { aspect: args.aspect as Aspect }),
                    count: args.n ?? 1,
                    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
                });
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            const folder = await env.absolutePath(FOLDER, context);

            if (!folder.ok) {
                return reply(`Cannot save in ${FOLDER}: ${folder.error.message}`, true);
            }

            const created = await env.createDir(folder.value, { recursive: true }, context);

            if (!created.ok) {
                return reply(`Could not make ${folder.value}: ${created.error.message}`, true);
            }

            const base = `${stamp(new Date())}-${slugOf(args.prompt)}`;
            const saved: { path: string; width: number; height: number }[] = [];

            for (const [index, image] of made.images.entries()) {
                // Saved as PNG whatever the provider sent, so latest.png is one too.
                const converted = isPng(image.data) ? { bytes: image.data, ...pngSize(image.data) } : markUp(image.data, [], { png: true });
                const path = `${folder.value}/${base}${index === 0 ? "" : `-${index + 1}`}.png`;

                for (const target of index === 0 ? [path, `${folder.value}/latest.png`] : [path]) {
                    const written = await env.writeFile(target, converted.bytes, context);

                    if (!written.ok) {
                        return reply(`Could not save ${target}: ${written.error.message}`, true);
                    }
                }

                saved.push({ path, width: converted.width, height: converted.height });
            }

            const codex = choice.provider === CODEX_PROVIDER;
            const cost = codex ? "on the ChatGPT plan (no charge in money)" : made.cost === undefined ? `cost not reported by ${choice.provider}` : `cost ${money(made.cost)}`;
            const usage: Usage | undefined = codex
                ? undefined
                : {
                      input: made.tokens.input,
                      output: made.tokens.output,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: made.tokens.input + made.tokens.output,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: made.cost ?? 0 },
                  };
            const lines = [
                `${paths.length > 0 ? "Edited" : "Made"} ${saved.length === 1 ? "1 image" : `${saved.length} images`} with ${choice.id}, ${cost}:`,
                ...saved.map((each) => `- ${each.path} (${each.width}×${each.height})`),
                `The first is also ${folder.value}/latest.png. They show in the chat; read a path to look at one.`,
                ...(made.text === "" ? [] : [`The model said: ${made.text.slice(0, 500)}`]),
            ];

            return {
                output: [{ type: "text" as const, text: lines.join("\n") }],
                details: {
                    model: choice.id,
                    images: saved,
                    latest: `${folder.value}/latest.png`,
                    ...(codex ? { plan: "chatgpt" } : made.cost === undefined ? {} : { cost: made.cost }),
                },
                ...(usage === undefined ? {} : { usage }),
            };
        },
    });

    return defineExtension({
        name: "pocket-images",
        tools: [generate],
        sections: [
            section("images", async (input) => {
                const model = input.agent.model;

                if (model === undefined) {
                    return undefined;
                }

                try {
                    return (await host.images.makesImages(model.provider, model.modelId)) ? ownModelNote(`${model.provider}/${model.modelId}`) : undefined;
                } catch (error) {
                    return `Images: whether your model can make images itself is not known now (${error instanceof Error ? error.message : String(error)}). Make images with image_generate.`;
                }
            }),
        ],
    });
}
