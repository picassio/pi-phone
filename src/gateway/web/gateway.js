// The gateway's page (PP-21): sign in (password, then TOTP; or a passkey), the owner's setup, an invite, your account
// (password, two-factor, passkeys, sign out), and for the owner, people and invites. Plain JS, no build; text goes in
// with textContent only. better-auth's routes are /auth/api/*, the gateway's own /auth/gw/*.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "/auth/static/webauthn/index.js";

const app = document.getElementById("app");

/** An element: tag, properties (on* are listeners), children (strings become text). */
function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);

    for (const [name, value] of Object.entries(props)) {
        if (name.startsWith("on") && typeof value === "function") {
            node.addEventListener(name.slice(2).toLowerCase(), value);
        } else if (value !== undefined && value !== false && value !== null) {
            node.setAttribute(name, value === true ? "" : String(value));
        }
    }

    for (const child of children.flat()) {
        if (child !== undefined && child !== null && child !== false) {
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
    }

    return node;
}

async function call(path, body, method) {
    const response = await fetch(path, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
    });
    const text = await response.text();
    let data = {};

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        throw new Error(data.error ?? data.message ?? `HTTP ${response.status}`);
    }

    return data;
}

const authApi = (path, body, method) => call(`/auth/api/${path}`, body, method);
const gw = (path, body, method) => call(`/auth/gw/${path}`, body, method);

function page(title, lede, ...content) {
    // Leaving out what is not there (a passkey button where the browser can't make one): replaceChildren would write "null".
    app.replaceChildren(
        ...[h("div", { class: "brand" }, h("img", { src: "/auth/static/icon.svg", alt: "" }), h("b", {}, "pi-phone")), h("h1", {}, title), lede ? h("p", { class: "muted" }, lede) : null, ...content].filter(
            (each) => each !== null && each !== undefined && each !== false,
        ),
    );
    document.title = `${title} · pi-phone`;
}

/** A form whose submit runs `action`; its error shows under it. */
function form(fields, submit, action) {
    const error = h("p", { class: "error", role: "alert" });
    const button = h("button", { class: "primary", type: "submit" }, submit);
    const node = h(
        "form",
        {
            onsubmit: async (event) => {
                event.preventDefault();
                error.textContent = "";
                button.disabled = true;

                try {
                    await action(Object.fromEntries(new FormData(node).entries()));
                } catch (failed) {
                    error.textContent = failed.message;
                } finally {
                    button.disabled = false;
                }
            },
        },
        ...fields,
        button,
        error,
    );

    return node;
}

const field = (label, name, type = "text", extra = {}) => h("label", {}, label, h("input", { name, type, required: true, ...extra }));
const next = () => new URLSearchParams(location.search).get("next") || "/";
const go = (path) => {
    history.pushState({}, "", path);
    void route();
};

// ─── Sign in ───

function signIn() {
    const passkey = browserSupportsWebAuthn()
        ? h(
              "button",
              {
                  type: "button",
                  onclick: async () => {
                      try {
                          const options = await authApi("passkey/generate-authenticate-options");
                          const response = await startAuthentication({ optionsJSON: options });

                          await authApi("passkey/verify-authentication", { response });
                          location.href = next();
                      } catch (failed) {
                          alert(`Passkey: ${failed.message}`);
                      }
                  },
              },
              "Sign in with a passkey",
          )
        : null;

    page(
        "Sign in",
        "Your own pi-phone, on this server.",
        form([field("Email", "email", "email", { autocomplete: "username" }), field("Password", "password", "password", { autocomplete: "current-password" })], "Sign in", async ({ email, password }) => {
            const answer = await authApi("sign-in/email", { email, password, rememberMe: true });

            if (answer.twoFactorRedirect) {
                return twoFactorStep();
            }

            location.href = next();
        }),
        passkey ? h("p", { class: "muted or" }, "or") : null,
        passkey,
    );
}

