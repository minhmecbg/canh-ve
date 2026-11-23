// Canh vé rẻ: kiểm tra giá vé máy bay theo lịch và báo qua Telegram (@sanve_bacnam_bot).
// Chạy: node watch.js   (GitHub Actions gọi mỗi 30 phút)
// Biến môi trường:
//   TELEGRAM_BOT_TOKEN  token bot lấy từ @BotFather (bắt buộc)
//   SERPAPI_KEY         key SerpApi (bắt buộc)
//   DROP_PERCENT        rẻ hơn bình thường bao nhiêu % thì báo (mặc định 20)
//   MONTHLY_LIMIT       số lượt tra giá tối đa mỗi tháng (mặc định 240, gói free là 250)
//   MIN_HOURS           khoảng cách tối thiểu giữa 2 lần tra một chuyến (mặc định 1)
//   MOCK=1              chạy thử: giá giả, tin nhắn in ra màn hình
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'data', 'state.json');
const ENV = process.env;
const MOCK = ENV.MOCK === '1';
const TG = ENV.TELEGRAM_BOT_TOKEN || '';
const SERP = ENV.SERPAPI_KEY || '';
const DROP = Number(ENV.DROP_PERCENT || 20) / 100;
const LIMIT = Number(ENV.MONTHLY_LIMIT || 240);
const MIN_HOURS = Number(ENV.MIN_HOURS || 1);
const NOW = MOCK && ENV.MOCK_NOW ? Number(ENV.MOCK_NOW) : Date.now();

const AIRPORTS = {
  HAN: 'Hà Nội', HPH: 'Hải Phòng', VDO: 'Vân Đồn', THD: 'Thanh Hóa', VII: 'Vinh', VDH: 'Đồng Hới', HUI: 'Huế',
  DAD: 'Đà Nẵng', VCL: 'Chu Lai', UIH: 'Quy Nhơn', TBB: 'Tuy Hòa', CXR: 'Nha Trang', DLI: 'Đà Lạt', BMV: 'Buôn Ma Thuột', PXU: 'Pleiku',
  SGN: 'TP.HCM', PQC: 'Phú Quốc', VCA: 'Cần Thơ', VCS: 'Côn Đảo', CAH: 'Cà Mau', VKG: 'Rạch Giá',
};
const ALIAS = { HCM: 'SGN', SG: 'SGN', SAIGON: 'SGN', HN: 'HAN', HANOI: 'HAN', DN: 'DAD', NT: 'CXR', PQ: 'PQC', HP: 'HPH', CT: 'VCA', DL: 'DLI' };
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

// ---------- tiện ích ----------
const vnd = n => Math.round(n).toLocaleString('vi-VN') + 'đ';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayLabel = iso => { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return `${WD[dt.getUTCDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`; };
const vnNow = () => new Date(NOW + 7 * 3600e3); // giờ Việt Nam
const todayVN = () => vnNow().toISOString().slice(0, 10);
const monthVN = () => vnNow().toISOString().slice(0, 7);
const gLink = (w, date = w.date) => 'https://www.google.com/travel/flights?hl=vi&curr=VND&q=' + encodeURIComponent(`Flights from ${w.from} to ${w.to} on ${date} one way`);

function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { }
  return Object.assign({ owner: null, tgOffset: 0, nextId: 1, watches: [], usage: { month: monthVN(), count: 0 } }, s);
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1) + '\n');
}

// ---------- Telegram ----------
async function tg(method, body) {
  if (MOCK) { if (method === 'sendMessage') console.log(`\n--- Telegram → ${body.chat_id} ---\n${body.text.replace(/<[^>]+>/g, '')}`); return { ok: true, result: [] }; }
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
const send = (chat, text) => tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true });

// ---------- tra giá ----------
// Chế độ đêm: "đêm ngày D" = chuyến cất cánh từ NIGHT_FROM giờ ngày D đến trước NIGHT_TO giờ sáng ngày D+1
const NIGHT_FROM = Number(ENV.NIGHT_FROM || 19);
const NIGHT_TO = Number(ENV.NIGHT_TO || 6);
const nextDay = iso => new Date(Date.parse(iso + 'T00:00:00Z') + 86400e3).toISOString().slice(0, 10);
const startH = w => w.fromH ?? NIGHT_FROM; // giờ bắt đầu canh, đổi được bằng /theo ... 14h
const inNight = (w, f) => f.date === w.date ? f.hour >= startH(w) : f.hour < NIGHT_TO;
const ddmm = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7);

