// Pi Pocket web app. No build step: edit a file under web/ and every open browser reloads.
import { t, tn } from "./i18n.js";
import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { folderColor } from "./avatar.js";
import { machineNameOf, splitPlace } from "./place.js";
import { canGoBack, goBack, replaceAddress, startHistory, useBack } from "./back.js";
import { PeopleButton, PeoplePanel } from "./chat.js";
import { Composer, openingByAlt } from "./composer.js";
import { useChanges } from "./diff.js";
import {
    FilesButton,
    FilesPanel,
    filesAvailable,
    setFilesOpen,
    toggleFiles,
} from "./files-panel.js";
import { BrowserButton, BrowserPanel, BrowserPreview, BrowserWatcher, browserShown } from "./browser-panel.js";
import { ComputerButton, ComputerPanel, ComputerPreview, ComputerWatcher, computerShown } from "./computer-panel.js";
import { voiceShown } from "./voice-call.js";
import { VoicePanel } from "./voice-view.js";
import { ExtensionPage, openPageWhenReady, openSheetWhenReady } from "./extension-ui.js";
import { GATEWAY_PAGE, GatewayPage } from "./gateway-panel.js";
import { startEdgeBack, startSwipes, useDragToClose } from "./gestures.js";
import { Splash } from "./home.js";
import { UsageMeter } from "./usage.js";
import { Launcher } from "./launcher.js";
import {
    PEEK_WIDE,
    PeekHost,
    PeeksButton,
    PeekStrip,
    peekTiles,
    peeksWanted,
    togglePeeks,
} from "./peeks.js";
import { Drawer, RailNav, ResizeHandle, SessionList, toSessions } from "./sessions.js";
// Loaded for what it does: it gives replies' Markdown the component for pages, images, and diffs in code blocks.
import "./rich.js";
import { Sheets } from "./sheets.js";
import { branchAvailable, headLabel } from "./sheets/branch.js";
import { SignIn } from "./signin.js";
import { openSubagents } from "./subagents.js";
import { SubagentsBoard } from "./subagents-board.js";
import {
    actions,
    attempt,
    canSteer,
    dismiss,
    filesShown,
    holdNotice,
    loadUsage,
    navigate,
    notify,
    openSheet,
    panelsBeside,
    peopleDocked,
    scoped,
    start,
    store,
    workspaceOrder,
} from "./store.js";
import { prefs, setPrefs, startTheme } from "./theme.js";
import { Transcript } from "./transcript.js";
import { installAndroidSpeech } from "./android-speech.js";
import { ASSIST, AssistView, rememberLastSession } from "./assist.js";
import { installAppUpdates } from "./sheets/update.js";
import { toggleDictation } from "./voice.js";
import {
    APPLE,
    Boot,
    BOTTOM_SHEETS,
    html,
    Icon,
    iconPath,
    shortPath,
    useEdge,
    usePresence,
    WIDE,
} from "./ui.js";

/** What changed in the session's folder: lines added and removed, and how many files. It opens Changes. */
function ChangesButton() {
    const { changes } = useChanges();
    // Outside a repository Pi's edits are all there is to review (in one, they are what was committed since).
    const files = [...(changes?.files ?? []), ...(changes?.repo ? [] : (changes?.piOnly ?? []))];

    if (files.length === 0) {
        return null;
    }

    // Git counts the lines of changed files, not of new or binary ones: each side shows when it has some.
    const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
    const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
    const lines = added > 0 || removed > 0;
    const count = files.length + (changes.more ?? 0);
    const counted = `${count} ${count === 1 ? "file" : "files"}`;

    return html`<button
        class="changes-button"
        title=${t("Uncommitted changes in this session's folder")}
        aria-label=${`Changes: ${counted}${lines ? `, ${added} lines added and ${removed} removed` : ""}`}
        onClick=${() => setFilesOpen(true, "changes")}
    >
        ${added > 0 && html`<span class="added">+${added}</span>`}
        ${removed > 0 && html`<span class="removed">−${removed}</span>`}
        <span class=${lines ? "changes-files" : ""}>${counted}</span>
    </button>`;
}

/**
 * The plan usage of the session's account, in the top bar (web/usage.js): asked once when a session on a subscription
 * account opens without figures; runs on it bring new ones.
 */
