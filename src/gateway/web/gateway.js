// The gateway's page (PP-21): sign in (password, then TOTP; or a passkey), the owner's setup, an invite, your account
// (password, two-factor, passkeys, sign out), and for the owner, people and invites. Plain JS, no build; text goes in
// with textContent only. better-auth's routes are /auth/api/*, the gateway's own /auth/gw/*.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "/auth/static/webauthn/index.js";
import { t, tn, tServer } from "/auth/static/i18n.js";

/** A translated sentence with elements in it: its text pieces and the given nodes, in the language's own order. */
const pieces = (sentence, vars) =>
    t(sentence)
        .split(/\{(\w+)\}/)
        .map((part, index) => (index % 2 === 1 ? (Object.hasOwn(vars, part) ? vars[part] : `{${part}}`) : part))
        .filter((part) => part !== "");

/**
 * Where the pages draw: the gateway's own page (`main#app[data-gateway]`), or the app's People & account panel
 * (`mount`, PP-80). In the panel there is no address of its own: `embedded.path` is the page shown.
 */
let app = null;
let embedded = null;
const here = () => (embedded === null ? location.pathname : embedded.path);
/** The pages the panel shows as tabs; any other (signing in or out) is the gateway's own page, whole. */
const TABS = ["/auth/account", "/auth/shared", "/auth/people", "/auth/roles", "/auth/audit", "/auth/server"];

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

    // The server's message in the person's language, when the catalog has it (PP-85).
    if (!response.ok) {
        throw new Error(tServer(data.error ?? data.message ?? `HTTP ${response.status}`));
    }

    return data;
}

const authApi = (path, body, method) => call(`/auth/api/${path}`, body, method);
const gw = (path, body, method) => call(`/auth/gw/${path}`, body, method);

function page(title, lede, ...content) {
    // A signed-in page starts with its tabs (`nav`): they go under the top bar, which then leads to your pi-phone. In the
    // app's panel there is no top bar: the panel has its title and its ×, and you are in your pi-phone already.
    const tabs = content[0] instanceof Node && content[0].classList?.contains("tabs") ? content.shift() : null;
    const top = embedded !== null ? null : h(
        "header",
        { class: "top" },
        h("a", { class: "brand", href: "/auth/account", onclick: (event) => (event.preventDefault(), go("/auth/account")) }, h("img", { src: "/auth/static/icon.svg", alt: "" }), h("b", {}, "pi-phone")),
        tabs === null ? null : h("a", { class: "button primary small", href: "/" }, t("Open my pi-phone")),
    );

    // Signed out (sign in, set up, an invite): one narrow card in the middle of the screen (PP-62).
    app.classList.toggle("solo", tabs === null && embedded === null);
    // Leaving out what is not there (a passkey button where the browser can't make one): replaceChildren would write "null".
    app.replaceChildren(
        ...[top, tabs, h("h1", {}, title), lede ? h("p", { class: "lede muted" }, lede) : null, ...content].filter((each) => each !== null && each !== undefined && each !== false),
    );
    if (embedded === null) {
        document.title = `${title} · pi-phone`;
    }

    // On a phone the tabs scroll sideways: the one you are on comes into view.
    tabs?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * A dropdown in pi-phone's own style, not the system's picker (PP-62): a field-like button with the chosen option and a
 * list under it. A hidden input named `name` holds the value, so a form's FormData has it. `onChange` runs on a new pick.
 * Arrow keys move, Enter picks, Escape or a tap elsewhere closes.
 */
function choice({ name, label, options, value, onChange, small = false }) {
    let chosen = value;
    let active = 0;
    const input = h("input", { type: "hidden", name, value });
    const text = h("span", { class: "choice-text" });
    const list = h("div", { class: "choice-menu", role: "listbox", "aria-label": label, hidden: true });
    const button = h("button", { type: "button", class: "choice", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": label }, text, h("span", { class: "choice-caret", "aria-hidden": "true" }));
    const wrap = h("span", { class: `choice-wrap${small ? " small" : ""}` }, input, button, list);
    const rows = () => [...list.children];
    const mark = () => rows().forEach((row, index) => row.classList.toggle("on", index === active));
    const away = (event) => !wrap.contains(event.target) && close();
    const close = () => {
        list.hidden = true;
        button.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", away, true);
    };
    const open = () => {
        active = Math.max(0, options.findIndex((option) => option.value === chosen));
        mark();
        list.hidden = false;
        button.setAttribute("aria-expanded", "true");
        document.addEventListener("pointerdown", away, true);
        rows()[active]?.scrollIntoView({ block: "nearest" });
    };
    const pick = (option) => {
        close();
        button.focus();

        if (option.value === chosen) {
            return;
        }

        chosen = option.value;
        input.value = option.value;
        show();
        onChange?.(option.value);
    };
    const show = () => {
        text.textContent = options.find((option) => option.value === chosen)?.label ?? "";
        rows().forEach((row, index) => row.setAttribute("aria-selected", String(options[index].value === chosen)));
    };

    list.append(...options.map((option, index) => h("button", { type: "button", class: "choice-row", role: "option", onclick: () => pick(option), onmousemove: () => ((active = index), mark()) }, option.label)));
    button.addEventListener("click", () => (list.hidden ? open() : close()));
    button.addEventListener("keydown", (event) => {
        if (list.hidden) {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
                event.preventDefault();
                open();
            }

            return;
        }

        if (event.key === "Escape" || event.key === "Tab") {
            close();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            active = Math.min(options.length - 1, Math.max(0, active + (event.key === "ArrowDown" ? 1 : -1)));
            mark();
            rows()[active]?.scrollIntoView({ block: "nearest" });
        } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            pick(options[active]);
        }
    });
    show();

    return wrap;
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
    if (embedded !== null) {
        // Signing in or out leaves the panel for the gateway's own page.
        if (!TABS.includes(path)) {
            location.href = path;

            return;
        }

        embedded.path = path;
        void route();

        return;
    }

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
                          alert(t("Passkey: {error}", { error: failed.message }));
                      }
                  },
              },
              t("Sign in with a passkey"),
          )
        : null;

    page(
        t("Sign in"),
        t("Your own pi-phone, on this server."),
        form([field(t("Email"), "email", "email", { autocomplete: "username" }), field(t("Password"), "password", "password", { autocomplete: "current-password" })], t("Sign in"), async ({ email, password }) => {
            const answer = await authApi("sign-in/email", { email, password, rememberMe: true });

            if (answer.twoFactorRedirect) {
                return twoFactorStep();
            }

            location.href = next();
        }),
        passkey ? h("p", { class: "muted or" }, t("or")) : null,
        passkey,
    );
}

