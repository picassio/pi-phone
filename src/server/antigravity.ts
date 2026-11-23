/**
 * Google Antigravity as a provider, signed in the way Google's own CLI `agy` signs in on a machine with no browser
 * (PP-555; the owner's decision of 2026-11-23, for personal use, the risk of a suspended account accepted). Sign in
 * with Google opens Google's consent page with agy's OAuth client, PKCE (S256), its scopes and its redirect to
 * `https://antigravity.google/oauth-callback`, which shows a code; the owner pastes it in the sign-in card, and this
 * server trades it for agy's tokens, as agy does. Then the account's project: `loadCodeAssist`, and `onboardUser` for an
 * account that has none yet. From then on the requests go from this server with agy's own shape: its host, User-Agent
 * and headers, its request envelope (project, requestId, labels, sessionId, userAgent, requestType) and its thinking
 * settings per model, as captured from agy 1.5.15 (wiki: resources/antigravity-agy-fingerprint), the way `cc-patch.ts`
 * speaks as Claude Code. Its model list is what `agy models` lists (`fetchAvailableModels`), one model per family with
 * agy's efforts as thinking levels. The stream, tool calls, thinking and pictures are pi-ai's Google conversion
 * (`api/google-shared`), the parts pi-mono v0.70.6's `google-gemini-cli.ts` (MIT) had of its own.
 *
 * Google's terms forbid third-party clients of Antigravity, and accounts are being suspended for it: a suspension
 * closes Antigravity, Gemini CLI and Code Assist, with one appeal. The provider does nothing until the owner signs in,
 * and Settings › Providers says so beside it. The pasted code, the verifier and the tokens never reach a log or a chat.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
    type Api,
    type AssistantMessage,
    calculateCost,
    clampThinkingLevel,
    collapseSystemMessages,
    type Credential,
    createAssistantMessageEventStream,
    createProvider,
    getCurrentTools,
    getInitialSystemMessage,
    getSystemMessageText,
    type Model,
    type ModelAuth,
    type ModelThinkingLevel,
    type OAuthCredential,
    type Provider,
    type ProviderAuthInteraction,
    type SimpleStreamOptions,
    type StreamOptions,
    type TextContent,
    type ThinkingContent,
    type ThinkingLevelMap,
    type ToolCall,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
    convertMessages,
    convertTools,
    isThinkingPart,
    mapStopReasonString,
    mapToolChoice,
    retainThoughtSignature,
} from "@earendil-works/pi-ai/api/google-shared";
import { retryProviderRequest } from "@earendil-works/pi-ai/utils/provider-retry";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import { agyTlsTransport } from "./agy-tls-proxy.ts";
import { AgyBackground, type AgyRead, agyTransport, goHeaders, type WireRequest, type WireResponse } from "./agy-wire.ts";
import { APP_ROOT } from "./config.ts";
import { ClearcutClient } from "./antigravity-clearcut.ts";

export const AGY_PROVIDER = "google-antigravity";
export const AGY_NAME = "Google Antigravity";
/** The agy release whose requests these are, and its build: in the User-Agent. Raise both with agy's. */
export const AGY_VERSION = "1.5.15";
export const AGY_BUILD = "1027820220";

const API = "google-antigravity";
const HOST = "https://daily-cloudcode-pa.googleapis.com";
/** Cloud Code's host, for the media calls (`antigravity-media.ts`). */
export const AGY_HOST = HOST;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Google's account endpoint, which agy reads with Go's own User-Agent. */
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
/** agy's config and experiments. */
const CONFIG_URL = "https://aicode.googleapis.com/v1alpha:fetchConfig";
/** Google's consent page, as agy opens it (Go's `oauth2` with Google's endpoint: not the v2 path). */
export const AGY_AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
/** agy's redirect for a machine with no browser: the page shows the code to paste. */
export const AGY_REDIRECT = "https://antigravity.google/oauth-callback";
/** agy's scopes, in its order. */
const SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
    "https://www.googleapis.com/auth/aicode",
    "openid",
];
/** What agy's User-Agent says of a Google sign-in. */
const AUTH_METHOD = "consumer";
/** How long an account's first project may take Google to set up, and how often it is asked. */
const ONBOARD_TRIES = 24;
const ONBOARD_EVERY_MS = 5_000;
// agy's OAuth client (the same one pi-mono v0.70.6 ships, base64 as it keeps it). An installed app's client secret is
// not a secret in OAuth's sense; it is still never logged.
const CLIENT_ID = atob("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==");
const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
/** A token is renewed this long before Google's end of it, as pi-mono did. */
const EARLY_MS = 5 * 60_000;

/** What the owner reads before connecting (the sign-in's first words; Providers shows it translated). */
export const AGY_RISK =
    "Google's terms forbid third-party clients of Antigravity, and accounts are being suspended for it. A suspension closes Antigravity, Gemini CLI and Code Assist together, with one appeal. Connect only an account you accept to lose.";

export type AgyResponse = WireResponse;