/** The digits of a code as typed (an app may show "123 456"). */
const digits = (code) => String(code).replace(/\D+/g, "");

function twoFactorStep(backup = false) {
    page(
        backup ? "Backup code" : "Two-factor code",
        backup ? "One of the backup codes you saved when you turned two-factor on. Each works once." : "The 6-digit code your authenticator app shows for pi-phone.",
        backup
            ? form([field("Backup code", "code", "text", { autocomplete: "off" })], "Verify", async ({ code }) => {
                  await authApi("two-factor/verify-backup-code", { code: String(code).trim() });
                  location.href = next();
              })
            : form([field("Code", "code", "text", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })], "Verify", async ({ code }) => {
                  await authApi("two-factor/verify-totp", { code: digits(code), trustDevice: false });
                  location.href = next();
              }),
        h("button", { type: "button", onclick: () => twoFactorStep(!backup) }, backup ? "Use my authenticator app instead" : "Use a backup code instead"),
    );
}

// ─── The owner's setup, and an invite ───

function setup() {
    page(
        "Set up the owner",
        "The first account on this server: the owner's. The setup token is in the gateway's log.",
        form(
            [field("Setup token", "setupToken", "password"), field("Your name", "name"), field("Email", "email", "email", { autocomplete: "username" }), field("Password (10 or more)", "password", "password", { minlength: 10, autocomplete: "new-password" })],
            "Create the owner",
            async ({ setupToken, name, email, password }) => {
                await gw("setup", { setupToken, name, email, password });
                await authApi("sign-in/email", { email, password, rememberMe: true });
                go("/auth/account");
            },
        ),
    );
}

async function invite(code) {
    let live;

    try {
        live = await gw(`invite/${code}`);
    } catch (failed) {
        return page("Invite", failed.message, h("a", { class: "button", href: "/auth/sign-in" }, "Sign in"));
    }

    page(
        "Join pi-phone",
        `You're invited as ${live.role}. Your own pi-phone starts when you first open it.`,
        form([field("Your name", "name"), field("Email", "email", "email", { autocomplete: "username" }), field("Password (10 or more)", "password", "password", { minlength: 10, autocomplete: "new-password" })], "Create my account", async ({ name, email, password }) => {
            await gw(`invite/${code}`, { name, email, password });
            await authApi("sign-in/email", { email, password, rememberMe: true });
            go("/auth/account");
        }),
    );
}

// ─── Your account ───

async function account(me) {
    const twoFactor = h("div", { class: "card" });
    const passkeys = h("div", { class: "card" });

    page(
        me.name,
        `${me.email} · ${me.roleName ?? me.role}`,
        nav(me),
        h("div", { class: "row" }, h("button", { onclick: async () => (await authApi("sign-out", {}), go("/auth/sign-in")) }, "Sign out")),
        h("h2", {}, "Two-factor sign-in"),
        twoFactor,
        h("h2", {}, "Passkeys"),
        passkeys,
        h("h2", {}, "Password"),
        h(
            "div",
            { class: "card" },
            form([field("Current password", "currentPassword", "password", { autocomplete: "current-password" }), field("New password (10 or more)", "newPassword", "password", { minlength: 10, autocomplete: "new-password" })], "Change password", async ({ currentPassword, newPassword }) => {
                await authApi("change-password", { currentPassword, newPassword, revokeOtherSessions: true });
                alert("Password changed; your other devices are signed out.");
            }),
        ),
    );

    renderTwoFactor(twoFactor, me);
    void renderPasskeys(passkeys);
}

