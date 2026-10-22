// People with access to this server, and invites for more.
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "../avatar.js";
import { t, tx } from "../i18n.js";
import {
    actions,
    api,
    attempt,
    canSteer,
    closeSheet,
    collab,
    notify,
    openSheet,
    scoped,
    store,
} from "../store.js";
import { copyText, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

/** What a role may do, said in full: a guest seeing one session is told that does not limit Pi. */
const roleText = (role, only) =>
    role === "guest"
        ? only
            ? t("Can steer Pi, which can run commands on this machine. Seeing one session in the app does not limit what Pi can reach on the machine.")
            : t("Can steer Pi, which can run commands on this machine.")
        : t("Can read along, react, and chat, but not steer Pi.");

/** How long an invite may last: minutes, its button, and how the help text says it (in the person's language). */
const LASTS = () => [
    [15, t("15 min"), t("in 15 minutes")],
    [60, t("1 hour"), t("in an hour")],
    [24 * 60, t("1 day"), t("in a day")],
    [7 * 24 * 60, t("1 week"), t("in a week")],
];

/** Whether `at` was a moment ago, as timeAgo says it in the language in use. */
const isNow = (at) => timeAgo(at) === t("now");

/** End an invite nobody will see: one the sheet stopped showing, or one that answered too late to show. */
const cancelInvite = (invite) => {
    // A server that says how long its invites last also ends them on request; an older one has no such route.
    if (invite?.minutes !== undefined) {
        // Sent even when the page goes (a reload, a web file edited), so it is never left live and unseen.
        fetch("api/invite/cancel", {
            method: "POST",
            keepalive: true,
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ code: invite.code }),
        }).catch(() => {});
    }
};

