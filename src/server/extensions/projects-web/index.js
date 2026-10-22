// Projects (src/server/extensions/projects.ts): the board of a project in the conversation's place, from the rail and the
// launcher, with ACS's Kanban (owner's choice): a column per state on a canvas lighter than the board, cards darker than
// the column, each with its type, priority, parent, progress, and a footer of ID, due date, age, and assignee. On a
// desktop a card is dragged to another state (and place); on a phone the states are tabs over one column at a time,
// swiped, and a long press offers Move to. A card opens its task in a sheet: every field, checklist, links, comments,
// activity, and the sessions that worked on it. The session menu's "Board for this session" turns board mode on or off.
const BOARD = "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z";

// Agent-board's states, with ACS's tones in the theme's palette (their names: stateLabel, in the person's language).
const STATES = [
    { id: "inbox", tone: "var(--muted)", icon: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" },
    { id: "planning", tone: "var(--accent)", icon: "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6M9 16h3" },
    { id: "assigned", tone: "var(--warn)", icon: "M9 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM3 21v-1a6 6 0 0 1 12 0v1M16 11l2 2 4-4" },
    { id: "in_progress", tone: "var(--o-cyan)", wip: 5, icon: "M13 2 4 14h7l-1 8 9-12h-7z" },
    { id: "blocked", tone: "var(--err)", icon: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 8v5M12 16h.01" },
    { id: "testing", tone: "var(--o-orange)", wip: 3, icon: "M9 3h6M10 3v6L5 19a1.5 1.5 0 0 0 1.3 2h11.4A1.5 1.5 0 0 0 19 19l-5-10V3M7.5 15h9" },
    { id: "review", tone: "var(--spark)", icon: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" },
    { id: "done", tone: "var(--ok)", icon: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM8 12l3 3 5-6" },
];
const STATE = Object.fromEntries(STATES.map((state) => [state.id, state]));

// Agent-board's task types: the chip on every card (their names: typeLabel).
const TYPES = [
    { id: "epic", tone: "var(--spark)", icon: "M12 3 21 12 12 21 3 12z" },
    { id: "story", tone: "var(--accent)", icon: "M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" },
    { id: "task", tone: "var(--muted)", icon: "M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14z" },
    { id: "bug", tone: "var(--err)", icon: "M12 7a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0v-5a4 4 0 0 1 4-4zM12 20v-7M4 10l4 1.5M20 10l-4 1.5M4 16h4M16 16h4M9.5 4l1.5 3M14.5 4 13 7" },
    { id: "subtask", tone: "var(--muted)", icon: "M6 4v7a4 4 0 0 0 4 4h8M15 12l3 3-3 3" },
];
const TYPE = Object.fromEntries(TYPES.map((type) => [type.id, type]));
// A run's states, with the colour its chip takes (in words: runLabel).
const RUN = {
    queued: "var(--faint)",
    starting: "var(--o-cyan)",
    running: "var(--o-cyan)",
    done: "var(--ok)",
    failed: "var(--err)",
    stopped: "var(--warn)",
    cancelled: "var(--faint)",
};
const ACTIVE = new Set(["queued", "starting", "running"]);
const PHONE = matchMedia("(max-width: 760px)");
const CURRENT = "pi-phone.projects.current";
/** The view the page shows (kept on this device), and the views. */
const VIEW = "pi-phone.projects.view";
/** A shared board's project wiki (the team server): a view of its own. Views' names: viewLabel. */
const WIKI_VIEW = ["wiki", "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10"];
const VIEWS = [
    ["board", "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z"],
    ["list", "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"],
    ["timeline", "M4 6h9M8 12h12M6 18h8"],
    ["calendar", "M5 5h14v15H5zM5 10h14M9 3v4M15 3v4"],
];

/** "2026-10-20" as "Oct 20". */
function dayLabel(day) {
    const date = new Date(`${day}T00:00:00`);

    return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Whether a due day has passed (late) or is today or tomorrow (soon). */
function dueClass(day, state) {
    if (state === "done") {
        return "";
    }

    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const due = new Date(`${day}T00:00:00`).getTime();

    return due < start ? "late" : due <= start + 86_400_000 ? "soon" : "";
}

const initials = (name) =>
    name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("") || "?";

export default function projects(pocket) {
    const { html, useState, useEffect, useRef, useMemo, Icon, Loader, Markdown, Switch, t, tn, tx } = pocket;
    // The shown names of the module's ids (STATES, TYPES, priorities 0-4, RUN, VIEWS), in the person's language.
    const stateLabel = {
        inbox: t("Inbox"),
        planning: t("Planning"),
        assigned: t("Assigned"),
        in_progress: t("In Progress"),
        blocked: t("Blocked"),
        testing: t("Testing"),
        review: t("Review"),
        done: t("Done"),
    };
    const typeLabel = { epic: t("epic"), story: t("story"), task: t("task"), bug: t("bug"), subtask: t("sub-task") };
    const priorityLabel = [t("None"), t("Low"), t("Medium"), t("High"), t("Urgent")];
    const priorityTitle = [t("No priority"), t("Low priority"), t("Medium priority"), t("High priority"), t("Urgent priority")];
    const runLabel = {
        queued: t("Waiting for a place"),
        starting: t("Starting"),
        running: t("Running"),
        done: t("Finished"),
        failed: t("Failed"),
        stopped: t("Stopped"),
        cancelled: t("Cancelled"),
    };
    /** A run's state inside a line, in lower case. */
    const runLower = {
        queued: t("waiting for a place"),
        starting: t("starting"),
        running: t("running"),
        done: t("finished"),
        failed: t("failed"),
        stopped: t("stopped"),
        cancelled: t("cancelled"),
    };
    /** A task type as the activity names it (its id). */
    const typeWord = { epic: t("epic"), story: t("story"), task: t("task"), bug: t("bug"), subtask: t("subtask") };
    /** What a change to a field reads as in the activity. */
    const changedWords = {
        type: t("changed type"),
        title: t("changed title"),
        description: t("changed description"),
        priority: t("changed priority"),
        labels: t("changed labels"),
        start: t("changed start"),
        due: t("changed due"),
        parent: t("changed parent"),
        checklist: t("changed checklist"),
        operatorReview: t("changed approval"),
        fixVerified: t("changed fix verified"),
        blockedReason: t("changed blockedReason"),
    };
    const viewLabel = { board: t("Board"), list: t("List"), timeline: t("Timeline"), calendar: t("Calendar"), wiki: t("Wiki") };
    const MONTHS = [t("January"), t("February"), t("March"), t("April"), t("May"), t("June"), t("July"), t("August"), t("September"), t("October"), t("November"), t("December")];
    const SHORT_MONTHS = [t("Jan"), t("Feb"), t("Mar"), t("Apr"), t("May"), t("Jun"), t("Jul"), t("Aug"), t("Sep"), t("Oct"), t("Nov"), t("Dec")];
    const WEEKDAYS = [t("Mon"), t("Tue"), t("Wed"), t("Thu"), t("Fri"), t("Sat"), t("Sun")];
    /** A weekday's one-letter mark, Monday first: "MTWTFSS" in English, one character a day. */
    const WEEKDAY_MARKS = [...t("MTWTFSS")];
    /** How long ago, short: 5m, 2h, 3d. */
    const ago = (ms) => {
        const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));

        return minutes < 60 ? t("{n}m", { n: minutes }) : minutes < 48 * 60 ? t("{n}h", { n: Math.round(minutes / 60) }) : t("{n}d", { n: Math.round(minutes / 1440) });
    };
    /** What the next opening of the page shows: a project's key. */
    let pendingKey = null;

    pocket.style("projects.css");

    const svg = (path, size = 14, cls = "") =>
        html`<svg class=${cls} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${path} /></svg>`;
    const typeChip = (type) => {
        const kind = TYPE[type] ?? TYPE.task;

        return html`<span class=${`pj-type pj-type-${kind.id}`} style=${`--tt:${kind.tone}`}>${svg(kind.icon, 11)}${typeLabel[kind.id]}</span>`;
    };
    const priority = (value) =>
        value === 4
            ? html`<span class="pj-prio urgent" title=${t("Urgent")}>!</span>`
            : html`<span class="pj-prio" title=${priorityTitle[value]} data-p=${value}><i></i><i></i><i></i></span>`;
    const avatar = (assignee, people) => {
        if (assignee === null) {
            return html`<span class="pj-av none" title=${t("Nobody yet")}>+</span>`;
        }

        if (assignee === "pi") {
            // pi-phone's own mark (web/icon.svg), as the rail and sign-in show it.
            return html`<span class="pj-av pi" title="Pi"><img src="icon.svg" alt="" draggable="false" /></span>`;
        }

        // A person's own Pi (the team server): Pi's mark, named for them.
        if (assignee.startsWith("pi:")) {
            const whose = people.find((person) => person.id === assignee.slice(3))?.name;

            return html`<span class="pj-av pi" title=${whose === undefined || whose === null ? t("Pi (someone)") : t("Pi ({name})", { name: whose })}><img src="icon.svg" alt="" draggable="false" /></span>`;
        }

        const name = people.find((person) => person.id === assignee)?.name ?? t("Someone");

        return html`<span class="pj-av" title=${name}>${initials(name)}</span>`;
    };
    const failed = (error) => pocket.notify("error", error.message);
    const patchTask = (ref, body) => pocket.api(`tasks/${ref}`, body, { method: "PATCH" });

    /** Everyone, for assignees and sharing; loaded once a page or sheet needs them. */
    let peopleCache = null;
    /** Who this person is on the boards, and whether they are the team server's (PP-43): team boards, roles, Wiki. */
    let teamCache = null;
    const loadPeople = () =>
        pocket.api("people").then((answer) => {
            peopleCache = answer.people;
            teamCache = { me: answer.me, team: answer.team === true };

            return answer;
        });
    const usePeople = () => {
        const [people, setPeople] = useState(peopleCache ?? []);

        useEffect(() => {
            if (peopleCache === null) {
                loadPeople().then((answer) => setPeople(answer.people), () => {});
            }
        }, []);

        return people;
    };
    const useTeam = () => {
        const [team, setTeam] = useState(teamCache ?? { me: null, team: false });

        useEffect(() => {
            if (teamCache === null) {
                loadPeople().then(() => setTeam(teamCache), () => {});
            }
        }, []);

        return team;
    };
    /** Whether `me` leads `project`: makes it, leads it, or (a team board) manages team boards; the phone's owner leads all. */
    const leads = (team, project) =>
        team.team
            ? project.owner === team.me?.id || project.memberRoles?.[team.me?.id] === "lead" || (project.team && team.me?.managesTeam === true)
            : pocket.me()?.role === "owner" || pocket.me()?.id === project.owner;

    // ─── The page ─────────────────────────────────────────────────────────────────

    function ProjectsPage() {
        const [list, setList] = useState(null);
        const [key, setKey] = useState(pendingKey ?? localStorage.getItem(CURRENT));
        const [board, setBoard] = useState(null);
        const [problem, setProblem] = useState(null);
        const [picking, setPicking] = useState(false);
        const [view, setView] = useState(() => localStorage.getItem(VIEW) ?? "board");
        const people = usePeople();
        const team = useTeam();
        const keyRef = useRef(key);
        /** The boards by whose they are, on the team server: Mine, Team, Shared with me. */
        const groups = (boards) =>
            team.team
                ? [
                      [t("Mine"), boards.filter((each) => each.owner === team.me?.id)],
                      [t("Team"), boards.filter((each) => each.team)],
                      [t("Shared with me"), boards.filter((each) => !each.team && each.owner !== team.me?.id)],
                  ]
                : [[null, boards]];

        keyRef.current = key;
        pendingKey = null;

        const loadList = () =>
            pocket.api("projects").then(
                (answer) => {
                    setList(answer.projects);

                    if (!answer.projects.some((project) => project.key === keyRef.current)) {
                        setKey(answer.projects[0]?.key ?? null);
                    }
                },
                (error) => setProblem(error.message),
            );
        const loadBoard = () => {
            const current = keyRef.current;

            if (current === null) {
                setBoard(null);

                return;
            }

            pocket.api(`projects/${current}`).then(
                (answer) => {
                    if (keyRef.current === current) {
                        setBoard(answer);
                        setProblem(null);
                    }
                },
                (error) => setProblem(error.message),
            );
        };

        useEffect(() => {
            loadList();

            // Changes by anyone (people, Pi) as they happen.
            return pocket.on("changed", () => {
                loadList();
                loadBoard();
            });
        }, []);
        useEffect(() => {
            if (key !== null) {
                localStorage.setItem(CURRENT, key);
            }

            setBoard(null);
            loadBoard();
        }, [key]);

        if (list === null) {
            return problem ? html`<p class="pj-problem">${problem}</p>` : html`<${Loader} label=${t("Opening projects")} />`;
        }

        if (list.length === 0) {
            return html`<div class="pj-empty-page">
                <div class="pj-empty-icon">${svg(BOARD, 28)}</div>
                <h3>${t("No projects yet")}</h3>
                <p class="muted">${t("A board of tasks for you and Pi: a backlog that keeps work from being forgotten. Pi also offers to start one when a session's work has several parts.")}</p>
                <button class="button primary" onClick=${() => pocket.openSheet("new-project")}>${t("New project")}</button>
            </div>`;
        }

        const project = list.find((each) => each.key === key);
        const counts = project?.counts ?? {};
        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

        return html`<div class="pj">
            <div class="pj-top">
                <div class="pj-picker">
                    <button class="pj-title-button" aria-haspopup="listbox" aria-expanded=${picking} onClick=${() => setPicking(!picking)}>
                        <span class="pj-key">${project?.key}</span>
                        <span class="pj-name">${project?.name}</span>
                        ${svg("m6 9 6 6 6-6", 14)}
                    </button>
                    ${
                        picking &&
                        html`<div class="pj-menu" role="listbox">
                            ${groups(list).map(
                                ([heading, boards]) => html`${heading && boards.length > 0 && html`<div class="pj-menu-h">${heading}</div>`}
                                ${boards.map(
                                    (each) => html`<button
                                        role="option"
                                        aria-selected=${each.key === key}
                                        class=${each.key === key ? "on" : ""}
                                        onClick=${() => {
                                            setPicking(false);
                                            setKey(each.key);
                                        }}
                                    >
                                        <span class="pj-key">${each.key}</span><span>${each.name}</span>
                                    </button>`,
                                )}`,
                            )}
                            <button
                                class="pj-menu-new"
                                onClick=${() => {
                                    setPicking(false);
                                    pocket.openSheet("new-project");
                                }}
                            >
                                ${t("+ New project")}
                            </button>
                        </div>`
                    }
                </div>
                <span class="pj-sp"></span>
                <button class="button small ghost" title=${t("Tasks given to you or your Pi, on every board")} onClick=${() => pocket.openSheet("mine")}>${t("Mine")}</button>
                <button
                    class="button small ghost"
                    title=${t("This board's documents")}
                    onClick=${() => {
                        // The Documents page opens on the place it finds here (PP-47).
                        localStorage.setItem("pi-phone.docs.place", `project:${key}`);
                        pocket.openPageOf("docs", "docs");
                    }}
                >
                    ${t("Docs")}
                </button>
                <button class="icon-button" title=${t("Project settings")} aria-label=${t("Project settings")} onClick=${() => pocket.openSheet("project", { project: key })}>
                    ${svg("M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6", 18)}
                </button>
                <button class="button primary small pj-add" onClick=${() => pocket.openSheet("new-task", { project: key })}>${t("+ Task")}</button>
            </div>
            <div class="pj-chips">
                ${[
                    ["blocked", t("Blocked")],
                    ["review", t("Review")],
                    ["in_progress", t("In progress")],
                    ["testing", t("Testing")],
                ].map(
                    ([state, label]) =>
                        counts[state] > 0 &&
                        html`<span class=${`pj-chip ${state === "blocked" ? "need" : ""}`} style=${`--tone:${STATE[state].tone}`}>
                            <i></i>${label} <b>${counts[state]}</b>
                        </span>`,
                )}
                ${(() => {
                    const runs = (board?.tasks ?? []).map((task) => task.run?.state);
                    const running = runs.filter((state) => state === "running" || state === "starting").length;
                    const queued = runs.filter((state) => state === "queued").length;

                    return html`${running > 0 && html`<span class="pj-chip" style="--tone:var(--o-cyan)"><i></i>${tx("Running {count}", { count: html`<b>${running}</b>` })}</span>`}
                    ${queued > 0 && html`<span class="pj-chip" style="--tone:var(--faint)"><i></i>${tx("Queued {count}", { count: html`<b>${queued}</b>` })}</span>`}`;
                })()}
                ${board?.lead && html`<a class="pj-chip pj-lead-chip" href=${`s/${board.lead.session}`} title=${t("The project's main session")}>${svg("M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z", 12)} ${t("Main session")}</a>`}
                <span class="pj-chip quiet">${tn(total, "{n} task · {done} done", "{n} tasks · {done} done", { done: counts.done ?? 0 })}</span>
            </div>
            <div class="pj-views" role="tablist" aria-label=${t("View")}>
                ${VIEWS.concat(team.team ? [WIKI_VIEW] : []).map(
                    ([id, path]) => html`<button
                        role="tab"
                        aria-selected=${view === id}
                        class=${view === id ? "on" : ""}
                        onClick=${() => {
                            setView(id);
                            localStorage.setItem(VIEW, id);
                        }}
                    >${svg(path, 14)}<span>${viewLabel[id]}</span></button>`,
                )}
            </div>
            ${problem && html`<p class="pj-problem">${problem}</p>`}
            ${
                board === null
                    ? html`<${Loader} label=${t("Opening the board")} />`
                    : view === "wiki" && team.team
                      ? html`<${WikiView} project=${board.project} team=${team} />`
                      : view === "list"
                      ? html`<${ListView} board=${board} people=${people} />`
                      : view === "timeline"
                        ? html`<${TimelineView} board=${board} people=${people} />`
                        : view === "calendar"
                          ? html`<${CalendarView} board=${board} />`
                          : html`<${Kanban} board=${board} people=${people} reload=${loadBoard} />`
            }
        </div>`;
    }

    // ─── List, Timeline, Calendar ─────────────────────────────────────────────────

    /** A day as the app keeps it ("2026-10-19"), from a Date in local time. */
    const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    /** A kept day as a Date at local midnight. */
    const dateOf = (day) => {
        const [year, month, date] = day.split("-").map(Number);

        return new Date(year, month - 1, date);
    };
    const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
    const daysBetween = (from, to) => Math.round((to - from) / 86_400_000);
    const today = () => dateOf(dayOf(new Date()));
    /** Monday 0 … Sunday 6. */
    const weekday = (date) => (date.getDay() + 6) % 7;

    /** A task's run, in a word and a color, for rows and chips; or null when it never ran or it is long over. */
    const runWord = (task) => {
        const run = task.run;

        if (!run) {
            return null;
        }

        if (run.state === "running" || run.state === "starting") {
            return { text: t("Working"), tone: "var(--o-cyan)", live: true };
        }

        if (run.state === "queued") {
            return { text: t("Queued"), tone: "var(--faint)" };
        }

        if (run.merged) {
            return { text: t("Merged"), tone: "var(--ok)" };
        }

        if (run.state === "done" && task.state === "review") {
            return { text: t("To review"), tone: "var(--accent)" };
        }

        if (run.state === "failed" || run.state === "stopped") {
            return { text: runLabel[run.state], tone: RUN[run.state] };
        }

        return null;
    };
    const progressBar = (task) =>
        task.progress && html`<span class="pv-sub" title=${t("{done} of {total} done", { done: task.progress[0], total: task.progress[1] })}><span class="pv-bar"><i style=${`width:${Math.round((task.progress[0] / task.progress[1]) * 100)}%`}></i></span>${task.progress[0]}/${task.progress[1]}</span>`;
    const dueChip = (task) => task.due && html`<span class=${`pv-due ${dueClass(task.due, task.state)}`}>${dayLabel(task.due)}</span>`;
    const openTask = (ref) => pocket.openSheet("task", { task: ref });

    /** Every task, grouped by state, assignee, priority, or label; a row each, a table on a desk. */
    function ListView({ board, people }) {
        const storeKey = "pi-phone.projects.list";
        const [group, setGroup] = useState(() => localStorage.getItem(`${storeKey}.group`) ?? "state");
        const [folded, setFolded] = useState(() => new Set(JSON.parse(localStorage.getItem(`${storeKey}.folded`) ?? '["state:done"]')));
        const name = (assignee) => (assignee === null ? t("Nobody") : assignee === "pi" ? "Pi" : (people.find((person) => person.id === assignee)?.name ?? t("Someone")));
        const order = (a, b) => b.priority - a.priority || a.number - b.number;
        const groups = (() => {
            const tasks = board.tasks;

            if (group === "assignee") {
                const keys = [...new Set(tasks.map((task) => task.assignee))].sort((a, b) => (a === null) - (b === null) || (a === "pi" ? -1 : b === "pi" ? 1 : name(a).localeCompare(name(b))));

                return keys.map((key) => ({ key: `assignee:${key}`, label: name(key), mark: key === null ? null : avatar(key, people), tasks: tasks.filter((task) => task.assignee === key) }));
            }

            if (group === "priority") {
                return [4, 3, 2, 1, 0].map((value) => ({ key: `priority:${value}`, label: value === 0 ? t("No priority") : priorityLabel[value], mark: value > 0 ? priority(value) : null, tasks: tasks.filter((task) => task.priority === value) }));
            }

            if (group === "label") {
                const labels = [...new Set(tasks.flatMap((task) => task.labels))].sort();

                return [
                    ...labels.map((label) => ({ key: `label:${label}`, label, mark: null, tasks: tasks.filter((task) => task.labels.includes(label)) })),
                    { key: "label:", label: t("No label"), mark: null, tasks: tasks.filter((task) => task.labels.length === 0) },
                ];
            }

            return STATES.map((state) => ({ key: `state:${state.id}`, label: stateLabel[state.id], mark: html`<span class="pt-dot" style=${`--tone:${state.tone}`}></span>`, tasks: tasks.filter((task) => task.state === state.id) }));
        })().filter((each) => each.tasks.length > 0);
        const fold = (key) => {
            const next = new Set(folded);

            next.has(key) ? next.delete(key) : next.add(key);
            setFolded(next);
            localStorage.setItem(`${storeKey}.folded`, JSON.stringify([...next]));
        };
        const pick = (value) => {
            setGroup(value);
            localStorage.setItem(`${storeKey}.group`, value);
        };

        return html`<div class="pv pv-list">
            <div class="pv-bar-top">
                <span class="pv-hint">${t("Group")}</span>
                <span class="pt-seg">
                    ${[
                        ["state", t("State")],
                        ["assignee", t("Assignee")],
                        ["priority", t("Priority")],
                        ["label", t("Label")],
                    ].map(([value, label]) => html`<button class=${group === value ? "on" : ""} aria-pressed=${group === value} onClick=${() => pick(value)}>${label}</button>`)}
                </span>
                <span class="pj-sp"></span>
                <span class="pv-hint pv-wide">${t("By priority, then number")}</span>
            </div>
            ${board.tasks.length === 0 && html`<p class="pv-empty">${t("No tasks yet. + Task adds one.")}</p>`}
            <div class="pv-scroll">
                <table class="pv-table">
                    <thead>
                        <tr><th>${t("ID")}</th><th>${t("Title")}</th><th>${t("Priority")}</th><th>${t("Assignee")}</th><th>${t("Labels")}</th><th>${t("Due")}</th><th>${t("Run")}</th></tr>
                    </thead>
                    ${groups.map(
                        (each) => html`<tbody>
                            <tr class="pv-group" onClick=${() => fold(each.key)}>
                                <td colspan="7">
                                    <span class="pv-group-in">${svg(folded.has(each.key) ? CHEVRON : "M6 9l6 6 6-6", 12)}${each.mark}${each.label}<span class="pt-n">${each.tasks.length}</span></span>
                                </td>
                            </tr>
                            ${
                                !folded.has(each.key) &&
                                [...each.tasks].sort(order).map((task) => {
                                    const run = runWord(task);

                                    return html`<tr class="pv-task" tabindex="0" onClick=${() => openTask(task.ref)} onKeyDown=${(event) => event.key === "Enter" && openTask(task.ref)}>
                                        <td class="pv-ref">${task.ref}</td>
                                        <td class="pv-title">${task.type !== "task" && html`${typeChip(task.type)} `}${task.title}${task.state === "blocked" && html` <span class="pv-blocked">${t("Blocked")}</span>`}</td>
                                        <td>${task.priority > 0 ? priority(task.priority) : html`<span class="pv-none">—</span>`}</td>
                                        <td><span class="pv-who">${avatar(task.assignee, people)}${name(task.assignee)}</span></td>
                                        <td>${task.labels.map((label) => html`<span class="pv-label">${label}</span>`)}</td>
                                        <td>${dueChip(task) || html`<span class="pv-none">—</span>`}</td>
                                        <td>${run ? html`<span class="pv-run" style=${`--tone:${run.tone}`}><i class=${run.live ? "live" : ""}></i>${run.text}</span>` : progressBar(task)}</td>
                                    </tr>`;
                                })
                            }
                        </tbody>`,
                    )}
                </table>
                <div class="pv-rows">
                    ${groups.map(
                        (each) => html`<button class="pv-row-group" aria-expanded=${!folded.has(each.key)} onClick=${() => fold(each.key)}>
                                ${svg(folded.has(each.key) ? CHEVRON : "M6 9l6 6 6-6", 12)}${each.mark}${each.label}<span class="pt-n">${each.tasks.length}</span>
                            </button>
                            ${
                                !folded.has(each.key) &&
                                [...each.tasks].sort(order).map((task) => {
                                    const run = runWord(task);

                                    return html`<button class="pv-row" onClick=${() => openTask(task.ref)}>
                                        <span class="pv-row-prio">${task.priority > 0 ? priority(task.priority) : null}</span>
                                        <span class="pv-row-main">
                                            <span class="pv-row-title">${task.title}</span>
                                            <span class="pv-meta">
                                                <span class="pv-ref">${task.ref}</span>
                                                ${group !== "state" && html`<span class="pt-dot" style=${`--tone:${STATE[task.state].tone}`} title=${stateLabel[task.state]}></span>`}
                                                ${dueChip(task)}${progressBar(task)}
                                                ${run && html`<span class="pv-run" style=${`--tone:${run.tone}`}><i class=${run.live ? "live" : ""}></i>${run.text}</span>`}
                                            </span>
                                        </span>
                                        ${avatar(task.assignee, people)}
                                    </button>`;
                                })
                            }`,
                    )}
                </div>
            </div>
        </div>`;
    }

    /** Tasks with dates on a time line, by state: a bar from start to due (dashed from when it was made, without a start). */
    function TimelineView({ board, people }) {
        const [zoom, setZoom] = useState(() => localStorage.getItem("pi-phone.projects.zoom") ?? "week");
        const scroller = useRef(null);
        const now = today();
        const width = zoom === "week" ? 32 : 14;
        const dated = board.tasks.filter((task) => task.state !== "done" && (task.due || task.start));
        const undated = board.tasks.filter((task) => task.state !== "done" && !task.due && !task.start).length;
        const spanOf = (task) => {
            const made = dateOf(dayOf(new Date(task.createdAt)));
            const start = task.start ? dateOf(task.start) : null;
            const due = task.due ? dateOf(task.due) : null;
            // No start: from when it was made, but not after its due day. No due: one day.
            const from = start ?? (due && made > due ? due : made);
            const to = due ?? from;

            return { from, to: to < from ? from : to, inferred: start === null };
        };
        const spans = new Map(dated.map((task) => [task.ref, spanOf(task)]));
        const first = addDays([now, ...[...spans.values()].map((span) => span.from)].reduce((a, b) => (b < a ? b : a)), -3);
        const last = addDays([addDays(now, zoom === "week" ? 21 : 60), ...[...spans.values()].map((span) => span.to)].reduce((a, b) => (b > a ? b : a)), 3);
        const days = Array.from({ length: daysBetween(first, last) + 1 }, (_each, index) => addDays(first, index));
        const x = (date) => daysBetween(first, date) * width;
        // The months the days span: a stretch each, whose name stays in view while its days scroll by.
        const months = days.reduce((all, date) => {
            const last = all.at(-1);

            if (last && last.month === date.getMonth() && last.year === date.getFullYear()) {
                last.days += 1;
            } else {
                all.push({ month: date.getMonth(), year: date.getFullYear(), days: 1 });
            }

            return all;
        }, []);
        const groups = STATES.filter((state) => state.id !== "done")
            .map((state) => ({ state, tasks: dated.filter((task) => task.state === state.id).sort((a, b) => spans.get(a.ref).from - spans.get(b.ref).from) }))
            .filter((each) => each.tasks.length > 0);
        const toToday = (smooth) => {
            const box = scroller.current;

            if (box) {
                box.scrollTo({ left: Math.max(0, x(now) - 2 * width), behavior: smooth ? "smooth" : "auto" });
            }
        };

        // Open at today, with two days before it in view.
        useEffect(() => {
            toToday(false);
            requestAnimationFrame(() => toToday(false));
        }, [zoom, board.project.key]);

        return html`<div class="pv pv-timeline">
            <div class="pv-bar-top">
                <span class="pt-seg">
                    ${[
                        ["week", t("Week")],
                        ["month", t("Month")],
                    ].map(
                        ([value, label]) => html`<button
                            class=${zoom === value ? "on" : ""}
                            aria-pressed=${zoom === value}
                            onClick=${() => {
                                setZoom(value);
                                localStorage.setItem("pi-phone.projects.zoom", value);
                            }}
                        >${label}</button>`,
                    )}
                </span>
                <span class="pj-sp"></span>
                <span class="pv-hint pv-wide">${undated > 0 ? t("{n} without dates · Dashed: no start date", { n: undated }) : t("Dashed: no start date")}</span>
                <button class="pv-btn" onClick=${() => toToday(true)}>${t("Today")}</button>
            </div>
            ${
                groups.length === 0
                    ? html`<p class="pv-empty">${undated > 0 ? t("No open task has a date yet. Give one a start or due date in its sheet ({n} without dates).", { n: undated }) : t("No open task has a date yet. Give one a start or due date in its sheet.")}</p>`
                    : html`<div class="pv-tl-scroll" ref=${scroller}>
                          <div class="pv-tl">
                              <div class="pv-tl-labels">
                                  <div class="pv-tl-corner">${t("Task")}</div>
                                  ${groups.map(
                                      (each) => html`<div class="pv-tl-group"><span class="pt-dot" style=${`--tone:${each.state.tone}`}></span>${stateLabel[each.state.id]}<span class="pt-n">${each.tasks.length}</span></div>
                                          ${each.tasks.map((task) => html`<button class="pv-tl-label" onClick=${() => openTask(task.ref)}>${avatar(task.assignee, people)}<span>${task.title}</span></button>`)}`,
                                  )}
                              </div>
                              <div class="pv-tl-track" style=${`width:${days.length * width}px`}>
                                  <div class="pv-tl-head">
                                      <div class="pv-tl-months">
                                          ${months.map(
                                              (each) => html`<div class="pv-tl-month" style=${`width:${each.days * width}px`}><span>${each.year !== now.getFullYear() || each === months[0] ? t("{month} {year}", { month: MONTHS[each.month], year: each.year }) : MONTHS[each.month]}</span></div>`,
                                          )}
                                      </div>
                                      <div class="pv-tl-days">
                                          ${days.map(
                                              (date) => html`<div class=${`pv-tl-day ${weekday(date) === 0 ? "mon" : ""} ${daysBetween(date, now) === 0 ? "today" : ""}`} style=${`width:${width}px`}>
                                                  ${zoom === "week" && html`<span>${WEEKDAY_MARKS[weekday(date)]}</span>`}
                                                  <b>${zoom === "week" || weekday(date) === 0 ? date.getDate() : ""}</b>
                                              </div>`,
                                          )}
                                      </div>
                                  </div>
                                  ${days.filter((date) => weekday(date) >= 5).map((date) => html`<div class="pv-tl-weekend" style=${`left:${x(date)}px;width:${width}px`}></div>`)}
                                  <div class="pv-tl-today" style=${`left:${x(now) + width / 2 - 1}px`}></div>
                                  ${groups.map(
                                      (each) => html`<div class="pv-tl-gap"></div>
                                          ${each.tasks.map((task) => {
                                              const span = spans.get(task.ref);
                                              const run = runWord(task);

                                              return html`<div class="pv-tl-row">
                                                  <button
                                                      class=${`pv-tl-bar ${span.inferred ? "inferred" : ""}`}
                                                      style=${`left:${x(span.from) + 2}px;width:${Math.max(width - 4, (daysBetween(span.from, span.to) + 1) * width - 4)}px;--tone:${each.state.tone}`}
                                                      title=${
                                                          span.inferred
                                                              ? task.due
                                                                  ? t("{ref}: {title}, made {from} → due {due}", { ref: task.ref, title: task.title, from: dayLabel(dayOf(span.from)), due: dayLabel(task.due) })
                                                                  : t("{ref}: {title}, made {from}", { ref: task.ref, title: task.title, from: dayLabel(dayOf(span.from)) })
                                                              : task.due
                                                                ? t("{ref}: {title}, from {from} → due {due}", { ref: task.ref, title: task.title, from: dayLabel(dayOf(span.from)), due: dayLabel(task.due) })
                                                                : t("{ref}: {title}, from {from}", { ref: task.ref, title: task.title, from: dayLabel(dayOf(span.from)) })
                                                      }
                                                      onClick=${() => openTask(task.ref)}
                                                  >
                                                      ${run?.live && html`<i class="live"></i>`}<span class="pv-ref">${task.ref}</span>${zoom === "week" && html`<span class="pv-tl-name">${task.title}</span>`}
                                                  </button>
                                              </div>`;
                                          })}`,
                                  )}
                              </div>
                          </div>
                      </div>`
            }
        </div>`;
    }

    /** Tasks by due date: a month on a desk, the month's days with work as a list on a phone; and what has no date. */
    function CalendarView({ board }) {
        const now = today();
        const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
        const [over, setOver] = useState(null);
        // On a phone, a day tapped in the month: its tasks alone; none, the month's.
        const [picked, setPicked] = useState(null);
        const open = board.tasks.filter((task) => task.state !== "done" || task.due);
        const byDay = new Map();

        for (const task of open) {
            if (task.due) {
                byDay.set(task.due, [...(byDay.get(task.due) ?? []), task]);
            }
        }

        const unscheduled = board.tasks.filter((task) => !task.due && task.state !== "done");
        const gridStart = addDays(month, -weekday(month));
        const cells = Array.from({ length: 42 }, (_each, index) => addDays(gridStart, index));
        const weeks = cells[35].getMonth() !== month.getMonth() ? 5 : 6;
        const shift = (by) => {
            setPicked(null);
            setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));
        };
        const openTasks = board.tasks.filter((task) => task.state !== "done").length;
        const drop = (event, day) => {
            event.preventDefault();
            setOver(null);

            const ref = event.dataTransfer.getData("text/x-task");

            if (ref) {
                patchTask(ref, { due: day }).then(() => pocket.notify("info", day === null ? t("{ref} is due on no day.", { ref }) : t("{ref} is due {day}.", { ref, day: dayLabel(day) })), failed);
            }
        };
        const chip = (task) => {
            const run = runWord(task);

            return html`<button
                class=${`pv-chip ${task.state === "done" ? "done" : ""}`}
                style=${`--tone:${STATE[task.state].tone}`}
                draggable="true"
                title=${t("{ref}: {title} ({state})", { ref: task.ref, title: task.title, state: stateLabel[task.state] })}
                onDragStart=${(event) => {
                    event.dataTransfer.setData("text/x-task", task.ref);
                    event.dataTransfer.effectAllowed = "move";
                }}
                onClick=${() => openTask(task.ref)}
            >
                ${run?.live && html`<i class="live"></i>`}<span class="pv-chip-text"><span class="pv-ref">${task.ref}</span> ${task.title}</span>
            </button>`;
        };
        const target = (day) => ({
            onDragOver: (event) => {
                event.preventDefault();
                setOver(day);
            },
            onDragLeave: () => setOver((current) => (current === day ? null : current)),
            onDrop: (event) => drop(event, day),
        });
        const agenda = picked
            ? [dateOf(picked)]
            : cells.filter((date) => date.getMonth() === month.getMonth() && byDay.has(dayOf(date)));

        return html`<div class="pv pv-calendar">
            <div class="pv-bar-top">
                <button class="pv-btn" aria-label=${t("Previous month")} onClick=${() => shift(-1)}>${svg("M15 6l-6 6 6 6", 14)}</button>
                <strong class="pv-month">${t("{month} {year}", { month: MONTHS[month.getMonth()], year: month.getFullYear() })}</strong>
                <button class="pv-btn" aria-label=${t("Next month")} onClick=${() => shift(1)}>${svg(CHEVRON, 14)}</button>
                ${(month.getMonth() !== now.getMonth() || month.getFullYear() !== now.getFullYear()) && html`<button class="pv-btn" onClick=${() => setMonth(new Date(now.getFullYear(), now.getMonth(), 1))}>${t("Today")}</button>`}
                <span class="pj-sp"></span>
                <span class="pv-hint pv-wide">${t("By due date · drag a task to another day")}</span>
            </div>
            <div class="pv-cal">
                <div class="pv-cal-main">
                    <div class="pv-grid" style=${`--weeks:${weeks}`}>
                        ${WEEKDAYS.map((name) => html`<div class="pv-wd">${name}</div>`)}
                        ${cells.slice(0, weeks * 7).map((date) => {
                            const day = dayOf(date);
                            const items = byDay.get(day) ?? [];

                            return html`<div
                                class=${`pv-cell ${date.getMonth() !== month.getMonth() ? "out" : ""} ${daysBetween(date, now) === 0 ? "today" : ""} ${over === day ? "over" : ""}`}
                                ...${target(day)}
                            >
                                <span class="pv-d">${date.getDate()}</span>
                                ${items.slice(0, 3).map(chip)}
                                ${items.length > 3 && html`<button class="pv-more" onClick=${() => openTask(items[3].ref)}>${t("+{n} more", { n: items.length - 3 })}</button>`}
                            </div>`;
                        })}
                    </div>
                    <div class="pv-mini" role="grid" aria-label=${t("{month} {year}", { month: MONTHS[month.getMonth()], year: month.getFullYear() })}>
                        ${WEEKDAY_MARKS.map((name) => html`<span class="pv-mini-wd">${name}</span>`)}
                        ${cells.slice(0, weeks * 7).map((date) => {
                            const day = dayOf(date);
                            const items = byDay.get(day) ?? [];

                            return html`<button
                                class=${`pv-mini-day ${date.getMonth() !== month.getMonth() ? "out" : ""} ${daysBetween(date, now) === 0 ? "today" : ""} ${picked === day ? "picked" : ""}`}
                                aria-pressed=${picked === day}
                                aria-label=${items.length === 0 ? t("{date} {month}: nothing due", { date: date.getDate(), month: MONTHS[date.getMonth()] }) : t("{date} {month}: {n} due", { date: date.getDate(), month: MONTHS[date.getMonth()], n: items.length })}
                                onClick=${() => setPicked(picked === day ? null : day)}
                            >
                                <b>${date.getDate()}</b>
                                <span class="pv-mini-dots">${items.slice(0, 3).map((task) => html`<i style=${`--tone:${STATE[task.state].tone}`}></i>`)}</span>
                            </button>`;
                        })}
                    </div>
                    <div class="pv-agenda">
                        ${picked && html`<button class="pt-act pv-all" onClick=${() => setPicked(null)}>${t("All of {month}", { month: MONTHS[month.getMonth()] })}</button>`}
                        ${agenda.length === 0 && html`<p class="pv-empty">${t("Nothing is due in {month}.", { month: MONTHS[month.getMonth()] })}</p>`}
                        ${agenda.map((date) => {
                            const day = dayOf(date);

                            return html`<div class=${`pv-aday ${daysBetween(date, now) === 0 ? "today" : ""}`}>
                                <h4>${
                                    daysBetween(date, now) === 0
                                        ? t("{weekday} {date} {month} · today", { weekday: WEEKDAYS[weekday(date)], date: date.getDate(), month: SHORT_MONTHS[date.getMonth()] })
                                        : t("{weekday} {date} {month}", { weekday: WEEKDAYS[weekday(date)], date: date.getDate(), month: SHORT_MONTHS[date.getMonth()] })
                                }</h4>
                                ${(byDay.get(day) ?? []).map(chip)}
                                ${!byDay.has(day) && html`<span class="pv-hint">${t("Nothing due")}</span>`}
                            </div>`;
                        })}
                    </div>
                </div>
                <div class=${`pv-panel ${over === "none" ? "over" : ""} ${unscheduled.length === 0 ? "empty" : ""}`}
                    onDragOver=${(event) => (event.preventDefault(), setOver("none"))}
                    onDragLeave=${() => setOver((current) => (current === "none" ? null : current))}
                    onDrop=${(event) => drop(event, null)}
                >
                    <h3>${tx("Unscheduled {count}", { count: html`<span class="pt-n">${unscheduled.length}</span>` })}</h3>
                    ${unscheduled.map(chip)}
                    <span class="pv-hint">${openTasks === 0 ? t("No open tasks.") : unscheduled.length === 0 ? t("Every open task has a due date.") : t("Drag one onto a day to give it a due date, or set it in its sheet.")}</span>
                </div>
            </div>
        </div>`;
    }

    // ─── The Kanban (ACS) ─────────────────────────────────────────────────────────

    function Kanban({ board, people, reload }) {
        const storeKey = `pi-phone.projects.collapsed.${board.project.key}`;
        const [collapsed, setCollapsed] = useState(() => new Set(JSON.parse(localStorage.getItem(storeKey) ?? '["done"]')));
        const [tasks, setTasks] = useState(board.tasks);
        const [tab, setTab] = useState(0);
        const scroller = useRef(null);
        const drag = useRef(null);
        const suppressClick = useRef(false);
        const byRef = useMemo(() => new Map(tasks.map((task) => [task.ref, task])), [tasks]);

        useEffect(() => setTasks(board.tasks), [board]);
        useEffect(() => localStorage.setItem(storeKey, JSON.stringify([...collapsed])), [collapsed]);

        const toggle = (state) => {
            const next = new Set(collapsed);

            next.has(state) ? next.delete(state) : next.add(state);
            setCollapsed(next);
        };
        const columnTasks = (state) => tasks.filter((task) => task.state === state).sort((a, b) => a.position - b.position);
        const move = (task, state, position) => {
            // At once on the board; the server's answer (or refusal) settles it.
            setTasks((current) => current.map((each) => (each.id === task.id ? { ...each, state, position } : each)));
            patchTask(task.ref, { state, position }).then(reload, (error) => {
                failed(error);
                reload();
            });
        };

        // Dragging, with a mouse: a card follows the pointer; the column under it lights up; dropping places it there.
        const onPointerDown = (event, task) => {
            if (event.pointerType !== "mouse" || event.button !== 0) {
                return;
            }

            drag.current = { task, x: event.clientX, y: event.clientY, el: event.currentTarget, ghost: null, over: null };

            const onMove = (moved) => {
                const state = drag.current;

                if (state === null) {
                    return;
                }

                if (state.ghost === null) {
                    if (Math.hypot(moved.clientX - state.x, moved.clientY - state.y) < 6) {
                        return;
                    }

                    const rect = state.el.getBoundingClientRect();

                    state.ghost = state.el.cloneNode(true);
                    state.ghost.classList.add("pj-ghost");
                    state.ghost.style.width = `${rect.width}px`;
                    state.dx = state.x - rect.left;
                    state.dy = state.y - rect.top;
                    document.body.append(state.ghost);
                    state.el.classList.add("pj-dragging");
                }

                state.ghost.style.transform = `translate(${moved.clientX - state.dx}px, ${moved.clientY - state.dy}px) rotate(1.5deg)`;

                const column = document.elementFromPoint(moved.clientX, moved.clientY)?.closest(".pj-col") ?? null;

                if (column !== state.over) {
                    state.over?.classList.remove("over");
                    column?.classList.add("over");
                    state.over = column;
                }
            };
            const onUp = (released) => {
                removeEventListener("pointermove", onMove);
                removeEventListener("pointerup", onUp);

                const state = drag.current;

                drag.current = null;

                if (state?.ghost == null) {
                    return;
                }

                state.ghost.remove();
                state.el.classList.remove("pj-dragging");
                state.over?.classList.remove("over");
                suppressClick.current = true;
                setTimeout(() => (suppressClick.current = false), 0);

                const target = state.over?.dataset.state;

                if (target === undefined) {
                    return;
                }

                // Its place: before the first card whose middle is below the pointer.
                const others = columnTasks(target).filter((each) => each.id !== state.task.id);
                const cards = [...state.over.querySelectorAll(".pj-card[data-ref]")].filter((card) => card.dataset.ref !== state.task.ref);
                let index = cards.findIndex((card) => {
                    const rect = card.getBoundingClientRect();

                    return rect.top + rect.height / 2 > released.clientY;
                });

                index = index === -1 ? others.length : index;

                const before = others[index - 1]?.position;
                const after = others[index]?.position;
                const position =
                    before === undefined && after === undefined ? 1 : before === undefined ? after - 1 : after === undefined ? before + 1 : (before + after) / 2;

                if (target !== state.task.state || position !== state.task.position) {
                    move(state.task, target, position);
                }
            };

            addEventListener("pointermove", onMove);
            addEventListener("pointerup", onUp);
        };

        // A long press on a phone: Move to.
        const press = useRef(null);
        const onTouchStart = (task) => {
            press.current = setTimeout(() => {
                press.current = null;
                suppressClick.current = true;
                setTimeout(() => (suppressClick.current = false), 600);
                navigator.vibrate?.(15);
                pocket.openSheet("move", { task: task.ref, state: task.state });
            }, 500);
        };
        const cancelPress = () => {
            clearTimeout(press.current);
            press.current = null;
        };
        const open = (task) => {
            if (!suppressClick.current) {
                pocket.openSheet("task", { task: task.ref });
            }
        };

        const card = (task) => {
            const parent = task.parentRef === null ? null : byRef.get(task.parentRef);
            const tone = STATE[task.state].tone;

            return html`<button
                class=${`pj-card ${task.state === "inbox" || task.state === "done" ? "" : "edge"} ${task.state === "blocked" ? "needs" : ""}`}
                style=${`--tone:${tone}`}
                data-ref=${task.ref}
                key=${task.id}
                onPointerDown=${(event) => onPointerDown(event, task)}
                onTouchStart=${() => onTouchStart(task)}
                onTouchEnd=${cancelPress}
                onTouchMove=${cancelPress}
                onContextMenu=${(event) => PHONE.matches && event.preventDefault()}
                onClick=${() => open(task)}
            >
                <div class="pj-row">
                    ${typeChip(task.type)}${priority(task.priority)}<span class="pj-sp"></span>
                    ${task.operatorReview && html`<span class="pj-approve" title=${t("Needs a person's approval before Done")}>${svg("M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", 12)}</span>`}
                    ${
                        task.run && ACTIVE.has(task.run.state) &&
                        html`<span class=${`pj-running ${task.run.state}`} title=${runLabel[task.run.state]}><i></i>${task.run.state === "queued" ? t("queued") : t("running")}</span>`
                    }
                </div>
                <div class="pj-card-title">${task.title}</div>
                ${parent && html`<div class="pj-parent">${svg("M6 4v7a4 4 0 0 0 4 4h8M15 12l3 3-3 3", 11)}<span>${parent.title}</span></div>`}
                ${task.waitingOn.length > 0 && html`<div class="pj-waiting">${t("Waiting on {refs}", { refs: task.waitingOn.join(", ") })}</div>`}
                ${task.state === "blocked" && task.blockedReason && html`<div class="pj-blocked">${task.blockedReason}</div>`}
                ${
                    task.progress &&
                    html`<div class="pj-prog">
                        <span class="pj-bar"><i style=${`width:${(task.progress[0] / task.progress[1]) * 100}%`}></i></span><span>${task.progress[0]}/${task.progress[1]}</span>
                    </div>`
                }
                <div class="pj-foot">
                    <span class="pj-id">${task.ref.toLowerCase()}</span>
                    ${task.due && html`<span class=${`pj-due ${dueClass(task.due, task.state)}`}>◷ ${dayLabel(task.due)}</span>`}
                    <span class="pj-sp"></span>
                    <span class="pj-age" title=${t("Last changed")}>${ago(task.updatedAt)}</span>
                    ${avatar(task.assignee, people)}
                </div>
            </button>`;
        };

        const followSwipe = () => {
            const el = scroller.current;

            if (el !== null && PHONE.matches) {
                setTab(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
            }
        };

        return html`<div class="pj-kanban">
            <div class="pj-tabs" role="tablist" aria-label=${t("States")}>
                ${STATES.map((state, index) => {
                    const n = tasks.filter((task) => task.state === state.id).length;

                    return html`<button
                        role="tab"
                        aria-selected=${index === tab}
                        class=${index === tab ? "on" : ""}
                        style=${`--tone:${n > 0 ? state.tone : "var(--faint)"}`}
                        onClick=${() => scroller.current?.scrollTo({ left: index * scroller.current.clientWidth, behavior: "smooth" })}
                    >
                        <i></i>${stateLabel[state.id]} <b>${n}</b>
                    </button>`;
                })}
            </div>
            <div class="pj-board" ref=${scroller} onScroll=${followSwipe}>
                ${STATES.map((state) => {
                    const items = columnTasks(state.id);
                    const isCollapsed = collapsed.has(state.id) && !PHONE.matches;
                    const atWip = state.wip !== undefined && items.length >= state.wip;

                    return html`<section
                        class=${`pj-col ${isCollapsed ? "collapsed" : ""} ${items.length === 0 ? "pj-empty" : ""}`}
                        data-state=${state.id}
                        key=${state.id}
                        style=${`--tone:${state.tone};--fill:${Math.max(Math.min(items.length * 10, 100), 8)}%`}
                        onClick=${isCollapsed ? () => toggle(state.id) : undefined}
                        title=${isCollapsed ? t("Open {state}", { state: stateLabel[state.id] }) : undefined}
                    >
                        <div class="pj-tbar"></div>
                        <header>
                            ${isCollapsed && svg("m6 17 5-5-5-5M13 17l5-5-5-5", 14, "pj-unfold")}
                            ${svg(state.icon, 15, "pj-col-icon")}
                            <span class="pj-col-label">${stateLabel[state.id]}</span>
                            <span class="pj-count">${items.length}</span>
                            ${!isCollapsed && state.wip !== undefined && html`<span class=${`pj-wip ${atWip ? "over" : ""}`} title=${t("Work-in-progress limit")}>${items.length}/${state.wip}</span>`}
                            <span class="pj-sp"></span>
                            ${
                                !isCollapsed &&
                                html`<button class="pj-fold" title=${t("Collapse {state}", { state: stateLabel[state.id] })} aria-label=${t("Collapse {state}", { state: stateLabel[state.id] })} onClick=${() => toggle(state.id)}>
                                    ${svg("m11 17-5-5 5-5M18 17l-5-5 5-5", 14)}
                                </button>`
                            }
                        </header>
                        ${
                            !isCollapsed &&
                            html`<div class="pj-cards">
                                    ${items.length === 0 ? html`<div class="pj-col-empty">${t("No tasks")}</div>` : items.map(card)}
                                </div>
                                <button class="pj-add-row" onClick=${() => pocket.openSheet("new-task", { project: board.project.key, state: state.id })}>${t("+ Add a task")}</button>`
                        }
                    </section>`;
                })}
            </div>
        </div>`;
    }

    // ─── Sheets ───────────────────────────────────────────────────────────────────

    /** Move to: a long press's choice of state, on a phone. */
    function MoveSheet({ task: ref, state, close }) {
        return html`<div class="pj-move">
            <p class="muted small">${t("Move {ref} to", { ref })}</p>
            ${STATES.map(
                (each) => html`<button
                    class=${`pj-move-row ${each.id === state ? "on" : ""}`}
                    style=${`--tone:${each.tone}`}
                    onClick=${() =>
                        patchTask(ref, { state: each.id }).then(
                            () => {
                                pocket.notify("info", t("{ref} is {state}.", { ref, state: stateLabel[each.id] }));
                                close();
                            },
                            failed,
                        )}
                >
                    ${svg(each.icon, 16)}<span>${stateLabel[each.id]}</span>
                </button>`,
            )}
        </div>`;
    }

    /** A folder as people read it: a machine's as "path · on a machine". */
    const folderLabel = (folder) => {
        const machine = /^machine:[^:]+:(.*)$/.exec(folder);

        // The sentence keeps " · " between the path and the rest: shortFolder splits there.
        return machine ? t("{path} · on a machine", { path: machine[1] }) : folder;
    };

    /** A folder in few words: its last two parts (and the machine's mark). */
    const shortFolder = (folder) => {
        const label = folderLabel(folder);
        const [path, where] = label.split(" · ");
        const parts = path.split("/").filter(Boolean);

        return `${parts.length > 2 ? "…/" : ""}${parts.slice(-2).join("/")}${where ? ` · ${where}` : ""}`;
    };

    /**
     * The project's folder: typed, or chosen with the app's folder picker (browse, make a folder, here or on a machine).
     * The picker takes the sheet's place; `reopen(folder)` brings the sheet back with the choice.
     */
    function FolderField({ value, onInput, reopen }) {
        const choose = async () => {
            const chosen = await pocket.pickFolder({ start: value || undefined, title: t("The project's folder") });

            reopen(chosen ?? value);
        };

        return html`<div class="field">
            <span class="label">${t("Folder")}</span>
            <div class="pj-folder">
                <input value=${value} placeholder="~/work/project" aria-label=${t("Folder")} onInput=${(event) => onInput(event.currentTarget.value)} />
                <button type="button" class="button" onClick=${choose}>${t("Choose…")}</button>
            </div>
            <span class="muted small">${value && /^machine:/.test(value) ? folderLabel(value) : t("Where its work happens: a folder here or on a machine. Choose… browses and makes folders, as New session does.")}</span>
        </div>`;
    }

    function NewProjectSheet({ draft, close }) {
        const [key, setKey] = useState(draft?.key ?? "");
        const [name, setName] = useState(draft?.name ?? "");
        const [folder, setFolder] = useState(draft?.folder ?? "");
        const [busy, setBusy] = useState(false);
        const team = useTeam();
        const [teamBoard, setTeamBoard] = useState(false);
        const submit = (event) => {
            event.preventDefault();
            setBusy(true);
            pocket
                .api("projects", { key: key.trim().toUpperCase(), name: name.trim(), folder: folder.trim() || null, ...(teamBoard ? { team: true } : {}) })
                .then(
                    (made) => {
                        close();
                        pendingKey = made.key;
                        localStorage.setItem(CURRENT, made.key);
                        pocket.openPage("projects");
                    },
                    failed,
                )
                .finally(() => setBusy(false));
        };

        return html`<form class="pj-form" onSubmit=${submit}>
            <label class="field"><span class="label">${t("Name")}</span><input value=${name} placeholder="pi-phone" onInput=${(event) => setName(event.currentTarget.value)} required maxlength="80" /></label>
            <label class="field"
                ><span class="label">${t("Key")}</span
                ><input value=${key} placeholder="PP" onInput=${(event) => setKey(event.currentTarget.value.toUpperCase())} required pattern="[A-Za-z][A-Za-z0-9]{1,5}" maxlength="6" />
                <span class="muted small">${t("2 to 6 letters or digits. Tasks are named after it: {key}-1, {key}-2…", { key: key || "PP" })}</span></label
            >
            <${FolderField} value=${folder} onInput=${setFolder} reopen=${(chosen) => pocket.openSheet("new-project", { draft: { key, name, folder: chosen } })} />
            ${
                team.me?.managesTeam &&
                html`<label class="pj-share"
                    ><input type="checkbox" checked=${teamBoard} onChange=${(event) => setTeamBoard(event.currentTarget.checked)} /><span>${t("A team board")}</span
                    ><span class="muted small">${t("the team's, not yours: whoever manages team boards manages it")}</span></label
                >`
            }
            <button class="button primary" disabled=${busy || key === "" || name.trim() === ""}>${t("Make the project")}</button>
        </form>`;
    }

    function NewTaskSheet({ project: key, state, close }) {
        const [title, setTitle] = useState("");
        const [type, setType] = useState("task");
        const [parent, setParent] = useState("");
        const [chosen, setChosen] = useState(state ?? "inbox");
        const [description, setDescription] = useState("");
        const [priority, setPriority] = useState(0);
        const [assignee, setAssignee] = useState("");
        const [due, setDue] = useState("");
        const [busy, setBusy] = useState(false);
        const people = usePeople();
        const submit = (event) => {
            event.preventDefault();
            setBusy(true);
            pocket
                .api(`projects/${key}/tasks`, {
                    title: title.trim(),
                    type,
                    state: chosen,
                    parent: parent.trim() || null,
                    description,
                    priority,
                    assignee: assignee || null,
                    due: due || null,
                })
                .then(
                    (made) => {
                        close();
                        pocket.openSheet("task", { task: made.ref });
                    },
                    failed,
                )
                .finally(() => setBusy(false));
        };

        return html`<form class="pj-form" onSubmit=${submit}>
            <label class="field"><span class="label">${t("Title")}</span><input value=${title} onInput=${(event) => setTitle(event.currentTarget.value)} required maxlength="200" autofocus /></label>
            <div class="pj-two">
                <label class="field"
                    ><span class="label">${t("Type")}</span
                    ><select value=${type} onChange=${(event) => setType(event.currentTarget.value)}>
                        ${TYPES.map((each) => html`<option value=${each.id}>${typeLabel[each.id]}</option>`)}
                    </select></label
                >
                <label class="field"
                    ><span class="label">${t("State")}</span
                    ><select value=${chosen} onChange=${(event) => setChosen(event.currentTarget.value)}>
                        ${STATES.filter((each) => each.id !== "done").map((each) => html`<option value=${each.id}>${stateLabel[each.id]}</option>`)}
                    </select></label
                >
            </div>
            <label class="field"
                ><span class="label">${t("Description")}</span
                ><textarea
                    rows="5"
                    value=${description}
                    placeholder=${t("What to do and how to tell it is done (Markdown)")}
                    onInput=${(event) => setDescription(event.currentTarget.value)}
                ></textarea></label
            >
            <div class="pj-two">
                <label class="field"
                    ><span class="label">${t("Priority")}</span
                    ><select value=${priority} onChange=${(event) => setPriority(Number(event.currentTarget.value))}>
                        ${priorityLabel.map((label, index) => html`<option value=${index}>${label}</option>`)}
                    </select></label
                >
                <label class="field"
                    ><span class="label">${t("Assignee")}</span
                    ><select value=${assignee} onChange=${(event) => setAssignee(event.currentTarget.value)}>
                        <option value="">${t("Nobody")}</option>
                        <option value="pi">Pi</option>
                        ${people.map((person) => html`<option value=${person.id}>${person.name}</option>`)}
                    </select></label
                >
            </div>
            <label class="field"
                ><span class="label">${t("Due (optional)")}</span
                ><input type="date" value=${due} onInput=${(event) => setDue(event.currentTarget.value)} /></label
            >
            <label class="field"
                ><span class="label">${t("Under (optional)")}</span
                ><input value=${parent} placeholder=${`${key}-1`} onInput=${(event) => setParent(event.currentTarget.value.toUpperCase())} />
                <span class="muted small">${t("An epic holds stories, tasks and bugs; a story holds tasks, bugs and sub-tasks; a task or bug holds sub-tasks.")}</span></label
            >
            <button class="button primary" disabled=${busy || title.trim() === ""}>${t("Add to {key}", { key })}</button>
        </form>`;
    }

    /** A menu that opens under its button and closes on a tap elsewhere or Esc. */
    function Popover({ open, onClose, children, align = "right" }) {
        const box = useRef(null);

        useEffect(() => {
            if (!open) {
                return undefined;
            }

            const away = (event) => !box.current?.parentElement?.contains(event.target) && onClose();
            const esc = (event) => {
                if (event.key === "Escape") {
                    event.stopPropagation();
                    onClose();
                }
            };

            document.addEventListener("pointerdown", away, true);
            document.addEventListener("keydown", esc, true);

            return () => {
                document.removeEventListener("pointerdown", away, true);
                document.removeEventListener("keydown", esc, true);
            };
        }, [open]);

        return open ? html`<div class=${`pt-menu ${align}`} role="menu" ref=${box}>${children}</div>` : null;
    }

    const TRASH = "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3";
    const MERGE = "M6 8.2v7.6M8 6.8c5 0 8 1.2 8 5M6 3.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM6 15.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM18 9.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z";
    const PLAY = "M8 5v14l11-7z";
    const DIFF = "M12 4v8M8 8h8M8 18h8";
    const CHAT = "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z";
    const CHECK = "M5 12.5l4.5 4.5L19 7";
    const CHEVRON = "M9 6l6 6-6 6";

    /** "2nd", "3rd": which run. */
    const nth = (n) =>
        n % 10 === 1 && n % 100 !== 11 ? t("{n}st", { n }) : n % 10 === 2 && n % 100 !== 12 ? t("{n}nd", { n }) : n % 10 === 3 && n % 100 !== 13 ? t("{n}rd", { n }) : t("{n}th", { n });

    /** How long, in words: "25s", "3m 12s", "1h 4m". */
    const took = (ms) => {
        const seconds = Math.max(0, Math.round(ms / 1000));

        return seconds < 60
            ? t("{s}s", { s: seconds })
            : seconds < 3600
              ? seconds % 60
                  ? t("{m}m {s}s", { m: Math.floor(seconds / 60), s: seconds % 60 })
                  : t("{m}m", { m: Math.floor(seconds / 60) })
              : t("{h}h {m}m", { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });
    };

    /** git's short stat ("2 files changed, 142 insertions(+), 3 deletions(-)") as +142 −3 in 2 files. */
    const diffStat = (stat) => {
        if (!stat) {
            return null;
        }

        const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(stat)?.[1] ?? 0);
        const files = count("files?");

        const added = count("insertions?");
        const removed = count("deletions?");

        return html`<span class="pt-stat">${added > 0 && html`<b class="add">+${added}</b> `}${removed > 0 && html`<b class="del">−${removed}</b> `}${tn(files, "in {n} file", "in {n} files")}</span>`;
    };

    /** A task, as one sheet: what it is and where it stands, its run, its properties, its parts, and what happened. */
    function TaskSheet({ task: ref, close }) {
        const [data, setData] = useState(null);
        const [problem, setProblem] = useState(null);
        const [menu, setMenu] = useState(null);
        const people = usePeople();
        const load = () => pocket.api(`tasks/${ref}`).then(setData, (error) => setProblem(error.message));

        useEffect(() => {
            load();

            return pocket.on("changed", load);
        }, [ref]);

        if (data === null) {
            return problem ? html`<p class="pj-problem pt-pad">${problem}</p>` : html`<${Loader} label=${t("Opening the task")} />`;
        }

        const { task, project, activity } = data;
        const save = (body) => patchTask(ref, body).then(load, failed);
        const state = STATE[task.state];
        const made = activity.find((each) => each.kind === "created");
        const toggle = (name) => setMenu(menu === name ? null : name);

        return html`<div class="pt" data-task=${task.ref}>
            <header class="pt-head">
                <span class="pt-type" title=${typeLabel[task.type]} style=${`--tt:${TYPE[task.type].tone}`}>${svg(TYPE[task.type].icon, 13)}</span>
                <span class="pt-ref">${task.ref}</span>
                <span class="pt-anchor">
                    <button class="pt-state" style=${`--tone:${state.tone}`} aria-haspopup="menu" aria-expanded=${menu === "state"} onClick=${() => toggle("state")}>
                        <i></i>${stateLabel[state.id]}${svg("M6 9l6 6 6-6", 11)}
                    </button>
                    <${Popover} open=${menu === "state"} onClose=${() => setMenu(null)} align="left">
                        ${STATES.map(
                            (each) => html`<button role="menuitemradio" aria-checked=${each.id === task.state} class=${each.id === task.state ? "on" : ""} onClick=${() => {
                                setMenu(null);
                                each.id !== task.state && save({ state: each.id });
                            }}>
                                <span class="pt-dot" style=${`--tone:${each.tone}`}></span>${stateLabel[each.id]}${each.id === task.state && html`<span class="pj-sp"></span>${svg(CHECK, 14)}`}
                            </button>`,
                        )}
                    <//>
                </span>
                <span class="pj-sp"></span>
                <span class="pt-anchor">
                    <button class="icon-button" aria-label=${t("More")} aria-haspopup="menu" aria-expanded=${menu === "more"} onClick=${() => toggle("more")}><${Icon} name="more" /></button>
                    <${Popover} open=${menu === "more"} onClose=${() => setMenu(null)}>
                        <button role="menuitem" onClick=${() => {
                            setMenu(null);
                            navigator.clipboard.writeText(`${location.origin}/?page=projects:projects#task:${task.ref}`).then(() => pocket.notify("info", t("Copied the link to {ref}.", { ref: task.ref })), failed);
                        }}><${Icon} name="copy" size=${15} />${t("Copy link")}</button>
                        <div class="pt-menu-label">${t("Type")}</div>
                        ${TYPES.map(
                            (each) => html`<button role="menuitemradio" aria-checked=${each.id === task.type} class=${each.id === task.type ? "on" : ""} onClick=${() => {
                                setMenu(null);
                                each.id !== task.type && save({ type: each.id });
                            }}>${svg(each.icon, 15)}${typeLabel[each.id]}${each.id === task.type && html`<span class="pj-sp"></span>${svg(CHECK, 14)}`}</button>`,
                        )}
                        <hr />
                        <button role="menuitem" class="danger" onClick=${() => {
                            setMenu(null);
                            confirm(t("Delete {ref} for good?", { ref: task.ref })) &&
                                pocket.api(`tasks/${ref}`, undefined, { method: "DELETE" }).then(() => {
                                    pocket.notify("info", t("Deleted {ref}.", { ref: task.ref }));
                                    close();
                                }, failed);
                        }}>${svg(TRASH, 15)}${t("Delete {ref}…", { ref: task.ref })}</button>
                    <//>
                </span>
                <button class="icon-button" aria-label=${t("Close")} onClick=${() => close()}><${Icon} name="close" /></button>
            </header>

            <div class="pt-body">
                <${TitleField} task=${task} save=${save} />
                <div class="pt-where">
                    ${svg(BOARD, 12)}<b>${project.key} · ${project.name}</b>${made && html`<span>${t("· made by {name} {time} ago", { name: made.actorName, time: ago(made.createdAt) })}</span>`}
                </div>
                ${task.waitingOn.length > 0 && task.state !== "done" && html`<div class="pt-note">${t("Waiting on {refs}: the main session decides when it runs.", { refs: task.waitingOn.join(", ") })}</div>`}
                ${
                    task.state === "blocked" &&
                    html`<label class="pt-blocked">
                        <span>${t("Blocked: what it waits for")}</span>
                        <input value=${task.blockedReason ?? ""} placeholder=${t("Say what it waits for")} onChange=${(event) => save({ blockedReason: event.currentTarget.value })} />
                    </label>`
                }
                <${RunCard} data=${data} reload=${load} close=${close} />
                <${Properties} task=${task} project=${project} people=${people} save=${save} />
                <${Description} task=${task} save=${save} />
                <${Checklist} task=${task} save=${save} />
                <${Relations} data=${data} reload=${load} />
                <${Sessions} data=${data} close=${close} />
                <${Activity} data=${data} />
            </div>
            <${Composer} task=${task} reload=${load} />
        </div>`;
    }

    /** The title, edited where it is: Enter or leaving it saves. */
    function TitleField({ task, save }) {
        const box = useRef(null);
        const done = () => {
            const value = box.current.value.replace(/\s+/g, " ").trim();

            if (value === "") {
                box.current.value = task.title;
            } else if (value !== task.title) {
                save({ title: value });
            }
        };
        const fit = () => {
            box.current.style.height = "auto";
            box.current.style.height = `${box.current.scrollHeight}px`;
        };

        useEffect(fit, [task.title]);

        return html`<textarea
            class="pt-title"
            ref=${box}
            rows="1"
            maxlength="200"
            aria-label=${t("Title")}
            value=${task.title}
            onInput=${fit}
            onBlur=${done}
            onKeyDown=${(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                }
            }}
        ></textarea>`;
    }

    /** What its run is doing and what to do about it: review and merge, open the working session, or run it. */
    function RunCard({ data, reload, close }) {
        const { task, project, runs, sessions } = data;
        const [diff, setDiff] = useState(null);
        const [stat, setStat] = useState(null);
        const [busy, setBusy] = useState(false);
        const [, tick] = useState(0);
        const run = task.run;
        const session = run?.conversationId ? sessions.find((each) => each.conversationId === run.conversationId) : undefined;
        const working = run && ["starting", "running"].includes(run.state);
        const branchReady = run && run.branch && run.merged === null && !ACTIVE.has(run.state);
        const canRun = (!run || !ACTIVE.has(run.state)) && task.state !== "done" && task.type !== "epic";
        const which = run ? runs.findIndex((each) => each.id === run.id) + 1 : 0;
        const act = (work) => {
            setBusy(true);
            work()
                .then(reload, failed)
                .finally(() => setBusy(false));
        };

        useEffect(() => {
            setStat(null);
            setDiff(null);

            if (branchReady) {
                pocket.api(`tasks/${task.ref}/stat`).then((answer) => setStat(answer.stat), () => setStat(""));
            }
        }, [run?.id, run?.state, run?.merged?.at]);

        // The time worked counts up while you watch.
        useEffect(() => {
            if (!working) {
                return undefined;
            }

            const timer = setInterval(() => tick((n) => n + 1), 1000);

            return () => clearInterval(timer);
        }, [working]);

        if (!run && !canRun) {
            return null;
        }

        const open = run?.conversationId
            ? html`<a class="btn small" href=${`s/${run.conversationId}`} onClick=${() => close()}>${t("Open session")}</a>`
            : null;
        const sessionLine = run?.conversationId
            ? html`<div class="pt-run-session">${svg(CHAT, 13)}<span>${which > 1 ? t("Session #{id} · {nth} run", { id: run.conversationId, nth: nth(which) }) : t("Session #{id}", { id: run.conversationId })}</span><span class="pj-sp"></span>${open}</div>`
            : null;
        const card = (tone, mark, title, lines, actions, footer = null) => html`<section class="pt-run" style=${`--tone:${tone}`}>
            <div class="pt-run-top">
                <span class="pt-run-mark">${mark}</span>
                <div class="pt-run-what"><b>${title}</b>${lines}</div>
            </div>
            ${actions && html`<div class="pt-run-acts">${actions}</div>`}
            ${diff !== null && html`<pre class="pt-diff">${diff}</pre>`}
            ${footer}
        </section>`;
        const branchLine = run?.branch && html`<span><code>${run.branch}</code> → <code>${run.base}</code></span>`;

        // Someone else's Pi works on it, in their own pi-phone (the team server).
        const theirs = data.elsewhere;

        if (!run && theirs && ACTIVE.has(theirs.state)) {
            return card(
                "var(--accent)",
                svg(PLAY, 13),
                theirs.state === "queued" ? t("{name}'s Pi is about to work on it", { name: theirs.by }) : t("{name}'s Pi is working on it", { name: theirs.by }),
                html`<span>${theirs.branch ? tx("In their own pi-phone, on {branch}.", { branch: html`<code>${theirs.branch}</code>` }) : t("In their own pi-phone.")}</span>`,
                null,
            );
        }

        if (!run) {
            return card(
                "var(--muted)",
                svg(PLAY, 13),
                t("Not run yet"),
                html`<span>${
                    project.autoRuns
                        ? tx("Give it to Pi and it runs by itself, or run it now: in a git worktree on {branch}.", { branch: html`<code>task/${task.ref}</code>` })
                        : tx("Pi works on it in its own session, in a git worktree on {branch}.", { branch: html`<code>task/${task.ref}</code>` })
                }</span>`,
                html`<button class="btn primary grow" disabled=${busy} onClick=${() => act(() => pocket.api(`tasks/${task.ref}/run`, {}))}>${svg(PLAY, 13)}${t("Run now")}</button>`,
            );
        }

        if (run.merged !== null) {
            return card(
                "var(--ok)",
                svg(CHECK, 15),
                t("Merged into {base}", { base: run.base }),
                html`<span>${t("by {name} {time} ago", { name: run.merged.byName, time: ago(run.merged.at) })}${run.merged.stat ? " · " : ""}${diffStat(run.merged.stat)}${run.merged.commit ? html` · <code>${run.merged.commit}</code>` : ""}</span>`,
                null,
                sessionLine,
            );
        }

        if (run.state === "queued") {
            return card(
                "var(--faint)",
                svg("M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", 15),
                t("Waiting for a place"),
                html`<span>${run.note ? t("It starts when a place has room: {note}", { note: run.note }) : t("It starts when a place has room.")}</span>`,
                html`<button class="btn" disabled=${busy} onClick=${() => act(() => pocket.api(`tasks/${task.ref}/run`, undefined, { method: "DELETE" }))}>${t("Cancel")}</button>`,
            );
        }

        if (working) {
            const since = session?.state?.busySince ?? run.startedAt ?? run.createdAt;

            return card(
                "var(--o-cyan)",
                html`<i class="pt-spin"></i>`,
                t("Pi is working · {time}", { time: took(Date.now() - since) }),
                html`<span>${(() => {
                    const where = run.worktree ? { folder: html`<code>${shortFolder(run.worktree)}</code>` } : null;

                    return run.state === "starting"
                        ? where ? tx("Making its worktree in {folder}", where) : t("Making its worktree")
                        : session?.state?.waiting
                          ? where ? tx("Waiting for an approval in {folder}", where) : t("Waiting for an approval")
                          : where ? tx("In its own session in {folder}", where) : t("In its own session");
                })()}</span>${branchLine}`,
                run.conversationId ? html`<a class="btn primary grow" href=${`s/${run.conversationId}`} onClick=${() => close()}>${svg(CHAT, 14)}${t("Open session")}</a>` : null,
            );
        }

        const finished = run.endedAt && run.startedAt ? t("Pi finished in {time}", { time: took(run.endedAt - run.startedAt) }) : t("Pi finished");
        const ended =
            run.state === "failed"
                ? ["var(--err)", "×", t("Its run failed"), `${run.note ?? t("Open its session to see why.")}`]
                : run.state === "stopped"
                  ? ["var(--warn)", "!", t("Its run stopped"), run.note ?? t("The task was not finished.")]
                  : run.state === "cancelled"
                    ? ["var(--faint)", "–", t("Cancelled"), t("It was taken off the queue before it started.")]
                    : ["var(--accent)", svg(DIFF, 15), task.state === "done" ? t("Done, not merged") : t("Ready to review"), finished];

        return card(
            ended[0],
            ended[1],
            ended[2],
            html`<span>${ended[3]}${branchReady && stat ? " · " : ""}${branchReady && diffStat(stat)}</span>${branchLine}`,
            html`${
                branchReady &&
                html`<button
                    class="btn grow"
                    disabled=${busy}
                    onClick=${() => (diff === null ? pocket.api(`tasks/${task.ref}/diff`).then((answer) => setDiff(answer.diff || t("No changes on this branch.")), failed) : setDiff(null))}
                >
                    ${svg(DIFF, 14)}${diff === null ? t("See changes") : t("Hide changes")}
                </button>`
            }${
                branchReady &&
                html`<button
                    class="btn primary grow"
                    disabled=${busy}
                    onClick=${() =>
                        confirm(t("Merge {branch} into {base}? Its worktree and branch go after.", { branch: run.branch, base: run.base })) &&
                        act(async () => {
                            await pocket.api(`tasks/${task.ref}/merge`, {});
                            pocket.notify("info", t("Merged {branch} into {base}.", { branch: run.branch, base: run.base }));
                        })}
                >
                    ${svg(MERGE, 14)}${t("Merge into {base}", { base: run.base })}
                </button>`
            }${canRun && !branchReady && html`<button class="btn primary grow" disabled=${busy} onClick=${() => act(() => pocket.api(`tasks/${task.ref}/run`, {}))}>${svg(PLAY, 13)}${t("Run again")}</button>`}`,
            sessionLine,
        );
    }

    /** Assignee, priority, dates, labels, parent, and approval: quiet rows, each a value or a faint way to add one. */
    function Properties({ task, project, people, save }) {
        const [editing, setEditing] = useState(null);
        const start = useRef(null);
        const due = useRef(null);
        const members = people.filter((person) => person.role === "owner" || person.id === project.owner || project.members.includes(person.id));
        const who = task.assignee === "pi" ? "Pi" : (people.find((person) => person.id === task.assignee)?.name ?? null);
        const pick = (input) => {
            try {
                input.current.showPicker();
            } catch {
                input.current.focus();
            }
        };
        const dateWords = {
            start: { set: (day) => t("Start {day}", { day }), add: t("Add start date"), field: t("Start date") },
            due: { set: (day) => t("Due {day}", { day }), add: t("Add due date"), field: t("Due date") },
        };
        const dateChip = (input, value, key) => html`<button class=${`pt-chip ${value ? "" : "faint"}`} onClick=${() => pick(input)}>
            ${value ? dateWords[key].set(dayLabel(value)) : dateWords[key].add}
            <input type="date" ref=${input} tabindex="-1" aria-label=${dateWords[key].field} value=${value ?? ""} onChange=${(event) => save({ [key]: event.currentTarget.value || null })} />
        </button>`;
        const inline = (key, value, placeholder, apply) => html`<input
            class="pt-inline"
            autofocus
            value=${value}
            placeholder=${placeholder}
            onBlur=${(event) => {
                setEditing(null);
                apply(event.currentTarget.value);
            }}
            onKeyDown=${(event) => {
                if (event.key === "Enter") {
                    event.currentTarget.blur();
                } else if (event.key === "Escape") {
                    event.stopPropagation();
                    setEditing(null);
                }
            }}
            ref=${(element) => element && editing === key && element.focus()}
        />`;

        return html`<dl class="pt-props">
            <dt>${t("Assignee")}</dt>
            <dd class=${who ? "" : "faint"}>
                ${task.assignee !== null && avatar(task.assignee, people)}${who ?? t("Nobody")}
                <select aria-label=${t("Assignee")} value=${task.assignee ?? ""} onChange=${(event) => save({ assignee: event.currentTarget.value || null })}>
                    <option value="">${t("Nobody")}</option>
                    <option value="pi">Pi</option>
                    ${members.map((person) => html`<option value=${person.id}>${person.name}</option>`)}
                </select>
            </dd>
            <dt>${t("Priority")}</dt>
            <dd class=${task.priority === 0 ? "faint" : ""}>
                ${task.priority > 0 && priority(task.priority)}${task.priority === 0 ? t("No priority") : priorityLabel[task.priority]}
                <select aria-label=${t("Priority")} value=${task.priority} onChange=${(event) => save({ priority: Number(event.currentTarget.value) })}>
                    ${priorityLabel.map((label, index) => html`<option value=${index}>${label}</option>`)}
                </select>
            </dd>
            <dt>${t("Dates")}</dt>
            <dd class="pt-wrap">${dateChip(start, task.start, "start")}${dateChip(due, task.due, "due")}</dd>
            <dt>${t("Labels")}</dt>
            <dd class="pt-wrap">
                ${task.labels.map(
                    (label) => html`<span class="pt-chip">${label}<button aria-label=${t("Remove {label}", { label })} onClick=${() => save({ labels: task.labels.filter((each) => each !== label) })}>×</button></span>`,
                )}
                ${
                    editing === "labels"
                        ? inline("labels", "", t("a label, or several with commas"), (value) => {
                              const added = value.split(",").map((label) => label.trim()).filter(Boolean);

                              added.length > 0 && save({ labels: [...task.labels, ...added] });
                          })
                        : html`<button class="pt-chip faint" onClick=${() => setEditing("labels")}>${task.labels.length === 0 ? t("Add a label") : "+"}</button>`
                }
            </dd>
            <dt>${t("Parent")}</dt>
            <dd class=${`pt-wrap ${task.parentRef ? "" : "faint"}`}>
                ${
                    editing === "parent"
                        ? inline("parent", task.parentRef ?? "", `${project.key}-1`, (value) => {
                              const next = value.trim().toUpperCase() || null;

                              next !== task.parentRef && save({ parent: next });
                          })
                        : html`<button class="pt-plain" onClick=${() => setEditing("parent")}>${task.parentRef ?? t("None")}</button>`
                }
                ${task.children.length > 0 && html`<span class="pt-hint">${t("holds {refs}", { refs: task.children.join(", ") })}</span>`}
            </dd>
            <dt>${t("Approval")}</dt>
            <dd>
                <${Switch} on=${task.operatorReview} label=${t("Needs a person's approval before Done")} onChange=${() => save({ operatorReview: !task.operatorReview })} />
                <span class="pt-hint">${task.operatorReview ? t("Only a person moves it to Done") : t("Pi's main session may move it to Done")}</span>
            </dd>
            ${
                task.type === "bug" &&
                html`<dt>${t("Fix")}</dt>
                    <dd>
                        <${Switch} on=${task.fixVerified} label=${t("The fix was verified")} onChange=${() => save({ fixVerified: !task.fixVerified })} />
                        <span class="pt-hint">${task.fixVerified ? t("Verified") : t("A bug is Done only once its fix is verified")}</span>
                    </dd>`
            }
        </dl>`;
    }

    /** The description: folded when long, edited in place. */
    function Description({ task, save }) {
        const [editing, setEditing] = useState(false);
        const [open, setOpen] = useState(false);
        const text = task.description.trim();
        const long = text.length > 360 || text.split("\n").length > 7;

        return html`<section class="pt-sec">
            <div class="pt-sec-h">${t("Description")}<span class="pj-sp"></span><button class="pt-act" onClick=${() => setEditing(!editing)}>${editing ? t("Done") : text === "" ? t("Add") : t("Edit")}</button></div>
            ${
                editing
                    ? html`<textarea class="pt-desc" rows="8" autofocus value=${task.description} onChange=${(event) => save({ description: event.currentTarget.value })}></textarea>`
                    : text === ""
                      ? html`<button class="pt-add" onClick=${() => setEditing(true)}>${svg("M12 6v12M6 12h12", 16)}${t("Add a description")}</button>`
                      : html`<div class=${`pt-prose ${long && !open ? "folded" : ""}`}><${Markdown} text=${task.description} /></div>
                            ${long && html`<button class="pt-act pt-more" onClick=${() => setOpen(!open)}>${open ? t("Show less") : t("Show more")}</button>`}`
            }
        </section>`;
    }

    /** The checklist: tap an item to tick it; its progress beside the heading. */
    function Checklist({ task, save }) {
        const [adding, setAdding] = useState(false);
        const [text, setText] = useState("");
        const done = task.checklist.filter((item) => item.done).length;
        const all = task.checklist.length;
        const add = () => {
            if (text.trim() !== "") {
                save({ checklist: [...task.checklist, { text: text.trim(), done: false }] }).then(() => setText(""));
            }
        };

        return html`<section class="pt-sec">
            <div class="pt-sec-h">
                ${t("Checklist")}${all > 0 && html`<span class="pt-n">${done}/${all}</span><span class="pt-progress"><i style=${`width:${Math.round((done / all) * 100)}%`}></i></span>`}
            </div>
            ${task.checklist.map(
                (item, index) => html`<div class=${`pt-check ${item.done ? "done" : ""}`}>
                    <button
                        class="pt-check-main"
                        role="checkbox"
                        aria-checked=${item.done}
                        onClick=${() => save({ checklist: task.checklist.map((each, at) => (at === index ? { ...each, done: !each.done } : each)) })}
                    >
                        <span class="pt-box">${item.done && svg(CHECK, 11)}</span><span>${item.text}</span>
                    </button>
                    <button class="pt-x" aria-label=${t("Remove {label}", { label: item.text })} onClick=${() => save({ checklist: task.checklist.filter((_each, at) => at !== index) })}>×</button>
                </div>`,
            )}
            ${
                adding
                    ? html`<form class="pt-add-form" onSubmit=${(event) => (event.preventDefault(), add())}>
                          <input
                              autofocus
                              value=${text}
                              placeholder=${t("An item, then Enter")}
                              onInput=${(event) => setText(event.currentTarget.value)}
                              onBlur=${() => text.trim() === "" && setAdding(false)}
                              onKeyDown=${(event) => event.key === "Escape" && (event.stopPropagation(), setAdding(false))}
                          />
                      </form>`
                    : html`<button class="pt-add" onClick=${() => setAdding(true)}>${svg("M12 6v12M6 12h12", 16)}${t("Add an item")}</button>`
            }
        </section>`;
    }

    /** What it waits on and what waits on it, and tasks it relates to. */
    function Relations({ data, reload }) {
        const { task, project, links } = data;
        const [adding, setAdding] = useState(false);
        const [kind, setKind] = useState("waits");
        const [to, setTo] = useState("");
        const add = () => {
            const other = to.trim().toUpperCase();

            if (other === "") {
                return;
            }

            // "Waits on X" is X blocking this task.
            const made = kind === "waits" ? pocket.api(`tasks/${other}/links`, { to: task.ref, kind: "blocks" }) : pocket.api(`tasks/${task.ref}/links`, { to: other, kind });

            made.then(() => {
                setTo("");
                setAdding(false);
                reload();
            }, failed);
        };

        return html`<section class="pt-sec">
            <div class="pt-sec-h">${t("Relations")}${links.length > 0 && html`<span class="pt-n">${links.length}</span>`}</div>
            ${links.map(
                (link) => html`<div class="pt-row">
                    <button class="pt-row-main" onClick=${() => pocket.openSheet("task", { task: link.ref })}>
                        <span class="pt-k">${link.kind === "relates" ? t("Relates to") : link.direction === "out" ? t("Blocks") : t("Waits on")}</span>
                        <span class="pt-r">${link.ref}</span>
                        <span class="pt-t">${link.title}</span>
                        <span class="pt-dot" style=${`--tone:${STATE[link.state].tone}`} title=${stateLabel[link.state]}></span>
                    </button>
                    <button
                        class="pt-x"
                        aria-label=${t("Remove the link to {ref}", { ref: link.ref })}
                        onClick=${() =>
                            (link.direction === "out"
                                ? pocket.api(`tasks/${task.ref}/links/${link.kind}/${link.ref}`, undefined, { method: "DELETE" })
                                : pocket.api(`tasks/${link.ref}/links/${link.kind}/${task.ref}`, undefined, { method: "DELETE" })
                            ).then(reload, failed)}
                    >×</button>
                </div>`,
            )}
            ${
                adding
                    ? html`<form class="pt-add-form" onSubmit=${(event) => (event.preventDefault(), add())}>
                          <select value=${kind} aria-label=${t("How it relates")} onChange=${(event) => setKind(event.currentTarget.value)}>
                              <option value="waits">${t("Waits on")}</option>
                              <option value="blocks">${t("Blocks")}</option>
                              <option value="relates">${t("Relates to")}</option>
                          </select>
                          <input autofocus value=${to} placeholder=${`${project.key}-2`} aria-label=${t("Task")} onInput=${(event) => setTo(event.currentTarget.value)} onKeyDown=${(event) => event.key === "Escape" && (event.stopPropagation(), setAdding(false))} />
                          <button class="btn small primary" disabled=${to.trim() === ""}>${t("Add")}</button>
                      </form>`
                    : html`<button class="pt-add" onClick=${() => setAdding(true)}>${svg("M12 6v12M6 12h12", 16)}${t("Add a relation")}</button>`
            }
        </section>`;
    }

    /** The sessions that led, worked on, or mentioned it: rows as in the session list, newest run first. */
    function Sessions({ data, close }) {
        const { runs, sessions } = data;

        if (sessions.length === 0) {
            return null;
        }

        const order = { main: 0, worker: 1, linked: 2 };
        const rows = [...sessions].sort((a, b) => order[a.role] - order[b.role] || b.createdAt - a.createdAt);

        return html`<section class="pt-sec">
            <div class="pt-sec-h">${t("Sessions")}<span class="pt-n">${sessions.length}</span></div>
            ${rows.map((session) => {
                // In someone else's pi-phone (the team server): named, not a link.
                if (!/^\d+$/.test(session.conversationId)) {
                    return html`<div class="pt-row pt-session">
                        <span class="pt-sess-icon">${svg(CHAT, 14)}</span>
                        <span class="pt-t">${session.by ? t("In {name}'s pi-phone", { name: session.by }) : t("In someone else's pi-phone")}<small>${session.role === "worker" ? t("Their Pi's run") : session.role === "main" ? t("Leads it there") : t("Mentions it")}</small></span>
                    </div>`;
                }

                const index = runs.findIndex((run) => run.conversationId === session.conversationId);
                const run = runs[index];
                const busy = session.state?.busy;
                const what =
                    session.role === "main"
                        ? t("Leads it")
                        : session.role === "worker"
                          ? [
                                runs.length > 1 && index >= 0 ? t("{nth} run", { nth: nth(index + 1) }) : t("Its run"),
                                busy
                                    ? t("working {time}", { time: took(Date.now() - (session.state.busySince ?? Date.now())) })
                                    : run?.endedAt && run.startedAt
                                      ? t("finished in {time}", { time: took(run.endedAt - run.startedAt) })
                                      : run
                                        ? runLower[run.state]
                                        : null,
                            ]
                                .filter(Boolean)
                                .join(" · ")
                          : t("Mentions it");

                return html`<a class="pt-row pt-session" href=${`s/${session.conversationId}`} onClick=${() => close()}>
                    <span class=${`pt-sess-icon ${busy ? "busy" : ""} ${session.state?.waiting ? "waiting" : ""}`}>${svg(session.role === "main" ? BOARD : CHAT, 14)}</span>
                    <span class="pt-t">${(session.title ?? t("Session #{id}", { id: session.conversationId })).replace(/^[A-Z][A-Z0-9]{1,5}-\d+ · /, "")}<small>${what} · #${session.conversationId}</small></span>
                    ${svg(CHEVRON, 15, "pt-chev")}
                </a>`;
            })}
        </section>`;
    }

    /** Comments, and with All what happened: run steps folded into one line a run, the oldest folded away. */
    function Activity({ data }) {
        const { comments, activity, runs } = data;
        const [all, setAll] = useState(false);
        const [shown, setShown] = useState(8);
        let ended = 0;
        const events = activity.flatMap((event) => {
            if (event.kind === "run") {
                // One line a run, when it ends: queued, starting and running are its way there.
                if (!["done", "failed", "stopped", "cancelled"].includes(event.data.state)) {
                    return [];
                }

                // Someone else's run (the team server): its step and branch, from their pi-phone.
                const mine = event.data.session === undefined || event.data.session === null || /^\d+$/.test(String(event.data.session));
                const run = mine ? runs.filter((each) => !ACTIVE.has(each.state))[ended++] : undefined;
                const time = run?.endedAt && run.startedAt ? took(run.endedAt - run.startedAt) : null;
                const branch = event.data.branch || null;
                const vars = { time, branch };
                const words = {
                    done:
                        time !== null
                            ? branch !== null
                                ? t("ran it · finished in {time} · on {branch}", vars)
                                : t("ran it · finished in {time}", vars)
                            : branch !== null
                              ? t("ran it · finished · on {branch}", vars)
                              : t("ran it · finished"),
                    failed: branch !== null ? t("ran it · it failed · on {branch}", vars) : t("ran it · it failed"),
                    stopped: branch !== null ? t("ran it · it stopped · on {branch}", vars) : t("ran it · it stopped"),
                    cancelled: t("cancelled its run"),
                }[event.data.state];

                return [{ at: event.createdAt, who: mine ? event.actorName : t("{name}'s Pi", { name: event.data.by ?? event.actorName }), words }];
            }

            // Ticking items is the checklist's to show, not the feed's.
            if (event.kind === "changed" && Object.keys(event.data).every((field) => field === "checklist")) {
                return [];
            }

            return [{ at: event.createdAt, who: event.actorName, words: describe(event) }];
        });
        const entries = [...comments.map((comment) => ({ at: comment.createdAt, comment })), ...(all ? events : [])].sort((a, b) => a.at - b.at);
        const hidden = Math.max(0, entries.length - shown);

        return html`<section class="pt-sec">
            <div class="pt-sec-h">
                ${t("Activity")}<span class="pj-sp"></span>
                <span class="pt-seg" role="tablist">
                    <button role="tab" aria-selected=${!all} class=${all ? "" : "on"} onClick=${() => setAll(false)}>${t("Comments")}</button>
                    <button role="tab" aria-selected=${all} class=${all ? "on" : ""} onClick=${() => setAll(true)}>${t("All")}</button>
                </span>
            </div>
            ${entries.length === 0 && html`<p class="pt-hint">${all ? t("Nothing yet.") : t("No comments yet.")}</p>`}
            <div class="pt-feed">
                ${hidden > 0 && html`<button class="pt-act pt-earlier" onClick=${() => setShown(shown + 20)}>${t("Show {n} earlier", { n: hidden })}</button>`}
                ${entries.slice(hidden).map((entry) =>
                    entry.comment
                        ? html`<div class="pt-comment">
                              ${avatar(entry.comment.author, [{ id: entry.comment.author, name: entry.comment.authorName }])}
                              <div class="pt-comment-body">
                                  <div class="pt-comment-who"><b>${entry.comment.authorName}</b>${entry.comment.session && html`<span>#${entry.comment.session}</span>`}<span>${ago(entry.at)}</span></div>
                                  <div class="pt-prose"><${Markdown} text=${entry.comment.text} /></div>
                              </div>
                          </div>`
                        : html`<div class="pt-event"><span class="pt-tick"><i></i></span><span><b>${entry.who}</b> ${entry.words}</span><span class="pt-time">${ago(entry.at)}</span></div>`,
                )}
            </div>
        </section>`;
    }

    /** The comment box, at the foot of the sheet. Ctrl/⌘+Enter sends. */
    function Composer({ task, reload }) {
        const [text, setText] = useState("");
        const box = useRef(null);
        const send = () => {
            if (text.trim() === "") {
                return;
            }

            pocket.api(`tasks/${task.ref}/comments`, { text }).then(() => {
                setText("");
                reload();
            }, failed);
        };

        useEffect(() => {
            box.current.style.height = "auto";
            box.current.style.height = `${Math.min(box.current.scrollHeight, 140)}px`;
            // A scrollbar only once it is full.
            box.current.style.overflowY = box.current.scrollHeight > 140 ? "auto" : "hidden";
        }, [text]);

        return html`<form class="pt-composer" onSubmit=${(event) => (event.preventDefault(), send())}>
            <textarea
                ref=${box}
                rows="1"
                value=${text}
                placeholder=${t("Comment on {ref}…", { ref: task.ref })}
                aria-label=${t("Comment")}
                onInput=${(event) => setText(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && (event.ctrlKey || event.metaKey) && (event.preventDefault(), send())}
            ></textarea>
            <button class="pt-send" aria-label=${t("Send")} disabled=${text.trim() === ""}><${Icon} name="send" size=${17} /></button>
        </form>`;
    }

    /** An activity entry in words. */
    function describe(event) {
        if (event.kind === "created") {
            return t("made it ({type}, {state})", { type: typeWord[event.data.type] ?? event.data.type, state: stateLabel[event.data.state] ?? event.data.state });
        }

        if (event.kind === "merged") {
            return event.data.commit
                ? t("merged it into {base} ({commit})", { base: event.data.base, commit: event.data.commit })
                : t("merged it into {base}", { base: event.data.base });
        }

        if (event.kind === "run") {
            const state = runLabel[event.data.state] ?? event.data.state;

            return event.data.note ? t("run: {state} ({note})", { state, note: event.data.note }) : t("run: {state}", { state });
        }

        if (event.kind === "linked" || event.kind === "unlinked") {
            return event.kind === "unlinked"
                ? t("unlinked it from {ref}", { ref: event.data.to })
                : event.data.kind === "blocks"
                  ? t("linked it as blocking {ref}", { ref: event.data.to })
                  : t("linked it to {ref}", { ref: event.data.to });
        }

        const said = Object.entries(event.data).map(([field, value]) =>
            field === "state"
                ? t("moved it to {state}", { state: stateLabel[value] ?? value })
                : field === "assignee"
                  ? value === null
                      ? t("unassigned it")
                      : t("assigned it to {name}", { name: value === "pi" ? "Pi" : (peopleCache?.find((person) => person.id === value)?.name ?? t("someone")) })
                  : (changedWords[field] ?? t("changed {field}", { field })),
        );

        return said.join(", ");
    }

    /** The project's team: its main session, whether tasks given to Pi run by themselves, and where they run. */
    function TeamSettings({ project, places, lead, save, close }) {
        const [busy, setBusy] = useState(false);
        const setPlaces = (next) => save({ places: next });
        const addPlace = async () => {
            const chosen = await pocket.pickFolder({ start: project.folder || undefined, title: t("Where its tasks run: the repository there") });

            if (chosen) {
                await setPlaces([...places.filter((place) => place.folder !== chosen), { folder: chosen, cap: 2 }]);
            }

            pocket.openSheet("project", { project: project.key });
        };

        return html`<div class="field">
            <span class="label">${t("Team")}</span>
            <div class="pj-team">
                <div class="pj-team-row">
                    <div class="pj-grow">
                        <div>${t("Main session")}</div>
                        <div class="muted small">${t("Leads the project: plans, asks before runs, gets the task sessions' reports, reviews. It never writes code itself.")}</div>
                    </div>
                    ${
                        lead
                            ? html`<a class="button small" href=${`s/${lead.session}`} onClick=${() => close()}>${t("Open #{id}", { id: lead.session })}</a>`
                            : html`<button
                                  class="button small primary"
                                  disabled=${busy || !project.folder}
                                  title=${project.folder ? "" : t("Give the project a folder first")}
                                  onClick=${() => {
                                      setBusy(true);
                                      pocket
                                          .api(`projects/${project.key}/team`, {})
                                          .then((answer) => {
                                              pocket.notify("info", t("Started the main session, #{id}.", { id: answer.session }));
                                              pocket.openSheet("project", { project: project.key });
                                          }, failed)
                                          .finally(() => setBusy(false));
                                  }}
                              >
                                  ${t("Start it")}
                              </button>`
                    }
                </div>
                <div class="pj-team-row">
                    <div class="pj-grow">
                        <div>${t("Runs by itself")}</div>
                        <div class="muted small">${project.autoRuns ? t("A task given to Pi starts at once, where there is room.") : t("Off: the main session asks you before a task given to Pi runs.")}</div>
                    </div>
                    <${Switch} on=${project.autoRuns} label=${t("Run tasks given to Pi by themselves")} onChange=${() => save({ autoRuns: !project.autoRuns })} />
                </div>
                <div class="pj-team-row">
                    <div class="pj-grow">
                        <div>${t("Board rules")}</div>
                        <div class="muted small">${project.rules === "light" ? t("Light: Pi tracks its work as tasks and keeps them current.") : t("Full: also blocked tasks, review for risky work, and how to comment.")}</div>
                    </div>
                    <${Segmented} value=${project.rules ?? "full"} options=${[["full", t("Full")], ["light", t("Light")]]} onChange=${(rules) => save({ rules })} />
                </div>
                <div class="pj-team-sub muted small">${t("Where tasks run: each in a git worktree of the repository there, at most so many at once. A run goes to the place with the most room; when all are full, it waits.")}</div>
                ${places.map(
                    (place, index) => html`<div class="pj-team-row">
                        <div class="pj-grow pj-place" title=${place.folder}>${shortFolder(place.folder)}</div>
                        <div class="pj-stepper">
                            <button aria-label=${t("Fewer at once")} disabled=${place.cap <= 1} onClick=${() => setPlaces(places.map((each, at) => (at === index ? { ...each, cap: each.cap - 1 } : each)))}>−</button>
                            <span title=${t("At once")}>${place.cap}</span>
                            <button aria-label=${t("More at once")} disabled=${place.cap >= 8} onClick=${() => setPlaces(places.map((each, at) => (at === index ? { ...each, cap: each.cap + 1 } : each)))}>+</button>
                        </div>
                        <button class="pj-x" aria-label=${t("Remove this place")} disabled=${places.length === 1 && project.places.length === 0} onClick=${() => setPlaces(places.filter((_each, at) => at !== index))}>×</button>
                    </div>`,
                )}
                ${places.length === 0 && html`<div class="muted small">${t("Give the project a folder, or add a place.")}</div>`}
                <button class="button small" onClick=${addPlace}>${t("Add a place")}</button>
            </div>
        </div>`;
    }

    function ProjectSheet({ project: key, close }) {
        const [project, setProject] = useState(null);
        const [team, setTeam] = useState({ places: [], lead: null });
        const people = usePeople();
        const crew = useTeam();
        const loadProject = () =>
            pocket.api(`projects/${key}`).then((answer) => {
                setProject(answer.project);
                setTeam({ places: answer.places, lead: answer.lead });
            }, failed);

        useEffect(() => {
            loadProject();
        }, [key]);

        if (project === null) {
            return html`<${Loader} label=${t("Opening")} />`;
        }

        const manage = leads(crew, project);
        const save = (body) => pocket.api(`projects/${key}`, body, { method: "PATCH" }).then(loadProject, failed);
        const share = (members, roles = project.memberRoles ?? {}) =>
            pocket.api(`projects/${key}/members`, { members, roles: Object.fromEntries(members.map((id) => [id, roles[id] ?? "member"])) }, { method: "PUT" }).then(setProject, failed);
        /** One teammate's standing on the board (the team server): none, viewer, member or lead. */
        const standing = (id, role) => {
            const others = project.members.filter((each) => each !== id);

            share(role === "none" ? others : [...others, id], { ...(project.memberRoles ?? {}), [id]: role });
        };
        const act = (path, body, method) =>
            pocket.api(`projects/${key}/${path}`, body, method === undefined ? undefined : { method }).then((answer) => {
                loadProject();

                return answer;
            }, failed);

        return html`<div class="pj-form">
            <label class="field"><span class="label">${t("Name")}</span><input value=${project.name} onChange=${(event) => save({ name: event.currentTarget.value })} /></label>
            <${FolderField}
                value=${project.folder ?? ""}
                onInput=${(value) => setProject({ ...project, folder: value })}
                reopen=${(chosen) =>
                    pocket
                        .api(`projects/${key}`, { folder: chosen || null }, { method: "PATCH" })
                        .catch(failed)
                        .finally(() => pocket.openSheet("project", { project: key }))}
            />
            <button class="button small" onClick=${() => save({ folder: project.folder || null })}>${t("Save the folder")}</button>
            <${TeamSettings} project=${project} places=${team.places} lead=${team.lead} save=${save} close=${close} />
            ${crew.team && html`<${TeamSharing} project=${project} people=${people} team=${crew} manage=${manage} standing=${standing} act=${act} close=${close} />`}
            <div class="field" hidden=${crew.team}>
                <span class="label">${t("Shared with")}</span>
                ${people
                    .filter((person) => person.role !== "owner" && person.id !== project.owner)
                    .map(
                        (person) => html`<label class="pj-share">
                            <input
                                type="checkbox"
                                disabled=${!manage}
                                checked=${project.members.includes(person.id)}
                                onChange=${(event) =>
                                    share(event.currentTarget.checked ? [...project.members, person.id] : project.members.filter((id) => id !== person.id))}
                            />
                            <span>${person.name}</span><span class="muted small">${person.role === "viewer" ? t("can view") : t("can change")}</span>
                        </label>`,
                    )}
                ${people.filter((person) => person.role !== "owner" && person.id !== project.owner).length === 0 && html`<span class="muted small">${t("Nobody else is in the app yet (Settings › People).")}</span>`}
            </div>
            ${
                manage &&
                (!crew.team || crew.me?.canDelete) &&
                html`<button
                    class="button ghost pj-delete"
                    onClick=${() =>
                        confirm(t("Delete {key} and all its tasks for good?", { key: project.key })) &&
                        pocket.api(`projects/${key}`, undefined, { method: "DELETE" }).then(() => {
                            pocket.notify("info", t("Deleted {ref}.", { ref: project.key }));
                            localStorage.removeItem(CURRENT);
                            close();
                        }, failed)}
                >
                    ${t("Delete {key}", { key: project.key })}
                </button>`
            }
        </div>`;
    }

    /**
     * Sharing on the team server (PP-43): each teammate as nobody, viewer, member or lead; a team board open to everyone;
     * moving a board to the team; leaving one shared with you.
     */
    function TeamSharing({ project, people, team, manage, standing, act, close }) {
        const others = people.filter((person) => person.id !== project.owner);
        const mine = project.members.includes(team.me?.id) && project.owner !== team.me?.id;

        return html`<div class="field">
            <span class="label">${project.team ? t("A team board: its members") : t("Shared with")}</span>
            ${others.map(
                (person) => html`<label class="pj-share">
                    <span class="pj-grow">${person.id === team.me?.id ? t("{name} (you)", { name: person.name }) : person.name}</span>
                    <select
                        aria-label=${t("{name} on {key}", { name: person.name, key: project.key })}
                        disabled=${!manage || !team.me?.canShare || person.id === team.me?.id}
                        value=${project.members.includes(person.id) ? (project.memberRoles?.[person.id] ?? "member") : "none"}
                        onChange=${(event) => standing(person.id, event.currentTarget.value)}
                    >
                        <option value="none">${t("Not on it")}</option>
                        <option value="viewer">${t("Viewer")}</option>
                        ${person.role !== "viewer" && html`<option value="member">${t("Member")}</option><option value="lead">${t("Lead")}</option>`}
                    </select>
                </label>`,
            )}
            ${others.length === 0 && html`<span class="muted small">${t("Nobody else is on the team yet.")}</span>`}
            ${!manage && html`<span class="muted small">${t("Its leads choose who is on it.")}</span>`}
            ${
                project.team &&
                manage &&
                html`<label class="pj-share"
                    ><input type="checkbox" checked=${project.open} onChange=${(event) => act("open", { open: event.currentTarget.checked }, "PUT")} /><span>${t("Everyone on the team can see it")}</span
                    ><span class="muted small">${t("as viewers")}</span></label
                >`
            }
            ${
                !project.team &&
                manage &&
                team.me?.managesTeam &&
                html`<button class="button small" onClick=${() => confirm(t("Move {key} to the team? It stops being yours; you stay on it as a lead.", { key: project.key })) && act("to-team", {})}>${t("Move to the team")}</button>`
            }
            ${
                mine &&
                html`<button
                    class="button small ghost"
                    onClick=${() =>
                        confirm(t("Leave {key}? It leaves your Projects, and what was given to you or your Pi goes back to nobody.", { key: project.key })) &&
                        act("leave", {}).then(() => {
                            localStorage.removeItem(CURRENT);
                            close();
                        })}
                >
                    ${t("Leave {key}", { key: project.key })}
                </button>`
            }
        </div>`;
    }

    /** Tasks given to you or your Pi, on every board you see, not done (PP-43). */
    function MineSheet({ close }) {
        const [tasks, setTasks] = useState(null);

        useEffect(() => {
            pocket.api("mine").then((answer) => setTasks(answer.tasks), failed);
        }, []);

        if (tasks === null) {
            return html`<${Loader} label=${t("Finding your tasks")} />`;
        }

        return html`<div class="pj-form">
            ${tasks.length === 0 && html`<p class="muted">${t("Nothing is given to you or your Pi right now.")}</p>`}
            ${tasks.map(
                (task) => html`<button
                    class="pt-row"
                    onClick=${() => {
                        close();
                        pocket.openSheet("task", { task: task.ref });
                    }}
                >
                    <span class="pj-key">${task.ref}</span>
                    <span class="pt-t">${task.title}<small>${task.assignee?.startsWith("pi") ? t("{state} · your Pi", { state: stateLabel[task.state] ?? task.state }) : (stateLabel[task.state] ?? task.state)}</small></span>
                </button>`,
            )}
        </div>`;
    }

    /** A shared board's project wiki (PP-42, the team server): its pages, a search, a page, and writing one. */
    function WikiView({ project, team }) {
        const [pages, setPages] = useState(null);
        const [open, setOpen] = useState(null);
        const [query, setQuery] = useState("");
        const [hits, setHits] = useState(null);
        const [draft, setDraft] = useState(null);
        const writer = project.owner === team.me?.id || ["lead", "member"].includes(project.memberRoles?.[team.me?.id]) || (project.team && team.me?.managesTeam);
        const load = () => pocket.api(`projects/${project.key}/wiki`).then((answer) => setPages(answer.pages), failed);
        const show = (slug) => pocket.api(`projects/${project.key}/wiki/${slug}`).then((page) => (setOpen(page), setDraft(null)), failed);

        useEffect(() => {
            load();

            return pocket.on("changed", load);
        }, [project.key]);

        const search = (event) => {
            event.preventDefault();
            query.trim() === "" ? setHits(null) : pocket.api(`projects/${project.key}/wiki-search?q=${encodeURIComponent(query)}`).then((answer) => setHits(answer.hits), failed);
        };
        const save = (event) => {
            event.preventDefault();
            const slug = draft.slug || draft.title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

            pocket.api(`projects/${project.key}/wiki/${slug}`, { title: draft.title, body: draft.body }, { method: "PUT" }).then((page) => (setOpen(page), setDraft(null), load()), failed);
        };

        if (pages === null) {
            return html`<${Loader} label=${t("Opening the wiki")} />`;
        }

        return html`<div class="pj-wiki">
            <aside class="pj-wiki-list">
                <form onSubmit=${search}><input type="search" placeholder=${t("Search the wiki")} value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} /></form>
                ${(hits ?? pages).map(
                    (page) => html`<button class=${`pt-row ${open?.slug === page.slug ? "on" : ""}`} onClick=${() => show(page.slug)}>
                        <span class="pt-t">${page.title}<small>${page.snippet ?? `${page.updatedByName} · ${ago(page.updatedAt)}`}</small></span>
                    </button>`,
                )}
                ${pages.length === 0 && html`<p class="muted small">${t("No pages yet. Pi writes what it learns about {key} here, in board mode; so can you.", { key: project.key })}</p>`}
                ${writer && html`<button class="button small" onClick=${() => setDraft({ slug: "", title: "", body: "" })}>${t("+ Page")}</button>`}
            </aside>
            <section class="pj-wiki-page">
                ${
                    draft !== null
                        ? html`<form class="pj-form" onSubmit=${save}>
                              <label class="field"><span class="label">${t("Title")}</span><input value=${draft.title} required maxlength="120" onInput=${(event) => setDraft({ ...draft, title: event.currentTarget.value })} /></label>
                              <label class="field"><span class="label">${t("Page (markdown)")}</span><textarea rows="16" value=${draft.body} onInput=${(event) => setDraft({ ...draft, body: event.currentTarget.value })}></textarea></label>
                              <div class="pj-row"><button class="button primary small">${t("Save")}</button><button type="button" class="button small ghost" onClick=${() => setDraft(null)}>${t("Cancel")}</button></div>
                          </form>`
                        : open === null
                          ? html`<p class="muted">${t("Pick a page.")}</p>`
                          : html`<article>
                                <h3>${open.title}</h3>
                                <p class="muted small">${t("{slug} · last written by {name}, {time} ago", { slug: open.slug, name: open.updatedByName, time: ago(open.updatedAt) })}</p>
                                <${Markdown} text=${open.body} />
                                ${writer && html`<button class="button small" onClick=${() => setDraft({ slug: open.slug, title: open.title, body: open.body })}>${t("Edit")}</button>`}
                            </article>`
                }
            </section>
        </div>`;
    }

    /**
     * Choosing a session's project among many: a search box, then the projects (the chosen one first, then the most
     * recently changed), in a list that scrolls on its own.
     */
    function ProjectPicker({ list, chosen, onPick, onBack }) {
        const [query, setQuery] = useState("");
        const wanted = query.trim().toLowerCase();
        const shown = list
            .filter((project) => wanted === "" || project.key.toLowerCase().includes(wanted) || project.name.toLowerCase().includes(wanted))
            .sort((a, b) => Number(b.key === chosen) - Number(a.key === chosen) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

        return html`<div class="pj-board-sheet">
            <div class="pj-picker-head">
                <button class="icon-button" aria-label=${t("Back")} onClick=${onBack}><${Icon} name="back" size=${18} /></button>
                <input
                    class="pj-picker-search"
                    type="search"
                    value=${query}
                    placeholder=${t("Search {n} projects", { n: list.length })}
                    aria-label=${t("Search projects")}
                    autofocus
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                    onKeyDown=${(event) => event.key === "Enter" && shown[0] && onPick(shown[0].key)}
                />
            </div>
            ${
                shown.length === 0
                    ? html`<p class="muted small">${t("No project matches “{query}”.", { query })}</p>`
                    : html`<div class="sheet-list pj-picker-list" role="radiogroup" aria-label=${t("Project")}>
                          ${shown.map(
                              (project) => html`<button class="list-item pj-pick" role="radio" aria-checked=${project.key === chosen} onClick=${() => onPick(project.key)}>
                                  <span><b class="pj-pick-key">${project.key}</b> ${project.name}</span>
                                  ${project.key === chosen && html`<${Icon} name="check" size=${16} />`}
                              </button>`,
                          )}
                      </div>`
            }
        </div>`;
    }

    /** A choice of a few, as the app's settings draw them (`.segmented`). */
    function Segmented({ value, options, onChange }) {
        return html`<div class="segmented">
            ${options.map(([key, label]) => html`<button class=${value === key ? "on" : ""} aria-pressed=${value === key} onClick=${() => value !== key && onChange(key)}>${label}</button>`)}
        </div>`;
    }

    /**
     * The session menu's "Board for this session", laid out as the app's settings: board mode on or off; the project, a
     * row each (picking one turns the board on); and, while on, who moves tasks to Done and the board rules here.
     */
    function BoardModeSheet({ close }) {
        const conversation = pocket.conversationId();
        const [mode, setMode] = useState(null);
        const [list, setList] = useState([]);
        const [picking, setPicking] = useState(false);

        useEffect(() => {
            if (conversation === null) {
                return;
            }

            pocket.api(`board-mode/${conversation}`).then(setMode, failed);
            pocket.api("projects").then((answer) => setList(answer.projects), failed);
        }, [conversation]);

        if (conversation === null) {
            return html`<p class="muted">${t("Open a session first.")}</p>`;
        }

        if (mode === null) {
            return html`<${Loader} label=${t("Opening")} />`;
        }

        const set = (body) => pocket.api(`board-mode/${conversation}`, body, { method: "PUT" }).then(setMode, failed);
        const current = list.find((project) => project.key === mode.project);

        if (picking) {
            return html`<${ProjectPicker}
                list=${list}
                chosen=${mode.project}
                onPick=${(key) => {
                    setPicking(false);

                    if (key !== mode.project || !mode.on) {
                        void set({ on: true, project: key });
                    }
                }}
                onBack=${() => setPicking(false)}
            />`;
        }

        return html`<div class="pj-board-sheet">
            <div class="sheet-list">
                <div class="setting-row">
                    <div class="setting-text">
                        <span>${t("Track this session on a board")}</span>
                        <span>
                            ${
                                mode.on
                                    ? current
                                        ? t("Pi keeps its tasks current on {key} · {name}.", { key: current.key, name: current.name })
                                        : t("Pi keeps its tasks current on the board.")
                                    : mode.decided
                                      ? t("Off: Pi works without a board and won't ask again.")
                                      : t("Off: Pi asks once when the work has several parts.")
                            }
                        </span>
                    </div>
                    <${Switch}
                        on=${mode.on}
                        label=${t("Board mode")}
                        disabled=${!mode.on && list.length === 0}
                        onChange=${() => set({ on: !mode.on, project: mode.project ?? list[0]?.key ?? null })}
                    />
                </div>
            </div>
            <div class="label">${t("Project")}</div>
            ${
                list.length === 0
                    ? html`<p class="muted small">${t("No projects yet: make one on the Projects page.")}</p>`
                    : html`<div class="sheet-list">
                          <button class="list-item pj-pick" onClick=${() => setPicking(true)}>
                              <span>${current ? html`<b class="pj-pick-key">${current.key}</b> ${current.name}` : html`<span class="muted">${t("Choose a project")}</span>`}</span>
                              <span class="pj-pick-more">${list.length > 1 && html`<span class="muted small">${tn(list.length, "{n} project", "{n} projects")}</span>`}<${Icon} name="chevron" size=${16} /></span>
                          </button>
                      </div>`
            }
            ${
                mode.on &&
                html`<div class="label">${t("How Pi works the board here")}</div>
                    <div class="sheet-list">
                        <div class="setting-row">
                            <div class="setting-text">
                                <span>${t("Moves tasks to Done")}</span>
                                <span>
                                    ${
                                        mode.closer === "verified"
                                            ? t("Pi, once it verified the work itself: live, measured, and it tells you how.")
                                            : mode.closer === "pi"
                                              ? t("Pi, once you say in chat that a task is good.")
                                              : t("You, on the board: Pi stops at Review.")
                                    }
                                </span>
                            </div>
                            <${Segmented} value=${mode.closer} options=${[["person", t("You")], ["pi", t("Pi, after you")], ["verified", "Pi"]]} onChange=${(closer) => set({ closer })} />
                        </div>
                        <div class="setting-row">
                            <div class="setting-text">
                                <span>${t("Board rules")}</span>
                                <span>
                                    ${
                                        mode.rules === null
                                            ? mode.projectRules === "light"
                                                ? t("The project's: light.")
                                                : t("The project's: full.")
                                            : mode.rules === "light"
                                              ? t("Light: track work as tasks, keep them current.")
                                              : t("Full: also blocked tasks, review for risky work, how to comment.")
                                    }
                                </span>
                            </div>
                            <${Segmented} value=${mode.rules ?? "project"} options=${[["project", t("Project")], ["full", t("Full")], ["light", t("Light")]]} onChange=${(rules) => set({ rules: rules === "project" ? null : rules })} />
                        </div>
                    </div>`
            }
            <div class="sheet-actions"><button class="button" onClick=${close}>${t("Done")}</button></div>
        </div>`;
    }

    pocket.page({ id: "projects", title: t("Projects"), component: ProjectsPage, swipe: false });
    // Bare: the sheet draws its own header (the task's ref, its state, its menu).
    pocket.sheet({ id: "task", title: t("Task"), component: TaskSheet, wide: true, bare: true });
    pocket.sheet({ id: "new-task", title: t("New task"), component: NewTaskSheet });
    pocket.sheet({ id: "new-project", title: t("New project"), component: NewProjectSheet });
    pocket.sheet({ id: "project", title: t("Project settings"), component: ProjectSheet });
    pocket.sheet({ id: "move", title: t("Move to"), component: MoveSheet });
    pocket.sheet({ id: "mine", title: t("Given to you"), component: MineSheet });
    pocket.sheet({ id: "board-mode", title: t("Board for this session"), component: BoardModeSheet });
    pocket.rail({ id: "projects", title: t("Projects"), iconPath: BOARD, page: "projects" });
    pocket.launcher({
        id: "projects",
        label: t("Projects"),
        detail: t("boards of tasks for you and Pi"),
        iconPath: BOARD,
        keywords: ["kanban", "board", "tasks", "backlog"],
        page: "projects",
    });
    // `#task:PP-3` links anywhere in the app (Pi's answers, notes) open that task; an address ending in one opens it too.
    const TASK_LINK = /^#task:([A-Za-z][A-Za-z0-9]{1,5}-\d+)$/;
    const anywhere = (event) => {
        const link = event.target.closest?.('a[href^="#task:"]');
        const match = link && TASK_LINK.exec(link.getAttribute("href"));

        if (match) {
            event.preventDefault();
            pocket.openSheet("task", { task: match[1].toUpperCase() });
        }
    };
    // `#project:new` opens New project, and `#project:PP` that project's settings.
    const settingsLink = /^#project:([A-Za-z][A-Za-z0-9]{1,5})$/.exec(location.hash);
    const linked = TASK_LINK.exec(location.hash) ?? (location.hash === "#project:new" || settingsLink ? ["", null] : null);

    document.addEventListener("click", anywhere);
    pocket.onDispose(() => document.removeEventListener("click", anywhere));

    if (linked) {
        history.replaceState(history.state, "", location.pathname + location.search);
        const task = linked[1]?.toUpperCase() ?? null;
        const settings = settingsLink && settingsLink[1].toLowerCase() !== "new" ? settingsLink[1].toUpperCase() : null;
        const shown = () => (task === null ? document.querySelector(".pj-form") : document.querySelector(`.pt[data-task="${task}"]`));
        // The app opens a linked page as the modules load, and that closes sheets: until the task shows, ask again.
        let tries = 0;
        const tryOpen = () => {
            if (shown() !== null || tries++ > 30) {
                return;
            }

            setTimeout(tryOpen, 300);

            try {
                task !== null ? pocket.openSheet("task", { task }) : settings !== null ? pocket.openSheet("project", { project: settings }) : pocket.openSheet("new-project");
            } catch {
                // Not ready yet: the next try.
            }
        };

        setTimeout(tryOpen, 300);
    }

    pocket.menu({ id: "board-mode", label: t("Board for this session"), hint: t("track this work on a project board"), sheet: "board-mode" });
}
