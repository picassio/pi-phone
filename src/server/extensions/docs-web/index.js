// The Documents page (src/server/extensions/docs.ts, PP-47; redesigned in PP-110): people's documents in folders, by
// place: Mine, the team's (the team server), and each board's. The place is the page's header, with + Page and a ⋯ for
// the rest (a new folder, deleted pages, the settings); search has a row of its own; folders are sections with their
// count, each with a ⋯ sheet (a page or folder in it, rename, delete). A page renders like a wiki page, with [[links]]
// (to a page here, or [[team:Page]], [[PP:Page]], [[mine:Page]] elsewhere) and the pages that link to it; an editor with a
// preview; every saved version, to look at and restore; deleted pages, to bring back; and search across every place.
// Wide, the folders and the open page sit side by side. The image model lives in Menu › Settings › Documents. A board's
// "Docs" opens its documents here (the place it opens on, in localStorage).
const DOCS = "M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5M9 13h6M9 17h6";
/** The place the page shows (kept on this device; a board's Docs button sets it). */
const PLACE = "pi-phone.docs.place";
/** From this width (the page's, not the window's: it may be one tile of several) the folders and the page sit side by side. */
const WIDE = 860;

/** [[Page]], [[Page|words]], [[team:Page]] and [[PP:Page]] as links the page opens (`#doc:`), outside code. */
function linkPages(markdown) {
    return markdown
        .split(/(```[\s\S]*?```|`[^`\n]*`)/)
        .map((part, index) =>
            index % 2 === 1
                ? part
                : part.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_whole, target, label) => `[${(label ?? target).trim()}](#doc:${encodeURIComponent(target.trim())})`),
        )
        .join("");
}

/** How a page shows an image: `![name](image:<id>)` (`doc-store.ts` IMAGE_REF). */
const IMAGE_REF = /!\[([^\]\n]*)\]\(image:([A-Za-z0-9_-]{6,64})\)/g;
/** Images kept for this tab, by place and id: a data URL, or null for one that could not load. */
const images = new Map();

/** A file (an image) as base64, without the data URL's start. */
function base64Of(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
        reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
        reader.readAsDataURL(file);
    });
}

