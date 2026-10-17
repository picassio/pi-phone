// The extension gallery: drop-ins and themes other people wrote, from a reviewed index. Browse and search them, read
// one's code before it is installed, install it (a drop-in off; a theme into Appearance's list, not applied), ask Pi to
// review a drop-in, turn it on, update it with a diff, remove it; and share your own as a draft index entry. The
// owner's alone; the server side is src/server/gallery.ts.
//
// Everything the index says is untrusted: it shows as text only, and links go only to addresses the server built.
import { useEffect, useRef, useState } from "preact/hooks";
import { planAvailable } from "../commands.js";
import { DiffBlock } from "../diff.js";
import { Highlighted } from "../rich.js";
import {
    actions,
    api,
    attempt,
    closeSheet,
    navigate,
    notify,
    openSheet,
    store,
    uid,
} from "../store.js";
import { BASE_LOOK, prefs, setPrefs } from "../theme.js";
import { copyText, formatBytes, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

/** The owner's, while its module is on. */
export const galleryAvailable = () =>
    store.state.me?.role === "owner" &&
    store.state.server?.extensions?.includes("pocket-gallery") === true;

/** The gallery's routes: GET without a body, POST with one; `options.signal` stops it. */
export const galleryApi = (path, body, options) => api(`x/gallery/${path}`, body, options);

/**
 * Read a route while a sheet shows, and stop when it closes: a download of an extension's files goes no further, and
 * its answer reaches no sheet that is gone.
 */
function useRoute(path, setData, setProblem) {
    useEffect(() => {
        const stop = new AbortController();

        galleryApi(path, undefined, { signal: stop.signal }).then(
            (result) => !stop.signal.aborted && setData(result),
            (error) => !stop.signal.aborted && setProblem(error.message),
        );

        return () => stop.abort();
    }, [path]);
}

const short = (commit) => (commit ?? "").slice(0, 7);
const plural = (count, word) =>
    `${count} ${count === 1 ? word : word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`}`;
const revocation = (entry, commit) => entry.revoked.find((each) => each.commit === commit)?.reason;

/** Who a browser module or a route is for, in words. */
export const ACCESS_WORDS = {
    owner: "the owner",
    steer: "people who can steer",
    view: "everyone who sees every session",
};

/** What a module declares, by group, in the order the entry and the review list them. */
const GROUPS = [
    ["extensions", "Extensions"],
    ["tools", "Tools"],
    ["readOnlyTools", "Read-only tools"],
    ["hooks", "Hooks"],
    ["sections", "Prompt sections"],
    ["wraps", "Wraps"],
    ["routes", "Routes"],
    ["commands", "Slash commands"],
];

/**
 * One group of what a module declares, as names to show: a command with its slash, and who may run it. Older entries
 * lack some groups.
 */
const declared = (declares, key) =>
    (declares[key] ?? []).map((each) => {
        if (key !== "commands") {
            return each;
        }

        const [scope, name] = each.split(" ");

        return `/${name} (${scope === "global" ? "owner" : "who can steer"})`;
    });

const RISK =
    "A drop-in runs inside the server with your rights, in every session. Lancet Guard does not see what its code does.";
const THEME_RISK =
    "A theme is CSS, fonts, and images. It runs no code, and it loads nothing from other sites. But it can hide or relabel what people see, approvals too: install only themes you trust.";

const isTheme = (item) => item?.kind === "theme";

/** A link out, to an address the server built (or a GitHub profile): never one the index wrote. */
const Out = ({ href, class: className = "", children }) =>
    html`<a class=${className} href=${href} target="_blank" rel="noopener noreferrer">${children}</a>`;

/** The last index read, so an entry opened from the list shows at once while it is read again. */
let lastListing = null;

function useListing() {
    const [data, setData] = useState(lastListing);
    const [problem, setProblem] = useState(null);
    const [loading, setLoading] = useState(true);
    const live = useRef(true);

    const load = (refresh = false) => {
        setLoading(true);

        return galleryApi(`index${refresh ? "?refresh=1" : ""}`)
            .then(
                (result) => {
                    lastListing = result;

                    if (live.current) {
                        setData(result);
                        setProblem(null);
                    }
                },
                (error) => live.current && setProblem(error.message),
            )
            .finally(() => live.current && setLoading(false));
    };

    useEffect(() => {
        load();

        return () => {
            live.current = false;
        };
    }, []);

    return { data, problem, loading, load };
}

/** How an installed extension stands, as small pills. */
function StatePills({ installed }) {
    if (!installed) {
        return null;
    }

    return html`<span class="gallery-pills">
        ${installed.revoked !== null && html`<span class="pi-tag gallery-bad">revoked</span>`}
        ${installed.update && html`<span class="pi-tag behind">update available</span>`}
        ${installed.enabled ? html`<span class="pi-tag gallery-on">on</span>` : html`<span class="pi-tag gallery-plain">installed</span>`}
    </span>`;
}

function EntryRow({ entry }) {
    return html`<button
        class="gallery-row"
        onClick=${() => openSheet({ type: "gallery-entry", id: entry.name })}
    >
        <span class="gallery-row-text">
            <span class="gallery-row-head">
                <span class="gallery-row-title">${entry.title}</span>
                <span class="gallery-row-name mono">${entry.name}</span>
                ${isTheme(entry) && html`<span class="pi-tag gallery-plain">Theme</span>`}
            </span>
            ${entry.description && html`<span class="gallery-row-desc">${entry.description}</span>`}
            <span class="gallery-row-meta">
                ${entry.tags.map((tag) => html`<span class="gallery-tag-text" key=${tag}>#${tag}</span>`)}
                <span>${entry.author.name} · v${entry.version}</span>
            </span>
            <${StatePills} installed=${entry.installed} />
        </span>
        <${Icon} name="chevron" size=${14} />
    </button>`;
}

/** The most common tags first, at most `limit`. */
function topTags(entries, limit) {
    const counts = new Map();

    for (const entry of entries) {
        for (const tag of entry.tags) {
            counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
    }

    return [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([tag]) => tag);
}

/** Where the index is read from, and changing it (empty is the default). */
function IndexAddress({ address, onChanged }) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(address);
    const [fallback, setFallback] = useState(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);

    useEffect(() => {
        if (editing && fallback === null) {
            galleryApi("settings").then(
                (result) => setFallback(result.default),
                () => {},
            );
        }
    }, [editing]);

    const save = async (index) => {
        setBusy(true);
        setProblem(null);

        try {
            const result = await galleryApi("settings", { index });

            setValue(result.index);
            setEditing(false);
            onChanged();
        } catch (error) {
            setProblem(error.message);
        } finally {
            setBusy(false);
        }
    };

    if (!editing) {
        return html`<div class="setting wrap">
            <div class="grow small">
                <div class="muted">Index</div>
                <div class="mono gallery-address">${address}</div>
            </div>
            <button
                class="button small"
                onClick=${() => {
                    setValue(address);
                    setEditing(true);
                }}
            >
                Change
            </button>
        </div>`;
    }

    return html`<form
        class="field gallery-index-form"
        onSubmit=${(event) => {
            event.preventDefault();
            save(value.trim());
        }}
    >
        <label class="label" for="gallery-index">
            Index: a GitHub repository (owner/name), or the https address of an index.json
        </label>
        <input
            id="gallery-index"
            class="mono"
            value=${value}
            autofocus
            spellcheck=${false}
            autocapitalize="off"
            onInput=${(event) => setValue(event.currentTarget.value)}
        />
        ${problem && html`<div class="error-box small">${problem}</div>`}
        <div class="sheet-actions gallery-wrap">
            ${
                fallback !== null &&
                fallback !== address &&
                html`<button type="button" class="button small ghost" disabled=${busy} onClick=${() => save("")}>
                    Use the default (${fallback})
                </button>`
            }
            <button type="button" class="button small" onClick=${() => setEditing(false)}>Cancel</button>
            <button class="button small primary" disabled=${busy}>Save</button>
        </div>
    </form>`;
}

/** Browse: search, tag pills, and the entries for this Pi Pocket. */
export function GallerySheet() {
    const { data, problem, loading, load } = useListing();
    const [query, setQuery] = useState("");
    const [tag, setTag] = useState(null);
    // "theme", "extension", or null for both.
    const [kind, setKind] = useState(null);
    const [showInvalid, setShowInvalid] = useState(false);
    const needle = query.trim().toLowerCase();
    // A version the index revoked is not offered, unless it is the one installed here.
    const offered = (data?.entries ?? []).filter(
        (entry) => entry.installed !== null || revocation(entry, entry.source.commit) === undefined,
    );
    const tags = topTags(offered, 10);
    // The kinds as a filter, while the index offers both.
    const kinds = offered.some(isTheme) && !offered.every(isTheme) ? ["extension", "theme"] : [];
    const matches = offered.filter(
        (entry) =>
            (kind === null || (kind === "theme") === isTheme(entry)) &&
            (tag === null || entry.tags.includes(tag)) &&
            (needle === "" ||
                [entry.name, entry.title, entry.description, ...entry.tags].some((text) =>
                    text.toLowerCase().includes(needle),
                )),
    );
    const elsewhere = (data?.installed ?? []).filter((each) => !each.listed);
    const hidden = data?.hidden ?? { incompatible: 0, invalid: [] };

    return html`<${Sheet} title="Find extensions" onClose=${closeSheet} wide=${true} className="gallery">
        <p class="muted small">
            Drop-ins and themes other people wrote, from a reviewed index. Drop-ins install turned off: read their code, or ask Pi to review it, before you turn one on. A theme installs into the list in Appearance, where each person can choose it.
        </p>
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${data?.error && html`<div class="error-box small">${data.error}</div>`}
        ${!data && !problem && html`<${Loader} label="Reading the index" />`}
        ${
            data &&
            offered.length > 0 &&
            html`<input
                class="find-input"
                type="search"
                autofocus
                placeholder=${offered.some(isTheme) ? "Search extensions and themes" : "Search extensions"}
                aria-label="Search the gallery: names, descriptions, and tags"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />`
        }
        ${
            (tags.length > 1 || kinds.length > 0) &&
            html`<div class="gallery-tags" role="group" aria-label="Kinds and tags">
                ${kinds.map(
                    (each) => html`<button
                        key=${`kind-${each}`}
                        class=${`gallery-tag ${kind === each ? "on" : ""}`}
                        aria-pressed=${kind === each}
                        onClick=${() => setKind(kind === each ? null : each)}
                    >
                        ${each === "theme" ? "Themes" : "Extensions"}
                    </button>`,
                )}
                ${(tags.length > 1 ? tags : []).map(
                    (each) => html`<button
                        key=${each}
                        class=${`gallery-tag ${tag === each ? "on" : ""}`}
                        aria-pressed=${tag === each}
                        onClick=${() => setTag(tag === each ? null : each)}
                    >
                        ${each}
                    </button>`,
                )}
            </div>`
        }
        ${
            data &&
            offered.length === 0 &&
            !data.error &&
            html`<p class="muted">The index has nothing for this Pi Pocket yet.</p>`
        }
        ${
            matches.length > 0 &&
            html`<div class="sheet-list gallery-list">
                ${matches.map((entry) => html`<${EntryRow} key=${entry.name} entry=${entry} />`)}
            </div>`
        }
        ${
            offered.length > 0 &&
            matches.length === 0 &&
            html`<p class="muted">
                Nothing matches${needle ? ` “${query.trim()}”` : ""}${kind ? ` in ${kind === "theme" ? "themes" : "extensions"}` : ""}${tag ? ` with the tag ${tag}` : ""}.
            </p>`
        }
        ${
            elsewhere.length > 0 &&
            html`<div class="group">
                <div class="group-title">Installed, not listed now</div>
                <div class="sheet-list gallery-list">
                    ${elsewhere.map(
                        (each) => html`<button
                            key=${each.name}
                            class="gallery-row"
                            onClick=${() => openSheet({ type: "gallery-entry", id: each.name })}
                        >
                            <span class="gallery-row-text">
                                <span class="gallery-row-head">
                                    <span class="gallery-row-title">${each.title}</span>
                                    <span class="gallery-row-name mono">${each.name}</span>
                                </span>
                                <span class="gallery-row-meta">v${each.version} · ${each.unlisted}</span>
                                <${StatePills} installed=${each} />
                            </span>
                            <${Icon} name="chevron" size=${14} />
                        </button>`,
                    )}
                </div>
            </div>`
        }
        ${
            data &&
            (hidden.incompatible > 0 || hidden.invalid.length > 0) &&
            html`<div class="muted small gallery-hidden">
                ${hidden.incompatible > 0 && html`<span>${plural(hidden.incompatible, "entry")} ${hidden.incompatible === 1 ? "needs" : "need"} a newer Pi Pocket.</span>`}
                ${
                    hidden.invalid.length > 0 &&
                    html`<button class="link small" onClick=${() => setShowInvalid(!showInvalid)}>
                        ${plural(hidden.invalid.length, "entry")} could not be read
                    </button>`
                }
            </div>`
        }
        ${
            showInvalid &&
            html`<ul class="gallery-problems small">
                ${hidden.invalid.map(
                    (each, index) => html`<li key=${index}>
                        ${each.name && html`<span class="mono">${each.name}</span>`}
                        ${each.name ? ": " : ""}${each.problem}
                    </li>`,
                )}
            </ul>`
        }
        ${
            data &&
            html`<div class="group">
                <div class="group-title">Where they come from</div>
                <div class="sheet-list gallery-panel">
                    <${IndexAddress} address=${data.address} onChanged=${() => load(true)} />
                    <div class="setting wrap">
                        <div class="grow muted small">
                            ${loading ? "Reading the index…" : data.fetchedAt ? `Read ${timeAgo(data.fetchedAt)}` : "Not read yet"}
                        </div>
                        <button class="button small" disabled=${loading} onClick=${() => load(true)}>
                            <${Icon} name="reload" size=${14} /> Refresh
                        </button>
                        ${
                            data.repoUrl &&
                            html`<${Out} class="button small" href=${data.repoUrl}>
                                Submit yours <${Icon} name="external" size=${14} />
                            <//>`
                        }
                    </div>
                </div>
            </div>`
        }
    <//>`;
}

