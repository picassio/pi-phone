/**
 * Skills & commands (PP-467, epic PP-464): the owner's library (`src/server/library.ts`) as a page in the conversation's
 * place, opened from Menu › Skills & commands or from the rail once kept there. Two tabs, Skills and Commands, with a
 * search; each item with its description, where it is pinned and its versions; editing in the app (SKILL.md and its
 * files, a command's template), version history with Undo and Restore, Delete on a card of its own, the "Every
 * session" switch, and pins to sessions and boards. The session menu's Skills & commands sheet pins items to that
 * session, and shows those its board or every session gives it as states.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { t, tn } from "./i18n.js";
import { loadTemplates } from "./commands.js";
import { api, attempt, closeSheet, notify, store } from "./store.js";
import { Choice, html, Icon, Loader, MultiChoice, railState, Sheet, StateTag, Switch, timeAgo } from "./ui.js";

/** The page slot's module name for the library: not an extension's. */
export const LIBRARY_PAGE = "library";
const TABS = ["skills", "commands"];
const kindOf = (tab) => (tab === "commands" ? "command" : "skill");

/** Open Skills & commands on a tab, in the conversation's place. */
export function openLibrary(tab = "skills") {
    store.set({ page: { module: LIBRARY_PAGE, id: TABS.includes(tab) ? tab : "skills" }, sheet: null, launcher: false, board: false, boardAgents: null, drawer: false });
}

const closePage = () => store.set({ page: null });

/** Keep Skills & commands on the rail, or take it off (the owner's; every device of theirs hears it). */
export const keepOnRail = (on) => attempt(() => api("me", { libraryOnRail: on }));

/** The owner's rail button for Skills & commands, once kept there. */
export function LibraryRailButton() {
    const { me, page } = store.state;

    if (me?.role !== "owner" || me.libraryOnRail !== true) {
        return null;
    }

    const open = page?.module === LIBRARY_PAGE;

    return html`<button
        class=${`rail-button rail-ext ${open ? "open" : ""}`}
        data-part="rail-button"
        data-rail="library"
        data-state=${railState(open)}
        title=${t("Skills & commands")}
        aria-label=${t("Skills & commands")}
        aria-pressed=${open}
        onClick=${() => (open ? closePage() : openLibrary())}
    >
        <${Icon} name="sparkle" size=${20} />
    </button>`;
}

/** Where an item is pinned, in words: every session, its sessions and its boards. */
function pinWords(pins) {
    const sessions = pins.filter((pin) => pin.scope === "session").length;
    const boards = pins.filter((pin) => pin.scope === "board").map((pin) => pin.target);

    return [sessions > 0 && tn(sessions, "{n} session", "{n} sessions"), boards.length > 0 && tn(boards.length, "board {names}", "boards {names}", { names: boards.join(", ") })]
        .filter(Boolean)
        .join(" · ");
}

/** One row of the list: its name, description, pins and versions. */
function ItemRow({ item, chosen, onPick }) {
    const every = item.pins.some((pin) => pin.scope === "all");
    const where = pinWords(item.pins);

    return html`<button class=${`lib-row ${chosen ? "on" : ""}`} data-part="library-item" data-name=${item.name} aria-current=${chosen ? "true" : undefined} onClick=${onPick}>
        <span class="lib-row-name">${item.kind === "command" ? `/${item.name}` : item.name}</span>
        <span class="lib-row-desc muted">${item.description}</span>
        <span class="lib-row-meta">
            ${every && html`<${StateTag} tone="ok" label=${t("Every session")} />`}
            ${where !== "" && html`<span class="muted">${where}</span>`}
            ${!every && where === "" && html`<${StateTag} tone="off" label=${t("Not pinned")} />`}
            <span class="muted">${tn(item.versions, "{n} version", "{n} versions")}</span>
        </span>
    </button>`;
}

