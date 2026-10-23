/**
 * The app's words on the server (PP-85), for what the server itself says in a person's language: the phone's
 * notifications. The same catalogs as the web app's (web/i18n/<locale>.json, keyed by the English sentence), read once;
 * a sentence a catalog lacks is said in English. `scripts/i18n-check.ts` finds the sentences of `t` calls here too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

/** The languages the app speaks (as web/i18n.js's LANGUAGES). */
export const LANGUAGES = ["en", "zh-CN"] as const;

export type Language = (typeof LANGUAGES)[number];

/** A person's choice ("auto", or a language), resolved with a device's own language for "auto". */
export function resolveLanguage(choice: string | undefined, device: string | undefined): Language {
    if (choice !== undefined && choice !== "auto" && (LANGUAGES as readonly string[]).includes(choice)) {
        return choice as Language;
    }

    // Chinese of every script reads Simplified for now: the only Chinese catalog there is.
    return /^zh\b/i.test(device ?? "") ? "zh-CN" : "en";
}

const catalogs = new Map<Language, Record<string, string>>();

function catalogOf(language: Language): Record<string, string> {
    let catalog = catalogs.get(language);

    if (catalog === undefined) {
        catalog = language === "en" ? {} : (JSON.parse(readFileSync(join(APP_ROOT, "web", "i18n", `${language}.json`), "utf8")) as Record<string, string>);
        catalogs.set(language, catalog);
    }

    return catalog;
}

export type Translate = (text: string, vars?: Record<string, string | number>) => string;

/** `t` for one language: the sentence in it, its `{name}` placeholders filled. */
export function translator(language: Language): Translate {
    const catalog = catalogOf(language);

    return (text, vars) => {
        const found = catalog[text];
        const sentence = typeof found === "string" && found !== "" ? found : text;

        return vars === undefined ? sentence : sentence.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));
    };
}
