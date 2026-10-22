// A session to Pi on a machine and back (src/server/pi-handoff.ts): where it went, whether Pi went on there, and the
// way back. Laid out as the Providers sheet: one card, its state, its actions.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, navigate, notify, openSheet, store } from "../store.js";
import { copyText, html, Loader, Sheet, timeAgo } from "../ui.js";
import { joinPlace, splitPlace } from "../place.js";
import { t, tn, tx } from "../i18n.js";

/** Where Pi's side stands: what it added, when it changed, and whether this session went on too. */
function statusLine(status) {
    const when = timeAgo(status.modified);

    if (status.added > 0) {
        return status.sessionWentOn
            ? tn(status.added, "Pi added {n} message · changed {when} ago · this session went on too", "Pi added {n} messages · changed {when} ago · this session went on too", { when })
            : tn(status.added, "Pi added {n} message · changed {when} ago", "Pi added {n} messages · changed {when} ago", { when });
    }

    return status.sessionWentOn
        ? t("Pi has nothing new · changed {when} ago · this session went on too", { when })
        : t("Pi has nothing new · changed {when} ago", { when });
}

/** Quoted for a POSIX shell. */
const quote = (text) => (/^[\w./~-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

/** The folder picker, choosing where on a machine Pi continues: this session's folder when on one, else a machine's home. */
export function pickPiFolder() {
    const { view, server } = store.state;
    const cwd = view.agent?.cwd ?? view.conversation?.cwd ?? "";
    const machine = server?.machines?.[0];
    const start = splitPlace(cwd).machineId !== undefined ? cwd : machine && joinPlace(machine.id, machine.home);

    if (!start) {
        notify("error", t("Connect a machine first: Settings > Machines. Pi runs there."));

        return;
    }

    openSheet({ type: "cwd", mode: "pi", start });
}

/** Continue the session in Pi at `place` (a folder on a machine), and show where it went. */
export async function continueInPiAt(place) {
    const id = store.state.conversationId;

    await api(`pi-handoff/${id}/continue`, { place });
    openSheet({ type: "pi-handoff" });
}

export function PiHandoffSheet() {
    const id = store.state.conversationId;
    const [status, setStatus] = useState(undefined);
    const [busy, setBusy] = useState(null);
    const load = async () => setStatus((await api(`pi-handoff/${id}`)).link);

    useEffect(() => {
        attempt(load);
    }, [id]);

    const run = (what, work) =>
        attempt(async () => {
            setBusy(what);

            try {
                await work();
            } finally {
                setBusy(null);
            }
        });
    const command = status && `cd ${quote(status.cwd)} && pi --session ${status.piSession}`;
    const bringBack = (asNew) =>
        run(asNew ? "new" : "back", async () => {
            if (status.settling && !confirm(t("Pi changed this session in the last seconds. Quit pi there first, or the last turn may be missing.\n\nBring it back anyway?"))) {
                return;
            }

            const back = await api(`pi-handoff/${id}/bring-back`, { asNew });

            if (asNew) {
                closeSheet();
                navigate(back.id);

                return;
            }

            notify("info", back.added === 0 ? t("Nothing new from Pi.") : t("{n} messages from Pi brought back.", { n: back.added }));
            await load();
        });
    const goAgain = () =>
        run("again", async () => {
            await api(`pi-handoff/${id}/continue`, {});
            notify("info", t("Pi's file on {machine} has this session's new messages.", { machine: status.machine }));
            await load();
        });
    const openTerminal = () =>
        openSheet({ type: "terminal", place: joinPlace(status.machineId, status.cwd), run: `pi --session ${status.piSession}` });
    const copy = () =>
        copyText(command).then(
            () => notify("info", t("Command copied.")),
            () => notify("error", t("Could not copy.")),
        );

    // Either side going another way means Pi's part comes back only as a new session.
    const apart = status && status.added > 0 && (status.sessionWentOn || status.branchMoved);

    return html`<${Sheet} title=${t("Continue in Pi")} onClose=${closeSheet}>
        <p class="muted small">
            ${tx("The session as the model has it now, as a session of Pi's on a machine: {command} there lists it. What Pi does there comes back here.", { command: html`<span class="mono">pi -r</span>` })}
        </p>
        ${status === undefined && html`<${Loader} label=${t("Looking at Pi's file")} />`}
        ${
            status === null &&
            html`<p class="muted">${t("This session has not gone to Pi.")}</p>
                <div class="sheet-actions">
                    <button class="button primary" onClick=${pickPiFolder}>${t("Pick a folder on a machine")}</button>
                </div>`
        }
        ${
            status &&
            html`<div class="sheet-list">
                <div class="provider">
                    <div>
                        <div>${t("In Pi on {machine}", { machine: status.machine })}</div>
                        <div class="muted small mono">${status.cwd}</div>
                        <div class="muted small">
                            ${statusLine(status)}
                        </div>
                        ${status.branchMoved && html`<div class="muted small">${t("Pi went back to an earlier message there.")}</div>`}
                        ${
                            apart &&
                            html`<div class="muted small">
                                ${t("Both went on, so Pi's part comes back as a new session; this one stays as it is.")}
                            </div>`
                        }
                        <pre class="ssh-public-key">${command}</pre>
                    </div>
                    <div class="provider-actions">
                        ${
                            status.added > 0 &&
                            !apart &&
                            html`<button class="button small primary" disabled=${busy !== null} onClick=${() => bringBack(false)}>
                                ${busy === "back" ? t("Bringing back…") : t("Bring back")}
                            </button>`
                        }
                        ${
                            status.added > 0 &&
                            html`<button class=${`button small ${apart ? "primary" : "ghost"}`} disabled=${busy !== null} onClick=${() => bringBack(true)}>
                                ${busy === "new" ? t("Bringing back…") : t("Bring back as a new session")}
                            </button>`
                        }
                        ${
                            status.added === 0 &&
                            status.sessionWentOn &&
                            html`<button class="button small primary" disabled=${busy !== null} onClick=${goAgain}>
                                ${busy === "again" ? t("Sending…") : t("Send the new messages to Pi")}
                            </button>`
                        }
                        <button class="button small" onClick=${openTerminal}>${t("Open Pi in a terminal")}</button>
                        <button class="button small ghost" onClick=${copy}>${t("Copy command")}</button>
                        <button class="button small ghost" onClick=${pickPiFolder}>${t("Another folder")}</button>
                    </div>
                </div>
            </div>`
        }
    <//>`;
}