function renderTwoFactor(box, me) {
    if (me.twoFactor) {
        box.replaceChildren(
            h("p", { class: "ok" }, "On: signing in asks for a code from your authenticator app."),
            form([field("Password", "password", "password", { autocomplete: "current-password" })], "Turn off", async ({ password }) => {
                await authApi("two-factor/disable", { password });
                renderTwoFactor(box, { ...me, twoFactor: false });
            }),
        );

        return;
    }

    box.replaceChildren(
        h("p", { class: "muted" }, "Off. Turn it on to ask for a code from an authenticator app after your password."),
        form([field("Password", "password", "password", { autocomplete: "current-password" })], "Turn on", async ({ password }) => {
            const { totpURI, backupCodes } = await authApi("two-factor/enable", { password });
            const qr = await gw("qr", { text: totpURI });
            const key = new URL(totpURI).searchParams.get("secret") ?? "";
            const copy = (text, button) => async () => {
                await navigator.clipboard.writeText(text);
                button.textContent = "Copied";
            };
            const copyKey = h("button", { type: "button" }, "Copy setup key");
            const copyCodes = h("button", { type: "button" }, "Copy backup codes");

            copyKey.addEventListener("click", copy(key, copyKey));
            copyCodes.addEventListener("click", copy(backupCodes.join("\n"), copyCodes));
            box.replaceChildren(
                h("p", {}, h("b", {}, "1. Add pi-phone to your authenticator app"), " (1Password, Google Authenticator, Authy…):"),
                h(
                    "div",
                    { class: "row" },
                    h("a", { class: "button primary", href: totpURI }, "Open in authenticator app"),
                    copyKey,
                ),
                h("p", { class: "muted" }, "Or type the setup key into the app's one-time password field: ", h("span", { class: "code" }, key.replace(/(.{4})/g, "$1 ").trim())),
                h("p", { class: "muted" }, "Or scan this from another device:"),
                h("img", { class: "qr", src: qr.svg, alt: "QR code for your authenticator app" }),
                h("p", {}, h("b", {}, "2. Type the 6-digit code the app now shows for pi-phone"), " (not a backup code):"),
                form([field("Code from the app", "code", "text", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })], "Finish", async ({ code }) => {
                    await authApi("two-factor/verify-totp", { code: digits(code) });
                    renderTwoFactor(box, { ...me, twoFactor: true });
                }),
                h("p", {}, h("b", {}, "3. Save the backup codes"), ": spares for signing in if you lose your app, each usable once. Not for step 2."),
                h("p", { class: "code" }, backupCodes.join("  ")),
                copyCodes,
            );
        }),
    );
}

async function renderPasskeys(box) {
    const list = await authApi("passkey/list-user-passkeys");
    const add = browserSupportsWebAuthn()
        ? h(
              "button",
              {
                  onclick: async () => {
                      try {
                          const options = await authApi("passkey/generate-register-options");
                          const response = await startRegistration({ optionsJSON: options });

                          await authApi("passkey/verify-registration", { response, name: navigator.platform || "Passkey" });
                          void renderPasskeys(box);
                      } catch (failed) {
                          alert(`Passkey: ${failed.message}`);
                      }
                  },
              },
              "Add a passkey",
          )
        : h("p", { class: "muted" }, "This browser can't make passkeys.");

    box.replaceChildren(
        list.length === 0
            ? h("p", { class: "muted" }, "None yet: a passkey signs you in without your password.")
            : h(
                  "div",
                  { class: "list" },
                  list.map((each) =>
                      h(
                          "div",
                          { class: "spread" },
                          h("span", {}, each.name || "Passkey", " ", h("span", { class: "muted" }, new Date(each.createdAt).toLocaleDateString())),
                          h("button", { class: "danger", onclick: async () => (await authApi("passkey/delete-passkey", { id: each.id }), renderPasskeys(box)) }, "Remove"),
                      ),
                  ),
              ),
        add,
    );
}

// ─── People (the owner, or a role with people.invite / people.manage) ───

