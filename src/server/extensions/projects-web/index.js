// Projects (src/server/extensions/projects.ts): the board of a project in the conversation's place, from the rail and the
// launcher, with ACS's Kanban (owner's choice): a column per state on a canvas lighter than the board, cards darker than
// the column, each with its type, priority, parent, progress, and a footer of ID, due date, age, and assignee. On a
// desktop a card is dragged to another state (and place); on a phone the states are tabs over one column at a time,
// swiped, and a long press offers Move to. A card opens its task in a sheet: every field, checklist, links, comments,
// activity, and the sessions that worked on it. The session menu's "Board for this session" turns board mode on or off.
const BOARD = "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z";

// Agent-board's states, with ACS's tones in the theme's palette.
const STATES = [
    { id: "inbox", label: "Inbox", tone: "var(--muted)", icon: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" },
    { id: "planning", label: "Planning", tone: "var(--accent)", icon: "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6M9 16h3" },
    { id: "assigned", label: "Assigned", tone: "var(--warn)", icon: "M9 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM3 21v-1a6 6 0 0 1 12 0v1M16 11l2 2 4-4" },
    { id: "in_progress", label: "In Progress", tone: "var(--o-cyan)", wip: 5, icon: "M13 2 4 14h7l-1 8 9-12h-7z" },
    { id: "blocked", label: "Blocked", tone: "var(--err)", icon: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 8v5M12 16h.01" },
    { id: "testing", label: "Testing", tone: "var(--o-orange)", wip: 3, icon: "M9 3h6M10 3v6L5 19a1.5 1.5 0 0 0 1.3 2h11.4A1.5 1.5 0 0 0 19 19l-5-10V3M7.5 15h9" },
    { id: "review", label: "Review", tone: "var(--spark)", icon: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" },
    { id: "done", label: "Done", tone: "var(--ok)", icon: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM8 12l3 3 5-6" },
];
const STATE = Object.fromEntries(STATES.map((state) => [state.id, state]));

// Agent-board's task types: the chip on every card.
const TYPES = [
    { id: "epic", label: "epic", tone: "var(--spark)", icon: "M12 3 21 12 12 21 3 12z" },
    { id: "story", label: "story", tone: "var(--accent)", icon: "M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" },
    { id: "task", label: "task", tone: "var(--muted)", icon: "M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14z" },
    { id: "bug", label: "bug", tone: "var(--err)", icon: "M12 7a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0v-5a4 4 0 0 1 4-4zM12 20v-7M4 10l4 1.5M20 10l-4 1.5M4 16h4M16 16h4M9.5 4l1.5 3M14.5 4 13 7" },
    { id: "subtask", label: "sub-task", tone: "var(--muted)", icon: "M6 4v7a4 4 0 0 0 4 4h8M15 12l3 3-3 3" },
];
const TYPE = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const PRIORITIES = ["None", "Low", "Medium", "High", "Urgent"];
// A run's states, in words, with the colour its chip takes.
const RUN = {
    queued: ["Waiting for a place", "var(--faint)"],
    starting: ["Starting", "var(--o-cyan)"],
    running: ["Running", "var(--o-cyan)"],
    done: ["Finished", "var(--ok)"],
    failed: ["Failed", "var(--err)"],
    stopped: ["Stopped", "var(--warn)"],
    cancelled: ["Cancelled", "var(--faint)"],
};
const ACTIVE = new Set(["queued", "starting", "running"]);
const PHONE = matchMedia("(max-width: 760px)");
const CURRENT = "pi-phone.projects.current";

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

function ago(ms) {
    const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));

    return minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
}

const initials = (name) =>
    name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("") || "?";

export default function projects(pocket) {
    const { html, useState, useEffect, useRef, useMemo, Icon, Loader, Markdown, Switch } = pocket;
    /** What the next opening of the page shows: a project's key. */
    let pendingKey = null;

    pocket.style("projects.css");

    const svg = (path, size = 14, cls = "") =>
        html`<svg class=${cls} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${path} /></svg>`;
    const typeChip = (type) => {
        const kind = TYPE[type] ?? TYPE.task;

        return html`<span class=${`pj-type pj-type-${kind.id}`} style=${`--tt:${kind.tone}`}>${svg(kind.icon, 11)}${kind.label}</span>`;
    };
    const priority = (value) =>
        value === 4
            ? html`<span class="pj-prio urgent" title="Urgent">!</span>`
            : html`<span class="pj-prio" title=${`${PRIORITIES[value]} priority`} data-p=${value}><i></i><i></i><i></i></span>`;
    const avatar = (assignee, people) => {
        if (assignee === null) {
            return html`<span class="pj-av none" title="Nobody yet">+</span>`;
        }

        if (assignee === "pi") {
            return html`<span class="pj-av pi" title="Pi">π</span>`;
        }

        const name = people.find((person) => person.id === assignee)?.name ?? "Someone";

        return html`<span class="pj-av" title=${name}>${initials(name)}</span>`;
    };
    const failed = (error) => pocket.notify("error", error.message);
    const patchTask = (ref, body) => pocket.api(`tasks/${ref}`, body, { method: "PATCH" });

    /** Everyone, for assignees and sharing; loaded once a page or sheet needs them. */
    let peopleCache = null;
    const usePeople = () => {
        const [people, setPeople] = useState(peopleCache ?? []);

        useEffect(() => {
            if (peopleCache === null) {
                pocket.api("people").then(
                    (answer) => {
                        peopleCache = answer.people;
                        setPeople(answer.people);
                    },
                    () => {},
                );
            }
        }, []);

        return people;
    };

    // ─── The page ─────────────────────────────────────────────────────────────────

    function ProjectsPage() {
        const [list, setList] = useState(null);
        const [key, setKey] = useState(pendingKey ?? localStorage.getItem(CURRENT));
        const [board, setBoard] = useState(null);
        const [problem, setProblem] = useState(null);
        const [picking, setPicking] = useState(false);
        const people = usePeople();
        const keyRef = useRef(key);

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
            return problem ? html`<p class="pj-problem">${problem}</p>` : html`<${Loader} label="Opening projects" />`;
        }

        if (list.length === 0) {
            return html`<div class="pj-empty-page">
                <div class="pj-empty-icon">${svg(BOARD, 28)}</div>
                <h3>No projects yet</h3>
                <p class="muted">A board of tasks for you and Pi: a backlog that keeps work from being forgotten. Pi also offers to start one when a session's work has several parts.</p>
                <button class="button primary" onClick=${() => pocket.openSheet("new-project")}>New project</button>
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
                            ${list.map(
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
                            )}
                            <button
                                class="pj-menu-new"
                                onClick=${() => {
                                    setPicking(false);
                                    pocket.openSheet("new-project");
                                }}
                            >
                                + New project
                            </button>
                        </div>`
                    }
                </div>
                <span class="pj-sp"></span>
                <button class="icon-button" title="Project settings" aria-label="Project settings" onClick=${() => pocket.openSheet("project", { project: key })}>
                    ${svg("M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6", 18)}
                </button>
                <button class="button primary small pj-add" onClick=${() => pocket.openSheet("new-task", { project: key })}>+ Task</button>
            </div>
            <div class="pj-chips">
                ${[
                    ["blocked", "Blocked"],
                    ["review", "Review"],
                    ["in_progress", "In progress"],
                    ["testing", "Testing"],
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

                    return html`${running > 0 && html`<span class="pj-chip" style="--tone:var(--o-cyan)"><i></i>Running <b>${running}</b></span>`}
                    ${queued > 0 && html`<span class="pj-chip" style="--tone:var(--faint)"><i></i>Queued <b>${queued}</b></span>`}`;
                })()}
                ${board?.lead && html`<a class="pj-chip pj-lead-chip" href=${`/s/${board.lead.session}`} title="The project's main session">${svg("M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z", 12)} Main session</a>`}
                <span class="pj-chip quiet">${total} ${total === 1 ? "task" : "tasks"} · ${counts.done ?? 0} done</span>
            </div>
            ${problem && html`<p class="pj-problem">${problem}</p>`}
            ${board === null ? html`<${Loader} label="Opening the board" />` : html`<${Kanban} board=${board} people=${people} reload=${loadBoard} />`}
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
                    ${task.operatorReview && html`<span class="pj-approve" title="Needs a person's approval before Done">${svg("M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", 12)}</span>`}
                    ${
                        task.run && ACTIVE.has(task.run.state) &&
                        html`<span class=${`pj-running ${task.run.state}`} title=${RUN[task.run.state][0]}><i></i>${task.run.state === "queued" ? "queued" : "running"}</span>`
                    }
                </div>
                <div class="pj-card-title">${task.title}</div>
                ${parent && html`<div class="pj-parent">${svg("M6 4v7a4 4 0 0 0 4 4h8M15 12l3 3-3 3", 11)}<span>${parent.title}</span></div>`}
                ${task.waitingOn.length > 0 && html`<div class="pj-waiting">Waiting on ${task.waitingOn.join(", ")}</div>`}
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
                    <span class="pj-age" title="Last changed">${ago(task.updatedAt)}</span>
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
            <div class="pj-tabs" role="tablist" aria-label="States">
                ${STATES.map((state, index) => {
                    const n = tasks.filter((task) => task.state === state.id).length;

                    return html`<button
                        role="tab"
                        aria-selected=${index === tab}
                        class=${index === tab ? "on" : ""}
                        style=${`--tone:${n > 0 ? state.tone : "var(--faint)"}`}
                        onClick=${() => scroller.current?.scrollTo({ left: index * scroller.current.clientWidth, behavior: "smooth" })}
                    >
                        <i></i>${state.label} <b>${n}</b>
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
                        title=${isCollapsed ? `Open ${state.label}` : undefined}
                    >
                        <div class="pj-tbar"></div>
                        <header>
                            ${isCollapsed && svg("m6 17 5-5-5-5M13 17l5-5-5-5", 14, "pj-unfold")}
                            ${svg(state.icon, 15, "pj-col-icon")}
                            <span class="pj-col-label">${state.label}</span>
                            <span class="pj-count">${items.length}</span>
                            ${!isCollapsed && state.wip !== undefined && html`<span class=${`pj-wip ${atWip ? "over" : ""}`} title="Work-in-progress limit">${items.length}/${state.wip}</span>`}
                            <span class="pj-sp"></span>
                            ${
                                !isCollapsed &&
                                html`<button class="pj-fold" title=${`Collapse ${state.label}`} aria-label=${`Collapse ${state.label}`} onClick=${() => toggle(state.id)}>
                                    ${svg("m11 17-5-5 5-5M18 17l-5-5 5-5", 14)}
                                </button>`
                            }
                        </header>
                        ${
                            !isCollapsed &&
                            html`<div class="pj-cards">
                                    ${items.length === 0 ? html`<div class="pj-col-empty">No tasks</div>` : items.map(card)}
                                </div>
                                <button class="pj-add-row" onClick=${() => pocket.openSheet("new-task", { project: board.project.key, state: state.id })}>+ Add a task</button>`
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
            <p class="muted small">Move ${ref} to</p>
            ${STATES.map(
                (each) => html`<button
                    class=${`pj-move-row ${each.id === state ? "on" : ""}`}
                    style=${`--tone:${each.tone}`}
                    onClick=${() =>
                        patchTask(ref, { state: each.id }).then(
                            () => {
                                pocket.notify("info", `${ref} is ${each.label}.`);
                                close();
                            },
                            failed,
                        )}
                >
                    ${svg(each.icon, 16)}<span>${each.label}</span>
                </button>`,
            )}
        </div>`;
    }

    /** A folder as people read it: a machine's as "path · on a machine". */
    const folderLabel = (folder) => {
        const machine = /^machine:[^:]+:(.*)$/.exec(folder);

        return machine ? `${machine[1]} · on a machine` : folder;
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
            const chosen = await pocket.pickFolder({ start: value || undefined, title: "The project's folder" });

            reopen(chosen ?? value);
        };

        return html`<div class="field">
            <span class="label">Folder</span>
            <div class="pj-folder">
                <input value=${value} placeholder="~/work/project" aria-label="Folder" onInput=${(event) => onInput(event.currentTarget.value)} />
                <button type="button" class="button" onClick=${choose}>Choose…</button>
            </div>
            <span class="muted small">${value && /^machine:/.test(value) ? folderLabel(value) : "Where its work happens: a folder here or on a machine. Choose… browses and makes folders, as New session does."}</span>
        </div>`;
    }

    function NewProjectSheet({ draft, close }) {
        const [key, setKey] = useState(draft?.key ?? "");
        const [name, setName] = useState(draft?.name ?? "");
        const [folder, setFolder] = useState(draft?.folder ?? "");
        const [busy, setBusy] = useState(false);
        const submit = (event) => {
            event.preventDefault();
            setBusy(true);
            pocket
                .api("projects", { key: key.trim().toUpperCase(), name: name.trim(), folder: folder.trim() || null })
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
            <label class="field"><span class="label">Name</span><input value=${name} placeholder="pi-phone" onInput=${(event) => setName(event.currentTarget.value)} required maxlength="80" /></label>
            <label class="field"
                ><span class="label">Key</span
                ><input value=${key} placeholder="PP" onInput=${(event) => setKey(event.currentTarget.value.toUpperCase())} required pattern="[A-Za-z][A-Za-z0-9]{1,5}" maxlength="6" />
                <span class="muted small">2 to 6 letters or digits. Tasks are named after it: ${key || "PP"}-1, ${key || "PP"}-2…</span></label
            >
            <${FolderField} value=${folder} onInput=${setFolder} reopen=${(chosen) => pocket.openSheet("new-project", { draft: { key, name, folder: chosen } })} />
            <button class="button primary" disabled=${busy || key === "" || name.trim() === ""}>Make the project</button>
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
            <label class="field"><span class="label">Title</span><input value=${title} onInput=${(event) => setTitle(event.currentTarget.value)} required maxlength="200" autofocus /></label>
            <div class="pj-two">
                <label class="field"
                    ><span class="label">Type</span
                    ><select value=${type} onChange=${(event) => setType(event.currentTarget.value)}>
                        ${TYPES.map((each) => html`<option value=${each.id}>${each.label}</option>`)}
                    </select></label
                >
                <label class="field"
                    ><span class="label">State</span
                    ><select value=${chosen} onChange=${(event) => setChosen(event.currentTarget.value)}>
                        ${STATES.filter((each) => each.id !== "done").map((each) => html`<option value=${each.id}>${each.label}</option>`)}
                    </select></label
                >
            </div>
            <label class="field"
                ><span class="label">Description</span
                ><textarea
                    rows="5"
                    value=${description}
                    placeholder="What to do and how to tell it is done (Markdown)"
                    onInput=${(event) => setDescription(event.currentTarget.value)}
                ></textarea></label
            >
            <div class="pj-two">
                <label class="field"
                    ><span class="label">Priority</span
                    ><select value=${priority} onChange=${(event) => setPriority(Number(event.currentTarget.value))}>
                        ${PRIORITIES.map((label, index) => html`<option value=${index}>${label}</option>`)}
                    </select></label
                >
                <label class="field"
                    ><span class="label">Assignee</span
                    ><select value=${assignee} onChange=${(event) => setAssignee(event.currentTarget.value)}>
                        <option value="">Nobody</option>
                        <option value="pi">Pi</option>
                        ${people.map((person) => html`<option value=${person.id}>${person.name}</option>`)}
                    </select></label
                >
            </div>
            <label class="field"
                ><span class="label">Due (optional)</span
                ><input type="date" value=${due} onInput=${(event) => setDue(event.currentTarget.value)} /></label
            >
            <label class="field"
                ><span class="label">Under (optional)</span
                ><input value=${parent} placeholder=${`${key}-1`} onInput=${(event) => setParent(event.currentTarget.value.toUpperCase())} />
                <span class="muted small">An epic holds stories, tasks and bugs; a story holds tasks, bugs and sub-tasks; a task or bug holds sub-tasks.</span></label
            >
            <button class="button primary" disabled=${busy || title.trim() === ""}>Add to ${key}</button>
        </form>`;
    }

    function TaskSheet({ task: ref, close }) {
        const [data, setData] = useState(null);
        const [problem, setProblem] = useState(null);
        const [comment, setComment] = useState("");
        const [linkTo, setLinkTo] = useState("");
        const [linkKind, setLinkKind] = useState("blocks");
        const [newItem, setNewItem] = useState("");
        const [editing, setEditing] = useState(false);
        const people = usePeople();
        const load = () => pocket.api(`tasks/${ref}`).then(setData, (error) => setProblem(error.message));

        useEffect(() => {
            load();

            return pocket.on("changed", load);
        }, [ref]);

        if (data === null) {
            return problem ? html`<p class="pj-problem">${problem}</p>` : html`<${Loader} label="Opening the task" />`;
        }

        const { task, project, comments, activity, sessions, links } = data;
        const save = (body) => patchTask(ref, body).then(load, failed);
        const members = people.filter((person) => person.role === "owner" || person.id === project.owner || project.members.includes(person.id));

        return html`<div class="pj-task" data-task=${task.ref} style=${`--tone:${STATE[task.state].tone}`}>
            <div class="pj-task-head">
                ${typeChip(task.type)}<span class="pj-id">${task.ref}</span>
                <select class="pj-state-select" value=${task.state} aria-label="State" onChange=${(event) => save({ state: event.currentTarget.value })}>
                    ${STATES.map((each) => html`<option value=${each.id}>${each.label}</option>`)}
                </select>
            </div>
            <input
                class="pj-task-title"
                value=${task.title}
                aria-label="Title"
                maxlength="200"
                onChange=${(event) => event.currentTarget.value.trim() !== task.title && save({ title: event.currentTarget.value })}
            />
            ${task.waitingOn.length > 0 && html`<div class="pj-waiting">Waiting on ${task.waitingOn.join(", ")}: the main session decides when it runs.</div>`}
            <${RunPanel} task=${task} project=${project} reload=${load} close=${close} />
            ${
                task.state === "blocked" &&
                html`<label class="field"
                    ><span class="label">Blocked: what it waits for</span
                    ><input value=${task.blockedReason ?? ""} onChange=${(event) => save({ blockedReason: event.currentTarget.value })} /></label
                >`
            }
            <dl class="pj-props">
                <dt>Type</dt>
                <dd>
                    <select value=${task.type} onChange=${(event) => save({ type: event.currentTarget.value })}>
                        ${TYPES.map((each) => html`<option value=${each.id}>${each.label}</option>`)}
                    </select>
                </dd>
                <dt>Priority</dt>
                <dd>
                    <select value=${task.priority} onChange=${(event) => save({ priority: Number(event.currentTarget.value) })}>
                        ${PRIORITIES.map((label, index) => html`<option value=${index}>${label}</option>`)}
                    </select>
                </dd>
                <dt>Assignee</dt>
                <dd>
                    <select value=${task.assignee ?? ""} onChange=${(event) => save({ assignee: event.currentTarget.value || null })}>
                        <option value="">Nobody</option>
                        <option value="pi">Pi</option>
                        ${members.map((person) => html`<option value=${person.id}>${person.name}</option>`)}
                    </select>
                </dd>
                <dt>Under</dt>
                <dd>
                    <input
                        class="pj-short"
                        value=${task.parentRef ?? ""}
                        placeholder="none"
                        onChange=${(event) => save({ parent: event.currentTarget.value.trim().toUpperCase() || null })}
                    />
                    ${task.children.length > 0 && html`<span class="muted small">holds ${task.children.join(", ")}</span>`}
                </dd>
                <dt>Dates</dt>
                <dd class="pj-dates">
                    <input type="date" value=${task.start ?? ""} aria-label="Start" onChange=${(event) => save({ start: event.currentTarget.value || null })} />
                    <span class="muted">→</span>
                    <input type="date" value=${task.due ?? ""} aria-label="Due" onChange=${(event) => save({ due: event.currentTarget.value || null })} />
                </dd>
                <dt>Labels</dt>
                <dd>
                    <input
                        value=${task.labels.join(", ")}
                        placeholder="ui, server"
                        onChange=${(event) => save({ labels: event.currentTarget.value.split(",").map((label) => label.trim()).filter(Boolean) })}
                    />
                </dd>
                <dt>Your approval</dt>
                <dd>
                    <${Switch} on=${task.operatorReview} label="Needs a person's approval before Done" onChange=${() => save({ operatorReview: !task.operatorReview })} />
                    <span class="muted small">${task.operatorReview ? "Only a person moves it to Done" : "Pi's main session may approve it"}</span>
                </dd>
                ${
                    task.type === "bug" &&
                    html`<dt>Fix verified</dt>
                        <dd>
                            <${Switch} on=${task.fixVerified} label="The fix was verified" onChange=${() => save({ fixVerified: !task.fixVerified })} />
                            <span class="muted small">A bug is Done only after this</span>
                        </dd>`
                }
            </dl>

            <section>
                <div class="pj-sec">
                    Description
                    <button class="link small" onClick=${() => setEditing(!editing)}>${editing ? "Done" : "Edit"}</button>
                </div>
                ${
                    editing
                        ? html`<textarea
                              class="pj-desc"
                              rows="8"
                              value=${task.description}
                              onChange=${(event) => save({ description: event.currentTarget.value })}
                          ></textarea>`
                        : task.description.trim() === ""
                          ? html`<p class="muted small">No description.</p>`
                          : html`<div class="pj-md"><${Markdown} text=${task.description} /></div>`
                }
            </section>

            <section>
                <div class="pj-sec">Checklist${task.checklist.length > 0 && ` · ${task.checklist.filter((item) => item.done).length}/${task.checklist.length}`}</div>
                ${task.checklist.map(
                    (item, index) => html`<div class=${`pj-check ${item.done ? "done" : ""}`}>
                        <input
                            type="checkbox"
                            checked=${item.done}
                            aria-label=${item.text}
                            onChange=${() => save({ checklist: task.checklist.map((each, at) => (at === index ? { ...each, done: !each.done } : each)) })}
                        />
                        <span>${item.text}</span>
                        <button class="pj-x" aria-label=${`Remove ${item.text}`} onClick=${() => save({ checklist: task.checklist.filter((_each, at) => at !== index) })}>×</button>
                    </div>`,
                )}
                <form
                    class="pj-inline"
                    onSubmit=${(event) => {
                        event.preventDefault();

                        if (newItem.trim() !== "") {
                            save({ checklist: [...task.checklist, { text: newItem.trim(), done: false }] }).then(() => setNewItem(""));
                        }
                    }}
                >
                    <input value=${newItem} placeholder="Add an item" onInput=${(event) => setNewItem(event.currentTarget.value)} />
                </form>
            </section>

            <section>
                <div class="pj-sec">Links</div>
                ${links.map(
                    (link) => html`<div class="pj-link">
                        <span class="muted small">${link.kind === "relates" ? "relates to" : link.direction === "out" ? "blocks" : "waits on"}</span>
                        <button class="link" onClick=${() => pocket.openSheet("task", { task: link.ref })}>${link.ref}</button>
                        <span class="pj-link-title">${link.title}</span>
                        <span class="pj-state-dot" style=${`--tone:${STATE[link.state].tone}`} title=${STATE[link.state].label}></span>
                        <button
                            class="pj-x"
                            aria-label="Remove the link"
                            onClick=${() =>
                                (link.direction === "out"
                                    ? pocket.api(`tasks/${ref}/links/${link.kind}/${link.ref}`, undefined, { method: "DELETE" })
                                    : pocket.api(`tasks/${link.ref}/links/${link.kind}/${ref}`, undefined, { method: "DELETE" })
                                ).then(load, failed)}
                        >
                            ×
                        </button>
                    </div>`,
                )}
                <form
                    class="pj-inline"
                    onSubmit=${(event) => {
                        event.preventDefault();

                        if (linkTo.trim() !== "") {
                            pocket.api(`tasks/${ref}/links`, { to: linkTo.trim().toUpperCase(), kind: linkKind }).then(() => {
                                setLinkTo("");
                                load();
                            }, failed);
                        }
                    }}
                >
                    <select value=${linkKind} onChange=${(event) => setLinkKind(event.currentTarget.value)}>
                        <option value="blocks">blocks</option>
                        <option value="relates">relates to</option>
                    </select>
                    <input value=${linkTo} placeholder=${`${project.key}-2`} onInput=${(event) => setLinkTo(event.currentTarget.value)} />
                    <button class="button small" disabled=${linkTo.trim() === ""}>Link</button>
                </form>
            </section>

            ${
                sessions.length > 0 &&
                html`<section>
                    <div class="pj-sec">Sessions</div>
                    ${sessions.map(
                        (session) => html`<a class="pj-session" href=${`/s/${session.conversationId}`} onClick=${() => close()}>
                            #${session.conversationId} <span class="muted small">${session.role === "worker" ? "worked on it" : session.role === "main" ? "leads it" : "mentions it"}</span>
                        </a>`,
                    )}
                </section>`
            }

            <section>
                <div class="pj-sec">Activity</div>
                <div class="pj-activity">
                    ${[
                        ...comments.map((each) => ({ at: each.createdAt, comment: each })),
                        ...activity.map((each) => ({ at: each.createdAt, event: each })),
                    ]
                        .sort((a, b) => a.at - b.at)
                        .map((entry) =>
                            entry.comment
                                ? html`<div class=${`pj-act comment ${entry.comment.author === "pi" ? "pi" : ""}`}>
                                      <span class="muted small">${entry.comment.authorName} · ${ago(entry.at)}</span>
                                      <div class="pj-md"><${Markdown} text=${entry.comment.text} /></div>
                                  </div>`
                                : html`<div class=${`pj-act ${entry.event.actor === "pi" ? "pi" : ""}`}>
                                      <span class="muted small">${entry.event.actorName} ${describe(entry.event)} · ${ago(entry.at)}</span>
                                  </div>`,
                        )}
                </div>
                <form
                    class="pj-comment"
                    onSubmit=${(event) => {
                        event.preventDefault();

                        if (comment.trim() !== "") {
                            pocket.api(`tasks/${ref}/comments`, { text: comment }).then(() => {
                                setComment("");
                                load();
                            }, failed);
                        }
                    }}
                >
                    <textarea rows="2" value=${comment} placeholder="Comment" onInput=${(event) => setComment(event.currentTarget.value)}></textarea>
                    <button class="button small" disabled=${comment.trim() === ""}>Comment</button>
                </form>
            </section>

            <button
                class="button ghost pj-delete"
                onClick=${() =>
                    confirm(`Delete ${task.ref} for good?`) &&
                    pocket.api(`tasks/${ref}`, undefined, { method: "DELETE" }).then(() => {
                        pocket.notify("info", `Deleted ${task.ref}.`);
                        close();
                    }, failed)}
            >
                Delete ${task.ref}
            </button>
        </div>`;
    }

    /** A task's run: its state, where, its session; Run now, Cancel, See diff, Merge (the person's). */
    function RunPanel({ task, project, reload, close }) {
        const [diff, setDiff] = useState(null);
        const [busy, setBusy] = useState(false);
        const run = task.run;
        const act = (work) => {
            setBusy(true);
            work()
                .then(reload, failed)
                .finally(() => setBusy(false));
        };
        const canRun = (!run || !ACTIVE.has(run.state)) && task.state !== "done" && task.type !== "epic";
        const branchReady = run && run.branch && !["queued", "starting", "running"].includes(run.state);

        if (!run && !canRun) {
            return null;
        }

        return html`<section class="pj-run" style=${run ? `--tone:${RUN[run.state][1]}` : ""}>
            <div class="pj-sec">Run</div>
            ${
                run
                    ? html`<div class="pj-run-row">
                          <span class="pj-run-state"><i></i>${RUN[run.state][0]}</span>
                          ${run.place && html`<span class="muted small" title=${run.place}>at ${shortFolder(run.place)}</span>`}
                          ${run.branch && html`<span class="pj-id">${run.branch}</span>`}
                          ${run.conversationId && html`<a class="small" href=${`/s/${run.conversationId}`} onClick=${() => close()}>Session #${run.conversationId}</a>`}
                      </div>
                      ${run.note && html`<p class="muted small">${run.note}</p>`}`
                    : html`<p class="muted small">${project.autoRuns ? "Give it to Pi and it runs by itself." : "Not run yet. Run now starts a task session in a git worktree, at the place with room."}</p>`
            }
            <div class="pj-run-actions">
                ${canRun && html`<button class="button small primary" disabled=${busy} onClick=${() => act(() => pocket.api(`tasks/${task.ref}/run`, {}))}>${run ? "Run again" : "Run now"}</button>`}
                ${run?.state === "queued" && html`<button class="button small" disabled=${busy} onClick=${() => act(() => pocket.api(`tasks/${task.ref}/run`, undefined, { method: "DELETE" }))}>Cancel</button>`}
                ${
                    branchReady &&
                    html`<button class="button small" disabled=${busy} onClick=${() => (diff === null ? pocket.api(`tasks/${task.ref}/diff`).then((answer) => setDiff(answer.diff || "No changes on this branch."), failed) : setDiff(null))}>
                        ${diff === null ? "See diff" : "Hide diff"}
                    </button>`
                }
                ${
                    branchReady &&
                    html`<button
                        class="button small"
                        disabled=${busy}
                        onClick=${() =>
                            confirm(`Merge ${run.branch} into ${run.base}? Its worktree and branch go after.`) &&
                            act(async () => {
                                await pocket.api(`tasks/${task.ref}/merge`, {});
                                pocket.notify("info", `Merged ${run.branch} into ${run.base}.`);
                            })}
                    >
                        Merge into ${run.base}
                    </button>`
                }
            </div>
            ${diff !== null && html`<pre class="pj-diff">${diff}</pre>`}
        </section>`;
    }

    /** An activity entry in words. */
    function describe(event) {
        if (event.kind === "created") {
            return `made it (${event.data.type}, ${STATE[event.data.state]?.label ?? event.data.state})`;
        }

        if (event.kind === "run") {
            return `run: ${RUN[event.data.state]?.[0] ?? event.data.state}${event.data.note ? ` (${event.data.note})` : ""}`;
        }

        if (event.kind === "linked" || event.kind === "unlinked") {
            return `${event.kind === "linked" ? "linked" : "unlinked"} ${event.data.kind} ${event.data.to}`;
        }

        const said = Object.entries(event.data).map(([field, value]) =>
            field === "state"
                ? `moved it to ${STATE[value]?.label ?? value}`
                : field === "assignee"
                  ? value === null
                      ? "unassigned it"
                      : `assigned it to ${value === "pi" ? "Pi" : (peopleCache?.find((person) => person.id === value)?.name ?? "someone")}`
                  : `changed ${field === "operatorReview" ? "approval" : field === "fixVerified" ? "fix verified" : field}`,
        );

        return said.join(", ");
    }

    /** The project's team: its main session, whether tasks given to Pi run by themselves, and where they run. */
    function TeamSettings({ project, places, lead, save, close }) {
        const [busy, setBusy] = useState(false);
        const setPlaces = (next) => save({ places: next });
        const addPlace = async () => {
            const chosen = await pocket.pickFolder({ start: project.folder || undefined, title: "Where its tasks run: the repository there" });

            if (chosen) {
                await setPlaces([...places.filter((place) => place.folder !== chosen), { folder: chosen, cap: 2 }]);
            }

            pocket.openSheet("project", { project: project.key });
        };

        return html`<div class="field">
            <span class="label">Team</span>
            <div class="pj-team">
                <div class="pj-team-row">
                    <div class="pj-grow">
                        <div>Main session</div>
                        <div class="muted small">Leads the project: plans, asks before runs, gets the task sessions' reports, reviews. It never writes code itself.</div>
                    </div>
                    ${
                        lead
                            ? html`<a class="button small" href=${`/s/${lead.session}`} onClick=${() => close()}>Open #${lead.session}</a>`
                            : html`<button
                                  class="button small primary"
                                  disabled=${busy || !project.folder}
                                  title=${project.folder ? "" : "Give the project a folder first"}
                                  onClick=${() => {
                                      setBusy(true);
                                      pocket
                                          .api(`projects/${project.key}/team`, {})
                                          .then((answer) => {
                                              pocket.notify("info", `Started the main session, #${answer.session}.`);
                                              pocket.openSheet("project", { project: project.key });
                                          }, failed)
                                          .finally(() => setBusy(false));
                                  }}
                              >
                                  Start it
                              </button>`
                    }
                </div>
                <div class="pj-team-row">
                    <div class="pj-grow">
                        <div>Runs by itself</div>
                        <div class="muted small">${project.autoRuns ? "A task given to Pi starts at once, where there is room." : "Off: the main session asks you before a task given to Pi runs."}</div>
                    </div>
                    <${Switch} on=${project.autoRuns} label="Run tasks given to Pi by themselves" onChange=${() => save({ autoRuns: !project.autoRuns })} />
                </div>
                <div class="pj-team-sub muted small">Where tasks run: each in a git worktree of the repository there, at most so many at once. A run goes to the place with the most room; when all are full, it waits.</div>
                ${places.map(
                    (place, index) => html`<div class="pj-team-row">
                        <div class="pj-grow pj-place" title=${place.folder}>${shortFolder(place.folder)}</div>
                        <div class="pj-stepper">
                            <button aria-label="Fewer at once" disabled=${place.cap <= 1} onClick=${() => setPlaces(places.map((each, at) => (at === index ? { ...each, cap: each.cap - 1 } : each)))}>−</button>
                            <span title="At once">${place.cap}</span>
                            <button aria-label="More at once" disabled=${place.cap >= 8} onClick=${() => setPlaces(places.map((each, at) => (at === index ? { ...each, cap: each.cap + 1 } : each)))}>+</button>
                        </div>
                        <button class="pj-x" aria-label="Remove this place" disabled=${places.length === 1 && project.places.length === 0} onClick=${() => setPlaces(places.filter((_each, at) => at !== index))}>×</button>
                    </div>`,
                )}
                ${places.length === 0 && html`<div class="muted small">Give the project a folder, or add a place.</div>`}
                <button class="button small" onClick=${addPlace}>Add a place</button>
            </div>
        </div>`;
    }

    function ProjectSheet({ project: key, close }) {
        const [project, setProject] = useState(null);
        const [team, setTeam] = useState({ places: [], lead: null });
        const people = usePeople();
        const me = pocket.me();
        const loadProject = () =>
            pocket.api(`projects/${key}`).then((answer) => {
                setProject(answer.project);
                setTeam({ places: answer.places, lead: answer.lead });
            }, failed);

        useEffect(() => {
            loadProject();
        }, [key]);

        if (project === null) {
            return html`<${Loader} label="Opening" />`;
        }

        const manage = me?.role === "owner" || me?.id === project.owner;
        const save = (body) => pocket.api(`projects/${key}`, body, { method: "PATCH" }).then(loadProject, failed);
        const share = (members) => pocket.api(`projects/${key}/members`, { members }, { method: "PUT" }).then(setProject, failed);

        return html`<div class="pj-form">
            <label class="field"><span class="label">Name</span><input value=${project.name} onChange=${(event) => save({ name: event.currentTarget.value })} /></label>
            <${FolderField}
                value=${project.folder ?? ""}
                onInput=${(value) => setProject({ ...project, folder: value })}
                reopen=${(chosen) =>
                    pocket
                        .api(`projects/${key}`, { folder: chosen || null }, { method: "PATCH" })
                        .catch(failed)
                        .finally(() => pocket.openSheet("project", { project: key }))}
            />
            <button class="button small" onClick=${() => save({ folder: project.folder || null })}>Save the folder</button>
            <${TeamSettings} project=${project} places=${team.places} lead=${team.lead} save=${save} close=${close} />
            <div class="field">
                <span class="label">Shared with</span>
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
                            <span>${person.name}</span><span class="muted small">${person.role === "viewer" ? "can view" : "can change"}</span>
                        </label>`,
                    )}
                ${people.filter((person) => person.role !== "owner" && person.id !== project.owner).length === 0 && html`<span class="muted small">Nobody else is in the app yet (Settings › People).</span>`}
            </div>
            ${
                manage &&
                html`<button
                    class="button ghost pj-delete"
                    onClick=${() =>
                        confirm(`Delete ${project.key} and all its tasks for good?`) &&
                        pocket.api(`projects/${key}`, undefined, { method: "DELETE" }).then(() => {
                            pocket.notify("info", `Deleted ${project.key}.`);
                            localStorage.removeItem(CURRENT);
                            close();
                        }, failed)}
                >
                    Delete ${project.key}
                </button>`
            }
        </div>`;
    }

    /** The session menu's "Board for this session": board mode here, and its project. */
    function BoardModeSheet({ close }) {
        const conversation = pocket.conversationId();
        const [mode, setMode] = useState(null);
        const [list, setList] = useState([]);

        useEffect(() => {
            if (conversation === null) {
                return;
            }

            pocket.api(`board-mode/${conversation}`).then(setMode, failed);
            pocket.api("projects").then((answer) => setList(answer.projects), failed);
        }, [conversation]);

        if (conversation === null) {
            return html`<p class="muted">Open a session first.</p>`;
        }

        if (mode === null) {
            return html`<${Loader} label="Opening" />`;
        }

        const set = (body) => pocket.api(`board-mode/${conversation}`, body, { method: "PUT" }).then(setMode, failed);

        return html`<div class="pj-form">
            <div class="pj-mode-row">
                <div>
                    <div>Track this session's work on a board</div>
                    <div class="muted small">
                        ${mode.on ? "Pi keeps its tasks current there." : mode.decided ? "Off: Pi works without the board and does not ask again." : "Off: Pi asks once when the work has several parts."}
                    </div>
                </div>
                <${Switch} on=${mode.on} label="Board mode" disabled=${!mode.on && list.length === 0 && mode.project === null} onChange=${() => set({ on: !mode.on, project: mode.project ?? list[0]?.key ?? null })} />
            </div>
            <label class="field"
                ><span class="label">Project</span
                ><select value=${mode.project ?? ""} onChange=${(event) => set({ on: mode.on, project: event.currentTarget.value || null })}>
                    <option value="">None</option>
                    ${list.map((project) => html`<option value=${project.key}>${project.key} · ${project.name}</option>`)}
                </select></label
            >
            ${list.length === 0 && html`<p class="muted small">No projects yet: make one on the Projects page.</p>`}
            <button class="button" onClick=${close}>Done</button>
        </div>`;
    }

    pocket.page({ id: "projects", title: "Projects", component: ProjectsPage, swipe: false });
    pocket.sheet({ id: "task", title: "Task", component: TaskSheet, wide: true });
    pocket.sheet({ id: "new-task", title: "New task", component: NewTaskSheet });
    pocket.sheet({ id: "new-project", title: "New project", component: NewProjectSheet });
    pocket.sheet({ id: "project", title: "Project settings", component: ProjectSheet });
    pocket.sheet({ id: "move", title: "Move to", component: MoveSheet });
    pocket.sheet({ id: "board-mode", title: "Board for this session", component: BoardModeSheet });
    pocket.rail({ id: "projects", title: "Projects", iconPath: BOARD, page: "projects" });
    pocket.launcher({
        id: "projects",
        label: "Projects",
        detail: "boards of tasks for you and Pi",
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
        const shown = () => (task === null ? document.querySelector(".pj-form") : document.querySelector(`.pj-task[data-task="${task}"]`));
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

    pocket.menu({ id: "board-mode", label: "Board for this session", hint: "track this work on a project board", sheet: "board-mode" });
}