async function search(w, date) {
  if (MOCK) return mockResult(w, date);
  const q = new URLSearchParams({ engine: 'google_flights', departure_id: w.from, arrival_id: w.to, outbound_date: date, type: '2', currency: 'VND', hl: 'vi', gl: 'vn', adults: '1', stops: '1', api_key: SERP });
  const r = await fetch('https://serpapi.com/search.json?' + q);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}
function flightsOf(res, w, date) {
  const all = [...(res.best_flights || []), ...(res.other_flights || [])];
  const out = new Map();
  for (const it of all) {
    const seg = (it.flights || [])[0];
    if (!seg || !it.price) continue;
    const fn = seg.flight_number || `${seg.airline} ${seg.departure_airport?.time}`;
    const key = date === w.date ? fn : `${fn} (${ddmm(date)})`; // chuyến rạng sáng hôm sau ghi kèm ngày
    const dep = (seg.departure_airport?.time || '').slice(11, 16);
    const arr = ((it.flights.at(-1) || seg).arrival_airport?.time || '').slice(11, 16);
    const f = { key, fn, date, airline: seg.airline || '', dep, arr, hour: Number(dep.slice(0, 2)) + Number(dep.slice(3)) / 60, price: it.price };
    f.t = f.hour + (date === w.date ? 0 : 24); // giờ tính liên tục qua nửa đêm
    if (w.night && !inNight(w, f)) continue;
    if (!out.has(key) || out.get(key).price > f.price) out.set(key, f);
  }
  return [...out.values()].sort((a, b) => a.price - b.price);
}

// Tìm chuyến rẻ bất thường:
//  (a) rẻ hơn giá thường ngày của chính chuyến đó (trung vị các lần tra trước) ít nhất DROP
//  (b) rẻ hơn chuyến rẻ kế tiếp của các hãng bay cùng khung giờ (±2 tiếng) ít nhất DROP
//  (c) thấp hơn khoảng giá thường của Google Flights cho chặng này
// Luật (b) bị bỏ qua nếu giá vẫn cao hơn khoảng giá thường của Google: rẻ nhất trong một ngày
// giá cao thì chưa phải vé rẻ.
function findDeals(w, flights, insights) {
  const deals = [];
  const tr = insights && insights.typical_price_range;
  const [typLow, typHigh] = Array.isArray(tr) && tr.length === 2 ? tr : [null, null];
  for (const f of flights) {
    const past = (w.hist[f.key] || []).map(p => p[1]);
    const own = past.length >= 3 ? median(past) : null;
    const peers = flights.filter(o => o !== f && Math.abs(o.t - f.t) <= 2).map(o => o.price);
    // So với chuyến rẻ nhất còn lại cùng khung giờ (không dùng trung bình: Vietjet luôn rẻ hơn
    // Vietnam Airlines nên so trung bình sẽ báo liên tục dù không có khuyến mãi gì)
    const slot = peers.length >= 2 ? Math.min(...peers) : null;
    const reasons = [];
    if (own && f.price <= own * (1 - DROP)) reasons.push(`rẻ hơn ${Math.round((1 - f.price / own) * 100)}% so với giá thường của chuyến này (~${vnd(own)})`);
    if (typLow && f.price < typLow) reasons.push(`thấp hơn khoảng giá thường của Google Flights (${vnd(typLow)} – ${vnd(typHigh)})`);
    if (slot && f.price <= slot * (1 - DROP) && !(typHigh && f.price > typHigh)) reasons.push(`rẻ hơn ${Math.round((1 - f.price / slot) * 100)}% so với chuyến rẻ kế tiếp cùng khung giờ (${vnd(slot)})`);
    if (!reasons.length) continue;
    const last = w.alerted[f.key];
    if (last && f.price >= last * 0.97) continue; // đã báo giá này rồi, chỉ báo lại nếu giảm tiếp
    deals.push({ f, reasons });
  }
  // nếu Google cũng đánh giá giá đang thấp thì ghi thêm
  const lvl = insights && insights.price_level;
  return { deals, googleLow: lvl === 'low' };
}