/** What a module declares, group by group: "nothing" for an empty one. */
function Declares({ declares }) {
    return html`<dl class="pi-facts gallery-declares">
        ${GROUPS.map(
            ([key, label]) => html`<div key=${key}>
                <dt>${label}</dt>
                ${
                    declared(declares, key).length > 0
                        ? html`<dd class="mono">${declared(declares, key).join(", ")}</dd>`
                        : html`<dd class="muted">nothing</dd>`
                }
            </div>`,
        )}
        <div>
            <dt>Browser module</dt>
            ${
                declares.client === null
                    ? html`<dd class="muted">nothing</dd>`
                    : html`<dd>for ${ACCESS_WORDS[declares.client] ?? declares.client}</dd>`
            }
        </div>
        <div>
            <dt>Widest access</dt>
            <dd>${ACCESS_WORDS[declares.access] ?? declares.access}</dd>
        </div>
    </dl>`;
}

/**
 * Ask Pi to review an installed extension: a new session in the drop-in folder, in plan mode, with the review prompt.
 * Pi reads code that may hold instructions to it: without plan mode, which blocks its edits and commands that change
 * things, the review is not sent.
 */
async function askForReview(name) {
    if (!planAvailable()) {
        throw new Error(
            "The review runs in plan mode, which is off: turn Plan mode on in Extensions first.",
        );
    }

    const { cwd, prompt } = await galleryApi(`review/${encodeURIComponent(name)}`);
    const { id } = await actions.createSession(cwd);

    try {
        await api(`c/${id}/plan`, { on: true });
    } catch (error) {
        navigate(id);

        throw new Error(
            `Plan mode did not turn on (${error.message}), so the review was not sent.`,
        );
    }

    await api(`c/${id}/submit`, { text: prompt, requestId: uid() });
    closeSheet();
    navigate(id);
    notify(
        "info",
        "Pi reviews it in plan mode: it reads the files, and plan mode keeps it from changing them.",
    );
}

