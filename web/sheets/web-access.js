// Settings › Web access (src/server/web/access.ts): the search provider `web_search` uses, and what it needs — a Pi
// sign-in, a key (kept in Settings › Secrets), or an address — with a test search. Off until a provider is picked.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, openSheet } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

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
            aria-label=${`${provider.name} key`}
            placeholder=${provider.missing ? "Paste its key" : "Saved; paste to replace it"}
            value=${value}
            onInput=${(event) => setValue(event.currentTarget.value)}
        />
        <button class="button small primary" disabled=${busy || value.length < 8} onClick=${save}>Save</button>
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
            <button class="button small" disabled=${value.trim() === (provider.endpoint.value ?? "")} onClick=${save}>Save</button>
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

    return html`<${Sheet} title="Web access" onClose=${closeSheet}>
        <p class="muted small">
            The search provider Pi's <span class="mono">web_search</span> uses. Pi reads pages, documents, and GitHub with
            <span class="mono">fetch_content</span> without one. Model providers use your sign-in from Settings › Providers;
            the others use a key kept in Settings › Secrets.
        </p>
        ${!state && html`<${Loader} label="Loading providers" />`}
        ${
            state &&
            html`<div class="field">
                <div class="label">Search provider</div>
                <select value=${state.provider ?? ""} onChange=${(event) => pick(event.currentTarget.value)}>
                    <option value="">Off: no web search</option>
                    ${state.providers.map(
                        (provider) => html`<option value=${provider.id}>
                            ${provider.name}${provider.missing ? " · not set up" : ""}${provider.price ? ` · ${provider.price}` : ""}
                        </option>`,
                    )}
                </select>
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
                                ? html`Uses your ${chosen.key.provider} sign-in${chosen.missing ? html`, which is missing: <button class="link" onClick=${() => openSheet({ type: "providers" })}>sign in under Providers</button>` : " ✓"}.`
                                : chosen.key.kind === "secret"
                                  ? html`Key: the secret <span class="mono">${chosen.key.secret}</span>${chosen.key.optional ? " (optional)" : ""}${chosen.missing ? "" : " ✓"}.`
                                  : "Needs no key."
                        }
                        ${" "}<a href=${chosen.site} target="_blank" rel="noopener">${new URL(chosen.site).hostname}</a>
                    </div>
                    ${chosen.key.kind === "secret" && html`<${KeyField} provider=${chosen} onSaved=${() => attempt(load)} />`}
                    ${chosen.endpoint && html`<${EndpointField} key=${chosen.id} provider=${chosen} onSaved=${() => attempt(load)} />`}
                    ${chosen.missing && html`<p class="wiki-problem">Not set up: ${chosen.missing}.</p>`}
                </div>
            </div>
            <div class="sheet-actions">
                <span class="muted small grow">
                    ${
                        test === null
                            ? ""
                            : test.running
                              ? "Searching…"
                              : test.ok
                                ? `${test.results.length} results in ${(test.ms / 1000).toFixed(1)} s${test.results[0] ? `: ${test.results[0].title}` : ""}`
                                : test.error
                    }
                </span>
                <button class="button" disabled=${Boolean(chosen.missing) || test?.running} onClick=${runTest}>Test</button>
            </div>`
        }
    <//>`;
}
