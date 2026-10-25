/**
 * The phone's screen in words for Pi (PP-141): the accessibility tree the app's service reads (`PhoneControl.java`) as a
 * compact outline, numbered `[n]` like Pi's browser's controls (`browser/page.ts`), so Pi reads a phone like a page.
 * Ported from lycorp-jp/sim-use (Apache-2.0, Copyright 2026 LY Corporation): `AndroidOutlineRenderer.swift`,
 * `AndroidClassifier.swift`, `AndroidListDetector.swift` and `ElementType.swift`, cut down: regions Top / Content /
 * Bottom (and toolbars, tab bars, labelled lists), one line per element that carries a label, an id or an action;
 * clickable wrappers folded into the label they hold; lists with their row count; popups over an app alone; the
 * keyboard. Password fields never carry their value (the service does not send it).
 */

/** A node as the service sends it: short keys, empty fields left out. */
export type PhoneNode = {
    /** Class name. */
    c?: string;
    /** Resource id, `package:id/name`. */
    r?: string;
    /** Text (never a password field's). */
    t?: string;
    /** Content description. */
    d?: string;
    /** Hint. */
    h?: string;
    /** State description (Android 11+). */
    s?: string;
    /** Bounds on the screen: left, top, right, bottom, in pixels. */
    b: [number, number, number, number];
    /** Flags (`FLAG`). */
    f?: number;
    /** Its index among its parent's children, when not its place in `k` (a child Android gave as none is left out). */
    i?: number;
    k?: PhoneNode[];
};

/** A window on the screen; `root` only for windows of the app in front that may be read. */
export type PhoneWindow = {
    id: number;
    type: string;
    package: string;
    layer: number;
    active: boolean;
    root?: PhoneNode;
};

export type PhoneScreen = {
    display: { width: number; height: number };
    foreground: string | null;
    /** With no app known in front: the title of an app window whose content Android hides (`PhoneControl.hiddenTitle`). */
    hidden?: string;
    keyboard: boolean;
    windows: PhoneWindow[];
};

export const FLAG = {
    clickable: 1,
    longClickable: 2,
    scrollable: 4,
    focusable: 8,
    focused: 16,
    enabled: 32,
    checkable: 64,
    checked: 128,
    selected: 256,
    password: 512,
    visible: 1024,
    editable: 2048,
    collection: 4096,
} as const;

export type Frame = { x: number; y: number; width: number; height: number };

/** A numbered element: where it is, and how the service finds its node again (window, child indices). */
export type OutlineEntry = {
    index: number;
    role: string;
    label: string;
    frame: Frame;
    ref: { w: number; p: number[] };
    editable: boolean;
    password: boolean;
    scrollable: boolean;
};

export type Outline = { text: string; entries: OutlineEntry[]; size: { width: number; height: number } };

/** At most this many elements are listed; the rest are counted. */
const MAX_ENTRIES = 200;

const has = (node: PhoneNode, flag: number) => ((node.f ?? 0) & flag) !== 0;

/** sim-use's `ElementVocabulary`: class names to roles. */
const ROLES: Record<string, string> = {};

for (const [role, classes] of Object.entries({
    Button: [
        "android.widget.Button",
        "android.widget.ImageButton",
        "androidx.appcompat.widget.AppCompatButton",
        "androidx.appcompat.widget.AppCompatImageButton",
        "com.google.android.material.button.MaterialButton",
        "com.google.android.material.floatingactionbutton.FloatingActionButton",
    ],
    TextField: ["android.widget.EditText", "androidx.appcompat.widget.AppCompatEditText", "com.google.android.material.textfield.TextInputEditText", "android.widget.AutoCompleteTextView"],
    TextView: ["android.widget.TextView", "androidx.appcompat.widget.AppCompatTextView", "com.google.android.material.textview.MaterialTextView"],
    Switch: ["android.widget.Switch", "androidx.appcompat.widget.SwitchCompat", "com.google.android.material.switchmaterial.SwitchMaterial", "com.google.android.material.materialswitch.MaterialSwitch"],
    Checkbox: ["android.widget.CheckBox", "androidx.appcompat.widget.AppCompatCheckBox", "com.google.android.material.checkbox.MaterialCheckBox"],
    Radio: ["android.widget.RadioButton", "androidx.appcompat.widget.AppCompatRadioButton", "com.google.android.material.radiobutton.MaterialRadioButton"],
    Image: ["android.widget.ImageView", "androidx.appcompat.widget.AppCompatImageView"],
    NavigationBar: ["androidx.appcompat.widget.Toolbar", "com.google.android.material.appbar.MaterialToolbar", "android.widget.Toolbar"],
    ScrollView: ["android.widget.ScrollView", "androidx.core.widget.NestedScrollView", "android.widget.HorizontalScrollView"],
    List: ["androidx.recyclerview.widget.RecyclerView", "android.widget.ListView", "android.widget.GridView"],
    Slider: ["android.widget.SeekBar", "com.google.android.material.slider.Slider"],
    ProgressBar: ["android.widget.ProgressBar"],
    Spinner: ["android.widget.Spinner", "androidx.appcompat.widget.AppCompatSpinner"],
})) {
    for (const each of classes) {
        ROLES[each] = role;
    }
}