export function InviteSheet({ session = null }) {
    const { view, me } = store.state;
    const here = view.conversation?.kind === "session" ? view.conversation : null;
    const [role, setRole] = useState("guest");
    const [only, setOnly] = useState(session !== null);
    // The owner's own other device: it signs in as the owner, not as someone new.
    const [asOwner, setAsOwner] = useState(false);
    const [minutes, setMinutes] = useState(15);
    const [made, setMade] = useState(null);
    // The newest invite could not be made: the sheet offers to try again rather than wait for ever.
    const [failed, setFailed] = useState(false);
    // What the sheet says now: an invite shows only while it was made for exactly this.
    const asked = JSON.stringify([asOwner, role, only, minutes]);
    // Only the newest invite shows: one asked for before a change, answering late, must not stand for what the sheet says.
    const latest = useRef(0);
    // The invite the sheet last showed: a change to what it grants, or how long it lasts, ends it.
    const shown = useRef(null);
    // Closed (gone, or still sliding away): nothing more is made, and what was being made ends when it answers.
    const mounted = useRef(true);
    const open = () => mounted.current && store.state.sheet?.type === "invite";
    const create = ({ replacing = false } = {}) =>
        attempt(async () => {
            if (!open()) {
                return;
            }

            const ticket = ++latest.current;

            if (replacing) {
                cancelInvite(shown.current);
                shown.current = null;
            }

            setMade(null);
            setFailed(false);
            let answer;

            try {
                answer = await api(
                    "invite",
                    asOwner
                        ? { role: "owner" }
                        : collab()
                          ? { role, ...(only && here ? { session: here.id } : {}), minutes }
                          : { minutes },
                );
            } catch (error) {
                if (ticket === latest.current) {
                    setFailed(true);
                }

                throw error;
            }

            if (ticket !== latest.current || !open()) {
                cancelInvite(answer);

                return;
            }

            // A server from before owner invites makes a guest's: never shown as the owner's.
            if (asOwner && answer.grant?.role !== "owner") {
                setFailed(true);

                throw new Error(t("Restart pi-phone to sign in another device as the owner."));
            }

            shown.current = answer;
            setMade({ ...answer, asked });
        });

    useEffect(() => {
        create({ replacing: true });
    }, [role, only, asOwner, minutes]);
    useEffect(
        () => () => {
            mounted.current = false;
        },
        [],
    );
    // Shown only while it is what the sheet says, not for a frame after a change: above all, never an owner's invite
    // under a cleared box (which the server's answer says too).
    const invite =
        made && made.asked === asked && (made.grant?.role === "owner") === asOwner ? made : null;
    // As long as the invite shown lasts (a server that does not say: 15 minutes), or, while one is made, as chosen.
    const lasting = LASTS().find(
        ([each]) => each === (invite ? (invite.minutes ?? 15) : minutes),
    )?.[2];

    return html`<${Sheet} title=${t("Invite someone")} onClose=${closeSheet}>
        ${
            me?.role === "owner" &&
            html`<label class="check">
                <input
                    type="checkbox"
                    checked=${asOwner}
                    onChange=${(event) => setAsOwner(event.currentTarget.checked)}
                />
                ${t("Sign in as me (owner)")}
            </label>`
        }
        ${
            collab() &&
            !asOwner &&
            html`<div class="field">
                <div class="label">${t("They can")}</div>
                <div class="segmented">
                    <button
                        class=${role === "guest" ? "on" : ""}
                        aria-pressed=${role === "guest"}
                        onClick=${() => setRole("guest")}
                    >
                        ${t("Steer")}
                    </button>
                    <button
                        class=${role === "viewer" ? "on" : ""}
                        aria-pressed=${role === "viewer"}
                        onClick=${() => setRole("viewer")}
                    >
                        ${t("View only")}
                    </button>
                </div>
                <div class="muted small">
                    ${roleText(role, only)}
                </div>
            </div>
            ${
                here &&
                html`<div class="field">
                    <div class="label">${t("In")}</div>
                    <div class="segmented">
                        <button
                            class=${!only ? "on" : ""}
                            aria-pressed=${!only}
                            onClick=${() => setOnly(false)}
                        >
                            ${t("Every session")}
                        </button>
                        <button
                            class=${only ? "on" : ""}
                            aria-pressed=${only}
                            onClick=${() => setOnly(true)}
                        >
                            ${t("Only this session")}
                        </button>
                    </div>
                </div>`
            }`
        }
        ${
            !asOwner &&
            html`<div class="field">
                <div class="label">${t("Expires after")}</div>
                <div class="segmented">
                    ${LASTS().map(
                        ([each, label]) => html`<button
                            class=${minutes === each ? "on" : ""}
                            aria-pressed=${minutes === each}
                            onClick=${() => setMinutes(each)}
                        >
                            ${label}
                        </button>`,
                    )}
                </div>
            </div>`
        }
        <p class="muted small">
            ${
                asOwner
                    ? t("Scan this on your other device, or send it the link. That device signs in as you, the owner. It works once and expires in 15 minutes.")
                    : only && here
                      ? t("Scan this on the other device, or send it the link. It works once and expires {when}. Whoever joins sees only “{title}”.", { when: lasting, title: here.title })
                      : t("Scan this on the other device, or send it the link. It works once and expires {when}. Whoever joins sees every session.", { when: lasting })
            }
        </p>
        ${
            invite?.access?.url &&
            html`<p class="muted small">${t("Other devices connect through {label}: people on your tailnet.", { label: invite.access.label })}</p>`
        }
        ${
            invite
                ? html`<div class="invite">
                    ${
                        invite.local &&
                        html`<div class="error-box">
                            ${tx("This link only works on this phone. To let people on your Tailscale network open it, turn on {link}.", {
                                link: html`<button class="link" onClick=${() => openSheet({ type: "access" })}>${t("Settings › Access")}</button>`,
                            })}
                        </div>`
                    }
                    <div class="invite-details">
                    <div class="qr" dangerouslySetInnerHTML=${{ __html: invite.svg }}></div>
                    <div class="invite-code">
                        <div class="invite-code-head">
                            <span>${t("Invite code")}</span>
                            <button
                                class="link small"
                                onClick=${() =>
                                    copyText(invite.code).then(
                                        () => notify("info", t("Code copied.")),
                                        () => notify("error", t("Could not copy.")),
                                    )}
                            >
                                ${t("Copy")}
                            </button>
                        </div>
                        <div
                            class="invite-code-value"
                            aria-label=${t("Invite code {code}", { code: invite.code.split("").join(" ") })}
                        >
                            <span>${invite.code.slice(0, 5)}</span>
                            <span>${invite.code.slice(5)}</span>
                        </div>
                        <div class="muted small">
                            ${t("Or enter it on the other device's sign-in screen.")}
                        </div>
                    </div>
                    </div>
                    <div class="row">
                        <input
                            class="mono"
                            readonly
                            value=${invite.url}
                            onFocus=${(event) => event.currentTarget.select()}
                        />
                        <button
                            class="button"
                            onClick=${() =>
                                copyText(invite.url).then(
                                    () => notify("info", t("Link copied.")),
                                    () => notify("error", t("Could not copy.")),
                                )}
                        >
                            ${t("Copy")}
                        </button>
                    </div>
                    ${
                        invite.alternatives?.length > 0 &&
                        html`<p class="muted small">
                            ${tx("Also reachable at: {urls}", {
                                urls: invite.alternatives.map((url) => html`<span class="mono">${url} </span>`),
                            })}
                        </p>`
                    }
                </div>`
                : failed
                  ? html`<p class="muted small">${t("No invite yet. Tap New invite to try again.")}</p>`
                  : html`<${Loader} label=${t("Making an invite")} />`
        }
        <button class="button wide" onClick=${create}>${t("New invite")}</button>
        ${!collab() && html`<${PeopleList} />`}
    <//>`;
}