function SessionUsage({ provider }) {
    useEffect(() => {
        if (provider !== undefined && store.state.usage[provider] === undefined) {
            void loadUsage();
        }
    }, [provider]);

    return provider === undefined ? null : html`<${UsageMeter} provider=${provider} />`;
}

function Topbar() {
    const { view, server, conversationId } = store.state;
    const conversation = view.conversation;
    const artifacts = view.artifacts?.length ?? 0;
    const cwd = view.agent?.cwd ?? conversation?.cwd;
    // On a machine (place.js): the machine's name, then the folder's.
    const machine = machineNameOf(cwd);
    const folderName = String(splitPlace(cwd ?? "").path ?? "")
        .replace(/\/+$/, "")
        .split("/")
        .pop();
    const folder = machine === undefined ? folderName : `${machine}: ${folderName}`;
    const branch = headLabel(view.branch) || conversation?.worktree?.branch;
    const { sessions } = store.state;
    // Both read every session: again only when the list changes, not on each word Pi streams.
    const listed = useMemo(
        () => sessions.find((session) => session.id === conversationId)?.title,
        [sessions, conversationId],
    );
    const title =
        conversation?.title ??
        listed ??
        (store.state.missing ? t("Not found") : t("Loading…"));
    const busySubagents = (view.subagents ?? []).filter((agent) => agent.busy).length;
    // Other sessions waiting for an approval, counted on the way back to them.
    const waiting = useMemo(
        () =>
            sessions.filter(
                (session) => session.waiting && !session.archived && session.id !== conversationId,
            ).length,
        [sessions, conversationId],
    );
    // How far down it reaches: PiP's window on a short wide screen stops below its buttons.
    const edge = useEdge("--topbar-h", (rect) => rect.bottom);

    return html`<header class="topbar" data-part="topbar" ref=${edge}>
        <button
            class="icon-button badge-host topbar-back"
            aria-label=${waiting > 0 ? t("Back to sessions, {n} waiting for you", { n: waiting }) : t("Back to sessions")}
            title=${t("Sessions")}
            onClick=${toSessions}
        >
            <${Icon} name="back" size=${22} />
            ${waiting > 0 && html`<span class="badge warn">${waiting}</span>`}
        </button>
        <div class="title">
            <button
                class="title-open"
                aria-label=${folder ? t("{title}, in {folder}: session menu", { title, folder }) : t("{title}: session menu", { title })}
                title=${cwd ? `${shortPath(cwd, server?.home)}\n${t("Session menu")}` : t("Session menu")}
                disabled=${!conversation}
                onClick=${() => openSheet({ type: "menu" })}
            ></button>
            <span class="title-main" data-part="topbar-title" aria-hidden="true">${title}</span>
            <span class="title-sub" data-part="topbar-sub">
                ${
                    folder &&
                    html`<span
                        class="folder-mark"
                        style=${`--folder:${folderColor(cwd)}`}
                        aria-hidden="true"
                    ></span>`
                }
                ${
                    conversation?.kind === "subagent"
                        ? html`<span class="title-folder title-parent">
                              ${t("subagent of {title}", { title: conversation.parent?.title ?? "?" })}
                          </span>`
                        : html`${
                              folder &&
                              html`<span class="title-folder" aria-hidden="true">${folder}</span>`
                          }
                          ${
                              branch &&
                              (branchAvailable()
                                  ? html`<button
                                        class="title-branch"
                                        aria-label=${view.branch?.detached ? t("No branch, at {branch}: switch to one", { branch }) : t("Branch {branch}: switch or make a branch", { branch })}
                                        title=${view.branch?.detached ? t("No branch: switch to one") : t("Switch or make a branch")}
                                        onClick=${() => openSheet({ type: "branch" })}
                                    >
                                        <${Icon} name="fork" size=${10} /><span class="title-branch-name">${branch}</span>
                                    </button>`
                                  : html`<span class="title-branch" title=${t("The git branch")}>
                                        <${Icon} name="fork" size=${10} /><span class="title-branch-name">${branch}</span>
                                    </span>`)
                          }
                          ${
                              conversation?.worktree &&
                              html`<span class="title-worktree" aria-hidden="true">${t("worktree")}</span>`
                          }`
                }
            </span>
        </div>
        <${SessionUsage} key=${conversationId} provider=${view.agent?.model?.provider} />
        ${
            busySubagents > 0 &&
            html`<button
                class="icon-button"
                aria-label=${`Subagents: ${busySubagents} working`}
                title=${t("Subagents working")}
                onClick=${openSubagents}
            >
                <span class="pulse"></span>
                <span class="count">${busySubagents}</span>
            </button>`
        }
        ${filesAvailable() && html`<${ChangesButton} key=${conversationId} />`}
        <${PeeksButton} />
        <${BrowserButton} />
        <${ComputerButton} />
        <${FilesButton} />
        <button
            class=${`icon-button badge-host ${artifacts > 0 ? "quiet-phone" : "quiet"}`}
            aria-label=${t("Artifacts")}
            title=${t("Artifacts")}
            onClick=${() => openSheet({ type: "artifacts" })}
        >
            <${Icon} name="artifact" />
            ${artifacts > 0 && html`<span class="badge">${artifacts}</span>`}
        </button>
        <${PeopleButton} />
        <button
            class="icon-button"
            aria-label=${t("Menu")}
            title=${t("Menu")}
            aria-haspopup="dialog"
            aria-expanded=${store.state.sheet?.type === "menu"}
            onClick=${() => openSheet({ type: "menu" })}
        >
            <${Icon} name="more" />
        </button>
    </header>`;
}