/**
 * One request (a POST unless `method` says GET), its headers written as given, in Go's order (`goHeaders`); the body is
 * gunzipped when Google gzipped it.
 */
export type AgySend = (url: string, init: WireRequest) => Promise<AgyResponse>;

export interface AgyOptions {
    /** Tests answer for Google. Default: agy's wire (`agy-wire.ts`): HTTP/1.1 with Go's headers and TLS. */
    send?: AgySend;
    /** The sign-in of an account now, as `toAuth` gives it (Pi renews it): agy's background reads between turns. */
    auth?: (provider: string) => Promise<string | undefined>;
    /** The app's log: a background read that failed. */
    log?: (line: string) => void;
    /** agy read an account's quota again (the usage bars show it). */
    quotaRead?: (provider: string) => void;
    now?: () => number;
    /** The wait between asking whether a new account's project is ready. Tests do not wait. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** What the User-Agent says of this system, as agy's Go build would (default: this server's). */
    platform?: { osType: string; arch: string };
}

/** The sign-in as pi keeps it (`auth.json`): agy's tokens, the account's project, and what the User-Agent says. */
export type AgyCredential = OAuthCredential & {
    projectId: string;
    email?: string;
    /** agy's `os_type`, `arch` and `auth_method` in its User-Agent. */
    osType: string;
    arch: string;
    authMethod: string;
};

/** What a request needs, as `toAuth` gives it to the stream (pi-ai's `apiKey`). */
export type AgyAuth = { token: string; project: string; userAgent: string };

type ModelInfo = {
    displayName?: string;
    supportsImages?: boolean;
    supportsThinking?: boolean;
    thinkingLevel?: number;
    thinkingBudget?: number;
    maxTokens?: string | number;
    maxOutputTokens?: number;
    model?: string;
    modelProvider?: string;
    disabled?: boolean;
};

export type AgyCatalog = {
    models?: Record<string, ModelInfo>;
    agentModelSorts?: { groups?: { modelIds?: string[] }[] }[];
    groupedModels?: Record<string, { displayName?: string; supportedThinkingLevels?: { thinkingSuffix?: string }[] }>;
    /** The image models agy's image tool uses (`antigravity-media.ts`). */
    imageGenerationModelIds?: string[];
    /** The dictation models agy's `/voice` uses. */
    audioTranscriptionModelIds?: string[];
};

/** agy's thinking levels by number, as protobuf's JSON writes them; another number is sent as it is (100: xhigh). */
const LEVEL_NAMES: Record<number, string> = { 1: "LOW", 2: "MEDIUM", 3: "HIGH" };
/** pi's levels, lowest first: agy's effort suffixes that are pi's levels too. */
const PI_LEVELS: readonly ModelThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export class AgyHttpError extends Error {
    readonly status: number;
    readonly headers: Headers;

    constructor(status: number, headers: Headers, message: string) {
        super(message);
        this.status = status;
        this.headers = headers;
    }
}

export async function readText(body: AsyncIterable<Uint8Array>): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString("utf8");
}

/** Google's error message in a JSON error body, or the body cut short. */
export function errorText(body: string): string {
    try {
        const message = (JSON.parse(body) as { error?: { message?: unknown; status?: unknown } }).error;

        if (typeof message?.message === "string") {
            return typeof message.status === "string" ? `${message.status}: ${message.message}` : message.message;
        }
    } catch {
        // Not JSON: the text itself.
    }

    return body.trim().slice(0, 500);
}

/** agy's User-Agent for the system it says it runs on. */
export function agyUserAgent(osType: string, arch: string, authMethod: string): string {
    return `antigravity/cli/${AGY_VERSION} (aidev_client; os_type=${osType}; arch=${arch}; cl=${AGY_BUILD}; auth_method=${authMethod})`;
}

/** Go's names for this server's system and processor; Android is Linux, as agy has no Android build. */
function hostPlatform(): { osType: string; arch: string } {
    const osType = process.platform === "win32" ? "windows" : process.platform === "android" ? "linux" : process.platform;

    return { osType, arch: process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch };
}

/**
 * Google's consent page for one sign-in, as agy opens it: Go's `url.Values` order (by name), agy's client, PKCE S256,
 * offline access with consent, its scopes and its no-browser redirect.
 */
export function signInUrl(challenge: string, state: string): string {
    const query = new URLSearchParams({
        access_type: "offline",
        client_id: CLIENT_ID,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "consent",
        redirect_uri: AGY_REDIRECT,
        response_type: "code",
        scope: SCOPES.join(" "),
        state,
    });

    return `${AGY_AUTH_URL}?${query.toString()}`;
}

/**
 * The code from what the owner pasted: the code the page shows, or the page's whole address (whose state must be this
 * sign-in's). Its words never hold the code.
 */
