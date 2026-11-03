// Running now: everything Pi is doing, across sessions, and a timeline of every scheduled message (PP-355, after
// pi-pocket 0.28's Running now board, #232). Elapsed times and countdowns tick each second between the server's answers.
import { useEffect, useState } from "preact/hooks";
import { folderColor } from "../avatar.js";
import { api, attempt, canSteer, closeSheet, navigate, serverClockOffset, store } from "../store.js";
import { formatWhen, html, Icon, Loader, Sheet, Spinner, StateTag } from "../ui.js";
import { t, tn } from "../i18n.js";

/** How often the Running now sheet asks again while it is open. */
const RUNNING_EVERY_MS = 2000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The timeline's spans: the next day, by the hour, or the next 8 days, by the day (the server sends 8 days of times). */
const SPANS = { day: DAY, week: 8 * DAY };

/** The server's clock now: what its times are on. */
const serverNow = () => Date.now() + serverClockOffset();

/** A span of time in a few characters: "45s", "3m 40s", "2h 14m", "3d 4h". */
export function span(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 60) {
        return `${seconds}s`;
    }

    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }

    if (seconds < 86_400) {
        return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    }

    return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

/** Money as the board shows it: "$0.42". */
const dollars = (amount) => `$${amount.toFixed(amount >= 100 ? 0 : 2)}`;

/** Each second while the sheet is open: what elapsed times and countdowns read, so they move between answers. */
function useNow() {
    const [now, setNow] = useState(serverNow);

    useEffect(() => {
        const timer = setInterval(() => setNow(serverNow()), 1000);

        return () => clearInterval(timer);
    }, []);

    return now;
}

/** The ticks of the timeline: every 6 hours over a day, every day over 8, at this device's clock. */
function ticksOf(now, range) {
    const step = range === SPANS.day ? 6 * HOUR : DAY;
    const first = new Date(now - serverClockOffset());

    if (range === SPANS.day) {
        first.setMinutes(0, 0, 0);
        first.setHours(Math.ceil((first.getHours() + 1) / 6) * 6);
    } else {
        first.setHours(24, 0, 0, 0);
    }

    const ticks = [];

    for (let at = first.getTime() + serverClockOffset(); at < now + range; at += step) {
        const local = new Date(at - serverClockOffset());

        // Not on top of "now", nor past the end.
        if ((at - now) / range < 0.12 || (at - now) / range > 0.94) {
            continue;
        }

        ticks.push({
            at,
            label: range === SPANS.day ? local.toLocaleTimeString([], { hour: "numeric" }) : local.toLocaleDateString([], { weekday: "short" }),
        });
    }

    return ticks;
}

/**
 * The scheduled messages on a timeline from now on: a lane for each session, a mark at each time one goes out (a held
 * one in the warning colour), and the list under it with what each sends, when, and Cancel.
 */