/**
 * A notice, as a small tile: a state square in its level's color, the message, and a countdown line until it goes. A
 * tap dismisses it, or does what it offers (a chevron says so); on a phone, a swipe up puts it away.
 */
function Notice({ notice, leaving }) {
    const ref = useRef(null);
    const [pointed, setPointed] = useState(false);
    const [focused, setFocused] = useState(false);
    const held = (pointed || focused) && !leaving;

    // Its countdown, and the line that shows it, wait while it is being read or reached for.
    useEffect(() => holdNotice(notice.id, held), [held]);

    useDragToClose(ref, {
        dir: "up",
        onClose: () => dismiss(notice.id),
        enabled: BOTTOM_SHEETS.matches,
        // It fades as it goes, not the stack behind it.
        scrim: ref,
    });

    return html`<button
        ref=${ref}
        class=${`notice ${notice.level} ${notice.action ? "acts" : ""} ${held ? "held" : ""} ${leaving ? "leaving" : ""}`}
        data-part="notice"
        style=${`--life:${notice.life ?? 4500}ms`}
        onPointerEnter=${() => setPointed(true)}
        onPointerLeave=${() => setPointed(false)}
        onFocus=${() => setFocused(true)}
        onBlur=${() => setFocused(false)}
        onClick=${() => {
            dismiss(notice.id);
            notice.action?.();
        }}
    >
        <span class="notice-mark" aria-hidden="true"></span>
        <span class="notice-text">${notice.message}</span>
        <${Icon} name=${notice.action ? "chevron" : "close"} size=${14} />
    </button>`;
}

/** Notices: each slides in, counts down, and slides out when it goes. */
function Notices() {
    const { notices } = store.state;
    const [gone, setGone] = useState([]);
    const before = useRef(notices);

    useEffect(() => {
        const removed = before.current.filter(
            (notice) => !notices.some((each) => each.id === notice.id),
        );

        before.current = notices;

        if (removed.length === 0) {
            return;
        }

        setGone((list) => [...list, ...removed]);
        setTimeout(
            () => setGone((list) => list.filter((notice) => !removed.includes(notice))),
            160,
        );
    }, [notices]);
    const all = [
        ...notices,
        ...gone.filter((notice) => !notices.some((each) => each.id === notice.id)),
    ].sort((a, b) => a.id - b.id);

    if (all.length === 0) {
        return null;
    }

    return html`<div class="notices" data-part="notices" role="status" aria-live="polite">
        ${all.map(
            (notice) =>
                html`<${Notice}
                    key=${notice.id}
                    notice=${notice}
                    leaving=${!notices.includes(notice)}
                />`,
        )}
    </div>`;
}

/** The launcher, kept on screen a moment after it closes so it can fade out. */
function LauncherHost() {
    const [opening, setOpening] = useState({ n: 0, returnTo: document.activeElement });
    const wasOpen = useRef(Boolean(store.state.launcher));

    // Observe logical openings before batched renders: even a close/reopen in one task gets a fresh launcher.
    // Issue #62, reported by @arunsathiya: a retained, inert launcher must not reopen without its input focused.
    useLayoutEffect(
        () =>
            store.subscribe((state) => {
                const next = Boolean(state.launcher);

                if (next && !wasOpen.current) {
                    const target = document.activeElement;

                    setOpening((previous) => ({
                        n: previous.n + 1,
                        returnTo:
                            target === document.body || target?.closest(".launcher-overlay")
                                ? previous.returnTo
                                : target,
                    }));
                }

                wasOpen.current = next;
            }),
        [],
    );

    const [open, leaving] = usePresence(store.state.launcher ? opening : null, 150);

    useBack(Boolean(store.state.launcher), () => store.set({ launcher: false }));

    return open
        ? html`<${Launcher} key=${open.n} leaving=${leaving} returnTo=${open.returnTo} />`
        : null;
}