const has = (me, permission) => (me.permissions ?? []).includes(permission);
const nav = (me) =>
    h(
        "div",
        { class: "row" },
        h("a", { class: "button primary", href: "/" }, "Open my pi-phone"),
        h("a", { class: "button", href: "/auth/account", onclick: (event) => (event.preventDefault(), go("/auth/account")) }, "My account"),
        has(me, "pi.use") ? h("a", { class: "button", href: "/auth/shared", onclick: (event) => (event.preventDefault(), go("/auth/shared")) }, "Shared with me") : null,
        has(me, "people.invite") || has(me, "people.manage") ? h("a", { class: "button", href: "/auth/people", onclick: (event) => (event.preventDefault(), go("/auth/people")) }, "People") : null,
        has(me, "roles.manage") ? h("a", { class: "button", href: "/auth/roles", onclick: (event) => (event.preventDefault(), go("/auth/roles")) }, "Roles") : null,
        has(me, "audit.view") ? h("a", { class: "button", href: "/auth/audit", onclick: (event) => (event.preventDefault(), go("/auth/audit")) }, "Audit log") : null,
        has(me, "server.manage") ? h("a", { class: "button", href: "/auth/server", onclick: (event) => (event.preventDefault(), go("/auth/server")) }, "Server") : null,
    );

async function people(me) {
    const listBox = h("div", { class: "list" });
    const invitesBox = h("div", { class: "list" });
    const { roles } = await gw("roles");
    const offered = roles.filter((role) => role.id !== "owner" || me.role === "owner");

    page(
        "People",
        "Everyone with an account here. Each has their own pi-phone, by their role.",
        nav(me),
        has(me, "people.invite") ? h("h2", {}, "Invite someone") : null,
        has(me, "people.invite")
            ? h(
                  "div",
                  { class: "card" },
                  form(
                      [
                          h("label", {}, "Role", h("select", { name: "role" }, offered.map((role) => h("option", { value: role.id, selected: role.id === "member" }, role.name)))),
                          h("label", {}, "Lasts", h("select", { name: "minutes" }, h("option", { value: "60" }, "1 hour"), h("option", { value: "1440", selected: true }, "1 day"), h("option", { value: "10080" }, "7 days"))),
                      ],
                      "Make an invite link",
                      async ({ role, minutes }) => {
                          const made = await gw("invites", { role, minutes: Number(minutes) });

                          await navigator.clipboard?.writeText(made.url).catch(() => {});
                          void renderInvites(invitesBox);
                          alert(`Invite link (copied):\n${made.url}`);
                      },
                  ),
              )
            : null,
        has(me, "people.invite") ? h("h2", {}, "Invites") : null,
        has(me, "people.invite") ? invitesBox : null,
        h("h2", {}, "Accounts"),
        listBox,
    );

    if (has(me, "people.invite")) {
        void renderInvites(invitesBox, roles);
    }

    void renderPeople(listBox, me, roles);
}

async function renderInvites(box, roles = []) {
    const { invites } = await gw("invites");
    const now = Date.now();
    const nameOf = (id) => roles.find((role) => role.id === id)?.name ?? id;

    box.replaceChildren(
        ...(invites.length === 0
            ? [h("p", { class: "muted" }, "None.")]
            : invites.map((each) =>
                  h(
                      "div",
                      { class: "card spread" },
                      h("span", {}, h("span", { class: "tag" }, nameOf(each.role)), " ", each.usedBy ? "used" : each.expiresAt < now ? "expired" : `until ${new Date(each.expiresAt).toLocaleString()}`),
                      !each.usedBy && each.expiresAt > now ? h("button", { onclick: async () => (await gw(`invites/${each.code}/cancel`, {}), renderInvites(box, roles)) }, "Cancel") : null,
                  ),
              )),
    );
}