/** Containers whose elements make a region of their own. */
const REGIONS: Record<string, string> = {
    "androidx.appcompat.widget.Toolbar": "NavBar",
    "com.google.android.material.appbar.MaterialToolbar": "NavBar",
    "android.widget.Toolbar": "NavBar",
    "com.google.android.material.appbar.AppBarLayout": "NavBar",
    "com.google.android.material.bottomnavigation.BottomNavigationView": "TabBar",
    "com.google.android.material.navigation.NavigationBarView": "TabBar",
    "androidx.recyclerview.widget.RecyclerView": "List",
    "android.widget.ListView": "List",
    "android.widget.GridView": "List",
    "android.widget.ScrollView": "Scroll",
    "androidx.core.widget.NestedScrollView": "Scroll",
};

const COLLECTIONS = new Set(["androidx.recyclerview.widget.RecyclerView", "android.widget.ListView", "android.widget.GridView"]);

/** Layout classes: one without a label or an action of its own is skeleton, not something to address. */
const CONTAINERS = new Set([
    "android.view.View",
    "android.view.ViewGroup",
    "android.widget.FrameLayout",
    "android.widget.LinearLayout",
    "android.widget.RelativeLayout",
    "android.widget.ScrollView",
    "androidx.core.widget.NestedScrollView",
    "androidx.constraintlayout.widget.ConstraintLayout",
    "androidx.coordinatorlayout.widget.CoordinatorLayout",
    "androidx.viewpager.widget.ViewPager",
    "androidx.viewpager2.widget.ViewPager2",
]);

const LEAVES = new Set(["TextView", "Image", "TextField"]);
const SELECTABLE = new Set(["Switch", "Checkbox", "Toggle", "Radio"]);

type Region = { kind: string; label?: string };

type Working = {
    node: PhoneNode;
    frame: Frame;
    depth: number;
    declared: Region | undefined;
    role: string;
    label: string;
    ref: { w: number; p: number[] };
    /** The list (a collection) it is in, if any: its rows stay in the list's region, even at the screen's edges. */
    list: PhoneNode | undefined;
};

const isCollection = (node: PhoneNode) => COLLECTIONS.has(node.c ?? "") || has(node, FLAG.collection);

const frameOf = (node: PhoneNode): Frame => ({ x: node.b[0], y: node.b[1], width: node.b[2] - node.b[0], height: node.b[3] - node.b[1] });
const sameFrame = (a: Frame, b: Frame) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const contains = (outer: Frame, inner: Frame) =>
    outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
const overlaps = (a: Frame, b: Frame) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** The short name of a resource id: `com.app:id/send_button` is `send_button`. */
export function shortId(id: string | undefined): string {
    if (id === undefined || id === "") {
        return "";
    }

    const at = id.indexOf(":id/");

    return at === -1 ? id.slice(id.lastIndexOf("/") + 1) : id.slice(at + 4);
}

/** What a node says it is: its description, else its text (not the hint shown as text); apps' literal "null" is none. */
function labelOf(node: PhoneNode): string {
    const description = node.d ?? "";

    if (description !== "" && description !== "null") {
        return description;
    }

    // A password field's text is never words for Pi (the service does not send it; were it sent, it stays out).
    const text = has(node, FLAG.password) ? "" : (node.t ?? "");

    return text !== "" && text !== "null" && text !== node.h ? text : "";
}

