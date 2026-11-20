// Pi asks before it changes the owner's MCP servers (PP-527, src/server/mcp/admin.ts, `form: { type: "mcp-server" }`):
// the whole entry as it will be, the change for an edit, where it runs, the folders it serves and the secrets it uses.
// Approve is the owner's alone; anyone who can steer may deny.
import { useState } from "preact/hooks";
import { DiffBlock } from "./diff.js";
import { t } from "./i18n.js";
import { actions, attempt, canSteer, store } from "./store.js";
import { html, Icon } from "./ui.js";

/** What the card asks: whole sentences, so each language can order them. */
function asked(form) {
    switch (form.action) {
        case "save":
            return form.diff === undefined ? t("Add the MCP server {name}?", { name: form.name }) : t("Change the MCP server {name}?", { name: form.name });
        case "enable":
            return t("Turn on the MCP server {name}?", { name: form.name });
        case "disable":
            return t("Turn off the MCP server {name}?", { name: form.name });
        default:
            return t("Remove the MCP server {name}?", { name: form.name });
    }
}

/** What Approve does, in a line. */
function reason(form) {
    switch (form.action) {
        case "disable":
            return t("Its running instances stop. Its entry stays, to turn on again.");
        case "remove":
            return t("Its running instances stop and its entry goes.");
        default:
            return t("It runs this command as you, where it says, for sessions in these folders. Nothing runs until you approve.");
    }
}

const ICON = { save: "plus", enable: "play", disable: "stop", remove: "alert" };

export function McpServerCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [busy, setBusy] = useState(false);
    const [whole, setWhole] = useState(false);
    const owner = me?.role === "owner";
    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };
    const approve = { save: form.diff === undefined ? t("Add") : t("Change"), enable: t("Turn on"), disable: t("Turn off"), remove: t("Remove") }[form.action];
    const edit = form.diff !== undefined;

    return html`<div class="approval library-card" data-part="approval" data-mcp=${form.action}>
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name=${form.action === "save" && edit ? "pencil" : ICON[form.action]} size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${asked(form)}</span>
                <span class="approval-reason">${reason(form)}</span>
            </div>
        </div>
        <dl class="machine-add-facts">
            <dt>${t("Runs")}</dt>
            <dd>${form.runs}</dd>
            <dt>${t("Folders")}</dt>
            <dd>${form.folders.length === 0 ? t("Every folder") : form.folders.map((folder) => html`<div class="mono small">${folder}</div>`)}</dd>
            <dt>${t("Secrets")}</dt>
            <dd>${form.secrets.length === 0 ? t("None") : form.secrets.map((name) => html`<div class="mono small">${name}</div>`)}</dd>
        </dl>
        ${form.unpinned && html`<div class="muted small mcp-unpinned">${t("{spec} names no version: what runs can change without a new card. Pin one, such as {spec}@1.2.3.", { spec: form.unpinned })}</div>`}
        ${edit && html`<${DiffBlock} text=${form.diff} />`}
        ${edit
            ? html`<div class="library-whole">
                  <button type="button" class="library-whole-toggle" aria-expanded=${whole ? "true" : "false"} onClick=${() => setWhole(!whole)}>
                      <${Icon} name="down" size=${16} /><span>${t("Whole entry after the change")}</span>
                  </button>
                  ${whole && html`<pre class="output">${form.entry}</pre>`}
              </div>`
            : html`<pre class="output">${form.entry}</pre>`}
        ${
            !canSteer()
                ? html`<div class="muted small">${t("Waiting for someone who can steer to answer.")}</div>`
                : html`${!owner && html`<div class="muted small">${t("The MCP servers are the owner's: only they approve this. You can deny it.")}</div>`}
                      <div class="approval-actions">
                          <button class="button deny" disabled=${busy} onClick=${() => answer(false)}>${t("Deny")}</button>
                          ${owner && html`<button class="button primary" disabled=${busy} onClick=${() => answer(true)}>${approve}</button>`}
                      </div>`
        }
    </div>`;
}
