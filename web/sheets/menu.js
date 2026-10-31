// The menu: what can be done in this session and in the app.
import { t, tn } from "../i18n.js";
import { dictationLanguage } from "../android-speech.js";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { chatUnread } from "../chat.js";
import { schedulesAvailable, webAvailable } from "../commands.js";
import { extensionMenuItems, safeMode } from "../extension-ui.js";
import { openGatewayPage } from "../gateway-panel.js";
import { useChanges } from "../diff.js";
import { filesAvailable, setFilesOpen } from "../files-panel.js";
import { peeksOn, togglePeeks } from "../peeks.js";
import { modelRefreshAvailable, refreshModels } from "../model-refresh.js";
import { groupOf } from "../session-groups.js";
import { openGettingStarted } from "../guide.js";

/** The Compact context row's hint: when the session compacts by itself (PP-78). */
const compactHint = (at) => (typeof at === "number" ? t("now, or by itself at {n}%", { n: at }) : t("summarize older messages"));
import { setArchived } from "../sessions.js";
import { isRemotePlace, splitPlace } from "../place.js";
import { openSubagent, ordered, stateOf, unresolved } from "../subagents.js";
import { pushId, pushSupport } from "../push.js";
import {
    actions,
    api,
    attempt,
    canSteer,
    canToggleTurns,
    closeSheet,
    collab,
    navigate,
    notify,
    openSheet,
    scoped,
    setUnread,
    signOut,
    store,
    roleAllows,
} from "../store.js";
import { isPinned, lookLabel, togglePin } from "../theme.js";
import { currentTrust, trustAvailable } from "../trust.js";
import { branchAvailable } from "./branch.js";
import { defaultLabel, defaultsKept } from "./model.js";
import { copyText, html, Icon, item, Sheet, shortPath, timeAgo } from "../ui.js";
import { voiceAvailable } from "../voice.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/** The Extensions row's hint: that this tab loads none of their browser parts (safe mode), and Lancet Guard. */
function extensionsHint() {
    const { guard } = store.state;

    return [
        safeMode() && t("browser parts off here"),
        guard?.enabled ? t("Lancet Guard on") : guard?.available ? t("Lancet Guard off") : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

/**
 * The session's places as big tiles at the top of the menu: Files, Changes, artifacts, the chat, find,
 * the branch, and peek tiles. The top bar keeps only the buttons with something to say; these are always here, a
 * thumb's width each.
 */
function Places() {
    if (!store.state.view.conversation) {
        return null;
    }

    return filesAvailable() ? html`<${PlacesWithChanges} />` : html`<${PlacesGrid} />`;
}

/** Only people who can open Files request its shared changes data, just as the top bar does. */
function PlacesWithChanges() {
    const { changes } = useChanges();

    return html`<${PlacesGrid} changes=${changes} />`;
}

function PlacesGrid({ changes = null }) {
    const { view, server, filesOpen, filesTab } = store.state;
    // Match the top bar: uncommitted files in a repository, Pi's edits elsewhere, plus any unlisted files.
    const changeCount = changes
        ? changes.files.length + (changes.repo ? 0 : changes.piOnly.length) + (changes.more ?? 0)
        : 0;
    const unread = collab() ? chatUnread() : 0;
    const places = [
        filesAvailable() && {
            id: "files",
            icon: "folder",
            label: t("Files"),
            on: filesOpen && filesTab === "files",
            run: () => setFilesOpen(true, "files"),
        },
        filesAvailable() && {
            id: "changes",
            icon: "diff",
            label: t("Changes"),
            count: changeCount,
            counted: changeCount === 1 ? t("changed file") : t("changed files"),
            on: filesOpen && filesTab === "changes",
            run: () => setFilesOpen(true, "changes"),
        },
        {
            id: "artifacts",
            icon: "artifact",
            label: t("Artifacts"),
            count: view.artifacts.length,
            run: () => openSheet({ type: "artifacts" }),
        },
        collab() && {
            id: "chat",
            icon: "chat",
            label: t("Chat"),
            count: unread,
            counted: "unread",
            run: () => openSheet({ type: "chat" }),
        },
        { id: "find", icon: "search", label: t("Find"), run: () => openSheet({ type: "find" }) },
        branchAvailable() && {
            id: "branch",
            icon: "fork",
            label: t("Branch"),
            run: () => openSheet({ type: "branch" }),
        },
        server?.peeks === true && {
            id: "peeks",
            icon: "tiles",
            label: t("Peeks"),
            on: peeksOn(),
            run: () => {
                togglePeeks();
                closeSheet();
            },
        },
    ].filter(Boolean);

    return html`<nav class="places" aria-label=${t("Places")}>
        ${places.map(
            (place) => html`<button
                key=${place.id}
                type="button"
                class=${`place ${place.on ? "on" : ""}`}
                data-place=${place.id}
                aria-label=${place.count > 0 ? `${place.label}, ${place.count} ${place.counted ?? ""}`.trim() : place.dot ? `${place.label}, ${t("a page open")}` : place.label}
                aria-pressed=${place.on === undefined ? undefined : place.on ? "true" : "false"}
                onClick=${place.run}
            >
                <span class="place-icon badge-host">
                    <${Icon} name=${place.icon} size=${20} />
                    ${place.count > 0 && html`<span class="badge">${place.count}</span>`}
                    ${place.dot && html`<span class="browser-dot" aria-hidden="true"></span>`}
                </span>
                <span class="place-label">${place.label}</span>
            </button>`,
        )}
    </nav>`;
}

/**
 * The places alone, in a short sheet that stays near the bottom edge: what the button beside the message box and a
 * swipe up from it open on a phone, a thumb's reach away. The rest of the menu is a row below.
 */
export function PlacesSheet() {
    const conversation = store.state.view.conversation;

    return html`<${Sheet}
        title=${conversation?.title ?? t("Open")}
        onClose=${closeSheet}
        className="places-sheet"
    >
        <${Places} />
        ${item("Session menu", () => openSheet({ type: "menu", fromPlaces: true }), "rename, context, settings")}
    <//>`;
}

/** Keep Sheet's Esc, drag, and focus handling; the sheet trail already owns its back-stack layer. */
function MenuFrame({ title, children }) {
    const host = useRef(null);

    useLayoutEffect(() => {
        const element = host.current;
        const button = document.querySelector('.topbar [aria-label="Menu"]');
        const active = document.activeElement;
        const opener = active === document.body ? button : active;

        const place = () => {
            const rect = button?.getBoundingClientRect();
            const top = (rect?.bottom ?? 58) + 6;
            const bottom =
                (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight);
            const left = Math.max(
                8,
                Math.min((rect?.right ?? innerWidth - 8) - 360, innerWidth - 368),
            );

            element.style.setProperty("--menu-left", `${left}px`);
            element.style.setProperty("--menu-top", `${top}px`);
            element.style.setProperty("--menu-height", `${Math.max(100, bottom - top - 8)}px`);
        };

        const body = element.querySelector(".sheet-body");

        if (menuScroll !== null) {
            body.scrollTop = menuScroll;
            menuScroll = null;
        }

        place();
        addEventListener("resize", place);
        visualViewport?.addEventListener("resize", place);

        return () => {
            removeEventListener("resize", place);
            visualViewport?.removeEventListener("resize", place);

            // Another sheet open now: the menu is going back under it, not closing.
            if (store.state.sheet) {
                menuScroll = body.scrollTop;
            }

            const focused = document.activeElement;
            const back = opener?.isConnected ? opener : button;
            // As sheets.js does: not behind a sheet the menu opened, and not into a text field on a touch screen,
            // where its keyboard would pop up.
            const field =
                matchMedia("(pointer: coarse)").matches &&
                back?.matches("input, textarea, [contenteditable]");

            if (
                !store.state.sheet &&
                !field &&
                (focused === document.body || element.contains(focused)) &&
                back?.isConnected
            ) {
                back.focus({ preventScroll: true });
            }
        };
    }, []);

    const onKey = (event) => {
        if (
            event.defaultPrevented ||
            event.isComposing ||
            event.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
        ) {
            return;
        }

        const items = [...host.current.querySelectorAll(".place, .list-item")];
        const active = document.activeElement;
        const index = items.indexOf(active);
        let target;

        if (event.key === "Tab") {
            // Close stays reachable with Tab, but is not part of the menu's item navigation.
            const controls = [...items, ...host.current.querySelectorAll(".sheet-head button")];
            const at = controls.indexOf(active);
            const next =
                at < 0
                    ? event.shiftKey
                        ? controls.length - 1
                        : 0
                    : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;

            target = controls[next];
        } else if (event.key === "Home") {
            target = items[0];
        } else if (event.key === "End") {
            target = items.at(-1);
        } else if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) {
            const down = event.key === "ArrowDown" || event.key === "ArrowRight";
            const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
            const tiles = host.current.querySelectorAll(".place").length;
            const step = vertical && index >= 0 && index < tiles ? 3 : 1;
            let next = index < 0 ? (down ? 0 : items.length - 1) : index + (down ? step : -step);

            // Down from the grid's last row enters the first text row; Up from its first row wraps to the last item.
            if (vertical && index >= 0 && index < tiles) {
                next = next < 0 ? items.length - 1 : Math.min(next, tiles);
            }

            target = items[(next + items.length) % items.length];
        }

        if (target) {
            event.preventDefault();
            target.focus();
        }
    };

    return html`<div class="nav-menu-host" data-part="menu" ref=${host} onKeyDown=${onKey}>
        <${Sheet} title=${title} onClose=${closeSheet} className="nav-menu">
            ${children}
        <//>
    </div>`;
}

/** The menu's scroll, kept while a sheet it opened shows, so back finds the menu where it was left. */
let menuScroll = null;

store.subscribe(({ sheet }) => {
    if (!sheet) {
        menuScroll = null;
    }
});

/** The project's trust in a word, once the server said. */
function trustHint() {
    const info = currentTrust();

    if (!info) {
        return "";
    }

    if (info.ask) {
        return "not decided";
    }

    // No decision, and nothing waiting for one: there is nothing to say.
    if (info.saved === null && info.defaultProjectTrust === "ask") {
        return "";
    }

    return info.trusted ? t("trusted") : t("not trusted");
}

/** The menu; `places` is false when it opens from the places sheet, which just showed the tiles. */
/** Idle subagents shown as they are, up to this many; more fold into one row (PP-280). */
const IDLE_SHOWN = 2;

/** A subagent's row: its state as a dot, its name, and what it does or how long ago it last did something. */
function subagentRow(agent) {
    const status = stateOf(agent);
    const needs = unresolved(agent);
    const when = agent.busy ? agent.askedAt : agent.answeredAt;
    const word = agent.busy ? t("working") : needs ? t("failed") : status === "stopped" ? t("stopped") : t("idle");

    const dot = agent.busy ? "working" : needs ? "failed" : "idle";
    const name = html`<span class="sa-name"><span class=${`sa-dot ${dot}`} aria-hidden="true"></span>${agent.name}</span>`;

    return item(name, () => openSubagent(agent.conversationId), when === undefined ? word : `${word} · ${timeAgo(when)}`);
}

/**
 * The session's subagents in its menu (PP-280, the owner's option B): those at work and failures nobody dealt with
 * first, each with a row; the idle ones fold into one row ("12 idle") that opens in place, so many of them never push
 * the menu's other parts away.
 */
function MenuSubagents({ agents }) {
    const [open, setOpen] = useState(false);
    const sorted = ordered(agents);
    const active = sorted.filter((agent) => agent.busy || unresolved(agent));
    const idle = sorted.filter((agent) => !agent.busy && !unresolved(agent));
    const folded = idle.length > IDLE_SHOWN;

    return html`<div class="group" data-part="menu-subagents">
        <div class="group-title">${t("Subagents · {n}", { n: agents.length })}</div>
        ${active.map(subagentRow)}
        ${
            folded
                ? html`<button class="list-item" data-part="idle-subagents" aria-expanded=${String(open)} onClick=${() => setOpen(!open)}>
                      <span class="sa-name"><span class="sa-dot idle" aria-hidden="true"></span>${t("{n} idle", { n: idle.length })}</span>
                      <span class="muted small">${open ? t("Hide") : t("Show")}</span>
                  </button>
                  ${open && html`<div class="sa-folded">${idle.map(subagentRow)}</div>`}`
                : idle.map(subagentRow)
        }
    </div>`;
}

export function MenuSheet({ places = true }) {
    const { view, me, server } = store.state;
    const allowed = roleAllows;
    const conversation = view.conversation;
    const steer = canSteer();
    const session = conversation?.kind === "session";
    const turns = view.turns;
    // While take turns is on, settings belong to the driver.
    const driving = !turns?.on || turns.driver === me?.id;
    const instructions = view.agent?.instructions;

    return html`<${MenuFrame} title=${conversation?.title ?? t("Menu")}>
        ${places && html`<${Places} />`}
        <div class="menu-session">
            ${
                conversation &&
                collab() &&
                canToggleTurns() &&
                item(
                    turns?.on ? "Turn off take turns" : "Take turns",
                    () =>
                        attempt(async () => {
                            await actions.turns(turns?.on ? "off" : "on");
                            closeSheet();
                        }),
                    turns?.on
                        ? "anyone here can send to Pi again"
                        : "one person drives Pi at a time",
                )
            }
            ${session && steer && item("Rename", () => openSheet({ type: "rename" }))}
            ${
                session &&
                item(
                    isPinned(conversation.id) ? "Unpin from the top" : "Pin to the top",
                    () => {
                        togglePin(conversation.id);
                        closeSheet();
                    },
                    "this browser",
                )
            }
            ${
                session &&
                item(
                    "Mark unread",
                    () => {
                        setUnread(conversation.id, true);
                        closeSheet();
                        navigate(null);
                    },
                    "this browser; opening it again clears it",
                )
            }
            ${
                conversation?.worktree && steer
                    ? item(
                          "Worktree",
                          () => openSheet({ type: "worktree" }),
                          conversation.worktree.branch,
                      )
                    : conversation &&
                      steer &&
                      driving &&
                      !scoped() &&
                      item(
                          "Working directory",
                          () => openSheet({ type: "cwd", mode: "change" }),
                          shortPath(view.agent?.cwd, server?.home),
                      )
            }
            ${
                conversation &&
                me?.role === "owner" &&
                allowed("terminal.use") &&
                item(
                    "Terminal",
                    () => openSheet({ type: "terminal", place: view.agent?.cwd ?? conversation.cwd }),
                    "a shell in this session's folder",
                )
            }
            ${
                conversation?.kind === "session" &&
                me?.role === "owner" &&
                (store.state.server?.machines?.length ?? 0) > 0 &&
                item("Continue in Pi", () => openSheet({ type: "pi-handoff" }), "in pi on a machine, and back")
            }
            ${
                conversation?.kind === "session" &&
                me?.role === "owner" &&
                item(
                    "Other sessions",
                    () => openSheet({ type: "send-limit" }),
                    (conversation.sendLimit === undefined ? server?.sessionSendLimit : conversation.sendLimit) === null
                        ? "no limit on messages to them"
                        : t("up to {n} messages an hour to them", { n: conversation.sendLimit ?? server?.sessionSendLimit ?? 30 }),
                )
            }
            ${
                me?.role === "owner" &&
                isRemotePlace(view.agent?.cwd ?? conversation?.cwd) &&
                item(
                    "Open a port",
                    () => openSheet({ type: "forwards", machineId: splitPlace(view.agent?.cwd ?? conversation.cwd).machineId }),
                    "a dev server on the machine, in the browser",
                )
            }
            ${conversation && trustAvailable() && item("Project trust", () => openSheet({ type: "trust" }), trustHint())}
            ${session && steer && driving && item("Instructions for Pi", () => openSheet({ type: "instructions" }), instructions ? "on" : "none")}
            ${conversation && steer && driving && item("Compact context", () => openSheet({ type: "compact" }), compactHint(conversation.compactAt ?? store.state.server?.compactAt))}
            ${conversation && steer && driving && item("New context", () => openSheet({ type: "reset" }), "Pi starts fresh; history stays")}
            ${schedulesAvailable() && item("Scheduled messages", () => openSheet({ type: "schedules" }), view.schedules.length === 0 ? "none" : t("{n} coming", { n: view.schedules.length }))}
            ${
                conversation &&
                item("Copy link", () =>
                    copyText(location.href).then(
                        () => notify("info", t("Link copied. Other signed-in devices can open it.")),
                        () => notify("error", t("Could not copy.")),
                    ),
                )
            }
            ${
                conversation &&
                html`<a class="list-item" href=${`api/c/${conversation.id}/export`} download>
                    <span>${t("Export as Markdown")}</span>
                    <span class="muted small">${t("the whole history")}</span>
                </a>`
            }
            ${
                session &&
                steer &&
                !scoped() &&
                !conversation.archived &&
                item("Move to group…", () => openSheet({ type: "session-move", ids: [conversation.id] }), groupOf(conversation.id)?.name ?? "not in a group")
            }
            ${
                session &&
                steer &&
                item(conversation.archived ? "Unarchive" : "Archive", () => {
                    closeSheet();
                    setArchived([conversation.id], !conversation.archived);
                })
            }
        </div>
        ${view.subagents.length > 0 && html`<${MenuSubagents} agents=${view.subagents} />`}
        <div class="group">
            <div class="group-title">${t("App")}</div>
            ${me?.role === "owner" && item("Getting started", () => openGettingStarted(), "Pi shows you around")}
            ${item("Appearance", () => openSheet({ type: "appearance" }), lookLabel())}
            ${me?.role === "owner" && !["app", "space"].includes(pushSupport()) && item("Notifications", () => openSheet({ type: "notifications" }), pushId() === null ? "off on this device" : "on on this device")}
            ${voiceAvailable() && item("Dictation", () => openSheet({ type: "dictation" }), dictationLanguage())}
            ${
                // Voice calls and Codex dictation on the owner's ChatGPT sign-in (PP-190).
                me?.role === "owner" && server?.voice && item("Voice", () => openSheet({ type: "voice" }), "calls with Pi, on your ChatGPT sign-in")
            }
            ${!touch && item("Keyboard shortcuts", () => openSheet({ type: "shortcuts" }), "?")}
            ${
                me?.role === "owner" &&
                defaultsKept() &&
                item(
                    "Default model",
                    () => openSheet({ type: "model", id: "default", forDefault: true }),
                    defaultLabel(server?.defaultModel, store.state.models) ||
                        "project, last picked, then Pi global",
                )
            }
            ${item("Your name", () => openSheet({ type: "name" }), me?.name)}
            ${
                // Behind the server edition's gateway, accounts, people and devices are its (PP-21).
                server?.gateway
                    ? item("Your account", () => openGatewayPage("account"), "password, two-factor, passkeys, people")
                    : collab()
                      ? item("People", () => openSheet({ type: "people" }), me?.role === "viewer" ? "you can view" : "")
                      : item("Sign in another device", () => openSheet({ type: "invite" }))
            }
            ${item("Running now", () => openSheet({ type: "running" }), "everything Pi is doing")}
            ${item("Spend", () => openSheet({ type: "spend" }), me?.role === "owner" ? "by person and session, limits" : "yours")}
            ${me?.role === "owner" && allowed("providers.signin") && item("Providers", () => openSheet({ type: "providers" }))}
            ${me?.role === "owner" && allowed("providers.signin") && item("GitHub", () => openSheet({ type: "github" }), "for Pi's git and gh")}
            ${me?.role === "owner" && !server?.gateway && item("Access", () => openSheet({ type: "access" }), "people on your Tailscale network")}
            ${me?.role === "owner" && allowed("machines.use") && item("Machines", () => openSheet({ type: "machines" }), "run sessions on other computers")}
            ${me?.role === "owner" && allowed("machines.use") && item("SSH keys", () => openSheet({ type: "ssh-keys" }), "for machines")}
            ${me?.role === "owner" && allowed("web.search") && webAvailable() && item("Web access", () => openSheet({ type: "web-access" }), "search provider for Pi")}
            ${me?.role === "owner" && allowed("settings.change") && server?.extensions?.includes("pocket-design") && item("Design system", () => openSheet({ type: "design-system" }), server?.designSystem ?? "none: Pi picks a look")}
            ${
                // The model image_generate makes images with (PP-275), while the Images extension is on.
                me?.role === "owner" && allowed("settings.change") && server?.extensions?.includes("pocket-images") && item("Images", () => openSheet({ type: "images" }), server?.imageModel ?? "automatic")
            }
            ${me?.role === "owner" && allowed("browser.use") && item("Pi's browser", () => openSheet({ type: "browser" }), "how browser_run decides each step")}
            ${
                // Pi uses this phone's apps (PP-141): the phone's own pi-phone only, never the team server.
                me?.role === "owner" && !server?.gateway && (server?.onPhone || window.PiPhoneApp) && allowed("phone.control") && item("Phone control", () => openSheet({ type: "phone-control" }), "Pi uses apps on this phone")
            }
            ${
                // Pi uses desktop apps on the owner's machines (PP-178): never on the team server.
                me?.role === "owner" && !server?.gateway && allowed("computer.control") && item("Computer control", () => openSheet({ type: "computer-control" }), "Pi uses apps on your machines")
            }
            ${
                // pi-phone as the phone's digital assistant (PP-146): the side key's sheet, on the phone's own pi-phone.
                me?.role === "owner" && !server?.gateway && (server?.onPhone || window.PiPhoneApp) && item("Assistant", () => openSheet({ type: "assistant" }), "hold the side key to talk to Pi")
            }
            ${me?.role === "owner" && allowed("secrets.use") && item("Secrets", () => openSheet({ type: "secrets" }), "keys Pi uses without seeing")}
            ${extensionMenuItems().map((each) => item(each.label, each.run, each.hint))}
            ${me?.role === "owner" && allowed("settings.change") && (server?.gateway ? item("Backup", () => openSheet({ type: "phone" }), "your sessions and settings, in one file") : item("This phone", () => openSheet({ type: "phone" }), "notifications, screen off, backup"))}
            ${
                // The Android shell's bridge (android/.../MainActivity.java): only inside the app.
                me?.role === "owner" &&
                window.PiPhoneApp &&
                item("Check for app updates", () => {
                    closeSheet();
                    window.PiPhoneApp.checkForUpdates();
                })
            }
            ${modelRefreshAvailable() && item("Refresh models", refreshModels, store.state.modelRefresh.loading ? "refreshing…" : "models.json and providers")}
            ${allowed("extensions.manage") && item("Extensions", () => openSheet({ type: "extensions" }), extensionsHint())}
            ${
                me?.role === "owner" &&
                server?.supervised &&
                item(
                    "Restart server",
                    () =>
                        attempt(async () => {
                            await api("restart", {});
                            closeSheet();
                            notify("info", t("Restarting. Running work continues after the restart."));
                        }),
                    "running work resumes",
                )
            }
            ${item(html`<span class="menu-signout">${t("Sign out")}</span>`, signOut)}
        </div>
    <//>`;
}
