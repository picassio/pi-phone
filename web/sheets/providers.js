// Model providers: signing in and out, the models subagents may use besides their session's own, and the dialog a
// sign-in uses to ask for a code or a key.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t, tn, tx } from "../i18n.js";
import { api, attempt, closeSheet, closeSignIn, loadUsage, signInAnswered, store } from "../store.js";
import { UsageBars } from "../usage.js";
import { html, Icon, Loader, Sheet, Switch } from "../ui.js";
import { RefreshModels } from "../model-refresh.js";

/** How long a run waits for a provider's limit to clear, at most (`limit-gate.ts`, PP-135): hours, 0 is off. */
const LIMIT_WAIT = [0, 1, 6, 12, 24];

/**
 * The owner's choice of how long a run waits for a provider's limit rather than failing: until the provider's own reset,
 * up to this long. And whether the phone hears of a wait of 10 minutes or more.
 */
function LimitWait() {
    const hours = store.state.server?.limitWaitHours;
    const notice = store.state.server?.limitNotice;

    // A server that does not wait for limits sends none.
    if (typeof hours !== "number") {
        return null;
    }

    return html`<div class="limit-wait" data-part="limit-wait">
        <div class="small">${t("Wait for a limit")}</div>
        <p class="muted small">
            ${t("When a provider's limit stops a run, it waits until the provider's reset and goes on by itself, up to this long. A reset further away, billing, or an expired sign-in fails at once, with the reset time.")}
        </p>
        <div class="segmented" role="group" aria-label=${t("How long to wait for a limit")}>
            ${LIMIT_WAIT.map(
                (value) => html`<button class=${hours === value ? "on" : ""} aria-pressed=${hours === value} onClick=${() => attempt(() => api("settings", { limitWaitHours: value }))}>
                    ${value === 0 ? t("Off") : t("{n} h", { n: value })}
                </button>`,
            )}
        </div>
        <div class="limit-wait-notice">
            <span class="small">${t("Tell me when a run waits 10 minutes or more")}</span>
            <${Switch}
                on=${notice !== false}
                disabled=${hours === 0}
                label=${t("Tell me when a run waits 10 minutes or more")}
                onChange=${() => attempt(() => api("settings", { limitNotice: notice === false }))}
            />
        </div>
    </div>`;
}

/** Models past this many get a box to find them by. */
const MODEL_SEARCH_AT = 8;

/** This tab's changes to the models for subagents, one after another: their answers come back in the order sent. */
let saving = Promise.resolve();

/**
 * The owner's choice of the models Pi may start subagents on besides their session's own: every model, by provider,
 * each checked or not on its own. None, the default: subagents always run on their session's model, and Pi is offered
 * no model to pick. A tap sends that one model's change, not the whole list, so quick taps and other tabs keep theirs.
 * `names`: providers' names by id, once the sheet has them.
 */