function Scheduled({ schedules, now, steer, go }) {
    const [range, setRange] = useState(SPANS.day);
    const lanes = new Map();

    for (const schedule of schedules) {
        const lane = lanes.get(schedule.session) ?? { session: schedule.session, title: schedule.sessionTitle, cwd: schedule.sessionCwd, marks: [] };

        for (const at of schedule.upcoming) {
            if (at - now <= range) {
                lane.marks.push({ at, schedule });
            }
        }

        lanes.set(schedule.session, lane);
    }

    const place = (at) => `${Math.min(100, Math.max(0, ((at - now) / range) * 100))}%`;
    const usersById = new Map(store.state.users.map((user) => [user.id, user.name]));
    const setBy = (schedule) => (schedule.by === undefined ? t("set by Pi") : schedule.by === store.state.me?.id ? t("set by you") : t("set by {name}", { name: usersById.get(schedule.by) ?? t("someone") }));

    return html`<section class="rb-scheduled" data-part="running-scheduled">
        <div class="rb-section-head">
            <span class="label">${t("Scheduled")}</span>
            <div class="segmented" role="group" aria-label=${t("Timeline span")}>
                ${[
                    [SPANS.day, t("24 hours")],
                    [SPANS.week, t("8 days")],
                ].map(([value, label]) => html`<button class=${range === value ? "on" : ""} aria-pressed=${range === value} onClick=${() => setRange(value)}>${label}</button>`)}
            </div>
        </div>
        <div class="rb-timeline" data-part="running-timeline">
            <div class="rb-axis" aria-hidden="true">
                <span class="rb-tick rb-now" style="left: 0%">${t("now")}</span>
                ${ticksOf(now, range).map((tick) => html`<span class="rb-tick" key=${tick.at} style=${`left: ${place(tick.at)}`}>${tick.label}</span>`)}
            </div>
            ${[...lanes.values()].map(
                (lane) => html`<div class="rb-lane" key=${lane.session} data-session=${lane.session}>
                    <button class="rb-lane-name" onClick=${() => go(lane.session)} title=${lane.title}>
                        <span class="folder-mark" style=${`--folder:${folderColor(lane.cwd)}`} aria-hidden="true"></span>
                        <span>${lane.title}</span>
                    </button>
                    <div class="rb-track">
                        ${lane.marks.map(
                            (mark) => html`<span
                                class=${`rb-mark ${mark.schedule.held ? "held" : ""}`}
                                key=${`${mark.schedule.id}:${mark.at}`}
                                data-part="running-mark"
                                style=${`left: ${place(mark.at)}`}
                                title=${`${formatWhen(mark.at - serverClockOffset())} · ${mark.schedule.text}`}
                            ></span>`,
                        )}
                    </div>
                </div>`,
            )}
        </div>
        <div class="sheet-list rb-schedules">
            ${schedules.map(
                (schedule) => html`<div class="schedule rb-schedule" key=${schedule.id} data-part="running-schedule" data-schedule=${schedule.id}>
                    <${Icon} name="clock" size=${16} />
                    <div class="grow">
                        <button class="link rb-schedule-text" onClick=${() => go(schedule.session)}>${schedule.text}</button>
                        <div class="muted small">
                            <span class="mono" data-part="running-countdown">${t("in {time}", { time: span(schedule.next - now) })}</span>
                            · ${formatWhen(schedule.next - serverClockOffset())}${schedule.repeat ? ` · ${schedule.repeat}` : ""} · ${schedule.sessionTitle} · ${setBy(schedule)}
                        </div>
                        ${
                            schedule.held &&
                            html`<div class="rb-held small">
                                <${StateTag} tone="warn" label=${t("Held")} />
                                ${t("{why}. At its time it is cancelled, unless that changes first.", { why: schedule.held })}
                            </div>`
                        }
                    </div>
                    ${steer && html`<button class="button small ghost" onClick=${() => attempt(() => api(`c/${schedule.session}/schedules/${encodeURIComponent(schedule.id)}/cancel`, {}))}>${t("Cancel")}</button>`}
                </div>`,
            )}
        </div>
    </section>`;
}

/** The message a session works on, folded to a line until tapped. */
function Prompt({ prompt }) {
    const [open, setOpen] = useState(false);

    return html`<button class=${`rb-prompt ${open ? "open" : ""}`} aria-expanded=${open} onClick=${() => setOpen(!open)} data-part="running-prompt">
        <span class="muted small">${prompt.from ? t("{name} asked", { name: prompt.from }) : t("Working on")}</span>
        <span class="rb-prompt-text">${prompt.text}</span>
    </button>`;
}