/** Turn an installed extension on (after the owner confirms the risk) or off. */
async function setEnabled(installed, title, enabled) {
    if (
        enabled &&
        !confirm(
            `Turn on ${title}?\n\n${RISK}\n\nTurn it on only if you read its source, or Pi's review of it, and trust it.`,
        )
    ) {
        return false;
    }

    await api(`extensions/${encodeURIComponent(installed.file)}`, { enabled });
    notify("info", `${title} is ${enabled ? "on" : "off"}.`);

    return true;
}

/** One entry: what it is, where it comes from, what it declares, and what the owner can do with it here. */
export function GalleryEntrySheet({ name }) {
    const { data, problem, load } = useListing();
    const [busy, setBusy] = useState(false);
    // Set at once, not at the next render: a second tap in the same moment must not run it twice.
    const going = useRef(false);
    const entry = data?.entries.find((each) => each.name === name) ?? null;
    const installed =
        entry?.installed ?? data?.installed.find((each) => each.name === name) ?? null;

    const run = (work, reload = true) => {
        if (going.current) {
            return;
        }

        going.current = true;
        setBusy(true);
        attempt(work).finally(() => {
            going.current = false;
            setBusy(false);

            if (reload) {
                load();
            }
        });
    };

    if (!entry && !installed) {
        return html`<${Sheet} title="Extension" onClose=${closeSheet}>
            ${problem && html`<div class="error-box small">${problem}</div>`}
            ${
                data === null
                    ? !problem && html`<${Loader} label="Reading the index" />`
                    : html`<p class="muted">The index does not list ${name}, and it is not installed.</p>`
            }
        <//>`;
    }

    if (isTheme(entry ?? installed)) {
        return html`<${ThemeEntry}
            name=${name}
            entry=${entry}
            installed=${installed}
            problem=${problem}
            busy=${busy}
            run=${run}
        />`;
    }

    const title = installed?.title ?? entry.title;
    const declares = installed?.declares ?? entry.declares;
    // The index's files are these when it offers the version here, or nothing is installed.
    const files =
        entry && (!installed || entry.source.commit === installed.commit) ? entry.files : null;
    const offeredRevoked = !installed && entry ? revocation(entry, entry.source.commit) : undefined;

    // Bound to the manifest the owner saw (`pin`): when the index changed since, the server refuses with 409, and the
    // entry is read again (run's reload) for the owner to look at once more.
    const install = () =>
        run(() => galleryApi(`install/${encodeURIComponent(name)}`, { pin: entry.pin }));
    const toggle = (enabled) => run(() => setEnabled(installed, title, enabled));

    const uninstall = () => {
        if (
            confirm(
                `Remove ${title}?\n\n${installed.enabled ? "It is turned off first, then its" : "Its"} files are deleted from the extensions folder.`,
            )
        ) {
            run(() => galleryApi(`uninstall/${encodeURIComponent(name)}`, {}));
        }
    };

    const review = () => run(() => askForReview(name), false);

    return html`<${Sheet} title=${title} onClose=${closeSheet} className="gallery">
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${
            installed &&
            installed.revoked !== null &&
            html`<div class="error-box gallery-revoked" role="alert">
                <strong>The gallery revoked this version.</strong> Its reason: ${installed.revoked}
                ${
                    installed.enabled &&
                    html`<div class="sheet-actions">
                        <button class="button small primary" disabled=${busy} onClick=${() => toggle(false)}>
                            Turn it off
                        </button>
                    </div>`
                }
            </div>`
        }
        ${
            offeredRevoked !== undefined &&
            html`<div class="error-box gallery-revoked" role="alert">
                <strong>The gallery revoked this version.</strong> Its reason: ${offeredRevoked}
            </div>`
        }
        <div class="gallery-head">
            <h3 class="pi-title">${title}</h3>
            <span class="mono muted small">${name}</span>
            <${StatePills} installed=${installed} />
        </div>
        ${entry?.description && html`<p class="gallery-description">${entry.description}</p>`}
        ${
            entry &&
            entry.tags.length > 0 &&
            html`<div class="gallery-row-meta">
                ${entry.tags.map((tag) => html`<span class="gallery-tag-text" key=${tag}>#${tag}</span>`)}
            </div>`
        }
        <${EntryFacts}
            entry=${entry}
            installed=${installed}
            needs=${entry && `Pi Pocket ${entry.minPocket} or newer · extension API ${entry.pocketApi}`}
        />
        ${
            installed?.changed.length > 0 &&
            html`<div class="gallery-warn small">
                Not as installed (edited since, or gone): <span class="mono">${installed.changed.join(", ")}</span>
            </div>`
        }
        ${
            files &&
            html`<div class="group">
                <div class="group-title">Files</div>
                <div class="sheet-list gallery-files">
                    ${files.map(
                        (file) => html`<div class="gallery-file" key=${file.name}>
                            <span class="mono">${file.name}</span>
                            <span class="muted small">${formatBytes(file.size)}</span>
                        </div>`,
                    )}
                </div>
            </div>`
        }
        <div class="group">
            <div class="group-title">What it declares</div>
            <${Declares} declares=${declares} />
        </div>
        <p class="gallery-warn small">${RISK} Read its code before you turn it on.</p>
        <div class="gallery-actions">
            ${
                !installed &&
                html`<button
                    class="button primary"
                    disabled=${busy || offeredRevoked !== undefined}
                    onClick=${install}
                >
                    Install (it stays off)
                </button>`
            }
            ${
                installed &&
                installed.revoked === null &&
                !installed.enabled &&
                html`<button class="button primary" disabled=${busy} onClick=${() => toggle(true)}>
                    Turn on
                </button>`
            }
            ${
                installed &&
                installed.update &&
                html`<button
                    class="button primary"
                    disabled=${busy}
                    onClick=${() => openSheet({ type: "gallery-update", id: name })}
                >
                    Update to ${installed.update.version}
                </button>`
            }
            <button
                class="button"
                disabled=${busy}
                onClick=${() => openSheet({ type: "gallery-source", id: name })}
            >
                View source
            </button>
            ${
                installed &&
                html`<button class="button" disabled=${busy} onClick=${review}>
                    <${Icon} name="sparkle" size=${14} /> Ask Pi to review
                </button>`
            }
            ${
                installed &&
                installed.enabled &&
                installed.revoked === null &&
                html`<button class="button" disabled=${busy} onClick=${() => toggle(false)}>Turn off</button>`
            }
            ${
                installed &&
                html`<button class="button ghost" disabled=${busy} onClick=${uninstall}>Uninstall</button>`
            }
        </div>
    <//>`;
}

