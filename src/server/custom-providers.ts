/**
 * OpenAI-compatible providers the owner adds in Settings › Providers (PP-248, picassio/pi-phone#4): a name, a base URL,
 * an API key (none for a local server such as Ollama or LM Studio), extra headers, and models, found with the server's
 * `GET <base>/models` or typed by hand. They are Pi's own custom providers, in `~/.pi/agent/models.json`: the app reads
 * and writes that file, people do not. Every other entry in it stays as it was, and a change Pi would not accept is never
 * written, so a typo cannot empty the model list (`model-refresh.ts` checks the same before it publishes).
 *
 * The key is a secret (`secrets.ts`), and the file names it only: `"apiKey": "$NAME"`. Pi resolves `$NAME` from the
 * server's own environment (`process.env`), where secrets never are: a secret there would reach every command, tool and
 * machine the server starts. So the app gives Pi the secret's value as the provider's runtime API key
 * (`ModelRuntime.setRuntimeApiKey`), in memory only, which Pi uses before anything else for that provider: as the app
 * opens, after each change here, and whenever the secrets change. A secret that is removed takes its key away; the
 * provider's models are then not available until it is back. A plain `pi` run in a shell where `$NAME` is set reads the
 * same file and works too.
 *
 * Listed and editable here: the providers of the file with `api: "openai-completions"` and a base URL that are not Pi's
 * own. A key set by hand in another form (a literal, `!command`) is kept as it is unless a new one is given, and is
 * never shown.
 */
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HttpError } from "./errors.ts";
import { SECRET_NAME, type Secrets } from "./secrets.ts";

export const CUSTOM_API = "openai-completions";
/**
 * The key a provider without one has in the file. Pi lists a provider's models only when it has a key, and a local
 * server ignores this one (Pi's own docs give Ollama a dummy key the same way).
 */
export const NO_KEY = "no-key";
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const MAX_MODELS = 500;
const MAX_HEADERS = 20;
const MAX_TOKENS_LIMIT = 100_000_000;
const MAX_FOUND = 5_000;
/** How long a server has to list its models. */
const FIND_MS = 15_000;
/** The most of a model list read: OpenRouter's whole catalog is about 2 MB. */
const MAX_LIST_BYTES = 16 * 1024 * 1024;

export type CustomModel = {
    id: string;
    contextWindow?: number;
    maxTokens?: number;
    images: boolean;
    /**
     * It writes images in its answers (PP-275), so `image_generate` may use it: `output: ["text", "image"]` in the file,
     * as Pi's own image models say it. Only what the owner marks (or a server's list says) counts.
     */
    makesImages: boolean;
    reasoning: boolean;
};

export type CustomHeader = { name: string; value: string };

/** A provider's key as the app shows it: never a value. */
export type KeyView = { kind: "none" } | { kind: "secret"; name: string; missing: boolean } | { kind: "other" };

export type CustomProviderView = {
    id: string;
    name: string;
    baseUrl: string;
    key: KeyView;
    headers: CustomHeader[];
    models: CustomModel[];
    /** Whether Pi can use its models now (it has a key). */
    configured: boolean;
};

/** What to do with a provider's key. `new` is a value a person typed into the form; Pi gives only a secret's name. */
export type KeyChoice = { kind: "keep" } | { kind: "none" } | { kind: "secret"; name: string } | { kind: "new"; value: string };

export type SaveInput = {
    name: unknown;
    baseUrl: unknown;
    key: KeyChoice;
    /** Undefined: keep the headers as they are. */
    headers?: unknown;
    models: unknown;
};

/** A model a server listed, with what its answer said of it. */
export type FoundModel = CustomModel & { name?: string };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A key choice as a form or a tool sends it: `{ kind: "keep" | "none" }`, `{ kind: "secret", name }`, or, from a
 * person's form only (`typed`), `{ kind: "new", value }`.
 */
