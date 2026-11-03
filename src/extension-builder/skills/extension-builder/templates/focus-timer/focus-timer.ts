/**
 * Focus timer: a rail button that opens a page with a timer for focused work.
 *
 * Template (pi-phone's extension-builder skill): a drop-in with only a browser part. The server part names it with
 * `web.client` and returns nothing: what it adds is the rail button and the page, in `focus-timer.js`.
 */

/** The version of pi-phone's extension API this module is written for. */
export const pocketApi = 2;

/** The part of the `web` argument this module uses. */
type Web = { client(entry: string, options?: { access?: "owner" | "steer" | "view" }): void };

export default function createFocusTimer(_host: unknown, web: Web): void {
    // The browser part beside this file; the owner's alone unless `access` says otherwise.
    web.client("focus-timer.js");
}
