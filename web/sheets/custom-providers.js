// OpenAI-compatible providers (src/server/custom-providers.ts, PP-248): a server the owner names with a base URL, an API
// key (none for a local one), extra headers and models, found with its /models or typed. The app keeps them in Pi's
// model configuration and the key in Secrets; their models join the pickers. In the Providers sheet, for the owner.
import { useEffect, useState } from "preact/hooks";
import { t, tn } from "../i18n.js";
import { api, attempt } from "../store.js";
import { html, Icon, Loader } from "../ui.js";

/** Found models past this many get a box to find them by. */
const FIND_AT = 8;

/** A provider's id from its name, as the server makes it: lower case, ASCII, words joined by `-`. */
function idFromName(name) {
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

/** The secret a typed key is kept in, as the server names it. */
function keySecretName(id) {
    const name = `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;

    return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** Whether a base URL is one the server takes: http or https. */
function webAddress(value) {
    try {
        const url = new URL(value.trim());

        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

/** A provider's key, in words. */
function keyWords(provider) {
    if (provider.key.kind === "none") {
        return t("no key");
    }

    if (provider.key.kind === "secret") {
        return provider.key.missing && !provider.configured ? t("its secret {name} is missing", { name: provider.key.name }) : t("key in {name}", { name: provider.key.name });
    }

    return t("key set outside the app");
}

/** A number field of a model: tokens, or empty for Pi's default. */
function TokensField({ label, value, onChange }) {
    return html`<label class="cp-tokens">
        <span class="muted small">${label}</span>
        <input
            inputmode="numeric"
            aria-label=${label}
            placeholder=${t("default")}
            value=${value ?? ""}
            onInput=${(event) => {
                const digits = event.currentTarget.value.replace(/[^0-9]/g, "");

                onChange(digits === "" ? undefined : Number(digits));
            }}
        />
    </label>`;
}

/** The form for a new provider (`provider` undefined) or a change to one. */
function ProviderForm({ provider, secrets, onDone }) {
    const isNew = provider === undefined;
    const [name, setName] = useState(provider?.name ?? "");
    const [id, setId] = useState(provider?.id ?? "");
    const [idTyped, setIdTyped] = useState(false);
    const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
    // keep (a change), none, new (typed here), secret (a saved one).
    const [keyKind, setKeyKind] = useState(isNew ? "new" : "keep");
    const [keyValue, setKeyValue] = useState("");
    const [keySecret, setKeySecret] = useState(provider?.key.kind === "secret" ? provider.key.name : (secrets[0] ?? ""));
    const [headers, setHeaders] = useState(provider?.headers ?? []);
    const [models, setModels] = useState(provider?.models ?? []);
    const [found, setFound] = useState(null);
    const [finding, setFinding] = useState(false);
    const [findError, setFindError] = useState("");
    const [filter, setFilter] = useState("");
    const [typedModel, setTypedModel] = useState("");
    const [busy, setBusy] = useState(false);
    const shownId = isNew ? (idTyped ? id : idFromName(name)) : provider.id;
    const urlOk = webAddress(baseUrl);
    const key = () =>
        keyKind === "new"
            ? { kind: "new", value: keyValue }
            : keyKind === "secret"
              ? { kind: "secret", name: keySecret }
              : { kind: keyKind };
    const keyOk = keyKind === "new" ? keyValue.trim().length >= 8 : keyKind === "secret" ? keySecret !== "" : true;
    const has = (modelId) => models.some((model) => model.id === modelId);
    const change = (modelId, patch) => setModels((list) => list.map((model) => (model.id === modelId ? { ...model, ...patch } : model)));
    const toggle = (model, on) =>
        setModels((list) => (on ? (list.some((each) => each.id === model.id) ? list : [...list, { id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, images: model.images, makesImages: model.makesImages, reasoning: model.reasoning }]) : list.filter((each) => each.id !== model.id)));
    const addTyped = () => {
        const typed = typedModel.trim();

        if (typed !== "" && !/\s/.test(typed) && !has(typed)) {
            setModels((list) => [...list, { id: typed, images: false, makesImages: false, reasoning: false }]);
        }

        setTypedModel("");
    };
    const find = async () => {
        setFinding(true);
        setFindError("");

        try {
            const answer = await api("custom-providers/discover", {
                baseUrl,
                headers,
                key: keyKind === "new" && keyValue.trim() === "" ? { kind: "none" } : key(),
                ...(isNew ? {} : { id: provider.id }),
            });

            setFound(answer.models);
        } catch (error) {
            setFound(null);
            setFindError(error.message ?? String(error));
        } finally {
            setFinding(false);
        }
    };
    const save = () =>
        attempt(async () => {
            setBusy(true);

            try {
                const body = { name, baseUrl, key: key(), headers, models };

                await (isNew ? api("custom-providers", { ...body, id: shownId }) : api(`custom-providers/${encodeURIComponent(provider.id)}`, body, { method: "PUT" }));
                onDone(true);
            } finally {
                setBusy(false);
            }
        });
    const needle = filter.trim().toLowerCase();
    const shown = (found ?? []).filter((model) => needle === "" || `${model.id} ${model.name ?? ""}`.toLowerCase().includes(needle));
    const kinds = [...(isNew ? [] : [["keep", t("As it is")]]), ["new", isNew ? t("A key") : t("New key")], ["none", t("No key")], ...(secrets.length > 0 ? [["secret", t("Saved secret")]] : [])];

    return html`<div class="cp-form" data-part="custom-provider-form">
        <div class="field">
            <div class="label">${t("Name")}</div>
            <input
                autofocus
                aria-label=${t("Provider's name")}
                placeholder="LM Studio"
                maxlength="60"
                value=${name}
                onInput=${(event) => setName(event.currentTarget.value)}
            />
            ${
                isNew
                    ? html`<label class="cp-id">
                          <span class="muted small">${t("Id")}</span>
                          <input
                              class="mono"
                              aria-label=${t("Provider's id")}
                              placeholder="lm-studio"
                              maxlength="40"
                              value=${shownId}
                              onInput=${(event) => {
                                  setIdTyped(true);
                                  setId(event.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
                              }}
                          />
                      </label>
                      <p class="muted small">${t("Its models are {id}/<model> in sessions. The id stays once it is made.", { id: shownId || "id" })}</p>`
                    : html`<p class="muted small mono">${provider.id}</p>`
            }
        </div>
        <div class="field">
            <div class="label">${t("Base URL")}</div>
            <input
                class="mono"
                type="url"
                inputmode="url"
                aria-label=${t("Base URL")}
                placeholder="http://192.168.1.20:1234/v1"
                value=${baseUrl}
                onInput=${(event) => setBaseUrl(event.currentTarget.value)}
            />
            ${
                baseUrl.trim() !== "" && !urlOk
                    ? html`<p class="warn small">${t("A base URL starts with http:// or https://.")}</p>`
                    : html`<p class="muted small">${t("The address of its OpenAI-compatible API, often ending in /v1: LM Studio, Ollama, vLLM, OpenRouter, a proxy.")}</p>`
            }
        </div>
        <div class="field">
            <div class="label">${t("API key")}</div>
            <div class="segmented" role="group" aria-label=${t("API key")}>
                ${kinds.map(([kind, label]) => html`<button type="button" class=${keyKind === kind ? "on" : ""} aria-pressed=${keyKind === kind} onClick=${() => setKeyKind(kind)}>${label}</button>`)}
            </div>
            ${
                keyKind === "new" &&
                html`<input
                        type="password"
                        class="mono"
                        autocomplete="off"
                        aria-label=${t("The API key")}
                        placeholder="sk-…"
                        value=${keyValue}
                        onInput=${(event) => setKeyValue(event.currentTarget.value)}
                    />
                    <p class="muted small">${t("Kept in Secrets as {name}; the model configuration names it only. At least 8 characters.", { name: keySecretName(shownId || "id") })}</p>`
            }
            ${
                keyKind === "secret" &&
                html`<select aria-label=${t("Saved secret")} value=${keySecret} onChange=${(event) => setKeySecret(event.currentTarget.value)}>
                    ${secrets.map((secret) => html`<option value=${secret}>${secret}</option>`)}
                </select>`
            }
            ${keyKind === "none" && html`<p class="muted small">${t("For a server on your network that needs none, such as Ollama or LM Studio.")}</p>`}
            ${keyKind === "keep" && html`<p class="muted small">${keyWords(provider)}</p>`}
        </div>
        <div class="field">
            <div class="label">${t("Extra headers")}</div>
            ${headers.map(
                (header, index) => html`<div class="row cp-header" key=${index}>
                    <input
                        class="mono"
                        aria-label=${t("Header name")}
                        placeholder="X-Title"
                        value=${header.name}
                        onInput=${(event) => setHeaders((list) => list.map((each, at) => (at === index ? { ...each, name: event.currentTarget.value } : each)))}
                    />
                    <input
                        class="mono"
                        aria-label=${t("Header value")}
                        placeholder=${t("value")}
                        value=${header.value}
                        onInput=${(event) => setHeaders((list) => list.map((each, at) => (at === index ? { ...each, value: event.currentTarget.value } : each)))}
                    />
                    <button class="icon-button" aria-label=${t("Remove header")} onClick=${() => setHeaders((list) => list.filter((_, at) => at !== index))}>
                        <${Icon} name="close" size=${16} />
                    </button>
                </div>`,
            )}
            <button class="button small ghost cp-add" onClick=${() => setHeaders((list) => [...list, { name: "", value: "" }])}>
                <${Icon} name="plus" size=${14} /> ${t("Add header")}
            </button>
            <p class="muted small">${t("Kept as typed in the model configuration: put a key in the API key field, not here.")}</p>
        </div>
        <div class="field">
            <div class="label">${t("Models")}</div>
            <div class="row cp-find">
                <button class="button small" disabled=${!urlOk || finding || (keyKind === "secret" && keySecret === "")} onClick=${find}>
                    <${Icon} name="search" size=${14} /> ${finding ? t("Finding…") : t("Find models")}
                </button>
                <span class="muted small">${t("Asks the server's /models.")}</span>
            </div>
            ${findError !== "" && html`<p class="warn small" role="alert">${findError}</p>`}
            ${finding && html`<${Loader} label=${t("Asking the server for its models")} />`}
            ${
                found !== null &&
                html`${
                    found.length > FIND_AT &&
                    html`<label class="search">
                        <${Icon} name="search" size=${16} />
                        <input placeholder=${t("Find a model")} aria-label=${t("Find a model the server has")} value=${filter} onInput=${(event) => setFilter(event.currentTarget.value)} />
                    </label>`
                }
                    <div class="subagent-models-list cp-found" role="group" aria-label=${t("Models the server has")}>
                        ${found.length === 0 && html`<p class="muted small">${t("The server lists no models: type their ids below.")}</p>`}
                        ${found.length > 0 && shown.length === 0 && html`<p class="muted small">${t("No model matches.")}</p>`}
                        ${shown.map(
                            (model) => html`<label class="subagent-model" key=${model.id}>
                                <input type="checkbox" checked=${has(model.id)} onChange=${(event) => toggle(model, event.currentTarget.checked)} />
                                <span>
                                    ${model.name ?? model.id}
                                    <span class="muted small">
                                        ${[model.name ? model.id : "", model.contextWindow ? t("{n} context", { n: model.contextWindow.toLocaleString() }) : "", model.images ? t("images") : "", model.makesImages ? t("makes images") : "", model.reasoning ? t("reasoning") : ""].filter(Boolean).join(" · ")}
                                    </span>
                                </span>
                            </label>`,
                        )}
                    </div>`
            }
            <div class="row cp-typed">
                <input
                    class="mono"
                    aria-label=${t("A model's id")}
                    placeholder=${t("Or type a model's id")}
                    value=${typedModel}
                    onInput=${(event) => setTypedModel(event.currentTarget.value)}
                    onKeyDown=${(event) => event.key === "Enter" && addTyped()}
                />
                <button class="button small" disabled=${typedModel.trim() === ""} onClick=${addTyped}>${t("Add")}</button>
            </div>
            ${
                models.length > 0 &&
                html`<div class="cp-models">
                    <div class="muted small">${tn(models.length, "{n} model chosen", "{n} models chosen")}</div>
                    ${models.map(
                        (model) => html`<div class="cp-model" key=${model.id}>
                            <div class="cp-model-head">
                                <span class="mono">${model.id}</span>
                                <button class="icon-button" aria-label=${t("Remove {model}", { model: model.id })} onClick=${() => toggle(model, false)}>
                                    <${Icon} name="close" size=${16} />
                                </button>
                            </div>
                            <div class="cp-model-fields">
                                <${TokensField} label=${t("Context window")} value=${model.contextWindow} onChange=${(value) => change(model.id, { contextWindow: value })} />
                                <${TokensField} label=${t("Most output")} value=${model.maxTokens} onChange=${(value) => change(model.id, { maxTokens: value })} />
                                <label class="check">
                                    <input type="checkbox" checked=${model.images} onChange=${(event) => change(model.id, { images: event.currentTarget.checked })} />
                                    ${t("Image input")}
                                </label>
                                <label class="check" title=${t("It writes images in its answers, so Pi's image_generate may use it (Menu › Images)")}>
                                    <input type="checkbox" checked=${model.makesImages === true} onChange=${(event) => change(model.id, { makesImages: event.currentTarget.checked })} />
                                    ${t("Makes images")}
                                </label>
                                <label class="check">
                                    <input type="checkbox" checked=${model.reasoning} onChange=${(event) => change(model.id, { reasoning: event.currentTarget.checked })} />
                                    ${t("Reasoning")}
                                </label>
                            </div>
                        </div>`,
                    )}
                </div>`
            }
        </div>
        <div class="sheet-actions">
            <button class="button" onClick=${() => onDone(false)}>${t("Cancel")}</button>
            <button class="button primary" disabled=${busy || name.trim() === "" || shownId === "" || !urlOk || !keyOk || models.length === 0} onClick=${save}>
                ${busy ? t("Saving…") : t("Save")}
            </button>
        </div>
    </div>`;
}

/** The owner's OpenAI-compatible providers, each with Edit and Remove, and Add. `changed`: the models changed. */
export function CustomProviders({ changed }) {
    const [state, setState] = useState(null);
    const [editing, setEditing] = useState(null);
    const load = () =>
        attempt(async () => {
            const answer = await api("custom-providers");

            setState(answer);
        });

    useEffect(() => {
        load();
    }, [changed]);

    const remove = (provider) =>
        confirm(t("Remove {name}? Sessions on its models need another model. Its key stays in Secrets.", { name: provider.name })) &&
        attempt(async () => {
            await api(`custom-providers/${encodeURIComponent(provider.id)}`, undefined, { method: "DELETE" });
            load();
        });
    const done = (saved) => {
        setEditing(null);

        if (saved) {
            load();
        }
    };

    return html`<div class="custom-providers" data-part="custom-providers">
        <div class="label">${t("OpenAI-compatible providers")}</div>
        <p class="muted small">${t("A server that speaks OpenAI's API, on your network or the web. Its models join the model pickers; its key is kept in Secrets.")}</p>
        ${state === null && html`<${Loader} label=${t("Loading providers")} />`}
        ${
            state !== null &&
            state.providers.length > 0 &&
            html`<div class="sheet-list">
                ${state.providers.map((provider) =>
                    editing === provider.id
                        ? html`<div class="provider family" key=${provider.id}>
                              <${ProviderForm} provider=${provider} secrets=${state.secrets} onDone=${done} />
                          </div>`
                        : html`<div class="provider family" key=${provider.id}>
                              <div>
                                  <div>${provider.name} ${provider.configured ? html`<span class="ok">✓</span>` : html`<span class="warn provider-needs">${t("no key")}</span>`}</div>
                                  <div class="muted small cp-url mono">${provider.baseUrl}</div>
                                  <div class="muted small">${keyWords(provider)} · ${t("{n} models", { n: provider.models.length })}</div>
                              </div>
                              <div class="provider-actions">
                                  <button class="button small" onClick=${() => setEditing(provider.id)}>${t("Edit")}</button>
                                  <button class="button small ghost" onClick=${() => remove(provider)}>${t("Remove")}</button>
                              </div>
                          </div>`,
                )}
            </div>`
        }
        ${
            state !== null &&
            (editing === "new"
                ? html`<div class="provider family"><${ProviderForm} secrets=${state.secrets} onDone=${done} /></div>`
                : html`<button class="button small cp-add" onClick=${() => setEditing("new")}>
                      <${Icon} name="plus" size=${14} /> ${t("Add an OpenAI-compatible provider")}
                  </button>`)
        }
    </div>`;
}
