/**
 * People & account on the team server (PP-80): the gateway's own pages (Account, Shared with me, People, Roles, Audit
 * log, Server) drawn in the conversation's place, as an extension's page shows, with the rail and the sessions kept. The
 * pages are the gateway's code (`/auth/static/gateway.js`, `mount`), which exists only behind the gateway, so it loads
 * when the panel opens; its styles are scoped to the panel (`.gw-embed`) and take the app's theme colors.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { t } from "./i18n.js";
import { store } from "./store.js";
import { html, Icon, Loader } from "./ui.js";

/** The page slot's module name for this panel: not an extension's (theirs come from module files). */
export const GATEWAY_PAGE = "gateway";

const PATHS = { account: "/auth/account", shared: "/auth/shared", people: "/auth/people", roles: "/auth/roles", audit: "/auth/audit", server: "/auth/server" };

/** Open People & account on a tab (`people`, `account`, …), over what the conversation's place shows. */
export function openGatewayPage(tab = "account") {
    store.set({ page: { module: GATEWAY_PAGE, id: tab }, sheet: null, launcher: false, board: false, boardAgents: null, drawer: false });
}

const close = () => store.set({ page: null });

export function GatewayPage({ tab }) {
    const box = useRef(null);
    const [failed, setFailed] = useState(null);
    const [loading, setLoading] = useState(true);

    useBack(true, close);

    // Esc closes it, as it closes an extension's page, unless a sheet or the launcher is over it, or a menu of its own
    // (a dropdown) takes Esc first.
    useEffect(() => {
        const onKey = (event) => {
            const { sheet, launcher } = store.state;

            if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented && !sheet && !launcher && !box.current?.querySelector(".choice-menu:not([hidden])")) {
                event.preventDefault();
                close();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        let gone = false;

        // Its styles, once: scoped to `.gw`, so nothing else of the app changes.
        if (document.querySelector("link[data-gateway-css]") === null) {
            document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/auth/static/gateway.css" }));
            document.head.lastElementChild?.setAttribute("data-gateway-css", "");
        }

        import("/auth/static/gateway.js")
            .then((gateway) => {
                if (!gone && box.current !== null) {
                    gateway.mount(box.current, PATHS[tab] ?? PATHS.account);
                    setLoading(false);
                }
            })
            .catch((error) => {
                if (!gone) {
                    setFailed(error instanceof Error ? error.message : String(error));
                    setLoading(false);
                }
            });

        return () => {
            gone = true;
        };
    }, [tab]);

    return html`<section class="ext-page gw-panel" data-part="gateway-page" aria-label=${t("People & account")}>
        <header class="board-head">
            <div class="board-title">
                <h2>${t("People & account")}</h2>
            </div>
            <button class="icon-button" title=${t("Back to the conversation (Esc)")} aria-label=${t("Close")} onClick=${close}>
                <${Icon} name="close" />
            </button>
        </header>
        <div class="ext-page-body">
            ${loading && html`<${Loader} />`}
            ${failed !== null && html`<p class="muted gw-failed">${t("Could not load the team server's pages: {reason}", { reason: failed })}</p>`}
            <div ref=${box}></div>
        </div>
    </section>`;
}