/** Where the item is pinned, and the controls to pin it: every session, sessions, boards. */
function Pins({ item, boards, onPins }) {
    const sessions = store.state.sessions ?? [];
    const pin = (scope, target, pinned) =>
        attempt(async () => {
            const answer = await api(`library/${item.kind}/${item.name}/pins`, { scope, ...(target === undefined ? {} : { target }), pinned }, { method: "PUT" });

            onPins(answer.pins);
        });
    const every = item.pins.some((each) => each.scope === "all");
    const inSessions = item.pins.filter((each) => each.scope === "session");
    const onBoards = item.pins.filter((each) => each.scope === "board");
    const sessionOptions = sessions
        .filter((session) => session.kind !== "subagent" && !session.archived && !inSessions.some((each) => each.target === String(session.id)))
        .map((session) => ({ value: String(session.id), label: session.title ?? t("New session") }));
    const boardOptions = boards.filter((board) => !onBoards.some((each) => each.target === board.key)).map((board) => ({ value: board.key, label: board.name, detail: board.key }));
    const row = (each) => html`<div class="lib-pin" data-part="library-pin" data-scope=${each.scope} data-target=${each.target}>
        <span class="lib-pin-name">${each.gone ? html`<${StateTag} tone="off" label=${t("No longer there")} />` : (each.label ?? each.target)}</span>
        ${each.scope === "board" && html`<span class="muted">${each.target}</span>`}
        <button
            class="icon-button"
            title=${t("Unpin from {name}", { name: each.label ?? each.target })}
            aria-label=${t("Unpin from {name}", { name: each.label ?? each.target })}
            onClick=${() => pin(each.scope, each.target, false)}
        >
            <${Icon} name="close" size=${16} />
        </button>
    </div>`;

    return html`<section class="lib-section" data-part="library-pins">
        <h4 class="lib-heading">${t("Where it is pinned")}</h4>
        <div class="sheet-list">
            <div class="provider toggle lib-every">
                <div>
                    <div>${t("Every session")}</div>
                    <div class="muted small">${t("Every session of yours has it, from its next message.")}</div>
                </div>
                <${Switch} on=${every} label=${t("Every session")} onChange=${() => pin("all", undefined, !every)} />
            </div>
        </div>
        <div class="lib-pins">
            <div class="field">
                <span class="label">${t("Sessions")}</span>
                ${inSessions.map(row)}
                <${MultiChoice}
                    label=${t("Pin to sessions")}
                    placeholder=${t("Pin to sessions…")}
                    options=${sessionOptions}
                    disabled=${sessionOptions.length === 0}
                    onAdd=${(ids) => attempt(async () => {
                        let pins = item.pins;

                        for (const id of ids) {
                            pins = (await api(`library/${item.kind}/${item.name}/pins`, { scope: "session", target: id, pinned: true }, { method: "PUT" })).pins;
                        }

                        onPins(pins);
                    })}
                />
            </div>
            <div class="field">
                <span class="label">${t("Boards")}</span>
                ${onBoards.map(row)}
                ${
                    boards.length === 0
                        ? html`<span class="muted small">${t("No boards yet.")}</span>`
                        : html`<${Choice}
                              label=${t("Pin to a board")}
                              placeholder=${t("Pin to a board…")}
                              value=${null}
                              options=${boardOptions}
                              disabled=${boardOptions.length === 0}
                              onChange=${(key) => pin("board", key, true)}
                          />`
                }
            </div>
        </div>
    </section>`;
}