/** The facts both kinds of entry show: who made it, its version, where its files are, what it needs, and when. */
function EntryFacts({ entry, installed, needs }) {
    const version = installed?.version ?? entry.version;
    const repo = installed?.repo ?? entry.source.repo;
    const commit = installed?.commit ?? entry.source.commit;

    return html`<dl class="pi-facts">
        ${
            entry &&
            html`<div>
                <dt>Author</dt>
                <dd>
                    ${entry.author.name}
                    ${
                        entry.author.github &&
                        html` · <${Out} href=${`https://github.com/${entry.author.github}`}>@${entry.author.github}<//>`
                    }
                </dd>
            </div>`
        }
        <div>
            <dt>Version</dt>
            <dd>
                ${version}${installed?.update ? html`<span class="warn"> · ${installed.update.version} available</span>` : ""}
            </dd>
        </div>
        <div>
            <dt>Source</dt>
            <dd class="mono">
                <${Out} href=${installed?.sourceUrl ?? entry.sourceUrl}>${repo} @ ${short(commit)}<//>
            </dd>
        </div>
        ${
            entry &&
            html`<div>
                <dt>Needs</dt>
                <dd>${needs}</dd>
            </div>`
        }
        ${
            installed &&
            html`<div>
                <dt>Installed</dt>
                <dd>
                    ${timeAgo(installed.installedAt)}${installed.unlisted ? ` · ${installed.unlisted}` : ""}
                </dd>
            </div>`
        }
    </dl>`;
}

