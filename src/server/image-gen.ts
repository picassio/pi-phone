/**
 * Image generation and editing (PP-275): the `image_generate` tool's providers, the models they offer, and the setting
 * that picks one (`image.model`, Settings › Images). No model runs here: every image comes from a remote provider.
 *
 * - **ChatGPT (Codex) sign-in**: `POST <codex>/images/generations`, or `/images/edits` with up to five input images as
 *   data URLs, model `gpt-image-2.5`, as Codex itself asks. Ported from pi-codex-imagegen by Igor Warzocha (MIT,
 *   github.com/IgorWarzocha/howaboua-pi-stuff, `packages/pi-codex-imagegen/src/request.ts`, `execute.ts`,
 *   `codex-runtime/headers.ts`). It answers `{ data: [{ b64_json }] }` and takes no size (checked live 2026-10-31: a
 *   1024x1024 request came back 1536x1024), so the aspect goes in the prompt. Counted on the ChatGPT plan, not in money.
 * - **OpenRouter**: `POST /api/v1/chat/completions` with `modalities` and `image_config.aspect_ratio`; the images come
 *   back as data URLs in the message's `images`, and `usage.cost` says what it cost. The models are those of
 *   `GET /api/v1/models` whose `architecture.output_modalities` include "image" (Nano Banana is `google/gemini-*-image`).
 * - **OpenAI-compatible providers** (Settings › Providers, PP-248): only a model marked "makes images" there, through the
 *   same chat-completions shape as OpenRouter, the aspect in the prompt.
 *
 * The default, when the owner picked none, is the Codex model when the ChatGPT sign-in is there, else OpenRouter's first
 * image model, else none: then the tool fails, saying to set up a provider.
 */
import { HttpError } from "./errors.ts";
import { imageType } from "./image-meta.ts";
import { chatgptAccount } from "./voice.ts";

export const CODEX_PROVIDER = "openai-codex";
export const CODEX_IMAGE_MODEL = "gpt-image-2.5";
export const OPENROUTER = "openrouter";
export const ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
export type Aspect = (typeof ASPECTS)[number];
/** Codex's and the tool's limit on images to edit at once. */
export const MAX_INPUT_IMAGES = 5;
export const MAX_COUNT = 4;
/** Where the setting is, for errors. */
export const SETTING_HINT = "Settings › Images (setting image.model)";

const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
/** As pi-codex-imagegen sends it (`codex-runtime/types.ts`). */
const CODEX_ORIGINATOR = "codex_cli_rs";
/** How long OpenRouter's model list is kept before it is asked again. */
const LIST_MS = 60 * 60 * 1000;
/** An image takes a while: OpenRouter's own example took 94 s. */
const MAKE_MS = 5 * 60 * 1000;

/** One model that makes images, as the picker and the tool list it. */
export type ImageModelChoice = {
    /** `provider/model`, the setting's value. */
    id: string;
    provider: string;
    model: string;
    name: string;
    /** OpenRouter's prices, dollars per million tokens: image tokens out, and text in. */
    price?: { imageOut?: number; input?: number };
    /** Whether the model answers with text beside its images (OpenRouter's output_modalities). */
    text: boolean;
};

export type ImageInput = { mimeType: string; data: Uint8Array };

export type MadeImages = {
    choice: ImageModelChoice;
    images: { mimeType: string; data: Uint8Array }[];
    /** Dollars, when the provider said; undefined on the ChatGPT plan or when a provider does not say. */
    cost: number | undefined;
    tokens: { input: number; output: number };
    /** What the model wrote beside its images, if anything. */
    text: string;
};

/** A provider of the owner's own (Settings › Providers), with the models marked as making images. */
export type CustomImageProvider = { id: string; name: string; baseUrl: string; headers: { name: string; value: string }[]; models: string[] };

type OpenRouterModel = { id: string; name: string; text: boolean; price?: { imageOut?: number; input?: number } };

