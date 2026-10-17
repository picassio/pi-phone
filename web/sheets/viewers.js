// An image, in a viewer of its own.
import { useEffect } from "preact/hooks";
import { closeSheet } from "../store.js";
import { html, Icon } from "../ui.js";

/** An image full screen. Tap anywhere to close; Open shows it in its own tab to zoom, save, or share. */
export function ImageViewer({ src, alt }) {
    useEffect(() => {
        const onKey = (event) => event.key === "Escape" && closeSheet();

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    return html`<div
        class="lightbox"
        role="dialog"
        aria-modal="true"
        aria-label=${alt || "Image"}
        onClick=${closeSheet}
    >
        <img src=${src} alt=${alt ?? ""} />
        <div class="lightbox-bar" onClick=${(event) => event.stopPropagation()}>
            <span class="lightbox-title">${alt ?? ""}</span>
            <a class="button small" href=${src} target="_blank" rel="noopener">Open</a>
            <button class="icon-button" onClick=${closeSheet} aria-label="Close">
                <${Icon} name="close" />
            </button>
        </div>
    </div>`;
}