/**
 * The People panel, kept on screen a moment after it closes so it can slide out. Not when the Browser panel or the Files
 * tile takes its place.
 */
function PeopleHost({ shown, replaced }) {
    const [kept, leaving] = usePresence(shown || null, 180);

    if (kept === null || (leaving && replaced)) {
        return null;
    }

    return html`<${PeoplePanel} leaving=${leaving} />`;
}

/**
 * The Browser panel or the Files tile. Where it covers the conversation it is a screen pushed over it, kept a moment
 * after it closes so it can slide away; beside the conversation it goes at once.
 */
function PanelHost({ shown, panel }) {
    const [kept, leaving] = usePresence(shown || null, 240);
    const covering = shown && !panelsBeside();

    // Over the conversation, keys go to the panel (a dialog then, with Tab kept in it), unless something in it already
    // took them; when it goes, they go back to what had them before, unless something else took them meanwhile.
    useLayoutEffect(() => {
        if (!covering) {
            return undefined;
        }

        const opener = document.activeElement;
        const box = document.querySelector(".layout > :is(.files-tile, .browser):not(.leaving)");

        if (box && !box.contains(opener)) {
            box.focus({ preventScroll: true });
        }

        return () => {
            const active = document.activeElement;

            // Not into a text field on touch screens, where its keyboard would pop up.
            if (
                (active === null || active === document.body || box?.contains(active)) &&
                opener?.isConnected &&
                !box?.contains(opener) &&
                !(
                    matchMedia("(pointer: coarse)").matches &&
                    opener.matches("input, textarea, [contenteditable]")
                )
            ) {
                opener.focus({ preventScroll: true });
            }
        };
    }, [covering]);

    if (kept === null || (leaving && panelsBeside())) {
        return null;
    }

    return html`<${panel} leaving=${leaving} />`;
}

