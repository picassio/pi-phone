/**
 * Test sites (PP-456): where Pi may run browser_run with a run model other than the setting's without the owner's card.
 * A run's page goes to the run model's provider each step (with Jev, OpenRouter), so on a real or production site a
 * change of provider is the owner's to approve; on a test site it is not.
 *
 * A test site is a page on this machine or a private network (`isLocalAddress`: localhost, 127/8, ::1, 10/8,
 * 172.16/12, 192.168/16, 169.254/16, 100.64/10), a host under a reserved test name (`TEST_SUFFIXES`), a file: or
 * about: page, or a host on the owner's list (`browser.testSites`: hosts, or `*.suffix` for every host under one). An
 * address is judged as written: on a machine, its own localhost is a test site. Everything else is a real site; so is
 * a computer app (`app:` in computer_run's state), whose window has no address to judge.
 */
import { isLocalAddress } from "./browser/page.ts";

/** Reserved names for testing and local networks (RFC 2606, 6761, 6762), and `.internal`. */
export const TEST_SUFFIXES = [".test", ".localhost", ".local", ".example", ".invalid", ".internal"] as const;

/** How many hosts the owner's list holds at most. */
export const TEST_SITES_MAX = 30;

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** The owner's list as typed (`*.ts.net, staging.example.com`): hosts, lower case, or what is wrong with it. */
export function parseTestSites(value: string): { sites: string[] } | { bad: string[] } | { tooMany: number } {
    const given = value
        .split(/[\s,]+/)
        .map((each) => each.trim().toLowerCase())
        .filter((each) => each !== "" && each !== "none");
    const bad = given.filter((each) => !HOST.test(each));

    if (bad.length > 0) {
        return { bad };
    }

    const sites = [...new Set(given)];

    return sites.length > TEST_SITES_MAX ? { tooMany: sites.length } : { sites };
}

/** Whether `url` is a test site, with the owner's list `sites`. */
export function isTestSite(url: string, sites: readonly string[]): boolean {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return false;
    }

    if (parsed.protocol === "file:" || parsed.protocol === "about:") {
        return true;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
    }

    const host = parsed.hostname.toLowerCase();

    if (isLocalAddress(url) || TEST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        return true;
    }

    return sites.some((site) => (site.startsWith("*.") ? host.endsWith(site.slice(1)) : host === site));
}

/** The site of a page, as a card names it: its host, or the address itself when it has none. */
export function siteOf(url: string): string {
    try {
        return new URL(url).host || url;
    } catch {
        return url;
    }
}
