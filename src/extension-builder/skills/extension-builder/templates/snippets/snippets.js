// Snippets' browser part (a template of pi-phone's extension-builder skill): a menu row and a launcher action open a
// sheet that lists texts kept in this browser; Use puts one in the message box (the person sends it, or not).
export const pocketApi = 2;

const WORDS = {
    vi: {
        Snippets: "Đoạn mẫu",
        "Texts you use often": "Những đoạn bạn hay dùng",
        "Insert a snippet": "Chèn một đoạn mẫu",
        "No snippets yet. Write one below.": "Chưa có đoạn mẫu nào. Hãy viết một đoạn bên dưới.",
        "New snippet": "Đoạn mẫu mới",
        Add: "Thêm",
        Use: "Dùng",
        Remove: "Xóa",
        "Remove {text}": "Xóa {text}",
    },
    "zh-CN": {
        Snippets: "常用片段",
        "Texts you use often": "你常用的文字",
        "Insert a snippet": "插入一个片段",
        "No snippets yet. Write one below.": "还没有片段。在下面写一个。",
        "New snippet": "新片段",
        Add: "添加",
        Use: "使用",
        Remove: "删除",
        "Remove {text}": "删除 {text}",
    },
};

/** This browser's own store: one key, the module's name in it. */
const KEY = "pi-phone-ext:snippets";

const LIST = "display:flex;flex-direction:column;gap:8px;margin:0 0 16px";
const ROW = "display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--r-row);background:var(--card)";
const TEXT = "flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;color:var(--text)";
const FORM = "display:flex;flex-direction:column;gap:8px";

const load = () => {
    try {
        const kept = JSON.parse(localStorage.getItem(KEY) ?? "[]");

        return Array.isArray(kept) ? kept.filter((each) => typeof each === "string") : [];
    } catch {
        return [];
    }
};

export default function snippets(pocket) {
    const { html, useState, Icon, t, language } = pocket;
    const say = (english, vars) => t(WORDS[language()]?.[english] ?? english, vars);

    function SnippetsSheet({ close }) {
        const [items, setItems] = useState(load);
        const [draft, setDraft] = useState("");
        const save = (next) => {
            localStorage.setItem(KEY, JSON.stringify(next));
            setItems(next);
        };
        const add = (event) => {
            event.preventDefault();

            if (draft.trim() !== "") {
                save([...items, draft.trim()]);
                setDraft("");
            }
        };
        const use = (text) => {
            pocket.compose(text);
            close();
        };

        return html`<div>
            ${items.length === 0
                ? html`<p class="muted">${say("No snippets yet. Write one below.")}</p>`
                : html`<div style=${LIST}>
                      ${items.map(
                          (text, index) => html`<div style=${ROW} key=${index}>
                              <span style=${TEXT}>${text}</span>
                              <button class="button small" onClick=${() => use(text)}>${say("Use")}</button>
                              <button
                                  class="icon-button small"
                                  title=${say("Remove")}
                                  aria-label=${say("Remove {text}", { text: text.slice(0, 40) })}
                                  onClick=${() => save(items.filter((_, at) => at !== index))}
                              >
                                  <${Icon} name="close" size=${14} />
                              </button>
                          </div>`,
                      )}
                  </div>`}
            <form style=${FORM} onSubmit=${add}>
                <label class="field">
                    <span class="label">${say("New snippet")}</span>
                    <textarea rows="3" value=${draft} onInput=${(event) => setDraft(event.currentTarget.value)}></textarea>
                </label>
                <div><button class="button primary" disabled=${draft.trim() === ""}>${say("Add")}</button></div>
            </form>
        </div>`;
    }

    pocket.sheet({ id: "snippets", title: say("Snippets"), component: SnippetsSheet });
    pocket.menu({ id: "snippets", label: say("Snippets"), hint: say("Texts you use often"), sheet: "snippets" });
    pocket.launcher({ id: "insert", label: say("Insert a snippet"), icon: "clip", keywords: ["snippet", "text"], sheet: "snippets" });
}
