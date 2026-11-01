/**
 * How well the wiki's search finds its pages for a message (PP-315): XuShi Visa's eval (visa-dashboard
 * `apps/api/scripts/memory-eval.ts`, 2026-11-01) on pi-phone's own `Para`: a made-up shop wiki of 24 pages and 40
 * questions with the pages that answer them (direct, other words, one word, no accents, several things at once, whole
 * chat messages, and 6 no page answers), each searched as a message is (`Para.relevant`, at most 4 pages), four ways:
 *   A words · B words + meaning (embeddings) · C words + Jev · D words + meaning + Jev.
 * Measures: the right page first, the right pages among those given, pages off the point a question, questions with no
 * page left empty, time a message, Jev's cost.
 *
 *   OPENROUTER_API_KEY=… node scripts/wiki-eval.ts [--configs A,B,C,D] [--out report.md]
 *
 * Each way runs in a wiki of its own in a temporary home; nothing touches the owner's wiki. With embeddings, the pages
 * are embedded before the first question (`Para.embed`): the app embeds a moment after a write.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevModels } from "../src/server/jev.ts";
import { Para } from "../src/server/para.ts";

type Page = { path: string; title: string; body: string };
type Case = { q: string; kind: string; gold: string[]; ok?: string[] };

const P = (path: string, title: string, ...lines: string[]): Page => ({ path, title, body: lines.map((line) => `- ${line}`).join("\n") });

const PAGES: Page[] = [
    P("areas/quy-tac-soan-tin-zalo", "Quy tắc soạn tin Zalo cho khách", 'Xưng "em", gọi khách là anh/chị.', 'Luôn ký tên "Tiệm XuShi" ở cuối tin.', "Không dùng biểu tượng cảm xúc (emoji).", "Chỉ nhắn trong giờ hành chính, trừ khi khách hỏi trước."),
    P("areas/gui-ho-so-dong-a", "Gửi hồ sơ visa Nhật cho đối tác Đông Á", "Gửi trước 15h thứ Năm để kịp nộp đầu tuần sau.", "Kèm bảng kê theo mẫu Excel của Đông Á, đặt tên file theo mã HS.", "Chị dặn ngày 28/10 sau lần HS-0071 trễ một tuần."),
    P("resources/kvac-tphcm", "Nộp visa Hàn Quốc tại KVAC TP.HCM", "Trung tâm KVAC ở tầng 3, 253 Hoàng Văn Thụ, Tân Bình.", "Phải đặt hẹn online trước; nhận hồ sơ 8:30–15:00 thứ Hai đến thứ Sáu.", "KVAC hay đòi bổ sung xác nhận công tác."),
    P("resources/han-c39-giay-to", "Giấy tờ visa du lịch Hàn C-3-9", "Hộ chiếu còn hạn trên 6 tháng.", "Sao kê tài khoản 3 tháng, số dư tối thiểu 100 triệu.", "Xác nhận việc làm hoặc giấy phép kinh doanh."),
    P("resources/nhat-du-lich-giay-to", "Giấy tờ visa du lịch Nhật Bản", "Ảnh 4,5 x 4,5 cm nền trắng, chụp trong 3 tháng.", "Sổ tiết kiệm từ 100 triệu hoặc sao kê.", "Lịch trình từng ngày và đặt phòng khách sạn."),
    P("resources/my-b1b2-phong-van", "Phỏng vấn visa Mỹ B1/B2", "Điền DS-160, đóng phí, đặt lịch trên ais.usvisa-info.com.", "Trả lời ngắn, thật, mang giấy tờ chứng minh ràng buộc ở Việt Nam.", "Tổng lãnh sự quán Mỹ ở 4 Lê Duẩn, quận 1."),
    P("resources/schengen-phap", "Visa Pháp (Schengen)", "Nộp qua TLScontact, đặt lịch online.", "Bảo hiểm du lịch tối thiểu 30.000 EUR cho cả chuyến.", "Đặt chỗ khách sạn và vé máy bay khứ hồi."),
    P("resources/uc-visitor-600", "Visa Úc du lịch (subclass 600)", "Nộp online qua ImmiAccount.", "Có thể phải khám sức khỏe tại phòng khám được chỉ định.", "Lấy sinh trắc học tại VFS sau khi nộp."),
    P("resources/canada-trv", "Visa Canada du lịch (TRV)", "Lấy sinh trắc học (vân tay, ảnh) tại VFS.", "Chứng minh tài chính và thư mời nếu thăm thân."),
    P("resources/dich-thuat-minh-anh", "Đối tác dịch thuật Minh Anh", "Tiếng Anh 120.000 đ/trang, trả trong 2 ngày.", "Tiếng Nhật, tiếng Hàn 180.000 đ/trang.", "Công chứng bản dịch thêm 30.000 đ/bản."),
    P("areas/quy-dinh-dat-coc", "Quy định đặt cọc và hoàn cọc", "Thu cọc 50% phí dịch vụ khi nhận hồ sơ.", "Trượt visa thì hoàn cọc, trừ phí lãnh sự đã nộp."),
    P("areas/khach-kho-tinh", "Xử lý khách khó tính, khiếu nại", "Nghe hết trước, không cãi.", "Không bao giờ hứa chắc đậu.", "Khách đòi hoàn tiền thì báo chủ tiệm, không tự quyết."),
    P("resources/hoang-gia-doi-tac", "Đối tác Hoàng Gia", "Làm visa Úc và Canada.", "Phản hồi chậm: nhắn trước 10h sáng mới kịp trong ngày."),
    P("projects/khai-truong-thu-duc", "Mở chi nhánh Thủ Đức tháng 12", "Đang tìm mặt bằng gần Vincom Thủ Đức.", "Tuyển thêm 1 nhân viên hồ sơ."),
    P("projects/khuyen-mai-tet-2027", "Khuyến mãi Tết 2027", "Giảm 10% phí dịch vụ visa Hàn cho nhóm từ 4 người.", "Chạy từ 15/12 đến 15/1."),
    P("resources/phong-cach-anh-quang-ba", "Phong cách ảnh quảng bá XuShi", "Màu vàng chủ đạo, logo góc phải.", "Không ghi cam kết tỉ lệ đậu."),
    P("areas/luu-tru-ho-so-giay", "Lưu hồ sơ giấy", "Tủ sắt, bìa màu theo nước.", "Hủy bản sao của khách sau 6 tháng."),
    P("resources/tre-em-di-cung", "Trẻ em đi cùng", "Giấy khai sinh bản sao.", "Giấy đồng ý của bố hoặc mẹ không đi cùng, có công chứng."),
    P("resources/khach-tu-do-chung-minh", "Khách làm tự do, kinh doanh: chứng minh thu nhập", "Giấy phép kinh doanh.", "Sao kê doanh thu 6 tháng, tờ khai thuế."),
    P("areas/ca-lam-viec", "Giờ làm việc của tiệm", "Thứ Hai đến thứ Bảy 8h–17h30, Chủ nhật nghỉ.", "Trực Zalo buổi tối đến 21h."),
    P("resources/khach-bi-tu-choi", "Khách từng bị từ chối visa", "Hỏi rõ lý do lần trước.", "Visa Hàn: chờ 6 tháng mới nộp lại.", "Khai trung thực lịch sử bị từ chối."),
    P("resources/bang-gia-dich-vu", "Bảng giá dịch vụ tham khảo", "Nhật 1.500.000 đ, Hàn 1.900.000 đ, Mỹ 3.000.000 đ phí dịch vụ."),
    P("areas/xuat-hoa-don-vat", "Xuất hóa đơn VAT cho công ty", "Làm bên ngoài qua kế toán chị Lan.", "Mất 2–3 ngày làm việc."),
    P("resources/hen-sinh-trac-hoc", "Lịch hẹn sinh trắc học VFS", "Mùa cao điểm đặt sớm 2 tuần.", "Mang hộ chiếu gốc."),
];

const CASES: Case[] = [
    { kind: "direct", q: "Nhắn Zalo cho khách thì ký tên thế nào", gold: ["areas/quy-tac-soan-tin-zalo"] },
    { kind: "direct", q: "Gửi hồ sơ Nhật cho Đông Á hạn chót khi nào", gold: ["areas/gui-ho-so-dong-a"] },
    { kind: "direct", q: "KVAC ở đâu, mấy giờ nhận hồ sơ", gold: ["resources/kvac-tphcm"] },
    { kind: "direct", q: "Visa Hàn C-3-9 cần sao kê bao nhiêu", gold: ["resources/han-c39-giay-to"] },
    { kind: "direct", q: "Phí dịch tiếng Nhật một trang bao nhiêu", gold: ["resources/dich-thuat-minh-anh"] },
    { kind: "direct", q: "Khách đặt cọc bao nhiêu phần trăm", gold: ["areas/quy-dinh-dat-coc"] },
    { kind: "direct", q: "Khuyến mãi Tết giảm bao nhiêu", gold: ["projects/khuyen-mai-tet-2027"] },
    { kind: "direct", q: "Trẻ em đi cùng cần giấy gì", gold: ["resources/tre-em-di-cung"] },
    { kind: "other words", q: "Cách nói chuyện với khách qua tin nhắn điện thoại", gold: ["areas/quy-tac-soan-tin-zalo"] },
    { kind: "other words", q: "Trung tâm tiếp nhận hồ sơ Hàn Quốc ở Sài Gòn", gold: ["resources/kvac-tphcm"] },
    { kind: "other words", q: "Khách bị đánh rớt visa lần trước thì sao", gold: ["resources/khach-bi-tu-choi"] },
    { kind: "other words", q: "Người buôn bán không có hợp đồng lao động thì chứng minh thu nhập thế nào", gold: ["resources/khach-tu-do-chung-minh"] },
    { kind: "other words", q: "Con nhỏ đi du lịch mà chỉ có mẹ đi theo", gold: ["resources/tre-em-di-cung"] },
    { kind: "other words", q: "Khách nổi nóng đòi trả lại tiền", gold: ["areas/khach-kho-tinh"], ok: ["areas/quy-dinh-dat-coc"] },
    { kind: "other words", q: "Lấy dấu vân tay khi xin visa Canada", gold: ["resources/canada-trv"], ok: ["resources/hen-sinh-trac-hoc"] },
    { kind: "other words", q: "Mấy giờ tiệm mở cửa", gold: ["areas/ca-lam-viec"] },
    { kind: "other words", q: "Chuẩn bị gì trước buổi gặp lãnh sự Mỹ", gold: ["resources/my-b1b2-phong-van"] },
    { kind: "other words", q: "Bảo hiểm du lịch châu Âu mức bao nhiêu", gold: ["resources/schengen-phap"] },
    { kind: "other words", q: "Giấy tờ cũ của khách giữ bao lâu thì bỏ", gold: ["areas/luu-tru-ho-so-giay"] },
    { kind: "other words", q: "Công ty của khách cần hóa đơn đỏ", gold: ["areas/xuat-hoa-don-vat"] },
    { kind: "one word", q: "Zalo", gold: ["areas/quy-tac-soan-tin-zalo"], ok: ["areas/ca-lam-viec"] },
    { kind: "one word", q: "Đông Á", gold: ["areas/gui-ho-so-dong-a"] },
    { kind: "one word", q: "Minh Anh", gold: ["resources/dich-thuat-minh-anh"] },
    { kind: "one word", q: "Hoàng Gia", gold: ["resources/hoang-gia-doi-tac"] },
    { kind: "one word", q: "VAT", gold: ["areas/xuat-hoa-don-vat"] },
    { kind: "one word", q: "Thủ Đức", gold: ["projects/khai-truong-thu-duc"] },
    { kind: "no accents", q: "visa han c-3-9 sao ke bao nhieu", gold: ["resources/han-c39-giay-to"] },
    { kind: "no accents", q: "gui ho so dong a truoc may gio", gold: ["areas/gui-ho-so-dong-a"] },
    { kind: "several", q: "Báo giá visa Hàn cho nhóm 5 người dịp Tết", gold: ["projects/khuyen-mai-tet-2027", "resources/bang-gia-dich-vu"] },
    { kind: "several", q: "Khách đi Úc thì qua đối tác nào, nhắn họ lúc nào", gold: ["resources/hoang-gia-doi-tac"], ok: ["resources/uc-visitor-600"] },
    { kind: "several", q: "Làm ảnh quảng cáo visa Nhật để đăng Facebook", gold: ["resources/phong-cach-anh-quang-ba"], ok: ["resources/nhat-du-lich-giay-to"] },
    { kind: "chat", q: "Soạn giúp em tin nhắn báo khách Hùng là hồ sơ Hàn đã nộp KVAC, hẹn 10 ngày có kết quả", gold: ["areas/quy-tac-soan-tin-zalo"], ok: ["resources/kvac-tphcm"] },
    { kind: "chat", q: "Khách hỏi đi Nhật cần ảnh cỡ nào", gold: ["resources/nhat-du-lich-giay-to"] },
    { kind: "chat", q: "Chị ơi khách muốn làm visa Mỹ cho cả nhà có 2 bé", gold: ["resources/my-b1b2-phong-van", "resources/tre-em-di-cung"] },
    { kind: "no page", q: "Thời tiết hôm nay thế nào", gold: [] },
    { kind: "no page", q: "Hồ sơ HS-0082 đã nộp chưa", gold: [] },
    { kind: "no page", q: "Visa Ấn Độ điện tử làm thế nào", gold: [] },
    { kind: "no page", q: "Cách nấu phở bò", gold: [] },
    { kind: "no page", q: "Tỷ giá đô la hôm nay", gold: [] },
    { kind: "no page", q: "Đổi mật khẩu app ở đâu", gold: [] },
];

const KEY = process.env.OPENROUTER_API_KEY;

if (KEY === undefined || KEY === "") {
    throw new Error("OPENROUTER_API_KEY is needed: the embeddings and Jev run on OpenRouter.");
}

const argument = (name: string) => {
    const at = process.argv.indexOf(name);

    return at > 0 ? process.argv[at + 1] : undefined;
};
const EMBEDDING = "openai/text-embedding-3-small";
const JEV = "typesafe/jev-1.14";
const CONFIGS = [
    { id: "A", name: "Words", embedding: null, jev: null },
    { id: "B", name: "Words + embeddings", embedding: EMBEDDING, jev: null },
    { id: "C", name: "Words + Jev", embedding: null, jev: JEV },
    { id: "D", name: "Words + embeddings + Jev", embedding: EMBEDDING, jev: JEV },
].filter((each) => (argument("--configs") ?? "A,B,C,D").split(",").includes(each.id));

type Row = { name: string; hit1: number; recall: number; noise: number; emptyOk: number; ms: number; cost: number; misses: string[] };
const rows: Row[] = [];
const detail: string[] = [];
const jevModels = new JevModels();

for (const config of CONFIGS) {
    const home = mkdtempSync(join(tmpdir(), "wiki-eval-"));
    const cwd = mkdtempSync(join(tmpdir(), "wiki-eval-cwd-"));
    let jevCost = 0;
    const para = new Para({
        home,
        apiKey: async (provider) => (provider === "openrouter" ? KEY : undefined),
        models: () => [],
        remote: () => undefined,
        spent: (usage) => {
            if (usage.model.startsWith("typesafe/")) {
                jevCost += usage.cost;
            }
        },
        log: (message) => console.error(`  log: ${message}`),
        rerankModel: () => config.jev,
        jevModels: () => jevModels.list(),
        fetch,
    });

    await para.updateSettings({ embeddingModel: config.embedding });

    for (const page of PAGES) {
        const category = page.path.split("/")[0]!;

        await para.save(page.path, `---\ntitle: ${JSON.stringify(page.title)}\npara: ${category}\nscope:\n  - global\ntags: []\n---\n\n${page.body}\n`, true);
    }

    // The keyword index now, not when the scheduler next looks: the questions come right after the writes.
    await (await para.open()).store.update();

    if (config.embedding !== null) {
        await para.embed();

        if (!(await para.status()).search.vectors) {
            throw new Error(`${config.name}: no vectors were made`);
        }
    }

    let hit1 = 0;
    let recall = 0;
    let withGold = 0;
    let noise = 0;
    let emptyOk = 0;
    let negatives = 0;
    let ms = 0;
    const misses: string[] = [];

    for (const each of CASES) {
        const started = Date.now();
        const found = (await para.relevant(each.q, cwd)).map((page) => page.path);

        ms += Date.now() - started;
        noise += found.filter((path) => !each.gold.includes(path) && !(each.ok ?? []).includes(path)).length;

        if (each.gold.length > 0) {
            withGold++;
            hit1 += each.gold.includes(found[0] ?? "") ? 1 : 0;
            const got = each.gold.filter((path) => found.includes(path)).length / each.gold.length;

            recall += got;

            if (got < 1) {
                misses.push(`${each.kind}: «${each.q}» → ${found.length > 0 ? found.join(", ") : "(nothing)"}`);
            }
        } else {
            negatives++;

            if (found.length === 0) {
                emptyOk++;
            } else {
                misses.push(`no page: «${each.q}» → ${found.join(", ")}`);
            }
        }

        detail.push(`| ${config.name} | ${each.kind} | ${each.q} | ${found.map((path) => path.split("/")[1]).join("<br>") || "—"} |`);
    }

    rows.push({ name: config.name, hit1: hit1 / withGold, recall: recall / withGold, noise: noise / CASES.length, emptyOk: emptyOk / negatives, ms: ms / CASES.length, cost: jevCost, misses });
    console.error(`${config.name}: done`);
    await para.close();
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const report = [
    `# The wiki's search on pi-phone (${new Date().toISOString().slice(0, 10)})`,
    "",
    `${PAGES.length} pages, ${CASES.length} questions (${CASES.filter((each) => each.gold.length === 0).length} with no page). Each searched as a message is, at most 4 pages.`,
    "",
    "| How | Right page first | Right pages present | Extra pages / question | No page → empty | Time / message | Jev (40 questions) |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.name} | ${pct(row.hit1)} | ${pct(row.recall)} | ${row.noise.toFixed(2)} | ${pct(row.emptyOk)} | ${Math.round(row.ms)} ms | ${row.cost > 0 ? `$${row.cost.toFixed(4)}` : "—"} |`),
    "",
    ...rows.flatMap((row) => [`## Missed: ${row.name}`, "", ...(row.misses.length > 0 ? row.misses.map((miss) => `- ${miss}`) : ["- (none)"]), ""]),
    "## Each question",
    "",
    "| How | Kind | Question | Pages |",
    "|---|---|---|---|",
    ...detail,
].join("\n");

const out = argument("--out");

if (out !== undefined) {
    writeFileSync(out, report);
}

console.log(report.split("\n## Each question")[0]);
process.exit(0);
