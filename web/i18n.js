// The app's words in the person's language (PP-81). Each text is written in English where it is used, as a whole
// sentence, and that sentence is its key: `t("Move {title} to a group", { title })`. A catalog (web/i18n/<locale>.json)
// gives the sentence in another language, written freely (its word order is its own); a text it lacks shows in English.
// Placeholders are `{name}`; a catalog's sentence must use the same ones (scripts/i18n-check.ts makes sure).
//
// The language: the person's choice (Appearance › Language, kept on the server with them), remembered by this browser
// so the first draw is in it; "auto" follows the browser or phone. Changing it loads the page again in the new one.

/** The languages the app speaks, each named in itself. */
export const LANGUAGES = [
    { id: "en", name: "English" },
    { id: "zh-CN", name: "简体中文" },
    { id: "vi", name: "Tiếng Việt" },
];

const KEY = "pocket.language";

/** The language a choice means here: "auto" picks the browser's, when the app speaks it. */
export function resolveLanguage(choice, preferred = []) {
    if (choice !== undefined && choice !== "auto" && LANGUAGES.some((each) => each.id === choice)) {
        return choice;
    }

    for (const tag of preferred) {
        // Chinese of every script reads Simplified for now: the only Chinese catalog there is.
        if (/^zh\b/i.test(tag)) {
            return "zh-CN";
        }

        if (/^vi\b/i.test(tag)) {
            return "vi";
        }

        if (/^en\b/i.test(tag)) {
            return "en";
        }
    }

    return "en";
}

let language = "en";
let catalog = {};
/** The server's messages in the language (web/i18n/<locale>.server.json): exact ones, and patterns with {1}, {2}… */
let serverCatalog = {};
let serverPatterns = null;

/** Put `text`'s placeholders in: `{name}` from `vars`; one with no value stays as written. */
function fill(text, vars) {
    return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));
}

/** A sentence in the person's language, with its placeholders filled. */
export function t(text, vars) {
    const found = catalog[text];

    return fill(typeof found === "string" && found !== "" ? found : text, vars);
}

/**
 * A sentence with elements in it (a name in bold, a link): its pieces, text and the values given, in the order the
 * language puts them, for a template to show: `html\`<span>\${tx("{who} asks to drive", { who: html\`<b>…</b>\` })}</span>\``.
 */
export function tx(text, vars) {
    const found = catalog[text];
    const sentence = typeof found === "string" && found !== "" ? found : text;

    return sentence.split(/\{(\w+)\}/).map((piece, index) => (index % 2 === 1 ? (Object.hasOwn(vars, piece) ? vars[piece] : `{${piece}}`) : piece)).filter((piece) => piece !== "");
}

/**
 * A sentence with a count: `one` when `n` is 1, else `other` (English's two forms; a catalog gives each its own, and
 * Chinese writes both the same). `{n}` is the count.
 */
export function tn(n, one, other, vars = {}) {
    return t(n === 1 ? one : other, { n, ...vars });
}

/** The language in use: "en", "zh-CN" or "vi". */
export const currentLanguage = () => language;

/** The person's choice as this browser remembers it ("auto" when none). */
export const storedChoice = () => globalThis.localStorage?.getItem(KEY) ?? "auto";