/** A moment, short: "Oct 21, 14:05". */
function when(ms) {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** How many pages a folder holds, its folders' included. */
function pagesIn(tree, folderId) {
    const own = tree.pages.filter((page) => page.folderId === folderId).length;

    return own + tree.folders.filter((folder) => folder.parentId === folderId).reduce((sum, folder) => sum + pagesIn(tree, folder.id), 0);
}

export default function documents(pocket) {
    const { html, useState, useEffect, useRef, Markdown, Loader, Choice, t, tn } = pocket;

    function ago(ms) {
        const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));

        return minutes < 60 ? t("{n}m", { n: minutes }) : minutes < 48 * 60 ? t("{n}h", { n: Math.round(minutes / 60) }) : t("{n}d", { n: Math.round(minutes / 1440) });
    }

    pocket.style("docs.css");

    const failed = (error) => pocket.notify("error", error.message);
    const call = (scope, method, ...args) => pocket.api("call", { scope, method, args }).then((answer) => answer.value);
    /**
     * The page as it is open now, for its sheets (a folder's, a new folder): where to go, and what to read again. Set while
     * the page is open; a sheet only opens from it.
     */
    const open = { go: null, refresh: null };
    const imageOf = (scope, id) => {
        const key = `${scope}|${id}`;

        if (!images.has(key)) {
            images.set(
                key,
                call(scope, "image", id).then(
                    (image) => `data:${image.mime};base64,${image.data}`,
                    () => null,
                ),
            );
        }

        return images.get(key);
    };
    /** A page's markdown with its images loaded (each shows as its name until it has). */
    const useImages = (scope, text) => {
        const [urls, setUrls] = useState({});

        useEffect(() => {
            let live = true;

            for (const id of new Set([...text.matchAll(IMAGE_REF)].map((match) => match[2]))) {
                imageOf(scope, id).then((url) => live && setUrls((was) => (was[id] === url ? was : { ...was, [id]: url })));
            }

            return () => {
                live = false;
            };
        }, [scope, text]);

        return text.replace(IMAGE_REF, (_whole, alt, id) =>
            urls[id] ? `![${alt}](${urls[id]})` : urls[id] === null ? `*[${t("{name}: could not load", { name: alt || t("image") })}]*` : `*[${alt || t("image")}…]*`,
        );
    };
    /** Markdown of a page in `scope`, with its [[links]] and its images. */
    function DocMarkdown({ scope, text }) {
        return html`<${Markdown} text=${linkPages(useImages(scope, text))} class="pd-body" />`;
    }
    const svg = (path, size = 14) =>
        html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${path} /></svg>`;
    /** ⋯ as three filled dots, as the app's other menus draw it. */
    const dots = html`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>`;

    function DocsPage() {
        const [scopes, setScopes] = useState(null);
        const [place, setPlace] = useState(() => localStorage.getItem(PLACE) ?? "mine");
        const [tree, setTree] = useState(null);
        const [view, setView] = useState({ kind: "home" });
        const [past, setPast] = useState([]);
        const [problem, setProblem] = useState(null);
        const [reload, setReload] = useState(0);
        const [wide, setWide] = useState(false);
        // The page's element, as it is drawn (a callback ref: it changes when the layout does).
        const [root, setRoot] = useState(null);

        const go = (next) => {
            setPast((was) => [...was, view]);
            setView(next);
        };
        const back = () => {
            setView(past.at(-1) ?? { kind: "home" });
            setPast((was) => was.slice(0, -1));
        };
        const refresh = () => setReload((n) => n + 1);

        open.go = go;
        open.refresh = refresh;
        useEffect(
            () => () => {
                open.go = null;
                open.refresh = null;
            },
            [],
        );

        // Wide enough, the folders and the open page side by side (the page's width: it may be one tile of several).
        useEffect(() => {
            // The room the page has: its container's (the narrow layout keeps to a reading width of its own).
            const room = root?.parentElement;

            if (room === null || room === undefined) {
                return undefined;
            }

            const watch = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= WIDE));

            watch.observe(room);

            return () => watch.disconnect();
        }, [root]);

        useEffect(() => {
            pocket.api("scopes").then(
                (answer) => {
                    setScopes(answer.scopes);

                    // The place asked for may not be one of this person's (a board left): Mine then.
                    if (!answer.scopes.some((scope) => scope.id === place)) {
                        setPlace("mine");
                    }
                },
                (error) => setProblem(error.message),
            );
        }, []);
        useEffect(() => {
            localStorage.setItem(PLACE, place);
            setTree(null);
            call(place, "tree").then(setTree, (error) => setProblem(error.message));
        }, [place, reload]);

        // Links in a page open their page: here, or in the place they name.
        const onClick = (event) => {
            const link = event.target.closest?.('a[href^="#doc:"]');

            if (!link) {
                return;
            }

            event.preventDefault();
            const target = decodeURIComponent(link.getAttribute("href").slice(5));
            const named = /^([A-Za-z][A-Za-z0-9]{1,5}|team|mine):(.+)$/.exec(target);
            const scope = named === null ? place : named[1] === "team" || named[1] === "mine" ? named[1] : `project:${named[1].toUpperCase()}`;
            const title = named === null ? target : named[2];

            call(scope, "byTitle", title).then((page) => {
                if (!page) {
                    pocket.notify("info", t("There is no page {title} there yet.", { title }));

                    return;
                }

                if (scope !== place) {
                    setPlace(scope);
                }

                go({ kind: "page", scope, id: page.id });
            }, failed);
        };

        if (problem) {
            return html`<div class="pd"><p class="pd-problem">${problem}</p></div>`;
        }

        if (scopes === null) {
            return html`<${Loader} label=${t("Opening documents")} />`;
        }

        const current = scopes.find((scope) => scope.id === place) ?? scopes[0];
        const choose = (id) => {
            setPlace(id);
            setPast([]);
            setView({ kind: "home" });
        };
        const shown =
            view.kind === "home"
                ? null
                : view.kind === "search"
                  ? html`<${Search} query=${view.q} go=${go} />`
                  : view.kind === "page"
                    ? html`<${Page} scope=${view.scope} id=${view.id} write=${scopes.find((scope) => scope.id === view.scope)?.write === true} go=${go} done=${() => (refresh(), setPast([]), setView({ kind: "home" }))} key=${`${view.id}:${reload}`} />`
                    : view.kind === "edit"
                      ? html`<${Editor} ...${view} tree=${tree} saved=${(page) => (refresh(), setPast((was) => was.filter((each) => each.kind !== "edit")), setView({ kind: "page", scope: page.scope, id: page.id }))} />`
                      : view.kind === "history"
                        ? html`<${History} scope=${view.scope} id=${view.id} write=${current.write} saved=${(page) => (refresh(), setView({ kind: "page", scope: page.scope, id: page.id }))} />`
                        : html`<${Deleted} scope=${view.scope} write=${current.write} saved=${(page) => (refresh(), setView({ kind: "page", scope: page.scope, id: page.id }))} />`;
        const home = html`<${Home}
            scopes=${scopes}
            current=${current}
            tree=${tree}
            choose=${choose}
            go=${go}
            selected=${view.kind === "page" ? view.id : null}
        />`;
        // Wide, the folders are always there: back only to something else than them (a page before this one).
        const backButton =
            (wide ? past.some((each) => each.kind !== "home") : past.length > 0) && html`<button class="pd-back link" onClick=${back}>${t("‹ Back")}</button>`;

        // Wide: the place's folders always, the page (or what it led to) beside them.
        if (wide) {
            const empty = tree !== null && tree.folders.length === 0 && tree.pages.length === 0;

            return html`<div class="pd pd-wide" ref=${setRoot} onClick=${onClick}>
                <div class="pd-side">${home}</div>
                <div class="pd-main">
                    ${backButton}
                    ${shown ?? (empty ? null : html`<p class="pd-meta pd-pick">${t("Pick a page.")}</p>`)}
                </div>
            </div>`;
        }

        return html`<div class="pd" ref=${setRoot} onClick=${onClick}>
            ${view.kind !== "home" && backButton}
            ${view.kind === "home" ? home : shown}
        </div>`;
    }

    /** The place as the header (+ Page and ⋯ beside it), a search, and the place's folders and pages. */
    function Home({ scopes, current, tree, choose, go, selected }) {
        const [query, setQuery] = useState("");
        const [shut, setShut] = useState({});
        const [more, setMore] = useState(false);
        const moreRef = useRef(null);

        // ⋯ closes on a tap anywhere else, or Escape.
        useEffect(() => {
            if (!more) {
                return undefined;
            }

            const away = (event) => {
                if (moreRef.current && !moreRef.current.contains(event.target)) {
                    setMore(false);
                }
            };
            const key = (event) => event.key === "Escape" && setMore(false);

            document.addEventListener("pointerdown", away, true);
            document.addEventListener("keydown", key);

            return () => {
                document.removeEventListener("pointerdown", away, true);
                document.removeEventListener("keydown", key);
            };
        }, [more]);

        const newPage = (folderId) => go({ kind: "edit", scope: current.id, folderId, title: "", body: "" });
        const newFolder = (parentId) => pocket.openSheet("new-folder", { scope: current.id, parentId });
        const pageRow = (page, depth) =>
            html`<button class=${`pd-row pd-page-row ${page.id === selected ? "selected" : ""}`} key=${page.id} style=${`--depth:${depth}`} onClick=${() => go({ kind: "page", scope: current.id, id: page.id })}>
                ${svg(DOCS, 14)}
                <span class="pd-page-text"><span class="pd-row-title">${page.title}</span><span class="pd-row-meta">${page.updatedByName} · ${ago(page.updatedAt)}</span></span>
            </button>`;
        const section = (folder, depth) => {
            const folded = shut[folder.id] === true;

            return html`<div class="pd-folder" key=${folder.id}>
                <div class="pd-section" style=${`--depth:${depth}`}>
                    <button class="pd-fold" aria-expanded=${!folded} onClick=${() => setShut({ ...shut, [folder.id]: !folded })}>
                        ${svg(folded ? "M9 6l6 6-6 6" : "M6 9l6 6 6-6", 13)}<span class="pd-section-name">${folder.name}</span><span class="pd-count">${pagesIn(tree, folder.id)}</span>
                    </button>
                    ${
                        current.write &&
                        html`<button class="pd-icon" title=${t("{name}: new page, folder, rename, delete", { name: folder.name })} aria-label=${t("{name}: the folder's menu", { name: folder.name })} onClick=${() => pocket.openSheet("folder", { scope: current.id, folder, title: folder.name })}>
                            ${dots}
                        </button>`
                    }
                </div>
                ${
                    !folded &&
                    html`${tree.folders.filter((each) => each.parentId === folder.id).map((each) => section(each, depth + 1))}
                    ${tree.pages.filter((page) => page.folderId === folder.id).map((page) => pageRow(page, depth + 1))}`
                }
            </div>`;
        };

        const top = tree === null ? [] : tree.folders.filter((folder) => folder.parentId === null);
        const loose = tree === null ? [] : tree.pages.filter((page) => page.folderId === null);
        const empty = tree !== null && tree.folders.length === 0 && tree.pages.length === 0;

        return html`<div class="pd-home">
            <div class="pd-top">
                <div class="pd-place">
                    <${Choice}
                        label=${t("Where")}
                        value=${current.id}
                        options=${scopes.map((scope) => ({
                            value: scope.id,
                            label: scope.name,
                            detail: scope.id === "mine" ? t("Only you") : scope.id === "team" ? t("Everyone on this server") : t("A board's documents"),
                        }))}
                        onChange=${choose}
                    />
                </div>
                <span class="pd-sp"></span>
                ${current.write && html`<button class="button primary small" onClick=${() => newPage(null)}>${t("+ Page")}</button>`}
                <div class="pd-more" ref=${moreRef}>
                    <button class="pd-icon" aria-label=${t("More")} aria-expanded=${more} title=${t("More")} onClick=${() => setMore(!more)}>${dots}</button>
                    ${
                        more &&
                        html`<div class="pd-menu" role="menu">
                            ${current.write && html`<button role="menuitem" onClick=${() => (setMore(false), newFolder(null))}>${t("New folder")}</button>`}
                            ${current.write && html`<button role="menuitem" onClick=${() => (setMore(false), go({ kind: "deleted", scope: current.id }))}>${t("Deleted pages")}<small>${t("bring one back")}</small></button>`}
                            ${current.write && html`<hr />`}
                            <button role="menuitem" onClick=${() => (setMore(false), pocket.openSheet("settings"))}>${t("Documents settings")}<small>${t("image search")}</small></button>
                        </div>`
                    }
                </div>
            </div>
            <form
                class="pd-search"
                onSubmit=${(event) => {
                    event.preventDefault();

                    if (query.trim() !== "") {
                        go({ kind: "search", q: query.trim() });
                    }
                }}
            >
                ${svg("M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-3.5-3.5", 16)}
                <input type="search" placeholder=${t("Search all your documents")} aria-label=${t("Search all your documents")} value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} />
            </form>
            ${!current.write && html`<p class="pd-meta pd-readonly">${t("You can read these; editing them is not part of your role here.")}</p>`}
            ${
                tree === null
                    ? html`<${Loader} label=${t("Opening")} />`
                    : empty
                      ? html`<div class="pd-empty">
                            <div class="pd-empty-icon">${svg(DOCS, 26)}</div>
                            <h3>${t("No documents here yet")}</h3>
                            <p>${current.id === "mine" ? t("Your own pages, in folders: only you see them.") : current.id === "team" ? t("Pages for everyone on this server, in folders.") : t("Pages you and Pi write for this board, in folders.")}</p>
                            ${
                                current.write &&
                                html`<div class="pd-empty-acts">
                                    <button class="button primary small" onClick=${() => newPage(null)}>${t("Write the first page")}</button>
                                    <button class="button small" onClick=${() => newFolder(null)}>${t("+ Folder")}</button>
                                </div>`
                            }
                            <p class="pd-meta">${t("Pi writes here too: ask it in any session.")}</p>
                        </div>`
                      : html`<div class="pd-tree">
                            ${top.map((folder) => section(folder, 0))}
                            ${loose.length > 0 && top.length > 0 && html`<div class="pd-loose"><span>${t("Not in a folder")}</span><span class="pd-count">${loose.length}</span></div>`}
                            ${loose.map((page) => pageRow(page, 0))}
                        </div>`
            }
        </div>`;
    }

    /** A folder's actions, from its ⋯: a page or a folder in it, rename it, delete it (its pages can be brought back). */
    function FolderSheet({ scope, folder, close }) {
        const [name, setName] = useState(folder.name);
        const [renaming, setRenaming] = useState(false);
        const [busy, setBusy] = useState(false);
        const done = () => {
            open.refresh?.();
            close();
        };
        const rename = () => {
            if (name.trim() === "" || name.trim() === folder.name) {
                setRenaming(false);

                return;
            }

            setBusy(true);
            call(scope, "changeFolder", folder.id, { name: name.trim() }).then(done, failed).finally(() => setBusy(false));
        };
        const remove = () => {
            if (confirm(t("Delete the folder {name} and its pages? The pages can be brought back from Deleted pages.", { name: folder.name }))) {
                call(scope, "removeFolder", folder.id).then(done, failed);
            }
        };

        return html`<div class="pd-sheet">
            ${
                renaming
                    ? html`<form
                          class="pd-rename"
                          onSubmit=${(event) => {
                              event.preventDefault();
                              rename();
                          }}
                      >
                          <label class="field"><span class="label">${t("Folder name")}</span><input value=${name} maxlength="80" autofocus onInput=${(event) => setName(event.currentTarget.value)} /></label>
                          <div class="pd-actions">
                              <span class="pd-sp"></span>
                              <button type="button" class="button small" onClick=${() => setRenaming(false)}>${t("Cancel")}</button>
                              <button class="button primary small" disabled=${busy || name.trim() === ""}>${t("Rename")}</button>
                          </div>
                      </form>`
                    : html`<div class="pd-sheet-list">
                          <button class="pd-sheet-row" onClick=${() => (close(), open.go?.({ kind: "edit", scope, folderId: folder.id, title: "", body: "" }))}>${t("New page in this folder")}</button>
                          <button class="pd-sheet-row" onClick=${() => pocket.openSheet("new-folder", { scope, parentId: folder.id, parentName: folder.name })}>${t("New folder inside")}</button>
                          <button class="pd-sheet-row" onClick=${() => setRenaming(true)}>${t("Rename")}</button>
                          <button class="pd-sheet-row danger" onClick=${remove}>${t("Delete the folder and its pages")}<small>${t("can be brought back")}</small></button>
                      </div>`
            }
        </div>`;
    }

    /** A new folder: at the top of the place, or in a folder. */
    function NewFolderSheet({ scope, parentId, parentName, close }) {
        const [name, setName] = useState("");
        const [busy, setBusy] = useState(false);
        const make = () => {
            setBusy(true);
            call(scope, "makeFolder", parentId ?? null, name.trim())
                .then(() => {
                    open.refresh?.();
                    close();
                }, failed)
                .finally(() => setBusy(false));
        };

        return html`<form
            class="pd-sheet"
            onSubmit=${(event) => {
                event.preventDefault();

                if (name.trim() !== "") {
                    make();
                }
            }}
        >
            ${parentName && html`<p class="pd-meta">${t("Inside {name}", { name: parentName })}</p>`}
            <label class="field"><span class="label">${t("Folder name")}</span><input value=${name} maxlength="80" autofocus onInput=${(event) => setName(event.currentTarget.value)} /></label>
            <div class="pd-actions">
                <span class="pd-sp"></span>
                <button type="button" class="button small" onClick=${close}>${t("Cancel")}</button>
                <button class="button primary small" disabled=${busy || name.trim() === ""}>${t("Make the folder")}</button>
            </div>
        </form>`;
    }

    /**
     * Documents settings (Menu › Settings › Documents): the model that describes images, so they are found by what they
     * show (Mine, and the phone's boards'; the team's are set on the team server's Server page).
     */
    function SettingsSheet() {
        const [state, setState] = useState(null);
        const [problem, setProblem] = useState(null);

        useEffect(() => {
            pocket.api("image-model").then(setState, (error) => setProblem(error.message));
        }, []);

        if (problem) {
            return html`<p class="pd-problem">${problem}</p>`;
        }

        if (state === null) {
            return html`<${Loader} label=${t("Loading the settings")} />`;
        }

        const choose = (model) => pocket.api("image-model", { model: model === "" ? null : model }).then((answer) => setState({ ...state, model: answer.model }), failed);

        return html`<div class="pd-settings">
            <h3 class="pd-settings-head">${t("Image search")}</h3>
            <div class="field">
                <span class="label">${t("Describe images with")}</span>
                <${Choice}
                    label=${t("Describe images with")}
                    value=${state.model ?? ""}
                    options=${[{ value: "", label: t("No model"), detail: t("Images are found by name only") }, ...state.models.map((model) => ({ value: model, label: model }))]}
                    onChange=${choose}
                />
                <span class="pd-meta">${t("So search finds pictures by what they show. Each image is sent to this model once; its cost shows in Spend.")}</span>
                ${state.team && html`<span class="pd-meta">${t("This is for yours; the team's are set on the team server's Server page.")}</span>`}
            </div>
            <h3 class="pd-settings-head">${t("Search by meaning")}</h3>
            <p class="pd-meta">${t("Documents are searched by meaning with the wiki's embedding model: Menu › Settings › Wiki.")}</p>
        </div>`;
    }

    function Search({ query, go }) {
        const [hits, setHits] = useState(null);
        const [meaning, setMeaning] = useState(null);

        useEffect(() => {
            pocket.api(`search?q=${encodeURIComponent(query)}`).then((answer) => setHits(answer.hits), failed);
            pocket.api("meaning").then(setMeaning, () => setMeaning(null));
        }, [query]);

        if (hits === null) {
            return html`<${Loader} label=${t("Searching")} />`;
        }

        return html`<div>
            <p class="pd-meta">${hits.length === 0 ? t("Nothing matches “{query}”.", { query }) : tn(hits.length, "“{query}”: {n} page", "“{query}”: {n} pages", { query })}</p>
            ${
                meaning &&
                (!meaning.mine || meaning.team === false) &&
                html`<p class="pd-meta">
                    ${!meaning.mine && t("Yours are searched by keyword only: choose an embedding model in the wiki's settings (with OpenRouter signed in) to search them by meaning too. ")}
                    ${meaning.team === false && t("The team's are searched by keyword only until the server's owner sets search in documents on the Server page.")}
                </p>`
            }
            ${hits.map(
                (hit) => html`<button class="pd-row pd-hit" key=${`${hit.scope}:${hit.pageId}`} onClick=${() => go({ kind: "page", scope: hit.scope, id: hit.pageId })}>
                    <span class="pd-row-title">${hit.title}</span>
                    <span class="pd-row-meta">${[hit.scope === "mine" ? t("Mine") : hit.scope === "team" ? t("Team") : hit.scope.slice("project:".length), ...hit.path].join(" › ")}</span>
                    <span class="pd-snippet"><${Markdown} text=${hit.snippet} /></span>
                </button>`,
            )}
        </div>`;
    }

    function Page({ scope, id, write, go, done }) {
        const [page, setPage] = useState(null);
        const [links, setLinks] = useState([]);
        const [problem, setProblem] = useState(null);

        useEffect(() => {
            call(scope, "page", id).then(setPage, (error) => setProblem(error.message));
            call(scope, "backlinks", id).then(setLinks, () => setLinks([]));
        }, [scope, id]);

        if (problem) {
            return html`<p class="pd-problem">${problem}</p>`;
        }

        if (page === null) {
            return html`<${Loader} label=${t("Opening the page")} />`;
        }

        const place = scope === "mine" ? t("Mine") : scope === "team" ? t("Team") : scope.slice("project:".length);
        const remove = () => confirm(t("Delete {title}? It can be brought back from Deleted pages.", { title: page.title })) && call(scope, "remove", id).then(done, failed);
        const ask = () => pocket.compose(`${t('About the document "{title}" ({where}): read it first.', { title: page.title, where: [place, ...page.path].join(" › ") })}\n\n`);

        return html`<article class="pd-page">
            <p class="pd-crumb">${[place, ...page.path].join(" › ")}</p>
            <h2>${page.title}</h2>
            <p class="pd-meta">${t("Last saved by {who}, {when} ago", { who: page.updatedByName, when: ago(page.updatedAt) })}</p>
            <div class="pd-actions pd-page-acts">
                ${write && html`<button class="button small" onClick=${() => go({ kind: "edit", scope, id, folderId: page.folderId, title: page.title, body: page.body })}>${t("Edit")}</button>`}
                <button class="button small" onClick=${() => go({ kind: "history", scope, id })}>${t("History")}</button>
                <button class="button primary small" onClick=${ask}>${t("Ask Pi")}</button>
                <span class="pd-sp"></span>
                ${write && html`<button class="link danger small" onClick=${remove}>${t("Delete")}</button>`}
            </div>
            <${DocMarkdown} scope=${scope} text=${page.body} />
            ${
                links.length > 0 &&
                html`<div class="pd-backlinks">
                    <span>${t("Linked from")}</span>
                    ${links.map((link) => html`<button class="link" key=${link.id} onClick=${() => go({ kind: "page", scope, id: link.id })}>${link.title}</button>`)}
                </div>`
            }
        </article>`;
    }

    /** Write a page: its title, its folder, its text (with a preview). */
    function Editor({ scope, id, folderId, title: firstTitle, body: firstBody, tree, saved }) {
        const [title, setTitle] = useState(firstTitle);
        const [body, setBody] = useState(firstBody);
        const [folder, setFolder] = useState(folderId ?? "");
        const [preview, setPreview] = useState(false);
        const [busy, setBusy] = useState(false);
        const [problem, setProblem] = useState(null);
        const [adding, setAdding] = useState(0);
        const text = useRef(null);
        const picker = useRef(null);
        const folders = tree?.folders ?? [];
        /** Upload images (picked or pasted) and put each where the cursor is. */
        const addImages = async (files) => {
            const chosen = [...files].filter((file) => file.type.startsWith("image/"));

            if (chosen.length === 0) {
                return;
            }

            setProblem(null);
            setAdding((count) => count + chosen.length);

            for (const file of chosen) {
                try {
                    if (file.size > 10 * 1024 * 1024) {
                        throw new Error(t("{name}: an image may be 10 MB at most.", { name: file.name }));
                    }

                    const image = await call(scope, "addImage", { name: file.name.replace(/\.[^.]+$/, "") || "image", data: await base64Of(file) });
                    const area = text.current;
                    const at = area ? area.selectionEnd : body.length;

                    setBody((was) => `${was.slice(0, at)}${at > 0 && was[at - 1] !== "\n" ? "\n" : ""}${image.markdown}\n${was.slice(at)}`);
                } catch (error) {
                    setProblem(error.message);
                } finally {
                    setAdding((count) => count - 1);
                }
            }
        };
        const named = (folderOf) => {
            const path = [];

            for (let at = folders.find((each) => each.id === folderOf); at; at = folders.find((each) => each.id === at.parentId)) {
                path.unshift(at.name);
            }

            return path.join(" › ");
        };
        const save = () => {
            setBusy(true);
            setProblem(null);
            call(scope, "write", { ...(id === undefined ? {} : { id }), folderId: folder === "" ? null : folder, title, body })
                .then((page) => {
                    pocket.notify("info", t("Saved {title}.", { title: page.title }));
                    saved(page);
                }, (error) => setProblem(error.message))
                .finally(() => setBusy(false));
        };

        return html`<div class="pd-editor">
            <label class="field"><span class="label">${t("Title")}</span><input value=${title} maxlength="120" onInput=${(event) => setTitle(event.currentTarget.value)} /></label>
            <div class="field">
                <span class="label">${t("Folder")}</span>
                <${Choice} label=${t("Folder")} value=${folder} options=${[{ value: "", label: t("(the top)") }, ...folders.map((each) => ({ value: each.id, label: named(each.id) }))]} onChange=${setFolder} />
            </div>
            ${
                preview
                    ? html`<${DocMarkdown} scope=${scope} text=${body} />`
                    : html`<textarea
                          ref=${text}
                          class="pd-text mono"
                          aria-label=${t("Page (markdown)")}
                          placeholder=${t("Markdown. [[Another page]] links to a page here; [[team:Page]] or [[PP:Page]] to one elsewhere. Paste an image to add it.")}
                          value=${body}
                          onInput=${(event) => setBody(event.currentTarget.value)}
                          onPaste=${(event) => {
                              const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));

                              if (files.length > 0) {
                                  event.preventDefault();
                                  addImages(files);
                              }
                          }}
                      ></textarea>`
            }
            ${problem && html`<p class="pd-problem">${problem}</p>`}
            <input
                ref=${picker}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange=${(event) => {
                    addImages(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                }}
            />
            <div class="pd-actions pd-editor-acts">
                <button class="button small" onClick=${() => setPreview(!preview)}>${preview ? t("Edit") : t("Preview")}</button>
                <button class="button small" disabled=${adding > 0} onClick=${() => picker.current?.click()}>${adding > 0 ? t("Adding…") : t("+ Image")}</button>
                <span class="pd-sp"></span>
                <button class="button primary small" disabled=${busy || title.trim() === ""} onClick=${save}>${busy ? t("Saving…") : t("Save")}</button>
            </div>
        </div>`;
    }

    /** Every saved version, newest first: look at one, and bring it back. */
    function History({ scope, id, write, saved }) {
        const [versions, setVersions] = useState(null);
        const [shown, setShown] = useState(null);

        useEffect(() => {
            call(scope, "history", id).then(setVersions, failed);
        }, [scope, id]);

        if (versions === null) {
            return html`<${Loader} label=${t("Opening its history")} />`;
        }

        const restore = (version) => call(scope, "restore", id, version.id).then((page) => (pocket.notify("info", t("Brought back the version of {when} ago.", { when: ago(version.at) })), saved(page)), failed);

        return html`<div class="pd-history">
            <h3>${t("History")}</h3>
            ${versions.map(
                (version, index) => html`<div class="pd-version" key=${version.id}>
                    <button class="pd-row" onClick=${() => call(scope, "version", id, version.id).then(setShown, failed)}>
                        <span class="pd-row-title">${index === 0 ? t("{title} (now)", { title: version.title }) : version.title}</span>
                        <span class="pd-row-meta">${version.byName} · ${when(version.at)}</span>
                    </button>
                    ${write && index > 0 && html`<button class="button small" onClick=${() => restore(version)}>${t("Bring back")}</button>`}
                </div>`,
            )}
            ${shown && html`<div class="pd-shown"><p class="pd-meta">${shown.title} · ${shown.byName}, ${when(shown.at)}</p><${DocMarkdown} scope=${scope} text=${shown.body} /></div>`}
        </div>`;
    }

    /** Pages deleted here, newest first, to bring back. */
    function Deleted({ scope, write, saved }) {
        const [pages, setPages] = useState(null);

        useEffect(() => {
            call(scope, "deleted").then(setPages, failed);
        }, [scope]);

        if (pages === null) {
            return html`<${Loader} label=${t("Opening")} />`;
        }

        const restore = (page) =>
            call(scope, "history", page.id)
                .then((versions) => call(scope, "restore", page.id, versions[0].id))
                .then((back) => (pocket.notify("info", t("{title} is back.", { title: back.title })), saved(back)), failed);

        return html`<div>
            <h3>${t("Deleted pages")}</h3>
            ${pages.length === 0 && html`<p class="pd-meta">${t("Nothing deleted here.")}</p>`}
            ${pages.map(
                (page) => html`<div class="pd-version" key=${page.id}>
                    <span class="pd-row"><span class="pd-row-title">${page.title}</span><span class="pd-row-meta">${page.updatedByName} · ${ago(page.updatedAt)}</span></span>
                    ${write && html`<button class="button small" onClick=${() => restore(page)}>${t("Bring back")}</button>`}
                </div>`,
            )}
        </div>`;
    }

    pocket.page({ id: "docs", title: t("Documents"), component: DocsPage });
    pocket.sheet({ id: "folder", title: t("Folder"), component: FolderSheet });
    pocket.sheet({ id: "new-folder", title: t("New folder"), component: NewFolderSheet });
    pocket.sheet({ id: "settings", title: t("Documents settings"), component: SettingsSheet });
    pocket.rail({ id: "docs", title: t("Documents"), iconPath: DOCS, page: "docs" });
    pocket.launcher({ id: "docs", label: t("Documents"), detail: t("yours, the team's, and each board's, in folders"), iconPath: DOCS, keywords: ["docs", "documents", "pages", "notes"], page: "docs" });
    pocket.launcher({ id: "docs-settings", label: t("Documents settings"), detail: t("image search"), iconPath: DOCS, keywords: ["docs", "images", "model", "search"], sheet: "settings" });
    // In Settings with the app's own, as the wiki's: there while Documents is on, gone with it.
    pocket.menu({ id: "docs-settings", label: t("Documents"), hint: t("image search"), sheet: "settings" });
}