/** The current files, edited in the app: a skill's files one at a time, a command's template. */
function Editor({ item, files, onSaved }) {
    const [draft, setDraft] = useState(files);
    const [file, setFile] = useState(item.kind === "skill" ? "SKILL.md" : `${item.name}.md`);
    const [note, setNote] = useState("");
    const [adding, setAdding] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setDraft(files);
        setFile(item.kind === "skill" ? "SKILL.md" : `${item.name}.md`);
        setNote("");
    }, [files]);

    const changed = JSON.stringify(draft) !== JSON.stringify(files);
    const paths = Object.keys(draft).sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
    const save = () =>
        attempt(async () => {
            setSaving(true);

            try {
                const body = item.kind === "skill" ? { files: draft, note } : { content: draft[`${item.name}.md`], note };

                const saved = (await api(`library/${item.kind}/${item.name}`, body, { method: "PUT" })).item;

                onSaved(saved);
                notify("info", t("Saved as version {n}.", { n: saved.version }));
            } finally {
                setSaving(false);
            }
        });
    const addFile = (event) => {
        event.preventDefault();

        const path = adding.trim();

        if (path === "" || draft[path] !== undefined) {
            return;
        }

        setDraft({ ...draft, [path]: "" });
        setFile(path);
        setAdding(null);
    };

    return html`<section class="lib-section" data-part="library-editor">
        <h4 class="lib-heading">${item.kind === "skill" ? t("Files") : t("Template")}</h4>
        ${
            item.kind === "skill" &&
            html`<div class="lib-files">
                <${Choice} label=${t("File")} value=${file} options=${paths.map((path) => ({ value: path, label: path }))} onChange=${setFile} />
                ${
                    adding === null
                        ? html`<button class="button small ghost" data-part="library-add-file" onClick=${() => setAdding("")}><${Icon} name="plus" size=${16} />${t("Add a file")}</button>`
                        : html`<form class="lib-add-file" onSubmit=${addFile}>
                              <input value=${adding} placeholder="scripts/check.sh" aria-label=${t("The new file's path")} autofocus onInput=${(event) => setAdding(event.currentTarget.value)} />
                              <button class="button small primary">${t("Add")}</button>
                              <button type="button" class="button small ghost" onClick=${() => setAdding(null)}>${t("Cancel")}</button>
                          </form>`
                }
                ${
                    file !== "SKILL.md" &&
                    html`<button
                        class="button small ghost"
                        onClick=${() => {
                            const { [file]: _gone, ...rest } = draft;

                            setDraft(rest);
                            setFile("SKILL.md");
                        }}
                    >
                        ${t("Remove this file")}
                    </button>`
                }
            </div>`
        }
        <textarea
            class="lib-text mono"
            data-part="library-text"
            spellcheck="false"
            aria-label=${t("{file}'s text", { file })}
            value=${draft[file] ?? ""}
            onInput=${(event) => setDraft({ ...draft, [file]: event.currentTarget.value })}
        ></textarea>
        <div class="lib-save">
            <input value=${note} placeholder=${t("What changed (optional)")} aria-label=${t("What changed")} maxlength="200" onInput=${(event) => setNote(event.currentTarget.value)} />
            <button class="button small ghost" disabled=${!changed} onClick=${() => setDraft(files)}>${t("Discard")}</button>
            <button class="button small primary" data-part="library-save" disabled=${!changed || saving} onClick=${save}>${t("Save")}</button>
        </div>
    </section>`;
}

/** The kept versions, newest first: Undo goes back one, Restore makes any of them current. */
function Versions({ item, revision, onChanged }) {
    const [view, setView] = useState(null);

    useEffect(() => {
        attempt(async () => setView(await api(`library/${item.kind}/${item.name}/versions`)));
    }, [item.name, item.kind, revision]);

    if (view === null) {
        return html`<${Loader} label=${t("Loading versions")} />`;
    }

    const older = view.versions.some((version) => version.n < view.current);
    const act = (path, body) => attempt(async () => onChanged((await api(`library/${item.kind}/${item.name}/${path}`, body)).item));

    return html`<section class="lib-section" data-part="library-versions">
        <div class="lib-section-head">
            <h4 class="lib-heading">${t("Versions")}</h4>
            <button class="button small ghost" data-part="library-undo" disabled=${!older} onClick=${() => act("undo", {})}>
                <${Icon} name="undo" size=${16} />${t("Undo")}
            </button>
        </div>
        <div class="sheet-list">
            ${view.versions.map(
                (version) => html`<div class="provider lib-version" data-part="library-version" data-n=${version.n}>
                    <div>
                        <div>${t("Version {n}", { n: version.n })} ${version.n === view.current && html`<${StateTag} tone="ok" label=${t("Current")} />`}</div>
                        <div class="muted small">${[timeAgo(version.at), version.note].filter(Boolean).join(" · ")}</div>
                    </div>
                    ${version.n !== view.current && html`<button class="button small ghost" onClick=${() => act("restore", { n: version.n })}>${t("Restore")}</button>`}
                </div>`,
            )}
        </div>
    </section>`;
}

/** Delete, asked on a card of its own: the item, its versions and its pins go. */
function Delete({ item, onDeleted }) {
    const [asking, setAsking] = useState(false);

    if (!asking) {
        return html`<button class="button small ghost lib-delete" data-part="library-delete" onClick=${() => setAsking(true)}>${t("Delete")}</button>`;
    }

    return html`<div class="lib-confirm" role="alertdialog" aria-label=${t("Delete {name}?", { name: item.name })} data-part="library-delete-card">
        <div>${t("Delete {name}?", { name: item.name })}</div>
        <div class="muted small">${t("Its versions and pins go too. Sessions that have it lose it from their next message.")}</div>
        <div class="sheet-actions">
            <button class="button small ghost" onClick=${() => setAsking(false)}>${t("Keep it")}</button>
            <button
                class="button small danger"
                data-part="library-delete-confirm"
                onClick=${() =>
                    attempt(async () => {
                        await api(`library/${item.kind}/${item.name}`, undefined, { method: "DELETE" });
                        notify("info", t("Deleted {name}.", { name: item.name }));
                        onDeleted();
                    })}
            >
                ${t("Delete for good")}
            </button>
        </div>
    </div>`;
}

