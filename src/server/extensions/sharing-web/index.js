// Sharing sessions with teammates on the team server (src/server/extensions/sharing.ts, PP-58): the menu's "Share this
// session" opens a sheet with who it is shared with (Can write or Can watch, and whether Pi may use your machines and
// secrets for their messages), and adds teammates; "Shared with me" lists what others share with you, each opening at
// its /space/ address in their pi-phone.
export default function sharing(pocket) {
    const { html, useState, useEffect, Loader, Switch, Choice, t, tx } = pocket;

    pocket.style("sharing.css");

    const failed = (error) => pocket.notify("error", error.message);
    const LEVELS = [
        ["write", t("Can write")],
        ["watch", t("Can watch")],
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
            return html`<p class="muted">${t("Open a session first.")}</p>`;
        }

        if (state === null || people === null) {
            return html`<${Loader} label=${t("Opening")} />`;
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
                machines: onMachine || (adding.level === "write" && adding.machines),
                ...(adding.level === "write" && adding.budget.trim() !== "" ? { budget: Number(adding.budget) } : {}),
            }).then(() => setAdding({ teammate: "", level: "write", machines: false, budget: "" }));

        return html`<div class="sh-sheet">
            <p class="muted">${t("Teammates open it from Shared with me, in their browser. It runs here, on your providers and your money.")}</p>
            ${onMachine && html`<p class="sh-warn">${t('This session works on {machine}: every command runs there. It can be shared only with "Pi may use my machines and secrets" on.', { machine: state.machine })}</p>`}
            ${
                state.shares.length > 0 &&
                html`<section>
                    <h4 class="sh-h">${t("Shared with")}</h4>
                    <div class="sh-list">
                        ${state.shares.map(
                            (share) => html`<div class="sh-share" key=${share.teammate}>
                                <div class="sh-share-head">
                                    <b>${share.name}</b>
                                    <button class="link danger small" disabled=${busy} onClick=${() => run("unshare", { session: String(conversation), teammate: share.teammate })}>${t("Stop sharing")}</button>
                                </div>
                                <div class="sh-share-set">
                                    <div class="segmented" role="radiogroup" aria-label=${t("What {name} may do", { name: share.name })}>
                                        ${LEVELS.map(
                                            ([value, label]) =>
                                                html`<button role="radio" aria-checked=${share.level === value} class=${share.level === value ? "on" : ""} disabled=${busy} onClick=${() => share.level !== value && change(share, { level: value })}>${label}</button>`,
                                        )}
                                    </div>
                                    ${
                                        // A watcher sends no messages: machines and secrets are a writer's question.
                                        share.level === "write" &&
                                        html`<span class="sh-machines">
                                            <span class="muted small">${t("Machines and secrets")}</span>
                                            <${Switch} on=${share.machines} label=${t("Pi may use your machines and secrets for their messages")} disabled=${busy || onMachine} onChange=${() => change(share, { machines: !share.machines })} />
                                        </span>`
                                    }
                                </div>
                            </div>`,
                        )}
                    </div>
                </section>`
            }
            ${
                others.length === 0
                    ? html`<p class="muted">${people.length === 0 ? t("Nobody else is on this server yet.") : t("Shared with everyone on this server.")}</p>`
                    : html`<section class="sh-add">
                          <h4 class="sh-h">${t("Add a teammate")}</h4>
                          <div class="field">
                              <span class="label">${t("Teammate")}</span>
                              <${Choice}
                                  label=${t("Teammate")}
                                  placeholder=${t("Choose a teammate")}
                                  value=${adding.teammate}
                                  options=${others.map((person) => ({ value: person.id, label: person.name }))}
                                  onChange=${(teammate) => setAdding({ ...adding, teammate })}
                              />
                          </div>
                          <div class="sh-levels" role="radiogroup" aria-label=${t("What they may do")}>
                              ${LEVELS.map(
                                  ([value, label]) =>
                                      html`<button role="radio" aria-checked=${adding.level === value} class=${`sh-level${adding.level === value ? " on" : ""}`} onClick=${() => setAdding({ ...adding, level: value })}>
                                          <b>${label}</b>
                                          <span>${value === "write" ? t("Send messages and steer Pi; read the files and changes.") : t("Read the chat as it happens.")}</span>
                                      </button>`,
                              )}
                          </div>
                          ${
                              adding.level === "write" &&
                              html`<label class="field"
                                  ><span class="label">${t("Spend limit for their messages, $ a month")}</span
                                  ><input type="number" min="0" step="1" inputmode="decimal" placeholder=${t("None")} value=${adding.budget} onInput=${(event) => setAdding({ ...adding, budget: event.currentTarget.value })} /></label>`
                          }
                          ${
                              adding.level === "write" &&
                              html`<div class="sh-switch">
                              <div class="setting-text">
                                  <span>${t("Pi may use my machines and secrets for their messages")}</span>
                                  <span>${onMachine ? t("On for a session on a machine.") : t("Off unless you turn it on.")}</span>
                              </div>
                              <${Switch} on=${onMachine || adding.machines} label=${t("Pi may use my machines and secrets")} disabled=${onMachine} onChange=${() => setAdding({ ...adding, machines: !adding.machines })} />
                          </div>`
                          }
                          <button class="button primary sh-go" disabled=${busy || adding.teammate === ""} onClick=${add}>${busy ? t("Sharing…") : t("Share")}</button>
                      </section>`
            }
            <p class="muted small sh-foot">${t("Only you allow Pi's calls, and nobody else gets the terminal. A teammate who can write can make Pi do what your Pi can do in this session.")}</p>
        </div>`;
    }

    function SharedSheet() {
        const [shared, setShared] = useState(null);
        const [copying, setCopying] = useState(null);
        // Continue in my space: a copy here, on your own providers; the session it came from stays as it is.
        const carryOn = (url) => {
            setCopying(url);
            pocket
                .api("continue", { url })
                .then((made) => {
                    pocket.notify("info", t('Continued "{title}" here.', { title: made.title }));
                    location.href = `s/${made.id}`;
                }, failed)
                .finally(() => setCopying(null));
        };

        useEffect(() => {
            pocket.api("mine").then((answer) => setShared(answer.shared), failed);
        }, []);

        if (shared === null) {
            return html`<${Loader} label=${t("Opening")} />`;
        }

        const sessions = shared.flatMap((space) => space.sessions.map((session) => ({ ...session, sharer: space.sharer, level: space.level })));

        if (sessions.length === 0) {
            return html`<p class="muted">${t("Nothing is shared with you yet. When a teammate shares a session, it shows here.")}</p>`;
        }

        return html`<div class="sheet-list">
            ${sessions.map(
                (session) => html`<div class="setting-row sh-row" key=${session.url}>
                    <a class="setting-text sh-link" href=${session.url}>
                        <span>${session.title}</span>
                        <span>${session.level === "write" ? t("You can write · shared by {who}", { who: session.sharer }) : t("You can watch · shared by {who}", { who: session.sharer })}</span>
                    </a>
                    <button class="button small" disabled=${copying !== null} title=${t("A copy in your pi-phone, on your own providers")} onClick=${() => carryOn(session.url)}>
                        ${copying === session.url ? t("Copying…") : t("Continue in mine")}
                    </button>
                </div>`,
            )}
        </div>`;
    }

    pocket.sheet({ id: "share", title: t("Share this session"), component: ShareSheet });
    pocket.sheet({ id: "shared", title: t("Shared with me"), component: SharedSheet });
    pocket.menu({ id: "share", label: t("Share this session"), hint: t("with teammates on this server"), sheet: "share" });
    pocket.menu({ id: "shared", label: t("Shared with me"), hint: t("sessions teammates share with you"), sheet: "shared" });
}