/** Everything at work in the sessions you can see: open one, stop a run, or cancel a scheduled message. */
export function RunningSheet() {
    const [board, setBoard] = useState(null);
    const [failed, setFailed] = useState(null);
    const now = useNow();

    useEffect(() => {
        let open = true;
        const load = () =>
            api("running/board").then(
                (next) => {
                    if (open) {
                        setBoard(next);
                        setFailed(null);
                    }
                },
                (error) => open && setFailed(error.message),
            );

        load();
        const timer = setInterval(load, RUNNING_EVERY_MS);

        return () => {
            open = false;
            clearInterval(timer);
        };
    }, []);
    const steer = canSteer();

    const go = (id) => {
        closeSheet();
        navigate(id);
    };

    const stopCommand = (task) => {
        const path = task.kind === "pocket.shell" ? "shell" : "extension-commands";

        return attempt(() => api(`c/${task.conversationId}/${path}/${task.id}/stop`, {}));
    };
    const sessions = board?.sessions ?? [];
    const schedules = board?.schedules ?? [];

    return html`<${Sheet} title=${t("Running now")} onClose=${closeSheet} wide=${true}>
        ${board === null && failed === null && html`<${Loader} label=${t("Looking")} />`}
        ${failed !== null && html`<p class="warn">${failed}</p>`}
        ${
            board !== null &&
            html`<p class="muted small rb-counts" data-part="running-counts">
                ${tn(sessions.length, "{n} session at work", "{n} sessions at work")} · ${tn(schedules.length, "{n} scheduled message", "{n} scheduled messages")}
            </p>`
        }
        ${board !== null && sessions.length === 0 && html`<p class="muted">${t("Nothing is running.")}</p>`}
        ${sessions.map(
            (session) => html`<div class="running" key=${session.id} data-part="running-session" data-session=${session.id}>
                <div class="running-head">
                    <span class="folder-mark" style=${`--folder:${folderColor(session.cwd)}`} aria-hidden="true"></span>
                    <button class="link grow" onClick=${() => go(session.id)}>${session.title}</button>
                    ${session.approvals > 0 && html`<span class="warn small">${tn(session.approvals, "{n} waiting for approval", "{n} waiting for approval")}</span>`}
                    ${steer && session.busy && html`<button class="button small" onClick=${() => attempt(() => api(`c/${session.id}/abort`, {}))}>${t("Stop")}</button>`}
                </div>
                <div class="rb-facts muted small">
                    ${[session.model, session.spent > 0 ? dollars(session.spent) : null].filter(Boolean).join(" · ")}
                    ${session.approval && html`<span class="rb-approval mono" title=${session.approval.subject}>${session.approval.tool}: ${session.approval.subject}</span>`}
                </div>
                ${session.prompt && html`<${Prompt} prompt=${session.prompt} />`}
                ${session.tasks.map(
                    (task) => html`<div class="running-task" key=${task.id}>
                        ${task.status === "running" ? html`<${Spinner} />` : html`<span class="muted">·</span>`}
                        <span class="grow">
                            ${task.subagent && html`<span class="mono">${task.subagent}</span>: `}
                            ${task.label}
                        </span>
                        <span class="muted small mono" data-part="running-elapsed" title=${t("How long it has been at work")}>${task.since === undefined ? task.status : span(now - task.since)}</span>
                        ${
                            steer &&
                            task.scheduleId &&
                            html`<button class="link small" onClick=${() => attempt(() => api(`c/${task.conversationId}/schedules/${encodeURIComponent(task.scheduleId)}/cancel`, {}))}>${t("Cancel")}</button>`
                        }
                        ${
                            steer &&
                            task.subagent &&
                            task.kind === "pi.generation" &&
                            html`<button class="link small" onClick=${() => attempt(() => api(`c/${task.conversationId}/abort`, {}))}>${t("Stop")}</button>`
                        }
                        ${
                            steer &&
                            ["pocket.shell", "pocket.extension-command"].includes(task.kind) &&
                            html`<button class="link small" onClick=${() => stopCommand(task)}>${t("Stop")}</button>`
                        }
                    </div>`,
                )}
            </div>`,
        )}
        ${schedules.length > 0 && html`<${Scheduled} schedules=${schedules} now=${now} steer=${steer} go=${go} />`}
    <//>`;
}
