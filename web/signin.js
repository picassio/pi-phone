// The sign-in screen, for a browser that is not signed in.

import { t, tn } from "./i18n.js";
import { useEffect, useState } from "preact/hooks";
import { html } from "./ui.js";

export function SignIn() {
    const [value, setValue] = useState("");
    const [problem, setProblem] = useState("");

    // In the pi-phone app, the shell signs in with the owner token as it is now (MainActivity's bridge): after "Sign out
    // every device", the old one in this WebView's cookie no longer works.
    // Once a minute at most: a sign-in that fails lands here again, and must not loop.
    useEffect(() => {
        const last = Number(sessionStorage.getItem("pi-phone.app-sign-in") ?? 0);

        if (window.PiPhoneApp?.signIn && Date.now() - last > 60_000) {
            sessionStorage.setItem("pi-phone.app-sign-in", String(Date.now()));
            window.PiPhoneApp.signIn();
        }
    }, []);

    const go = () => {
        const text = value.trim();

        if (!text) {
            return;
        }

        // The owner's recovery code (break glass; src/server/http/sign-in.ts `recover`): six groups of four.
        if (/^([a-z0-9]{4}[\s-]*){5}[a-z0-9]{4}$/i.test(text)) {
            setProblem("");
            fetch("/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: text }) }).then(
                async (response) => {
                    if (response.ok) {
                        location.href = "/";
                    } else {
                        setProblem((await response.json().catch(() => ({}))).error ?? t("That did not work."));
                    }
                },
                () => setProblem(t("Could not reach pi-phone.")),
            );

            return;
        }

        try {
            const url = new URL(text, location.origin);

            if (url.pathname.startsWith("/join/") || url.searchParams.has("token")) {
                location.href = `${url.pathname}${url.search}`;

                return;
            }
        } catch {
            // not a URL
        }

        // Invite codes are ten lowercase letters and digits, and phones capitalize the first letter typed. Tokens are longer.
        // The invite sheet shows a code in two groups, so spaces typed or copied between them are dropped.
        const code = text.toLowerCase().replace(/\s+/g, "");

        location.href = /^[a-z0-9]{10}$/.test(code)
            ? `/join/${code}`
            : `/login?token=${encodeURIComponent(text)}`;
    };

    return html`<div class="signin" data-part="sign-in">
        <div class="pi big"><img class="brand-icon" src="icon.svg" alt="" /></div>
        <h1>${t("pi-phone")}</h1>
        <p class="muted">${t("The pi-phone app signs in by itself: close it and open it again. You can also paste a sign-in link, the token, an invite code, or your recovery code here.")}</p>
        <div class="row">
            <input
                value=${value}
                placeholder=${t("Link, token, invite, or recovery code")}
                autocapitalize="none"
                autocorrect="off"
                autocomplete="off"
                spellcheck=${false}
                onInput=${(event) => setValue(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && go()}
            />
            <button class="button primary" onClick=${go}>${t("Sign in")}</button>
        </div>
        ${problem && html`<p class="wiki-problem">${problem}</p>`}
    </div>`;
}
