// The Wiki page (src/server/extensions/para.ts): pi-para's wiki, to browse, search, read, and edit. A page in the
// conversation's place, from the rail and the launcher. Pages render as markdown, with [[wikilinks]] that open the page
// they name; a page shows its scope, tags, how fresh it is, and the pages that link to it. Ask Pi puts the page into
// the message box. Edits save through pi-para's own wiki_write (checks, links, index, log, search). Anywhere in the app,
// a link to `#wiki:<page>` opens it here.
const BOOK = "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10";
const CATEGORIES = [
    ["projects", "Projects", "Goals with an end"],
    ["areas", "Areas", "Ongoing responsibilities"],
    ["resources", "Resources", "Reference and know-how"],
    ["archives", "Archives", "Done or inactive"],
];

/** How long ago an ISO date was, briefly. */
function ago(iso) {
    const ms = Date.now() - Date.parse(iso);

    if (!Number.isFinite(ms)) {
        return "";
    }

    const minutes = Math.round(ms / 60_000);

    return minutes < 60
        ? `${Math.max(1, minutes)}m`
        : minutes < 48 * 60
          ? `${Math.round(minutes / 60)}h`
          : `${Math.round(minutes / 1440)}d`;
}

/** [[slug]] and [[slug|label]] as links the page opens (`#wiki:`), outside code. */
function linkWikilinks(markdown) {
    return markdown
        .split(/(```[\s\S]*?```|`[^`\n]*`)/)
        .map((part, index) =>
            index % 2 === 1
                ? part
                : part.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_whole, target, label) =>
                      `[${(label ?? target).trim()}](#wiki:${encodeURIComponent(target.trim())})`,
                  ),
        )
        .join("");
}

const TEMPLATE = (title, category) => `---
title: ${title}
para: ${category}
scope:
  - global
tags: []
---

## Topic

## Key Facts

- 

## Connections

## Sources
`;