async function renderPeople(box, me, roles) {
    const { people } = await gw("people");
    const act = async (person, action, body = {}) => {
        try {
            await gw(`people/${person.id}/${action}`, body);
        } catch (failed) {
            alert(failed.message);
        }

        void renderPeople(box, me, roles);
    };
    const manage = has(me, "people.manage");

    box.replaceChildren(
        ...people.map((person) => {
            const mayAct = manage && person.id !== me.id && (person.role !== "owner" || me.role === "owner");
            const roleSelect = h(
                "select",
                { "aria-label": `${person.name}'s role`, onchange: (event) => act(person, "role", { role: event.target.value }) },
                roles.filter((role) => role.id !== "owner" || me.role === "owner" || person.role === "owner").map((role) => h("option", { value: role.id, selected: role.id === person.role }, role.name)),
            );

            return h(
                "div",
                { class: "card person" },
                h("b", {}, person.name, " ", mayAct ? null : h("span", { class: "tag" }, person.roleName), person.banned ? h("span", { class: "tag" }, "disabled") : null, person.twoFactor ? h("span", { class: "tag" }, "2FA") : null),
                h("span", { class: "muted" }, person.email),
                has(me, "server.manage") && !person.banned
                    ? h(
                          "label",
                          { class: "check", title: "Never stopped when idle; started by itself, so scheduled messages run without a visit" },
                          h("input", { type: "checkbox", checked: person.alwaysOn, onchange: (event) => act(person, "always-on", { on: event.target.checked }) }),
                          " Always on",
                      )
                    : null,
                has(me, "server.manage") && person.box && (person.role !== "owner" || me.role === "owner")
                    ? h("a", { class: "button", href: `/auth/gw/people/${person.id}/export`, download: "", title: "Their pi-phone's data (sessions, settings, files) as a .tar.gz" }, "Download data")
                    : null,
                mayAct
                    ? h(
                          "div",
                          { class: "row" },
                          roleSelect,
                          h("button", { onclick: () => { const password = prompt(`New password for ${person.name} (10 or more):`); if (password) void act(person, "reset-password", { password }); } }, "Reset password"),
                          person.twoFactor ? h("button", { onclick: () => confirm(`Remove ${person.name}'s two-factor? They set it up again.`) && act(person, "reset-two-factor") }, "Reset 2FA") : null,
                          person.banned ? h("button", { onclick: () => act(person, "enable") }, "Enable") : h("button", { onclick: () => confirm(`Disable ${person.name}? Their pi-phone stops.`) && act(person, "disable") }, "Disable"),
                          h("button", { class: "danger", onclick: () => confirm(`Remove ${person.name}'s account? Their data is kept.`) && act(person, "remove") }, "Remove"),
                      )
                    : null,
            );
        }),
    );
}

// ─── Roles (roles.manage) ───

async function rolesPage(me) {
    const { roles, counts, catalogue } = await gw("roles");
    const editor = (role) => {
        const fields = [
            field("Name", "name", "text", { value: role?.name ?? "", maxlength: 40 }),
            ...catalogue.map((group) =>
                h(
                    "fieldset",
                    { class: "card" },
                    h("legend", {}, group.group),
                    ...Object.entries(group.permissions).map(([key, label]) =>
                        h("label", { class: "check" }, h("input", { type: "checkbox", name: `p:${key}`, checked: role?.permissions.includes(key) ?? false }), h("span", {}, label, " ", h("span", { class: "muted" }, key))),
                    ),
                ),
            ),
            h("div", { class: "row" }, field("Memory (MB)", "memoryMb", "number", { value: role?.memoryMb ?? 2048, min: 256, max: 16384, step: 256 }), field("CPUs", "cpus", "number", { value: role?.cpus ?? 1, min: 0.25, max: 8, step: 0.25 })),
            h("label", {}, "Models they may use: one provider/model per line, none for any", h("textarea", { name: "models", rows: 3 }, (role?.models ?? []).join("\n"))),
            h("label", {}, "Spend limit, dollars a month: empty for none", h("input", { name: "spendLimit", type: "number", min: 0, step: "any", value: role?.spendLimit ?? "" })),
        ];
        const body = (values) => ({
            name: values.name,
            permissions: Object.keys(values).filter((key) => key.startsWith("p:")).map((key) => key.slice(2)),
            memoryMb: Number(values.memoryMb),
            cpus: Number(values.cpus),
            models: String(values.models ?? "").split("\n"),
            spendLimit: values.spendLimit === "" ? null : Number(values.spendLimit),
        });

        return form(fields, role ? "Save" : "Add the role", async (values) => {
            await gw(role ? `roles/${role.id}` : "roles", body(values));
            void rolesPage(me);
        });
    };

    page(
        "Roles",
        "What each role's people may do, and their pi-phone's memory, CPUs, models and spend. Changes reach a pi-phone when it next starts.",
        nav(me),
        ...roles.map((role) =>
            h(
                "details",
                { class: "card" },
                h("summary", {}, role.name, " ", h("span", { class: "tag" }, `${counts[role.id] ?? 0} ${(counts[role.id] ?? 0) === 1 ? "person" : "people"}`), role.builtin ? h("span", { class: "tag" }, "built in") : null),
                role.builtin
                    ? h("p", { class: "muted" }, "The owner's role has every permission, and isn't editable.")
                    : h(
                          "div",
                          {},
                          editor(role),
                          h(
                              "button",
                              {
                                  class: "danger",
                                  onclick: async () => {
                                      if (!confirm(`Delete the role ${role.name}?`)) {
                                          return;
                                      }

                                      try {
                                          await gw(`roles/${role.id}/delete`, {});
                                          void rolesPage(me);
                                      } catch (failed) {
                                          alert(failed.message);
                                      }
                                  },
                              },
                              "Delete the role",
                          ),
                      ),
            ),
        ),
        h("h2", {}, "New role"),
        h("div", { class: "card" }, editor(undefined)),
    );
}

