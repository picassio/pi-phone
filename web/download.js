// Saving a file from the server on this device. In the app, the shell saves it to Downloads (`MainActivity`'s
// `download`, with this page's sign-in); a browser elsewhere gets it as any download. A server's refusal (too large,
// not a file) is shown either way, by the shell or as the error here.
import { api, notify } from "./store.js";

/**
 * Save an image the page shows (PP-16): one at the app's address downloads as it is; one only in the page (a `data:`
 * address, as Pi's pictures are) goes to the server first, which keeps it a few minutes at an address the app's shell
 * can save. `title` names the file; its extension comes from the image's type.
 */
export async function downloadImage(src, title) {
    const base = (title || "image").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "image";

    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
        const path = new URL(src, location.href).pathname;
        const own = /\.[a-z0-9]{2,5}$/i.exec(path)?.[0] ?? ".png";

        return downloadFile(src, /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + own);
    }

    const blob = await (await fetch(src)).blob();
    const extension = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg" }[blob.type] ?? ".png";
    const name = /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + extension;

    if (!window.PiPhoneApp?.download) {
        const link = document.createElement("a");

        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 60_000);

        return;
    }

    const { url } = await api("kept-downloads", blob);

    return downloadFile(url, name);
}

export async function downloadFile(url, name) {
    if (window.PiPhoneApp?.download) {
        window.PiPhoneApp.download(new URL(url, location.href).href, name);
        notify("info", `Saving ${name} to Downloads…`);

        return;
    }

    const response = await fetch(url);

    if (!response.ok) {
        const text = await response.text();

        throw new Error(JSON.parse(text || "{}").error ?? `HTTP ${response.status}`);
    }

    const link = document.createElement("a");

    link.href = URL.createObjectURL(await response.blob());
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