/** One item: its pins, its editor, its versions, and Delete. */
function Detail({ item, boards, onItem, onDeleted, onBack }) {
    const [files, setFiles] = useState(null);
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        setFiles(null);
        attempt(async () => {
            const answer = await api(`library/${item.kind}/${item.name}`);

            setFiles(answer.files ?? { [`${item.name}.md`]: answer.content });
        });
    }, [item.kind, item.name, item.version]);

    const changed = (next) => {
        onItem(next);
        setRevision((value) => value + 1);
    };

    return html`<div class="lib-detail" data-part="library-detail">
        <div class="lib-detail-head">
            <button class="icon-button lib-back" title=${t("Back to the list")} aria-label=${t("Back to the list")} onClick=${onBack}>
                <${Icon} name="back" size=${20} />
            </button>
            <div class="lib-detail-title">
                <h3>${item.kind === "command" ? `/${item.name}` : item.name}</h3>
                <div class="muted small">${t("Version {n} of {count}", { n: item.version, count: item.versions })}${item.argumentHint ? ` · ${item.argumentHint}` : ""}</div>
            </div>
            <${Delete} item=${item} onDeleted=${onDeleted} />
        </div>
        <p class="lib-description">${item.description}</p>
        <${Pins} item=${item} boards=${boards} onPins=${(pins) => onItem({ ...item, pins })} />
        ${files === null ? html`<${Loader} label=${t("Loading files")} />` : html`<${Editor} item=${item} files=${files} onSaved=${changed} />`}
        <${Versions} item=${item} revision=${revision} onChanged=${changed} />
    </div>`;
}

/** A new skill or command: its name, description, and first text; saved as version 1. */
function NewItem({ kind, onMade, onCancel }) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [hint, setHint] = useState("");
    const [body, setBody] = useState("");
    const quote = (text) => JSON.stringify(text.trim());
    const make = (event) => {
        event.preventDefault();
        attempt(async () => {
            const front = kind === "skill" ? `name: ${name.trim()}\ndescription: ${quote(description)}` : `description: ${quote(description)}${hint.trim() === "" ? "" : `\nargument-hint: ${quote(hint)}`}`;
            const text = `---\n${front}\n---\n\n${body.trim()}\n`;
            const answer = await api(`library/${kind}/${name.trim()}`, kind === "skill" ? { files: { "SKILL.md": text }, note: t("Made") } : { content: text, note: t("Made") }, { method: "PUT" });

            onMade(answer.item);
        });
    };

    return html`<form class="lib-detail lib-new" data-part="library-new" onSubmit=${make}>
        <h3>${kind === "skill" ? t("New skill") : t("New command")}</h3>
        <label class="field">
            <span class="label">${t("Name")}</span>
            <input value=${name} required placeholder=${kind === "skill" ? "ssp-notes" : "ssp-review"} autofocus onInput=${(event) => setName(event.currentTarget.value)} />
            <span class="muted small">${t("Lowercase letters, digits and single hyphens.")}</span>
        </label>
        <label class="field">
            <span class="label">${t("Description")}</span>
            <input value=${description} required onInput=${(event) => setDescription(event.currentTarget.value)} />
            <span class="muted small">${kind === "skill" ? t("What it does and when Pi should use it: Pi picks skills by this.") : t("Shown beside it in the / list.")}</span>
        </label>
        ${
            kind === "command" &&
            html`<label class="field">
                <span class="label">${t("Argument hint")}</span>
                <input value=${hint} placeholder="<task> [focus]" onInput=${(event) => setHint(event.currentTarget.value)} />
            </label>`
        }
        <label class="field">
            <span class="label">${kind === "skill" ? t("Instructions") : t("Template")}</span>
            <textarea class="lib-text mono" required value=${body} onInput=${(event) => setBody(event.currentTarget.value)}></textarea>
            ${kind === "command" && html`<span class="muted small">${t("$ARGUMENTS is what follows the name; $1, $2 are its words.")}</span>`}
        </label>
        <div class="sheet-actions">
            <button type="button" class="button small ghost" onClick=${onCancel}>${t("Cancel")}</button>
            <button class="button small primary" data-part="library-make">${kind === "skill" ? t("Save the skill") : t("Save the command")}</button>
        </div>
    </form>`;
}

