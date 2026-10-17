// The app's SSH keys (src/server/ssh-keys.ts): one per purpose, each assigned to machines. Generate or import one, copy
// its public key for a machine's authorized_keys, rename, remove. Laid out as the Providers sheet.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify } from "../store.js";
import { copyText, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

/** One key: its name, type and fingerprint, and what can be done with it. */
function KeyRow({ item, onChanged }) {
    const [shown, setShown] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(item.name);
    const rename = () =>
        attempt(async () => {
            await api(`ssh-keys/${encodeURIComponent(item.id)}/rename`, { name });
            setRenaming(false);
            onChanged();
        });
    const remove = () =>
        confirm(
            `Remove the key “${item.name}”?\n\nMachines that trust it keep its public key in their authorized_keys until you remove it there too.`,
        ) &&
        attempt(async () => {
            await api(`ssh-keys/${encodeURIComponent(item.id)}`, undefined, { method: "DELETE" });
            onChanged();
        });
    const copy = () =>
        copyText(item.publicKey).then(
            () => notify("info", "Public key copied."),
            () => notify("error", "Could not copy."),
        );

    return html`<div class="provider ssh-key">
        <div>
            ${
                renaming
                    ? html`<div class="row">
                        <input
                            autofocus
                            aria-label="Key name"
                            value=${name}
                            onInput=${(event) => setName(event.currentTarget.value)}
                            onKeyDown=${(event) => (event.key === "Enter" ? rename() : event.key === "Escape" && setRenaming(false))}
                        />
                        <button class="button small primary" onClick=${rename}>Save</button>
                    </div>`
                    : html`<div>${item.name}</div>`
            }
            <div class="muted small mono">${item.type} · ${item.fingerprint}</div>
            <div class="muted small">${item.source === "imported" ? "imported" : "generated"} ${timeAgo(item.createdAt)} ago</div>
            ${shown && html`<pre class="ssh-public-key">${item.publicKey}</pre>`}
        </div>
        <div class="provider-actions">
            <button class="button small" onClick=${copy}>Copy public key</button>
            <button class="button small ghost" onClick=${() => setShown(!shown)}>${shown ? "Hide" : "Show"}</button>
            <button class="button small ghost" onClick=${() => setRenaming(true)}>Rename</button>
            <button class="button small ghost" onClick=${remove}>Remove</button>
        </div>
    </div>`;
}

export function SshKeysSheet() {
    const [keys, setKeys] = useState(null);
    // What is being added: nothing, a new key's name, or a key to import.
    const [adding, setAdding] = useState(null);
    const [name, setName] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [busy, setBusy] = useState(false);
    const load = () => api("ssh-keys").then((result) => setKeys(result.keys));

    useEffect(() => {
        attempt(load);
    }, []);

    const add = () =>
        attempt(async () => {
            setBusy(true);

            try {
                await api("ssh-keys", adding === "import" ? { name, privateKey } : { name });
                setAdding(null);
                setName("");
                setPrivateKey("");
                await load();
            } finally {
                setBusy(false);
            }
        });

    return html`<${Sheet} title="SSH keys" onClose=${closeSheet}>
        <p class="muted small">
            Keys the app connects to machines with (Settings › Machines). Each machine uses one key; put that key's public half in its <span class="mono">~/.ssh/authorized_keys</span>. Keys have no passphrase and live in the app's home folder, where Pi can read them.
        </p>
        ${keys === null && html`<${Loader} label="Loading keys" />`}
        ${keys !== null && keys.length === 0 && adding === null && html`<p class="muted">No keys yet.</p>`}
        ${
            keys !== null &&
            keys.length > 0 &&
            html`<div class="sheet-list">
                ${keys.map((item) => html`<${KeyRow} key=${item.id} item=${item} onChanged=${() => attempt(load)} />`)}
            </div>`
        }
        ${
            adding === null
                ? html`<div class="sheet-actions">
                    <button class="button" onClick=${() => setAdding("import")}>Import a key…</button>
                    <button class="button primary" onClick=${() => setAdding("generate")}>
                        <${Icon} name="plus" size=${14} /> Generate a key
                    </button>
                </div>`
                : html`<div class="field">
                    <div class="label">Name</div>
                    <input
                        autofocus
                        aria-label="Key name"
                        placeholder=${adding === "import" ? "work" : "laptop"}
                        value=${name}
                        onInput=${(event) => setName(event.currentTarget.value)}
                    />
                </div>
                ${
                    adding === "import" &&
                    html`<div class="field">
                        <div class="label">Private key</div>
                        <textarea
                            rows="6"
                            class="mono"
                            aria-label="Private key"
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                            value=${privateKey}
                            onInput=${(event) => setPrivateKey(event.currentTarget.value)}
                        ></textarea>
                        <p class="muted small">Without a passphrase. The public key is derived from it.</p>
                    </div>`
                }
                <div class="sheet-actions">
                    <button class="button" onClick=${() => setAdding(null)}>Cancel</button>
                    <button
                        class="button primary"
                        disabled=${busy || name.trim() === "" || (adding === "import" && privateKey.trim() === "")}
                        onClick=${add}
                    >
                        ${busy ? "Working…" : adding === "import" ? "Import" : "Generate"}
                    </button>
                </div>`
        }
    <//>`;
}