function SubagentModels({ names }) {
    const { models, server } = store.state;
    const allowed = server?.subagentModels;
    // What this tab asked for and has no answer to yet, by model: shown at once.
    const [asked, setAsked] = useState({});
    const [query, setQuery] = useState("");

    // A server that does not keep the choice sends none.
    if (!Array.isArray(allowed)) {
        return null;
    }

    const specOf = (model) => `${model.provider}/${model.id}`;
    // Allowed models that are not signed in now are listed too, so they can be seen and taken off.
    const rows = [
        ...models.map((model) => ({ spec: specOf(model), model })),
        ...allowed
            .filter((spec) => !models.some((model) => specOf(model) === spec))
            .map((spec) => ({ spec, model: null })),
    ];
    const isOn = (spec) => asked[spec] ?? allowed.includes(spec);
    const chosen = rows.filter((row) => isOn(row.spec)).map((row) => row.model?.name ?? row.spec);
    const summary =
        chosen.length === 0
            ? t("None allowed: Pi never picks a model.")
            : tn(chosen.length, "{n} allowed: {list}", "{n} allowed: {list}", { list: chosen.join(", ") });
    const needle = query.trim().toLowerCase();
    const groups = new Map();

    for (const row of rows) {
        const provider = row.spec.slice(0, row.spec.indexOf("/"));
        const words = `${row.spec} ${row.model?.name ?? ""} ${names[provider] ?? ""}`;

        if (needle === "" || words.toLowerCase().includes(needle)) {
            groups.set(provider, [...(groups.get(provider) ?? []), row]);
        }
    }

    const toggle = (spec, on) => {
        setAsked((was) => ({ ...was, [spec]: on }));
        saving = saving.then(async () => {
            const answer = await attempt(() =>
                api("subagent-models", { model: spec, allowed: on }),
            );

            if (Array.isArray(answer?.subagentModels)) {
                store.set((state) => ({
                    server: { ...state.server, subagentModels: answer.subagentModels },
                }));
            }

            // Unless a later tap asked otherwise, what the server says shows now.
            setAsked((was) => {
                if (was[spec] !== on) {
                    return was;
                }

                const rest = { ...was };

                delete rest[spec];

                return rest;
            });
        });
    };

    return html`<div class="subagent-models">
        <div class="label">${t("Models for subagents")}</div>
        <p class="muted small">
            ${t("Subagents and linked sessions run on their session's model, the one people picked. Pi cannot choose another model unless you allow it here.")}
        </p>
        <p class="small subagent-models-chosen" title=${summary}>${summary}</p>
        ${
            (rows.length > MODEL_SEARCH_AT || query !== "") &&
            html`<label class="search">
                <${Icon} name="search" size=${16} />
                <input
                    placeholder=${t("Find a model")}
                    aria-label=${t("Find a model for subagents")}
                    value=${query}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                />
            </label>`
        }
        <div class="subagent-models-list" role="group" aria-label=${t("Models for subagents")}>
            ${
                groups.size === 0 &&
                html`<p class="muted small">
                    ${rows.length === 0 ? t("No models: sign in to a provider below.") : t("No model matches.")}
                </p>`
            }
            ${[...groups].map(
                ([provider, list]) => html`<div key=${provider}>
                    <div class="subagent-models-head">${names[provider] ?? provider}</div>
                    ${list.map(
                        ({ spec, model }) => html`<label class="subagent-model" key=${spec}>
                            <input
                                type="checkbox"
                                value=${spec}
                                checked=${isOn(spec)}
                                onChange=${(event) => toggle(spec, event.currentTarget.checked)}
                            />
                            <span>
                                ${model?.name ?? spec.slice(spec.indexOf("/") + 1)}
                                <span class="muted small">
                                    ${spec}
                                    ${
                                        !model
                                            ? html` · <span class="warn">${t("not signed in")}</span>`
                                            : model.signIn &&
                                              html` · <span class="warn">${t("needs sign-in")}</span>`
                                    }
                                </span>
                            </span>
                        </label>`,
                    )}
                </div>`,
            )}
        </div>
    </div>`;
}

