// Pages with a dialog open, shared by the layout check's tests and the redlines' (PP-501): the layout check and the
// redlines find an open modal with the same page script, so both are tried on the same markup.

/** The head of the test pages: a 300 px column 20 px in, words at 14 px. */
export const head = `<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;font:14px sans-serif} .col{width:300px;margin:0 20px}</style>`;

const guard = `<span aria-hidden="true" data-aria-hidden="true" data-radix-focus-guard tabindex="0" style="outline:none;opacity:0;position:fixed;pointer-events:none"></span>`;

/**
 * Radix's dialog, as visa-dashboard's case page has it (its body's children, measured there on Build #492): the page's
 * #root left unhidden as it holds an aria-live region, focus guards, the dimmed overlay when `overlay`, and the dialog
 * under body with pointer-events:auto. `body` is body's style: `pointer-events:none` while the dialog is open.
 */
export const radix = (page: { body: string; overlay: boolean }) =>
    `${head}<body style="${page.body}"><div id="root"><div class="col"><p id="behind" style="font-size:10px">Behind the dialog</p><button>Thêm lịch hẹn</button></div><div aria-live="polite" role="status" style="position:fixed;bottom:0"></div></div>${guard}${
        page.overlay ? `<div aria-hidden="true" data-aria-hidden="true" data-state="open" class="fixed inset-0 z-50 bg-black/10" style="position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.1);pointer-events:auto"></div>` : ""
    }<div role="dialog" id="radix-r1" aria-labelledby="radix-r2" data-state="open" tabindex="-1" style="pointer-events:auto;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:calc(100% - 32px);z-index:50;padding:16px;box-sizing:border-box;background:#ffffff"><h2 id="radix-r2" style="margin:0">Thêm lịch hẹn</h2><p id="inside" style="font-size:10px;margin:0">Inside the dialog</p></div>${guard}</body>`;