function App() {
    const state = store.state;

    useEffect(() => {
        document.title = state.view.conversation?.title
            ? `${state.view.conversation.title} · pi-phone`
            : "pi-phone";
    }, [state.view.conversation?.title]);

    // The phone's assistant sheet (PP-146): only the sheet, over the app in front.
    if (ASSIST) {
        return html`<${AssistView} /><${Notices} />`;
    }

    if (state.me === undefined) {
        return html`<${Boot}
            caption=${state.notices.some((notice) => notice.level === "error") ? t("waiting for the server") : t("starting")}
        />
        <${Notices} />`;
    }

    if (state.me === null) {
        return html`<${SignIn} /><${Notices} />`;
    }

    const inConversation = state.conversationId !== null;
    const rail = prefs().sidebar === "rail";
    // The sidebar and the splash show only on wide screens (style.css): narrower, they are not drawn at all. A phone
    // drew the sidebar's session list beside its own, hidden, on each change and each Back.
    const sidebar = WIDE.matches;
    // The subagents board, or an extension's page, takes the conversation's place, and the panels beside it give it
    // their room.
    const board = state.board;
    const page = !board && state.page !== null;
    const placed = board || page;
    const filing = !placed && filesShown(state);
    // A voice call's view (PP-189) takes the panels' place while it shows: full screen on a phone, at the right on wide screens.
    const voicing = !placed && !filing && inConversation && voiceShown(state);
    // Pi's browser takes the Files tile's place (one panel at a time), and the People panel's.
    const browsing = !placed && !filing && !voicing && inConversation && browserShown(state);
    // Pi's computer (PP-178) takes the same place, after the browser's.
    const computing = !placed && !filing && !voicing && !browsing && inConversation && computerShown(state);
    const people = !placed && !filing && !voicing && !browsing && !computing && peopleDocked(state);
    const peeking = !placed && peeksWanted(state);
    const tiles = peeking ? peekTiles(state) : [];
    // The column takes the place beside the conversation when Browser and People leave it free; otherwise a strip,
    // which only shows when there are tiles.
    const peekColumn = peeking && PEEK_WIDE.matches && !filing && !people && !voicing;

    return html`<div
        class=${`layout ${inConversation || placed ? "" : "home"} ${filing || browsing || computing || voicing ? "filing" : ""}`}
        data-part="app"
    >
        <aside class="sidebar window" data-part="sidebar">
            ${
                sidebar &&
                html`<div class="sidebar-clip">
                        <${RailNav} foldable=${true} folded=${rail} />
                        ${!rail && html`<${SessionList} />`}
                    </div>
                    ${!rail && html`<${ResizeHandle} />`}`
            }
        </aside>
        <div class=${`pane window ${placed ? "boarded" : ""}`} data-part="pane">
            ${
                board
                    ? html`<${SubagentsBoard} />`
                    : page
                      ? state.page.module === GATEWAY_PAGE
                          ? html`<${GatewayPage} key=${state.page.id} tab=${state.page.id} />`
                          : html`<${ExtensionPage} key=${`${state.page.module}:${state.page.id}`} />`
                      : inConversation
                        ? html`<${Topbar} />
                    ${
                        peeking &&
                        tiles.length > 0 &&
                        !peekColumn &&
                        html`<${PeekStrip} tiles=${tiles} />`
                    }
                    <${Transcript} key=${state.conversationId} />
                    ${
                        state.view.conversation &&
                        !state.missing &&
                        html`<${BrowserPreview} /><${ComputerPreview} /><${Composer} key=${state.conversationId} />`
                    }`
                        : html`<div class="home-list" data-part="home-list">
                          <${RailNav} />
                          <${SessionList} />
                      </div>
                      ${sidebar && html`<${Splash} />`}`
            }
        </div>
        ${
            inConversation &&
            html`<${PeekHost}
                shown=${peekColumn}
                tiles=${tiles}
                replaced=${filing || people}
            />`
        }
        <${PanelHost} key=${`files:${state.conversationId}`} shown=${filing} panel=${FilesPanel} />
        <${PanelHost} key="pi-browser" shown=${browsing} panel=${BrowserPanel} />
        <${PanelHost} key="pi-computer" shown=${computing} panel=${ComputerPanel} />
        <${PanelHost} key="pi-voice" shown=${voicing} panel=${VoicePanel} />
        <${BrowserWatcher} />
        <${ComputerWatcher} />
        ${inConversation && html`<${PeopleHost} shown=${people} replaced=${filing} />`}
        <${Drawer} />
        <${Sheets} />
        <${LauncherHost} />
        <${Notices} />
    </div>`;
}

// ─── Windows and keys ───────────────────────────────────────────────────────────

/** Which window has focus, as Hyprland shows it: the one under the mouse (Omarchy's follow_mouse), or that took a tap or a key. */
function focusWindow(event) {
    if (event.type === "pointerover" && event.pointerType !== "mouse") {
        return;
    }

    const win = event.target.closest?.(".window");

    if (!win) {
        return;
    }

    // By the window's part name, as themes know it: `sidebar`, `peeks`, `people-panel`, `browser-panel`, `computer-panel`,
    // `files-panel`.
    const name =
        ["sidebar", "peeks", "people-panel", "browser-panel", "computer-panel", "files-panel"].find((each) =>
            win.matches(`[data-part~="${each}"]`),
        ) ?? "pane";

    if (document.documentElement.dataset.focus !== name) {
        document.documentElement.dataset.focus = name;
    }
}

// The conversation's window has the focus until another takes it: `data-focus` always names one, for themes too.
document.documentElement.dataset.focus ??= "pane";
document.addEventListener("pointerover", focusWindow, true);
document.addEventListener("pointerdown", focusWindow, true);
document.addEventListener("focusin", focusWindow, true);

const typingIn = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const wide = () => WIDE.matches;

/** Go to the session `by` places away in workspace order, wrapping around. */
function step(by) {
    const order = workspaceOrder();

    if (order.length === 0) {
        return;
    }

    const at = order.findIndex((session) => session.id === store.state.conversationId);

    const next = order[(at + by + order.length) % order.length].id;

    openingByAlt(next);
    navigate(next);
}