export function ProvidersSheet() {
    const { me, auth } = store.state;
    const [providers, setProviders] = useState(null);
    const [query, setQuery] = useState("");
    const loginButton = useRef(null);
    const load = () => attempt(async () => setProviders(await api("providers")));

    useEffect(() => {
        load();
    }, [store.state.models]);
    // The plan limits of each signed-in subscription account (src/server/usage-limits.ts), as the sheet opens.
    useEffect(() => {
        void loadUsage();
    }, []);
    useLayoutEffect(() => {
        if (!auth) {
            loginButton.current?.focus();
            loginButton.current = null;
        }
    }, [auth]);
    const owner = me?.role === "owner";

    const login = (provider, type, button) => {
        loginButton.current = button;

        return attempt(() => api(`providers/${encodeURIComponent(provider.id)}/login`, { type }));
    };

    const logout = (provider) =>
        confirm(
            t("Log out of {name}? Pi uses the same sign-in, so it is signed out too.", { name: provider.name }),
        ) &&
        attempt(async () => {
            await api(`providers/${encodeURIComponent(provider.id)}/logout`, {});
            load();
        });
    const needle = query.trim().toLowerCase();
    const byId = new Map((providers ?? []).map((provider) => [provider.id, provider]));
    // A provider's accounts (accounts.ts) come right after it, by name: the family sorts as its original does.
    const family = (provider) => (provider.account ? (byId.get(provider.account.of) ?? provider) : provider);
    const list = (providers ?? [])
        .filter(
            (provider) =>
                needle === "" ||
                `${provider.id} ${provider.name} ${provider.oauth ?? ""}`.toLowerCase().includes(needle),
        )
        .sort((a, b) => {
            const [x, y] = [family(a), family(b)];

            return (
                Number(Boolean(y.needsSignIn)) - Number(Boolean(x.needsSignIn)) ||
                Number(y.configured) - Number(x.configured) ||
                x.name.localeCompare(y.name) ||
                Number(Boolean(a.account)) - Number(Boolean(b.account)) ||
                a.name.localeCompare(b.name)
            );
        });
    const hasAccounts = (provider) => (providers ?? []).some((each) => each.account?.of === provider.id);
    const [adding, setAdding] = useState(null);
    const [renaming, setRenaming] = useState(null);
    const [name, setName] = useState("");
    const addAccount = (provider) =>
        attempt(async () => {
            await api("accounts", { provider: provider.id, name });
            setAdding(null);
            setName("");
            load();
        });
    const renameAccount = (provider) =>
        attempt(async () => {
            await api(`accounts/${encodeURIComponent(provider.id)}`, { name });
            setRenaming(null);
            setName("");
            load();
        });
    // The team's accounts (PP-69): on the team server, managed there; these call its routes through this pi-phone.
    const [addingTeam, setAddingTeam] = useState(null);
    const addTeamAccount = (provider) =>
        attempt(async () => {
            await api("team-accounts", { provider: provider.id, name });
            setAddingTeam(null);
            setName("");
            load();
        });
    const renameTeamAccount = (provider) =>
        attempt(async () => {
            await api(`team-accounts/${encodeURIComponent(provider.id)}`, { name });
            setRenaming(null);
            setName("");
            load();
        });
    const teamLogin = (provider, type, button) => {
        loginButton.current = button;

        return attempt(() => api(`team-accounts/${encodeURIComponent(provider.id)}/login`, { type, name: provider.name }));
    };
    const teamLogout = (provider) =>
        confirm(t("Sign the team account “{name}” out? Everyone using its models needs another until it is signed in again.", { name: provider.account.name })) &&
        attempt(async () => {
            await api(`team-accounts/${encodeURIComponent(provider.id)}/logout`, {});
            load();
        });
    const removeTeamAccount = (provider) =>
        confirm(t("Remove the team account “{name}”? Its sign-in is deleted, and everyone's sessions on its models need another model.", { name: provider.account.name })) &&
        attempt(async () => {
            await api(`team-accounts/${encodeURIComponent(provider.id)}/remove`, {});
            load();
        });
    const removeAccount = (provider) =>
        confirm(t("Remove the account “{name}”? It is signed out, and sessions on its models need another model.", { name: provider.account.name })) &&
        attempt(async () => {
            await api(`accounts/${encodeURIComponent(provider.id)}/remove`, {});
            load();
        });
    /** The account's name, typed in place: for a new account of `provider`, or a new name for one. */
    const nameField = (onSave, label) => html`<div class="account-name row">
        <input
            autofocus
            aria-label=${label}
            placeholder=${t("Work")}
            maxlength="40"
            value=${name}
            onInput=${(event) => setName(event.currentTarget.value)}
            onKeyDown=${(event) => (event.key === "Enter" ? onSave() : event.key === "Escape" && (setAdding(null), setAddingTeam(null), setRenaming(null)))}
        />
        <button class="button small primary" disabled=${name.trim() === ""} onClick=${onSave}>${t("Save")}</button>
        <button class="button small" onClick=${() => (setAdding(null), setAddingTeam(null), setRenaming(null), setName(""))}>${t("Cancel")}</button>
    </div>`;

    return html`<${Sheet} title=${t("Providers")} onClose=${closeSheet}>
        <p class="muted small">
            ${tx("pi-phone shares Pi's sign-ins ({file}).", { file: html`<span class="mono">~/.pi/agent/auth.json</span>` })} ${owner ? "" : t("Only the owner can change them.")}
        </p>
        <${RefreshModels} />
        ${owner && html`<${LimitWait} />`}
        ${
            owner &&
            html`<${SubagentModels}
                names=${Object.fromEntries((providers ?? []).map((each) => [each.id, each.name]))}
            />`
        }
        ${store.state.auth && html`<${AuthDialog} inline=${true} />`}
        <label class="search">
            <${Icon} name="search" size=${16} />
            <input
                placeholder=${t("Search providers")}
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
        </label>
        ${providers === null && html`<${Loader} label=${t("Loading providers")} />`}
        <div class="sheet-list">
            ${
                providers !== null &&
                list.length === 0 &&
                needle !== "" &&
                html`<div class="launcher-empty" role="status">
                    <strong>${t("No providers match “{query}”.", { query: query.trim() })}</strong>
                    <button class="button" onClick=${() => setQuery("")}>${t("Clear search")}</button>
                </div>`
            }
            ${list.map(
                (provider) => provider.team ? html`<${TeamRow}
                    provider=${provider}
                    of=${family(provider).name}
                    renaming=${renaming === provider.id}
                    nameField=${nameField}
                    onLogin=${teamLogin}
                    onLogout=${teamLogout}
                    onRename=${() => (setAdding(null), setAddingTeam(null), setName(provider.account.name), setRenaming(provider.id))}
                    onRenamed=${() => renameTeamAccount(provider)}
                    onRemove=${removeTeamAccount}
                />` : html`<div class=${`provider ${provider.account ? "account" : ""} ${provider.account || provider.accounts ? "family" : ""}`}>
                    <div>
                        <div>
                            ${provider.account ? provider.account.name : provider.name}
                            ${!provider.account && hasAccounts(provider) && html` <span class="muted small">· ${t("Default account")}</span>`}
                            ${provider.account && html` <span class="muted small">· ${t("account of {name}", { name: family(provider).name })}</span>`}
                            ${
                                provider.needsSignIn
                                    ? html` <span class="warn provider-needs">${t("needs sign-in")}</span>`
                                    : provider.configured && html` <span class="ok">✓</span>`
                            }
                        </div>
                        <div class="muted small">
                            ${
                                provider.needsSignIn
                                    ? t("the sign-in expired and could not be renewed: sign in again. Until then, sessions on its models fail, and PiP and subagents on other models do not use them")
                                    : provider.configured
                                      ? provider.label || provider.source
                                          ? t("signed in · {detail}", { detail: provider.label ? provider.label : provider.source })
                                          : t("signed in")
                                      : t("not configured")
                            } · ${t("{n} models", { n: provider.models })}
                        </div>
                        ${
                            provider.needsSignIn &&
                            html`<div class="muted small mono provider-why">${provider.needsSignIn}</div>`
                        }
                        ${provider.configured && html`<${UsageBars} provider=${provider.id} />`}
                        ${adding === provider.id && nameField(() => addAccount(provider), t("New account's name"))}
                        ${
                            addingTeam === provider.id &&
                            html`${nameField(() => addTeamAccount(provider), t("New team account's name"))}
                                ${
                                    provider.teamAdd === "subscription" &&
                                    html`<p class="pv-team-warn small">
                                        <b>${t("A subscription is licensed to one person.")}</b> ${t("{name}'s plans are for one person's use: sharing one with a team may break its terms, and heavy use can get the account limited. An API key is made for this.", { name: provider.name })}
                                    </p>`
                                }`
                        }
                        ${renaming === provider.id && nameField(() => renameAccount(provider), t("Account's name"))}
                    </div>
                    ${
                        owner &&
                        html`<div class="provider-actions">
                            ${
                                provider.oauth &&
                                html`<button
                                    class="button small"
                                    onClick=${(event) => login(provider, "oauth", event.currentTarget)}
                                >
                                    ${provider.oauth}
                                </button>`
                            }
                            ${
                                provider.apiKey &&
                                html`<button
                                    class="button small"
                                    onClick=${(event) => login(provider, "api_key", event.currentTarget)}
                                >
                                    ${t("API key")}
                                </button>`
                            }
                            ${
                                provider.configured &&
                                provider.source === "stored" &&
                                html`<button
                                    class="button small ghost"
                                    onClick=${() => logout(provider)}
                                >
                                    ${t("Log out")}
                                </button>`
                            }
                            ${
                                provider.accounts &&
                                html`<button class="button small ghost" onClick=${() => (setRenaming(null), setAddingTeam(null), setName(""), setAdding(provider.id))}>
                                    ${t("Add account")}
                                </button>`
                            }
                            ${
                                provider.teamAdd &&
                                html`<button class="button small ghost" onClick=${() => (setRenaming(null), setAdding(null), setName(""), setAddingTeam(provider.id))}>
                                    ${t("Add team account")}
                                </button>`
                            }
                            ${
                                provider.account &&
                                html`<button class="button small ghost" onClick=${() => (setAdding(null), setName(provider.account.name), setRenaming(provider.id))}>${t("Rename")}</button>
                                    <button class="button small ghost" onClick=${() => removeAccount(provider)}>${t("Remove")}</button>`
                            }
                        </div>`
                    }
                </div>`,
            )}
        </div>
    <//>`;
}