export function pastedCode(pasted: string, state: string): string {
    const text = pasted.trim();

    if (text === "") {
        throw new Error("No code was pasted: copy the code Google Antigravity's page shows after you sign in.");
    }

    if (!/^https?:\/\//.test(text) && !/(^|[?&])code=/.test(text)) {
        return text;
    }

    const query = new URLSearchParams(text.includes("?") ? text.slice(text.indexOf("?") + 1).split("#")[0] : text);
    const refused = query.get("error");

    if (refused !== null) {
        throw new Error(`Google did not sign in: ${refused}.`);
    }

    if (query.get("state") !== null && query.get("state") !== state) {
        throw new Error("That page is from another sign-in: start again and paste the code of this one.");
    }

    const code = query.get("code");

    if (code === null || code === "") {
        throw new Error("That address has no code: paste the code Google Antigravity's page shows.");
    }

    return code;
}

/** The account's address from the ID token Google's token endpoint gave (over TLS, from Google itself: not verified again). */
function emailOf(idToken: unknown): string | undefined {
    if (typeof idToken !== "string") {
        return undefined;
    }

    try {
        const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };

        return typeof claims.email === "string" ? claims.email : undefined;
    } catch {
        return undefined;
    }
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);

        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("cancelled"));
        });
    });

function agyCredential(credential: Credential | undefined): AgyCredential {
    if (credential?.type !== "oauth" || typeof credential.projectId !== "string" || typeof credential.osType !== "string") {
        throw new Error(`${AGY_NAME} is not signed in: sign in in Settings › Providers.`);
    }

    return credential as AgyCredential;
}

function authOf(credential: AgyCredential): AgyAuth {
    return { token: credential.access, project: credential.projectId, userAgent: agyUserAgent(credential.osType, credential.arch, credential.authMethod) };
}

export function parseAuth(apiKey: string | undefined): AgyAuth {
    try {
        const auth = JSON.parse(apiKey ?? "") as Partial<AgyAuth>;

        if (typeof auth.token === "string" && typeof auth.project === "string" && typeof auth.userAgent === "string") {
            return { token: auth.token, project: auth.project, userAgent: auth.userAgent };
        }
    } catch {
        // Below.
    }

    throw new Error(`${AGY_NAME} is not signed in: sign in in Settings › Providers.`);
}

/**
 * The headers agy sends with a Cloud Code call, as Go writes them (`goHeaders`): Host, User-Agent, Content-Length,
 * Authorization, Content-Type, Accept-Encoding; a GET has no body, so no Content-Length nor Content-Type.
 */
