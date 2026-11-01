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
/** The model `video_generate` makes videos with unless the owner picked another (the owner's pick, PP-298). */
export const DEFAULT_MAKE_MODEL = "kwaivgi/kling-v3.0-std";
/** How long a video may take to make, polled every `POLL_MS`. */
const MAKE_MS = 20 * 60 * 1000;
const POLL_MS = 8_000;
const MAKE_HINT = "Menu › Videos (setting video.model)";

/** A model that makes videos, as Menu › Videos lists it: what it takes, and its lowest price a second when it has one. */
export type VideoMakeModel = {
    id: string;
    name: string;
    durations: number[];
    resolutions: string[];
    aspects: string[];
    /** Dollars a second at its cheapest (without sound, the lowest resolution); absent for a price by tokens. */
    perSecond?: number;
    /** Dollars a second with sound, when it says. */
    withAudio?: number;
};

/** What a video is made of. */
export type MakeRequest = {
    prompt: string;
    duration?: number;
    aspect?: string;
    resolution?: string;
    audio?: boolean;
    /** Images it starts or ends on (image to video), and references for style. */
    firstFrame?: { data: Uint8Array; mimeType: string };
    lastFrame?: { data: Uint8Array; mimeType: string };
    references?: { data: Uint8Array; mimeType: string }[];
};

/**
 * A model's lowest price a second, from OpenRouter's `pricing_skus`: keys that price seconds, in dollars, or in cents
 * when they say so (`cents_per_...`); by tokens (Seedance), none.
 */
export function pricesOf(skus: unknown): { perSecond?: number; withAudio?: number } {
    if (!isRecord(skus)) {
        return {};
    }

    const seconds = Object.entries(skus).flatMap(([key, value]): { key: string; dollars: number }[] => {
        const number = Number(value);

        if (!Number.isFinite(number) || number <= 0 || !/second/.test(key) || /reference|input|megapixel|_2k|_4k|1080p|2k$|4k$/.test(key)) {
            return [];
        }

        return [{ key, dollars: key.startsWith("cents_") ? number / 100 : number }];
    });

    if (seconds.length === 0) {
        return {};
    }

    const silent = seconds.filter((each) => !/with_audio/.test(each.key));
    const loud = seconds.filter((each) => /with_audio/.test(each.key));
    const low = (list: { dollars: number }[]) => Math.round(Math.min(...list.map((each) => each.dollars)) * 10000) / 10000;

    return { ...(silent.length === 0 ? {} : { perSecond: low(silent) }), ...(loud.length === 0 ? {} : { withAudio: low(loud) }) };
}

