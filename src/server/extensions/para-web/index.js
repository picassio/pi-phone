// The Wiki page (src/server/extensions/para.ts): pi-para's wiki, to browse, search, read, and edit. A page in the
// conversation's place, from the rail and the launcher. Pages render as markdown, with [[wikilinks]] that open the page
// they name; a page shows its scope, tags, how fresh it is, and the pages that link to it. Ask Pi puts the page into
// the message box. Edits save through pi-para's own wiki_write (checks, links, index, log, search). Anywhere in the app,
// a link to `#wiki:<page>` opens it here.
const BOOK = "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10";
/** The categories by id; their names and hints are given in the person's language inside the module (`categoryText`). */
const CATEGORIES = ["projects", "areas", "resources", "archives"];

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
    const { html, useState, useEffect, useRef, Markdown, Icon, Loader, Switch, t, tn, tx } = pocket;
    /** Each category's name and hint, by id. */
    const categoryText = {
        projects: [t("Projects"), t("Goals with an end")],
        areas: [t("Areas"), t("Ongoing responsibilities")],
        resources: [t("Resources"), t("Reference and know-how")],
        archives: [t("Archives"), t("Done or inactive")],
    };

    /** How long ago an ISO date was, briefly. */
    function ago(iso) {
        const ms = Date.now() - Date.parse(iso);

        if (!Number.isFinite(ms)) {
            return "";
        }

        const minutes = Math.round(ms / 60_000);

        return minutes < 60
            ? t("{n}m", { n: Math.max(1, minutes) })
            : minutes < 48 * 60
              ? t("{n}h", { n: Math.round(minutes / 60) })
              : t("{n}d", { n: Math.round(minutes / 1440) });
    }
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
            return html`<${Loader} label=${t("Opening the wiki")} />`;
        }

        const saved = (path) => {
            setReload((count) => count + 1);
            setHistory((past) => past.filter((each) => each.kind !== "edit"));
            setView({ kind: "page", path });
        };

        return html`<div class="wiki" onClick=${onClick}>
            ${view.kind !== "home" && html`<button class="wiki-back link" onClick=${back}>${t("‹ Back")}</button>`}
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
                    placeholder=${t("Search the wiki")}
                    aria-label=${t("Search the wiki")}
                    value=${query}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                />
                <button class="button small" disabled=${query.trim() === ""}>${t("Search")}</button>
                <button
                    type="button"
                    class="button small ghost"
                    title=${t("New page")}
                    onClick=${() => go({ kind: "edit", create: true, path: "", raw: TEMPLATE("New page", "resources") })}
                >
                    ${t("New")}
                </button>
            </form>
            ${
                status &&
                html`<p class="wiki-meta">
                    ${
                        status.embedding
                            ? tn(status.pages, "{n} page · {dir} · search keywords and {model}", "{n} pages · {dir} · search keywords and {model}", {
                                  dir: status.wikiDir.replace(/^.*\/files\/home/, "~"),
                                  model: status.embedding,
                              })
                            : tn(status.pages, "{n} page · {dir} · search by keywords", "{n} pages · {dir} · search by keywords", {
                                  dir: status.wikiDir.replace(/^.*\/files\/home/, "~"),
                              })
                    }
                </p>`
            }
            ${
                capture &&
                html`<p class="wiki-meta">
                    ${
                        capture.model === null
                            ? t("Capture is off: {why}.", { why: capture.why })
                            : capture.minutes === null
                              ? t("Capture only when asked (session menu), on {model}.", { model: capture.model })
                              : t("Sessions idle for {minutes} min are captured, on {model}.", { minutes: capture.minutes, model: capture.model })
                    }
                    ${capture.last && ` ${t("Last: session #{session}, {when} ago.", { session: capture.last.session, when: ago(new Date(capture.last.at).toISOString()) })}`}
                    ${capture.conversation !== null && html` <a href=${`s/${capture.conversation}`}>${t("Open the capture session")}</a>`}
                </p>`
            }
            ${CATEGORIES.map((key) => {
                const [label, hint] = categoryText[key];
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
                    ${open[key] && pages.length === 0 && html`<p class="wiki-empty">${t("Nothing here yet.")}</p>`}
                </section>`;
            })}
            ${
                status?.log.length > 0 &&
                html`<section class="wiki-log">
                    <h3>${t("Lately")}</h3>
                    ${status.log.map((line) => html`<p>${line}</p>`)}
                </section>`
            }
        </div>`;
    }

    /**
     * Results in two steps: keyword matches at once (on the phone), then keywords and meaning together once the query's
     * remote embedding is back, which replace them.
     */
    function Search({ query, go }) {
        const [results, setResults] = useState(null);
        const [full, setFull] = useState(false);
        const [problem, setProblem] = useState(null);

        useEffect(() => {
            let live = true;

            setResults(null);
            setFull(false);
            pocket.api(`search?q=${encodeURIComponent(query)}&mode=keywords`).then(
                (answer) => live && setResults((now) => now ?? answer.results),
                (error) => live && setProblem(error.message),
            );
            pocket.api(`search?q=${encodeURIComponent(query)}`).then(
                (answer) => {
                    if (live) {
                        setResults(answer.results);
                        setFull(true);
                    }
                },
                (error) => live && setProblem(error.message),
            );

            return () => {
                live = false;
            };
        }, [query]);

        return html`<div class="wiki-results">
            <h2>“${query}”</h2>
            ${results && !full && html`<p class="wiki-meta">${t("Keyword matches; finding by meaning…")}</p>`}
            ${problem && html`<p class="wiki-problem">${problem}</p>`}
            ${!results && !problem && html`<${Loader} label=${t("Searching")} />`}
            ${results?.length === 0 && html`<p class="wiki-empty">${t("No page has these words.")}</p>`}
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
            return html`<${Loader} label=${t("Opening the page")} />`;
        }

        const ask = () =>
            pocket.compose(
                `${t('About the wiki page {path} ("{title}"): read it with wiki_read first.', { path: page.path, title: page.title })}\n\n`,
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
                    <span>${t("Linked from")}</span>
                    ${page.backlinks.map(
                        (link) => html`<button class="link" key=${link.path} onClick=${() => go({ kind: "page", path: link.path })}>${link.title}</button>`,
                    )}
                </div>`
            }
            <div class="wiki-actions">
                <button class="button" onClick=${() => go({ kind: "edit", create: false, path: page.path, raw: page.raw })}>${t("Edit")}</button>
                <button class="button primary" onClick=${ask}>${t("Ask Pi")}</button>
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
                pocket.notify("info", create ? t("Created {target}.", { target }) : t("Saved {target}.", { target }));
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
                    <select value=${category} aria-label=${t("Category")} onChange=${(event) => setCategory(event.currentTarget.value)}>
                        ${CATEGORIES.filter((key) => key !== "archives").map((key) => html`<option value=${key}>${categoryText[key][0]}</option>`)}
                    </select>
                    <input
                        class="mono"
                        placeholder=${t("page-name")}
                        aria-label=${t("Page name (lowercase, dashes)")}
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
                <button class="button" onClick=${() => setPreview(!preview)}>${preview ? t("Edit") : t("Preview")}</button>
                <button class="button primary" disabled=${busy || (create && slug.replace(/-/g, "") === "")} onClick=${save}>
                    ${busy ? t("Saving…") : t("Save")}
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
                pocket.notify("info", t("Saved."));
            } catch (error) {
                setProblem(error.message);
            } finally {
                setBusy(false);
            }
        };

        if (!settings) {
            return problem ? html`<p class="wiki-problem">${problem}</p>` : html`<${Loader} label=${t("Loading the settings")} />`;
        }

        const price = (model) => (model.pricePerMillion === 0 ? t("free") : "$" + model.pricePerMillion.toFixed(3) + "/M");
        const chosen = embedding?.models?.find((model) => model.id === settings.embeddingModel);

        return html`<div class="wiki-settings">
            <p class="muted small">${tx("The wiki is in {dir}, in pi-para's format: pi with pi-para on a computer reads it as it is.", { dir: html`<span class="mono">${settings.wikiDir.replace(/^.*\/files\/home/, "~")}</span>` })}</p>
            ${problem && html`<p class="wiki-problem">${problem}</p>`}
            <div class="sheet-list">
                <div class="provider">
                    <div>
                        <div>${t("Capture")}</div>
                        <div class="muted small">${t("What an idle session learned goes into the wiki, written by a model of its own in the Wiki capture session. The menu's Capture to wiki does it at once.")}</div>
                        <div class="field">
                            <div class="label">${t("After a session is idle for (minutes; empty: only when asked)")}</div>
                            <input class="mono" inputmode="numeric" value=${minutes} placeholder=${t("only when asked")} onInput=${(event) => setMinutes(event.currentTarget.value)} />
                        </div>
                        <div class="field">
                            <div class="label">${t("Capture model")}</div>
                            <select value=${settings.captureModel} onChange=${(event) => save({ captureModel: event.currentTarget.value })} disabled=${busy}>
                                <option value="auto">${t("The default model for new sessions")}</option>
                                ${settings.models.map((model) => html`<option value=${`${model.provider}/${model.id}`}>${model.provider}/${model.id}</option>`)}
                            </select>
                        </div>
                    </div>
                    <div class="provider-actions">
                        <button class="button small" disabled=${busy} onClick=${() => save({ captureMinutes: minutes.trim() === "" ? null : Number(minutes) })}>${t("Save")}</button>
                    </div>
                </div>
                <div class="provider">
                    <div>
                        <div>${t("Wiki in Pi's prompt")}</div>
                        <div class="muted small">${t("The wiki's conventions, its index, and the pages of the session's project, in every session's prompt.")}</div>
                        <div class="field">
                            <div class="label">${t("Budget (tokens)")}</div>
                            <input class="mono" inputmode="numeric" value=${tokens} onInput=${(event) => setTokens(event.currentTarget.value)} />
                        </div>
                        <label class="check wiki-switch">
                            <${Switch} on=${settings.contextSchema} label=${t("Include the conventions")} disabled=${busy} onChange=${() => save({ contextSchema: !settings.contextSchema })} />
                            ${t("Include the conventions (schema)")}
                        </label>
                    </div>
                    <div class="provider-actions">
                        <button class="button small" disabled=${busy} onClick=${() => save({ contextTokens: Number(tokens) })}>${t("Save")}</button>
                    </div>
                </div>
                <div class="provider">
                    <div>
                        <div>${t("Search by meaning")} ${settings.embeddingModel && html`<span class="ok">✓</span>`}</div>
                        <div class="muted small">
                            ${t("Keyword search always works. With an OpenRouter embedding model, search also finds pages by meaning, in the wiki and in your documents. Each search waits for the model to embed the query: some answer in 0.2 s, others in over 1 s. Changing it embeds the wiki and your documents again.")}
                        </div>
                        ${embedding?.error && html`<p class="wiki-problem">${embedding.error}</p>`}
                        ${embedding && !embedding.error && !embedding.signedIn && html`<p class="muted small">${t("Sign in to OpenRouter in Settings > Providers to use one.")}</p>`}
                        ${!embedding && html`<${Loader} label=${t("Loading OpenRouter's models")} />`}
                        ${
                            embedding?.signedIn &&
                            html`<div class="field">
                                <div class="label">${t("Embedding model for search")}</div>
                                <select
                                    value=${settings.embeddingModel ?? ""}
                                    disabled=${busy}
                                    onChange=${(event) => save({ embeddingModel: event.currentTarget.value === "" ? null : event.currentTarget.value })}
                                >
                                    <option value="">${t("Off: keyword search only")}</option>
                                    ${embedding.models.map((model) => html`<option value=${model.id}>${model.name} · ${price(model)}</option>`)}
                                </select>
                                ${chosen && html`<div class="muted small mono">${chosen.id} · ${price(chosen)} · ${t("up to {n} tokens", { n: chosen.context })}</div>`}
                            </div>`
                        }
                    </div>
                </div>
                <div class="provider">
                    <div>
                        <div>${t("Health checks")}</div>
                        <div class="muted small">${t("wiki_lint fixes simple problems by itself, and calls pages stale after {days} days.", { days: settings.lintStaleDays })}</div>
                        <div class="field">
                            <div class="label">${t("Open questions are stale after")}</div>
                            <select
                                aria-label=${t("Open questions are stale after")}
                                value=${String(settings.lintQuestionDays)}
                                disabled=${busy}
                                onChange=${(event) => save({ lintQuestionDays: Number(event.currentTarget.value) })}
                            >
                                ${[...new Set([3, 7, 14, 30, settings.lintQuestionDays])].sort((a, b) => a - b).map((days) => html`<option value=${String(days)}>${t("{n} days", { n: days })}</option>`)}
                            </select>
                        </div>
                        <label class="check wiki-switch">
                            <${Switch} on=${settings.lintAutoFix} label=${t("Fix simple problems")} disabled=${busy} onChange=${() => save({ lintAutoFix: !settings.lintAutoFix })} />
                            ${t("Fix simple problems")}
                        </label>
                    </div>
                </div>
            </div>
        </div>`;
    }

    pocket.sheet({ id: "settings", title: t("Wiki settings"), component: Settings, wide: true });
    pocket.page({ id: "wiki", title: t("Wiki"), component: WikiPage });
    pocket.rail({ id: "wiki", title: t("Wiki"), iconPath: BOOK, page: "wiki" });
    pocket.launcher({
        id: "wiki",
        label: t("Wiki"),
        detail: t("your PARA knowledge base: browse, search, edit"),
        iconPath: BOOK,
        keywords: ["para", "notes", "knowledge", "pi-para"],
        page: "wiki",
    });
    pocket.launcher({
        id: "wiki-settings",
        label: t("Wiki settings"),
        detail: t("capture, search by meaning, prompt context"),
        iconPath: BOOK,
        keywords: ["para", "embedding", "openrouter", "capture"],
        sheet: "settings",
    });
    // In Settings with the app's own: there while the wiki is on, gone with it.
    pocket.menu({
        id: "wiki-settings",
        label: t("Wiki"),
        hint: t("search by meaning, capture, prompt context"),
        sheet: "settings",
    });
    pocket.menu({
        id: "wiki-capture",
        label: t("Capture to wiki"),
        hint: t("what this session learned, into the wiki"),
        run: async () => {
            const session = pocket.conversationId();

            if (session === null) {
                pocket.notify("warning", t("Open a session to capture it."));

                return;
            }

            const result = await pocket.api("capture", { session });

            pocket.notify(
                result.sent ? "info" : "warning",
                result.sent ? t("Capturing this session into the wiki, in the Wiki capture session.") : t("Nothing captured: {why}.", { why: result.why }),
            );
        },
    });
    pocket.launcher({
        id: "wiki-new",
        label: t("New wiki page"),
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

    const given = (value) => value !== undefined && value !== null;

    pocket.toolCall({ tool: "wiki_query", iconPath: BOOK, label: (args) => t("Searched the wiki: {query}", { query: args.query ?? "" }) });
    pocket.toolCall({ tool: "wiki_read", iconPath: BOOK, label: (args) => (given(args.path) ? t("Read {path}", { path: args.path }) : t("Read the wiki")) });
    pocket.toolCall({ tool: "wiki_write", iconPath: BOOK, label: (args) => (paths(args) ? t("Wrote {paths}", { paths: paths(args) }) : t("Wrote the wiki")) });
    pocket.toolCall({ tool: "wiki_edit", iconPath: BOOK, label: (args) => (given(args.path) ? t("Edited {path}", { path: args.path }) : t("Edited a page")) });
    pocket.toolCall({
        tool: "wiki_move",
        iconPath: BOOK,
        label: (args) => (given(args.path) ? t("Moved {path} to {to}", { path: args.path, to: args.to ?? "" }) : t("Moved a page to {to}", { to: args.to ?? "" })),
    });
    pocket.toolCall({ tool: "wiki_ingest", iconPath: BOOK, label: (args) => t("Added to the wiki: {source}", { source: String(args.source ?? "").slice(0, 60) }) });
    pocket.toolCall({ tool: "wiki_lint", iconPath: BOOK, label: () => t("Checked the wiki's health") });
    pocket.toolCall({ tool: "wiki_summarize", iconPath: BOOK, label: (args) => (given(args.target) ? t("Summarized {target}", { target: args.target }) : t("Summarized the wiki")) });
    pocket.toolCall({ tool: "wiki_migrate", iconPath: BOOK, label: () => t("Migrated the wiki's pages") });
}