/**
 * A team account (PP-69): under its provider, like an account of the person's own, marked TEAM. Its sign-in or key is on
 * the team server; someone who manages the team's accounts signs it in, out, renames and removes it here, and "Who can
 * use" opens the team server's Roles. Everyone else sees it without buttons.
 */
function TeamRow({ provider, of, renaming, nameField, onLogin, onLogout, onRename, onRenamed, onRemove }) {
    const { roles, manage } = provider.team;
    const who = roles.length === 0 ? t("no role uses it yet") : t("{roles} can use", { roles: roles.join(", ") });
    const models = provider.models;

    return html`<div class="provider account family pv-team">
        <div>
            <div>
                ${provider.account.name}${" "}
                <span class="pv-team-tag">${t("Team")}</span>${" "}
                <span class="muted small">· ${t("team account of {name}", { name: of })}</span>
                ${provider.configured && html` <span class="ok">✓</span>`}
            </div>
            <div class="muted small">
                ${
                    manage
                        ? provider.configured
                            ? t("signed in · on the team server · {n} models · {who}", { n: models, who })
                            : t("not signed in · on the team server · {n} models · {who}", { n: models, who })
                        : t("from your team · {n} models", { n: models })
                }
            </div>
            ${provider.configured && html`<${UsageBars} provider=${provider.id} />`}
            ${renaming && nameField(onRenamed, t("Team account's name"))}
        </div>
        ${
            manage &&
            html`<div class="provider-actions">
                ${provider.oauth && html`<button class="button small" onClick=${(event) => onLogin(provider, "oauth", event.currentTarget)}>${provider.oauth}</button>`}
                ${provider.apiKey && html`<button class="button small" onClick=${(event) => onLogin(provider, "api_key", event.currentTarget)}>${t("API key")}</button>`}
                ${provider.configured && html`<button class="button small ghost" onClick=${() => onLogout(provider)}>${t("Log out")}</button>`}
                <button class="button small ghost" onClick=${onRename}>${t("Rename")}</button>
                <a class="button small ghost" href="/auth/roles" target="_top">${t("Who can use")}</a>
                <button class="button small ghost" onClick=${() => onRemove(provider)}>${t("Remove")}</button>
            </div>`
        }
    </div>`;
}