/** Use `id` with `entries` (its catalog) and `server` (its server messages): for tests, and for the start below. */
export function useCatalog(id, entries, server = {}) {
    language = id;
    catalog = entries;
    serverCatalog = server;
    serverPatterns = null;
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A message from the server (an error, a notice) in the person's language (PP-85): the server writes them in English,
 * and the catalog has each, those with parts that change as patterns ("There is no folder {1} on {2}."). The parts
 * are put back as they came, each translated too when it is a message of its own (a reason inside a message). A
 * message the catalog lacks stays in English.
 */
export function tServer(message, depth = 0) {
    if (typeof message !== "string" || message === "" || language === "en") {
        return message;
    }

    const exact = serverCatalog[message];

    if (typeof exact === "string" && exact !== "") {
        return exact;
    }

    // The most specific first: more fixed words, fewer parts that change.
    serverPatterns ??= Object.entries(serverCatalog)
        .filter(([english, translated]) => /\{\d+\}/.test(english) && typeof translated === "string" && translated !== "")
        .map(([english, translated]) => ({
            regex: new RegExp(`^${english.split(/\{\d+\}/).map(escaped).join("([\\s\\S]+?)")}$`),
            names: [...english.matchAll(/\{(\d+)\}/g)].map((match) => match[1]),
            translated,
            fixed: english.replace(/\{\d+\}/g, "").length,
        }))
        .sort((a, b) => b.fixed - a.fixed);

    for (const pattern of serverPatterns) {
        const match = pattern.regex.exec(message);

        if (match !== null) {
            return pattern.translated.replace(/\{(\d+)\}/g, (whole, name) => {
                const part = match[pattern.names.indexOf(name) + 1];

                return part === undefined ? whole : depth < 2 ? tServer(part, depth + 1) : part;
            });
        }
    }

    return message;
}

/**
 * The person's choice came from the server (hello, or Appearance): remember it, and when it means another language
 * than the page is in, load the page again in it. True when it does.
 */
export function chooseLanguage(choice) {
    const next = choice === undefined || choice === null ? "auto" : choice;

    if (storedChoice() !== next) {
        globalThis.localStorage?.setItem(KEY, next);
    }

    if (resolveLanguage(next, navigator.languages ?? [navigator.language]) !== language) {
        location.reload();

        return true;
    }

    return false;
}

// ─── Formatting in the language in use ───

const locale = () => (language === "en" ? undefined : language);

/** A number as the language writes it (1,234). */
export const formatNumber = (value, options) => new Intl.NumberFormat(locale(), options).format(value);

/** A date and time as the language writes it. */
export const formatDate = (ms, options) => new Date(ms).toLocaleString(locale(), options);

/** How long ago, short: "now", "5m", "2h", "3d" (刚刚, 5分钟, 2小时, 3天), then the date. */
export function timeAgo(ms) {
    const seconds = Math.max(0, (Date.now() - ms) / 1000);

    if (seconds < 45) {
        return t("now");
    }

    if (seconds < 3600) {
        return t("{n}m", { n: Math.round(seconds / 60) });
    }

    if (seconds < 86400) {
        return t("{n}h", { n: Math.round(seconds / 3600) });
    }

    if (seconds < 86400 * 30) {
        return t("{n}d", { n: Math.round(seconds / 86400) });
    }

    return formatDate(ms, { month: "short", day: "numeric" });
}

/** "5m ago" for a sentence ("connected {when}"): "just now" when it was, never "now ago". */
export function agoText(ms) {
    const seconds = Math.max(0, (Date.now() - ms) / 1000);

    if (seconds < 45) {
        return t("just now");
    }

    // A date (past a month) reads as it is.
    return seconds < 86400 * 30 ? t("{ago} ago", { ago: timeAgo(ms) }) : timeAgo(ms);
}

// ─── The start: the language this page is in, and its catalog, before anything draws ───

if (globalThis.document !== undefined) {
    const id = resolveLanguage(storedChoice(), navigator.languages ?? [navigator.language]);

    document.documentElement.lang = id;

    if (id !== "en") {
        // Beside this module, wherever it is served: the app's root, a shared space's, or the gateway's /auth/static/.
        const load = async (name) => {
            try {
                const response = await fetch(new URL(`i18n/${name}.json`, import.meta.url));

                return response.ok ? await response.json() : {};
            } catch {
                // Offline with no copy: English, as every text is written.
                return {};
            }
        };
        const [entries, server] = await Promise.all([load(id), load(`${id}.server`)]);

        useCatalog(id, entries, server);
    }
}