/** The digits of a code as typed (an app may show "123 456"). */
const digits = (code) => String(code).replace(/\D+/g, "");

function twoFactorStep(backup = false) {
    page(
        backup ? t("Backup code") : t("Two-factor code"),
        backup ? t("One of the backup codes you saved when you turned two-factor on. Each works once.") : t("The 6-digit code your authenticator app shows for pi-phone."),
        backup
            ? form([field(t("Backup code"), "code", "text", { autocomplete: "off" })], t("Verify"), async ({ code }) => {
                  await authApi("two-factor/verify-backup-code", { code: String(code).trim() });
                  location.href = next();
              })
            : form([field(t("Code from the app"), "code", "text", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })], t("Verify"), async ({ code }) => {
                  await authApi("two-factor/verify-totp", { code: digits(code), trustDevice: false });
                  location.href = next();
              }),
        h("button", { type: "button", onclick: () => twoFactorStep(!backup) }, backup ? t("Use my authenticator app instead") : t("Use a backup code instead")),
    );
}

// ─── The owner's setup, and an invite ───

function setup() {
    page(
        t("Set up the owner"),
        t("The first account on this server: the owner's. The setup token is in the gateway's log."),
        form(
            [field(t("Setup token"), "setupToken", "password"), field(t("Your name"), "name"), field(t("Email"), "email", "email", { autocomplete: "username" }), field(t("Password (10 or more)"), "password", "password", { minlength: 10, autocomplete: "new-password" })],
            t("Create the owner"),
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
        return page(t("Invite"), failed.message, h("a", { class: "button", href: "/auth/sign-in" }, t("Sign in")));
    }

    page(
        t("Join pi-phone"),
        t("You're invited as {role}. Your own pi-phone starts when you first open it.", { role: live.role }),
        form([field(t("Your name"), "name"), field(t("Email"), "email", "email", { autocomplete: "username" }), field(t("Password (10 or more)"), "password", "password", { minlength: 10, autocomplete: "new-password" })], t("Create my account"), async ({ name, email, password }) => {
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
        t("Account"),
        `${me.name} · ${me.email} · ${me.roleName ?? me.role}`,
        nav(me),
        h("h2", {}, t("Two-factor sign-in")),
        twoFactor,
        h("h2", {}, t("Passkeys")),
        passkeys,
        h("h2", {}, t("Password")),
        h(
            "div",
            { class: "card" },
            form([field(t("Current password"), "currentPassword", "password", { autocomplete: "current-password" }), field(t("New password (10 or more)"), "newPassword", "password", { minlength: 10, autocomplete: "new-password" })], t("Change password"), async ({ currentPassword, newPassword }) => {
                await authApi("change-password", { currentPassword, newPassword, revokeOtherSessions: true });
                alert(t("Password changed; your other devices are signed out."));
            }),
        ),
        h("div", { class: "signout" }, h("button", { onclick: async () => (await authApi("sign-out", {}), go("/auth/sign-in")) }, t("Sign out"))),
    );

    renderTwoFactor(twoFactor, me);
    void renderPasskeys(passkeys);
}

function renderTwoFactor(box, me) {
    if (me.twoFactor) {
        box.replaceChildren(
            h("p", { class: "ok" }, t("On: signing in asks for a code from your authenticator app.")),
            form([field(t("Password"), "password", "password", { autocomplete: "current-password" })], t("Turn off"), async ({ password }) => {
                await authApi("two-factor/disable", { password });
                renderTwoFactor(box, { ...me, twoFactor: false });
            }),
        );

        return;
    }

    box.replaceChildren(
        h("p", { class: "muted" }, t("Off. Turn it on to ask for a code from an authenticator app after your password.")),
        form([field(t("Password"), "password", "password", { autocomplete: "current-password" })], t("Turn on"), async ({ password }) => {
            const { totpURI, backupCodes } = await authApi("two-factor/enable", { password });
            const qr = await gw("qr", { text: totpURI });
            const key = new URL(totpURI).searchParams.get("secret") ?? "";
            const copy = (text, button) => async () => {
                await navigator.clipboard.writeText(text);
                button.textContent = t("Copied");
            };
            const copyKey = h("button", { type: "button" }, t("Copy setup key"));
            const copyCodes = h("button", { type: "button" }, t("Copy backup codes"));

            copyKey.addEventListener("click", copy(key, copyKey));
            copyCodes.addEventListener("click", copy(backupCodes.join("\n"), copyCodes));
            box.replaceChildren(
                h("p", {}, pieces("{step} (1Password, Google Authenticator, Authy…):", { step: h("b", {}, t("1. Add pi-phone to your authenticator app")) })),
                h(
                    "div",
                    { class: "row" },
                    h("a", { class: "button primary", href: totpURI }, t("Open in authenticator app")),
                    copyKey,
                ),
                h("p", { class: "muted" }, pieces("Or type the setup key into the app's one-time password field: {key}", { key: h("span", { class: "code" }, key.replace(/(.{4})/g, "$1 ").trim()) })),
                h("p", { class: "muted" }, t("Or scan this from another device:")),
                h("img", { class: "qr", src: qr.svg, alt: t("QR code for your authenticator app") }),
                h("p", {}, pieces("{step} (not a backup code):", { step: h("b", {}, t("2. Type the 6-digit code the app now shows for pi-phone")) })),
                form([field(t("Code from the app"), "code", "text", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })], t("Finish"), async ({ code }) => {
                    await authApi("two-factor/verify-totp", { code: digits(code) });
                    renderTwoFactor(box, { ...me, twoFactor: true });
                }),
                h("p", {}, pieces("{step}: spares for signing in if you lose your app, each usable once. Not for step 2.", { step: h("b", {}, t("3. Save the backup codes")) })),
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
                          alert(t("Passkey: {error}", { error: failed.message }));
                      }
                  },
              },
              t("Add a passkey"),
          )
        : h("p", { class: "muted" }, t("This browser can't make passkeys."));

    box.replaceChildren(
        list.length === 0
            ? h("p", { class: "muted" }, t("None yet: a passkey signs you in without your password."))
            : h(
                  "div",
                  { class: "list" },
                  list.map((each) =>
                      h(
                          "div",
                          { class: "spread" },
                          h("span", {}, each.name || t("Passkey"), " ", h("span", { class: "muted" }, new Date(each.createdAt).toLocaleDateString())),
                          h("button", { class: "danger", onclick: async () => (await authApi("passkey/delete-passkey", { id: each.id }), renderPasskeys(box)) }, t("Remove")),
                      ),
                  ),
              ),
        add,
    );
}

// ─── People (the owner, or a role with people.invite / people.manage) ───

const has = (me, permission) => (me.permissions ?? []).includes(permission);
/** The gateway's pages, as tabs (one row, scrolled sideways on a phone), the one shown marked. */
const nav = (me) => {
    const tab = (path, label) =>
        h("a", { class: "tab", href: path, "aria-current": here() === path ? "page" : null, onclick: (event) => (event.preventDefault(), go(path)) }, label);

    return h(
        "nav",
        { class: "tabs", "aria-label": t("Pages") },
        tab("/auth/account", t("Account")),
        has(me, "pi.use") ? tab("/auth/shared", t("Shared with me")) : null,
        has(me, "people.invite") || has(me, "people.manage") ? tab("/auth/people", t("People")) : null,
        has(me, "roles.manage") ? tab("/auth/roles", t("Roles")) : null,
        has(me, "audit.view") ? tab("/auth/audit", t("Audit log")) : null,
        has(me, "server.manage") ? tab("/auth/server", t("Server")) : null,
    );
};

async function people(me) {
    const listBox = h("div", { class: "list" });
    const invitesBox = h("div", { class: "list" });
    // The link just made, in place (PP-80): no dialog, so it reads the same on the page and in the app's panel.
    const madeBox = h("div", { class: "made-link", hidden: true });
    const { roles } = await gw("roles");
    const offered = roles.filter((role) => role.id !== "owner" || me.role === "owner");

    page(
        t("People"),
        t("Everyone with an account here. Each has their own pi-phone, by their role."),
        nav(me),
        has(me, "people.invite") ? h("h2", {}, t("Invite someone")) : null,
        has(me, "people.invite")
            ? h(
                  "div",
                  { class: "card" },
                  form(
                      [
                          h(
                              "div",
                              { class: "pair" },
                              h("div", { class: "field" }, h("span", {}, t("Role")), choice({ name: "role", label: t("Role"), value: offered.some((role) => role.id === "member") ? "member" : offered[0]?.id, options: offered.map((role) => ({ value: role.id, label: role.name })) })),
                              h(
                                  "div",
                                  { class: "field" },
                                  h("span", {}, t("Lasts")),
                                  choice({
                                      name: "minutes",
                                      label: t("Lasts"),
                                      value: "1440",
                                      options: [
                                          { value: "60", label: t("1 hour") },
                                          { value: "1440", label: t("1 day") },
                                          { value: "10080", label: t("7 days") },
                                      ],
                                  }),
                              ),
                          ),
                      ],
                      t("Make an invite link"),
                      async ({ role, minutes }) => {
                          const made = await gw("invites", { role, minutes: Number(minutes) });

                          const copied = await navigator.clipboard?.writeText(made.url).then(() => true, () => false);
                          const copy = h("button", { type: "button", class: "small" }, copied ? t("Copied") : t("Copy"));

                          copy.addEventListener("click", async () => {
                              copy.textContent = (await navigator.clipboard?.writeText(made.url).then(() => true, () => false)) ? t("Copied") : t("Copy it from the box");
                          });
                          madeBox.replaceChildren(h("span", { class: "muted" }, t("Invite link: send it to them; it works once.")), h("div", { class: "made-row" }, h("input", { readonly: true, value: made.url, "aria-label": t("Invite link"), onfocus: (event) => event.target.select() }), copy));
                          madeBox.hidden = false;
                          void renderInvites(invitesBox, roles);
                      },
                  ),
                  madeBox,
              )
            : null,
        has(me, "people.invite") ? h("h2", {}, t("Invites")) : null,
        has(me, "people.invite") ? invitesBox : null,
        h("h2", {}, t("Accounts")),
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

    // Only invites still open; used and expired ones are a count.
    const open = invites.filter((each) => !each.usedBy && each.expiresAt > now);
    const done = invites.length - open.length;

    box.replaceChildren(
        ...(open.length === 0
            ? [h("p", { class: "muted" }, done > 0 ? tn(done, "No open invites · {n} used or expired.", "No open invites · {n} used or expired.") : t("No open invites."))]
            : open.map((each) =>
                  h(
                      "div",
                      { class: "card spread" },
                      h("span", {}, h("span", { class: "tag" }, nameOf(each.role)), " ", h("span", { class: "muted" }, t("until {time}", { time: new Date(each.expiresAt).toLocaleString() }))),
                      h("button", { class: "small", onclick: async () => (await gw(`invites/${each.code}/cancel`, {}), renderInvites(box, roles)) }, t("Cancel")),
                  ),
              )),
        // replaceChildren writes null as text: only what is there.
        ...(open.length > 0 && done > 0 ? [h("p", { class: "muted small" }, tn(done, "{n} used or expired.", "{n} used or expired."))] : []),
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
            const roleSelect = choice({
                name: "role",
                label: t("{name}'s role", { name: person.name }),
                small: true,
                value: person.role,
                options: roles.filter((role) => role.id !== "owner" || me.role === "owner" || person.role === "owner").map((role) => ({ value: role.id, label: role.name })),
                onChange: (role) => act(person, "role", { role }),
            });

            // Who (name, chips, email), their role and Always on, then what can be done: small buttons in one row.
            return h(
                "div",
                { class: "card person" },
                h(
                    "div",
                    { class: "person-head" },
                    h("div", {}, h("b", {}, person.name), h("div", { class: "muted small" }, person.email)),
                    h("div", { class: "chips" }, mayAct ? null : h("span", { class: "tag" }, person.roleName), person.banned ? h("span", { class: "tag bad" }, t("disabled")) : null, person.twoFactor ? h("span", { class: "tag" }, t("2FA")) : null),
                ),
                mayAct || (has(me, "server.manage") && !person.banned)
                    ? h(
                          "div",
                          { class: "person-set" },
                          mayAct ? h("span", { class: "inline" }, t("Role"), roleSelect) : null,
                          has(me, "server.manage") && !person.banned
                              ? h(
                                    "label",
                                    { class: "check", title: t("Never stopped when idle; started by itself, so scheduled messages run without a visit") },
                                    h("input", { type: "checkbox", checked: person.alwaysOn, onchange: (event) => act(person, "always-on", { on: event.target.checked }) }),
                                    " ",
                                    t("Always on"),
                                )
                              : null,
                      )
                    : null,
                h(
                    "div",
                    { class: "row actions" },
                    has(me, "server.manage") && person.box && (person.role !== "owner" || me.role === "owner")
                        ? h("a", { class: "button small", href: `/auth/gw/people/${person.id}/export`, download: "", title: t("Their pi-phone's data (sessions, settings, files) as a .tar.gz") }, t("Download data"))
                        : null,
                    mayAct ? h("button", { class: "small", onclick: () => { const password = prompt(t("New password for {name} (10 or more):", { name: person.name })); if (password) void act(person, "reset-password", { password }); } }, t("Reset password")) : null,
                    mayAct && person.twoFactor ? h("button", { class: "small", onclick: () => confirm(t("Remove {name}'s two-factor? They set it up again.", { name: person.name })) && act(person, "reset-two-factor") }, t("Reset 2FA")) : null,
                    mayAct ? (person.banned ? h("button", { class: "small", onclick: () => act(person, "enable") }, t("Enable")) : h("button", { class: "small", onclick: () => confirm(t("Disable {name}? Their pi-phone stops.", { name: person.name })) && act(person, "disable") }, t("Disable"))) : null,
                    mayAct ? h("button", { class: "small danger", onclick: () => confirm(t("Remove {name}'s account? Their data is kept.", { name: person.name })) && act(person, "remove") }, t("Remove")) : null,
                ),
            );
        }),
    );
}

// ─── Roles (roles.manage) ───

async function rolesPage(me) {
    const { roles, counts, catalogue, teamAccounts } = await gw("roles");
    const editor = (role) => {
        const fields = [
            field(t("Name"), "name", "text", { value: role?.name ?? "", maxlength: 40 }),
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
            // The team accounts its people may use (PP-69); the owner's role uses every one.
            teamAccounts.length === 0
                ? null
                : h(
                      "fieldset",
                      { class: "card" },
                      h("legend", {}, t("Team accounts they may use")),
                      ...teamAccounts.map((account) =>
                          h(
                              "label",
                              { class: "check" },
                              h("input", { type: "checkbox", name: `t:${account.id}`, checked: role?.teamAccounts?.includes(account.id) ?? false }),
                              h("span", {}, account.name, account.configured ? null : h("span", { class: "muted" }, " ", t("needs sign-in"))),
                          ),
                      ),
                  ),
            h("div", { class: "row" }, field(t("Memory (MB)"), "memoryMb", "number", { value: role?.memoryMb ?? 2048, min: 256, max: 16384, step: 256 }), field(t("CPUs"), "cpus", "number", { value: role?.cpus ?? 1, min: 0.25, max: 8, step: 0.25 })),
            h("label", {}, t("Models they may use: one provider/model per line, none for any"), h("textarea", { name: "models", rows: 3 }, (role?.models ?? []).join("\n"))),
            h("label", {}, t("Spend limit, dollars a month: empty for none"), h("input", { name: "spendLimit", type: "number", min: 0, step: "any", value: role?.spendLimit ?? "" })),
            // Apart from their own spend (PP-73): what each may spend on the team's accounts.
            teamAccounts.length === 0
                ? null
                : h("label", {}, t("Team spend limit, dollars a month each, on the team's accounts: empty for none"), h("input", { name: "teamSpendLimit", type: "number", min: 0, step: "any", value: role?.teamSpendLimit ?? "" })),
        ];
        const body = (values) => ({
            name: values.name,
            permissions: Object.keys(values).filter((key) => key.startsWith("p:")).map((key) => key.slice(2)),
            teamAccounts: Object.keys(values).filter((key) => key.startsWith("t:")).map((key) => key.slice(2)),
            memoryMb: Number(values.memoryMb),
            cpus: Number(values.cpus),
            models: String(values.models ?? "").split("\n"),
            spendLimit: values.spendLimit === "" ? null : Number(values.spendLimit),
            teamSpendLimit: values.teamSpendLimit === undefined || values.teamSpendLimit === "" ? null : Number(values.teamSpendLimit),
        });

        return form(fields, role ? t("Save") : t("Add the role"), async (values) => {
            await gw(role ? `roles/${role.id}` : "roles", body(values));
            void rolesPage(me);
        });
    };

    page(
        t("Roles"),
        t("What each role's people may do, and their pi-phone's memory, CPUs, models and spend. Changes reach a pi-phone when it next starts."),
        nav(me),
        ...roles.map((role) =>
            h(
                "details",
                { class: "card" },
                h("summary", {}, h("span", { class: "grow" }, role.name), h("span", { class: "tag" }, tn(counts[role.id] ?? 0, "{n} person", "{n} people")), role.builtin ? h("span", { class: "tag" }, t("built in")) : null),
                role.builtin
                    ? h("p", { class: "muted" }, t("The owner's role has every permission, and isn't editable."))
                    : h(
                          "div",
                          {},
                          editor(role),
                          h(
                              "button",
                              {
                                  class: "danger small delete-role",
                                  onclick: async () => {
                                      if (!confirm(t("Delete the role {name}?", { name: role.name }))) {
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
                              t("Delete the role"),
                          ),
                      ),
            ),
        ),
        // A new role's form only once asked for: it is long.
        h("details", { class: "card new-role" }, h("summary", {}, h("span", { class: "grow" }, t("+ New role"))), editor(undefined)),
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
    const who = (id) => (id?.startsWith("pi:") ? t("Pi for {name}", { name: names[id.slice(3)] ?? id.slice(3) }) : (names[id] ?? id));

    page(
        t("Audit log"),
        t("Who changed what: invites, roles, people, shared sessions; and sign-ins that failed or were blocked."),
        nav(me),
        // One card, a row per entry (PP-62): what and to whom, then when and by whom, and the detail that matters.
        entries.length === 0
            ? h("p", { class: "muted" }, t("Nothing yet."))
            : h(
                  "div",
                  { class: "card log" },
                  entries.map((entry) => {
                      const when = new Date(entry.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
                      // A failed or blocked sign-in has nobody behind it yet (PP-26): when, how, and from where.
                      const detail = entry.details?.ip
                          ? t("{how} · from {ip}", { how: entry.details.how ?? entry.details.path ?? "", ip: entry.details.ip })
                          : entry.details?.title
                            ? entry.details.title
                            : entry.details?.role?.name
                              ? t("role: {name}", { name: entry.details.role.name })
                              : entry.details?.to
                                ? `${entry.details.from} → ${entry.details.to}`
                                : null;

                      return h(
                          "div",
                          { class: "log-row" },
                          h("div", {}, h("b", {}, entry.action.charAt(0).toUpperCase() + entry.action.slice(1)), entry.target ? h("span", {}, " · ", who(entry.target)) : null),
                          h("div", { class: "muted small" }, `${entry.actor ? t("{when} · by {who}", { when, who: who(entry.actor) }) : when}${detail === null ? "" : ` · ${detail}`}`),
                      );
                  }),
              ),
    );
}

// ─── Shared with me ───

async function sharedPage(me) {
    const { boards, sessions } = await gw("shared");

    page(
        t("Shared with me"),
        t("Sessions others share with you open in their pi-phone, on their providers: you watch, or write if they let you. Boards open in your own pi-phone, where your Pi works on them in your own copy of the code."),
        nav(me),
        h("h2", {}, t("Sessions")),
        h(
            "div",
            { class: "list" },
            sessions.length === 0
                ? h("p", { class: "muted" }, t("Nothing yet."))
                : sessions.map((session) =>
                      h("a", { class: "card", href: session.url }, h("div", {}, h("b", {}, session.title), h("span", { class: "muted small" }, session.level === "write" ? t("You can write · shared by {name}", { name: session.by }) : t("You can watch · shared by {name}", { name: session.by })))),
                  ),
        ),
        h("h2", {}, t("Boards")),
        h(
            "div",
            { class: "list" },
            boards.length === 0
                ? h("p", { class: "muted" }, t("Nothing yet."))
                : boards.map((board) =>
                      h(
                          "a",
                          { class: "card", href: `/#project:${board.key}` },
                          h("div", {}, h("div", {}, h("span", { class: "tag key" }, board.key), " ", h("b", {}, board.name)), h("span", { class: "muted small" }, board.team ? (board.open ? t("A team board, open to everyone") : t("A team board")) : t("Shared by {name}", { name: board.by }))),
                      ),
                  ),
        ),
    );
}

// ─── Server ───

/** This month's spend on the team's accounts (PP-73): a line per person, their total against their role's limit, then each account. */
function teamSpendCard(spend) {
    const dollars = (cost) => (cost > 0 && cost < 0.01 ? t("under $0.01") : `$${cost.toFixed(2)}`);
    const people = new Map();

    for (const row of spend.rows) {
        const person = people.get(row.userId) ?? { name: row.name, limit: row.limit, cost: 0, accounts: [] };

        person.cost += row.cost;
        person.accounts.push(t("{account} {cost} · {tokens} tokens", { account: row.accountName, cost: dollars(row.cost), tokens: row.tokens.toLocaleString() }));
        people.set(row.userId, person);
    }

    const month = new Date(`${spend.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

    return [
        h("h2", {}, t("Team accounts' spend")),
        people.size === 0
            ? h("div", { class: "card" }, h("p", { class: "muted" }, t("Nobody has used the team's accounts in {month}.", { month })))
            : h(
                  "div",
                  { class: "card log" },
                  ...[...people.values()].map((person) =>
                      h(
                          "div",
                          { class: "log-row" },
                          h("div", {}, h("b", {}, person.name), " · ", dollars(person.cost), person.limit === null ? null : h("span", { class: person.cost >= person.limit ? "gw-spend-over" : "muted" }, " ", t("of ${limit}", { limit: person.limit }))),
                          h("div", { class: "muted small" }, person.accounts.join(" · ")),
                      ),
                  ),
                  h("p", { class: "muted small gw-spend-note" }, t("{month}, counted here after each answer. A role's team spend limit is on the Roles page.", { month })),
              ),
    ];
}

async function serverPage(me) {
    // What runs now, in figures at the top; then each setting in its own card (PP-62).
    const stats = h("div", { class: "stats" });
    const show = (server) => {
        const { all, running, outdated } = server.containers;
        const stat = (value, label) => h("div", { class: "stat" }, h("b", {}, String(value)), h("span", { class: "muted small" }, label));

        stats.replaceChildren(stat(all, tn(all, "pi-phone", "pi-phones")), stat(running, t("running")), stat(outdated, t("on an older image")));
        renewing.textContent =
            outdated === 0
                ? ""
                : tn(
                      outdated,
                      "The one on an older image is made again from the new one when Pi isn't at work there, or at the next start.",
                      "Those on an older image are made again from the new one when Pi isn't at work there, or at the next start.",
                  );
    };
    const renewing = h("p", { class: "muted small" });
    const server = await gw("server");
    const docsLine = (docs) =>
        docs.model === null || !docs.keySet
            ? t("By keyword only for now.")
            : docs.month.cost > 0
              ? t("By meaning with {model}: {embedded} of {passages} passages indexed. This month: {tokens} tokens, {cost}.", {
                    model: docs.model,
                    embedded: docs.indexed.embedded,
                    passages: docs.indexed.passages,
                    tokens: docs.month.tokens.toLocaleString(),
                    cost: docs.month.cost < 0.01 ? t("under $0.01") : `$${docs.month.cost.toFixed(2)}`,
                })
              : t("By meaning with {model}: {embedded} of {passages} passages indexed. This month: {tokens} tokens.", {
                    model: docs.model,
                    embedded: docs.indexed.embedded,
                    passages: docs.indexed.passages,
                    tokens: docs.month.tokens.toLocaleString(),
                });
    const docsStatus = h("p", { class: "muted small" }, docsLine(server.docs));
    const saved = h("span", { class: "ok small" });

    show(server);
    page(
        t("Server"),
        t("How this server runs people's pi-phones."),
        nav(me),
        stats,
        renewing,
        h("h2", {}, t("Idle pi-phones")),
        h(
            "div",
            { class: "card" },
            h("p", { class: "muted" }, t("A pi-phone stops when nobody has it open and it isn't at work (Pi writing, tools, scheduled messages). It starts again on the next visit, in a few seconds.")),
            form(
                [h("div", { class: "inline-field" }, field(t("Stop after this many minutes unused (0: never)"), "idleMinutes", "number", { min: "0", max: "1440", step: "1", value: String(server.idleMinutes) }), saved)],
                t("Save"),
                async (values) => {
                    show(await gw("server", { idleMinutes: Number(values.idleMinutes) }));
                    saved.textContent = t("Saved.");
                },
            ),
        ),
        h("h2", {}, t("Search in documents")),
        h(
            "div",
            { class: "card" },
            h("p", { class: "muted" }, t("Team and project documents are searched by meaning too, with an OpenRouter embedding model and a key for it, used for nothing else. With an image description model, pictures in them are found by what they show. Without them: by keyword, and pictures by name.")),
            docsStatus,
            form(
                [
                    field(t("Embedding model (OpenRouter)"), "docsModel", "text", { required: false, value: server.docs.model ?? "", placeholder: "openai/text-embedding-3-small" }),
                    field(t("Image description model (OpenRouter, reads images)"), "docsVision", "text", { required: false, value: server.docs.vision ?? "", placeholder: "google/gemini-2.5-flash" }),
                    field(server.docs.keySet ? t("OpenRouter key (one is set: type a new one to replace it)") : t("OpenRouter key"), "docsKey", "password", { required: false, autocomplete: "off", placeholder: server.docs.keySet ? "••••••••" : "sk-or-…" }),
                ],
                t("Save"),
                async (values) => {
                    const body = { docsModel: values.docsModel, docsVision: values.docsVision, ...(values.docsKey === "" ? {} : { docsKey: values.docsKey }) };
                    const answer = await gw("server", body);

                    show(answer);
                    docsStatus.textContent = t("{status} Saved.", { status: docsLine(answer.docs) });
                },
            ),
        ),
        ...teamSpendCard(server.teamSpend),
        h("h2", {}, t("Backup")),
        h(
            "div",
            { class: "card" },
            h("p", { class: "muted" }, t("One .tar.gz with this server's accounts, roles and settings, shared boards and documents, and every person's pi-phone data. It takes a while with many people. How to restore it: deploy/README.md.")),
            h("a", { class: "button", href: "/auth/gw/backup", download: "" }, t("Download a backup")),
        ),
    );
}

// ─── Routes ───

async function route() {
    const path = here();
    let state;

    try {
        state = await gw("state");
    } catch (failed) {
        return page("pi-phone", failed.message);
    }

    // The panel is for someone signed in: signing in is the gateway's own page.
    if (embedded !== null && (state.setup || !state.me)) {
        location.href = "/auth/sign-in";

        return;
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

    // A tab this role may not open shows Account, marked as such.
    if (embedded !== null) {
        embedded.path = "/auth/account";
    }

    return account(state.me);
}

/**
 * Draw the pages in `box` (the app's People & account panel, PP-80) at `path` (one of the tabs; Account by default),
 * with the app's theme. Tabs change the page inside the box; signing out leaves for the gateway's own page.
 */
export function mount(box, path = "/auth/account") {
    app = box;
    embedded = { path: TABS.includes(path) ? path : "/auth/account" };
    box.classList.add("gw", "gw-embed");
    void route();
}

// The gateway's own page: its root is marked, so importing this module into the app (whose root is #app too) draws
// nothing until `mount`.
const own = document.querySelector("main#app[data-gateway]");

if (own !== null) {
    app = own;
    addEventListener("popstate", () => void route());
    void route();
}
