// The owner's secrets (src/server/secrets.ts): API keys and tokens Pi uses in bash as $NAME without seeing them. Add,
// change, or remove one; say what it is for and where it may be used. Values go to the server and never come back.
// Laid out as the SSH keys sheet.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet } from "../store.js";
import { html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MIN_LENGTH = 8;

/** Where a secret may be used, in words. */
function where(secret) {
    const folders = secret.folders.length === 0 ? "any folder" : secret.folders.join(", ");

    return `${folders} · ${secret.machines ? "phone and machines" : "phone only"}`;
}

/** The form for a new secret (`secret` undefined) or a change to one; a blank value keeps the stored one. */
function SecretForm({ secret, onDone }) {
    const [name, setName] = useState(secret?.name ?? "");
    const [value, setValue] = useState("");
    const [description, setDescription] = useState(secret?.description ?? "");
    const [folders, setFolders] = useState((secret?.folders ?? []).join("\n"));
    const [machines, setMachines] = useState(secret?.machines ?? true);
    const [ask, setAsk] = useState(secret?.ask ?? false);
    const [busy, setBusy] = useState(false);
    const isNew = secret === undefined;
    const nameOk = NAME.test(name);
    const valueOk = value === "" ? !isNew : value.length >= MIN_LENGTH;
    const save = () =>
        attempt(async () => {
            setBusy(true);

            try {
                await api(
                    `secrets/${encodeURIComponent(name)}`,
                    {
                        ...(value === "" ? {} : { value }),
                        description,
                        folders: folders
                            .split("\n")
                            .map((line) => line.trim())
                            .filter((line) => line !== ""),
                        machines,
                        ask,
                    },
                    { method: "PUT" },
                );
                onDone(true);
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="secret-form">
        ${
            isNew &&
            html`<div class="field">
                <div class="label">Name</div>
                <input
                    autofocus
                    class="mono"
                    aria-label="Secret name"
                    placeholder="DEEPSEEK_API_KEY"
                    autocapitalize="characters"
                    value=${name}
                    onInput=${(event) => setName(event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                />
                <p class="muted small">Pi uses it in commands as <span class="mono">$${name || "NAME"}</span>.</p>
            </div>`
        }
        <div class="field">
            <div class="label">Value</div>
            <input
                type="password"
                class="mono"
                aria-label="Secret value"
                autocomplete="off"
                placeholder=${isNew ? "" : "Unchanged; type to replace it"}
                value=${value}
                onInput=${(event) => setValue(event.currentTarget.value)}
            />
            ${
                value !== "" &&
                value.length < MIN_LENGTH &&
                html`<p class="muted small">At least ${MIN_LENGTH} characters: shorter values would hide ordinary text in outputs.</p>`
            }
        </div>
        <div class="field">
            <div class="label">What it is for</div>
            <input
                aria-label="What it is for"
                placeholder="DeepSeek API: web search and models"
                value=${description}
                onInput=${(event) => setDescription(event.currentTarget.value)}
            />
        </div>
        <div class="field">
            <div class="label">Folders</div>
            <textarea
                rows="2"
                class="mono"
                aria-label="Folders"
                placeholder="Any folder. Or one per line: ~/work/pi-phone, machine:…"
                value=${folders}
                onInput=${(event) => setFolders(event.currentTarget.value)}
            ></textarea>
            <label class="check">
                <input type="checkbox" checked=${machines} onChange=${(event) => setMachines(event.currentTarget.checked)} />
                Sessions on machines may use it too
            </label>
            <label class="check">
                <input type="checkbox" checked=${ask} onChange=${(event) => setAsk(event.currentTarget.checked)} />
                Ask me before each command that uses it
            </label>
        </div>
        <div class="sheet-actions">
            <button class="button" onClick=${() => onDone(false)}>Cancel</button>
            <button class="button primary" disabled=${busy || !nameOk || !valueOk} onClick=${save}>
                ${busy ? "Saving…" : "Save"}
            </button>
        </div>
    </div>`;
}

function SecretRow({ secret, onChanged }) {
    const [editing, setEditing] = useState(false);
    const remove = () =>
        confirm(`Remove ${secret.name}?\n\nCommands that use $${secret.name} then run without it.`) &&
        attempt(async () => {
            await api(`secrets/${encodeURIComponent(secret.name)}`, undefined, { method: "DELETE" });
            onChanged();
        });

    if (editing) {
        return html`<div class="provider">
            <div>
                <div class="mono">$${secret.name}</div>
                <${SecretForm}
                    secret=${secret}
                    onDone=${(saved) => {
                        setEditing(false);
                        saved && onChanged();
                    }}
                />
            </div>
        </div>`;
    }

    return html`<div class="provider">
        <div>
            <div class="mono">$${secret.name}</div>
            ${secret.description !== "" && html`<div class="small">${secret.description}</div>`}
            <div class="muted small">${where(secret)}${secret.ask ? " · asks first" : ""}</div>
            <div class="muted small">
                changed ${timeAgo(secret.updatedAt)} ago${secret.usedAt === undefined ? " · not used yet" : ` · used ${timeAgo(secret.usedAt)} ago`}
            </div>
        </div>
        <div class="provider-actions">
            <button class="button small" onClick=${() => setEditing(true)}>Change</button>
            <button class="button small ghost" onClick=${remove}>Remove</button>
        </div>
    </div>`;
}

export function SecretsSheet() {
    const [secrets, setSecrets] = useState(null);
    const [adding, setAdding] = useState(false);
    const load = () => api("secrets").then((result) => setSecrets(result.secrets));

    useEffect(() => {
        attempt(load);
    }, []);

    return html`<${Sheet} title="Secrets" onClose=${closeSheet}>
        <p class="muted small">
            API keys and tokens Pi uses without seeing them: a command that names one (<span class="mono">$NPM_TOKEN</span>) runs
            with its value, and any output that shows a value shows <span class="mono">[secret NAME]</span> instead. Pi can ask
            you for one with a hidden field. Values stay on this phone, in the app's own storage, and go into backups.
        </p>
        ${secrets === null && html`<${Loader} label="Loading secrets" />`}
        ${secrets !== null && secrets.length === 0 && !adding && html`<p class="muted">No secrets yet.</p>`}
        ${
            secrets !== null &&
            secrets.length > 0 &&
            html`<div class="sheet-list">
                ${secrets.map((secret) => html`<${SecretRow} key=${secret.name} secret=${secret} onChanged=${() => attempt(load)} />`)}
            </div>`
        }
        ${
            adding
                ? html`<${SecretForm}
                      onDone=${(saved) => {
                          setAdding(false);
                          saved && attempt(load);
                      }}
                  />`
                : html`<div class="sheet-actions">
                      <button class="button primary" onClick=${() => setAdding(true)}>
                          <${Icon} name="plus" size=${14} /> Add a secret
                      </button>
                  </div>`
        }
    <//>`;
}