/** The models of OpenRouter's `GET /videos/models` answer, in its order. */
export function openRouterVideoMakeModels(answer: unknown): VideoMakeModel[] {
    const data = isRecord(answer) && Array.isArray(answer.data) ? answer.data : [];
    const list = (value: unknown, kind: "number" | "string") => (Array.isArray(value) ? value.filter((each) => typeof each === kind) : []);

    return data.flatMap((each): VideoMakeModel[] => {
        if (!isRecord(each) || typeof each.id !== "string") {
            return [];
        }

        return [
            {
                id: each.id,
                name: typeof each.name === "string" ? each.name : each.id,
                durations: list(each.supported_durations, "number") as number[],
                resolutions: list(each.supported_resolutions, "string") as string[],
                aspects: list(each.supported_aspect_ratios, "string") as string[],
                ...pricesOf(each.pricing_skus),
            },
        ];
    });
}
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
    /** The owner's model for video_generate, or null for the default. */
    makeSetting?(): string | null;
    endpoints?: { openRouter?: string };
    fetch?: typeof fetch;
    now?: () => number;
    /** How often a video job is polled (tests: less). */
    pollMs?: number;
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
            // Long enough for OpenRouter's whole word on allowed providers, with its settings address.
            return `HTTP ${status}: ${message.slice(0, 600)}`;
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
    #makes: { at: number; models: VideoMakeModel[] } | undefined;

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

    /** The models that take video, kept an hour; a failed ask is not kept, and fails. Only with OpenRouter signed in. */
    async askModels(): Promise<VideoAskModel[]> {
        await this.#key();

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

    /** The models that make videos, kept an hour; only with OpenRouter signed in. */
    async makeModels(): Promise<VideoMakeModel[]> {
        const key = await this.#key();
        const now = (this.#options.now ?? Date.now)();

        if (this.#makes !== undefined && now - this.#makes.at < LIST_MS) {
            return this.#makes.models;
        }

        const response = await this.#fetch(`${this.#base}/videos/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });

        if (!response.ok) {
            throw new Error(`OpenRouter's video models answered ${response.status}.`);
        }

        const models = openRouterVideoMakeModels(await response.json());

        this.#makes = { at: now, models };

        return models;
    }

    /** The model to make with: one named for this call, the owner's, or the default; not listed now, an error. */
    async resolveMake(asked?: string): Promise<VideoMakeModel> {
        const wanted = (asked ?? this.#options.makeSetting?.() ?? DEFAULT_MAKE_MODEL).trim().replace(/^openrouter\//, "");
        const found = (await this.makeModels()).find((each) => each.id === wanted);

        if (found === undefined) {
            throw new Error(`${wanted} does not make videos on OpenRouter now. Pick one that does in ${MAKE_HINT}.`);
        }

        return found;
    }

    /** Check a model for the setting: null (the default) as it is, else one listed now. */
    async checkMake(model: string | null): Promise<string | null> {
        return model === null || model === "" || model === "auto" ? null : (await this.resolveMake(model)).id;
    }

    /**
     * Make a video: OpenRouter's job is submitted, polled until done, and its first output downloaded. `progress` hears
     * its state as it changes. The cost is `usage.cost` of the finished job, when it says.
     */
    async make(model: VideoMakeModel, request: MakeRequest, signal?: AbortSignal, progress?: (status: string) => void): Promise<{ data: Uint8Array; cost: number | undefined; job: string }> {
        const key = await this.#key();
        const headers = { "content-type": "application/json", authorization: `Bearer ${key}`, "http-referer": "https://github.com/picassio/pi-phone", "x-title": "pi-phone" };
        const image = (picture: { data: Uint8Array; mimeType: string }) => ({ type: "image_url", image_url: { url: `data:${picture.mimeType};base64,${Buffer.from(picture.data).toString("base64")}` } });
        const frames = [
            ...(request.firstFrame === undefined ? [] : [{ ...image(request.firstFrame), frame_type: "first_frame" }]),
            ...(request.lastFrame === undefined ? [] : [{ ...image(request.lastFrame), frame_type: "last_frame" }]),
        ];
        const stop = AbortSignal.any([AbortSignal.timeout(MAKE_MS), ...(signal === undefined ? [] : [signal])]);
        const submitted = await this.#fetch(`${this.#base}/videos`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: model.id,
                prompt: request.prompt,
                ...(request.duration === undefined ? {} : { duration: request.duration }),
                ...(request.aspect === undefined ? {} : { aspect_ratio: request.aspect }),
                ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
                ...(request.audio === undefined ? {} : { generate_audio: request.audio }),
                ...(frames.length === 0 ? {} : { frame_images: frames }),
                ...(request.references === undefined || request.references.length === 0 ? {} : { input_references: request.references.map(image) }),
            }),
            redirect: "error",
            signal: stop,
        });
        const sent = await submitted.text();

        if (!submitted.ok) {
            throw new Error(`OpenRouter did not start the video with ${model.id} (${providerError(submitted.status, sent)}). Another model: ${MAKE_HINT}.`);
        }

        const job = (JSON.parse(sent) as { id?: unknown }).id;

        if (typeof job !== "string" || job === "") {
            throw new Error("OpenRouter started a video but gave no job id.");
        }

        progress?.("pending");

        let last = "pending";
        let cost: number | undefined;

        for (;;) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, this.#options.pollMs ?? POLL_MS);

                stop.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(stop.reason instanceof Error ? stop.reason : new Error("stopped"));
                }, { once: true });
            });

            const polled = await this.#fetch(`${this.#base}/videos/${encodeURIComponent(job)}`, { headers: { authorization: `Bearer ${key}` }, signal: stop });
            const said = await polled.text();

            if (!polled.ok) {
                throw new Error(`OpenRouter's video job ${job} answered ${providerError(polled.status, said)}.`);
            }

            const state = JSON.parse(said) as { status?: unknown; error?: unknown; usage?: { cost?: unknown } };
            const status = typeof state.status === "string" ? state.status : "unknown";

            if (status !== last) {
                last = status;
                progress?.(status);
            }

            if (status === "completed") {
                cost = typeof state.usage?.cost === "number" ? state.usage.cost : undefined;
                break;
            }

            if (status === "failed" || status === "cancelled" || status === "expired") {
                throw new Error(`${model.id} could not make the video (${status}${typeof state.error === "string" && state.error !== "" ? `: ${state.error.slice(0, 300)}` : ""}).`);
            }
        }

        const content = await this.#fetch(`${this.#base}/videos/${encodeURIComponent(job)}/content?index=0`, { headers: { authorization: `Bearer ${key}` }, signal: stop });

        if (!content.ok) {
            throw new Error(`OpenRouter's video ${job} could not be downloaded (${providerError(content.status, await content.text())}).`);
        }

        return { data: new Uint8Array(await content.arrayBuffer()), cost, job };
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
