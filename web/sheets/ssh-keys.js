// The app's SSH keys (src/server/ssh-keys.ts): one per purpose, each assigned to machines. Generate or import one, copy
// its public key for a machine's authorized_keys, rename, remove. Laid out as the Providers sheet.
import { useEffect, useState } from "preact/hooks";
import { t, tx } from "../i18n.js";
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
            t("Remove the key “{name}”?\n\nMachines that trust it keep its public key in their authorized_keys until you remove it there too.", { name: item.name }),
        ) &&
        attempt(async () => {
            await api(`ssh-keys/${encodeURIComponent(item.id)}`, undefined, { method: "DELETE" });
            onChanged();
        });
    const copy = () =>
        copyText(item.publicKey).then(
            () => notify("info", t("Public key copied.")),
            () => notify("error", t("Could not copy.")),
        );

    return html`<div class="provider ssh-key">
        <div>
            ${
                renaming
                    ? html`<div class="row">
                        <input
                            autofocus
                            aria-label=${t("Key name")}
                            value=${name}
                            onInput=${(event) => setName(event.currentTarget.value)}
                            onKeyDown=${(event) => (event.key === "Enter" ? rename() : event.key === "Escape" && setRenaming(false))}
                        />
                        <button class="button small primary" onClick=${rename}>${t("Save")}</button>
                    </div>`
                    : html`<div>${item.name}</div>`
            }
            <div class="muted small mono">${item.type} · ${item.fingerprint}</div>
            ${item.problem && html`<div class="machine-problem small"><strong>${t("Not loaded:")}</strong> ${item.problem}</div>`}
            <div class="muted small">
                ${item.source === "imported" ? t("imported {ago} ago", { ago: timeAgo(item.createdAt) }) : t("generated {ago} ago", { ago: timeAgo(item.createdAt) })}
            </div>
            ${shown && html`<pre class="ssh-public-key">${item.publicKey}</pre>`}
        </div>
        <div class="provider-actions">
            <button class="button small" onClick=${copy}>${t("Copy public key")}</button>
            <button class="button small ghost" onClick=${() => setShown(!shown)}>${shown ? t("Hide") : t("Show")}</button>
            <button class="button small ghost" onClick=${() => setRenaming(true)}>${t("Rename")}</button>
            <button class="button small ghost" onClick=${remove}>${t("Remove")}</button>
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

    return html`<${Sheet} title=${t("SSH keys")} onClose=${closeSheet}>
        <p class="muted small">
            ${tx("Keys the app connects to machines with (Settings › Machines). Each machine uses one key; put that key's public half in its {file}. Private keys are kept in the app's database and its ssh-agent, never as files: the app signs with them, and nothing (Pi included) can read them out. They have no passphrase.", { file: html`<span class="mono">~/.ssh/authorized_keys</span>` })}
        </p>
        ${keys === null && html`<${Loader} label=${t("Loading keys")} />`}
        ${keys !== null && keys.length === 0 && adding === null && html`<p class="muted">${t("No keys yet.")}</p>`}
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
                    <button class="button" onClick=${() => setAdding("import")}>${t("Import a key…")}</button>
                    <button class="button primary" onClick=${() => setAdding("generate")}>
                        <${Icon} name="plus" size=${14} /> ${t("Generate a key")}
                    </button>
                </div>`
                : html`<div class="field">
                    <div class="label">${t("Name")}</div>
                    <input
                        autofocus
                        aria-label=${t("Key name")}
                        placeholder=${adding === "import" ? t("work") : t("laptop")}
                        value=${name}
                        onInput=${(event) => setName(event.currentTarget.value)}
                    />
                </div>
                ${
                    adding === "import" &&
                    html`<div class="field">
                        <div class="label">${t("Private key")}</div>
                        <textarea
                            rows="6"
                            class="mono"
                            aria-label=${t("Private key")}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                            value=${privateKey}
                            onInput=${(event) => setPrivateKey(event.currentTarget.value)}
                        ></textarea>
                        <p class="muted small">${t("Without a passphrase. The public key is derived from it.")}</p>
                    </div>`
                }
                <div class="sheet-actions">
                    <button class="button" onClick=${() => setAdding(null)}>${t("Cancel")}</button>
                    <button
                        class="button primary"
                        disabled=${busy || name.trim() === "" || (adding === "import" && privateKey.trim() === "")}
                        onClick=${add}
                    >
                        ${busy ? t("Working…") : adding === "import" ? t("Import") : t("Generate")}
                    </button>
                </div>`
        }
    <//>`;
}
