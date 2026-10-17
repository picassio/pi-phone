// Saving a file from the server on this device. In the app, the shell saves it to Downloads (`MainActivity`'s
// `download`, with this page's sign-in); a browser elsewhere gets it as any download. A server's refusal (too large,
// not a file) is shown either way, by the shell or as the error here.
import { notify } from "./store.js";

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
