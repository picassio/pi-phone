// Secrets' browser module, for the owner: Menu → Secrets, a sheet to add, change, and remove the API keys and tokens
// that Pi uses in bash as $NAME without seeing them. Values go to the server and never come back to the browser.

/** The version of `pocket` this module was written for: an older app does not load it. */
export const pocketApi = 2;

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MIN_LENGTH = 8;
/** A key, as a 24 × 24 stroked path like the app's own icons. */
const KEY =
    "M15 3.5a5.5 5.5 0 1 1-5.2 7.3L3 17.6V21h3.4l.9-.9v-2h2v-2h2l1.2-1.2A5.5 5.5 0 0 1 15 3.5zM16.5 7.5h.01";

/** "just now", or "5 min ago". */
function ago(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));

    if (seconds < 60) {
        return "just now";
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 60) {
        return `${minutes} min ago`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** Where and by whom a secret may be used, in words. */
function where(secret) {
    const folders = secret.folders.length === 0 ? "any folder" : secret.folders.join(", ");

    return `${folders} · ${secret.guests ? "the owner and guests" : "the owner only"}${secret.ask ? " · asks first" : ""}`;
}

export default function setup(pocket) {
    const { html, useEffect, useState, Loader, Icon } = pocket;

    // The owner's tab tells the server who the owner is, for the rule that guests do not use the owner's secrets.
    pocket.api("hello", {}).catch(() => {});

    /** Run `work`; show what went wrong as the app's own notice. */
    const attempt = async (work) => {
        try {
            await work();
        } catch (error) {
            pocket.notify("error", error instanceof Error ? error.message : String(error));
        }
    };

    /** The form for a new secret (`secret` undefined) or a change to one; a blank value keeps the stored one. */
    function SecretForm({ secret, onDone }) {
        const [name, setName] = useState(secret?.name ?? "");
        const [value, setValue] = useState("");
        const [description, setDescription] = useState(secret?.description ?? "");
        const [folders, setFolders] = useState((secret?.folders ?? []).join("\n"));
        const [guests, setGuests] = useState(secret?.guests ?? false);
        const [ask, setAsk] = useState(secret?.ask ?? false);
        const [busy, setBusy] = useState(false);
        const isNew = secret === undefined;
        const nameOk = NAME.test(name);
        const valueOk = value === "" ? !isNew : value.length >= MIN_LENGTH;
        const save = () =>
            attempt(async () => {
                setBusy(true);

                try {
                    await pocket.api(
                        `secrets/${encodeURIComponent(name)}`,
                        {
                            ...(value === "" ? {} : { value }),
                            description,
                            folders: folders
                                .split("\n")
                                .map((line) => line.trim())
                                .filter((line) => line !== ""),
                            guests,
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
                    onInput=${(event) =>
                        setName(
                            event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
                        )}
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
                    placeholder=${isNew ? "" : "Unchanged: type to replace it"}
                    value=${value}
                    onInput=${(event) => setValue(event.currentTarget.value)}
                />
                ${
                    value !== "" &&
                    value.length < MIN_LENGTH &&
                    html`<p class="muted small">
                    At least ${MIN_LENGTH} characters: shorter values would hide ordinary text in output.
                </p>`
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
                    placeholder="Any folder. Or one per line: ~/work/site"
                    value=${folders}
                    onInput=${(event) => setFolders(event.currentTarget.value)}
                ></textarea>
                <label class="check">
                    <input type="checkbox" checked=${guests} onChange=${(event) => setGuests(event.currentTarget.checked)} />
                    Guests' messages may use it too
                </label>
                <label class="check">
                    <input type="checkbox" checked=${ask} onChange=${(event) => setAsk(event.currentTarget.checked)} />
                    Ask before each command that uses it
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
            confirm(
                `Remove ${secret.name}?\n\nCommands that use $${secret.name} then run without it.`,
            ) &&
            attempt(async () => {
                await pocket.api(`secrets/${encodeURIComponent(secret.name)}`, undefined, {
                    method: "DELETE",
                });
                onChanged();
            });

        if (editing) {
            return html`<div class="provider secret">
                <div class="provider-info">
                    <div class="provider-name mono">$${secret.name}</div>
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

        const used = secret.usedAt === undefined ? "not used yet" : `used ${ago(secret.usedAt)}`;

        return html`<div class="provider secret">
            <div class="provider-info">
                <div class="provider-name mono">$${secret.name}</div>
                ${secret.description !== "" && html`<div class="small">${secret.description}</div>`}
                <div class="muted small">${where(secret)}</div>
                <div class="muted small">changed ${ago(secret.updatedAt)} · ${used}</div>
            </div>
            <div class="provider-actions">
                <button class="button small" onClick=${() => setEditing(true)}>Change</button>
                <button class="button small ghost" onClick=${remove}>Remove</button>
            </div>
        </div>`;
    }

    function SecretsSheet() {
        const [secrets, setSecrets] = useState(null);
        const [adding, setAdding] = useState(false);
        const load = () =>
            attempt(async () => {
                setSecrets((await pocket.api("secrets")).secrets);
            });

        useEffect(() => {
            void load();

            // Pi saved one (secret_request, secret_save), or another tab changed one.
            return pocket.on("changed", () => void load());
        }, []);

        return html`<div class="secrets">
            <p class="muted small">
                API keys and tokens that Pi uses without seeing them: a command that names one${" "}
                (<span class="mono">$NPM_TOKEN</span>) runs with its value, and output that shows a value shows${" "}
                <span class="mono">[secret NAME]</span> instead. Pi can ask you for one with a hidden field. Values${" "}
                stay on this server, in the data folder.
            </p>
            ${secrets === null && html`<${Loader} label="Loading secrets" />`}
            ${secrets !== null && secrets.length === 0 && !adding && html`<p class="muted">No secrets yet.</p>`}
            ${
                secrets !== null &&
                secrets.length > 0 &&
                html`<div class="sheet-list">
                ${secrets.map(
                    (secret) =>
                        html`<${SecretRow} key=${secret.name} secret=${secret} onChanged=${load} />`,
                )}
            </div>`
            }
            ${
                adding
                    ? html`<${SecretForm}
                      onDone=${(saved) => {
                          setAdding(false);
                          saved && void load();
                      }}
                  />`
                    : html`<div class="sheet-actions">
                      <button class="button primary" onClick=${() => setAdding(true)}>
                          <${Icon} name="plus" size=${14} /> Add a secret
                      </button>
                  </div>`
            }
        </div>`;
    }

    pocket.style("secrets.css");
    pocket.sheet({ id: "secrets", title: "Secrets", component: SecretsSheet });
    pocket.menu({ id: "secrets", label: "Secrets", hint: "keys Pi uses unseen", sheet: "secrets" });
    pocket.launcher({
        id: "secrets",
        label: "Secrets",
        detail: "API keys and tokens Pi uses without seeing them",
        iconPath: KEY,
        sheet: "secrets",
        keywords: ["api key", "token", "password", "env"],
    });

    // How Pi's calls of the tools show in transcripts and peek tiles.
    pocket.toolCall({
        tool: "secrets_list",
        iconPath: KEY,
        label: () => "list secrets",
        summary: () => ({ verb: "listed secrets" }),
    });
    pocket.toolCall({
        tool: "secret_request",
        iconPath: KEY,
        label: () => "ask for a secret",
        subject: (args) => String(args.name ?? ""),
        summary: () => ({ verb: "asked for", noun: "secret", by: "name" }),
    });
    pocket.toolCall({
        tool: "secret_save",
        iconPath: KEY,
        label: () => "save a secret",
        subject: (args) => String(args.name ?? ""),
        summary: () => ({ verb: "saved", noun: "secret", by: "name" }),
    });
}
