// Focus timer's browser part (a template of pi-phone's extension-builder skill): a rail button with the minutes left as
// its badge, and a page with the timer. The timer lives in this module, not in the page, so it keeps going while the
// page is closed; it stops when the module goes (an edit, or the module turned off).
export const pocketApi = 2;

/** Its own words in the app's other languages, by the English sentence. Every word it shows goes through `say`. */
const WORDS = {
    vi: {
        "Focus timer": "Hẹn giờ tập trung",
        "{n} minutes": "{n} phút",
        Length: "Thời lượng",
        Start: "Bắt đầu",
        Pause: "Tạm dừng",
        Reset: "Đặt lại",
        Ready: "Sẵn sàng",
        Running: "Đang chạy",
        Paused: "Đã tạm dừng",
        Done: "Xong",
        "Focus time is over.": "Đã hết thời gian tập trung.",
    },
    "zh-CN": {
        "Focus timer": "专注计时",
        "{n} minutes": "{n} 分钟",
        Length: "时长",
        Start: "开始",
        Pause: "暂停",
        Reset: "重置",
        Ready: "就绪",
        Running: "进行中",
        Paused: "已暂停",
        Done: "完成",
        "Focus time is over.": "专注时间结束了。",
    },
};

const LENGTHS = [15, 25, 50];
const MINUTE = 60_000;

/** Whole pixels on the 4 px grid, and the theme's own variables: never colours of its own. */
const PAGE = "display:flex;flex-direction:column;gap:16px;padding:16px;max-width:480px";
const HEAD = "display:flex;align-items:center;justify-content:space-between;gap:12px";
const CLOCK = "font:600 48px/56px var(--mono);color:var(--text)";
const ROW = "display:flex;gap:8px;flex-wrap:wrap";

export default function focusTimer(pocket) {
    const { html, useEffect, useReducer, Choice, Icon, StateTag, t, language } = pocket;
    const say = (english, vars) => t(WORDS[language()]?.[english] ?? english, vars);

    const timer = { minutes: 25, left: 25 * MINUTE, endsAt: null };
    const listeners = new Set();
    let ticking = null;

    const running = () => timer.endsAt !== null;
    const remaining = () => (running() ? Math.max(0, timer.endsAt - Date.now()) : timer.left);
    const clock = (ms) => {
        const seconds = Math.ceil(ms / 1000);

        return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    };

    const rail = pocket.rail({ id: "focus", title: say("Focus timer"), icon: "clock", page: "focus" });

    const changed = () => {
        rail.update({ badge: running() ? Math.ceil(remaining() / MINUTE) : 0 });

        for (const listener of listeners) {
            listener();
        }
    };

    const stopTicking = () => {
        clearInterval(ticking);
        ticking = null;
    };

    const tick = () => {
        if (remaining() === 0) {
            stopTicking();
            timer.endsAt = null;
            timer.left = 0;
            pocket.notify("info", say("Focus time is over."));
        }

        changed();
    };

    const start = () => {
        timer.endsAt = Date.now() + (timer.left === 0 ? timer.minutes * MINUTE : timer.left);
        ticking ??= setInterval(tick, 1000);
        changed();
    };

    const pause = () => {
        timer.left = remaining();
        timer.endsAt = null;
        stopTicking();
        changed();
    };

    const reset = () => {
        stopTicking();
        timer.endsAt = null;
        timer.left = timer.minutes * MINUTE;
        changed();
    };

    const setLength = (minutes) => {
        timer.minutes = minutes;
        reset();
    };

    function FocusPage() {
        const [, redraw] = useReducer((n) => n + 1, 0);

        useEffect(() => {
            listeners.add(redraw);

            return () => listeners.delete(redraw);
        }, []);

        // A state is a word and a dot (StateTag), never a mark of its own.
        const [tone, label] = running()
            ? ["ok", say("Running")]
            : timer.left === 0
              ? ["off", say("Done")]
              : timer.left < timer.minutes * MINUTE
                ? ["warn", say("Paused")]
                : ["off", say("Ready")];

        return html`<div style=${PAGE}>
            <div style=${HEAD}>
                <span style=${CLOCK}>${clock(remaining())}</span>
                <${StateTag} tone=${tone} label=${label} />
            </div>
            <div class="field">
                <span class="label">${say("Length")}</span>
                <${Choice}
                    label=${say("Length")}
                    value=${String(timer.minutes)}
                    options=${LENGTHS.map((n) => ({ value: String(n), label: say("{n} minutes", { n }) }))}
                    onChange=${(value) => setLength(Number(value))}
                    disabled=${running()}
                />
            </div>
            <div style=${ROW}>
                <button class="button primary" onClick=${running() ? pause : start}>
                    <${Icon} name=${running() ? "pause" : "play"} size=${16} />
                    ${running() ? say("Pause") : say("Start")}
                </button>
                <button class="button ghost" onClick=${reset}>
                    <${Icon} name="undo" size=${16} />
                    ${say("Reset")}
                </button>
            </div>
        </div>`;
    }

    pocket.page({ id: "focus", title: say("Focus timer"), component: FocusPage });
    pocket.onDispose(stopTicking);
}