const wLabel = w => (w.night ? '🌙 đêm ' : '') + dayLabel(w.date);
const nightNote = w => w.night ? ` (${startH(w)}h → ${NIGHT_TO}h sáng hôm sau)` : ' (cả ngày)';
const depLabel = (w, f) => f.dep + (f.date !== w.date ? ` ngày ${ddmm(f.date)}` : '');
function dealMsg(w, d, googleLow) {
  const { f, reasons } = d;
  return `🔥 <b>VÉ RẺ: ${w.from} → ${w.to}</b> · ${wLabel(w)}\n` +
    `✈️ ${esc(f.airline)} ${esc(f.fn)} · ${depLabel(w, f)} → ${f.arr}\n` +
    `💰 <b>${vnd(f.price)}</b>\n` + reasons.map(r => '• ' + r).join('\n') +
    (googleLow ? '\n• Google Flights cũng đánh giá giá ngày này đang THẤP' : '') +
    `\n\n👉 <a href="${gLink(w, f.date)}">Mở Google Flights để đặt</a>\nGiá rẻ theo giờ thường hết nhanh, nên đặt sớm.`;
}

function summary(w, flights, insights) {
  if (!flights.length) return `${w.from} → ${w.to} ${wLabel(w)}${nightNote(w)}: chưa thấy chuyến bay thẳng nào.`;
  const top = flights.slice(0, 6).map(f => `${depLabel(w, f)} ${esc(f.airline)} ${esc(f.fn)}: <b>${vnd(f.price)}</b>`).join('\n');
  let s = `📋 <b>${w.from} → ${w.to}</b> · ${wLabel(w)}${nightNote(w)}\nRẻ nhất hiện tại:\n${top}`;
  if (insights && insights.typical_price_range && insights.typical_price_range.length === 2) s += `\n\nGoogle: giá thường ${vnd(insights.typical_price_range[0])} – ${vnd(insights.typical_price_range[1])}`;
  if (insights && insights.price_level) s += `\nMức giá hôm nay theo Google: ${{ low: 'THẤP', typical: 'bình thường', high: 'CAO' }[insights.price_level] || insights.price_level}`;
  return s + `\n\n<a href="${gLink(w)}">Mở Google Flights</a>`;
}

const NEWLOW = Number(ENV.NEWLOW_PERCENT || 3) / 100;
const lowestSeen = w => { let m = null; for (const h of Object.values(w.hist)) for (const [, p] of h) if (m === null || p < m) m = p; return m; };
// Giá rẻ nhất ở lần tra gần mốc thời gian t nhất (để so với hôm qua)
function lowestAt(w, t) {
  const by = {};
  for (const h of Object.values(w.hist)) for (const [ts, p] of h) by[ts] = Math.min(by[ts] ?? Infinity, p);
  const ts = Object.keys(by).map(Number).filter(x => x <= t).sort((a, b) => b - a)[0];
  return ts ? by[ts] : null;
}

// Tin tóm tắt mỗi sáng (sau 8h) cho từng chuyến đang canh, không tốn lượt tra
function dailyMsg(w) {
  const now = w.top[0].price, low = lowestSeen(w), y = lowestAt(w, NOW - 22 * 3600e3);
  const days = Math.ceil((Date.parse(w.date + 'T00:00:00Z') - 7 * 3600e3 - NOW) / 86400e3);
  let trend = '';
  if (y) trend = now < y ? `📉 giảm ${vnd(y - now)} so với hôm qua` : now > y ? `📈 tăng ${vnd(now - y)} so với hôm qua` : '➖ không đổi so với hôm qua';
  return `☀️ <b>Tóm tắt sáng · ${w.from} → ${w.to}</b> · ${wLabel(w)}${nightNote(w)}\nCòn ${days} ngày nữa bay.\n\n` +
    `Rẻ nhất hiện tại:\n` + w.top.map(f => `${depLabel(w, f)} ${esc(f.airline)} ${esc(f.fn)}: <b>${vnd(f.price)}</b>`).join('\n') +
    `\n\n${trend}${trend ? '\n' : ''}Thấp nhất từng thấy: ${vnd(low)}\n<a href="${gLink(w)}">Mở Google Flights</a>`;
}

