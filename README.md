# Canh vé rẻ

Bot Telegram tự tra giá vé máy bay (dữ liệu Google Flights qua SerpApi) và nhắn ngay khi có chuyến rẻ bất thường.

## Khi nào bot báo

Bot báo một chuyến khi giá của nó thấp hơn ít nhất 20% (`DROP_PERCENT`) so với một trong hai mức sau:
- **Giá thường của chính chuyến đó**: trung vị các lần tra trước, cần ít nhất 3 lần tra.
- **Chuyến rẻ kế tiếp cùng khung giờ** (±2 tiếng) của các hãng khác.

Mỗi mức giá chỉ báo một lần. Nếu chuyến đó giảm tiếp thì bot báo lại.

## Lệnh Telegram

| Lệnh | Việc |
|---|---|
| `/theo SGN HAN 04/12` | Canh chặng, ngày |
| `/ds` | Danh sách đang canh |
| `/gia 1` | Tra giá ngay |
| `/xoa 1` | Bỏ canh |
| `/sanbay` | Mã sân bay |

Người đầu tiên nhắn bot trở thành chủ bot. Bot không nhận lệnh từ người khác.

## Cài đặt

1. Tạo bot bằng @BotFather trên Telegram và lấy token.
2. Đăng ký serpapi.com (gói Free 250 lượt/tháng) và lấy API key.
3. Đưa thư mục này lên một repo GitHub **riêng tư** (private).
4. Vào Settings → Secrets and variables → Actions và thêm `TELEGRAM_BOT_TOKEN`, `SERPAPI_KEY`.
5. Vào tab Actions, bật workflow, rồi nhắn `/start` cho bot.

## Giới hạn

- Có 240 lượt tra mỗi tháng, chia đều cho các chuyến đang canh. Canh 1 chuyến thì 3 tiếng tra một lần; canh 2 chuyến thì 6 tiếng một lần. Muốn tra dày hơn thì mua gói SerpApi lớn hơn và đặt biến `MONTHLY_LIMIT`.
- GitHub có thể chạy trễ vài phút so với lịch. Lệnh Telegram được xử lý trong khoảng 30 phút.
- Chạy thử không cần key: `MOCK=1 node watch.js`
