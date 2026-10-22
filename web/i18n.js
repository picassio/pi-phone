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

        if (/^en\b/i.test(tag)) {
            return "en";
        }
    }

    return "en";
}

let language = "en";
let catalog = {};

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

/** The language in use: "en" or "zh-CN". */
export const currentLanguage = () => language;

/** The person's choice as this browser remembers it ("auto" when none). */
export const storedChoice = () => globalThis.localStorage?.getItem(KEY) ?? "auto";

/** Use `id` with `entries` (its catalog): for tests, and for the start below. */
export function useCatalog(id, entries) {
    language = id;
    catalog = entries;
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

// ─── The start: the language this page is in, and its catalog, before anything draws ───

if (globalThis.document !== undefined) {
    const id = resolveLanguage(storedChoice(), navigator.languages ?? [navigator.language]);

    document.documentElement.lang = id;

    if (id !== "en") {
        try {
            const response = await fetch(`i18n/${id}.json`);

            useCatalog(id, response.ok ? await response.json() : {});
        } catch {
            // Offline with no copy: English, as every text is written.
            useCatalog(id, {});
        }
    }
}