async function check(state, w, { force = false, reply = null } = {}) {
  if (state.usage.month !== monthVN()) state.usage = { month: monthVN(), count: 0 };
  if (state.usage.count >= LIMIT) { if (reply) await send(reply, `Tháng này đã dùng hết ${LIMIT} lượt tra giá. Đầu tháng sau app tự chạy lại.`); return; }
  let res, flights;
  try {
    res = await search(w, w.date);
    state.usage.count++;
    flights = flightsOf(res, w, w.date);
    // Đêm: tra thêm ngày hôm sau để lấy chuyến rạng sáng. Nếu lần trước hôm sau không có chuyến
    // rạng sáng nào thì chỉ tra lại mỗi ngày một lần để tiết kiệm lượt.
    if (w.night && state.usage.count < LIMIT && (w.d2Has !== false || NOW - (w.d2Probe || 0) > 24 * 3600e3 || reply)) {
      const r2 = await search(w, nextDay(w.date));
      state.usage.count++;
      const f2 = flightsOf(r2, w, nextDay(w.date));
      w.d2Has = f2.length > 0; w.d2Probe = NOW;
      flights = [...flights, ...f2].sort((a, b) => a.price - b.price);
    }
  } catch (e) { console.error('Lỗi tra giá', w.id, e.message); if (reply) await send(reply, 'Tra giá lỗi: ' + esc(e.message)); return; }
  w.lastCheck = NOW;
  const { deals, googleLow } = findDeals(w, flights, res.price_insights);
  for (const d of deals) { await send(state.owner, dealMsg(w, d, googleLow)); w.alerted[d.f.key] = d.f.price; }
  // Báo khi giá rẻ nhất xuống mức thấp mới (thấp hơn mọi lần tra trước ít nhất NEWLOW_PERCENT),
  // kể cả khi chưa xuống dưới giá thường của Google.
  const prevLow = lowestSeen(w);
  const best = flights[0];
  if (best && prevLow && best.price <= prevLow * (1 - NEWLOW) && !deals.some(d => d.f === best)) {
    await send(state.owner, `📉 <b>GIÁ GIẢM: ${w.from} → ${w.to}</b> · ${wLabel(w)}\n` +
      `✈️ ${esc(best.airline)} ${esc(best.fn)} · ${depLabel(w, best)} → ${best.arr}\n` +
      `💰 <b>${vnd(best.price)}</b> (thấp nhất từ trước tới giờ là ${vnd(prevLow)}, giảm ${Math.round((1 - best.price / prevLow) * 100)}%)\n\n` +
      `👉 <a href="${gLink(w, best.date)}">Mở Google Flights</a>`);
  }
  w.top = flights.slice(0, 3).map(f => ({ fn: f.fn, airline: f.airline, dep: f.dep, arr: f.arr, date: f.date, price: f.price }));
  for (const f of flights) { (w.hist[f.key] = w.hist[f.key] || []).push([NOW, f.price]); w.hist[f.key] = w.hist[f.key].slice(-60); }
  if (reply) await send(reply, summary(w, flights, res.price_insights));
  console.log(`Đã tra #${w.id} ${w.from}-${w.to} ${w.date}: ${flights.length} chuyến, ${deals.length} vé rẻ`);
}

// ---------- lệnh Telegram ----------
const HELP = `Mình là bot canh vé rẻ ✈️\n\n` +
  `<b>/theo SGN HAN 04/12</b> — canh chuyến ĐÊM TP.HCM → Hà Nội: từ 19h tối 04/12 đến 6h sáng 05/12\n` +
  `<b>/theo SGN HAN 04/12 14h</b> — canh từ 14h chiều 04/12 đến 6h sáng 05/12\n` +
  `<b>/theo SGN HAN 04/12 cangay</b> — canh cả ngày 04/12\n` +
  `<b>/ds</b> — xem các chuyến đang canh\n` +
  `<b>/gia 1</b> — tra giá ngay chuyến số 1\n` +
  `<b>/xoa 1</b> — bỏ canh chuyến số 1\n` +
  `<b>/sanbay</b> — danh sách mã sân bay\n\n` +
  `Bot tự tra giá định kỳ và nhắn ngay khi có chuyến rẻ hơn hẳn bình thường hoặc rẻ hơn các hãng cùng khung giờ.`;