addEventListener("keydown", (event) => {
    if (event.isComposing) {
        return;
    }

    if (event.key === "Alt") {
        document.documentElement.dataset.alt = "on";
    }

    // Cmd on Apple keyboards, where Ctrl+K and Ctrl+B edit text; Ctrl elsewhere.
    const mod = APPLE ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const key = event.key.toLowerCase();

    if (!store.state.me) {
        return;
    }

    if (mod && !event.altKey && !event.shiftKey && key === "k") {
        event.preventDefault();
        store.set({ launcher: !store.state.launcher, drawer: false });

        return;
    }

    // Find in this session: the browser's own find misses the messages the transcript does not draw.
    if (
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        key === "f" &&
        store.state.view.conversation &&
        !store.state.launcher &&
        !store.state.board &&
        !store.state.page
    ) {
        event.preventDefault();
        openSheet({ type: "find" });

        return;
    }

    if (mod && !event.altKey && !event.shiftKey && key === "b") {
        event.preventDefault();

        if (wide()) {
            setPrefs({ sidebar: prefs().sidebar === "rail" ? "open" : "rail" });
        } else {
            store.set({ drawer: !store.state.drawer });
        }

        return;
    }

    // Option types characters on Apple keyboards, and AltGr does on many layouts: no Alt shortcuts there while typing.
    const altTypes = event.getModifierState?.("AltGraph") || (APPLE && typingIn(event.target));

    if (event.altKey && !event.ctrlKey && !event.metaKey && !altTypes) {
        const digit = /^Digit([1-9])$/.exec(event.code);

        if (digit) {
            const session = workspaceOrder()[Number(digit[1]) - 1];

            event.preventDefault();

            if (session) {
                openingByAlt(session.id);
                navigate(session.id);
            }

            return;
        }

        if (event.code === "ArrowDown" || event.code === "ArrowUp") {
            event.preventDefault();
            step(event.code === "ArrowDown" ? 1 : -1);

            return;
        }

        if (event.code === "KeyN" && canSteer() && !scoped()) {
            event.preventDefault();
            openSheet({ type: "cwd", mode: "new" });

            return;
        }

        if (event.code === "KeyP" && store.state.server?.peeks === true) {
            event.preventDefault();
            togglePeeks();

            return;
        }

        if (event.code === "KeyT") {
            event.preventDefault();
            setPrefs({ showThinking: !prefs().showThinking });
            notify("info", prefs().showThinking ? t("Show thinking: on.") : t("Show thinking: off."));

            return;
        }

        // The panels are not beside the subagents board, nor an extension's page.
        if (event.code === "KeyE" && !store.state.board && !store.state.page && filesAvailable()) {
            event.preventDefault();
            toggleFiles();

            return;
        }

        // Dictation into the message box in view.
        if (event.code === "KeyV" && !store.state.sheet && !store.state.launcher && toggleDictation()) {
            event.preventDefault();

            return;
        }

    }

    // Esc closes the Files tile where it covers the conversation, as back does. What is inside
    // takes it first: a file open over the tree, the page in the panel, a field.
    const cover =
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !store.state.sheet &&
        !store.state.launcher &&
        !store.state.drawer &&
        document.querySelector(
            '.layout > [aria-modal="true"].files-tile:not(.leaving)',
        );

    if (cover) {
        event.preventDefault();

        setFilesOpen(false);

        return;
    }

    if (event.key === "Escape" && !event.defaultPrevented) {
        stopOnSecondEscape();
    }

    if (
        event.key === "?" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !typingIn(event.target) &&
        !store.state.sheet &&
        !store.state.launcher
    ) {
        event.preventDefault();
        openSheet({ type: "shortcuts" });
    }
});
/** When Esc was last pressed while Pi worked: a second press soon after stops it. */
let escapedAt = 0;
/** The notice the first press shows. */
let escapeNotice = null;
const ESCAPE_TWICE_MS = 1500;

/** Esc twice stops Pi, as Esc does in other agents' terminals. Twice, since Esc also closes things and leaves fields. */
function stopOnSecondEscape() {
    const { view, sheet, launcher, board, page, drawer } = store.state;

    // Esc closes these first.
    if (sheet || launcher || board || page || drawer || !view.live?.busy || !canSteer()) {
        return;
    }

    if (Date.now() - escapedAt < ESCAPE_TWICE_MS) {
        escapedAt = 0;
        // Pressed again: what it asked for is done.
        dismiss(escapeNotice);
        attempt(actions.abort);

        return;
    }

    escapedAt = Date.now();
    const notice = (escapeNotice = notify("info", t("Press Esc again to stop Pi.")));

    // Up only while a second press stops Pi.
    setTimeout(() => dismiss(notice), ESCAPE_TWICE_MS);
}

