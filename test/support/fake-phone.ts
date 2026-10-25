// A phone for tests of phone control (PP-141): it answers the server's phone-control channel as the app's service does
// (`PhoneControl.java`), with realistic accessibility trees (Settings, a launcher, an app with a list and a login form),
// and checks each scoped request as the service does: the app in front must be in the session and never pi-phone or on
// the Never list. Everything it is asked is recorded.
import { createRequire } from "node:module";
import type { PhoneNode, PhoneWindow } from "../../src/server/phone-outline.ts";
import type { PhoneRequests } from "../../src/server/phone-requests.ts";

const V = 1024 | 32; // visible, enabled
const CLICK = 1;
const SCROLL = 4;
const FOCUSABLE = 8;
const CHECKABLE = 64;
const CHECKED = 128;
const PASSWORD = 512;
const EDITABLE = 2048;
const COLLECTION = 4096;

/** A node: class, bounds, the rest. */
export function node(c: string, b: [number, number, number, number], rest: Partial<PhoneNode> = {}, k: PhoneNode[] = []): PhoneNode {
    return { c, b, f: V | (rest.f ?? 0), ...(k.length === 0 ? {} : { k }), ...Object.fromEntries(Object.entries(rest).filter(([key]) => key !== "f")) };
}

const row = (top: number, title: string, summary: string, id = "com.android.settings") =>
    node("android.widget.LinearLayout", [0, top, 1080, top + 200], { f: CLICK | FOCUSABLE }, [
        node("android.widget.ImageView", [44, top + 64, 116, top + 136], { r: "android:id/icon" }),
        node("android.widget.RelativeLayout", [160, top + 40, 1036, top + 160], {}, [
            node("android.widget.TextView", [160, top + 40, 900, top + 100], { r: `${id}:id/title`, t: title }),
            node("android.widget.TextView", [160, top + 104, 900, top + 160], { r: `${id}:id/summary`, t: summary }),
        ]),
    ]);

/** Android 14's Settings home: a toolbar, a search bar, and its list of sections. */
export const SETTINGS: PhoneNode = node("android.widget.FrameLayout", [0, 0, 1080, 2400], {}, [
    node("android.widget.LinearLayout", [0, 0, 1080, 2400], { r: "com.android.settings:id/main_content" }, [
        node("android.widget.Toolbar", [0, 132, 1080, 300], { r: "com.android.settings:id/action_bar" }, [node("android.widget.TextView", [48, 170, 600, 260], { t: "Settings" })]),
        node("androidx.recyclerview.widget.RecyclerView", [0, 300, 1080, 2274], { r: "com.android.settings:id/recycler_view", f: SCROLL | COLLECTION }, [
            node("android.widget.LinearLayout", [40, 310, 1040, 450], { r: "com.android.settings:id/search_action_bar", f: CLICK }, [
                node("android.widget.TextView", [140, 340, 900, 420], { t: "Search settings" }),
            ]),
            row(470, "Network & internet", "Mobile, Wi\u2011Fi, hotspot"),
            row(670, "Connected devices", "Bluetooth, pairing"),
            row(870, "Apps", "Recent apps, default apps"),
            row(1070, "Notifications", "Notification history, conversations"),
            row(1270, "Battery", "100%"),
            node("android.widget.LinearLayout", [0, 1470, 1080, 1670], { f: CLICK | FOCUSABLE }, [
                node("android.widget.TextView", [160, 1510, 800, 1570], { t: "Dark theme" }),
                node("android.widget.Switch", [900, 1520, 1020, 1620], { r: "android:id/switch_widget", f: CHECKABLE | CHECKED }),
            ]),
            row(1670, "Storage", "34% used - 84 GB free"),
            row(1870, "Sound & vibration", "Volume, haptics, Do Not Disturb"),
            // Divider rows apps make clickable so taps do not fall through: no line.
            node("android.view.View", [0, 2070, 1080, 2072], { f: CLICK }),
        ]),
    ]),
]);

