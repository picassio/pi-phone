// All artifacts (PP-349, from pi-pocket 0.28 #237): every artifact in every session the person can see, by session, one
// row each with its current (latest) version; a tap opens that version in its session, and each can be kept as a page
// on the rail (PP-370) from here. Pi lists the same with `artifacts_list`.
import { useEffect, useState } from "preact/hooks";
import { folderColor } from "../avatar.js";
import { t, tn } from "../i18n.js";
import { KeepButton } from "../pages.js";
import { api, closeSheet, navigate, store } from "../store.js";
import { formatBytes, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

/** The entries (newest first) in groups by session, in the order the sessions first appear. */
function bySession(entries) {
    const groups = new Map();

    for (const entry of entries) {
        const group = groups.get(entry.session) ?? { session: entry.session, title: entry.sessionTitle, entries: [] };

        group.entries.push(entry);
        groups.set(entry.session, group);
    }

    return [...groups.values()];
}

/** What each type is called on a row. */
const TYPES = () => ({ html: t("Page"), markdown: t("Document"), svg: t("Image"), openui: t("Interactive answer") });

/** One session's artifacts, in the frame Running now gives a session. */
function Group({ group, open }) {
    const cwd = store.state.sessions.find((entry) => entry.id === group.session)?.cwd;

    return html`<div class="running overview" data-part="artifacts-session">
        <div class="running-head">
            <span class="folder-mark" style=${`--folder:${folderColor(cwd)}`} aria-hidden="true"></span>
            <span class="grow overview-session">${group.title || t("Session {n}", { n: group.session })}</span>
            <span class="muted small">${group.entries.length}</span>
        </div>
        ${group.entries.map(
            (entry) => html`<div class="overview-row" key=${entry.id} data-part="artifact-row" data-artifact=${entry.id}>
                <button class="overview-open" onClick=${() => open(entry)}>
                    <${Icon} name="artifact" size=${16} />
                    <span class="overview-main">
                        <span class="overview-title">${entry.title}</span>
                        <span class="muted small">${TYPES()[entry.type] ?? entry.type} · ${formatBytes(entry.size)} · ${timeAgo(entry.updatedAt)}</span>
                    </span>
                    <span class="overview-version mono" title=${t("Current version: {current}, of {versions}", { current: entry.current, versions: entry.versions })}>
                        v${entry.current}${entry.versions > 1 && html`<span class="muted"> / ${entry.versions}</span>`}
                    </span>
                </button>
                <span class="overview-keep"><${KeepButton} conversation=${entry.session} artifact=${entry.id} /></span>
            </div>`,
        )}
    </div>`;
}

/** All artifacts, across sessions: a tap opens the current version in its session. */
export function AllArtifactsSheet() {
    const [entries, setEntries] = useState(null);
    const [failed, setFailed] = useState(null);

    useEffect(() => {
        let open = true;

        api("artifacts").then(
            (list) => open && setEntries(list),
            (error) => open && setFailed(error.message),
        );

        return () => {
            open = false;
        };
    }, []);

    const open = (entry) => {
        closeSheet();
        navigate(entry.session, { sheet: { type: "viewer", id: entry.id, version: entry.current } });
    };

    return html`<${Sheet} title=${t("All artifacts")} onClose=${closeSheet} wide=${true}>
        ${entries === null && failed === null && html`<${Loader} label=${t("Looking")} />`}
        ${failed !== null && html`<p class="warn">${failed}</p>`}
        ${entries?.length === 0 && html`<p class="muted">${t("No artifacts yet. Ask Pi to build something you can look at: a chart, a demo, a game.")}</p>`}
        ${entries?.length > 0 && html`<p class="muted small">${tn(entries.length, "{n} artifact, in every session you can see. Archived sessions are left out.", "{n} artifacts, in every session you can see. Archived sessions are left out.")}</p>`}
        <div class="overview-groups">${bySession(entries ?? []).map((group) => html`<${Group} key=${group.session} group=${group} open=${open} />`)}</div>
    <//>`;
}
