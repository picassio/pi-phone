// An image, in a viewer of its own: full screen, zoomed by pinching, double-tapping, the wheel, or the bar's buttons.
import { useEffect, useRef, useState } from "preact/hooks";
import { closeSheet } from "../store.js";
import { html, Icon } from "../ui.js";

const MIN = 1;
const MAX = 8;
/** What a double tap zooms to from fit. */
const DOUBLE = 2.5;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_MS = 300;
const DOUBLE_PX = 30;
/** A press that moves less than this is a tap. */
const TAP_PX = 8;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * An image full screen. At fit, a tap beside the image closes it; zoomed, one finger (or the mouse) pans it, two pinch.
 * Inside the Android app there is no Open: a link out would take the app's only page away.
 */
export function ImageViewer({ src, alt }) {
    // Scale, and the image's offset from the stage's center, in screen pixels.
    const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
    const viewRef = useRef(view);
    const stage = useRef(null);
    const image = useRef(null);
    const pointers = useRef(new Map());
    const gesture = useRef(null);
    const lastTap = useRef(null);
    const inApp = Boolean(window.PiPhoneApp);

    viewRef.current = view;

    /** Keep the image covering what it can: no panning past its edges, centered on an axis where it fits. */
    const bounded = ({ scale, x, y }) => {
        const box = stage.current?.getBoundingClientRect();
        const img = image.current;

        if (!box || !img) {
            return { scale, x, y };
        }

        const room = (size, shown) => Math.max(0, (shown * scale - size) / 2);

        return {
            scale,
            x: clamp(x, -room(box.width, img.offsetWidth), room(box.width, img.offsetWidth)),
            y: clamp(y, -room(box.height, img.offsetHeight), room(box.height, img.offsetHeight)),
        };
    };

    /** Zoom to `scale`, keeping the point at (`cx`, `cy`) on screen where it is. */
    const zoomAt = (scale, cx, cy) => {
        const box = stage.current.getBoundingClientRect();
        const now = viewRef.current;
        const next = clamp(scale, MIN, MAX);
        // The point under (cx, cy), relative to the stage's center, before and after.
        const px = cx - box.left - box.width / 2;
        const py = cy - box.top - box.height / 2;
        const ratio = next / now.scale;

        setView(
            next === MIN
                ? { scale: MIN, x: 0, y: 0 }
                : bounded({ scale: next, x: px - (px - now.x) * ratio, y: py - (py - now.y) * ratio }),
        );
    };

    const zoomBy = (factor) => {
        const box = stage.current.getBoundingClientRect();

        zoomAt(viewRef.current.scale * factor, box.left + box.width / 2, box.top + box.height / 2);
    };

    useEffect(() => {
        const onKey = (event) => {
            if (event.key === "Escape") {
                closeSheet();
            } else if (event.key === "+" || event.key === "=") {
                zoomBy(1.5);
            } else if (event.key === "-") {
                zoomBy(1 / 1.5);
            } else if (event.key === "0") {
                setView({ scale: 1, x: 0, y: 0 });
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    const spread = () => {
        const [a, b] = [...pointers.current.values()];

        return {
            distance: Math.hypot(a.x - b.x, a.y - b.y),
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
        };
    };

    const onPointerDown = (event) => {
        if (event.target.closest(".lightbox-bar")) {
            return;
        }

        stage.current.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (pointers.current.size === 2) {
            gesture.current = { kind: "pinch", start: spread(), view: viewRef.current };
        } else if (pointers.current.size === 1) {
            gesture.current = {
                kind: "pan",
                x: event.clientX,
                y: event.clientY,
                view: viewRef.current,
                moved: false,
            };
        }
    };

    const onPointerMove = (event) => {
        if (!pointers.current.has(event.pointerId)) {
            return;
        }

        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const now = gesture.current;

        if (now?.kind === "pinch" && pointers.current.size === 2) {
            const { distance, cx, cy } = spread();
            const scale = clamp((now.view.scale * distance) / now.start.distance, MIN, MAX);
            const box = stage.current.getBoundingClientRect();
            // The pinch's starting center, relative to the stage's center, follows the fingers' center.
            const sx = now.start.cx - box.left - box.width / 2;
            const sy = now.start.cy - box.top - box.height / 2;
            const ratio = scale / now.view.scale;

            setView(
                bounded({
                    scale,
                    x: sx - (sx - now.view.x) * ratio + (cx - now.start.cx),
                    y: sy - (sy - now.view.y) * ratio + (cy - now.start.cy),
                }),
            );
        } else if (now?.kind === "pan") {
            const dx = event.clientX - now.x;
            const dy = event.clientY - now.y;

            if (Math.hypot(dx, dy) > TAP_PX) {
                now.moved = true;
            }

            if (now.view.scale > MIN) {
                setView(bounded({ scale: now.view.scale, x: now.view.x + dx, y: now.view.y + dy }));
            }
        }
    };

    const onPointerUp = (event) => {
        if (!pointers.current.delete(event.pointerId)) {
            return;
        }

        const now = gesture.current;

        if (now?.kind === "pinch") {
            // One finger still down pans on from where the pinch left the image.
            const [rest] = [...pointers.current.values()];

            gesture.current = rest
                ? { kind: "pan", x: rest.x, y: rest.y, view: viewRef.current, moved: true }
                : null;
            // A pinch let go almost at fit snaps to it.
            if (viewRef.current.scale < 1.05) {
                setView({ scale: 1, x: 0, y: 0 });
            }

            return;
        }

        gesture.current = null;

        if (now?.kind !== "pan" || now.moved || event.type === "pointercancel") {
            return;
        }

        // A tap: a second one soon after, close by, is a double tap.
        const tap = { at: Date.now(), x: event.clientX, y: event.clientY };
        const last = lastTap.current;

        if (last && tap.at - last.at < DOUBLE_MS && Math.hypot(tap.x - last.x, tap.y - last.y) < DOUBLE_PX) {
            lastTap.current = null;
            clearTimeout(last.timer);

            if (viewRef.current.scale > MIN) {
                setView({ scale: 1, x: 0, y: 0 });
            } else {
                zoomAt(DOUBLE, tap.x, tap.y);
            }

            return;
        }

        // A single tap beside the image at fit closes it, once it is clear no second tap follows.
        const beside = !image.current?.contains(event.target);

        tap.timer = setTimeout(() => {
            if (lastTap.current === tap) {
                lastTap.current = null;

                if (beside && viewRef.current.scale === MIN) {
                    closeSheet();
                }
            }
        }, DOUBLE_MS);
        lastTap.current = tap;
    };

    const onWheel = (event) => {
        event.preventDefault();
        zoomAt(viewRef.current.scale * Math.exp(-event.deltaY / 300), event.clientX, event.clientY);
    };

    useEffect(() => {
        const element = stage.current;

        // Not passive: the wheel zooms the image, not the page.
        element.addEventListener("wheel", onWheel, { passive: false });

        return () => element.removeEventListener("wheel", onWheel);
    }, []);

    const zoomed = view.scale > MIN;

    return html`<div
        class=${`lightbox ${zoomed ? "zoomed" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label=${alt || "Image"}
        ref=${stage}
        onPointerDown=${onPointerDown}
        onPointerMove=${onPointerMove}
        onPointerUp=${onPointerUp}
        onPointerCancel=${onPointerUp}
    >
        <img
            ref=${image}
            src=${src}
            alt=${alt ?? ""}
            draggable="false"
            style=${`transform: translate(${view.x}px, ${view.y}px) scale(${view.scale})`}
        />
        <div class="lightbox-bar">
            <span class="lightbox-title">${alt ?? ""}</span>
            <button class="icon-button" onClick=${() => zoomBy(1 / 1.5)} disabled=${!zoomed} aria-label="Zoom out">
                <span aria-hidden="true">−</span>
            </button>
            <button
                class="link small lightbox-zoom"
                onClick=${() => setView({ scale: 1, x: 0, y: 0 })}
                title="Fit to the screen"
            >
                ${Math.round(view.scale * 100)}%
            </button>
            <button class="icon-button" onClick=${() => zoomBy(1.5)} disabled=${view.scale >= MAX} aria-label="Zoom in">
                <span aria-hidden="true">+</span>
            </button>
            ${!inApp && html`<a class="button small" href=${src} target="_blank" rel="noopener">Open</a>`}
            <button class="icon-button" onClick=${closeSheet} aria-label="Close">
                <${Icon} name="close" />
            </button>
        </div>
    </div>`;
}
