# Vietnamese glossary (vi)

The words `web/i18n/vi.json`, `web/i18n/vi.server.json`, `android/app/src/main/res/values-vi/strings.xml` and
`README.vi.md` use, so the same thing is always called the same (PP-236). The reader is a technical user: short,
plain Vietnamese, the way a Vietnamese developer talks about these tools. Keep `{placeholders}` exactly as in the
English key (`node scripts/i18n-check.ts` fails otherwise).

## Kept as they are

Product and technical names stay in English: Pi, pi-phone, pi, Pi Durable, Termux, Android, GitHub, git, ssh, SSH,
OpenAI, ChatGPT, Codex, Claude, Anthropic, OpenRouter, MCP, OfficeCLI, wiki, PARA, agent, subagent, prompt, token,
API, URL, JSON, Markdown, diff, commit, branch names, model ids, tool names (`bash`, `edit`, `read`, `write`), file
paths, commands, keys (Ctrl K), units (MB, KB, px).

## Words

| English | Tiếng Việt |
| --- | --- |
| session | phiên |
| new session | phiên mới |
| message | tin nhắn |
| answer, reply | câu trả lời |
| model | mô hình |
| thinking (level) | suy nghĩ (mức) |
| tool | công cụ |
| tool call | lệnh gọi công cụ |
| approval, approve | phê duyệt, duyệt |
| allow / deny | cho phép / từ chối |
| folder | thư mục |
| file | tệp |
| machine | máy |
| owner | chủ sở hữu (short: chủ) |
| person, people | người dùng / người |
| guest, viewer, member | khách, người xem, thành viên |
| team | nhóm |
| group (of sessions) | nhóm |
| project | dự án |
| board | bảng |
| task | tác vụ |
| epic, story, bug | epic, story, lỗi |
| settings, Settings | cài đặt, Cài đặt |
| menu | menu |
| sheet (a panel from the bottom) | bảng (or the sheet's own name) |
| panel | khung |
| appearance | giao diện |
| theme | chủ đề |
| language | ngôn ngữ |
| sign in, sign-in | đăng nhập |
| sign out | đăng xuất |
| secret(s) | bí mật |
| key (API key) | khóa |
| password | mật khẩu |
| spend | chi tiêu |
| limit | giới hạn / hạn mức (provider usage) |
| usage | mức dùng |
| context | ngữ cảnh |
| compact (context) | nén |
| branch | nhánh |
| worktree | worktree |
| merge | gộp (merge) |
| changes | thay đổi |
| extension | tiện ích mở rộng (short: tiện ích) |
| skill | skill |
| schedule | lịch |
| notification | thông báo |
| browser | trình duyệt |
| screenshot | ảnh chụp màn hình |
| attachment | tệp đính kèm |
| upload / download | tải lên / tải xuống |
| dictation | nhập bằng giọng nói |
| voice call | cuộc gọi thoại |
| mute / unmute | tắt mic / bật mic |
| hands-free / tap to talk / hold to talk | rảnh tay / chạm để nói / giữ để nói |
| phone control / computer control | điều khiển điện thoại / điều khiển máy tính |
| artifact | artifact |
| interview (Pi's form) | biểu mẫu |
| card (an ask on screen) | thẻ |
| run (a session's run) | lượt chạy |
| running | đang chạy |
| waiting | đang chờ |
| failed | thất bại |
| idle | rảnh |
| settle / un-settle (a session) | cất / bỏ cất |
| Active (the session list) | Đang hoạt động |
| take turns, drive (shared session) | luân phiên, cầm lái |
| steer (a run) | điều hướng (message), điều khiển (rights) |
| capture (wiki) | ghi nhận |
| pin / unpin | ghim / bỏ ghim |
| archive | lưu trữ |
| fork | rẽ nhánh (fork) |
| restart | khởi động lại |
| server | máy chủ |
| device | thiết bị |

## Buttons

Save Lưu · Cancel Hủy · Delete Xóa · Remove Gỡ · Close Đóng · Open Mở · Back Quay lại · Done Xong · Send Gửi ·
Stop Dừng · Retry Thử lại · Edit Sửa · Copy Sao chép · Add Thêm · Change Đổi · Show Hiện · Hide Ẩn · More Thêm nữa ·
Yes Có · No Không · OK OK · Next Tiếp · Skip Bỏ qua · Search Tìm kiếm · Refresh Làm mới · Rename Đổi tên.

## Style

- Spelling: modern accents (`hòa`, `xóa`, `hủy`, `khóa`).
- Address the person as "bạn"; Pi is "Pi" (never "anh/chị/em").
- Times: whole words, also in lists: "5 phút", "2 giờ", "3 ngày", "5 phút trước"; "vừa xong" for now.
- Ordinals: "thứ 2" ("lần chạy thứ 2"). Weekday marks: T2…T7, CN; the calendar's one-letter row is "234567C".
- Months: "Tháng 1"… and short "Th1"….
- Group summaries of Pi's calls are past-tense phrases: "đã đọc 2 tệp", "đã chạy 1 lệnh".
- Server messages keep field names and values as code (`voice.turns`, `true`, `null`); only the sentence is Vietnamese.
- Quotes: “…” inside a sentence, so the JSON needs no escapes.
