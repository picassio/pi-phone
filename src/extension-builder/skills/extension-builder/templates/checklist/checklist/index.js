// Checklist's browser part (a template of pi-phone's extension-builder skill): a rail button with the open items as its
// badge, a page that changes the list through the module's routes, how Pi's checklist calls show in the transcript,
// and the "changed" event, so the page shows what Pi did at once. A folder with index.js, so it can load its own
// stylesheet (pocket.style) from beside it.
export const pocketApi = 2;

const WORDS = {
    vi: {
        Checklist: "Danh sách việc",
        "Open {n}": "Còn lại {n}",
        "Nothing on the checklist yet. You or Pi can add the first item.": "Danh sách chưa có gì. Bạn hoặc Pi có thể thêm việc đầu tiên.",
        "New item": "Việc mới",
        Add: "Thêm",
        Done: "Xong",
        Open: "Chưa xong",
        "Remove {text}": "Xóa {text}",
        "Mark {text} done": "Đánh dấu {text} là xong",
        "Read the checklist": "Đọc danh sách việc",
        "Change the checklist": "Sửa danh sách việc",
    },
    "zh-CN": {
        Checklist: "清单",
        "Open {n}": "未完成 {n}",
        "Nothing on the checklist yet. You or Pi can add the first item.": "清单还是空的。你或 Pi 可以添加第一项。",
        "New item": "新事项",
        Add: "添加",
        Done: "完成",
        Open: "未完成",
        "Remove {text}": "删除 {text}",
        "Mark {text} done": "将 {text} 标为完成",
        "Read the checklist": "读取清单",
        "Change the checklist": "修改清单",
    },
};

export default function checklist(pocket) {
    const { html, useEffect, useState, Icon, Loader, StateTag, Switch, t, language } = pocket;
    const say = (english, vars) => t(WORDS[language()]?.[english] ?? english, vars);
    const failed = (error) => pocket.notify("error", error.message);

    pocket.style("checklist.css");

    const rail = pocket.rail({ id: "checklist", title: say("Checklist"), icon: "check", page: "checklist" });
    const badge = (items) => rail.update({ badge: items.filter((item) => !item.done).length });

    // The badge follows every change, the page open or not.
    pocket.api("items").then((answer) => badge(answer.items), failed);
    pocket.on("changed", (data) => badge(data.items));

    function ChecklistPage() {
        const [items, setItems] = useState(null);
        const [draft, setDraft] = useState("");
        const [busy, setBusy] = useState(false);

        useEffect(() => {
            pocket.api("items").then((answer) => setItems(answer.items), failed);

            return pocket.on("changed", (data) => setItems(data.items));
        }, []);

        if (items === null) {
            return html`<${Loader} label=${say("Checklist")} />`;
        }

        const run = (path, body, options) => {
            setBusy(true);

            return pocket
                .api(path, body, options)
                .then((answer) => setItems(answer.items), failed)
                .finally(() => setBusy(false));
        };
        const add = (event) => {
            event.preventDefault();
            run("items", { text: draft }).then(() => setDraft(""));
        };
        const open = items.filter((item) => !item.done).length;

        return html`<div class="ckl-page">
            <div class="label">${say("Open {n}", { n: open })}</div>
            ${items.length === 0
                ? html`<p class="muted">${say("Nothing on the checklist yet. You or Pi can add the first item.")}</p>`
                : html`<ul class="ckl-list">
                      ${items.map(
                          (item) => html`<li class=${`ckl-row ${item.done ? "done" : ""}`} key=${item.id}>
                              <${Switch}
                                  on=${item.done}
                                  disabled=${busy}
                                  label=${say("Mark {text} done", { text: item.text })}
                                  onChange=${() => run(`items/${item.id}`, { done: !item.done })}
                              />
                              <span class="ckl-text">${item.text}</span>
                              <${StateTag} tone=${item.done ? "ok" : "off"} label=${item.done ? say("Done") : say("Open")} />
                              <button
                                  class="icon-button small"
                                  disabled=${busy}
                                  aria-label=${say("Remove {text}", { text: item.text })}
                                  onClick=${() => run(`items/${item.id}`, undefined, { method: "DELETE" })}
                              >
                                  <${Icon} name="close" size=${14} />
                              </button>
                          </li>`,
                      )}
                  </ul>`}
            <form class="ckl-add" onSubmit=${add}>
                <label class="field">
                    <span class="label">${say("New item")}</span>
                    <input value=${draft} maxlength="300" onInput=${(event) => setDraft(event.currentTarget.value)} />
                </label>
                <button class="button primary" disabled=${busy || draft.trim() === ""}>${say("Add")}</button>
            </form>
        </div>`;
    }

    pocket.page({ id: "checklist", title: say("Checklist"), component: ChecklistPage });

    // How Pi's calls of its tools show in the transcript: a label, and what it was about.
    pocket.toolCall({ tool: "checklist_list", label: () => say("Read the checklist"), icon: "check" });
    pocket.toolCall({
        tool: "checklist_change",
        label: () => say("Change the checklist"),
        subject: (args) => args.text ?? args.id ?? "",
        icon: "check",
    });
}
