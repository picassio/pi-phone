// Settings › Web access (src/server/web/access.ts): the search provider `web_search` uses, and what it needs — a Pi
// sign-in, a key (kept in Settings › Secrets), or an address — with a test search. Off until a provider is picked.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, openSheet } from "../store.js";
import { Choice, html, Loader, Sheet } from "../ui.js";
import { t, tx } from "../i18n.js";

/** What a provider's key is: the secret it reads, whether it is optional, and whether it is there. */
function keyLine(key, missing) {
    const name = html`<span class="mono">${key.secret}</span>`;

    if (key.optional) {
        return missing ? tx("Key: the secret {name} (optional).", { name }) : tx("Key: the secret {name} (optional) ✓.", { name });
    }

    return missing ? tx("Key: the secret {name}.", { name }) : tx("Key: the secret {name} ✓.", { name });
}

/** What a test search found: how many, how fast, and the first one's title. */
function testLine(test) {
    const vars = { n: test.results.length, seconds: (test.ms / 1000).toFixed(1), title: test.results[0]?.title };

    return test.results[0] ? t("{n} results in {seconds} s: {title}", vars) : t("{n} results in {seconds} s", vars);
}

function KeyField({ provider, onSaved }) {
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const save = () =>
        attempt(async () => {
            setBusy(true);

            try {
                await api(
                    `secrets/${encodeURIComponent(provider.key.secret)}`,
                    { value, description: `${provider.name} web search` },
                    { method: "PUT" },
                );
                setValue("");
                onSaved();
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="row">
        <input
            type="password"
            class="mono"
            autocomplete="off"
            aria-label=${t("{provider} key", { provider: provider.name })}
            placeholder=${provider.missing ? t("Paste its key") : t("Saved; paste to replace it")}
            value=${value}
            onInput=${(event) => setValue(event.currentTarget.value)}
        />
        <button class="button small primary" disabled=${busy || value.length < 8} onClick=${save}>${t("Save")}</button>
    </div>`;
}

function EndpointField({ provider, onSaved }) {
    const [value, setValue] = useState(provider.endpoint.value ?? "");
    const save = () =>
        attempt(async () => {
            await api("web-access", { endpoints: { [provider.id]: value.trim() === "" ? null : value.trim() } }, { method: "PUT" });
            onSaved();
        });

    return html`<div class="field">
        <div class="label">${provider.endpoint.label}</div>
        <div class="row">
            <input
                class="mono"
                aria-label=${provider.endpoint.label}
                placeholder=${provider.endpoint.default ?? "https://…"}
                value=${value}
                onInput=${(event) => setValue(event.currentTarget.value)}
            />
            <button class="button small" disabled=${value.trim() === (provider.endpoint.value ?? "")} onClick=${save}>${t("Save")}</button>
        </div>
    </div>`;
}

export function WebAccessSheet() {
    const [state, setState] = useState(null);
    const [test, setTest] = useState(null);
    const load = () => api("web-access").then(setState);

    useEffect(() => {
        attempt(load);
    }, []);

    const pick = (id) =>
        attempt(async () => {
            setTest(null);
            setState(await api("web-access", { provider: id === "" ? null : id }, { method: "PUT" }));
        });
    const runTest = () =>
        attempt(async () => {
            setTest({ running: true });
            setTest(await api("web-access/test", {}));
        });
    const chosen = state?.providers.find((provider) => provider.id === state.provider);

    return html`<${Sheet} title=${t("Web access")} onClose=${closeSheet}>
        <p class="muted small">
            ${tx("The search provider Pi's {search} uses. Pi reads pages, documents, and GitHub with {fetch} without one. Model providers use your sign-in from Settings › Providers; the others use a key kept in Settings › Secrets.", { search: html`<span class="mono">web_search</span>`, fetch: html`<span class="mono">fetch_content</span>` })}
        </p>
        ${!state && html`<${Loader} label=${t("Loading providers")} />`}
        ${
            state &&
            html`<div class="field">
                <div class="label">${t("Search provider")}</div>
                <${Choice}
                    label=${t("Search provider")}
                    value=${state.provider ?? ""}
                    options=${[
                        { value: "", label: t("Off: no web search") },
                        ...state.providers.map((provider) => ({
                            value: provider.id,
                            label: provider.name,
                            detail: [provider.missing ? t("not set up") : "", provider.price ?? ""].filter(Boolean).join(" · "),
                        })),
                    ]}
                    onChange=${pick}
                />
            </div>`
        }
        ${
            chosen &&
            html`<div class="provider">
                <div>
                    <div>${chosen.name}</div>
                    <div class="muted small mono">${chosen.id}${chosen.price ? ` · ${chosen.price}` : ""}</div>
                    <div class="small">
                        ${
                            chosen.key.kind === "pi"
                                ? chosen.missing
                                    ? tx("Uses your {provider} sign-in, which is missing: {link}.", {
                                          provider: chosen.key.provider,
                                          link: html`<button class="link" onClick=${() => openSheet({ type: "providers" })}>${t("sign in under Providers")}</button>`,
                                      })
                                    : t("Uses your {provider} sign-in ✓.", { provider: chosen.key.provider })
                                : chosen.key.kind === "secret"
                                  ? keyLine(chosen.key, chosen.missing)
                                  : t("Needs no key.")
                        }
                        ${" "}<a href=${chosen.site} target="_blank" rel="noopener">${new URL(chosen.site).hostname}</a>
                    </div>
                    ${chosen.key.kind === "secret" && html`<${KeyField} provider=${chosen} onSaved=${() => attempt(load)} />`}
                    ${chosen.endpoint && html`<${EndpointField} key=${chosen.id} provider=${chosen} onSaved=${() => attempt(load)} />`}
                    ${chosen.missing && html`<p class="wiki-problem">${t("Not set up: {why}.", { why: chosen.missing })}</p>`}
                </div>
            </div>
            <div class="sheet-actions">
                <span class="muted small grow">
                    ${
                        test === null
                            ? ""
                            : test.running
                              ? t("Searching…")
                              : test.ok
                                ? testLine(test)
                                : test.error
                    }
                </span>
                <button class="button" disabled=${Boolean(chosen.missing) || test?.running} onClick=${runTest}>${t("Test")}</button>
            </div>`
        }
    <//>`;
}
