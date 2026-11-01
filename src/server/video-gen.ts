/**
 * Videos through OpenRouter (PP-297, PP-298; PP-294's research, the owner's picks): watching one with a model that takes
 * video (`video_ask`, Gemini Flash-Lite by default), on the owner's OpenRouter key. No model runs here.
 *
 * - The models: OpenRouter's `GET /api/v1/models` with `video` in `architecture.input_modalities`, priced from
 *   `pricing.prompt` (kept an hour).
 * - Asking: `POST /api/v1/chat/completions` with the question and the video as a `video_url` part: a base64 data URL of
 *   the file (OpenRouter takes mp4, mpeg, mov and webm), or a YouTube address (Gemini on AI Studio takes those alone).
 *   The cost is `usage.cost`.
 * - The setting `video.askModel` (`config.videoAskModel`, Menu › Videos): a listed model, or null for the default
 *   (google/gemini-3.5-flash-lite). A model not listed now fails naming the setting; nothing falls back to another.
 */
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
/** The model `video_ask` watches with unless the owner picked another (PP-294: cheap, long videos, Vietnamese). */
export const DEFAULT_ASK_MODEL = "google/gemini-3.5-flash-lite";
const LIST_MS = 60 * 60 * 1000;
/** How long one question about a video may take. */
const ASK_MS = 5 * 60 * 1000;
const SETTING_HINT = "Menu › Videos (setting video.askModel)";

/** A model that watches videos, as Menu › Videos lists it. */
export type VideoAskModel = { id: string; name: string; price?: { input: number; output?: number } };

export type VideosOptions = {
    /** The OpenRouter sign-in's key, or undefined. */
    openRouterKey(): Promise<string | undefined>;
    /** The owner's model for video_ask, or null for the default. */
    askSetting(): string | null;
    endpoints?: { openRouter?: string };
    fetch?: typeof fetch;
    now?: () => number;
};

/** A video to ask about: a file's bytes and type, or a YouTube address. */
export type VideoInput = { data: Uint8Array; mimeType: string } | { url: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Dollars per token as OpenRouter writes it, as dollars per million tokens; undefined for none or "-1". */
function perMillion(value: unknown): number | undefined {
    const number = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;

    return Number.isFinite(number) && number > 0 ? Math.round(number * 1e6 * 1e4) / 1e4 : undefined;
}

/** The models of OpenRouter's `GET /models` answer that take video, in its order; routers ("-1") and free ones left out. */
export function openRouterVideoAskModels(answer: unknown): VideoAskModel[] {
    const data = isRecord(answer) && Array.isArray(answer.data) ? answer.data : [];

    return data.flatMap((each): VideoAskModel[] => {
        if (!isRecord(each) || typeof each.id !== "string" || each.id.endsWith(":free") || each.id.endsWith(":batch") || each.id.startsWith("~")) {
            return [];
        }

        const architecture = isRecord(each.architecture) ? each.architecture : {};
        const input = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
        const pricing = isRecord(each.pricing) ? each.pricing : {};
        const price = perMillion(pricing.prompt);

        if (!input.includes("video") || price === undefined) {
            return [];
        }

        const output = perMillion(pricing.completion);

        return [{ id: each.id, name: typeof each.name === "string" ? each.name : each.id, price: { input: price, ...(output === undefined ? {} : { output }) } }];
    });
}

/** What an error answer says, in short. */
function providerError(status: number, text: string): string {
    try {
        const parsed = JSON.parse(text) as unknown;
        const message = isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string" ? parsed.error.message : undefined;

        if (message !== undefined) {
            return `HTTP ${status}: ${message.slice(0, 300)}`;
        }
    } catch {
        // Not JSON: its status says enough.
    }

    return `HTTP ${status}`;
}

export class Videos {
    readonly #options: VideosOptions;
    readonly #fetch: typeof fetch;
    #asks: { at: number; models: VideoAskModel[] } | undefined;

    constructor(options: VideosOptions) {
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
    }

    get #base(): string {
        return this.#options.endpoints?.openRouter ?? OPENROUTER_BASE;
    }

    async #key(): Promise<string> {
        const key = await this.#options.openRouterKey();

        if (key === undefined) {
            throw new Error("Videos go through OpenRouter, which is not signed in: sign in to it in Settings › Providers.");
        }

        return key;
    }

    /** The models that take video, kept an hour; a failed ask is not kept, and fails. */
    async askModels(): Promise<VideoAskModel[]> {
        const now = (this.#options.now ?? Date.now)();

        if (this.#asks !== undefined && now - this.#asks.at < LIST_MS) {
            return this.#asks.models;
        }

        const response = await this.#fetch(`${this.#base}/models`, { signal: AbortSignal.timeout(20_000) });

        if (!response.ok) {
            throw new Error(`OpenRouter's model list answered ${response.status}.`);
        }

        const models = openRouterVideoAskModels(await response.json());

        this.#asks = { at: now, models };

        return models;
    }

    /** The model to watch with: one named for this call, the owner's, or the default; not listed now, an error. */
    async resolveAsk(asked?: string): Promise<VideoAskModel> {
        const wanted = (asked ?? this.#options.askSetting() ?? DEFAULT_ASK_MODEL).trim().replace(/^openrouter\//, "");
        const found = (await this.askModels()).find((each) => each.id === wanted);

        if (found === undefined) {
            throw new Error(`${wanted} does not take video on OpenRouter now. Pick a model that does in ${SETTING_HINT}.`);
        }

        return found;
    }

    /** Check a model for the setting: null (the default) as it is, else one listed now. */
    async checkAsk(model: string | null): Promise<string | null> {
        return model === null || model === "" || model === "auto" ? null : (await this.resolveAsk(model)).id;
    }

    /** Ask a model about a video: its answer, the cost OpenRouter reports, and the tokens. */
    async ask(model: VideoAskModel, question: string, video: VideoInput, signal?: AbortSignal): Promise<{ text: string; cost: number | undefined; tokens: { input: number; output: number } }> {
        const key = await this.#key();
        const url = "url" in video ? video.url : `data:${video.mimeType};base64,${Buffer.from(video.data).toString("base64")}`;
        const response = await this.#fetch(`${this.#base}/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
                "http-referer": "https://github.com/picassio/pi-phone",
                "x-title": "pi-phone",
            },
            body: JSON.stringify({
                model: model.id,
                messages: [{ role: "user", content: [{ type: "text", text: question }, { type: "video_url", video_url: { url } }] }],
                stream: false,
                usage: { include: true },
            }),
            redirect: "error",
            signal: AbortSignal.any([AbortSignal.timeout(ASK_MS), ...(signal === undefined ? [] : [signal])]),
        });
        const text = await response.text();

        if (!response.ok) {
            throw new Error(`OpenRouter could not watch the video with ${model.id} (${providerError(response.status, text)}). Another model: ${SETTING_HINT}.`);
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error("OpenRouter answered with something that is not JSON.");
        }

        const choices = isRecord(parsed) && Array.isArray(parsed.choices) ? parsed.choices : [];
        const message = isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : {};
        const said = typeof message.content === "string" ? message.content.trim() : "";
        const usage = isRecord(parsed) && isRecord(parsed.usage) ? parsed.usage : {};

        if (said === "") {
            throw new Error(`${model.id} said nothing about the video.`);
        }

        return {
            text: said,
            cost: typeof usage.cost === "number" ? usage.cost : undefined,
            tokens: { input: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0, output: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0 },
        };
    }
}