/** The page: tabs, search, the list, and the item chosen (or a new one). */
export function LibraryPage({ tab }) {
    const [items, setItems] = useState(null);
    const [boards, setBoards] = useState([]);
    const [query, setQuery] = useState("");
    const [chosen, setChosen] = useState(null);
    const [making, setMaking] = useState(false);
    const kind = kindOf(tab);
    const onRail = store.state.me?.libraryOnRail === true;

    useBack(true, closePage);

    const load = () => attempt(async () => setItems((await api("library")).items));

    useEffect(() => {
        load();

        if (store.state.server?.extensions?.includes("pocket-projects")) {
            attempt(async () => setBoards((await api("x/projects/projects")).projects.map(({ key, name }) => ({ key, name }))));
        }
    }, []);

    useEffect(() => {
        setChosen(null);
        setMaking(false);
    }, [tab]);

    const shown = useMemo(() => {
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

        return (items ?? []).filter((item) => item.kind === kind && words.every((word) => `${item.name} ${item.description}`.toLowerCase().includes(word)));
    }, [items, query, kind]);
    const count = (of) => (items ?? []).filter((item) => item.kind === of).length;
    const item = items?.find((each) => each.kind === kind && each.name === chosen);
    const replace = (next) => setItems(items.map((each) => (each.kind === next.kind && each.name === next.name ? next : each)));
    const open = item !== undefined || making;

    return html`<section class="ext-page lib-page" data-part="library-page" aria-label=${t("Skills & commands")}>
        <header class="board-head">
            <div class="board-title">
                <h2>${t("Skills & commands")}</h2>
                <div class="board-sub">${t("Yours, seen only where you pin them")}</div>
            </div>
            <button
                class="button small ghost"
                data-part="library-keep"
                aria-label=${onRail ? t("Remove from the rail") : t("Keep on the rail")}
                title=${onRail ? t("Remove from the rail") : t("Keep on the rail")}
                onClick=${() => keepOnRail(!onRail)}
            >
                <${Icon} name="pin" size=${16} /><span class="lib-keep-words">${onRail ? t("Remove from the rail") : t("Keep on the rail")}</span>
            </button>
            <button class="icon-button" title=${t("Back to the conversation (Esc)")} aria-label=${t("Close")} onClick=${closePage}>
                <${Icon} name="close" />
            </button>
        </header>
        <div class="ext-page-body lib-body">
            ${
                items === null
                    ? html`<${Loader} label=${t("Loading the library")} />`
                    : html`<div class=${`lib-layout ${open ? "open" : ""}`}>
                          <div class="lib-side">
                              <div class="segmented lib-tabs" role="tablist">
                                  ${TABS.map(
                                      (each) => html`<button
                                          role="tab"
                                          class=${each === tab ? "on" : ""}
                                          aria-selected=${each === tab}
                                          data-part="library-tab"
                                          data-tab=${each}
                                          onClick=${() => openLibrary(each)}
                                      >
                                          ${each === "skills" ? t("Skills · {n}", { n: count("skill") }) : t("Commands · {n}", { n: count("command") })}
                                      </button>`,
                                  )}
                              </div>
                              <div class="lib-tools">
                                  <label class="search">
                                      <${Icon} name="search" size=${16} />
                                      <input value=${query} placeholder=${t("Search")} aria-label=${t("Search the library")} onInput=${(event) => setQuery(event.currentTarget.value)} />
                                  </label>
                                  <button
                                      class="button small primary"
                                      data-part="library-new-button"
                                      onClick=${() => {
                                          setChosen(null);
                                          setMaking(true);
                                      }}
                                  >
                                      <${Icon} name="plus" size=${16} />${kind === "skill" ? t("New skill") : t("New command")}
                                  </button>
                              </div>
                              <div class="lib-list" data-part="library-list">
                                  ${shown.map(
                                      (each) => html`<${ItemRow}
                                          key=${each.name}
                                          item=${each}
                                          chosen=${each.name === chosen}
                                          onPick=${() => {
                                              setMaking(false);
                                              setChosen(each.name);
                                          }}
                                      />`,
                                  )}
                                  ${
                                      shown.length === 0 &&
                                      html`<p class="muted small lib-empty">
                                          ${
                                              query.trim() !== ""
                                                  ? t("Nothing matches.")
                                                  : kind === "skill"
                                                    ? t("No skills yet. Make one here, or ask Pi to make one from what you did in a session.")
                                                    : t("No commands yet. A command is a message you send often, with $ARGUMENTS for what you type after it.")
                                          }
                                      </p>`
                                  }
                              </div>
                          </div>
                          ${
                              making
                                  ? html`<${NewItem}
                                        key=${kind}
                                        kind=${kind}
                                        onCancel=${() => setMaking(false)}
                                        onMade=${(made) => {
                                            setItems([...items, made]);
                                            setMaking(false);
                                            setChosen(made.name);
                                        }}
                                    />`
                                  : item
                                    ? html`<${Detail}
                                          key=${`${item.kind}:${item.name}`}
                                          item=${item}
                                          boards=${boards}
                                          onItem=${replace}
                                          onBack=${() => setChosen(null)}
                                          onDeleted=${() => {
                                              setItems(items.filter((each) => !(each.kind === item.kind && each.name === item.name)));
                                              setChosen(null);
                                          }}
                                      />`
                                    : html`<div class="lib-detail lib-none muted">${t("Choose one to see where it is pinned, edit it, or go back to an older version.")}</div>`
                          }
                      </div>`
            }
        </div>
    </section>`;
}