// ─── The audit log (audit.view) ───

async function auditPage(me) {
    const { entries } = await gw("audit");
    let names = {};

    try {
        names = Object.fromEntries((await gw("people")).people.map((person) => [person.id, person.name]));
    } catch {
        // Without people.manage or people.invite: ids as they are.
    }

    // Pi's changes, made in a person's pi-phone with their rights (PP-45): "Pi for" them.
    const who = (id) => (id?.startsWith("pi:") ? `Pi for ${names[id.slice(3)] ?? id.slice(3)}` : (names[id] ?? id));

    page(
        "Audit log",
        "Who changed what: invites, roles, people.",
        nav(me),
        h(
            "div",
            { class: "list" },
            entries.length === 0
                ? h("p", { class: "muted" }, "Nothing yet.")
                : entries.map((entry) =>
                      h(
                          "div",
                          { class: "card" },
                          h("b", {}, entry.action),
                          " ",
                          entry.target ? h("span", {}, "· ", who(entry.target)) : null,
                          h("div", { class: "muted" }, `${new Date(entry.at).toLocaleString()} · by ${who(entry.actor)}`),
                          entry.details?.role?.name ? h("div", { class: "muted" }, `role: ${entry.details.role.name}`) : entry.details?.to ? h("div", { class: "muted" }, `${entry.details.from} → ${entry.details.to}`) : null,
                      ),
                  ),
        ),
    );
}

// ─── Shared with me ───

async function sharedPage(me) {
    const { boards } = await gw("shared");

    page(
        "Shared with me",
        "Boards others shared with you, and the team's boards you're on. Each opens in your own pi-phone, where your Pi works on it in your own copy of the code.",
        nav(me),
        h(
            "div",
            { class: "list" },
            boards.length === 0
                ? h("p", { class: "muted" }, "Nothing yet.")
                : boards.map((board) =>
                      h(
                          "a",
                          { class: "card", href: `/#project:${board.key}` },
                          h("b", {}, board.key),
                          " ",
                          board.name,
                          h("div", { class: "muted" }, board.team ? (board.open ? "A team board, open to everyone" : "A team board") : `Shared by ${board.by}`),
                      ),
                  ),
        ),
    );
}

// ─── Server ───

