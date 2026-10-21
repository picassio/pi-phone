// The Documents page (src/server/extensions/docs.ts, PP-47): people's documents in folders, by place: Mine, the team's
// (the team server), and each board's. A folder tree to make, rename, move and delete folders and pages; a page rendered
// like a wiki page, with [[links]] (to a page here, or [[team:Page]], [[PP:Page]], [[mine:Page]] elsewhere) and the pages
// that link to it; an editor with a preview; every saved version, to look at and restore; deleted pages, to bring back;
// and search across every place. A board's "Docs" opens its documents here (the place it opens on, in localStorage).
const DOCS = "M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5M9 13h6M9 17h6";
/** The place the page shows (kept on this device; a board's Docs button sets it). */
const PLACE = "pi-phone.docs.place";

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

function ago(ms) {
    const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));

    return minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
}

export default function documents(pocket) {
    const { html, useState, useEffect, useRef, Markdown, Loader } = pocket;

    pocket.style("docs.css");

    const failed = (error) => pocket.notify("error", error.message);
    const call = (scope, method, ...args) => pocket.api("call", { scope, method, args }).then((answer) => answer.value);
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
            urls[id] ? `![${alt}](${urls[id]})` : urls[id] === null ? `*[${alt || "image"}: could not load]*` : `*[${alt || "image"}…]*`,
        );
    };
    /** Markdown of a page in `scope`, with its [[links]] and its images. */
    function DocMarkdown({ scope, text }) {
        return html`<${Markdown} text=${linkPages(useImages(scope, text))} class="pd-body" />`;
    }
    const svg = (path, size = 14) =>
        html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${path} /></svg>`;

    function DocsPage() {
        const [scopes, setScopes] = useState(null);
        const [place, setPlace] = useState(() => localStorage.getItem(PLACE) ?? "mine");
        const [tree, setTree] = useState(null);
        const [view, setView] = useState({ kind: "home" });
        const [past, setPast] = useState([]);
        const [problem, setProblem] = useState(null);
        const [reload, setReload] = useState(0);

        const go = (next) => {
            setPast((was) => [...was, view]);
            setView(next);
        };
        const back = () => {
            setView(past.at(-1) ?? { kind: "home" });
            setPast((was) => was.slice(0, -1));
        };
        const refresh = () => setReload((n) => n + 1);

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
                    pocket.notify("info", `There is no page ${title} there yet.`);

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
            return html`<${Loader} label="Opening documents" />`;
        }

        const current = scopes.find((scope) => scope.id === place) ?? scopes[0];

        return html`<div class="pd" onClick=${onClick}>
            ${view.kind !== "home" && html`<button class="pd-back link" onClick=${back}>‹ Back</button>`}
            ${
                view.kind === "home" &&
                html`<${Home}
                    scopes=${scopes}
                    current=${current}
                    tree=${tree}
                    choose=${(id) => {
                        setPlace(id);
                        setPast([]);
                    }}
                    go=${go}
                    refresh=${refresh}
                />`
            }
            ${view.kind === "search" && html`<${Search} query=${view.q} go=${go} />`}
            ${view.kind === "page" && html`<${Page} scope=${view.scope} id=${view.id} write=${scopes.find((scope) => scope.id === view.scope)?.write === true} go=${go} done=${() => (refresh(), setPast([]), setView({ kind: "home" }))} key=${`${view.id}:${reload}`} />`}
            ${view.kind === "edit" && html`<${Editor} ...${view} tree=${tree} saved=${(page) => (refresh(), setPast((was) => was.filter((each) => each.kind !== "edit")), setView({ kind: "page", scope: page.scope, id: page.id }))} />`}
            ${view.kind === "history" && html`<${History} scope=${view.scope} id=${view.id} write=${current.write} saved=${(page) => (refresh(), setView({ kind: "page", scope: page.scope, id: page.id }))} />`}
            ${view.kind === "deleted" && html`<${Deleted} scope=${view.scope} write=${current.write} saved=${(page) => (refresh(), setView({ kind: "page", scope: page.scope, id: page.id }))} />`}
        </div>`;
    }

    /** The places, a search, and the place's folders and pages. */
    function Home({ scopes, current, tree, choose, go, refresh }) {
        const [query, setQuery] = useState("");
        const [shut, setShut] = useState({});

        const newFolder = (parentId) => {
            const name = prompt(parentId === null ? "New folder:" : "New folder inside:");

            if (name) {
                call(current.id, "makeFolder", parentId, name).then(refresh, failed);
            }
        };
        const folderMenu = (folder) => {
            const what = prompt(`${folder.name}: type a new name to rename it, or "delete" to delete it and its pages (they can be brought back).`, folder.name);

            if (what === null || what === folder.name) {
                return;
            }

            (what.trim().toLowerCase() === "delete" ? call(current.id, "removeFolder", folder.id) : call(current.id, "changeFolder", folder.id, { name: what })).then(refresh, failed);
        };
        const rows = (parentId, depth) => {
            const folders = (tree?.folders ?? []).filter((folder) => folder.parentId === parentId);
            const pages = (tree?.pages ?? []).filter((page) => page.folderId === parentId);

            return html`${folders.map(
                (folder) => html`<div class="pd-folder" key=${folder.id}>
                    <div class="pd-row pd-folder-row" style=${`--depth:${depth}`}>
                        <button class="pd-fold" aria-expanded=${!shut[folder.id]} onClick=${() => setShut({ ...shut, [folder.id]: !shut[folder.id] })}>
                            ${svg(shut[folder.id] ? "M9 6l6 6-6 6" : "M6 9l6 6 6-6", 13)}<span class="pd-row-title">${folder.name}</span>
                        </button>
                        ${
                            current.write &&
                            html`<span class="pd-row-acts">
                                <button class="link" title="New page in this folder" onClick=${() => go({ kind: "edit", scope: current.id, folderId: folder.id, title: "", body: "" })}>+ page</button>
                                <button class="link" title="New folder inside" onClick=${() => newFolder(folder.id)}>+ folder</button>
                                <button class="link" title="Rename or delete" onClick=${() => folderMenu(folder)}>…</button>
                            </span>`
                        }
                    </div>
                    ${!shut[folder.id] && rows(folder.id, depth + 1)}
                </div>`,
            )}
            ${pages.map(
                (page) => html`<button class="pd-row pd-page-row" key=${page.id} style=${`--depth:${depth}`} onClick=${() => go({ kind: "page", scope: current.id, id: page.id })}>
                    ${svg(DOCS, 13)}<span class="pd-row-title">${page.title}</span><span class="pd-row-meta">${page.updatedByName} · ${ago(page.updatedAt)}</span>
                </button>`,
            )}`;
        };

        // Where (Mine, Team, a board) is a drop-down beside the search, not a row of chips that runs off a phone (PP-62).
        return html`<div class="pd-home">
            <form
                class="pd-search"
                onSubmit=${(event) => {
                    event.preventDefault();

                    if (query.trim() !== "") {
                        go({ kind: "search", q: query.trim() });
                    }
                }}
            >
                <select class="pd-place" aria-label="Where" value=${current.id} onChange=${(event) => choose(event.currentTarget.value)}>
                    ${scopes.map((scope) => html`<option value=${scope.id}>${scope.name}</option>`)}
                </select>
                <input type="search" placeholder="Search everywhere" aria-label="Search all your documents" value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} />
            </form>
            ${
                current.write &&
                html`<div class="pd-actions">
                    <button class="button primary small" onClick=${() => go({ kind: "edit", scope: current.id, folderId: null, title: "", body: "" })}>+ Page</button>
                    <button class="button small" onClick=${() => newFolder(null)}>+ Folder</button>
                    <span class="pd-sp"></span>
                    <button class="link small" onClick=${() => go({ kind: "deleted", scope: current.id })}>Deleted pages</button>
                </div>`
            }
            ${!current.write && html`<p class="pd-meta">You can read these; editing them is not part of your role here.</p>`}
            ${
                tree === null
                    ? html`<${Loader} label="Opening" />`
                    : tree.folders.length === 0 && tree.pages.length === 0
                      ? html`<p class="pd-meta">No documents here yet.</p>`
                      : html`<div class="pd-tree">${rows(null, 0)}</div>`
            }
            ${!current.id.startsWith("team") && (current.id === "mine" || !scopes.some((scope) => scope.id === "team")) && html`<${ImageModel} />`}
        </div>`;
    }

    /** The model that describes images here (Mine, and the phone's boards'), so they are found by what they show. */
    function ImageModel() {
        const [state, setState] = useState(null);

        useEffect(() => {
            pocket.api("image-model").then(setState, () => setState(null));
        }, []);

        if (state === null) {
            return null;
        }

        const choose = (model) => pocket.api("image-model", { model: model === "" ? null : model }).then((answer) => setState({ ...state, model: answer.model }), failed);

        return html`<details class="pd-image-model">
            <summary>Image search: ${state.model ?? "by name only"}</summary>
            <label class="field">
            <span class="label">Describe images with</span>
            <select value=${state.model ?? ""} onChange=${(event) => choose(event.currentTarget.value)}>
                <option value="">No model (images are found by name only)</option>
                ${state.models.map((model) => html`<option value=${model}>${model}</option>`)}
            </select>
            <span class="pd-meta">So search finds pictures by what they show${state.team ? " (yours; the team's are set on the server)" : ""}. Each image is sent to this model once; its cost shows in Spend.</span>
            </label>
        </details>`;
    }

    function Search({ query, go }) {
        const [hits, setHits] = useState(null);
        const [meaning, setMeaning] = useState(null);

        useEffect(() => {
            pocket.api(`search?q=${encodeURIComponent(query)}`).then((answer) => setHits(answer.hits), failed);
            pocket.api("meaning").then(setMeaning, () => setMeaning(null));
        }, [query]);

        if (hits === null) {
            return html`<${Loader} label="Searching" />`;
        }

        return html`<div>
            <p class="pd-meta">${hits.length === 0 ? `Nothing matches “${query}”.` : `“${query}”: ${hits.length} ${hits.length === 1 ? "page" : "pages"}`}</p>
            ${
                meaning &&
                (!meaning.mine || meaning.team === false) &&
                html`<p class="pd-meta">
                    ${!meaning.mine && "Yours are searched by keyword only: choose an embedding model in the wiki's settings (with OpenRouter signed in) to search them by meaning too. "}
                    ${meaning.team === false && "The team's are searched by keyword only until the server's owner sets search in documents on the Server page."}
                </p>`
            }
            ${hits.map(
                (hit) => html`<button class="pd-row pd-hit" key=${`${hit.scope}:${hit.pageId}`} onClick=${() => go({ kind: "page", scope: hit.scope, id: hit.pageId })}>
                    <span class="pd-row-title">${hit.title}</span>
                    <span class="pd-row-meta">${[hit.scope === "mine" ? "Mine" : hit.scope === "team" ? "Team" : hit.scope.slice("project:".length), ...hit.path].join(" › ")}</span>
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
            return html`<${Loader} label="Opening the page" />`;
        }

        const place = scope === "mine" ? "Mine" : scope === "team" ? "Team" : scope.slice("project:".length);
        const remove = () => confirm(`Delete ${page.title}? It can be brought back from Deleted pages.`) && call(scope, "remove", id).then(done, failed);
        const ask = () => pocket.compose(`About the document "${page.title}" (${place}${page.path.length > 0 ? ` › ${page.path.join(" › ")}` : ""}): read it first.\n\n`);

        return html`<article class="pd-page">
            <p class="pd-crumb">${[place, ...page.path].join(" › ")}</p>
            <h2>${page.title}</h2>
            <p class="pd-meta">Last saved by ${page.updatedByName}, ${ago(page.updatedAt)} ago</p>
            <div class="pd-actions pd-page-acts">
                ${write && html`<button class="button small" onClick=${() => go({ kind: "edit", scope, id, folderId: page.folderId, title: page.title, body: page.body })}>Edit</button>`}
                <button class="button small" onClick=${() => go({ kind: "history", scope, id })}>History</button>
                <button class="button primary small" onClick=${ask}>Ask Pi</button>
                <span class="pd-sp"></span>
                ${write && html`<button class="link danger small" onClick=${remove}>Delete</button>`}
            </div>
            <${DocMarkdown} scope=${scope} text=${page.body} />
            ${
                links.length > 0 &&
                html`<div class="pd-backlinks">
                    <span>Linked from</span>
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
                        throw new Error(`${file.name}: an image may be 10 MB at most.`);
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
                    pocket.notify("info", `Saved ${page.title}.`);
                    saved(page);
                }, (error) => setProblem(error.message))
                .finally(() => setBusy(false));
        };

        return html`<div class="pd-editor">
            <label class="field"><span class="label">Title</span><input value=${title} maxlength="120" onInput=${(event) => setTitle(event.currentTarget.value)} /></label>
            <label class="field"
                ><span class="label">Folder</span
                ><select value=${folder} onChange=${(event) => setFolder(event.currentTarget.value)}>
                    <option value="">(the top)</option>
                    ${folders.map((each) => html`<option value=${each.id}>${named(each.id)}</option>`)}
                </select></label
            >
            ${
                preview
                    ? html`<${DocMarkdown} scope=${scope} text=${body} />`
                    : html`<textarea
                          ref=${text}
                          class="pd-text mono"
                          aria-label="Page (markdown)"
                          placeholder="Markdown. [[Another page]] links to a page here; [[team:Page]] or [[PP:Page]] to one elsewhere. Paste an image to add it."
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
                <button class="button small" onClick=${() => setPreview(!preview)}>${preview ? "Edit" : "Preview"}</button>
                <button class="button small" disabled=${adding > 0} onClick=${() => picker.current?.click()}>${adding > 0 ? "Adding…" : "+ Image"}</button>
                <span class="pd-sp"></span>
                <button class="button primary small" disabled=${busy || title.trim() === ""} onClick=${save}>${busy ? "Saving…" : "Save"}</button>
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
            return html`<${Loader} label="Opening its history" />`;
        }

        const restore = (version) => call(scope, "restore", id, version.id).then((page) => (pocket.notify("info", `Brought back the version of ${ago(version.at)} ago.`), saved(page)), failed);

        return html`<div class="pd-history">
            <h3>History</h3>
            ${versions.map(
                (version, index) => html`<div class="pd-version" key=${version.id}>
                    <button class="pd-row" onClick=${() => call(scope, "version", id, version.id).then(setShown, failed)}>
                        <span class="pd-row-title">${version.title}${index === 0 ? " (now)" : ""}</span>
                        <span class="pd-row-meta">${version.byName} · ${when(version.at)}</span>
                    </button>
                    ${write && index > 0 && html`<button class="button small" onClick=${() => restore(version)}>Bring back</button>`}
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
            return html`<${Loader} label="Opening" />`;
        }

        const restore = (page) =>
            call(scope, "history", page.id)
                .then((versions) => call(scope, "restore", page.id, versions[0].id))
                .then((back) => (pocket.notify("info", `${back.title} is back.`), saved(back)), failed);

        return html`<div>
            <h3>Deleted pages</h3>
            ${pages.length === 0 && html`<p class="pd-meta">Nothing deleted here.</p>`}
            ${pages.map(
                (page) => html`<div class="pd-version" key=${page.id}>
                    <span class="pd-row"><span class="pd-row-title">${page.title}</span><span class="pd-row-meta">${page.updatedByName} · ${ago(page.updatedAt)}</span></span>
                    ${write && html`<button class="button small" onClick=${() => restore(page)}>Bring back</button>`}
                </div>`,
            )}
        </div>`;
    }

    pocket.page({ id: "docs", title: "Documents", component: DocsPage });
    pocket.rail({ id: "docs", title: "Documents", iconPath: DOCS, page: "docs" });
    pocket.launcher({ id: "docs", label: "Documents", detail: "yours, the team's, and each board's, in folders", iconPath: DOCS, keywords: ["docs", "documents", "pages", "notes"], page: "docs" });
}
