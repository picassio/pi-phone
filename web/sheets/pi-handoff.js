// A session to Pi on a machine and back (src/server/pi-handoff.ts): where it went, whether Pi went on there, and the
// way back. Laid out as the Providers sheet: one card, its state, its actions.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, navigate, notify, openSheet, store } from "../store.js";
import { copyText, html, Loader, Sheet, timeAgo } from "../ui.js";
import { joinPlace, splitPlace } from "../place.js";

/** Quoted for a POSIX shell. */
const quote = (text) => (/^[\w./~-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

/** The folder picker, choosing where on a machine Pi continues: this session's folder when on one, else a machine's home. */
export function pickPiFolder() {
    const { view, server } = store.state;
    const cwd = view.agent?.cwd ?? view.conversation?.cwd ?? "";
    const machine = server?.machines?.[0];
    const start = splitPlace(cwd).machineId !== undefined ? cwd : machine && joinPlace(machine.id, machine.home);

    if (!start) {
        notify("error", "Connect a machine first: Settings > Machines. Pi runs there.");

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
            if (status.settling && !confirm("Pi changed this session in the last seconds. Quit pi there first, or the last turn may be missing.\n\nBring it back anyway?")) {
                return;
            }

            const back = await api(`pi-handoff/${id}/bring-back`, { asNew });

            if (asNew) {
                closeSheet();
                navigate(back.id);

                return;
            }

            notify("info", back.added === 0 ? "Nothing new from Pi." : `${back.added} messages from Pi brought back.`);
            await load();
        });
    const goAgain = () =>
        run("again", async () => {
            await api(`pi-handoff/${id}/continue`, {});
            notify("info", `Pi's file on ${status.machine} has this session's new messages.`);
            await load();
        });
    const openTerminal = () =>
        openSheet({ type: "terminal", place: joinPlace(status.machineId, status.cwd), run: `pi --session ${status.piSession}` });
    const copy = () =>
        copyText(command).then(
            () => notify("info", "Command copied."),
            () => notify("error", "Could not copy."),
        );

    // Either side going another way means Pi's part comes back only as a new session.
    const apart = status && status.added > 0 && (status.sessionWentOn || status.branchMoved);

    return html`<${Sheet} title="Continue in Pi" onClose=${closeSheet}>
        <p class="muted small">
            The session as the model has it now, as a session of Pi's on a machine: <span class="mono">pi -r</span> there lists it. What Pi does there comes back here.
        </p>
        ${status === undefined && html`<${Loader} label="Looking at Pi's file" />`}
        ${
            status === null &&
            html`<p class="muted">This session has not gone to Pi.</p>
                <div class="sheet-actions">
                    <button class="button primary" onClick=${pickPiFolder}>Pick a folder on a machine</button>
                </div>`
        }
        ${
            status &&
            html`<div class="sheet-list">
                <div class="provider">
                    <div>
                        <div>In Pi on ${status.machine}</div>
                        <div class="muted small mono">${status.cwd}</div>
                        <div class="muted small">
                            ${
                                status.added > 0
                                    ? `Pi added ${status.added} message${status.added === 1 ? "" : "s"}`
                                    : "Pi has nothing new"
                            }
                            · changed ${timeAgo(status.modified)} ago
                            ${status.sessionWentOn && " · this session went on too"}
                        </div>
                        ${status.branchMoved && html`<div class="muted small">Pi went back to an earlier message there.</div>`}
                        ${
                            apart &&
                            html`<div class="muted small">
                                Both went on, so Pi's part comes back as a new session; this one stays as it is.
                            </div>`
                        }
                        <pre class="ssh-public-key">${command}</pre>
                    </div>
                    <div class="provider-actions">
                        ${
                            status.added > 0 &&
                            !apart &&
                            html`<button class="button small primary" disabled=${busy !== null} onClick=${() => bringBack(false)}>
                                ${busy === "back" ? "Bringing back…" : "Bring back"}
                            </button>`
                        }
                        ${
                            status.added > 0 &&
                            html`<button class=${`button small ${apart ? "primary" : "ghost"}`} disabled=${busy !== null} onClick=${() => bringBack(true)}>
                                ${busy === "new" ? "Bringing back…" : "Bring back as a new session"}
                            </button>`
                        }
                        ${
                            status.added === 0 &&
                            status.sessionWentOn &&
                            html`<button class="button small primary" disabled=${busy !== null} onClick=${goAgain}>
                                ${busy === "again" ? "Sending…" : "Send the new messages to Pi"}
                            </button>`
                        }
                        <button class="button small" onClick=${openTerminal}>Open Pi in a terminal</button>
                        <button class="button small ghost" onClick=${copy}>Copy command</button>
                        <button class="button small ghost" onClick=${pickPiFolder}>Another folder</button>
                    </div>
                </div>
            </div>`
        }
    <//>`;
}