/**
 * The session menu's Skills & commands: a switch per library item pins it to this session; what its board or every
 * session gives it shows as a state.
 */
export function LibrarySessionSheet({ id }) {
    const [items, setItems] = useState(null);
    const [board, setBoard] = useState(null);

    const load = () =>
        attempt(async () => {
            const [all, here] = await Promise.all([api("library"), api(`c/${id}/library`)]);

            setItems(all.items);
            setBoard(here.board);
        });

    useEffect(() => {
        // Opened by link, the session may not be open yet.
        if (id !== null && id !== undefined) {
            load();
        }
    }, [id]);

    const toggle = (item, pinned) =>
        attempt(async () => {
            const answer = await api(`library/${item.kind}/${item.name}/pins`, { scope: "session", target: String(id), pinned }, { method: "PUT" });

            setItems(items.map((each) => (each === item ? { ...item, pins: answer.pins } : each)));
            // The / list asks again: a pinned command shows there now.
            store.set({ templates: null });
            loadTemplates();
        });
    const group = (kind) => {
        const list = (items ?? []).filter((item) => item.kind === kind);

        if (list.length === 0) {
            return null;
        }

        return html`<h3 class="lib-heading lib-group">${kind === "skill" ? t("Skills") : t("Commands")}</h3>
            <div class="sheet-list">
                ${list.map((item) => {
                    const here = item.pins.some((pin) => pin.scope === "session" && pin.target === String(id));
                    const fromBoard = board !== null && item.pins.some((pin) => pin.scope === "board" && pin.target === board);
                    const every = item.pins.some((pin) => pin.scope === "all");
                    const name = item.kind === "command" ? `/${item.name}` : item.name;

                    return html`<div class="provider toggle" data-part="library-session-item" data-name=${item.name}>
                        <div>
                            <div>
                                ${name} ${fromBoard && html`<${StateTag} tone="ok" label=${t("From board {key}", { key: board })} />`}
                                ${every && html`<${StateTag} tone="ok" label=${t("Every session")} />`}
                            </div>
                            <div class="muted small">${item.description}</div>
                        </div>
                        <${Switch} on=${here} label=${t("Pin {name} to this session", { name })} onChange=${() => toggle(item, !here)} />
                    </div>`;
                })}
            </div>`;
    };

    return html`<${Sheet} title=${t("Skills & commands")} onClose=${closeSheet}>
        <p class="muted small">${t("Pin your own skills and commands to this session. Pi has a skill from your next message; a command shows in the / list.")}</p>
        ${items === null && html`<${Loader} label=${t("Loading the library")} />`}
        ${items !== null && items.length === 0 && html`<p class="muted small">${t("Your library is empty: make a skill or command in Skills & commands, or ask Pi to.")}</p>`}
        ${items !== null && group("skill")}
        ${items !== null && group("command")}
        <div class="sheet-actions">
            <button class="button small ghost" data-part="open-library" onClick=${() => openLibrary()}>${t("Open Skills & commands")}</button>
        </div>
    <//>`;
}