/** A provider signs in in place; sign-ins requested elsewhere still get their own dialog. */
function AuthFrame({ title, onClose, inline, focusKey, children }) {
    const ref = useRef(null);
    const close = useRef(onClose);

    close.current = onClose;

    // The first question may arrive after the card mounts. Focus it then, not on every redraw while typing.
    useLayoutEffect(() => {
        if (inline) {
            const card = ref.current?.querySelector(".auth-card");
            const control =
                card?.querySelector(".field input:not(:disabled), .field button:not(:disabled)") ??
                card?.querySelector("a[href], button:not(:disabled)");

            (control ?? ref.current)?.focus({ preventScroll: true });
            ref.current?.scrollIntoView({ block: "nearest" });
        }
    }, [inline, focusKey]);
    useEffect(() => {
        if (!inline) {
            return undefined;
        }

        const escape = (event) => {
            if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
                event.stopImmediatePropagation();
                close.current();
            }
        };

        addEventListener("keydown", escape, true);

        return () => removeEventListener("keydown", escape, true);
    }, [inline]);

    const content = html`<div class="auth-card">${children}</div>`;

    return inline
        ? html`<section class="auth-inline" aria-label=${title} tabindex="-1" ref=${ref}>
            <div class="auth-inline-head">
                <strong>${title}</strong>
                <button class="icon-button" aria-label=${t("Close")} onClick=${onClose}>
                    <${Icon} name="close" size=${16} />
                </button>
            </div>
            ${content}
        </section>`
        : html`<${Sheet} title=${title} onClose=${onClose}>${content}<//>`;
}