/**
 * A theme's entry: what it is, its files, and installing, updating, and removing it. Installing puts it in the list in
 * Appearance; it changes nothing until someone chooses it there.
 */
function ThemeEntry({ name, entry, installed, problem, busy, run }) {
    const title = installed?.title ?? entry.title;
    const files =
        entry && (!installed || entry.source.commit === installed.commit) ? entry.files : null;
    const offeredRevoked = !installed && entry ? revocation(entry, entry.source.commit) : undefined;

    const install = () =>
        run(() => galleryApi(`install/${encodeURIComponent(name)}`, { pin: entry.pin }));

    const uninstall = () => {
        if (
            confirm(
                `Remove the theme ${title}?\n\nIts folder moves to themes/.removed/ in the data folder. Browsers that use it go back to Pocket.`,
            )
        ) {
            run(async () => {
                await galleryApi(`uninstall/${encodeURIComponent(name)}`, {});

                if (prefs().look === name) {
                    setPrefs({ look: BASE_LOOK });
                }
            });
        }
    };

    return html`<${Sheet} title=${title} onClose=${closeSheet} className="gallery">
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${
            (installed?.revoked ?? offeredRevoked) &&
            html`<div class="error-box gallery-revoked" role="alert">
                <strong>The gallery revoked this version.</strong> Its reason: ${installed?.revoked ?? offeredRevoked}
            </div>`
        }
        <div class="gallery-head">
            <h3 class="pi-title">${title}</h3>
            <span class="mono muted small">${name}</span>
            <span class="pi-tag gallery-plain">Theme</span>
            <${StatePills} installed=${installed} />
        </div>
        ${entry?.description && html`<p class="gallery-description">${entry.description}</p>`}
        ${
            entry &&
            entry.tags.length > 0 &&
            html`<div class="gallery-row-meta">
                ${entry.tags.map((tag) => html`<span class="gallery-tag-text" key=${tag}>#${tag}</span>`)}
            </div>`
        }
        <${EntryFacts}
            entry=${entry}
            installed=${installed}
            needs=${entry && `Pi Pocket ${entry.minPocket} or newer · theme API ${entry.themeApi}`}
        />
        ${
            installed?.problem &&
            html`<div class="gallery-warn small">Appearance does not offer it as it is: ${installed.problem}</div>`
        }
        ${
            installed?.changed.length > 0 &&
            html`<div class="gallery-warn small">
                Not as installed (edited since, or gone): <span class="mono">${installed.changed.join(", ")}</span>
            </div>`
        }
        ${
            files &&
            html`<div class="group">
                <div class="group-title">Files</div>
                <div class="sheet-list gallery-files">
                    ${files.map(
                        (file) => html`<div class="gallery-file" key=${file.name}>
                            <span class="mono">${file.name}</span>
                            <span class="muted small">${formatBytes(file.size)}</span>
                        </div>`,
                    )}
                </div>
            </div>`
        }
        <p class="gallery-warn small">${THEME_RISK}</p>
        <div class="gallery-actions">
            ${
                !installed &&
                html`<button
                    class="button primary"
                    disabled=${busy || offeredRevoked !== undefined}
                    onClick=${install}
                >
                    Install
                </button>`
            }
            ${
                installed &&
                installed.update &&
                html`<button
                    class="button primary"
                    disabled=${busy}
                    onClick=${() => openSheet({ type: "gallery-update", id: name })}
                >
                    Update to ${installed.update.version}
                </button>`
            }
            ${
                installed &&
                html`<button class="button" onClick=${() => openSheet({ type: "appearance" })}>
                    Choose it in Appearance
                </button>`
            }
            <button
                class="button"
                disabled=${busy}
                onClick=${() => openSheet({ type: "gallery-source", id: name })}
            >
                View source
            </button>
            ${
                installed &&
                html`<button class="button ghost" disabled=${busy} onClick=${uninstall}>Remove</button>`
            }
        </div>
    <//>`;
}