function roleOf(node: PhoneNode): string {
    const known = ROLES[node.c ?? ""];

    if (known !== undefined) {
        return known;
    }

    if (has(node, FLAG.editable)) {
        return "TextField";
    }

    // A bare View that toggles: Compose's toggleable row.
    if (has(node, FLAG.checkable)) {
        return "Toggle";
    }

    const name = node.c ?? "";

    return name === "" ? "Element" : name.slice(name.lastIndexOf(".") + 1);
}

function declaredRegion(node: PhoneNode): Region | undefined {
    const kind = REGIONS[node.c ?? ""];

    if (kind === undefined) {
        return undefined;
    }

    const label = (node.d ?? "") === "" ? (node.t ?? "") : node.d!;

    if (kind === "NavBar" || kind === "TabBar") {
        return label === "" ? { kind } : { kind, label };
    }

    return label === "" ? undefined : { kind, label };
}

/** Whether an element earns a line (sim-use's `includeNode`). */
function include(node: PhoneNode, frame: Frame, screen: Frame, label: string, repeats: boolean): boolean {
    if (frame.width <= 0 || frame.height <= 0 || !has(node, FLAG.visible)) {
        return false;
    }

    if (frame.x + frame.width <= screen.x || frame.y + frame.height <= screen.y || frame.x >= screen.x + screen.width || frame.y >= screen.y + screen.height) {
        return false;
    }

    const id = shortId(node.r);
    const acts = has(node, FLAG.clickable) || has(node, FLAG.longClickable) || has(node, FLAG.checkable);
    const scrolls = has(node, FLAG.scrollable);

    if (label === "" && id === "" && !acts && !scrolls && !has(node, FLAG.editable)) {
        return false;
    }

    // A full-screen wrapper or background without a label. (sim-use drops a full-screen list too; here it stays, so Pi
    // can scroll it by number and read its row count.)
    if (label === "" && !acts && !scrolls && frame.width * frame.height * 100 >= screen.width * screen.height * 80) {
        return false;
    }

    const container = CONTAINERS.has(node.c ?? "");

    // Skeleton: a layout with an id but nothing to do; kept when its id repeats among siblings (a list's row).
    if (label === "" && !acts && !scrolls && !repeats && container) {
        return false;
    }

    // Spacers and dividers apps make clickable so taps do not fall through.
    if (label === "" && !scrolls && !has(node, FLAG.checkable) && Math.min(frame.width, frame.height) <= 60 && container) {
        return false;
    }

    return true;
}