export function AuthDialog({ inline = false }) {
    const { auth } = store.state;
    const [value, setValue] = useState("");

    // Each question starts empty, also one that came before the reply to the answer before it.
    useEffect(() => setValue(""), [auth?.flowId, auth?.prompt?.id]);

    if (!auth) {
        return null;
    }

    const answer = (payload) => {
        const { flowId, prompt: asked } = auth;

        if (asked.type === "secret" && payload.value?.trim() === "") {
            return;
        }

        return attempt(async () => {
            await api(`auth/${flowId}/${asked.id}`, payload);
            signInAnswered(flowId, asked.id);
        });
    };

    const close = () => {
        // Stop the sign-in on the server too, also while it waits without a question (an OAuth callback holds a port).
        if (!auth.done) {
            api(`auth/${encodeURIComponent(auth.flowId)}/cancel`, {}).catch(() => {});
        }

        closeSignIn(auth.flowId);
    };

    const prompt = auth.prompt;

    return html`<${AuthFrame}
        title=${t("Sign in: {name}", { name: auth.providerName })}
        onClose=${close}
        inline=${inline}
        focusKey=${`${auth.flowId}:${prompt?.id ?? auth.events.length}`}
    >
        ${(auth.done ? [] : auth.events).map((event) => {
            if (event.type === "auth_url") {
                return html`<div class="auth-event">
                    <a class="button primary wide" href=${event.url} target="_blank" rel="noopener">
                        ${t("Open the sign-in page")}
                    </a>
                    ${event.instructions && html`<p class="muted small">${event.instructions}</p>`}
                </div>`;
            }

            if (event.type === "device_code") {
                return html`<div class="auth-event">
                    <p>
                        ${tx("Enter this code at {link}", {
                            link: html`<a href=${event.verificationUri} target="_blank" rel="noopener">${event.verificationUri}</a>`,
                        })}
                    </p>
                    <div class="code-big">${event.userCode}</div>
                </div>`;
            }

            return html`<p class="muted small">
                ${event.message}
                ${event.links?.map(
                    (link) => html` <a href=${link.url} target="_blank" rel="noopener">
     ${link.label ?? link.url}
 </a>`,
                )}
            </p>`;
        })}
        ${
            prompt &&
            (prompt.type === "select"
                ? html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    ${prompt.options.map(
                        (option) =>
                            html`<button
                                class="list-item"
                                onClick=${() => answer({ value: option.id })}
                            >
                                <span>${option.label}</span>
                                <span class="muted small">${option.description ?? ""}</span>
                            </button>`,
                    )}
                </div>`
                : html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    <div class="row">
                        <input
                            type=${prompt.type === "secret" ? "password" : "text"}
                            aria-label=${prompt.message}
                            autocomplete="off"
                            placeholder=${prompt.placeholder ?? ""}
                            value=${value}
                            onInput=${(event) => setValue(event.currentTarget.value)}
                            onKeyDown=${(event) => event.key === "Enter" && answer({ value })}
                        />
                        <button
                            class="button primary"
                            disabled=${prompt.type === "secret" && value.trim() === ""}
                            onClick=${() => answer({ value })}
                        >
                            ${t("Continue")}
                        </button>
                    </div>
                </div>`)
        }
        ${!prompt && !auth.done && html`<${Loader} label=${t("Waiting for the provider")} />`}
        ${
            auth.done &&
            !auth.done.ok &&
            html`<div class="error-box">
                <p>${auth.done.details ? auth.done.error : t("Sign-in did not finish. Try again.")}</p>
                <details>
                    <summary>${t("Details")}</summary>
                    <p>${auth.done.details ?? auth.done.error}</p>
                </details>
                <button
                    class="button"
                    onClick=${() =>
                        attempt(async () => {
                            await api(`providers/${encodeURIComponent(auth.providerId)}/login`, {
                                type: auth.done.loginType ?? "oauth",
                            });
                            closeSignIn(auth.flowId);
                        })}
                >
                    ${t("Start again")}
                </button>
            </div>`
        }
    <//>`;
}
