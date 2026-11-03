// Settings › Pages (PP-370): the artifacts this person keeps as pages on the rail, to order and remove, and whether
// pages are on at all (the owner's). What it draws is in `../pages.js`, beside the pages themselves.
import { t } from "../i18n.js";
import { PagesSheetBody } from "../pages.js";
import { closeSheet } from "../store.js";
import { html, Sheet } from "../ui.js";

export function PagesSheet() {
    return html`<${Sheet} title=${t("Pages")} onClose=${closeSheet}>
        <${PagesSheetBody} />
    <//>`;
}
