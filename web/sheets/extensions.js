// Extensions: the built-in modules the owner can turn on and off (artifacts, subagents, schedules, plan mode, codemode,
// CI watch, ...), each with its tools, and reload; and the owner's drop-ins from the data folder's `extensions`, with
// why the app refused one.
import { useEffect, useState } from "preact/hooks";
import { leaveSafeMode, moduleTitle, safeMode } from "../extension-ui.js";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Loader, Sheet, Switch } from "../ui.js";
import { t, tx } from "../i18n.js";

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

/** Why the app refused a drop-in (`Refusal` in `reload.ts`), in the person's language. */
function refusalText(refused) {
    if (refused.kind === "tool-names") {
        return t("Refused: its tools {names} have built-in tools' names, and the built-in ones win. Rename them in the module.", {
            names: refused.names.join(", "),
        });
    }

    return refused.missing.length > 0
        ? t("Refused: it added nothing. It needs {members}, which pi-phone does not have yet.", {
              members: refused.missing.map((name) => `host.${name}`).join(", "),
          })
        : t("Refused: it added nothing (it may need host.browser, which pi-phone does not have yet).");
}

/** Where drop-ins go, and those never loaded because a built-in module has their file's name. The owner's. */
function DropIns({ folder, clashes }) {
    return html`<div class="muted small">
            ${tx("Drop-ins: modules you put in {folder} load after these, each off until you turn it on. They can use host.ask, host.hide and host.commandEnv; not host.browser yet.", {
                folder: html`<span class="mono">${folder}</span>`,
            })}
        </div>
        ${(clashes ?? []).map(
            (clash) => html`<div class="error-box small" key=${clash.path}>
                ${tx("{file} is not loaded: a built-in module has its name. Rename the file.", { file: html`<span class="mono">${clash.path}</span>` })}
            </div>`,
        )}`;
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
        ${data?.dropIns && html`<${DropIns} folder=${data.dropIns} clashes=${data.nameClashes} />`}
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
                                ${module.source === "drop-in" && html` <span class="muted small">${t("· drop-in")}</span>`}
                                ${module.error && html` <span class="warn small">${module.refused ? t("· refused") : t("· failed to load")}</span>`}
                            </div>
                            ${module.summary && html`<div class="muted small">${module.summary}</div>`}
                            ${module.error && html`<div class="error-box small">${module.refused ? refusalText(module.refused) : module.error}</div>`}
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
