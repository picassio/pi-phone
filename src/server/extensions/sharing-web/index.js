// Sharing sessions with teammates on the team server (src/server/extensions/sharing.ts, PP-58): the menu's "Share this
// session" opens a sheet with who it is shared with (Can write or Can watch, and whether Pi may use your machines and
// secrets for their messages), and adds teammates; "Shared with me" lists what others share with you, each opening at
// its /space/ address in their pi-phone.
export default function sharing(pocket) {
    const { html, useState, useEffect, Loader, Switch } = pocket;

    pocket.style("sharing.css");

    const failed = (error) => pocket.notify("error", error.message);
    const LEVELS = [
        ["write", "Can write"],
        ["watch", "Can watch"],
    ];

    function ShareSheet() {
        const conversation = pocket.conversationId();
        const [state, setState] = useState(null);
        const [people, setPeople] = useState(null);
        const [adding, setAdding] = useState({ teammate: "", level: "write", machines: false, budget: "" });
        const [busy, setBusy] = useState(false);

        useEffect(() => {
            if (conversation === null) {
                return;
            }

            pocket.api(`session/${conversation}`).then(setState, failed);
            pocket.api("teammates").then((answer) => setPeople(answer.teammates), failed);
        }, [conversation]);

        if (conversation === null) {
            return html`<p class="muted">Open a session first.</p>`;
        }

        if (state === null || people === null) {
            return html`<${Loader} label="Opening" />`;
        }

        const onMachine = state.machine !== null;
        const run = (path, body) => {
            setBusy(true);

            return pocket
                .api(path, body)
                .then(setState, failed)
                .finally(() => setBusy(false));
        };
        const change = (share, patch) => run("share", { session: String(conversation), teammate: share.teammate, level: share.level, machines: share.machines, ...patch });
        const others = people.filter((person) => !state.shares.some((share) => share.teammate === person.id));
        const add = () =>
            run("share", {
                session: String(conversation),
                teammate: adding.teammate,
                level: adding.level,
                machines: onMachine || adding.machines,
                ...(adding.level === "write" && adding.budget.trim() !== "" ? { budget: Number(adding.budget) } : {}),
            }).then(() => setAdding({ teammate: "", level: "write", machines: false, budget: "" }));

        return html`<div class="sh-sheet">
            <p class="muted">
                Teammates open it from Shared with me, in their browser. It runs here, on your providers and your money.${" "}
                <b>Can write</b>: they send messages and steer Pi, and read the files and changes; never the terminal, and only you
                allow Pi's calls. <b>Can watch</b>: they read the chat. A teammate who can write can make Pi do what your Pi can do
                in this session.
            </p>
            ${onMachine && html`<p class="sh-warn">This session works on ${state.machine}: every command runs there. It can be shared only with "Pi may use my machines and secrets" on.</p>`}
            ${
                state.shares.length > 0 &&
                html`<div class="sheet-list">
                    ${state.shares.map(
                        (share) => html`<div class="setting-row sh-row" key=${share.teammate}>
                            <div class="setting-text">
                                <span>${share.name}</span>
                                <span>${share.machines ? "Pi may use your machines and secrets for their messages" : "Not your machines or secrets"}</span>
                            </div>
                            <select aria-label=${`What ${share.name} may do`} value=${share.level} disabled=${busy} onChange=${(event) => change(share, { level: event.currentTarget.value })}>
                                ${LEVELS.map(([value, label]) => html`<option value=${value}>${label}</option>`)}
                            </select>
                            <${Switch} on=${share.machines} label="Your machines and secrets" disabled=${busy || onMachine} onChange=${() => change(share, { machines: !share.machines })} />
                            <button class="button ghost small" disabled=${busy} onClick=${() => run("unshare", { session: String(conversation), teammate: share.teammate })}>Remove</button>
                        </div>`,
                    )}
                </div>`
            }
            ${
                others.length === 0
                    ? html`<p class="muted">${people.length === 0 ? "Nobody else is on this server yet." : "Shared with everyone on this server."}</p>`
                    : html`<div class="sh-add">
                          <label class="field"
                              ><span class="label">Share with</span
                              ><select value=${adding.teammate} onChange=${(event) => setAdding({ ...adding, teammate: event.currentTarget.value })}>
                                  <option value="">Choose a teammate</option>
                                  ${others.map((person) => html`<option value=${person.id}>${person.name}</option>`)}
                              </select></label
                          >
                          <label class="field"
                              ><span class="label">They</span
                              ><select value=${adding.level} onChange=${(event) => setAdding({ ...adding, level: event.currentTarget.value })}>
                                  ${LEVELS.map(([value, label]) => html`<option value=${value}>${label.toLowerCase()}</option>`)}
                              </select></label
                          >
                          ${
                              adding.level === "write" &&
                              html`<label class="field"
                                  ><span class="label">Spend limit for their messages ($ a month, empty: none)</span
                                  ><input type="number" min="0" step="1" inputmode="decimal" value=${adding.budget} onInput=${(event) => setAdding({ ...adding, budget: event.currentTarget.value })} /></label>`
                          }
                          <div class="setting-row">
                              <div class="setting-text">
                                  <span>Pi may use my machines and secrets for their messages</span>
                                  <span>Off unless you turn it on${onMachine ? "; on for a session on a machine" : ""}.</span>
                              </div>
                              <${Switch} on=${onMachine || adding.machines} label="Pi may use my machines and secrets" disabled=${onMachine} onChange=${() => setAdding({ ...adding, machines: !adding.machines })} />
                          </div>
                          <div class="sh-actions">
                              <button class="button primary" disabled=${busy || adding.teammate === ""} onClick=${add}>${busy ? "Sharing…" : "Share"}</button>
                          </div>
                      </div>`
            }
        </div>`;
    }

    function SharedSheet() {
        const [shared, setShared] = useState(null);

        useEffect(() => {
            pocket.api("mine").then((answer) => setShared(answer.shared), failed);
        }, []);

        if (shared === null) {
            return html`<${Loader} label="Opening" />`;
        }

        const sessions = shared.flatMap((space) => space.sessions.map((session) => ({ ...session, sharer: space.sharer, level: space.level })));

        if (sessions.length === 0) {
            return html`<p class="muted">Nothing is shared with you yet. When a teammate shares a session, it shows here.</p>`;
        }

        return html`<div class="sheet-list">
            ${sessions.map(
                (session) => html`<a class="setting-row sh-link" key=${session.url} href=${session.url}>
                    <div class="setting-text">
                        <span>${session.title}</span>
                        <span>${session.level === "write" ? "You can write" : "You can watch"} · shared by ${session.sharer}</span>
                    </div>
                </a>`,
            )}
        </div>`;
    }

    pocket.sheet({ id: "share", title: "Share this session", component: ShareSheet });
    pocket.sheet({ id: "shared", title: "Shared with me", component: SharedSheet });
    pocket.menu({ id: "share", label: "Share this session", hint: "with teammates on this server", sheet: "share" });
    pocket.menu({ id: "shared", label: "Shared with me", hint: "sessions teammates share with you", sheet: "shared" });
}