/** A shopping app: a search field, a list of shops, a Checkout button (a clickable frame around its text), and sign-in. */
export const GRAB: PhoneNode = node("android.widget.FrameLayout", [0, 0, 1080, 2400], {}, [
    node("android.widget.EditText", [40, 160, 1040, 280], { r: "com.grabtaxi.passenger:id/search", h: "Search for food", t: "Search for food", f: CLICK | FOCUSABLE | EDITABLE }),
    node("androidx.recyclerview.widget.RecyclerView", [0, 300, 1080, 1500], { r: "com.grabtaxi.passenger:id/shops", f: SCROLL }, [
        node("android.widget.FrameLayout", [0, 300, 1080, 600], { r: "com.grabtaxi.passenger:id/shop", f: CLICK }, [node("android.widget.TextView", [40, 340, 900, 420], { t: "Pho Thin" })]),
        node("android.widget.FrameLayout", [0, 600, 1080, 900], { r: "com.grabtaxi.passenger:id/shop", f: CLICK }, [node("android.widget.TextView", [40, 640, 900, 720], { t: "Banh Mi 25" })]),
        node("android.widget.FrameLayout", [0, 900, 1080, 1200], { r: "com.grabtaxi.passenger:id/shop", f: CLICK }, [node("android.widget.TextView", [40, 940, 900, 1020], { t: "Cong Caphe" })]),
    ]),
    node("android.widget.EditText", [40, 1560, 1040, 1680], { r: "com.grabtaxi.passenger:id/password", h: "Password", f: CLICK | FOCUSABLE | EDITABLE | PASSWORD, t: "hunter2-never-shown" }),
    node("android.widget.FrameLayout", [40, 2200, 1040, 2340], { r: "com.grabtaxi.passenger:id/checkout", f: CLICK }, [node("android.widget.TextView", [400, 2240, 700, 2300], { t: "Checkout" })]),
]);

const icon = (label: string, x: number) => node("android.widget.TextView", [x, 1800, x + 200, 2000], { d: label, t: label, f: CLICK });

export const LAUNCHER: PhoneNode = node("android.widget.FrameLayout", [0, 0, 1080, 2400], {}, [
    node("android.view.ViewGroup", [0, 1780, 1080, 2020], { r: "com.android.launcher3:id/hotseat" }, [icon("Grab", 100), icon("Notes", 400), icon("Settings", 700)]),
]);

export const APPS = [
    { label: "Grab", package: "com.grabtaxi.passenger" },
    { label: "Notes", package: "com.example.notes" },
    { label: "Settings", package: "com.android.settings" },
    { label: "Vietcombank", package: "com.VCB" },
    { label: "Bitwarden", package: "com.x8bit.bitwarden" },
    { label: "pi", package: "io.piphone" },
];

const TREES: Record<string, PhoneNode> = {
    "com.android.launcher3": LAUNCHER,
    "com.android.settings": SETTINGS,
    "com.grabtaxi.passenger": GRAB,
    "com.example.notes": node("android.widget.FrameLayout", [0, 0, 1080, 2400], {}, [node("android.widget.TextView", [0, 300, 1080, 400], { t: "My private note" })]),
    // What Settings' Battery opens on a Samsung: an app of its own (as Device care is), with a button that opens Notes.
    "com.example.devicecare": node("android.widget.FrameLayout", [0, 0, 1080, 2400], {}, [
        node("android.widget.TextView", [0, 300, 1080, 400], { t: "Battery health: Good" }),
        node("android.widget.Button", [0, 500, 1080, 600], { t: "Open Notes", f: CLICK | FOCUSABLE }),
    ]),
};

const matches = (pattern: string, name: string) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

type Request = Record<string, unknown> & { id: string; seq: number; op: string };

export class FakePhone {
    foreground: string | null = "io.piphone";
    readonly launcher = "com.android.launcher3";
    enabled = true;
    keyboard = false;
    /** Every request, as it came. */
    readonly asked: Request[] = [];
    /** What the service refused, as it would say it. */
    readonly refused: string[] = [];
    banner: { until: number; apps: string; again?: boolean } | undefined;
    #stop = new AbortController();

    /** Answer `requests` until `detach`. */
    attach(requests: PhoneRequests): void {
        this.#stop = new AbortController();
        const signal = this.#stop.signal;

        void (async () => {
            let after = -1;

            while (!signal.aborted) {
                const { seq, requests: open } = await requests.after(after, signal);

                for (const request of open as Request[]) {
                    let answer: Record<string, unknown>;

                    try {
                        answer = this.#handle(request);
                    } catch (error) {
                        answer = { error: error instanceof Error ? error.message : String(error) };
                    }

                    try {
                        requests.answer(request.id, answer);
                    } catch {
                        // Timed out on the server's side.
                    }
                }

                after = seq;
            }
        })();
    }