const altUp = () => delete document.documentElement.dataset.alt;

addEventListener("keyup", (event) => event.key === "Alt" && altUp());
addEventListener("blur", altUp);

// The whole tree re-renders from the store; Preact's diff keeps that cheap. Batched per microtask.
startTheme();
// Inside the Android app, dictation listens with Android's recognizer (`android-speech.js`).
installAndroidSpeech();
// Updates the Android app finds are offered in the app's own sheet (`sheets/update.js`).
installAppUpdates();
// Where the session list is not beside the conversation, a conversation opened straight away gets it under it, so back
// goes to the list rather than out of the app.
// The assistant's sheet has no history of its own, nor the app's edge gestures; the app's window keeps the session the
// owner is in, for the sheet's "last session".
if (ASSIST) {
    document.documentElement.classList.add("assist-mode");
} else {
    startHistory({ home: !wide() });
    startEdgeBack();
    rememberLastSession();
}
// One hand on a phone: on the conversation, swipe right to go back and left for the Files tile; swipe up from the
// message box for the places.
startSwipes((where) => {
    const { conversationId, view, missing } = store.state;

    if (ASSIST) {
        return {};
    }

    // The subagents board or an extension's page in the conversation's place (or the home screen's): right goes back,
    // as its × does.
    if (where === "board") {
        return { right: { path: iconPath("back"), label: t("Back"), run: goBack } };
    }

    if (conversationId === null || !view.conversation || missing) {
        return {};
    }

    if (where === "files") {
        return { right: { path: iconPath("back"), label: t("Back"), run: goBack } };
    }

    // Back to the list, or to the session before when that is where back goes.
    const toList = !canGoBack() || history.state?.pocket?.back === 1;

    return {
        right: {
            path: iconPath("back"),
            label: toList ? t("Sessions") : t("Back"),
            run: () => (canGoBack() ? goBack() : toSessions()),
        },
        left: filesAvailable()
            ? { path: iconPath("folder"), label: t("Files"), run: () => setFilesOpen(true) }
            : null,
        up: () => openSheet({ type: "places" }),
    };
});
const root = document.getElementById("app");
let queued = false;

store.subscribe(() => {
    if (queued) {
        return;
    }

    queued = true;
    queueMicrotask(() => {
        queued = false;
        render(html`<${App} />`, root);
    });
});
render(html`<${App} />`, root);

// A notification's link can ask for the chat: `/s/12?chat=1`.
if (new URLSearchParams(location.search).has("chat")) {
    replaceAddress(location.pathname);
    openSheet({ type: "chat" });
}

// A settings sheet by link, `/?sheet=machines`: for Pi's screenshots of the app's own settings, and to share a place
// in them. Only sheets that need nothing else to open.
const LINKED_SHEETS = new Set([
    "access",
    "appearance",
    "dictation",
    "extensions",
    "github",
    "machines",
    "notifications",
    "people",
    "phone",
    "phone-control",
    "computer-control",
    "assistant",
    "voice",
    "providers",
    "schedules",
    "secrets",
    "shortcuts",
    "spend",
    "ssh-keys",
    "web-access",
]);
const linkedSheet = new URLSearchParams(location.search).get("sheet");

if (linkedSheet !== null && LINKED_SHEETS.has(linkedSheet)) {
    replaceAddress(location.pathname);
    openSheet({ type: linkedSheet });
}

// An extension's sheet by link, `/?sheet=projects:board-mode` (module:sheet): opened once its module has loaded.
const linkedExtensionSheet = /^([A-Za-z0-9_-]+):([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})$/.exec(linkedSheet ?? "");

if (linkedExtensionSheet !== null) {
    replaceAddress(location.pathname);
    openSheetWhenReady(linkedExtensionSheet[1], linkedExtensionSheet[2]);
}

// An extension's page by link, `/?page=projects:projects` (module:page): a notification's, or Pi's screenshots. The page
// shows once its module has loaded.
const linkedPage = /^([A-Za-z0-9_-]+):([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})$/.exec(new URLSearchParams(location.search).get("page") ?? "");

if (linkedPage !== null) {
    // A `#…` after it is the page's own (a task, say): kept for it.
    replaceAddress(location.pathname + location.hash);
    openPageWhenReady(linkedPage[1], linkedPage[2]);
}

start();
