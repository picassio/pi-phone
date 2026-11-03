/**
 * Snippets: texts you use often, kept in this browser, put into the message box from a sheet.
 *
 * Template (pi-phone's extension-builder skill): a drop-in whose browser part adds a menu row and a launcher action
 * that open a sheet. What it keeps is this browser's own (`localStorage`); what Pi should reach belongs on the server
 * (the checklist template).
 */

/** The version of pi-phone's extension API this module is written for. */
export const pocketApi = 2;

/** The part of the `web` argument this module uses. */
type Web = { client(entry: string, options?: { access?: "owner" | "steer" | "view" }): void };

export default function createSnippets(_host: unknown, web: Web): void {
    web.client("snippets.js");
}