/** An extension's files, to read: as installed, or downloaded from the pinned commit before it is. */
export function GallerySourceSheet({ name }) {
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);

    useRoute(`source/${encodeURIComponent(name)}`, setData, setProblem);

    return html`<${Sheet} title=${data ? `Source: ${data.title}` : "Source"} onClose=${closeSheet} wide=${true} className="gallery">
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${!data && !problem && html`<${Loader} label="Getting its files" />`}
        ${
            data &&
            html`<p class="muted small">
                ${data.from === "installed" ? "The files as they are in your extensions folder." : "Downloaded from the commit the index pins, and checked against its hashes. Nothing is installed."}
            </p>`
        }
        ${data?.files.map(
            (file) => html`<section class="gallery-source" key=${file.name}>
                <div class="gallery-source-head">
                    <span class="mono gallery-source-name">${file.name}</span>
                    <span class="muted small">${formatBytes(file.size)}</span>
                    ${
                        file.missing
                            ? html`<span class="pi-tag gallery-bad">missing</span>`
                            : file.pinned
                              ? html`<span class="pi-tag gallery-on" title="Matches the hash the index pins">✓ pinned</span>`
                              : html`<span class="pi-tag behind" title="Not the file the index pins">changed</span>`
                    }
                    ${file.binary && html`<span class="pi-tag gallery-plain">binary</span>`}
                </div>
                ${file.text !== null && html`<${Highlighted} class="gallery-code" text=${file.text} lang=${file.name} />`}
            </section>`,
        )}
    <//>`;
}

/** What changed in each group of declarations: lines like "Hooks: + after_tool_call". */
function declarationChanges(before, after) {
    const lines = [];

    for (const [key, label] of GROUPS) {
        const added = declared(after, key).filter((each) => !declared(before, key).includes(each));
        const removed = declared(before, key).filter(
            (each) => !declared(after, key).includes(each),
        );

        if (added.length > 0 || removed.length > 0) {
            lines.push({ label, added, removed });
        }
    }

    const words = (client) => (client === null ? "none" : `for ${ACCESS_WORDS[client] ?? client}`);

    if (before.client !== after.client) {
        lines.push({
            label: "Browser module",
            from: words(before.client),
            to: words(after.client),
        });
    }

    if (before.access !== after.access) {
        lines.push({
            label: "Widest access",
            from: ACCESS_WORDS[before.access] ?? before.access,
            to: ACCESS_WORDS[after.access] ?? after.access,
        });
    }

    return lines;
}

/** An update the index offers: what changes, the diff, and applying it. */
export function GalleryUpdateSheet({ name }) {
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(false);
    const going = useRef(false);

    const path = `update/${encodeURIComponent(name)}`;
    // Read again after the index changed: the sheet shows the update it offers now.
    const [round, setRound] = useState(0);

    useRoute(
        `${path}?round=${round}`,
        (result) => {
            setData(result);
            setProblem(null);
        },
        setProblem,
    );

    const apply = () => {
        if (going.current) {
            return;
        }

        if (
            data.enabled &&
            !confirm(
                `Apply the update to ${data.title}?\n\nIt is on, so the new code runs as soon as it is in place.`,
            )
        ) {
            return;
        }

        going.current = true;
        setBusy(true);
        attempt(async () => {
            let result;

            try {
                // Bound to the manifest shown here (`pin`), and to whether it was on, as the question above said.
                result = await galleryApi(path, { pin: data.to.pin, enabled: data.enabled });
            } catch (error) {
                // The index, or the switch, changed since this preview: show the update as it stands now instead.
                if (error.status === 409) {
                    setData(null);
                    setRound(round + 1);
                }

                throw error;
            }

            if (result.restart) {
                notify(
                    "warning",
                    `${data.title}'s helper files changed while it is on: restart the server (Menu → Restart server) to load them.`,
                );
            }

            openSheet({ type: "gallery-entry", id: name });
        }).finally(() => {
            going.current = false;
            setBusy(false);
        });
    };

    if (data === null) {
        return html`<${Sheet} title="Update" onClose=${closeSheet}>
            ${
                problem
                    ? html`<div class="error-box small">${problem}</div>`
                    : html`<${Loader} label="Getting the new version" />`
            }
        <//>`;
    }

    const changes =
        data.declares === null ? [] : declarationChanges(data.declares.before, data.declares.after);

    return html`<${Sheet} title=${`Update ${data.title}`} onClose=${closeSheet} wide=${true} className="gallery">
        <dl class="pi-facts">
            <div>
                <dt>From</dt>
                <dd class="mono">${data.from.version} · ${short(data.from.commit)}</dd>
            </div>
            <div>
                <dt>To</dt>
                <dd class="mono">
                    ${data.to.version} · <${Out} href=${data.sourceUrl}>${short(data.to.commit)}<//>
                </dd>
            </div>
        </dl>
        ${
            data.from.repo !== data.to.repo &&
            html`<div class="gallery-warn small" role="alert">
                It now comes from another repository: <span class="mono">${data.from.repo}</span> → <span class="mono">${data.to.repo}</span>. Make sure you trust the new one.
            </div>`
        }
        ${
            data.edited.length > 0 &&
            html`<div class="gallery-warn small" role="alert">
                Yours here, edited since it was installed or never part of it: <span class="mono">${data.edited.join(", ")}</span>. The diff is against your files, and the update replaces them.
            </div>`
        }
        ${
            data.declares === null
                ? html`<p class="muted small">
                      It is checked as every theme is before it is in place. The version you have now goes to themes/.removed/ in the data folder.
                  </p>`
                : html`<div class="group">
                      <div class="group-title">What it declares</div>
                      ${
                          changes.length === 0
                              ? html`<p class="muted small">The same as before.</p>`
                              : html`<dl class="pi-facts gallery-declares">
                                    ${changes.map(
                                        (change) => html`<div key=${change.label}>
                                            <dt>${change.label}</dt>
                                            <dd>
                                                ${change.added?.length > 0 && html`<div class="mono gallery-added">+ ${change.added.join(", ")}</div>`}
                                                ${change.removed?.length > 0 && html`<div class="mono gallery-removed">− ${change.removed.join(", ")}</div>`}
                                                ${change.from !== undefined && html`<div>${change.from} → ${change.to}</div>`}
                                            </dd>
                                        </div>`,
                                    )}
                                </dl>`
                      }
                  </div>`
        }
        <div class="group">
            <div class="group-title">Files</div>
            <div class="sheet-list gallery-files">
                ${data.files.map(
                    (file) => html`<div class="gallery-file" key=${file.name}>
                        <span class="mono">${file.name}</span>
                        <span class=${`small gallery-change ${file.change}`}>${file.change}</span>
                    </div>`,
                )}
            </div>
        </div>
        ${data.diff && html`<${DiffBlock} text=${data.diff} />`}
        ${
            data.enabled &&
            html`<p class="gallery-warn small">It is on: the new code runs as soon as it is in place.</p>`
        }
        <div class="gallery-actions">
            <button class="button primary" disabled=${busy} onClick=${apply}>Apply update</button>
        </div>
    <//>`;
}

