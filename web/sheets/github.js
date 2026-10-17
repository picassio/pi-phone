// GitHub for the app's gh and git: sign in with a device code, see the account, sign out (src/server/github-login.ts).
// Laid out as the Providers sheet: one provider row, and the sign-in as its device-code event.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet } from "../store.js";
import { copyText, html, Loader, Sheet } from "../ui.js";

export function GitHubSheet() {
    const [status, setStatus] = useState(null);
    const load = () => api("github").then(setStatus);

    useEffect(() => {
        attempt(load);
    }, []);

    // While a code waits, ask again every few seconds: the server finishes the sign-in on its own.
    useEffect(() => {
        if (status?.state !== "waiting") {
            return undefined;
        }

        const timer = setInterval(() => attempt(load), 3000);

        return () => clearInterval(timer);
    }, [status?.state]);

    const start = () => attempt(async () => setStatus(await api("github/login", {})));
    const cancel = () => attempt(async () => (await api("github/cancel", {}), load()));
    const logout = () => attempt(async () => (await api("github/logout", {}), load()));
    const signedIn = status?.state === "signed-in";

    return html`<${Sheet} title="GitHub" onClose=${closeSheet}>
        <p class="muted small">
            Pi's <span class="mono">git</span> and <span class="mono">gh</span> use this account for private repositories, pushes, and pull requests. The sign-in stays in the app's home folder, where Pi can read it.
        </p>
        ${status === null && html`<${Loader} label="Checking GitHub" />`}
        ${
            status !== null &&
            html`<div class="sheet-list">
                <div class="provider">
                    <div>
                        <div>GitHub ${signedIn && html` <span class="ok">✓</span>`}</div>
                        <div class="muted small">
                            ${signedIn ? `signed in · ${status.login}` : status.state === "waiting" ? "signing in" : "not configured"}
                        </div>
                    </div>
                    <div class="provider-actions">
                        ${
                            signedIn
                                ? html`<button class="button small ghost" onClick=${logout}>Sign out</button>`
                                : status.state !== "waiting" &&
                                  html`<button class="button small" onClick=${start}>Sign in</button>`
                        }
                    </div>
                </div>
            </div>`
        }
        ${
            status?.state === "waiting" &&
            html`<div class="auth-event">
                    <p>
                        Enter this code at <a href=${status.verificationUri} target="_blank" rel="noopener">${status.verificationUri}</a>
                    </p>
                    <div class="code-big">${status.userCode}</div>
                    <a class="button primary wide" href=${status.verificationUri} target="_blank" rel="noopener">
                        Open GitHub
                    </a>
                    <div class="row">
                        <button class="button small" onClick=${() => copyText(status.userCode)}>Copy code</button>
                        <button class="button small ghost" onClick=${cancel}>Cancel</button>
                    </div>
                </div>
                <${Loader} label="Waiting for GitHub" />`
        }
        ${
            status?.state === "failed" &&
            html`<div class="error-box">
                <p>${status.error}</p>
                <button class="button" onClick=${start}>Start again</button>
            </div>`
        }
    <//>`;
}