export default function wiki(pocket) {
    const { html, useState, useEffect, useRef, Markdown, Icon, Loader, Switch } = pocket;
    // What the page opens on, set by whatever opened it: a page's path or a slug, or a new page.
    let pending = null;
    const open = (target) => {
        pending = target;
        pocket.openPage("wiki");
    };

    pocket.style("wiki.css");

    function WikiPage() {
        const [view, setView] = useState({ kind: "home" });
        const [history, setHistory] = useState([]);
        const [tree, setTree] = useState(null);
        const [status, setStatus] = useState(null);
        const [capture, setCapture] = useState(null);
        const [problem, setProblem] = useState(null);
        const [reload, setReload] = useState(0);

        const go = (next) => {
            setHistory((past) => [...past, view]);
            setView(next);
        };
        const back = () => {
            const previous = history.at(-1) ?? { kind: "home" };

            setHistory((past) => past.slice(0, -1));
            setView(previous);
        };
        /** A page by path, or by slug or title as wikilinks name it. */
        const openTarget = (target) => {
            if (target === null || target === undefined) {
                return;
            }

            if (typeof target === "object") {
                go(target);

                return;
            }

            const all = tree ? Object.values(tree.categories).flat() : [];
            const found =
                all.find((page) => page.path === target) ??
                all.find((page) => page.slug === target) ??
                all.find((page) => page.title.toLowerCase() === target.toLowerCase());

            go({ kind: "page", path: found ? found.path : target });
        };

        useEffect(() => {
            Promise.all([pocket.api("tree"), pocket.api("status"), pocket.api("capture")]).then(
                ([loaded, loadedStatus, loadedCapture]) => {
                    setTree(loaded);
                    setStatus(loadedStatus);
                    setCapture(loadedCapture);
                    setProblem(null);
                },
                (error) => setProblem(error.message),
            );
        }, [reload]);

        // Opened for a page (a link, a launcher action): once the tree is there to find it in.
        useEffect(() => {
            if (tree && pending !== null) {
                const target = pending;

                pending = null;
                openTarget(target);
            }
        }, [tree]);

        // Links in a page open their page here.
        const onClick = (event) => {
            const link = event.target.closest?.('a[href^="#wiki:"]');

            if (link) {
                event.preventDefault();
                event.stopPropagation();
                openTarget(decodeURIComponent(link.getAttribute("href").slice(6)));
            }
        };

        if (problem) {
            return html`<div class="wiki"><p class="wiki-problem">${problem}</p></div>`;
        }

        if (!tree) {
            return html`<${Loader} label="Opening the wiki" />`;
        }

        const saved = (path) => {
            setReload((count) => count + 1);
            setHistory((past) => past.filter((each) => each.kind !== "edit"));
            setView({ kind: "page", path });
        };

        return html`<div class="wiki" onClick=${onClick}>
            ${view.kind !== "home" && html`<button class="wiki-back link" onClick=${back}>‹ Back</button>`}
            ${view.kind === "home" && html`<${Home} tree=${tree} status=${status} capture=${capture} go=${go} />`}
            ${view.kind === "search" && html`<${Search} query=${view.q} go=${go} />`}
            ${view.kind === "page" && html`<${Page} path=${view.path} key=${`${view.path}:${reload}`} go=${go} />`}
            ${view.kind === "edit" && html`<${Editor} ...${view} onSaved=${saved} />`}
        </div>`;
    }

    function Home({ tree, status, capture, go }) {
        const [query, setQuery] = useState("");
        const [open, setOpen] = useState({ projects: true, areas: true, resources: true, archives: false });

        return html`<div class="wiki-home">
            <form
                class="wiki-search"
                onSubmit=${(event) => {
                    event.preventDefault();

                    if (query.trim() !== "") {
                        go({ kind: "search", q: query.trim() });
                    }
                }}
            >
                <input
                    type="search"
                    placeholder="Search the wiki"
                    aria-label="Search the wiki"
                    value=${query}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                />
                <button class="button small" disabled=${query.trim() === ""}>Search</button>
                <button type="button" class="button small ghost" title="Wiki settings" onClick=${() => pocket.openSheet("settings")}>
                    Settings
                </button>
                <button
                    type="button"
                    class="button small ghost"
                    title="New page"
                    onClick=${() => go({ kind: "edit", create: true, path: "", raw: TEMPLATE("New page", "resources") })}
                >
                    New
                </button>
            </form>
            ${
                status &&
                html`<p class="wiki-meta">
                    ${status.pages} page${status.pages === 1 ? "" : "s"} · ${status.wikiDir.replace(/^.*\/files\/home/, "~")} ·
                    search ${status.embedding ? `keywords and ${status.embedding}` : "by keywords"}
                </p>`
            }
            ${
                capture &&
                html`<p class="wiki-meta">
                    ${
                        capture.model === null
                            ? `Capture is off: ${capture.why}.`
                            : capture.minutes === null
                              ? `Capture only when asked (session menu), on ${capture.model}.`
                              : `Sessions idle for ${capture.minutes} min are captured, on ${capture.model}.`
                    }
                    ${capture.last && ` Last: session #${capture.last.session}, ${ago(new Date(capture.last.at).toISOString())} ago.`}
                    ${capture.conversation !== null && html` <a href=${`/s/${capture.conversation}`}>Open the capture session</a>`}
                </p>`
            }
            ${CATEGORIES.map(([key, label, hint]) => {
                const pages = tree.categories[key] ?? [];

                return html`<section class="wiki-category" key=${key}>
                    <button
                        class="wiki-category-head"
                        aria-expanded=${open[key] ? "true" : "false"}
                        onClick=${() => setOpen({ ...open, [key]: !open[key] })}
                    >
                        <span class=${`wiki-dot ${key}`}></span>
                        <span class="wiki-category-name">${label}</span>
                        <span class="wiki-category-hint">${hint}</span>
                        <span class="wiki-count">${pages.length}</span>
                    </button>
                    ${
                        open[key] &&
                        pages.map(
                            (page) => html`<button class="wiki-row" key=${page.path} onClick=${() => go({ kind: "page", path: page.path })}>
                                <span class="wiki-row-title">${page.title}</span>
                                <span class="wiki-row-meta">${page.scope.join(", ")}${page.updated ? ` · ${ago(page.updated)}` : ""}</span>
                            </button>`,
                        )
                    }
                    ${open[key] && pages.length === 0 && html`<p class="wiki-empty">Nothing here yet.</p>`}
                </section>`;
            })}
            ${
                status?.log.length > 0 &&
                html`<section class="wiki-log">
                    <h3>Lately</h3>
                    ${status.log.map((line) => html`<p>${line}</p>`)}
                </section>`
            }
        </div>`;
    }

    function Search({ query, go }) {
        const [results, setResults] = useState(null);
        const [problem, setProblem] = useState(null);

        useEffect(() => {
            pocket.api(`search?q=${encodeURIComponent(query)}`).then(
                (answer) => setResults(answer.results),
                (error) => setProblem(error.message),
            );
        }, [query]);

        return html`<div class="wiki-results">
            <h2>“${query}”</h2>
            ${problem && html`<p class="wiki-problem">${problem}</p>`}
            ${!results && !problem && html`<${Loader} label="Searching" />`}
            ${results?.length === 0 && html`<p class="wiki-empty">No page has these words.</p>`}
            ${results?.map(
                (result) => html`<button class="wiki-row" key=${result.path} onClick=${() => go({ kind: "page", path: result.path })}>
                    <span class="wiki-row-title">${result.title}</span>
                    <span class="wiki-row-meta">${result.path}</span>
                    ${result.snippet && html`<span class="wiki-snippet">${result.snippet.replace(/^@@[^@]*@@\s*/, "").slice(0, 220)}</span>`}
                </button>`,
            )}
        </div>`;
    }

    function Page({ path, go }) {
        const [page, setPage] = useState(null);
        const [problem, setProblem] = useState(null);

        useEffect(() => {
            pocket.api(`page?path=${encodeURIComponent(path)}`).then(setPage, (error) => setProblem(error.message));
        }, [path]);

        if (problem) {
            return html`<p class="wiki-problem">${problem}</p>`;
        }

        if (!page) {
            return html`<${Loader} label="Opening the page" />`;
        }

        const ask = () =>
            pocket.compose(
                `About the wiki page ${page.path} ("${page.title}"): read it with wiki_read first.\n\n`,
            );

        return html`<article class="wiki-page">
            <p class="wiki-crumb">${page.category}</p>
            <h2>${page.title}</h2>
            <div class="wiki-chips">
                ${page.scope.map((scope) => html`<span class="wiki-chip scope">${scope}</span>`)}
                ${page.tags.map((tag) => html`<span class="wiki-chip">${tag}</span>`)}
                <span class="wiki-chip fresh">${page.freshness}</span>
            </div>
            <${Markdown} text=${linkWikilinks(page.body)} class="wiki-body" />
            ${
                page.backlinks.length > 0 &&
                html`<div class="wiki-backlinks">
                    <span>Linked from</span>
                    ${page.backlinks.map(
                        (link) => html`<button class="link" key=${link.path} onClick=${() => go({ kind: "page", path: link.path })}>${link.title}</button>`,
                    )}
                </div>`
            }
            <div class="wiki-actions">
                <button class="button" onClick=${() => go({ kind: "edit", create: false, path: page.path, raw: page.raw })}>Edit</button>
                <button class="button primary" onClick=${ask}>Ask Pi</button>
            </div>
        </article>`;
    }

    function Editor({ path, raw, create, onSaved }) {
        const [text, setText] = useState(raw);
        const [category, setCategory] = useState(create ? "resources" : path.split("/")[0]);
        const [slug, setSlug] = useState(create ? "" : path.split("/")[1]);
        const [busy, setBusy] = useState(false);
        const [problem, setProblem] = useState(null);
        const [preview, setPreview] = useState(false);
        const box = useRef(null);
        const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");

        const save = async () => {
            setBusy(true);
            setProblem(null);

            try {
                const target = `${category}/${slug}`;

                await pocket.api("page", { path: target, raw: text, create });
                pocket.notify("info", create ? `Created ${target}.` : `Saved ${target}.`);
                onSaved(target);
            } catch (error) {
                setProblem(error.message);
            } finally {
                setBusy(false);
            }
        };

        return html`<div class="wiki-editor">
            ${
                create &&
                html`<div class="wiki-new">
                    <select value=${category} aria-label="Category" onChange=${(event) => setCategory(event.currentTarget.value)}>
                        ${CATEGORIES.filter(([key]) => key !== "archives").map(([key, label]) => html`<option value=${key}>${label}</option>`)}
                    </select>
                    <input
                        class="mono"
                        placeholder="page-name"
                        aria-label="Page name (lowercase, dashes)"
                        value=${slug}
                        onInput=${(event) => setSlug(event.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))}
                    />
                </div>`
            }
            ${!create && html`<p class="wiki-crumb">${path}</p>`}
            ${
                preview
                    ? html`<${Markdown} text=${linkWikilinks(body)} class="wiki-body" />`
                    : html`<textarea class="wiki-text mono" ref=${box} value=${text} onInput=${(event) => setText(event.currentTarget.value)}></textarea>`
            }
            ${problem && html`<p class="wiki-problem">${problem}</p>`}
            <div class="wiki-actions">
                <button class="button" onClick=${() => setPreview(!preview)}>${preview ? "Edit" : "Preview"}</button>
                <button class="button primary" disabled=${busy || (create && slug.replace(/-/g, "") === "")} onClick=${save}>
                    ${busy ? "Saving…" : "Save"}
                </button>
            </div>
        </div>`;
    }

    /**
     * Wiki settings: what pi-para's config holds, changed here (people never edit it): capture (when, on which model),
     * the prompt's wiki context, vector search on an OpenRouter embedding model, and the health checks.
     */
    function Settings() {
        const [settings, setSettings] = useState(null);
        const [embedding, setEmbedding] = useState(null);
        const [problem, setProblem] = useState(null);
        const [busy, setBusy] = useState(false);
        const [tokens, setTokens] = useState("");
        const [minutes, setMinutes] = useState("");
        const [filter, setFilter] = useState("");

        const loaded = (next) => {
            setSettings(next);
            setTokens(String(next.contextTokens));
            setMinutes(next.captureMinutes === null ? "" : String(next.captureMinutes));
        };

        useEffect(() => {
            pocket.api("settings").then(loaded, (error) => setProblem(error.message));
            pocket.api("embedding-models").then(setEmbedding, (error) => setEmbedding({ error: error.message }));
        }, []);

        const save = async (patch) => {
            setBusy(true);
            setProblem(null);

            try {
                loaded(await pocket.api("settings", patch));
                pocket.notify("info", "Saved.");
            } catch (error) {
                setProblem(error.message);
            } finally {
                setBusy(false);
            }
        };

        if (!settings) {
            return problem ? html`<p class="wiki-problem">${problem}</p>` : html`<${Loader} label="Loading the settings" />`;
        }

        const models = embedding?.models?.filter(
            (model) => filter === "" || `${model.id} ${model.name}`.toLowerCase().includes(filter.toLowerCase()),
        );

        return html`<div class="wiki-settings">
            <p class="muted small">The wiki is in <span class="mono">${settings.wikiDir.replace(/^.*\/files\/home/, "~")}</span>, in pi-para's format: pi with pi-para on a computer reads it as it is.</p>
            ${problem && html`<p class="wiki-problem">${problem}</p>`}
            <div class="sheet-list">
                <div class="provider">
                    <div>
                        <div>Capture</div>
                        <div class="muted small">What an idle session learned goes into the wiki, written by a model of its own in the Wiki capture session. The menu's Capture to wiki does it at once.</div>
                        <div class="field">
                            <div class="label">After a session is idle for (minutes; empty: only when asked)</div>
                            <input class="mono" inputmode="numeric" value=${minutes} placeholder="only when asked" onInput=${(event) => setMinutes(event.currentTarget.value)} />
                        </div>
                        <div class="field">
                            <div class="label">Capture model</div>
                            <select value=${settings.captureModel} onChange=${(event) => save({ captureModel: event.currentTarget.value })} disabled=${busy}>
                                <option value="auto">The default model for new sessions</option>
                                ${settings.models.map((model) => html`<option value=${`${model.provider}/${model.id}`}>${model.provider}/${model.id}</option>`)}
                            </select>
                        </div>
                    </div>
                    <div class="provider-actions">
                        <button class="button small" disabled=${busy} onClick=${() => save({ captureMinutes: minutes.trim() === "" ? null : Number(minutes) })}>Save</button>
                    </div>
                </div>
                <div class="provider">
                    <div>
                        <div>Wiki in Pi's prompt</div>
                        <div class="muted small">The wiki's conventions, its index, and the pages of the session's project, in every session's prompt.</div>
                        <div class="field">
                            <div class="label">Budget (tokens)</div>
                            <input class="mono" inputmode="numeric" value=${tokens} onInput=${(event) => setTokens(event.currentTarget.value)} />
                        </div>
                        <label class="check wiki-switch">
                            <${Switch} on=${settings.contextSchema} label="Include the conventions" disabled=${busy} onChange=${() => save({ contextSchema: !settings.contextSchema })} />
                            Include the conventions (schema)
                        </label>
                    </div>
                    <div class="provider-actions">
                        <button class="button small" disabled=${busy} onClick=${() => save({ contextTokens: Number(tokens) })}>Save</button>
                    </div>
                </div>
                <div class="provider">
                    <div>
                        <div>Search by meaning ${settings.embeddingModel && html`<span class="ok">✓</span>`}</div>
                        <div class="muted small">
                            Keyword search always works. With an OpenRouter embedding model, search also finds pages by meaning.
                            ${settings.embeddingModel ? html` Now: <span class="mono">${settings.embeddingModel}</span>.` : " Now: off."}
                        </div>
                        ${embedding?.error && html`<p class="wiki-problem">${embedding.error}</p>`}
                        ${embedding && !embedding.error && !embedding.signedIn && html`<p class="muted small">Sign in to OpenRouter in Settings > Providers to use one.</p>`}
                        ${
                            embedding?.signedIn &&
                            html`<input type="search" placeholder="Find a model" value=${filter} onInput=${(event) => setFilter(event.currentTarget.value)} />
                                <div class="wiki-models">
                                    ${models.map(
                                        (model) => html`<button
                                            class=${`wiki-row ${model.id === settings.embeddingModel ? "on" : ""}`}
                                            key=${model.id}
                                            disabled=${busy}
                                            onClick=${() => save({ embeddingModel: model.id })}
                                        >
                                            <span class="wiki-row-title">${model.name}</span>
                                            <span class="wiki-row-meta">${model.id} · ${model.pricePerMillion === 0 ? "free" : `${model.pricePerMillion.toFixed(3)} per M tokens`} · ${model.context} tokens</span>
                                        </button>`,
                                    )}
                                </div>`
                        }
                    </div>
                    <div class="provider-actions">
                        ${settings.embeddingModel && html`<button class="button small ghost" disabled=${busy} onClick=${() => save({ embeddingModel: null })}>Turn off</button>`}
                    </div>
                </div>
                <div class="provider">
                    <div>
                        <div>Health checks</div>
                        <div class="muted small">wiki_lint fixes simple problems by itself, and calls pages stale after ${settings.lintStaleDays} days.</div>
                        <label class="check wiki-switch">
                            <${Switch} on=${settings.lintAutoFix} label="Fix simple problems" disabled=${busy} onChange=${() => save({ lintAutoFix: !settings.lintAutoFix })} />
                            Fix simple problems
                        </label>
                    </div>
                </div>
            </div>
        </div>`;
    }

    pocket.sheet({ id: "settings", title: "Wiki settings", component: Settings, wide: true });
    pocket.page({ id: "wiki", title: "Wiki", component: WikiPage });
    pocket.rail({ id: "wiki", title: "Wiki", iconPath: BOOK, page: "wiki" });
    pocket.launcher({
        id: "wiki",
        label: "Wiki",
        detail: "your PARA knowledge base: browse, search, edit",
        iconPath: BOOK,
        keywords: ["para", "notes", "knowledge", "pi-para"],
        page: "wiki",
    });
    pocket.launcher({
        id: "wiki-settings",
        label: "Wiki settings",
        detail: "capture, search by meaning, prompt context",
        iconPath: BOOK,
        keywords: ["para", "embedding", "openrouter", "capture"],
        sheet: "settings",
    });
    pocket.menu({
        id: "wiki-capture",
        label: "Capture to wiki",
        hint: "what this session learned, into the wiki",
        run: async () => {
            const session = pocket.conversationId();

            if (session === null) {
                pocket.notify("warning", "Open a session to capture it.");

                return;
            }

            const result = await pocket.api("capture", { session });

            pocket.notify(
                result.sent ? "info" : "warning",
                result.sent ? "Capturing this session into the wiki, in the Wiki capture session." : `Nothing captured: ${result.why}.`,
            );
        },
    });
    pocket.launcher({
        id: "wiki-new",
        label: "New wiki page",
        iconPath: BOOK,
        keywords: ["para", "note"],
        run: () => open({ kind: "edit", create: true, path: "", raw: TEMPLATE("New page", "resources") }),
    });

    // `#wiki:<page>` links anywhere in the app (Pi's answers, other pages) open the page here.
    const anywhere = (event) => {
        const link = event.target.closest?.('a[href^="#wiki:"]');

        if (link && !link.closest(".wiki")) {
            event.preventDefault();
            open(decodeURIComponent(link.getAttribute("href").slice(6)));
        }
    };

    document.addEventListener("click", anywhere);
    pocket.onDispose(() => document.removeEventListener("click", anywhere));

    // Pi's wiki calls, in words.
    const paths = (args) => (args.pages ?? []).map((page) => `${page.category}/${page.slug}`).join(", ");

    pocket.toolCall({ tool: "wiki_query", iconPath: BOOK, label: (args) => `Searched the wiki: ${args.query ?? ""}` });
    pocket.toolCall({ tool: "wiki_read", iconPath: BOOK, label: (args) => `Read ${args.path ?? "the wiki"}` });
    pocket.toolCall({ tool: "wiki_write", iconPath: BOOK, label: (args) => `Wrote ${paths(args) || "the wiki"}` });
    pocket.toolCall({ tool: "wiki_edit", iconPath: BOOK, label: (args) => `Edited ${args.path ?? "a page"}` });
    pocket.toolCall({ tool: "wiki_move", iconPath: BOOK, label: (args) => `Moved ${args.path ?? "a page"} to ${args.to ?? ""}` });
    pocket.toolCall({ tool: "wiki_ingest", iconPath: BOOK, label: (args) => `Added to the wiki: ${String(args.source ?? "").slice(0, 60)}` });
    pocket.toolCall({ tool: "wiki_lint", iconPath: BOOK, label: () => "Checked the wiki's health" });
    pocket.toolCall({ tool: "wiki_summarize", iconPath: BOOK, label: (args) => `Summarized ${args.target ?? "the wiki"}` });
    pocket.toolCall({ tool: "wiki_migrate", iconPath: BOOK, label: () => "Migrated the wiki's pages" });
}