export function keyChoice(given: unknown, typed: boolean): KeyChoice {
    const kind = isObject(given) ? given.kind : undefined;

    if (kind === "keep" || kind === "none") {
        return { kind };
    }

    if (kind === "secret" && isObject(given) && typeof given.name === "string" && SECRET_NAME.test(given.name)) {
        return { kind, name: given.name };
    }

    if (kind === "new" && typed && isObject(given) && typeof given.value === "string" && given.value.trim() !== "") {
        return { kind, value: given.value };
    }

    throw new HttpError(400, "Give a key, a saved secret, or no key.");
}

/** The secret's name a provider's typed key is kept under: `LM_STUDIO_API_KEY` for `lm-studio`. */
export function keySecretName(id: string): string {
    const name = `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;

    return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** A provider's id from its name: lower case, ASCII, words joined by `-`. Empty when the name has no letters or digits. */
export function idFromName(name: string): string {
    return name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/, "");
}

/** The secret a key in the file names, when it is exactly `$NAME` or `${NAME}`. */
function namedSecret(apiKey: unknown): string | undefined {
    if (typeof apiKey !== "string") {
        return undefined;
    }

    const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(apiKey);

    return match === null ? undefined : (match[1] ?? match[2]);
}

/** A header's value as Pi reads it from the file: `$` and a leading `!` escaped, so it is sent as typed. */
function escapeValue(value: string): string {
    const escaped = value.replace(/\$/g, "$$$$");

    return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

/** A header's value in the file as a person reads it: `$$` and `$!` are what Pi sends, `$` and `!`. */
function unescapeValue(raw: string): string {
    return raw.replace(/\$([$!])/g, "$1");
}

/** A base URL from a form: http or https, without a trailing slash or a password in it. */
export function checkBaseUrl(given: unknown): string {
    if (typeof given !== "string" || given.trim() === "") {
        throw new HttpError(400, "Give the provider's base URL, like http://192.168.1.20:1234/v1.");
    }

    let url: URL;

    try {
        url = new URL(given.trim());
    } catch {
        throw new HttpError(400, "The base URL is not a web address: it starts with http:// or https://.");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new HttpError(400, "The base URL starts with http:// or https://.");
    }

    if (url.username !== "" || url.password !== "") {
        throw new HttpError(400, "The base URL has no user name or password in it: give the key in the API key field.");
    }

    if (url.search !== "" || url.hash !== "") {
        throw new HttpError(400, "The base URL has no query or fragment (? or #).");
    }

    return url.href.replace(/\/+$/, "");
}

function checkName(given: unknown): string {
    if (typeof given !== "string" || given.trim() === "" || given.trim().length > 60) {
        throw new HttpError(400, "A provider's name is 1 to 60 characters.");
    }

    return given.trim();
}

function count(given: unknown, what: string): number | undefined {
    if (given === undefined || given === null || given === "") {
        return undefined;
    }

    const value = typeof given === "string" ? Number(given.trim()) : given;

    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TOKENS_LIMIT) {
        throw new HttpError(400, `${what} is a whole number of tokens, or empty.`);
    }

    return value;
}

function flag(given: unknown): boolean {
    if (given === undefined || given === null) {
        return false;
    }

    if (typeof given !== "boolean") {
        throw new HttpError(400, "Image input, making images and reasoning are true or false.");
    }

    return given;
}

/** The models of a form: 1 to 500, each with an id and what is known of it. */
export function checkModels(given: unknown): CustomModel[] {
    if (!Array.isArray(given) || given.length === 0) {
        throw new HttpError(400, "Pick or type at least one model.");
    }

    if (given.length > MAX_MODELS) {
        throw new HttpError(400, `A provider has at most ${MAX_MODELS} models here.`);
    }

    const seen = new Set<string>();

    return given.map((each: unknown) => {
        const model = isObject(each) ? each : { id: each };
        const id = typeof model.id === "string" ? model.id.trim() : "";

        if (id === "" || id.length > 200 || /[\s\u0000-\u001f\u007f]/.test(id)) {
            throw new HttpError(400, "A model's id is 1 to 200 characters, without spaces.");
        }

        if (seen.has(id)) {
            throw new HttpError(400, `The model ${id} is listed twice.`);
        }

        seen.add(id);

        const contextWindow = count(model.contextWindow, "The context window");
        const maxTokens = count(model.maxTokens, "The most output");

        return {
            id,
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(maxTokens === undefined ? {} : { maxTokens }),
            images: flag(model.images),
            makesImages: flag(model.makesImages),
            reasoning: flag(model.reasoning),
        };
    });
}

/** Extra headers of a form: at most 20, names as HTTP has them, values on one line. */
export function checkHeaders(given: unknown): CustomHeader[] {
    const list = isObject(given) ? Object.entries(given).map(([name, value]) => ({ name, value })) : given;

    if (!Array.isArray(list)) {
        throw new HttpError(400, "Headers are a list of names and values.");
    }

    const rows = list
        .map((each: unknown) => (isObject(each) ? { name: String(each.name ?? "").trim(), value: String(each.value ?? "") } : { name: "", value: "" }))
        .filter((row) => row.name !== "" || row.value !== "");

    if (rows.length > MAX_HEADERS) {
        throw new HttpError(400, `At most ${MAX_HEADERS} headers.`);
    }

    const seen = new Set<string>();

    for (const row of rows) {
        if (!HEADER_NAME.test(row.name)) {
            throw new HttpError(400, `${row.name || "A header"} is not a header's name: letters, digits and - (X-Title).`);
        }

        if (seen.has(row.name.toLowerCase())) {
            throw new HttpError(400, `The header ${row.name} is given twice.`);
        }

        if (/[\r\n\u0000]/.test(row.value) || row.value.length > 2_000) {
            throw new HttpError(400, `The header ${row.name}'s value is one line of at most 2000 characters.`);
        }

        seen.add(row.name.toLowerCase());
    }

    return rows;
}