function lastSeen(person) {
    if (person.online) {
        return t("here now");
    }

    if (!person.lastSeen) {
        return t("not seen yet");
    }

    return isNow(person.lastSeen) ? t("seen now") : t("seen {ago} ago", { ago: timeAgo(person.lastSeen) });
}

/** Everyone with access: who is online, when the others were last here, and (for the owner) what each may do. */
function PeopleList() {
    const { me, users, sessions } = store.state;
    const owner = me?.role === "owner";
    const sessionTitle = (id) => sessions.find((each) => each.id === id)?.title ?? t("session {id}", { id });
    const ordered = [...users].sort(
        (a, b) =>
            Number(Boolean(b.online)) - Number(Boolean(a.online)) ||
            (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
    );
    const change = (person, patch) =>
        attempt(async () => store.set({ users: await actions.setAccess(person.id, patch) }));

    return html`<div class="group">
        <div class="group-title">${t("People")}</div>
        <div class="sheet-list">
        ${ordered.map(
            (person) => html`<div class="person-row" key=${person.id}>
                <span class="people-here">
                    <${Avatar} person=${person} size=${32} />
                    <span
                        class=${`online-mark ${person.online ? "" : "away"}`}
                        aria-hidden="true"
                    ></span>
                </span>
                <div class="person-main">
                    <div>
                        ${person.name}
                        ${person.id === me?.id ? html` <span class="muted small">${t("(you)")}</span>` : ""}
                    </div>
                    <div class="muted small">
                        ${person.role === "owner" ? t("owner") : person.role === "viewer" ? t("view only") : t("can steer")}
                        ${person.sessions ? ` · ${t("only {sessions}", { sessions: person.sessions.map(sessionTitle).join(", ") })}` : ""} · ${lastSeen(person)}
                    </div>
                </div>
                ${
                    owner &&
                    person.role !== "owner" &&
                    html`<div class="person-actions">
                        ${
                            collab() &&
                            html`<button
                                class="button small"
                                title=${t("Change what they can do")}
                                onClick=${() => change(person, { role: person.role === "viewer" ? "guest" : "viewer" })}
                            >
                                ${person.role === "viewer" ? t("Let steer") : t("View only")}
                            </button>`
                        }
                        ${
                            collab() &&
                            person.sessions &&
                            html`<button
                                class="button small"
                                title=${t("Let them see every session")}
                                onClick=${() => change(person, { sessions: null })}
                            >
                                ${t("All sessions")}
                            </button>`
                        }
                        <button
                            class="button small ghost"
                            onClick=${() =>
                                confirm(t("Remove {name}? Their devices are signed out.", { name: person.name })) &&
                                attempt(async () => {
                                    await api(`users/${person.id}/remove`, {});
                                    store.set({
                                        users: store.state.users.filter(
                                            (each) => each.id !== person.id,
                                        ),
                                    });
                                })}
                        >
                            ${t("Remove")}
                        </button>
                    </div>`
                }
            </div>`,
        )}
        </div>
    </div>`;
}

/** Where a device was last seen from: this phone, the Tailscale network (100.64.0.0/10), or an address. */
export function placeName(address) {
    if (address === undefined || address === "") {
        return "";
    }

    if (/^(127\.|::1$)/.test(address)) {
        return t("this phone");
    }

    const [first, second] = address.split(".").map(Number);

    return first === 100 && second >= 64 && second <= 127 ? `Tailscale · ${address}` : address;
}

/**
 * Signed-in devices (src/server/app.ts `devices`): the owner sees everyone's, others their own. Each with whose it is,
 * where it was last seen, when it signed in and was last active, a dot when a tab of it is open now, and Sign out
 * (not for this device, nor the phone's app, which signs in again by itself). Looked at again every 10 seconds.
 */
function Devices() {
    const owner = store.state.me?.role === "owner";
    const [list, setList] = useState(null);
    const load = () =>
        api("devices").then(
            (answer) => setList(answer.devices),
            () => {},
        );

    useEffect(() => {
        const timer = setInterval(load, 10_000);

        load();

        return () => clearInterval(timer);
    }, []);

    const signOut = (device) =>
        confirm(
            owner && device.user.role !== "owner"
                ? t("Sign out {device} ({person})? It needs a new sign-in link to come back.", { device: device.name, person: device.user.name })
                : t("Sign out {device}? It needs a new sign-in link to come back.", { device: device.name }),
        ) &&
        attempt(async () => {
            await api(`devices/${encodeURIComponent(device.id)}/sign-out`, {});
            notify("info", t("{device} is signed out.", { device: device.name }));
            load();
        });

    return html`<div class="group">
        <div class="group-title">${owner ? t("Devices") : t("Your devices")}</div>
        ${list === null && html`<${Loader} label=${t("Loading")} />`}
        ${
            list !== null &&
            html`<div class="sheet-list">
                ${list.length === 0 && html`<div class="person-row muted small">${t("No devices signed in yet.")}</div>`}
                ${list.map(
                    (device) => html`<div class="person-row" key=${device.id}>
                        <span class="people-here">
                            <${Icon} name=${/app|Android|iOS/.test(device.name) ? "phone" : "monitor"} size=${20} />
                            ${device.open && html`<span class="online-mark" aria-label=${t("Open now")}></span>`}
                        </span>
                        <div class="person-main">
                            <div>
                                ${device.name}
                                ${device.current && html` <span class="muted small">${t("(this device)")}</span>`}
                            </div>
                            <div class="muted small">
                                ${[
                                    owner ? (device.user.role === "owner" ? t("you") : device.user.name) : "",
                                    placeName(device.address),
                                    device.open
                                        ? device.background
                                            ? t("open, in the background")
                                            : t("open now")
                                        : device.lastSeen
                                          ? isNow(device.lastSeen)
                                              ? t("active just now")
                                              : t("active {ago} ago", { ago: timeAgo(device.lastSeen) })
                                          : "",
                                    isNow(device.createdAt) ? t("signed in just now") : t("signed in {ago} ago", { ago: timeAgo(device.createdAt) }),
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </div>
                        </div>
                        ${
                            device.current || device.app
                                ? html`<span class="muted small">${device.current ? "" : t("signs in again by itself")}</span>`
                                : html`<div class="person-actions">
                                      <button class="button small ghost" onClick=${() => signOut(device)}>${t("Sign out")}</button>
                                  </div>`
                        }
                    </div>`,
                )}
                <${SignOutEverywhere} owner=${owner} />
                ${owner && html`<${RecoveryCode} />`}
            </div>`
        }
    </div>`;
}

/**
 * The owner's recovery code (break glass): a way in when no device is signed in and the app cannot sign in either. Made
 * here and shown once, to keep off the phone; it signs one browser in as the owner, once, and the phone says when it was
 * used. A new one ends the one before.
 */
function RecoveryCode() {
    const [madeAt, setMadeAt] = useState(undefined);
    // Made only in the app on the phone: elsewhere the row says so.
    const [here, setHere] = useState(false);
    const [shown, setShown] = useState(null);

    useEffect(() => {
        api("recovery-code").then(
            (answer) => {
                setMadeAt(answer.madeAt);
                setHere(answer.here === true);
            },
            () => {},
        );
    }, []);

    const make = () =>
        (madeAt === null || confirm(t("Make a new recovery code? The one you have stops working."))) &&
        attempt(async () => {
            const made = await api("recovery-code", {});

            setShown(made.code);
            setMadeAt(made.createdAt);
        });

    return html`<div class="provider family">
        <div>
            <div>${t("Recovery code")}</div>
            <div class="muted small">
                ${
                    madeAt === undefined
                        ? "…"
                        : madeAt === null
                          ? t("None yet. A code to sign a browser in as you if no device can, kept somewhere safe off this phone.")
                          : isNow(madeAt)
                            ? t("Made just now. It works once: paste it into the sign-in screen of any browser that reaches this phone.")
                            : t("Made {ago} ago. It works once: paste it into the sign-in screen of any browser that reaches this phone.", { ago: timeAgo(madeAt) })
                }${here ? "" : ` ${t("Only the pi-phone app on the phone can make one.")}`}
            </div>
            ${
                shown &&
                html`<div class="recovery-code">
                    <pre class="ssh-public-key">${shown}</pre>
                    <p class="muted small">${t("Shown only now. Keep it in a password manager or on paper, not on this phone. The phone notifies you when it is used.")}</p>
                </div>`
            }
        </div>
        <div class="provider-actions">
            ${shown && html`<button class="button small" onClick=${() => copyText(shown).then(() => notify("info", t("Copied.")), () => notify("error", t("Could not copy.")))}>${t("Copy")}</button>`}
            ${here && html`<button class="button small ghost" onClick=${make}>${madeAt ? t("Make a new code") : t("Make a code")}</button>`}
        </div>
    </div>`;
}

/**
 * "Sign out every device" (src/server/app.ts `signOutEverywhere`): every other device of yours signs out, and your own
 * token is replaced, so no old sign-in holds it. This one stays signed in; the phone's app signs in again by itself.
 */
function SignOutEverywhere({ owner }) {
    const [busy, setBusy] = useState(false);
    const run = () =>
        confirm(
            owner
                ? t("Sign out every other device signed in as you?\n\nThey need a new link from \"Sign in as me\" to come back. This device stays signed in, and the app on the phone signs in again by itself. Invited people are not affected.")
                : t("Sign out every other device of yours?\n\nThey need a new invite to come back. This device stays signed in."),
        ) &&
        attempt(async () => {
            setBusy(true);

            try {
                await api("sign-out-everywhere", {});
                notify("info", t("Every other device is signed out."));
                // Start again with this device's sign-in, if it only now became a device of its own.
                setTimeout(() => location.reload(), 800);
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="provider">
            <div>
                <div>${owner ? t("Sign out every device") : t("Sign out my other devices")}</div>
                <div class="muted small">
                    ${
                        owner
                            ? t("For a lost device or a sign-in link that got out: every other device signed in as you signs out, except the app on the phone.")
                            : t("For a lost device or a sign-in link that got out: every other device signed in as you signs out.")
                    }
                </div>
            </div>
            <div class="provider-actions">
                <button class="button small ghost" disabled=${busy} onClick=${run}>${busy ? t("Signing out…") : t("Sign out all")}</button>
            </div>
        </div>`;
}

export function PeopleSheet() {
    const canInvite = canSteer() && !scoped();
    return html`<${Sheet} title=${t("People")} onClose=${closeSheet}>
        ${
            canInvite &&
            html`<button class="button primary wide" onClick=${() => openSheet({ type: "invite" })}>
                <${Icon} name="plus" size=${16} /> ${t("Invite someone")}
            </button>`
        }
        <${PeopleList} />
        <${Devices} />
    <//>`;
}