function repeatingIds(children: readonly PhoneNode[]): Map<string, number> {
    const counts = new Map<string, number>();

    for (const child of children) {
        const id = shortId(child.r);

        if (id !== "") {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }

    return counts;
}

/** A SlidingPaneLayout in single-pane mode keeps both panes, the same size: the first is the hidden list. */
function hiddenMasterPane(node: PhoneNode): boolean {
    const name = node.c ?? "";

    if (!(name === "androidx.slidingpanelayout.widget.SlidingPaneLayout" || name.endsWith(".SlidingPaneLayout")) || node.k?.length !== 2) {
        return false;
    }

    const [first, second] = node.k;
    const labelled = (each: PhoneNode): boolean => labelOf(each) !== "" || (each.k ?? []).some(labelled);

    return first!.b.join() === second!.b.join() && labelled(first!) && labelled(second!);
}

function walk(node: PhoneNode, depth: number, declared: Region | undefined, screen: Frame, repeats: boolean, ref: Working["ref"], into: Working[], list?: PhoneNode): void {
    const own = declared === undefined ? declaredRegion(node) : undefined;
    const region = declared ?? own;
    const frame = frameOf(node);
    const label = labelOf(node);

    if (own === undefined && include(node, frame, screen, label, repeats)) {
        into.push({ node, frame, depth, declared: region, role: roleOf(node), label, ref, list });
    }

    const inList = isCollection(node) ? node : list;

    const children = node.k ?? [];
    const counts = repeatingIds(children);
    const skipFirst = hiddenMasterPane(node);

    children.forEach((child, position) => {
        if (skipFirst && position === 0) {
            return;
        }

        walk(child, depth + 1, region, screen, (counts.get(shortId(child.r)) ?? 0) >= 2, { w: ref.w, p: [...ref.p, child.i ?? position] }, into, inList);
    });
}

/** A clickable wrapper around one label (a button's text) becomes one element: the wrapper's place, the label's words. */
function fold(items: Working[]): Working[] {
    const labelled = items.flatMap((item, index) => (item.label === "" ? [] : [index]));
    const dropped = new Set<number>();
    const folded = new Map<number, Working>();

    items.forEach((wrapper, index) => {
        if (wrapper.label !== "" || !(has(wrapper.node, FLAG.clickable) || has(wrapper.node, FLAG.longClickable) || has(wrapper.node, FLAG.focusable))) {
            return;
        }

        const inside = labelled.filter((other) => other !== index && items[other]!.depth > wrapper.depth && contains(wrapper.frame, items[other]!.frame));

        if (inside.length === 0) {
            return;
        }

        const shallowest = Math.min(...inside.map((other) => items[other]!.depth));
        const top = inside.filter((other) => items[other]!.depth === shallowest);

        if (top.length !== 1) {
            return;
        }

        const chosen = items[top[0]!]!;

        if (has(chosen.node, FLAG.clickable) || has(chosen.node, FLAG.longClickable) || has(chosen.node, FLAG.checkable)) {
            return;
        }

        dropped.add(top[0]!);

        for (const other of inside) {
            const item = items[other]!;

            if (other !== top[0] && !has(item.node, FLAG.clickable) && !has(item.node, FLAG.longClickable) && !has(item.node, FLAG.checkable) && !item.role.includes("Image") && contains(chosen.frame, item.frame)) {
                dropped.add(other);
            }
        }

        folded.set(index, {
            ...wrapper,
            role: has(wrapper.node, FLAG.clickable) || has(wrapper.node, FLAG.longClickable) ? (SELECTABLE.has(wrapper.role) ? wrapper.role : "Button") : chosen.role,
            label: chosen.label,
        });
    });

    return items.flatMap((item, index) => (dropped.has(index) ? [] : [folded.get(index) ?? item]));
}

/** A labelless outer layout the same size as the button inside it goes. */
function dropRedundantOuter(items: Working[]): Working[] {
    const acting = (item: Working) => has(item.node, FLAG.clickable) || has(item.node, FLAG.longClickable) || has(item.node, FLAG.checkable);

    return items.filter(
        (outer) => outer.label !== "" || acting(outer) || !items.some((inner) => inner !== outer && inner.label !== "" && acting(inner) && inner.depth > outer.depth && sameFrame(inner.frame, outer.frame)),
    );
}

/** The same role, label and place twice: the deeper one stays. */
function dedup(items: Working[]): Working[] {
    const best = new Map<string, Working>();

    for (const item of items) {
        const key = `${item.role}\u0000${item.label}\u0000${item.frame.x},${item.frame.y},${item.frame.width},${item.frame.height}`;
        const kept = best.get(key);

        if (kept === undefined || item.depth > kept.depth) {
            best.set(key, item);
        }
    }

    const survivors = new Set(best.values());

    return items.filter((item) => survivors.has(item));
}

/** Lists on the screen (sim-use's tier-1 `AndroidListDetector`): each container's frame and its visible rows. */
function lists(roots: readonly PhoneNode[], screen: Frame): { frame: Frame; rows: number }[] {
    const found: { frame: Frame; rows: number; height: number }[] = [];
    const visit = (node: PhoneNode) => {
        if (isCollection(node)) {
            const frame = frameOf(node);
            const cells = (node.k ?? []).map(frameOf).filter((cell, index) => has(node.k![index]!, FLAG.visible) && cell.width > 0 && cell.height > 0 && overlaps(cell, frame));
            const heights = cells.map((cell) => cell.height).sort((a, b) => a - b);
            const middle = heights.length % 2 === 0 ? ((heights[heights.length / 2 - 1] ?? 0) + (heights[heights.length / 2] ?? 0)) / 2 : heights[(heights.length - 1) / 2]!;

            if (cells.length >= 2 && frame.width > 0 && frame.height > 0 && overlaps(frame, screen) && middle <= screen.height / 2) {
                found.push({ frame, rows: cells.length, height: middle });
            }
        }

        for (const child of node.k ?? []) {
            visit(child);
        }
    };

    roots.forEach(visit);

    // A list inside another that has more rows is one of its rows; an outer one around the real list goes.
    return found.filter(
        (list) => !found.some((other) => other !== list && ((contains(other.frame, list.frame) && other.rows > list.rows) || (contains(list.frame, other.frame) && other.rows >= list.rows && !sameFrame(other.frame, list.frame)))),
    );
}

function tagsOf(item: Working): string[] {
    const { node, role, label } = item;
    const tags: string[] = [];

    if (!has(node, FLAG.enabled)) {
        tags.push("disabled");
    }

    if (has(node, FLAG.selected) || (SELECTABLE.has(role) && has(node, FLAG.checked))) {
        tags.push(SELECTABLE.has(role) ? "on" : "selected");
    } else if (has(node, FLAG.checked)) {
        tags.push("checked");
    } else if (SELECTABLE.has(role) && has(node, FLAG.checkable)) {
        tags.push("off");
    }

    if (has(node, FLAG.focused)) {
        tags.push("focused");
    }

    if (has(node, FLAG.password)) {
        tags.push("password (hidden)");
    } else if (role === "TextField" || role === "Switch") {
        const text = node.t ?? "";

        if (text !== "" && text !== label && text !== node.h) {
            tags.push(`value ${quote(text, 40)}`);
        }
    }

    if ((role === "TextField" || label === "") && (node.h ?? "") !== "" && node.h !== label) {
        tags.push(`hint ${quote(node.h!, 40)}`);
    }

    if ((node.s ?? "") !== "" && node.s !== label) {
        tags.push(`state ${quote(node.s!, 30)}`);
    }

    if (has(node, FLAG.scrollable)) {
        tags.push("scrollable");
    }

    return tags;
}

/** Whitespace runs as one space, cut to `max` characters (code points). */
function quote(text: string, max: number): string {
    const plain = [...text.replace(/\s+/g, " ").trim()];

    return JSON.stringify(plain.length > max ? `${plain.slice(0, max - 1).join("")}…` : plain.join(""));
}

/** Each element's parent among those listed before it in its region, for indenting (sim-use's `computeIndentLayout`). */
function indentOrder(items: Working[], listed: Set<Working>, screen: Frame): { item: Working; depth: number }[] {
    const parents = items.map((item, index) => {
        let best: number | undefined;
        let area = Number.POSITIVE_INFINITY;

        for (let other = 0; other < index; other++) {
            const parent = items[other]!;

            if (LEAVES.has(parent.role) || sameFrame(parent.frame, item.frame) || !contains(parent.frame, item.frame)) {
                continue;
            }

            if (!listed.has(parent) && parent.frame.height * 10 > screen.height * 6) {
                continue;
            }

            if (parent.frame.width * parent.frame.height < area) {
                area = parent.frame.width * parent.frame.height;
                best = other;
            }
        }

        return best;
    });
    const out: { item: Working; depth: number }[] = [];
    const emit = (index: number, depth: number) => {
        out.push({ item: items[index]!, depth });
        parents.forEach((parent, child) => {
            if (parent === index) {
                emit(child, depth + 1);
            }
        });
    };

    parents.forEach((parent, index) => {
        if (parent === undefined) {
            emit(index, 0);
        }
    });

    return out;
}

/**
 * The outline of the app in front: its windows' elements (a popup or dialog over it alone), numbered top to bottom in
 * regions. `app` names it in the first line.
 */
export function renderOutline(screen: PhoneScreen, app: string): Outline {
    const display: Frame = { x: 0, y: 0, width: screen.display.width, height: screen.display.height };
    const readable = screen.windows.filter((window) => window.root !== undefined && window.package === screen.foreground && window.type === "application");
    const active = readable.find((window) => window.active) ?? readable[0];
    // A popup over the app (a menu, a dropdown, a dialog of its own): what is under it cannot be tapped without closing it.
    const popups = active === undefined ? [] : readable.filter((window) => window !== active && window.layer > active.layer);
    const shown = popups.length > 0 ? popups.sort((a, b) => a.layer - b.layer) : active === undefined ? [] : [active];
    // A dialog of the app takes the focus: the active window is over another of the app's, which is not listed.
    const over = popups.length > 0 || (active !== undefined && readable.some((window) => window !== active && window.layer < active.layer));
    const collected: Working[] = [];

    for (const window of shown) {
        const root = window.root!;
        const counts = repeatingIds(root.k ?? []);

        walk(root, 0, undefined, display, (counts.get(shortId(root.r)) ?? 0) >= 2, { w: window.id, p: [] }, collected);
    }

    const items = dedup(dropRedundantOuter(fold(collected))).sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
    const found = lists(shown.map((window) => window.root!), display);
    const listed = new Map<Working, number>();

    for (const list of found) {
        const item = items.find((each) => sameFrame(each.frame, list.frame));

        if (item !== undefined) {
            listed.set(item, list.rows);
        }
    }

    // Top and bottom bands: sim-use's 280 px of a 2400 px screen.
    const band = Math.round(display.height * 0.1167);
    const regionOf = (item: Working): Region => {
        if (item.declared !== undefined) {
            return item.declared;
        }

        // A list's rows go where the list is: by its place on the screen, not theirs.
        const where = item.list === undefined ? item.frame : frameOf(item.list);

        if (where.height <= display.height / 2) {
            const middle = where.y + where.height / 2;

            if (middle < band) {
                return { kind: "Top" };
            }

            if (middle >= display.height - band) {
                return { kind: "Bottom" };
            }
        }

        return { kind: "Content" };
    };
    const rank = (kind: string) => (kind === "Top" ? 0 : kind === "Content" ? 2 : kind === "Bottom" ? 3 : 1);
    const buckets = new Map<string, { region: Region; items: Working[] }>();

    for (const item of items) {
        const region = regionOf(item);
        const key = `${region.kind}\u0000${region.label ?? ""}`;

        if (!buckets.has(key)) {
            buckets.set(key, { region, items: [] });
        }

        buckets.get(key)!.items.push(item);
    }

    const ordered = [...buckets.values()].sort((a, b) => rank(a.region.kind) - rank(b.region.kind));
    const lines = [`${app} (${screen.foreground}) · screen ${display.width}x${display.height} px${screen.keyboard ? " · keyboard up" : ""}`];

    if (over) {
        lines.push("A popup or dialog is open over the app: only it is listed (button back closes it).");
    }

    const entries: OutlineEntry[] = [];
    let omitted = 0;

    for (const { region, items: inRegion } of ordered) {
        const layout = indentOrder(inRegion, new Set(listed.keys()), display);
        let header = false;

        for (const { item, depth } of layout) {
            if (entries.length >= MAX_ENTRIES) {
                omitted++;
                continue;
            }

            if (!header) {
                header = true;
                lines.push(region.label === undefined ? `[${region.kind}]` : `[${region.kind} ${quote(region.label, 40)}]`);
            }

            const index = entries.length + 1;
            const id = item.label === "" ? shortId(item.node.r) : "";
            const rows = listed.get(item);
            const tags = [...(rows === undefined ? [] : [`list of ${rows} rows in view`]), ...tagsOf(item)];
            const { x, y, width, height } = item.frame;

            lines.push(`${"  ".repeat(Math.min(depth, 2))}[${index}] ${item.role} ${quote(item.label, 60)}${id === "" ? "" : ` :${id}:`} (${x},${y} ${width}x${height})${tags.length === 0 ? "" : ` ${tags.join(" ")}`}`);
            entries.push({
                index,
                role: item.role,
                label: item.label,
                frame: item.frame,
                ref: item.ref,
                editable: has(item.node, FLAG.editable) || item.role === "TextField",
                password: has(item.node, FLAG.password),
                scrollable: has(item.node, FLAG.scrollable),
            });
        }
    }

    if (entries.length === 0) {
        lines.push("Nothing to read on this screen yet (it may still be loading: wait and read it again, or take a screenshot).");
    }

    if (omitted > 0) {
        lines.push(`(${omitted} more elements not listed)`);
    }

    return { text: lines.join("\n"), entries, size: { width: display.width, height: display.height } };
}