/** A positive whole number from a model list's answer, from the first field that has one. */
function firstCount(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_TOKENS_LIMIT) {
            return value;
        }
    }

    return undefined;
}

const words = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string").map((each) => each.toLowerCase()) : []);

/**
 * The models of a `GET /models` answer (`{ data: [{ id, … }] }`), with what the common servers say of them: OpenRouter's
 * `context_length`, `top_provider.max_completion_tokens`, `architecture.input_modalities` and `supported_parameters`,
 * Groq's `context_window`, vLLM's `max_model_len`, LM Studio's `max_context_length`, and `capabilities` lists.
 */
export function modelsOfAnswer(answer: unknown): FoundModel[] {
    const data = isObject(answer) ? answer.data : undefined;

    if (!Array.isArray(data)) {
        throw new HttpError(502, "The server's answer has no model list (data).");
    }

    const found = new Map<string, FoundModel>();

    for (const each of data.slice(0, MAX_FOUND)) {
        if (!isObject(each) || typeof each.id !== "string" || each.id.trim() === "" || /\s/.test(each.id.trim())) {
            continue;
        }

        const top = isObject(each.top_provider) ? each.top_provider : {};
        const architecture = isObject(each.architecture) ? each.architecture : {};
        const capabilities = words(each.capabilities);
        const parameters = words(each.supported_parameters);
        const inputs = [...words(architecture.input_modalities), ...words(each.input_modalities)];
        const outputs = [...words(architecture.output_modalities), ...words(each.output_modalities)];
        const contextWindow = firstCount(each.context_length, each.context_window, each.max_context_length, each.max_model_len, top.context_length);
        const maxTokens = firstCount(top.max_completion_tokens, each.max_completion_tokens, each.max_output_tokens);
        const name = typeof each.name === "string" && each.name.trim() !== "" && each.name.trim() !== each.id ? each.name.trim() : undefined;

        found.set(each.id.trim(), {
            id: each.id.trim(),
            ...(name === undefined ? {} : { name }),
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(maxTokens === undefined ? {} : { maxTokens }),
            images: inputs.includes("image") || capabilities.includes("vision"),
            makesImages: outputs.includes("image"),
            reasoning: parameters.includes("reasoning") || capabilities.includes("reasoning") || capabilities.includes("thinking"),
        });
    }

    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

type Options = {
    secrets: Secrets;
    models: () => ModelRuntime;
    /** Reload the models through the app's refresh (`ModelRefresh.refreshAfterChange`), which also tells every tab. */
    reload: () => Promise<unknown>;
    /** The tabs get the models again: after a key came or went. */
    changed: () => void;
    log: (line: string) => void;
    /** Pi's `models.json`; by default the one in Pi's agent folder. */
    file?: () => string;
    fetch?: typeof fetch;
};

export class CustomProviders {
    readonly #secrets: Secrets;
    readonly #models: () => ModelRuntime;
    readonly #reload: () => Promise<unknown>;
    readonly #changed: () => void;
    readonly #log: (line: string) => void;
    readonly #file: () => string;
    readonly #fetch: typeof fetch;
    /** The runtime keys given to Pi, by provider: what the secrets held then. */
    readonly #applied = new Map<string, string>();
    /** Changes to the file, one after another. */
    #queue: Promise<unknown> = Promise.resolve();
    #syncing: Promise<void> = Promise.resolve();

    constructor(options: Options) {
        this.#secrets = options.secrets;
        this.#models = options.models;
        this.#reload = options.reload;
        this.#changed = options.changed;
        this.#log = options.log;
        this.#file = options.file ?? (() => join(getAgentDir(), "models.json"));
        this.#fetch = options.fetch ?? fetch;
    }

    /** The file as it is: `{}` when there is none. Not plain JSON (comments, a typo): refused, so it is never rewritten. */
    #read(): Json {
        let text: string;

        try {
            text = readFileSync(this.#file(), "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return {};
            }

            throw new HttpError(500, "The model configuration could not be read.");
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
        } catch {
            throw new HttpError(409, "The model configuration has comments or is not valid JSON, so the app does not rewrite it.");
        }

        if (!isObject(parsed) || (parsed.providers !== undefined && !isObject(parsed.providers))) {
            throw new HttpError(409, "The model configuration is not in Pi's form, so the app does not rewrite it.");
        }

        return parsed;
    }

    /** The file's providers that are listed here, by id. */
    #entries(file: Json): [string, Json][] {
        const builtIn = new Set<string>(getBuiltinProviders());
        const providers = isObject(file.providers) ? file.providers : {};

        return Object.entries(providers).filter(
            (entry): entry is [string, Json] =>
                !builtIn.has(entry[0]) && isObject(entry[1]) && entry[1].api === CUSTOM_API && typeof entry[1].baseUrl === "string",
        );
    }

    #view(id: string, entry: Json): CustomProviderView {
        const secret = namedSecret(entry.apiKey);
        const key: KeyView =
            entry.apiKey === NO_KEY ? { kind: "none" } : secret !== undefined ? { kind: "secret", name: secret, missing: !this.#secrets.has(secret) } : { kind: "other" };
        const headers = isObject(entry.headers) ? Object.entries(entry.headers).map(([name, value]) => ({ name, value: unescapeValue(String(value)) })) : [];
        const models = (Array.isArray(entry.models) ? entry.models : []).filter(isObject).map((model) => {
            const contextWindow = firstCount(model.contextWindow);
            const maxTokens = firstCount(model.maxTokens);

            return {
                id: String(model.id),
                ...(contextWindow === undefined ? {} : { contextWindow }),
                ...(maxTokens === undefined ? {} : { maxTokens }),
                images: words(model.input).includes("image"),
                makesImages: words(model.output).includes("image"),
                reasoning: model.reasoning === true,
            };
        });
        let configured = false;

        try {
            configured = this.#models().hasConfiguredAuth(id);
        } catch {
            configured = false;
        }

        return { id, name: typeof entry.name === "string" && entry.name !== "" ? entry.name : id, baseUrl: String(entry.baseUrl), key, headers, models, configured };
    }

    /** Every provider listed here. */
    list(): CustomProviderView[] {
        return this.#entries(this.#read()).map(([id, entry]) => this.#view(id, entry));
    }

    /** The ids of the providers listed here; none when the file cannot be read. */
    ids(): Set<string> {
        try {
            return new Set(this.#entries(this.#read()).map(([id]) => id));
        } catch {
            return new Set();
        }
    }

    get(id: string): CustomProviderView {
        const found = this.list().find((each) => each.id === id);

        if (found === undefined) {
            throw new HttpError(404, `There is no OpenAI-compatible provider ${id}.`);
        }

        return found;
    }

    /** Add a provider (`create`: its id), or change one (its id). */
    save(id: string, input: SaveInput, create: boolean): Promise<CustomProviderView> {
        return this.#serial(async () => {
            const file = this.#read();
            const providers = isObject(file.providers) ? { ...file.providers } : {};
            const listed = new Map(this.#entries(file));
            const before = listed.get(id);

            if (create) {
                if (!ID.test(id)) {
                    throw new HttpError(400, "A provider's id is lower-case letters, digits and -, at most 40 (lm-studio).");
                }

                if (providers[id] !== undefined || this.#known(id) || (getBuiltinProviders() as string[]).includes(id)) {
                    throw new HttpError(409, `There is a provider ${id} already: give this one another name or id.`);
                }
            } else if (before === undefined) {
                throw new HttpError(404, `There is no OpenAI-compatible provider ${id}.`);
            }

            const name = checkName(input.name);
            const baseUrl = checkBaseUrl(input.baseUrl);
            const models = checkModels(input.models);
            const headers = input.headers === undefined ? undefined : checkHeaders(input.headers);
            const entry: Json = { ...(before ?? {}), name, baseUrl, api: CUSTOM_API };
            const secretName = keySecretName(id);
            let typed: string | undefined;

            switch (input.key.kind) {
                case "keep":
                    if (before === undefined) {
                        throw new HttpError(400, "Give a key, a saved secret, or no key.");
                    }

                    break;
                case "none":
                    entry.apiKey = NO_KEY;
                    break;
                case "secret":
                    if (!SECRET_NAME.test(input.key.name) || !this.#secrets.has(input.key.name)) {
                        throw new HttpError(400, `There is no secret ${input.key.name}: add it in Secrets first.`);
                    }

                    entry.apiKey = `$${input.key.name}`;
                    break;
                case "new":
                    // Another secret by this name is not this provider's to overwrite.
                    if (this.#secrets.has(secretName) && namedSecret(before?.apiKey) !== secretName) {
                        throw new HttpError(409, `A secret called ${secretName} exists already: choose it as a saved secret, or remove it in Secrets first.`);
                    }

                    typed = input.key.value.trim();
                    entry.apiKey = `$${secretName}`;
                    break;
            }

            if (headers !== undefined) {
                const old = isObject(before?.headers) ? before.headers : {};

                if (headers.length === 0) {
                    delete entry.headers;
                } else {
                    // A value as it was shown keeps its form in the file (a `$NAME` written by hand stays one).
                    entry.headers = Object.fromEntries(
                        headers.map(({ name: header, value }) => {
                            const raw = old[header];

                            return [header, typeof raw === "string" && unescapeValue(raw) === value ? raw : escapeValue(value)];
                        }),
                    );
                }
            }

            const oldModels = (Array.isArray(before?.models) ? before.models : []).filter(isObject);

            entry.models = models.map((model) => {
                // What else a model had (a name, costs, compat) stays.
                const next: Json = { ...(oldModels.find((each) => each.id === model.id) ?? {}), id: model.id };

                for (const [field, value] of [["contextWindow", model.contextWindow], ["maxTokens", model.maxTokens]] as const) {
                    if (value === undefined) {
                        delete next[field];
                    } else {
                        next[field] = value;
                    }
                }

                if (model.images) {
                    next.input = ["text", "image"];
                } else if (words(next.input).includes("image")) {
                    delete next.input;
                }

                if (model.makesImages) {
                    next.output = ["text", "image"];
                } else if (words(next.output).includes("image")) {
                    delete next.output;
                }

                if (model.reasoning) {
                    next.reasoning = true;
                } else {
                    delete next.reasoning;
                }

                return next;
            });
            providers[id] = entry;

            const next = { ...file, providers };

            await this.#check(next, id);

            // The key before the file: a value the secrets refuse (too short) leaves both as they were.
            if (typed !== undefined) {
                this.#secrets.set(secretName, { value: typed, description: `API key of the provider ${name} (Settings › Providers)` });
            }

            this.#write(next);
            await this.#publish();

            return this.get(id);
        });
    }

    /** Take a provider out of the file. Its secret stays in Secrets. */
    remove(id: string): Promise<void> {
        return this.#serial(async () => {
            const file = this.#read();

            if (!new Map(this.#entries(file)).has(id)) {
                throw new HttpError(404, `There is no OpenAI-compatible provider ${id}.`);
            }

            const providers = { ...(file.providers as Json) };

            delete providers[id];

            const next = { ...file, providers };

            await this.#check(next);
            this.#write(next);
            await this.#publish();
        });
    }

    /**
     * Ask a server for its models (`GET <base>/models`), with a key: one typed now, a saved secret, the key of a provider
     * here (`keep`, with its id), or none. The key is sent to that server only, and no answer carries it back.
     */
    async findModels(input: { baseUrl: unknown; headers?: unknown; key: KeyChoice; id?: string }): Promise<FoundModel[]> {
        const baseUrl = checkBaseUrl(input.baseUrl);
        const headers = checkHeaders(input.headers ?? []);
        let key: string | undefined;

        switch (input.key.kind) {
            case "none":
                break;
            case "new":
                key = input.key.value.trim() || undefined;
                break;
            case "secret":
                key = this.#secrets.value(input.key.name);

                if (key === undefined) {
                    throw new HttpError(400, `There is no secret ${input.key.name}: add it in Secrets first.`);
                }

                break;
            case "keep": {
                const id = input.id ?? "";

                this.get(id);

                // As Pi resolves it for a request: a runtime key from the secrets, or a key set by hand in the file.
                // None (no secret, no key): asked without one, as Pi would not ask at all.
                let resolved: string | undefined;

                try {
                    resolved = (await this.#models().getAuth(id))?.auth.apiKey;
                } catch {
                    throw new HttpError(400, "This provider's key could not be read: give a key, or pick a saved secret.");
                }

                key = resolved === NO_KEY ? undefined : resolved;
                break;
            }
        }

        const url = `${baseUrl}/models`;
        let response: Response;

        try {
            response = await this.#fetch(url, {
                headers: {
                    accept: "application/json",
                    ...Object.fromEntries(headers.map(({ name, value }) => [name, value])),
                    ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
                },
                redirect: "follow",
                signal: AbortSignal.timeout(FIND_MS),
            });
        } catch {
            throw new HttpError(502, `Could not reach ${url}. Check the address, and that the server is running.`);
        }

        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            if (response.status === 401 || response.status === 403) {
                throw new HttpError(502, `${url} answered ${response.status}: check the API key.`);
            }

            throw new HttpError(502, `${url} answered ${response.status}.`);
        }

        const length = Number(response.headers.get("content-length") ?? 0);

        if (length > MAX_LIST_BYTES) {
            await response.body?.cancel().catch(() => {});
            throw new HttpError(502, "The server's model list is too long to read.");
        }

        const text = await response.text();

        if (text.length > MAX_LIST_BYTES) {
            throw new HttpError(502, "The server's model list is too long to read.");
        }

        let answer: unknown;

        try {
            answer = JSON.parse(text);
        } catch {
            throw new HttpError(502, `${url} did not answer with JSON: is this the API's base URL (it often ends in /v1)?`);
        }

        return modelsOfAnswer(answer);
    }

    /**
     * Give Pi each listed provider's key from the secrets, as its runtime API key, and take away the ones whose secret
     * or provider went. Runs as the app opens, after each change here, and when the secrets change.
     */
    sync(): Promise<void> {
        this.#syncing = this.#syncing.then(() => this.#sync());

        return this.#syncing;
    }

    async #sync(): Promise<void> {
        const models = this.#models();
        const wanted = new Map<string, string>();
        let file: Json;

        try {
            file = this.#read();
        } catch (error) {
            // A file the app cannot read (comments, a typo) changes nothing here: the keys given stay as they were.
            this.#log(`custom providers: ${(error as Error).message}`);

            return;
        }

        for (const [id, entry] of this.#entries(file)) {
            const name = namedSecret(entry.apiKey);
            const value = name === undefined ? undefined : this.#secrets.value(name);

            if (value !== undefined) {
                wanted.set(id, value);
            }
        }

        let changed = false;

        for (const [id, value] of wanted) {
            if (this.#applied.get(id) !== value) {
                try {
                    await models.setRuntimeApiKey(id, value);
                    this.#applied.set(id, value);
                    changed = true;
                } catch (error) {
                    // The provider's name only: the error can hold the key.
                    this.#log(`custom providers: ${id}'s key was not given to Pi (${(error as Error).name})`);
                }
            }
        }

        for (const id of [...this.#applied.keys()]) {
            if (!wanted.has(id)) {
                await models.removeRuntimeApiKey(id).catch(() => undefined);
                this.#applied.delete(id);
                changed = true;
            }
        }

        if (changed) {
            this.#changed();
        }
    }

    /** Whether Pi has a provider by this id that is not one of the file's (an account, a team account, an extension's). */
    #known(id: string): boolean {
        try {
            return this.#models().getProvider(id) !== undefined;
        } catch {
            return false;
        }
    }

    /**
     * Pi's own check of a file before it is written, loaded as Pi loads it (no sign-ins, no network): a file it would not
     * load is refused, and so is a provider `id` it would not compose; nothing changes then. A problem another provider
     * of the file had before is that provider's, and does not stop this change.
     */
    async #check(next: Json, id?: string): Promise<void> {
        const dir = mkdtempSync(join(tmpdir(), "pi-phone-models-"));

        try {
            const path = join(dir, "models.json");

            writeFileSync(path, JSON.stringify(next), { mode: 0o600 });

            const runtime = await ModelRuntime.create({
                modelsPath: path,
                modelsStorePath: join(dir, "models-store.json"),
                authPath: join(dir, "auth.json"),
                refreshOnCreate: false,
            });
            const said = runtime.getError() ?? "";
            const schema = /(?:Invalid models\.json schema|Failed to (?:load|parse) models\.json):?\s*([\s\S]*?)\n\nFile:/.exec(said);
            const composed = id === undefined ? null : new RegExp(`^Provider "${id}": (.+)$`, "m").exec(said);
            const problem = schema !== null ? schema[1]!.replace(/\s+/g, " ").trim() : composed?.[1];

            if (problem !== undefined) {
                throw new HttpError(400, `Pi would not accept this provider: ${problem.slice(0, 300)}`);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    #write(next: Json): void {
        const path = this.#file();
        const temporary = `${path}.${process.pid}.tmp`;

        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, path);
    }

    async #publish(): Promise<void> {
        await this.#reload();
        await this.sync();
        this.#changed();
    }

    #serial<T>(run: () => Promise<T>): Promise<T> {
        const next = this.#queue.then(run, run);

        this.#queue = next.catch(() => undefined);

        return next;
    }
}