function parseDate(s) {
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (!m) return null;
  const now = vnNow();
  let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : now.getUTCFullYear();
  let iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (!m[3] && iso < todayVN()) iso = `${y + 1}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(iso + 'T00:00:00Z');
  return isNaN(d) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}
const code = s => { const u = (s || '').toUpperCase(); return AIRPORTS[u] ? u : ALIAS[u] || null; };

async function handle(state, msg) {
  const chat = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!state.owner) { state.owner = chat; await send(chat, 'Đã kết nối! Từ giờ bot chỉ nhận lệnh và báo vé cho bạn.\n\n' + HELP); return; }
  if (chat !== state.owner) { await send(chat, 'Bot này là bot riêng, không nhận lệnh từ bạn.'); return; }
  const [cmd, ...a] = text.split(/\s+/);
  const c = cmd.toLowerCase().replace(/@.*/, '');
  if (c === '/theo') {
    const from = code(a[0]), to = code(a[1]), date = parseDate(a[2] || '');
    if (!from || !to || !date || from === to) return send(chat, 'Cú pháp: <b>/theo SGN HAN 04/12</b>\n(mã sân bay đi, mã sân bay đến, ngày). Gõ /sanbay để xem mã.');
    if (date < todayVN()) return send(chat, 'Ngày này đã qua rồi.');
    if (state.watches.some(w => w.from === from && w.to === to && w.date === date)) return send(chat, 'Chuyến này đang được canh rồi.');
    const rest = a.slice(3).join(' ').normalize('NFC');
    const night = !/(ca|cả)?\s*(ngay|ngày)/i.test(rest);
    const hm = rest.match(/(\d{1,2})\s*h/i);
    const fromH = hm && Number(hm[1]) < 24 ? Number(hm[1]) : undefined;
    const w = { id: state.nextId++, from, to, date, night, fromH, hist: {}, alerted: {}, lastCheck: 0 };
    state.watches.push(w);
    await send(chat, `✅ Bắt đầu canh <b>${from} (${AIRPORTS[from]}) → ${to} (${AIRPORTS[to]})</b> ${wLabel(w)}${nightNote(w)}.\nKhoảng ${fmtH(intervalHours(state))} tiếng tra giá một lần. Đang tra lần đầu...`);
    return check(state, w, { reply: chat });
  }
  if (c === '/ds') {
    if (!state.watches.length) return send(chat, 'Chưa canh chuyến nào. Gõ ví dụ: /theo SGN HAN 04/12');
    const lines = state.watches.map(w => {
      const last = Object.values(w.hist).map(h => h.at(-1)).filter(p => p && p[0] === w.lastCheck).map(p => p[1]);
      return `<b>${w.id}.</b> ${w.from} → ${w.to} · ${wLabel(w)}` + (last.length ? ` · rẻ nhất ${vnd(Math.min(...last))}` : '');
    });
    return send(chat, `Đang canh:\n${lines.join('\n')}\n\nĐã dùng ${state.usage.count}/${LIMIT} lượt tra tháng này, ~${fmtH(intervalHours(state))} tiếng tra một lần.`);
  }
  if (c === '/gia' || c === '/xoa') {
    const w = state.watches.find(x => x.id === Number(a[0]));
    if (!w) return send(chat, `Không thấy chuyến số đó. Gõ /ds để xem số thứ tự.`);
    if (c === '/xoa') { state.watches = state.watches.filter(x => x !== w); return send(chat, `Đã bỏ canh ${w.from} → ${w.to} ${wLabel(w)}.`); }
    return check(state, w, { force: true, reply: chat });
  }
  if (c === '/sanbay') return send(chat, Object.entries(AIRPORTS).map(([k, v]) => `${k} ${v}`).join('\n'));
  return send(chat, HELP);
}

// Chia đều số lượt tra trong tháng cho các chuyến đang canh
// Dùng hết số lượt còn lại trong tháng: mỗi chuyến chỉ cần canh đến trước giờ bay, nên chia
// số lượt còn lại cho đúng khoảng thời gian còn phải canh (giữ lại 15% cho /gia và chuyến mới).
function intervalHours(state) {
  const used = state.usage.month === monthVN() ? state.usage.count : 0;
  const left = Math.max(1, (LIMIT - used) * 0.85);
  const v = vnNow();
  const monthEnd = Date.UTC(v.getUTCFullYear(), v.getUTCMonth() + 1, 1) - 7 * 3600e3; // 0h ngày 1 tháng sau, giờ VN
  let need = 0; // tổng (số lượt mỗi lần tra × số giờ còn phải canh)
  for (const w of state.watches) {
    const end = Date.parse(w.date + 'T00:00:00Z') - 7 * 3600e3 + (w.night ? startH(w) - 1 : 0) * 3600e3;
    const hours = Math.max(0, Math.min(end, monthEnd) - NOW) / 3600e3;
    need += (w.night && w.d2Has !== false ? 2 : 1) * hours;
  }
  if (!need) return MIN_HOURS;
  return Math.max(MIN_HOURS, Math.ceil((need / left) * 2) / 2); // làm tròn lên nửa tiếng
}
const fmtH = h => String(h).replace('.', ',');

async function main() {
  if (!MOCK && (!TG || !SERP)) { console.error('Thiếu TELEGRAM_BOT_TOKEN hoặc SERPAPI_KEY'); process.exit(1); }
  const state = loadState();
  // 1) đọc lệnh mới từ Telegram
  if (!MOCK && !state.bot) { const me = await tg('getMe', {}); state.bot = me.ok ? '@' + me.result.username : null; }
  const up = MOCK ? { result: JSON.parse(ENV.MOCK_UPDATES || '[]') } : await tg('getUpdates', { offset: state.tgOffset, timeout: 0 });
  state.tgStatus = up.ok === false ? `lỗi Telegram: ${up.error_code} ${up.description}` : 'ok';
  if (up.ok === false) console.error(state.tgStatus);
  for (const u of up.result || []) {
    state.tgOffset = u.update_id + 1;
    if (u.message) { try { await handle(state, u.message); } catch (e) { console.error(e); } }
  }
  // 2) bỏ các chuyến đã qua ngày
  state.watches = state.watches.filter(w => w.date >= todayVN());
  for (const w of state.watches) if (w.night === undefined) w.night = true; // bạn bay đêm là chính
  // 3) tra giá các chuyến đến hạn
  const every = intervalHours(state) * 3600e3;
  for (const w of state.watches) if (NOW - (w.lastCheck || 0) >= every - 5 * 60e3) await check(state, w);
  // 4) tóm tắt mỗi sáng
  if (state.owner && vnNow().getUTCHours() >= 8)
    for (const w of state.watches) if (w.top && w.top.length && w.daily !== todayVN()) { await send(state.owner, dailyMsg(w)); w.daily = todayVN(); }
  state.runs = [...(state.runs || []), NOW].slice(-48); // để kiểm tra GitHub có chạy đúng lịch không
  saveState(state);
}

// ---------- dữ liệu giả để chạy thử ----------
function mockResult(w, date) {
  const base = date !== w.date ? [['VJ 1100', 'Vietjet', '00:30'], ['VN 6000', 'Vietnam Airlines', '05:30'], ['VJ 1102', 'Vietjet', '09:00']] : [['VJ 120', 'Vietjet', '06:00'], ['VN 210', 'Vietnam Airlines', '06:30'], ['QH 202', 'Bamboo Airways', '07:15'], ['VJ 124', 'Vietjet', '08:10'], ['VN 216', 'Vietnam Airlines', '09:00'], ['VU 750', 'Vietravel Airlines', '13:00'], ['VJ 140', 'Vietjet', '19:30'], ['VN 254', 'Vietnam Airlines', '20:00'], ['QH 280', 'Bamboo Airways', '21:00'], ['VJ 160', 'Vietjet', '22:30']];
  const cheap = ENV.MOCK_CHEAP || '';
  const mk = ([n, al, t], i) => {
    let p = 1400000 + i * 90000 + (al === 'Vietnam Airlines' ? 600000 : 0) + Math.round(Math.random() * 40000);
    if (n === cheap) p = 690000;
    const h = Number(t.slice(0, 2)) + 2;
    return { price: p, flights: [{ airline: al, flight_number: n, departure_airport: { id: w.from, time: `${date} ${t}` }, arrival_airport: { id: w.to, time: `${date} ${String(h).padStart(2, '0')}${t.slice(2)}` } }] };
  };
  return { best_flights: base.slice(0, 3).map((b, i) => mk(b, i)), other_flights: base.slice(3).map((b, i) => mk(b, i + 3)), price_insights: { lowest_price: 690000, price_level: cheap ? 'low' : 'typical', typical_price_range: [1300000, 2100000] } };
}

main().catch(e => { console.error(e); process.exit(1); });