/** The rules an index entry keeps for what only its author fills in (`gallery/entry.ts`, which the index checks with). */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** Past this, GitHub's page would refuse the link with the entry in it: the owner copies the entry instead. */
const LINK_LIMIT = 6000;

/** Why what the owner typed for each of the author's fields would not pass the index's checks, by field. */
function fieldProblems({ repo, commit, path, tags, github, name }) {
    const [owner, repository, ...rest] = repo.split("/");
    const parts = path === "" ? [] : path.split("/");

    return {
        repo:
            repo === ""
                ? "Give the GitHub repository with its files."
                : rest.length > 0 ||
                    !OWNER.test(owner ?? "") ||
                    !REPO_NAME.test(repository ?? "") ||
                    repository === "." ||
                    repository === ".."
                  ? "Write it as owner/name, such as tannermidd/pocket-clock."
                  : null,
        commit:
            commit === ""
                ? "Give the commit with its files."
                : /^[0-9a-f]{40}$/.test(commit)
                  ? null
                  : "Write the full commit ID: 40 letters and digits, from a to f and 0 to 9.",
        path:
            parts.length > 4 || parts.some((part) => !PART.test(part))
                ? "Write a folder of the repository, such as extension, four deep at most."
                : null,
        tags:
            tags.length > 10 || tags.some((tag) => !TAG.test(tag))
                ? "Use up to 10 tags of lowercase letters, digits, and -."
                : null,
        github: github === "" || OWNER.test(github) ? null : "Write your GitHub name only.",
        name: name === "" || name.length > 60 ? "Give your name, 60 characters at most." : null,
    };
}

/** One of the author's fields, with what is wrong with it once something is typed. */
function Field({ id, label, hint, value, onInput, problem, placeholder, mono = true }) {
    return html`<div class="field gallery-field">
        <label class="label" for=${id}>${label}</label>
        <input
            id=${id}
            class=${mono ? "mono" : ""}
            value=${value}
            placeholder=${placeholder}
            spellcheck=${false}
            autocapitalize="off"
            autocomplete="off"
            aria-invalid=${problem !== null && value !== ""}
            onInput=${(event) => onInput(event.currentTarget.value)}
        />
        ${
            problem !== null && value !== ""
                ? html`<div class="small warn">${problem}</div>`
                : hint && html`<div class="muted small">${hint}</div>`
        }
    </div>`;
}

/**
 * Share one of your own drop-ins, or with `theme`, one of your theme folders (`file` is its id): the checks, where its
 * files are on GitHub (only its author knows), its index entry made from both, and the pull request, which opens only
 * once the entry can pass the index's checks.
 */