    detach(): void {
        this.#stop.abort();
    }

    ops(op: string): Request[] {
        return this.asked.filter((each) => each.op === op);
    }

    /** The service's own check of a scoped request (`PhoneControl.java` `refusal`). */
    #check(request: Request, front: boolean): void {
        const allowed = request.allowed as string[] | undefined;
        const never = (request.never as string[] | undefined) ?? [];

        if (allowed === undefined || Number(request.until) <= Date.now()) {
            throw new Error("no phone control session is active");
        }

        // The banner goes up again first when it is not (the app's process started again in a session).
        if (this.banner?.until !== Number(request.until)) {
            this.banner = { until: Number(request.until), apps: String(request.apps), again: true };
        }

        if (!front) {
            return;
        }

        const name = this.foreground ?? "";

        if (name === "io.piphone" || never.some((pattern) => matches(pattern, name)) || !allowed.includes(name)) {
            this.refused.push(name);

            throw new Error(`${name} is not an app this session may touch`);
        }
    }

    #handle(request: Request): Record<string, unknown> {
        this.asked.push(request);

        switch (request.op) {
            case "status":
                return { enabled: this.enabled, android: 34, screenshot: true, foreground: this.foreground, launcher: this.launcher, unrestricted: true };
            case "front":
                return { foreground: this.foreground };
            case "apps":
                return { apps: APPS };
            case "label": {
                // Any installed app's name: Device care has no icon of its own, so it is not among `apps`.
                const name = String(request.package);
                const label = name === "com.example.devicecare" ? "Device care" : APPS.find((each) => each.package === name)?.label;

                if (label === undefined) {
                    throw new Error(`${name} is not installed`);
                }

                return { label };
            }
            case "banner":
                this.banner = request.show === true ? { until: Number(request.until), apps: String(request.apps) } : undefined;

                return {};
            case "tree": {
                this.#check(request, false);
                const name = this.foreground ?? "";
                const readable = name !== "io.piphone" && (request.allowed as string[]).includes(name) && !(request.never as string[]).some((pattern) => matches(pattern, name));
                const windows: PhoneWindow[] = [
                    { id: 1, type: "application", package: name, layer: 1, active: true, ...(readable && TREES[name] !== undefined ? { root: TREES[name] } : {}) },
                    { id: 2, type: "system", package: "com.android.systemui", layer: 5, active: false },
                ];

                return { display: { width: 1080, height: 2400 }, foreground: this.foreground, keyboard: this.keyboard, windows };
            }
            case "tap":
            case "press": {
                this.#check(request, true);
                const x = Number(request.x);
                const y = Number(request.y);

                if (this.foreground === this.launcher && y >= 1800 && y <= 2000) {
                    this.foreground = x < 300 ? "com.grabtaxi.passenger" : x < 600 ? "com.example.notes" : "com.android.settings";
                }

                if (this.foreground === "com.grabtaxi.passenger" && y < 300) {
                    this.keyboard = true;
                }

                // Settings' Battery row opens Device care; Device care's button opens Notes.
                if (this.foreground === "com.android.settings" && y >= 1270 && y < 1470) {
                    this.foreground = "com.example.devicecare";
                } else if (this.foreground === "com.example.devicecare" && y >= 500 && y < 600) {
                    this.foreground = "com.example.notes";
                }

                return {};
            }
            case "swipe":
            case "type":
                this.#check(request, true);

                return {};
            case "button":
                this.#check(request, request.name !== "back" && request.name !== "home");

                if (request.name === "home") {
                    this.foreground = this.launcher;
                }

                return {};
            case "open":
                this.#check(request, false);

                if (!(request.allowed as string[]).includes(String(request.package))) {
                    throw new Error("not in this session");
                }

                this.foreground = String(request.package);

                return {};
            case "shot": {
                this.#check(request, true);
                const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as {
                    PhotonImage: new (raw: Uint8Array, width: number, height: number) => { get_bytes_jpeg(quality: number): Uint8Array; free(): void };
                };
                const image = new photon.PhotonImage(new Uint8Array(108 * 240 * 4).fill(200), 108, 240);

                try {
                    return { jpeg: Buffer.from(image.get_bytes_jpeg(80)).toString("base64"), width: 1080, height: 2400 };
                } finally {
                    image.free();
                }
            }
            default:
                throw new Error(`unknown request ${request.op}`);
        }
    }
}