export function cloudCodeHeaders(url: string, auth: AgyAuth, body?: string): Record<string, string> {
    return goHeaders(url, { "User-Agent": auth.userAgent, Authorization: `Bearer ${auth.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body);
}

/** A stable UUID-shaped id from a seed: agy's cascade and trajectory ids for one session and one turn. */
function uuidFrom(seed: string): string {
    const hex = createHash("sha256").update(seed).digest("hex");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** agy's request `sessionId`: a positive 63-bit number, as text. */
function numericId(seed: string | undefined): string {
    const bytes = seed === undefined ? createHash("sha256").update(randomUUID()).digest() : createHash("sha256").update(`session:${seed}`).digest();

    return (bytes.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString();
}

/** The models `agy models` lists: one per family with agy's efforts as thinking levels, and the rest as they are. */
export function catalogModels(catalog: AgyCatalog): Model<Api>[] {
    const infos = catalog.models ?? {};
    const groups = catalog.groupedModels ?? {};
    const listed = [...new Set((catalog.agentModelSorts ?? []).flatMap((sort) => sort.groups ?? []).flatMap((group) => group.modelIds ?? []))];
    const models: Model<Api>[] = [];
    const done = new Set<string>();

    const model = (id: string, name: string, variants: ModelInfo[], thinkingLevelMap?: ThinkingLevelMap): Model<Api> => ({
        id,
        name,
        api: API,
        provider: AGY_PROVIDER,
        baseUrl: HOST,
        reasoning: thinkingLevelMap !== undefined,
        ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
        input: variants.some((each) => each.supportsImages === true) ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Math.max(...variants.map((each) => Number(each.maxTokens) || 0)),
        maxTokens: Math.max(...variants.map((each) => each.maxOutputTokens ?? 0)),
    });

    for (const id of listed) {
        const info = infos[id];

        if (info === undefined || info.disabled === true || done.has(id)) {
            continue;
        }

        const family = Object.entries(groups).find(([group, about]) =>
            (about.supportedThinkingLevels ?? []).some((level) => `${group}-${level.thinkingSuffix}` === id),
        );

        if (family === undefined) {
            done.add(id);
            models.push(model(id, info.displayName ?? id, [info]));
            continue;
        }

        const [group, about] = family;
        const suffixes = (about.supportedThinkingLevels ?? [])
            .map((level) => level.thinkingSuffix)
            .filter((suffix): suffix is string => suffix !== undefined && infos[`${group}-${suffix}`] !== undefined && infos[`${group}-${suffix}`]!.disabled !== true);

        for (const suffix of suffixes) {
            done.add(`${group}-${suffix}`);
        }

        // Off is not one of agy's: its models always think. A level agy has not is unsupported (null); xhigh and max
        // are unsupported unless named.
        const map: ThinkingLevelMap = { off: null };

        for (const level of PI_LEVELS) {
            if (suffixes.includes(level)) {
                map[level] = level;
            } else if (level !== "xhigh" && level !== "max") {
                map[level] = null;
            }
        }

        models.push(model(group, about.displayName ?? group, suffixes.map((suffix) => infos[`${group}-${suffix}`]!), map));
    }

    return models;
}

/** agy's generation settings for one of its models: its most output, and its thinking as it sends it. */
function generationConfig(info: ModelInfo): Record<string, unknown> {
    const thinking =
        info.thinkingBudget !== undefined
            ? { includeThoughts: true, thinkingBudget: info.thinkingBudget }
            : info.thinkingLevel !== undefined
              ? { includeThoughts: true, thinkingLevel: LEVEL_NAMES[info.thinkingLevel] ?? info.thinkingLevel }
              : undefined;

    return {
        ...(info.maxOutputTokens === undefined ? {} : { maxOutputTokens: info.maxOutputTokens }),
        ...(thinking === undefined ? {} : { thinkingConfig: thinking }),
    };
}

/** As a Google model to pi-ai's Google conversion, which reads only its id, input and provider. */
const asGoogle = (model: Model<Api>) => model as unknown as Model<"google-generative-ai">;

type Part = {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
};

type Chunk = {
    response?: {
        candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
        usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            thoughtsTokenCount?: number;
            totalTokenCount?: number;
            cachedContentTokenCount?: number;
        };
        modelVersion?: string;
        responseId?: string;
    };
    error?: { message?: string; status?: string; code?: number };
};

/** The SSE events of a stream, each `data:` line's JSON. */
async function* events(body: AsyncIterable<Uint8Array>): AsyncGenerator<Chunk> {
    const decoder = new TextDecoder();
    let buffer = "";

    const parse = function* (lines: string[]): Generator<Chunk> {
        for (const line of lines) {
            if (!line.startsWith("data:")) {
                continue;
            }

            const json = line.slice(5).trim();

            if (json !== "") {
                yield JSON.parse(json) as Chunk;
            }
        }
    };

    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");

        buffer = lines.pop() ?? "";
        yield* parse(lines);
    }

    yield* parse([buffer + decoder.decode()]);
}

let toolCallCounter = 0;

export function antigravityProvider(options: AgyOptions = {}): Provider {
    return antigravity(options).provider;
}

/** A conversation's last agent request: its trajectory and the number its `requestId` ends with. */
export type AgyStep = { trajectory: string; step: number };

/** What `antigravity()` gives the app: the provider, and what agy's other features share with it, as in one agy. */
export type AgyRuntime = {
    provider: Provider;
    /** agy's background reads for its accounts (the usage bars read the quota from them). */
    background: AgyBackground<AgyAuth>;
    /** The one transport (one pool of connections, as Go's one transport) every HTTP/1.1 request of agy's goes on. */
    send: AgySend;
    /** The model list Google gave last (refreshed by the background reads), asked once when there is none. */
    catalog: (auth: AgyAuth, signal?: AbortSignal) => Promise<AgyCatalog>;
    /** A conversation's last agent request (by Pi's provider session id), for the ids of a tool call it made. */
    lastStep: (sessionId: string) => AgyStep | undefined;
    /** Clearcut telemetry client for session events (PP-559). */
    clearcut: ClearcutClient;
};

/** How many conversations' last steps are kept. */
const STEPS_KEPT = 200;

/** The provider, and agy's background reads, transport and catalog it shares with Antigravity's media. */
export function antigravity(options: AgyOptions = {}): AgyRuntime {
    // Go's own TLS through native/agy-tls (PP-559), Node's set close to it without the program.
    const send = options.send ?? agyTlsTransport({ appRoot: APP_ROOT, fallback: agyTransport(), ...(options.log === undefined ? {} : { log: options.log }) });
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? sleepFor;
    /** The last model list Google gave, for each request's model and settings; asked once after a start. */
    let catalog: AgyCatalog | undefined;
    let asking: Promise<AgyCatalog> | undefined;
    /** Each conversation's last agent request, newest last. */
    const steps = new Map<string, AgyStep>();

    // Clearcut telemetry client (PP-559): sends usage events to play.googleapis.com as agy does.
    const clearcut = new ClearcutClient({
        send,
        auth: async () => {
            const apiKey = await options.auth?.(AGY_PROVIDER);
            if (!apiKey) return undefined;
            try {
                const auth = parseAuth(apiKey);
                return { token: auth.token };
            } catch {
                return undefined;
            }
        },
        platform: options.platform,
        log: options.log,
    });

    const post = async (url: string, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal): Promise<string> => {
        const response = await send(url, { ...(body === undefined ? { method: "GET" as const } : { body }), headers, ...(signal === undefined ? {} : { signal }) });
        const text = await readText(response.body);

        if (response.status >= 400) {
            throw new AgyHttpError(response.status, response.headers, `${AGY_NAME} (${response.status}): ${errorText(text)}`);
        }

        return text;
    };

    const cloudCode = async <T>(method: string, auth: AgyAuth, body: unknown, signal?: AbortSignal): Promise<T> => {
        const json = JSON.stringify(body);
        const url = `${HOST}/v1internal:${method}`;

        return JSON.parse(await post(url, cloudCodeHeaders(url, auth, json), json, signal)) as T;
    };

    /** A GET as agy makes it: agy's User-Agent (Go's own for Google's account endpoint) and the token. */
    const getJson = async (url: string, auth: AgyAuth, userAgent: string = auth.userAgent): Promise<unknown> =>
        JSON.parse(await post(url, goHeaders(url, { "User-Agent": userAgent, Authorization: `Bearer ${auth.token}` }), undefined));

    /** agy's background reads, each as agy sends it. */
    const read = async (_provider: string, auth: AgyAuth, name: AgyRead): Promise<unknown> => {
        switch (name) {
            case "userinfo":
                return getJson(USERINFO_URL, auth, "Go-http-client/1.1");
            case "fetchConfig":
                return getJson(CONFIG_URL, auth);
            case "cascadeNuxes":
                return getJson(`${HOST}/v1internal/cascadeNuxes?page_size=1000`, auth);
            case "loadCodeAssist":
                return cloudCode(name, auth, { metadata: { ideType: "ANTIGRAVITY" } });
            case "fetchAvailableModels":
                catalog = await cloudCode<AgyCatalog>(name, auth, { project: auth.project });

                return catalog;
            default:
                return cloudCode(name, auth, { project: auth.project });
        }
    };
    const background = new AgyBackground<AgyAuth>({
        read,
        auth: async (provider) => {
            const apiKey = await options.auth?.(provider);

            return apiKey === undefined ? undefined : parseAuth(apiKey);
        },
        log: options.log ?? (() => {}),
        ...(options.quotaRead === undefined ? {} : { quotaRead: options.quotaRead }),
        now,
    });

    const fetchCatalog = (auth: AgyAuth, signal?: AbortSignal): Promise<AgyCatalog> =>
        cloudCode<AgyCatalog>("fetchAvailableModels", auth, { project: auth.project }, signal).then((answer) => {
            catalog = answer;

            return answer;
        });

    const catalogFor = (auth: AgyAuth, signal?: AbortSignal): Promise<AgyCatalog> => {
        if (catalog !== undefined) {
            return Promise.resolve(catalog);
        }

        asking ??= fetchCatalog(auth, signal).finally(() => {
            asking = undefined;
        });

        return asking;
    };

    /** Google's token endpoint, as agy's Go client asks it: the form by name, agy's client in it. */
    const token = async (
        fields: Record<string, string>,
        failed: string,
        signal?: AbortSignal,
    ): Promise<{ access_token: string; expires_in: number; refresh_token?: unknown; id_token?: unknown }> => {
        const form = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields });

        form.sort();
        let answer: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; id_token?: unknown };

        try {
            const body = form.toString();

            // Go's own client, with its User-Agent.
            answer = JSON.parse(await post(TOKEN_URL, goHeaders(TOKEN_URL, { "Content-Type": "application/x-www-form-urlencoded" }, body), body, signal)) as typeof answer;
        } catch (error) {
            // OAuth's own words (invalid_grant) reach the Providers sheet; the request's form never does.
            throw new Error(`${failed}: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (typeof answer.access_token !== "string" || typeof answer.expires_in !== "number") {
            throw new Error(`${failed}: the answer has no access token.`);
        }

        return { ...answer, access_token: answer.access_token, expires_in: answer.expires_in };
    };

    /** A new access token from the refresh token, as agy's Go client asks for it. */
    const renew = async (credential: AgyCredential, signal?: AbortSignal): Promise<AgyCredential> => {
        const answer = await token({ grant_type: "refresh_token", refresh_token: credential.refresh }, "Google token refresh failed", signal);

        return {
            ...credential,
            access: answer.access_token,
            refresh: typeof answer.refresh_token === "string" ? answer.refresh_token : credential.refresh,
            expires: now() + answer.expires_in * 1000 - EARLY_MS,
        };
    };

    /**
     * The account's project, as agy finds it: `loadCodeAssist`, and for an account with none yet `onboardUser` on its
     * default tier (Google makes the project of a free one), asked again until Google says it is done.
     */
    const projectOf = async (auth: AgyAuth, interaction: ProviderAuthInteraction): Promise<string> => {
        type Project = string | { id?: unknown } | undefined;
        const idOf = (project: Project) => (typeof project === "string" ? project : typeof project?.id === "string" ? project.id : "");
        const metadata = { ideType: "ANTIGRAVITY" };
        const assist = await cloudCode<{
            cloudaicompanionProject?: Project;
            currentTier?: { id?: string };
            allowedTiers?: { id?: string; isDefault?: boolean; userDefinedCloudaicompanionProject?: boolean }[];
        }>("loadCodeAssist", auth, { metadata }, interaction.signal);
        const found = idOf(assist.cloudaicompanionProject);

        if (found !== "") {
            return found;
        }

        const tier = assist.allowedTiers?.find((each) => each.isDefault === true) ?? { id: "free-tier" };

        if (assist.currentTier !== undefined || tier.userDefinedCloudaicompanionProject === true) {
            throw new Error(
                `This Google account needs a Google Cloud project of its own (${assist.currentTier?.id ?? tier.id ?? "its tier"}), as a Workspace account does: ${AGY_NAME} here signs in accounts Google gives a project to.`,
            );
        }

        interaction.notify({ type: "progress", message: "Setting up Antigravity for this account…" });
        let operation = await cloudCode<{ name?: string; done?: boolean; response?: { cloudaicompanionProject?: Project } }>(
            "onboardUser",
            auth,
            { tierId: tier.id ?? "free-tier", metadata },
            interaction.signal,
        );

        for (let tries = 1; operation.done !== true && typeof operation.name === "string" && tries < ONBOARD_TRIES; tries++) {
            await sleep(ONBOARD_EVERY_MS, interaction.signal);
            const url = `${HOST}/v1internal/${operation.name}`;

            operation = JSON.parse(await post(url, cloudCodeHeaders(url, auth), undefined, interaction.signal)) as typeof operation;
        }

        const made = idOf(operation.response?.cloudaicompanionProject);

        if (operation.done !== true || made === "") {
            throw new Error("Google has not finished setting up Antigravity for this account: sign in again in a few minutes.");
        }

        return made;
    };

    /**
     * Sign in as agy does on a machine with no browser: Google's consent page (agy's client, PKCE S256, its scopes, its
     * redirect), the code its page shows pasted back, traded for tokens, then the account's project.
     */
    const login = async (interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
        interaction.notify({ type: "info", message: AGY_RISK });
        // Go's oauth2.GenerateVerifier: 32 random bytes; agy's state: 16.
        const verifier = randomBytes(32).toString("base64url");
        const state = randomBytes(16).toString("base64url");

        interaction.notify({
            type: "auth_url",
            url: signInUrl(createHash("sha256").update(verifier).digest("base64url"), state),
            instructions: "Sign in with the Google account to use. Google Antigravity's page then shows a code: copy it and paste it below.",
        });
        const code = pastedCode(await interaction.prompt({ type: "manual_code", message: "The code from Google Antigravity's page", placeholder: "4/0A…" }), state);
        const answer = await token(
            { code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: AGY_REDIRECT },
            "Google did not accept the code",
            interaction.signal,
        );

        if (typeof answer.refresh_token !== "string" || answer.refresh_token === "") {
            throw new Error("Google gave no refresh token: sign in again.");
        }

        const platform = options.platform ?? hostPlatform();
        const email = emailOf(answer.id_token);
        const credential: AgyCredential = {
            type: "oauth",
            access: answer.access_token,
            refresh: answer.refresh_token,
            expires: now() + answer.expires_in * 1000 - EARLY_MS,
            projectId: "",
            osType: platform.osType,
            arch: platform.arch,
            authMethod: AUTH_METHOD,
            ...(email === undefined ? {} : { email }),
        };
        const projectId = await projectOf(authOf(credential), interaction);

        catalog = undefined;

        return { ...credential, projectId };
    };

    const stream = (model: Model<Api>, context: TranscriptContext, streamOptions: StreamOptions | undefined, reasoning: ModelThinkingLevel | undefined) => {
        const events$ = createAssistantMessageEventStream();
        const normalized = collapseSystemMessages(context);

        // After the turn, agy reads the quota again (`AgyBackground.afterTurn`).
        let ended = () => {};

        void (async () => {
            const output: AssistantMessage = {
                role: "assistant",
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "pending",
                timestamp: Date.now(),
            };

            try {
                const auth = parseAuth(streamOptions?.apiKey);
                const signal = streamOptions?.signal;

                // agy's start when it is not running for this account, and its reads at a conversation's first turn.
                await background.beforeTurn(model.provider, auth, streamOptions?.sessionId);
                ended = () => background.afterTurn(model.provider);
                const level = model.reasoning ? clampThinkingLevel(model, reasoning ?? "off") : undefined;
                const suffix = level === undefined ? undefined : model.thinkingLevelMap?.[level];
                const agyId = typeof suffix === "string" ? `${model.id}-${suffix}` : model.id;
                const info = (await catalogFor(auth, signal)).models?.[agyId];

                if (info === undefined) {
                    throw new Error(`Antigravity does not offer ${agyId} now: refresh the models (Settings › Providers › Refresh models).`);
                }

                if (typeof suffix === "string") {
                    output.providerThinkingLevel = suffix;
                }

                const body = requestBody(model, normalized, auth.project, agyId, info, streamOptions);
                const sessionId = streamOptions?.sessionId;
                const id = typeof body.requestId === "string" ? /^agent\/[^/]+\/\d+\/([^/]+)\/(\d+)$/.exec(body.requestId) : null;

                // A tool this request calls (agy's image tool) names the trajectory and the step after it.
                if (sessionId !== undefined && id !== null) {
                    steps.delete(sessionId);
                    steps.set(sessionId, { trajectory: id[1]!, step: Number(id[2]) });

                    for (const oldest of steps.keys()) {
                        if (steps.size <= STEPS_KEPT) {
                            break;
                        }

                        steps.delete(oldest);
                    }
                }

                const payload = (await streamOptions?.onPayload?.(body, model)) ?? body;
                const json = JSON.stringify(payload);
                const response = await retryProviderRequest(
                    async () => {
                        const url = `${HOST}/v1internal:streamGenerateContent?alt=sse`;
                        const answer = await send(url, {
                            headers: cloudCodeHeaders(url, auth, json),
                            body: json,
                            ...(signal === undefined ? {} : { signal }),
                        });

                        await streamOptions?.onResponse?.({ status: answer.status, headers: Object.fromEntries(answer.headers) }, model);

                        if (answer.status >= 400) {
                            throw new AgyHttpError(answer.status, answer.headers, `${AGY_NAME} (${answer.status}): ${errorText(await readText(answer.body))}`);
                        }

                        return answer;
                    },
                    {
                        ...(streamOptions?.maxRetries === undefined ? {} : { maxRetries: streamOptions.maxRetries }),
                        ...(streamOptions?.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: streamOptions.maxRetryDelayMs }),
                        ...(signal === undefined ? {} : { signal }),
                    },
                );

                events$.push({ type: "start", partial: output });
                let current: TextContent | ThinkingContent | null = null;
                const blocks = output.content;
                const index = () => blocks.length - 1;
                const close = () => {
                    if (current?.type === "text") {
                        events$.push({ type: "text_end", contentIndex: index(), content: current.text, partial: output });
                    } else if (current?.type === "thinking") {
                        events$.push({ type: "thinking_end", contentIndex: index(), content: current.thinking, partial: output });
                    }

                    current = null;
                };

                for await (const chunk of events(response.body)) {
                    await streamOptions?.onProviderStreamEvent?.(chunk, model);

                    if (chunk.error !== undefined) {
                        throw new Error(`${AGY_NAME}: ${chunk.error.status ?? chunk.error.code ?? ""} ${chunk.error.message ?? "error"}`.trim());
                    }

                    const answer = chunk.response;

                    if (answer === undefined) {
                        continue;
                    }

                    output.responseId ||= answer.responseId;

                    if (answer.modelVersion !== undefined) {
                        output.responseModel = answer.modelVersion;
                    }

                    const candidate = answer.candidates?.[0];

                    for (const part of candidate?.content?.parts ?? []) {
                        if (part.text !== undefined) {
                            const thinking = isThinkingPart(part);

                            if (current === null || (thinking ? current.type !== "thinking" : current.type !== "text")) {
                                close();

                                if (thinking) {
                                    current = { type: "thinking", thinking: "" };
                                    blocks.push(current);
                                    events$.push({ type: "thinking_start", contentIndex: index(), partial: output });
                                } else {
                                    current = { type: "text", text: "" };
                                    blocks.push(current);
                                    events$.push({ type: "text_start", contentIndex: index(), partial: output });
                                }
                            }

                            const block: TextContent | ThinkingContent = current!;

                            if (block.type === "thinking") {
                                block.thinking += part.text;
                                block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, part.thoughtSignature);
                                events$.push({ type: "thinking_delta", contentIndex: index(), delta: part.text, partial: output });
                            } else {
                                block.text += part.text;
                                block.textSignature = retainThoughtSignature(block.textSignature, part.thoughtSignature);
                                events$.push({ type: "text_delta", contentIndex: index(), delta: part.text, partial: output });
                            }
                        }

                        if (part.functionCall !== undefined) {
                            close();
                            const given = part.functionCall.id;
                            const id =
                                given === undefined || given === "" || blocks.some((each) => each.type === "toolCall" && each.id === given)
                                    ? `${part.functionCall.name ?? "tool"}_${Date.now()}_${++toolCallCounter}`
                                    : given;
                            const call: ToolCall = {
                                type: "toolCall",
                                id,
                                name: part.functionCall.name ?? "",
                                arguments: (part.functionCall.args ?? {}) as ToolCall["arguments"],
                                ...(part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature }),
                            };

                            blocks.push(call);
                            events$.push({ type: "toolcall_start", contentIndex: index(), partial: output });
                            events$.push({ type: "toolcall_delta", contentIndex: index(), delta: JSON.stringify(call.arguments), partial: output });
                            events$.push({ type: "toolcall_end", contentIndex: index(), toolCall: call, partial: output });
                        }
                    }

                    if (candidate?.finishReason !== undefined) {
                        output.rawStopReason = candidate.finishReason;
                        output.stopReason = mapStopReasonString(candidate.finishReason);

                        if (output.stopReason === "stop" && blocks.some((each) => each.type === "toolCall")) {
                            output.stopReason = "toolUse";
                        }
                    }

                    const usage = answer.usageMetadata;

                    if (usage !== undefined) {
                        const cached = usage.cachedContentTokenCount ?? 0;

                        output.usage = {
                            input: (usage.promptTokenCount ?? 0) - cached,
                            output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
                            cacheRead: cached,
                            cacheWrite: 0,
                            reasoning: usage.thoughtsTokenCount ?? 0,
                            totalTokens: usage.totalTokenCount ?? 0,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                        };
                        calculateCost(model, output.usage);
                    }
                }

                close();

                if (signal?.aborted) {
                    throw new Error("Request was aborted");
                }

                if (output.stopReason === "pending") {
                    throw new Error(`${AGY_NAME}: the stream ended without a finish reason`);
                }

                if (output.stopReason === "aborted" || output.stopReason === "error") {
                    throw new Error(`${AGY_NAME} stopped with ${output.rawStopReason ?? "an error"}`);
                }

                events$.push({ type: "done", reason: output.stopReason, message: output });
                events$.end();
            } catch (error) {
                output.stopReason = streamOptions?.signal?.aborted ? "aborted" : "error";
                output.errorMessage = error instanceof Error ? error.message : String(error);
                events$.push({ type: "error", reason: output.stopReason, error: output });
                events$.end();
            }

            ended();
        })();

        return events$;
    };

    const provider = createProvider({
        id: AGY_PROVIDER,
        name: AGY_NAME,
        baseUrl: HOST,
        auth: {
            oauth: {
                name: AGY_NAME,
                isSubscription: true,
                loginLabel: "Sign in with Google",
                login,
                refresh: async (credential, signal) => renew(agyCredential(credential), signal),
                toAuth: async (credential): Promise<ModelAuth> => ({ apiKey: JSON.stringify(authOf(agyCredential(credential))) }),
            },
        },
        models: [],
        fetchModels: async (context) => catalogModels(await fetchCatalog(authOf(agyCredential(context.credential)), context.signal)),
        api: {
            stream: (model, context, streamOptions) => stream(model, context, streamOptions, undefined),
            streamSimple: (model, context, streamOptions?: SimpleStreamOptions) => stream(model, context, streamOptions, streamOptions?.reasoning),
        },
    });

    return { provider, background, send, catalog: catalogFor, lastStep: (sessionId) => steps.get(sessionId), clearcut };
}