export function GalleryShareSheet({ file, theme = false }) {
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [form, setForm] = useState({
        repo: "",
        commit: "",
        path: "",
        tags: "",
        github: "",
        name: null,
    });

    useRoute(`${theme ? "share-theme" : "share"}/${encodeURIComponent(file)}`, setData, setProblem);
    // A theme by its name, as Appearance shows it; a drop-in by its file.
    const shareName = theme
        ? (store.state.themeList?.find((each) => each.id === file)?.name ?? file)
        : file;

    if (!data) {
        return html`<${Sheet} title=${`Share ${shareName}`} onClose=${closeSheet} wide=${true} className="gallery">
            ${problem ? html`<div class="error-box small">${problem}</div>` : html`<${Loader} label="Checking it" />`}
        <//>`;
    }

    const set = (field) => (value) => setForm({ ...form, [field]: value });
    const typed = {
        repo: form.repo
            .trim()
            .replace(/^https:\/\/github\.com\//, "")
            .replace(/(\.git)?\/*$/, ""),
        commit: form.commit.trim().toLowerCase(),
        path: form.path.trim().replace(/^\/+|\/+$/g, ""),
        tags: form.tags
            .split(/[\s,]+/)
            .map((tag) => tag.trim().toLowerCase())
            .filter(Boolean),
        github: form.github.trim().replace(/^@/, ""),
        name: (form.name ?? data.entry.author.name).trim(),
    };
    const wrong = fieldProblems(typed);
    const entry = {
        ...data.entry,
        tags: typed.tags,
        author: { name: typed.name, ...(typed.github === "" ? {} : { github: typed.github }) },
        source: {
            repo: typed.repo,
            commit: typed.commit,
            ...(typed.path === "" ? {} : { path: typed.path }),
        },
    };
    const text = `${JSON.stringify(entry, null, 4)}\n`;
    // What keeps the pull request closed, first to last: the drop-in itself, then what is still to fill in.
    const blocked =
        data.problems.length > 0
            ? "Fix the problems above first."
            : !data.declaresKnown
              ? "Turn it on once, so what it declares is known, then look again."
              : (Object.values(wrong).find((each) => each !== null) ?? null);
    const filled = data.newEntryPage && `${data.newEntryPage}&value=${encodeURIComponent(text)}`;
    const link = filled && filled.length <= LINK_LIMIT ? filled : data.newEntryPage;

    return html`<${Sheet} title=${`Share ${shareName}`} onClose=${closeSheet} wide=${true} className="gallery">
        <p class="muted small">
            To share it, add its entry to the gallery's index with a pull request. Pi Pocket makes no GitHub calls: you put its files on GitHub and open the pull request yourself.
        </p>
        ${
            data.problems.length > 0
                ? html`<div class="gallery-warn small" role="alert">
                      <strong>Fix these first:</strong>
                      <ul>
                          ${data.problems.map((each, index) => html`<li key=${index}>${each}</li>`)}
                      </ul>
                  </div>`
                : html`<p class="ok small">
                      <${Icon} name="check" size=${14} /> It stands on its own.
                  </p>`
        }
        ${
            data.notes.length > 0 &&
            html`<ul class="muted small gallery-notes">
                ${data.notes.map((each, index) => html`<li key=${index}>${each}</li>`)}
            </ul>`
        }
        <div class="group">
            <div class="group-title">1. Put its files on GitHub</div>
            <p class="small">
                Make a public GitHub repository, and commit these files to it with the same names, at its top or in one folder:
            </p>
            <div class="sheet-list gallery-files">
                ${data.entry.files.map(
                    (each) => html`<div class="gallery-file" key=${each.name}>
                        <span class="mono">${each.name}</span>
                        <span class="muted small">${formatBytes(each.size)}</span>
                    </div>`,
                )}
            </div>
        </div>
        <div class="group">
            <div class="group-title">2. Say where they are</div>
            <div class="gallery-form">
                <${Field}
                    id="share-repo"
                    label="Repository"
                    placeholder="owner/name"
                    value=${form.repo}
                    onInput=${set("repo")}
                    problem=${wrong.repo}
                />
                <${Field}
                    id="share-commit"
                    label="Commit"
                    hint="The full ID of the commit with these files (git rev-parse HEAD)."
                    placeholder="40 letters and digits"
                    value=${form.commit}
                    onInput=${set("commit")}
                    problem=${wrong.commit}
                />
                <${Field}
                    id="share-path"
                    label="Folder (optional)"
                    hint="Only when the files are not at the top of the repository."
                    placeholder=${theme ? "theme" : "extension"}
                    value=${form.path}
                    onInput=${set("path")}
                    problem=${wrong.path}
                />
                <${Field}
                    id="share-tags"
                    label="Tags"
                    hint=${`A few words people search for, such as ${theme ? "dark, calm" : "usage, time"}.`}
                    placeholder=${theme ? "dark, minimal" : "usage, limits"}
                    value=${form.tags}
                    onInput=${set("tags")}
                    problem=${wrong.tags}
                />
                <${Field}
                    id="share-name"
                    label="Your name"
                    value=${form.name ?? data.entry.author.name}
                    onInput=${set("name")}
                    problem=${wrong.name}
                    mono=${false}
                />
                <${Field}
                    id="share-github"
                    label="Your GitHub name (optional)"
                    placeholder="octocat"
                    value=${form.github}
                    onInput=${set("github")}
                    problem=${wrong.github}
                />
            </div>
        </div>
        <div class="group">
            <div class="gallery-entry-head">
                <div class="group-title">
                    3. Its entry, <span class="mono">entries/${data.name}.json</span>
                </div>
                <button
                    class="button small"
                    onClick=${() =>
                        attempt(() => copyText(text).then(() => notify("info", "Entry copied.")))}
                >
                    <${Icon} name="copy" size=${14} /> Copy
                </button>
            </div>
            <${Highlighted} class="gallery-code" text=${text} lang="json" />
        </div>
        <div class="gallery-actions">
            ${
                link &&
                (blocked === null
                    ? html`<${Out} class="button primary" href=${link}>
                          Open a pull request <${Icon} name="external" size=${14} />
                      <//>`
                    : html`<button class="button primary" disabled=${true}>Open a pull request</button>`)
            }
            ${
                data.contributingUrl &&
                html`<${Out} class="button" href=${data.contributingUrl}>
                    How to submit <${Icon} name="external" size=${14} />
                <//>`
            }
        </div>
        ${blocked !== null && link && html`<p class="muted small">${blocked}</p>`}
        ${
            blocked === null &&
            link !== filled &&
            html`<p class="muted small">
                Its entry is too long for the link: copy it, and paste it on GitHub's page.
            </p>`
        }
        ${
            !data.repoUrl &&
            html`<p class="muted small">
                This index does not say where to submit: ask whoever keeps it.
            </p>`
        }
    <//>`;
}