export type ImageGenOptions = {
    /** The ChatGPT sign-in's token and account, or undefined when there is none. */
    codexAuth(): Promise<{ token: string; account?: string } | undefined>;
    /** The OpenRouter sign-in's key, or undefined. */
    openRouterKey(): Promise<string | undefined>;
    /** The owner's OpenAI-compatible providers Pi can use now, and their key (undefined: none, as for a local server). */
    custom(): CustomImageProvider[];
    customKey(id: string): Promise<string | undefined>;
    /** The owner's choice, provider/model, or null for the default. */
    setting(): string | null;
    /** Images made on the ChatGPT plan: counted in Spend, not in money. */
    codexMade(count: number): void;
    endpoints?: { codex?: string; openRouter?: string };
    fetch?: typeof fetch;
    now?: () => number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Dollars per token as OpenRouter writes it ("0.00003"), as dollars per million tokens; undefined for none or "-1". */
function perMillion(value: unknown): number | undefined {
    const number = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;

    return Number.isFinite(number) && number > 0 ? Math.round(number * 1e6 * 1e4) / 1e4 : undefined;
}

/** The image models of OpenRouter's `GET /models` answer, in its order; routers with no set price ("-1") left out. */
export function openRouterImageModels(answer: unknown): OpenRouterModel[] {
    const data = isRecord(answer) && Array.isArray(answer.data) ? answer.data : [];

    return data.flatMap((each): OpenRouterModel[] => {
        if (!isRecord(each) || typeof each.id !== "string") {
            return [];
        }

        const architecture = isRecord(each.architecture) ? each.architecture : {};
        const output = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
        const pricing = isRecord(each.pricing) ? each.pricing : {};

        if (!output.includes("image") || pricing.prompt === "-1") {
            return [];
        }

        const imageOut = perMillion(pricing.image_output);
        const input = perMillion(pricing.prompt);

        return [
            {
                id: each.id,
                name: typeof each.name === "string" && each.name !== "" ? each.name : each.id,
                text: output.includes("text"),
                ...(imageOut === undefined && input === undefined ? {} : { price: { ...(imageOut === undefined ? {} : { imageOut }), ...(input === undefined ? {} : { input }) } }),
            },
        ];
    });
}

/** `data:<mime>;base64,<data>` as bytes; undefined for anything else. */
function fromDataUrl(url: unknown): { mimeType: string; data: Uint8Array } | undefined {
    const match = typeof url === "string" ? /^data:([^;,]+);base64,(.+)$/s.exec(url) : null;

    if (match === null) {
        return undefined;
    }

    const data = Buffer.from(match[2]!, "base64");

    return data.length === 0 ? undefined : { mimeType: imageType(data) ?? match[1]!, data };
}

const dataUrl = (image: ImageInput) => `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`;

/** The prompt with the aspect asked for in words, for providers that take no aspect of their own. */
const withAspect = (prompt: string, aspect: Aspect | undefined) => (aspect === undefined ? prompt : `${prompt}\n\nAspect ratio ${aspect}.`);

/** A provider's error as a short line: its message when it says one. */
function providerError(status: number, text: string): string {
    try {
        const body = JSON.parse(text) as unknown;
        const error = isRecord(body) ? body.error : undefined;
        const message = isRecord(error) ? error.message : isRecord(body) ? (body.detail ?? body.message) : undefined;

        if (typeof message === "string" && message !== "") {
            return `HTTP ${status}: ${message.slice(0, 300)}`;
        }
    } catch {
        // not JSON: the status alone
    }

    return `HTTP ${status}`;
}

export class ImageGen {
    readonly #options: ImageGenOptions;
    readonly #fetch: typeof fetch;
    #list: { at: number; models: OpenRouterModel[] } | undefined;

    constructor(options: ImageGenOptions) {
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
    }

    get #codexBase(): string {
        return this.#options.endpoints?.codex ?? CODEX_BASE;
    }

    get #openRouterBase(): string {
        return this.#options.endpoints?.openRouter ?? OPENROUTER_BASE;
    }

    /** OpenRouter's image models, kept an hour; a failed ask is not kept, and fails. */
    async #openRouterModels(): Promise<OpenRouterModel[]> {
        const now = (this.#options.now ?? Date.now)();

        if (this.#list !== undefined && now - this.#list.at < LIST_MS) {
            return this.#list.models;
        }

        const response = await this.#fetch(`${this.#openRouterBase}/models`, { signal: AbortSignal.timeout(20_000) });

        if (!response.ok) {
            throw new Error(`OpenRouter's model list answered ${response.status}.`);
        }

        const models = openRouterImageModels(await response.json());

        this.#list = { at: now, models };

        return models;
    }

    /**
     * Every image model of the providers signed in now, ChatGPT's first, then OpenRouter's in its order, then the owner's
     * own. A provider whose list cannot be read is a problem, said beside the list.
     */
    async models(): Promise<{ models: ImageModelChoice[]; problems: string[] }> {
        const models: ImageModelChoice[] = [];
        const problems: string[] = [];

        if ((await this.#options.codexAuth()) !== undefined) {
            models.push({ id: `${CODEX_PROVIDER}/${CODEX_IMAGE_MODEL}`, provider: CODEX_PROVIDER, model: CODEX_IMAGE_MODEL, name: "GPT Image 2.5 (ChatGPT sign-in)", text: false });
        }

        if ((await this.#options.openRouterKey()) !== undefined) {
            try {
                for (const each of await this.#openRouterModels()) {
                    models.push({ id: `${OPENROUTER}/${each.id}`, provider: OPENROUTER, model: each.id, name: each.name, text: each.text, ...(each.price === undefined ? {} : { price: each.price }) });
                }
            } catch (error) {
                problems.push(error instanceof Error ? error.message : String(error));
            }
        }

        for (const provider of this.#options.custom()) {
            for (const model of provider.models) {
                models.push({ id: `${provider.id}/${model}`, provider: provider.id, model, name: `${model} (${provider.name})`, text: true });
            }
        }

        return { models, problems };
    }

    /** The default when the owner picked none: Codex's, else OpenRouter's first, else none. */
    static defaultOf(models: readonly ImageModelChoice[]): ImageModelChoice | undefined {
        return models.find((each) => each.provider === CODEX_PROVIDER) ?? models.find((each) => each.provider === OPENROUTER);
    }

    /**
     * The model a request uses: `asked` (the tool's `model`), else the owner's setting, else the default. It must be one
     * of the models listed now; the error says where to change it.
     */
    async resolve(asked?: string): Promise<ImageModelChoice> {
        const { models, problems } = await this.models();
        const chosen = asked ?? this.#options.setting();
        const why = problems.length === 0 ? "" : ` (${problems.join(" ")})`;

        if (chosen === null) {
            const found = ImageGen.defaultOf(models);

            if (found === undefined) {
                throw new Error(`No image model: sign in to ChatGPT or OpenRouter in Settings › Providers, or mark a model of your own provider as making images there; then pick one in ${SETTING_HINT}.${why}`);
            }

            return found;
        }

        const found = models.find((each) => each.id === chosen);

        if (found === undefined) {
            const source = asked === undefined ? `The image model ${chosen} (${SETTING_HINT})` : `The image model ${chosen}`;

            throw new Error(`${source} is not one of the image models signed in now: ${models.map((each) => each.id).join(", ") || "none"}. Change it in ${SETTING_HINT}.${why}`);
        }

        return found;
    }

    /** Check a setting's value before it is kept: null (the default) or a model listed now. */
    async check(model: string | null): Promise<string | null> {
        if (model === null) {
            return null;
        }

        const { models } = await this.models();

        if (!models.some((each) => each.id === model)) {
            throw new HttpError(400, `${model} is not an image model of a provider signed in now. Pick one of: ${models.map((each) => each.id).join(", ") || "none (sign in to ChatGPT or OpenRouter first)"}.`);
        }

        return model;
    }

    /**
     * Whether a chat model can write images in its answer, as its provider says: OpenRouter's list for an OpenRouter
     * model, the owner's mark for one of their providers. Pi's other providers say nothing of output, so: no.
     */
    async makesImages(provider: string, modelId: string): Promise<boolean> {
        if (provider === OPENROUTER) {
            if ((await this.#options.openRouterKey()) === undefined) {
                return false;
            }

            return (await this.#openRouterModels()).some((each) => each.id === modelId);
        }

        return this.#options.custom().some((each) => each.id === provider && each.models.includes(modelId));
    }

    /** Make `count` images (one request each) with `choice`, from `inputs` when given (an edit). */
    async generate(choice: ImageModelChoice, request: { prompt: string; inputs: ImageInput[]; aspect?: Aspect; count: number; signal?: AbortSignal }): Promise<MadeImages> {
        if (request.inputs.length > MAX_INPUT_IMAGES) {
            throw new Error(`At most ${MAX_INPUT_IMAGES} images to edit at once.`);
        }

        const made: MadeImages = { choice, images: [], cost: choice.provider === CODEX_PROVIDER ? undefined : 0, tokens: { input: 0, output: 0 }, text: "" };

        for (let index = 0; index < request.count; index++) {
            const one = choice.provider === CODEX_PROVIDER ? await this.#codex(request) : await this.#chat(choice, request);

            made.images.push(...one.images);
            made.tokens.input += one.tokens.input;
            made.tokens.output += one.tokens.output;
            made.text = [made.text, one.text].filter((each) => each !== "").join("\n");

            if (made.cost !== undefined) {
                made.cost = one.cost === undefined ? undefined : made.cost + one.cost;
            }

            if (choice.provider === CODEX_PROVIDER) {
                this.#options.codexMade(one.images.length);
            }
        }

        return made;
    }

    /** One request to Codex's images endpoint, as pi-codex-imagegen makes it. */
    async #codex(request: { prompt: string; inputs: ImageInput[]; aspect?: Aspect; signal?: AbortSignal }) {
        const auth = await this.#options.codexAuth();

        if (auth === undefined) {
            throw new Error(`ChatGPT is not signed in: sign in to ChatGPT (Codex) in Settings › Providers, or pick another image model in ${SETTING_HINT}.`);
        }

        const account = auth.account ?? chatgptAccount(auth.token);

        if (account === undefined) {
            throw new Error(`The ChatGPT sign-in has no account id: sign in to ChatGPT (Codex) again in Settings › Providers, or pick another image model in ${SETTING_HINT}.`);
        }

        const edit = request.inputs.length > 0;
        const body = {
            ...(edit ? { images: request.inputs.map((image) => ({ image_url: dataUrl(image) })) } : {}),
            prompt: withAspect(request.prompt, request.aspect),
            model: CODEX_IMAGE_MODEL,
            background: "opaque",
            quality: "auto",
            size: "auto",
        };
        const platform = process.platform === "darwin" ? "Mac OS" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : process.platform;
        const response = await this.#fetch(`${this.#codexBase}/images/${edit ? "edits" : "generations"}`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${auth.token}`,
                "chatgpt-account-id": account,
                originator: CODEX_ORIGINATOR,
                "user-agent": `${CODEX_ORIGINATOR}/0.0.0 (${platform} unknown; ${process.arch}) pi-phone`,
                version: "0.0.0",
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.any([AbortSignal.timeout(MAKE_MS), ...(request.signal === undefined ? [] : [request.signal])]),
        });
        const text = await response.text();

        if (response.status === 401 || response.status === 403) {
            throw new Error(`ChatGPT refused the image request (${providerError(response.status, text)}): sign in to ChatGPT (Codex) again in Settings › Providers, or pick another image model in ${SETTING_HINT}.`);
        }

        if (!response.ok) {
            throw new Error(`ChatGPT's image endpoint failed (${providerError(response.status, text)}) with ${CODEX_PROVIDER}/${CODEX_IMAGE_MODEL}. Another image model: ${SETTING_HINT}.`);
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error("ChatGPT's image endpoint answered with something that is not JSON.");
        }

        const data = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
        const images = data.flatMap((item) => {
            const b64 = isRecord(item) && typeof item.b64_json === "string" ? Buffer.from(item.b64_json, "base64") : undefined;
            const mimeType = b64 === undefined ? undefined : imageType(b64);

            return b64 === undefined || mimeType === undefined ? [] : [{ mimeType, data: new Uint8Array(b64) }];
        });

        if (images.length === 0) {
            throw new Error(`ChatGPT's image endpoint returned no image for ${CODEX_PROVIDER}/${CODEX_IMAGE_MODEL}.`);
        }

        const usage = isRecord(parsed) && isRecord(parsed.usage) ? parsed.usage : {};

        return {
            images,
            cost: undefined,
            tokens: { input: typeof usage.input_tokens === "number" ? usage.input_tokens : 0, output: typeof usage.output_tokens === "number" ? usage.output_tokens : 0 },
            text: "",
        };
    }

    /** One chat-completions request that asks for images: OpenRouter's, or the owner's own provider's. */
    async #chat(choice: ImageModelChoice, request: { prompt: string; inputs: ImageInput[]; aspect?: Aspect; signal?: AbortSignal }) {
        const openRouter = choice.provider === OPENROUTER;
        const custom = openRouter ? undefined : this.#options.custom().find((each) => each.id === choice.provider);
        const label = openRouter ? "OpenRouter" : (custom?.name ?? choice.provider);
        const key = openRouter ? await this.#options.openRouterKey() : await this.#options.customKey(choice.provider);

        if (openRouter && key === undefined) {
            throw new Error(`OpenRouter is not signed in: sign in to it in Settings › Providers, or pick another image model in ${SETTING_HINT}.`);
        }

        if (!openRouter && custom === undefined) {
            throw new Error(`The provider ${choice.provider} is not set up now (Settings › Providers). Pick another image model in ${SETTING_HINT}.`);
        }

        const base = openRouter ? this.#openRouterBase : custom!.baseUrl.replace(/\/+$/, "");
        const body = {
            model: choice.model,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: openRouter ? request.prompt : withAspect(request.prompt, request.aspect) },
                        ...request.inputs.map((image) => ({ type: "image_url", image_url: { url: dataUrl(image) } })),
                    ],
                },
            ],
            modalities: choice.text ? ["image", "text"] : ["image"],
            stream: false,
            ...(openRouter ? { usage: { include: true }, ...(request.aspect === undefined ? {} : { image_config: { aspect_ratio: request.aspect } }) } : {}),
        };
        const headers: Record<string, string> = {
            "content-type": "application/json",
            ...(custom === undefined ? {} : Object.fromEntries(custom.headers.map((header) => [header.name, header.value]))),
            ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
            ...(openRouter ? { "http-referer": "https://github.com/picassio/pi-phone", "x-title": "pi-phone" } : {}),
        };
        const response = await this.#fetch(`${base}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.any([AbortSignal.timeout(MAKE_MS), ...(request.signal === undefined ? [] : [request.signal])]),
        });
        const text = await response.text();

        if (!response.ok) {
            throw new Error(`${label} failed to make an image with ${choice.id} (${providerError(response.status, text)}). Another image model: ${SETTING_HINT}.`);
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error(`${label} answered with something that is not JSON.`);
        }

        const choices = isRecord(parsed) && Array.isArray(parsed.choices) ? parsed.choices : [];
        const message = isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : {};
        const said = typeof message.content === "string" ? message.content.trim() : "";
        const images = (Array.isArray(message.images) ? message.images : []).flatMap((each) => {
            const url = isRecord(each) ? (isRecord(each.image_url) ? each.image_url.url : each.image_url) : undefined;
            const image = fromDataUrl(url);

            return image === undefined ? [] : [image];
        });

        if (images.length === 0) {
            throw new Error(`${label} returned no image with ${choice.id}${said === "" ? "" : `; it said: ${said.slice(0, 400)}`}. Another image model: ${SETTING_HINT}.`);
        }

        const usage = isRecord(parsed) && isRecord(parsed.usage) ? parsed.usage : {};

        return {
            images,
            cost: typeof usage.cost === "number" ? usage.cost : undefined,
            tokens: { input: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0, output: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0 },
            text: said,
        };
    }
}