async function serverPage(me) {
    const status = h("p", { class: "muted" });
    const show = (server) => {
        const { all, running, outdated } = server.containers;

        status.textContent = `${all} pi-phone${all === 1 ? "" : "s"}, ${running} running${outdated > 0 ? `, ${outdated} on an older image (made again from the new one when Pi is not at work there, or as they next start)` : ""}.`;
    };
    const server = await gw("server");
    const docsLine = (docs) =>
        docs.model === null || !docs.keySet
            ? "By keyword only for now."
            : `By meaning with ${docs.model}: ${docs.indexed.embedded} of ${docs.indexed.passages} passages indexed. This month: ${docs.month.tokens.toLocaleString()} tokens${docs.month.cost > 0 ? `, ${docs.month.cost < 0.01 ? "under $0.01" : `$${docs.month.cost.toFixed(2)}`}` : ""}.`;
    const docsStatus = h("p", { class: "muted" }, docsLine(server.docs));

    show(server);
    page(
        "Server",
        "How this server runs people's pi-phones.",
        nav(me),
        h("h2", {}, "Idle pi-phones"),
        h("p", { class: "muted" }, "A pi-phone stops when nobody has it open and it isn't at work (Pi writing, tools, scheduled messages). It starts again on the next visit, in a few seconds."),
        form(
            [field("Stop after this many minutes unused (0: never)", "idleMinutes", "number", { min: "0", max: "1440", step: "1", value: String(server.idleMinutes) })],
            "Save",
            async (values) => {
                show(await gw("server", { idleMinutes: Number(values.idleMinutes) }));
                status.textContent += " Saved.";
            },
        ),
        h("h2", {}, "Now"),
        status,
        h("h2", {}, "Search in documents"),
        h("p", { class: "muted" }, "Team and project documents are searched by meaning too, with an OpenRouter embedding model and a key for it, used for nothing else. Without them, search is by keyword."),
        form(
            [
                field("Embedding model (OpenRouter)", "docsModel", "text", { required: false, value: server.docs.model ?? "", placeholder: "openai/text-embedding-3-small" }),
                field(`OpenRouter key${server.docs.keySet ? " (one is set: type a new one to replace it)" : ""}`, "docsKey", "password", { required: false, autocomplete: "off", placeholder: server.docs.keySet ? "••••••••" : "sk-or-…" }),
            ],
            "Save",
            async (values) => {
                const body = { docsModel: values.docsModel, ...(values.docsKey === "" ? {} : { docsKey: values.docsKey }) };
                const saved = await gw("server", body);

                show(saved);
                docsStatus.textContent = docsLine(saved.docs) + " Saved.";
            },
        ),
        docsStatus,
        h("h2", {}, "Backup"),
        h("p", { class: "muted" }, "One .tar.gz with this server's accounts, roles and settings, and every person's pi-phone data. It takes a while with many people. How to restore it: deploy/README.md."),
        h("a", { class: "button", href: "/auth/gw/backup", download: "" }, "Download a backup"),
    );
}

// ─── Routes ───

async function route() {
    const path = location.pathname;
    let state;

    try {
        state = await gw("state");
    } catch (failed) {
        return page("pi-phone", failed.message);
    }

    const invited = /^\/auth\/invite\/([A-Za-z0-9_-]+)$/.exec(path);

    if (invited) {
        return invite(invited[1]);
    }

    if (state.setup) {
        return setup();
    }

    if (!state.me) {
        return signIn();
    }

    if (path === "/auth/people" && (has(state.me, "people.invite") || has(state.me, "people.manage"))) {
        return people(state.me);
    }

    if (path === "/auth/roles" && has(state.me, "roles.manage")) {
        return rolesPage(state.me);
    }

    if (path === "/auth/audit" && has(state.me, "audit.view")) {
        return auditPage(state.me);
    }

    if (path === "/auth/shared" && has(state.me, "pi.use")) {
        return sharedPage(state.me);
    }

    if (path === "/auth/server" && has(state.me, "server.manage")) {
        return serverPage(state.me);
    }

    if (path === "/auth/sign-in" && next() !== "/") {
        location.href = next();

        return;
    }

    return account(state.me);
}

addEventListener("popstate", () => void route());
void route();
