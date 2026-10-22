// Extensions: the built-in modules the owner can turn on and off (artifacts, subagents, schedules, plan mode, codemode,
// CI watch, ...), each with its tools, and reload.
import { useEffect, useState } from "preact/hooks";
import { leaveSafeMode, moduleTitle, safeMode } from "../extension-ui.js";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Loader, Sheet, Switch } from "../ui.js";
import { t } from "../i18n.js";

/** Safe mode: extensions' browser parts and the theme are off in this tab, after one broke it. */
function SafeMode() {
    if (!safeMode()) {
        return null;
    }

    return html`<div class="setting wrap safe-mode">
        <div class="grow small">${t("Extensions' browser parts are off in this tab, and so is the theme.")}</div>
        <button class="button" onClick=${leaveSafeMode}>${t("Turn them back on")}</button>
    </div>`;
}

export function ExtensionsSheet() {
    const owner = store.state.me?.role === "owner";
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(null);
    const load = () =>
        api("extensions").then(
            (result) => {
                setData(result);
                setProblem(null);
            },
            (error) => setProblem(error.message),
        );

    useEffect(() => {
        load();
    }, []);

    const change = (module, path, body) => {
        setBusy(module.file);
        attempt(async () =>
            setData(await api(`extensions/${encodeURIComponent(module.file)}${path}`, body)),
        ).finally(() => {
            setBusy(null);
            load();
        });
    };

    return html`<${Sheet} title=${t("Extensions")} onClose=${closeSheet} wide=${true}>
        <p class="muted small">
            ${owner
                ? t("Extensions give Pi its tools and checks. A change applies to every session right away and stays after restarts.")
                : t("Extensions give Pi its tools and checks. A change applies to every session right away and stays after restarts. Only the owner can change them.")}
        </p>
        <${SafeMode} />
        ${problem && html`<div class="error-box">${problem}</div>`}
        ${!data && !problem && html`<${Loader} label=${t("Loading extensions")} />`}
        ${
            data &&
            html`<div class="sheet-list">
                ${data.modules.map((module) => {
                    const tools = module.extensions.flatMap((extension) => extension.tools);

                    return html`<div class=${`extension ${module.enabled ? "" : "off"}`}>
                        <div class="extension-main">
                            <div class="extension-title">
                                ${moduleTitle(module.title)}
                                ${module.error && html` <span class="warn small">${t("· failed to load")}</span>`}
                            </div>
                            ${module.summary && html`<div class="muted small">${module.summary}</div>`}
                            ${module.error && html`<div class="error-box small">${module.error}</div>`}
                            <div class="muted small mono">
                                ${module.file}
                                ${tools.length > 0 ? t(" · tools: {tools}", { tools: tools.join(", ") }) : ""}
                                ${module.required ? t(" · required") : ""}
                            </div>
                        </div>
                        <div class="extension-actions">
                            <${Switch}
                                on=${module.enabled}
                                disabled=${!owner || module.required || busy !== null}
                                label=${module.enabled ? t("{title}: on", { title: moduleTitle(module.title) }) : t("{title}: off", { title: moduleTitle(module.title) })}
                                onChange=${() => change(module, "", { enabled: !module.enabled })}
                            />
                            ${
                                owner &&
                                module.enabled &&
                                html`<button
                                    class="link small"
                                    disabled=${busy !== null}
                                    onClick=${() => change(module, "/reload", {})}
                                >
                                    ${t("Reload")}
                                </button>`
                            }
                        </div>
                    </div>`;
                })}
            </div>`
        }
    <//>`;
}