/**
 * agy's request for one turn. Its ids are made as agy makes them: the session is a cascade, each of the person's
 * messages a trajectory, each call in it a step; here they are stable per session and turn.
 */
export function requestBody(
    model: Model<Api>,
    context: TranscriptContext,
    project: string,
    agyId: string,
    info: ModelInfo,
    options: (StreamOptions & { toolChoice?: unknown }) | undefined,
): Record<string, unknown> {
    const google = asGoogle(model);
    const contents = convertMessages(google, context);
    const system = getInitialSystemMessage(context.messages);
    const systemText = system === undefined ? "" : getSystemMessageText(system);
    const tools = getCurrentTools(context.messages);
    const claude = info.modelProvider === "MODEL_PROVIDER_ANTHROPIC";
    const sessionId = options?.sessionId;
    const turns = context.messages.filter((message) => message.role === "user").length;
    const lastUser = context.messages.findLastIndex((message) => message.role === "user");
    const calls = context.messages.slice(lastUser + 1).filter((message) => message.role === "assistant").length;
    const cascade = sessionId === undefined ? randomUUID() : uuidFrom(`cascade:${sessionId}`);
    const trajectory = sessionId === undefined ? randomUUID() : uuidFrom(`trajectory:${sessionId}:${turns}`);
    const step = Math.max(0, contents.length - 1);
    const toolChoice = typeof options?.toolChoice === "string" && options.toolChoice !== "auto" ? options.toolChoice : undefined;

    return {
        project,
        requestId: `agent/${cascade}/${Date.now()}/${trajectory}/${step + 1}`,
        request: {
            contents,
            ...(systemText === "" ? {} : { systemInstruction: { role: "user", parts: [{ text: sanitizeSurrogates(systemText) }] } }),
            ...(tools.length === 0 ? {} : { tools: convertTools(tools, claude, false) }),
            ...(tools.length === 0 || toolChoice === undefined ? {} : { toolConfig: { functionCallingConfig: { mode: mapToolChoice(toolChoice) } } }),
            labels: {
                cascade_id: cascade,
                last_step_index: String(step),
                model_enum: info.model ?? "",
                request_id: `${trajectory}-${calls}`,
                root_cascade_id: cascade,
                trajectory_id: trajectory,
                used_claude: String(claude),
                used_claude_conservative: String(claude),
                used_non_gemini_model: String(info.modelProvider !== "MODEL_PROVIDER_GOOGLE"),
            },
            generationConfig: generationConfig(info),
            sessionId: numericId(sessionId),
        },
        model: agyId,
        userAgent: "antigravity",
        requestType: "agent",
    };
}
