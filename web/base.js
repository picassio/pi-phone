// The address the app lives under (PP-54): "/" for your own pi-phone and the phone, or "/space/<key>/" when a teammate
// opens a session you shared, through the team server's gateway. The server writes it as the page's <base href>, so the
// app's relative URLs (api/…, a/…, vendor/…) resolve under it. Routes inside the app stay as they were ("/s/12"): they
// meet the address bar only through these two.

/** The base's path, ending in "/". */
export const BASE = new URL(document.baseURI).pathname;

/** A route ("/s/12") as the address it has under the base ("/space/k/s/12"); the same route when the base is "/". */
export const at = (route) => (BASE === "/" ? route : `${BASE}${route.replace(/^\//, "")}`);

/** The route of an address under the base ("/space/k/s/12" → "/s/12"). */
export const routeOf = (path) => (BASE !== "/" && path.startsWith(BASE) ? `/${path.slice(BASE.length)}` : path);
