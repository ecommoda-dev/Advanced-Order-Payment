/**
 * advanced-order-payment-worker  (v1.0.0)
 * skills: worker-builder v3.10.0 · constants v4.4.0 · order-lifecycle v1.9.0 — 01-11-2026
 *
 * ─────────────────────────────────────────────────────────────────────────
 * الأداة: تسجيل تحصيل أوردر **قبل الشحن** — أوردر واحد في المرة (مفيش دفعات).
 *
 * اللي بتعمله بالظبط:
 *   1) lookup_order  → بتجيب الأوردر من شوبيفاي (بالرقم أو بالـ Order ID) وبتحسب
 *      الأهلية. القراءة بس — صفر كتابة.
 *   2) record_payment → بتسجّل التحصيل على شوبيفاي (transaction kind=capture
 *      gateway=manual، REST) وبتكتب صف `payment` في D1.
 *
 * ⛔ اللي مابتعملوش أبدًا:
 *   • مفيش استرداد (refund) — لا endpoint ولا كود. أوردر مستحق استرداد
 *     (متبقي سالب) بيترفض بسبب مكتوب.
 *   • مفيش تحصيل جزئي — المبلغ لازم يساوي المستحق الحالي على شوبيفاي بالظبط.
 *   • مفيش لمس لـ PRE_REG_KV ولا لأي ميتافيلد — الكتابة الوحيدة على شوبيفاي
 *     هي الـ transaction.
 *
 * 🔴 قاعدة الأهلية (قرار أحمد 01-11-2026) — بتتحسب هنا في الـ Worker مش في
 *    الواجهة، وبتتعاد على قراءة جديدة وقت الكتابة (worker-builder Step 5A ⑩ ④):
 *      S1 (custom.manual_status)  == 'Confirmed' بالظبط
 *      S2 (custom.status_2_r_e)   فاضي (null) — أي قيمة = رفض
 *      الأوردر مش ملغي · canMarkAsPaid · المتبقي على شوبيفاي > 0
 *    كل الأسباب بتتعرض مع بعض بقيمتها الحرفية (مش أول سبب بس).
 *
 * العقد مع الواجهة:
 *   • كل الـ actions بـ `?action=` — الجسم JSON في POST بس (PIN وبيانات الدفع).
 *   • الرفض/الفشل التشغيلي بيرجع HTTP 200 و`success:false` و`status`:
 *       success | warning | error | already | rejected
 *     (الأربع حالات + rejected = اتوقف قبل أي محاولة — Step 5A ④ و ⑭).
 *   • HTTP 400 = طلب باظ (حقل ناقص/رقم غلط) — مش بيتسجّل في D1.
 *   • HTTP 500 = عطل (شوبيفاي/D1/إعدادات) — الرسالة بتقول إيه اللي وقع.
 *
 * D1: tool = 'advanced_order_payment'
 *     type : payment  (اتبعتت لشوبيفاي: extra.result ∈ success | warning | error)
 *            rejected (اتوقفت قبل أي محاولة: extra.result ∈ rejected | already)
 *            login · logout
 *     ⚠️ استعلام أي مجموع لازم يفلتر على extra.result = 'success' — type لوحده
 *        بيعدّ المحاولات (Step 5A ⑭).
 *     ⚠️ `valueAfter` = المبلغ اللي اتسجّل فعلاً. صف `warning` (مش متأكدين)
 *        و`error` بيتكتبوا بـ valueAfter = null عشان مايدخلوش أي مجموع.
 *
 * Env bindings required:
 *   WORKER_SECRET   — سر (فريد للأداة دي — مش عضو في أي مجموعة سر لسه)
 *   CLIENT_ID       — سر · Shopify OAuth
 *   CLIENT_SECRET   — سر · Shopify OAuth
 *   SHOP_DOMAIN     — var في wrangler.toml
 *   DB              — D1 → ecommoda-dev-logs
 *
 * الصلاحيات المطلوبة على الـ Custom App: read_orders + write_orders
 * (`?action=diag` بيتأكد منهم بالاسم).
 */

// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME = 'advanced_order_payment';

// مطلوب لـ ?action=get_config — الواجهة بتقارنه بـ MIN_WORKER_VERSION (Step 5A ⑨)
const WORKER_VERSION = '1.0.0';

// ─── §CONSTANTS::status — القيم بالحرف (casing جزء من القيمة) ───
// ecommoda-order-lifecycle §1 — تغيير حرف واحد = صفر نتيجة بلا أي خطأ.
const S1_REQUIRED = 'Confirmed';   // الأداة دي بتقبل S1 = Confirmed وبس
// S2 لازم يكون فاضي — مفيش قيمة مقبولة منه.

// سقف تصدير السجل — بيرجع للواجهة كـ `cap` جنب `total` و`truncated`
// (html-builder Standards #30). مصدر الحالة: سجل بيكبر بصف لكل محاولة تحصيل.
const LOG_EXPORT_MAX = 2000;

// نافذة حارس التكرار — تحصيل ناجح/مش مؤكَّد على نفس الأوردر خلال المدة دي
// بيرفض أي محاولة تانية. بيغطي ضغطتين من جهازين في نفس اللحظة (القراءة
// اللي قبل الكتابة مابتشوفش الكتابة التانية لسه). قرار تشغيلي مش قياس.
const DUP_GUARD_MS = 120 * 1000;

// فرق مسموح في المقارنات المالية (قرش واحد) — المقارنة بالقروش مش بالكسور
const MONEY_EPS_CENTS = 1;

// ══════════════════════════════════════════════════════
// §CORS — Option B (أداة مالية: تسجيل تحصيل)
// ══════════════════════════════════════════════════════
// ⚠️ العنصر [0] هو الـ fallback في getCORS() و json() — لازم يفضل دومين حقيقي.
const ALLOWED_ORIGINS = [
  'https://ecommoda-dev.github.io',
];
function getCORS(request) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] });
  return new Response(JSON.stringify(data), { status, headers });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── §HELPERS::assertEnv ───
// متغير ناقص لازم يوقف العملية برسالة باسمه (Step 5A ⑧).
const ENV_REQUIRED = {
  shopify: ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'],
};
function assertEnv(env, ...groups) {
  const missing = [];
  for (const g of groups) {
    for (const key of (ENV_REQUIRED[g] || [])) {
      if (env[key] === undefined || env[key] === null || String(env[key]).trim() === '') missing.push(key);
    }
  }
  if (!env.DB) missing.push('DB (D1 binding)');
  if (missing.length) {
    throw new Error(
      `متغيرات ناقصة في الـ Worker: ${missing.join('، ')} — ضِفها من Dashboard → Settings → ` +
      `Variables ثم Promote النسخة. (شغّل ?action=diag)`
    );
  }
}

// ─── §HELPERS::money ───
// كل المقارنات المالية بالقروش (أعداد صحيحة) — مفيش `===` على كسور عشرية.
const toCents = (v) => Math.round(Number(v) * 100);
const fmtMoney = (cents) => (cents / 100).toFixed(2);

// ─── §HELPERS::time — توقيت القاهرة يتحسب، مايتكتبش ثابت (constants §13) ───
// ⚠️ نفس الدوال بالحرف في الواجهة. صفر إزاحة مكتوبة ثابت — مصر بترجع UTC+2
//    يوم 29-10-2026 والأداة مابتشتكيش لو الثابت غلط.
const CAIRO_TZ = 'Africa/Cairo';
const _cairoFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAIRO_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function cairoParts(d) {
  const o = {};
  for (const p of _cairoFmt.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';        // حارس: بعض المحركات بترجّع 24
  return o;
}
function cairoOffsetMinutes(d) {             // ١٨٠ صيفًا · ١٢٠ شتاءً
  const p = cairoParts(d);
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day,
                              +p.hour, +p.minute, +p.second) - d.getTime()) / 60000);
}
// حدود يوم تقويمي بالقاهرة → UTC — الإزاحة تتقاس عند **ظهر** اليوم
// (أي تحويل توقيت بيحصل فجرًا، فالظهر بيدّي إزاحة اليوم الصحيحة)
function cairoDayBoundsUTC(dateStr) {
  const offMin = cairoOffsetMinutes(new Date(`${dateStr}T12:00:00.000Z`));
  return {
    start: new Date(Date.parse(`${dateStr}T00:00:00.000Z`) - offMin * 60000).toISOString(),
    end:   new Date(Date.parse(`${dateStr}T23:59:59.999Z`) - offMin * 60000).toISOString(),
  };
}

// ══════════════════════════════════════════════════════
// §SHARED — copy verbatim — never modify
// ══════════════════════════════════════════════════════
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();

  if (!row) return null;
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');

  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username)
    .run()
    .catch(() => {});

  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row) return { exists: false, hasPin: false, isActive: false };
  return { exists: true, hasPin: !!row.pin, isActive: !!row.is_active };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');

  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?').bind(pin, username).run();
  return true;
}

// ─── §AUTH::apps — الواجهة الوحيدة للـ Worker ده (Step 4) ───
// قايمة بيضاء مقفولة. الأداة بتخدم واجهة واحدة فـ `appId` مالوش لازمة، بس
// resolveAuthTool مطلوبة من بلوك auth-endpoints.
const AUTH_APPS = new Set([TOOL_NAME]);
function resolveAuthTool(appId) { return AUTH_APPS.has(appId) ? appId : TOOL_NAME; }

// ════════════════════════════════════════════════════════════
// §LOG-REG — الحارس الديناميكي لقيم اللوج (الطبقة ٥ · worker-builder Step 7-ج)
// ════════════════════════════════════════════════════════════
// قطعة الأداة دي بس من log-values.json اللي جنبها — بتتحدّث معاه في نفس
// الـ commit. القيمة غير المسجّلة **بتتكتب برضه** (مفيش رفض كتابة أبدًا).
const LOG_REGISTRY = {
  advanced_order_payment: new Set(['login', 'logout', 'payment', 'rejected']),
};

const isRegisteredLogValue = (tool, type) => !!LOG_REGISTRY[tool]?.has(type);

// UPSERT على (source_tool, tool, type) — صف واحد لكل قيمة، hits بيعدّ.
const LOG_ALERT_SQL = `
  INSERT INTO log_value_alerts
    (source_tool, tool, type, first_seen, last_seen, hits,
     worker_version, sample_order_name, sample_employee, sample_notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_tool, tool, type) DO UPDATE SET
    last_seen         = excluded.last_seen,
    hits              = log_value_alerts.hits + excluded.hits,
    worker_version    = excluded.worker_version,
    sample_order_name = excluded.sample_order_name,
    sample_employee   = excluded.sample_employee,
    sample_notes      = excluded.sample_notes,
    status            = CASE WHEN log_value_alerts.status = 'ignored'
                             THEN 'ignored' ELSE 'open' END
`;

// فشل التنبيه ممنوع يأثر على أي حاجة — try/catch صامت (التنبيه فهرس مش سجل).
async function noteUnregisteredLogValues(db, entries) {
  const byPair = new Map();
  for (const e of entries) {
    const key = `${e.tool}\u0000${e.type}`;
    const acc = byPair.get(key);
    if (acc) { acc.hits++; continue; }
    byPair.set(key, { entry: e, hits: 1 });
  }
  const now = new Date().toISOString();
  for (const { entry, hits } of byPair.values()) {
    try {
      await db.prepare(LOG_ALERT_SQL).bind(
        TOOL_NAME, entry.tool ?? '(بدون tool)', entry.type ?? '(بدون type)',
        now, now, hits, WORKER_VERSION ?? null,
        entry.orderName ?? null, entry.employee ?? null,
        entry.notes ? String(entry.notes).slice(0, 200) : null,
      ).run();
    } catch (e) { /* متعمّد: التنبيه فهرس، وفشله أهون من تعطيل الأداة */ }
  }
}

async function writeLog(db, entry) {
  const unregistered = !isRegisteredLogValue(entry.tool, entry.type);
  const extra = unregistered
    ? { ...(entry.extra || {}), _unregistered: true }
    : entry.extra;

  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    extra ? JSON.stringify(extra) : null
  ).run();

  if (unregistered) await noteUnregisteredLogValues(db, [entry]);   // بعد الكتابة، مش قبلها
}

// ─── §SHARED::safeWriteLog — worker-builder Step 5A ⑦ ───
// 🔴 التحصيل بيحصل على شوبيفاي **قبل** الكتابة في D1. `await writeLog` مكشوف
//    كان معناه إن فشل D1 يطلع للـ catch الخارجي ويرجّع 500 — فالموظف يشوف
//    "فشل" على تحصيل **اتنفّذ فعلًا** ويعيده. القاعدة: العملية حصلت — بس مفيش
//    سجل. يترجع `logged:false` والواجهة تحذّر. ⛔ ممنوع `.catch(() => {})`.
async function safeWriteLog(db, entry) {
  try { await writeLog(db, entry); return { logged: true, logError: null }; }
  catch (e) { console.error('writeLog failed:', e.message); return { logged: false, logError: e.message }; }
}

// ─── §SHARED::logFilters ───
// ⚠️ انحرافان **مقصودان** عن references/shared-functions.md (والنسخة المركزية
//    لسه ما اتحدّثتش بيهم — لو اتعمّموا، تنتقل للمهارة):
//    ① `results[]` — فلتر على extra.result (عمود «النتيجة» في الجدول فلتر قيم)،
//       و`orders[]` (رقم الأوردر توكنز) و`amountMin/amountMax` (نطاق المبلغ).
//    ② dateFrom/dateTo بيتقارنوا بحدود **يوم القاهرة** (cairoDayBoundsUTC —
//       constants §13) مش substr(timestamp) على UTC. العرض بتوقيت القاهرة،
//       والمقارنة بـ UTC كانت بتحط عملية بعد ٩ مساءً في يوم تاني.
function parseListParam(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  results   = null,
  orders    = null,
  amountMin = null, amountMax = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);
  const ress = Array.isArray(results)   && results.length   ? results   : [];

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) {
    sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps);
  }
  if (typs.length) {
    sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs);
  }
  if (ress.length) {
    sql += ` AND json_extract(extra, '$.result') IN (${ress.map(() => '?').join(',')})`; b.push(...ress);
  }
  // ③ orders[] — فلتر «رقم الأوردر» توكنز (Enter بيضيف توكن، والتوكنز OR). مطابقة
  //    تامة على `#<رقم>` — الرقم الجزئي مش بيطابق أوردر تاني (#55 ≠ #5500).
  const ords = (Array.isArray(orders) ? orders : [])
    .map(o => String(o).replace(/^#/, '').trim()).filter(o => /^\d{1,15}$/.test(o)).map(o => `#${o}`);
  if (ords.length) {
    sql += ` AND order_name IN (${ords.map(() => '?').join(',')})`; b.push(...ords);
  }
  // ④ نطاق المبلغ (value_after) — الصفوف بلا مبلغ (error/rejected/warning غير مؤكَّد) بتطلع برّه النطاق.
  const lo = amountMin === null || amountMin === '' ? NaN : Number(amountMin);
  const hi = amountMax === null || amountMax === '' ? NaN : Number(amountMax);
  if (Number.isFinite(lo)) { sql += ' AND value_after >= ?'; b.push(lo); }
  if (Number.isFinite(hi)) { sql += ' AND value_after <= ?'; b.push(hi); }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) { sql += ' AND timestamp >= ?'; b.push(cairoDayBoundsUTC(dateFrom).start); }
  if (dateTo   && /^\d{4}-\d{2}-\d{2}$/.test(dateTo))   { sql += ' AND timestamp <= ?'; b.push(cairoDayBoundsUTC(dateTo).end); }

  return { sql, b };
}

// ⚠️ قائمة **مقفولة** — القيمة جاية من العميل وبتتلزق في نص SQL مباشرةً
//    (ORDER BY مابيقبلش bind). أي قيمة بره القايمة بترجع للافتراضي بدون خطأ.
// ⚠️ المفاتيح لازم تطابق `data-sort-key` في الواجهة **حرفيًا**.
const LOG_SORT_COLUMNS = {
  date: 'timestamp', time: 'timestamp', employee: 'employee', orderName: 'order_name',
  type: 'type', amount: 'value_after', result: `json_extract(extra, '$.result')`,
};

function orderByClause(sortBy, sortDir) {
  const col = LOG_SORT_COLUMNS[String(sortBy || '')] || 'timestamp';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 🔴 كاسر تعادل إلزامي: من غيره صفوف نفس القيمة بترتيب عشوائي بين الصفحات.
  return col === 'timestamp' ? ` ORDER BY timestamp ${dir}`
                             : ` ORDER BY ${col} ${dir}, timestamp DESC`;
}

async function getLogs(db, { limit = 100, offset = 0, sortBy, sortDir, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + orderByClause(sortBy, sortDir) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

// ⚠️ بتقص في السكوت عند LOG_EXPORT_MAX — الـ endpoint بيرجّع cap/total/truncated.
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types'), results = csv('results'), orders = csv('orders');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    results:   results.length ? results : null,
    orders:    orders.length ? orders : null,
    amountMin: url.searchParams.get('amountMin'),
    amountMax: url.searchParams.get('amountMax'),
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}

// ══════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════
// ⚠️ التوكن مشترك بين كل Workers الستاك (نفس الـ Custom App) — ومعاه نفس
//    ميزانية تكلفة GraphQL. فشل OAuth عابر بيتعافى هنا بدل ما يتحوّل لفشل
//    كامل. → worker-builder Step 5A ⑯ ②
const OAUTH_MAX_ATTEMPTS = 3;

// جسم الطلب form-urlencoded زي كل الأدوات الشغّالة في الإنتاج
// (cod-payment-center-worker) — مش JSON.
async function getAccessToken(env) {
  assertEnv(env, 'shopify');
  let lastErr = null;
  for (let attempt = 1; attempt <= OAUTH_MAX_ATTEMPTS; attempt++) {
    let resp, raw;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`.replace(/\/$/, ''), {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'client_credentials',
          client_id:     env.CLIENT_ID,
          client_secret: env.CLIENT_SECRET,
        }),
      });
      raw = await resp.text();
    } catch (e) {
      lastErr = new Error(`OAuth: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < OAUTH_MAX_ATTEMPTS) { await sleep(400 * attempt); continue; }
      throw lastErr;
    }
    if (!resp.ok) {
      // 429/5xx قابلة لإعادة المحاولة؛ 401/403 لأ (CLIENT_ID/SECRET غلط)
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`OAuth: شوبيفاي ردّت HTTP ${resp.status} — ${raw.slice(0, 160)}`);
      if (retriable && attempt < OAUTH_MAX_ATTEMPTS) { await sleep(700 * attempt); continue; }
      throw lastErr;
    }
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error(`OAuth: رد شوبيفاي مش JSON — ${raw.slice(0, 160)}`); }
    if (!data.access_token) throw new Error('OAuth: الرد من غير access_token');
    return data.access_token;
  }
  throw lastErr || new Error('OAuth: فشل غير معروف');
}

// ─── §SHOPIFY::shopifyGQL — العقد الإلزامي (Step 5A ①) ───
// أي فشل بيترمي. مفيش رد بيعدّي وهو فاشل:
//   ① فشل شبكة  ② HTTP status  ③ رد مش JSON  ④ data.errors  ⑤ data فاضية
// ⚠️ تكلفة الاستعلام — الرصيد المتبقي و«النداء ده كلّف كام» رقمان مختلفان،
//    والقرار بيتبني على التاني. → worker-builder Step 5A ⑮
let _lastThrottle = null, _lastQueryCost = null;

async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify', costLog = null) {
  assertEnv(env, 'shopify');
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`.replace(/\/$/, ''), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await sleep(400 * attempt); continue; }
      throw lastErr;
    }

    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await sleep(700 * attempt); continue; }
      throw lastErr;
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(
        `${opName}: ${data.errors.map(e => e.message).join(' | ')}` +
        (codes.length ? ` [${codes.join(',')}]` : '')
      );
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) { await sleep(1200 * attempt); continue; }
      throw lastErr;
    }

    if (!data.data) throw new Error(`${opName}: رد شوبيفاي بدون data — ${text.slice(0, 180)}`);

    if (data.extensions?.cost) {
      const c = data.extensions.cost;
      if (c.throttleStatus) _lastThrottle = c.throttleStatus;
      _lastQueryCost = { op: opName, requested: c.requestedQueryCost ?? null, actual: c.actualQueryCost ?? null };
      if (costLog) costLog.push({ op: opName, requested: c.requestedQueryCost ?? null, actual: c.actualQueryCost ?? null });
    }
    return data;
  }
  throw lastErr || new Error(`${opName}: فشل غير معروف`);
}

// ─── §SHOPIFY::getOrderIdByName ───
// بيدوّر بالاسم وبيطابق **حرفيًا** على `#<رقم>` — بحث شوبيفاي ممكن يرجّع أوردر
// قريب، وأول نتيجة من غير مطابقة كانت هتسجّل تحصيل على أوردر تاني.
// null = مفيش أوردر بالاسم ده فعلاً (الحالة الوحيدة). أي فشل استعلام بيترمي.
async function getOrderIdByName(env, token, orderNumber) {
  const query = `
    query getOrderByNumber($query: String!) {
      orders(first: 3, query: $query) { nodes { id name } }
    }
  `;
  const data  = await shopifyGQL(env, token, query, { query: `name:#${orderNumber}` }, 'getOrderByNumber');
  const nodes = data?.data?.orders?.nodes || [];
  const hit   = nodes.find(n => n.name === `#${orderNumber}`);
  return hit ? hit.id.replace('gid://shopify/Order/', '') : null;
}

// ─── §SHOPIFY::getOrderForPayment ───
// null = الأوردر مش موجود فعلاً. أي فشل استعلام بيترمي من shopifyGQL قبل ما
// يوصل هنا — الخلط بين الاتنين هو العطل (Step 5A ⑥).
async function getOrderForPayment(env, token, numericId) {
  const query = `
    query getOrderForPayment($id: ID!) {
      order(id: $id) {
        id
        legacyResourceId
        name
        currencyCode
        cancelledAt
        canMarkAsPaid
        displayFinancialStatus
        displayFulfillmentStatus
        totalOutstandingSet { shopMoney { amount currencyCode } }
        totalReceivedSet    { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        subtotalPriceSet    { shopMoney { amount } }
        shippingLine { originalPriceSet { shopMoney { amount } } }
        courierMeta: metafield(namespace: "custom", key: "courier")               { value }
        preRegMeta:  metafield(namespace: "custom", key: "pre_register_payment")  { value }
        s1Meta:      metafield(namespace: "custom", key: "manual_status")         { value }
        s2Meta:      metafield(namespace: "custom", key: "status_2_r_e")          { value }
        lineItems(first: 50) {
          nodes {
            sku name quantity currentQuantity
            originalUnitPriceSet   { shopMoney { amount } }
            discountedTotalSet     { shopMoney { amount } }
          }
        }
      }
    }
  `;
  const data  = await shopifyGQL(env, token, query, { id: `gid://shopify/Order/${numericId}` }, 'getOrderForPayment');
  const order = data?.data?.order;
  if (!order) return null;

  // 🔴 المتبقي لو مجاش من شوبيفاي = فشل، **مش صفر**. الصفر معناه «مدفوع بالكامل»
  //    وده كان بالظبط عيلة العطل اللي اتصلح في cod-payment-center v3.5.0.
  const outstandingRaw = order.totalOutstandingSet?.shopMoney?.amount;
  if (outstandingRaw == null || !Number.isFinite(Number(outstandingRaw))) {
    throw new Error(`شوبيفاي ما رجّعتش المستحق للأوردر ${order.name || numericId} — العملية اتوقفت (مش هنفترض صفر)`);
  }

  const money = (x) => Number.isFinite(Number(x)) ? Number(x) : 0;   // للعرض بس — مش للقرار
  return {
    orderId:          String(order.legacyResourceId || numericId),
    orderName:        order.name,
    currency:         order.currencyCode || order.totalOutstandingSet?.shopMoney?.currencyCode || 'EGP',
    cancelled:        !!order.cancelledAt,
    cancelledAt:      order.cancelledAt || null,
    canMarkAsPaid:    !!order.canMarkAsPaid,
    financialStatus:  order.displayFinancialStatus || null,
    fulfillmentStatus: order.displayFulfillmentStatus || null,
    outstandingCents: toCents(outstandingRaw),
    receivedCents:    toCents(money(order.totalReceivedSet?.shopMoney?.amount)),
    totalCents:       toCents(money(order.currentTotalPriceSet?.shopMoney?.amount)),
    subtotalCents:    toCents(money(order.subtotalPriceSet?.shopMoney?.amount)),
    shippingCents:    toCents(money(order.shippingLine?.originalPriceSet?.shopMoney?.amount)),
    s1:               order.s1Meta?.value || null,
    s2:               order.s2Meta?.value || null,
    courier:          order.courierMeta?.value || null,
    preRegistered:    order.preRegMeta?.value === 'Pre-Registered Payment',
    lineItems: (order.lineItems?.nodes || [])
      .filter(li => (li.currentQuantity ?? li.quantity) > 0)
      .map(li => ({
        sku:        li.sku || '',
        name:       li.name || '',
        quantity:   li.currentQuantity ?? li.quantity,
        unitPrice:  money(li.originalUnitPriceSet?.shopMoney?.amount).toFixed(2),
        totalPrice: money(li.discountedTotalSet?.shopMoney?.amount).toFixed(2),
      })),
  };
}

// ─── §SHOPIFY::readOutstandingAfter ───
// قراءة التحقق بعد التحصيل. بترجّع null لو القراءة نفسها فشلت — والمنادي بيحوّل
// ده لـ warning «ما قدرناش نتأكد» (مش success ومش error).
async function readOutstandingAfter(env, token, numericId) {
  try {
    const query = `
      query paymentVerify($id: ID!) {
        order(id: $id) {
          displayFinancialStatus
          totalOutstandingSet { shopMoney { amount } }
        }
      }
    `;
    const data  = await shopifyGQL(env, token, query, { id: `gid://shopify/Order/${numericId}` }, 'paymentVerify');
    const order = data?.data?.order;
    const raw   = order?.totalOutstandingSet?.shopMoney?.amount;
    if (!order || raw == null || !Number.isFinite(Number(raw))) return null;
    return { outstandingCents: toCents(raw), financialStatus: order.displayFinancialStatus || null };
  } catch (e) {
    console.warn('readOutstandingAfter failed:', e.message);
    return null;
  }
}

// ─── §SHOPIFY::createCapture ───
// REST مش GraphQL — `orderCapture` مابتشتغلش على الـ COD (Step 5).
// بيرجّع 3 نتايج مش اتنين:
//   { success:true,  transactionId }            — شوبيفاي أكدت (id راجع)
//   { success:false, uncertain:false, error }   — شوبيفاي ردّت ورفضت صراحةً
//   { success:false, uncertain:true,  error }   — **معرفناش**: الاتصال انقطع أو
//        الرد مش مفهوم — الـ transaction ممكن تكون اتسجّلت. المنادي بيتحقق بقراءة.
async function createCapture(env, token, numericOrderId, amountStr, currency) {
  let res, raw;
  try {
    res = await fetch(
      `https://${env.SHOP_DOMAIN}/admin/api/2026-01/orders/${numericOrderId}/transactions.json`.replace(/\/$/, ''),
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({
          transaction: { kind: 'capture', status: 'success', amount: amountStr, currency, gateway: 'manual' },
        }),
      }
    );
    raw = await res.text();
  } catch (e) {
    return { success: false, uncertain: true, error: `انقطع الاتصال بشوبيفاي بعد إرسال التحصيل — ${e.message}` };
  }

  let data = null;
  try { data = JSON.parse(raw); } catch { /* مش JSON — بيتعامل معاه تحت */ }

  if (res.ok && data?.transaction?.id) return { success: true, transactionId: data.transaction.id };
  if (res.status >= 400 && res.status < 500 && data?.errors) {
    return { success: false, uncertain: false, error: typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors) };
  }
  // 2xx من غير transaction.id · 5xx · رد مش JSON → مش متأكدين إن شوبيفاي ما سجّلتش
  return { success: false, uncertain: true, error: `رد شوبيفاي غير مفهوم (HTTP ${res.status}) — ${String(raw).slice(0, 160)}` };
}

// ══════════════════════════════════════════════════════
// §PAYMENT — الأهلية + حارس التكرار + تسجيل التحصيل
// ══════════════════════════════════════════════════════

// ─── §PAYMENT::evaluateEligibility ───
// 🔴 المصدر الوحيد للأهلية. بتتنادى من lookup_order (للعرض) ومن record_payment
//    (على قراءة جديدة وقت الكتابة) — فمستحيل الشاشة تقول «مؤهل» والكتابة ترفض
//    بسبب تاني، ولا العكس.
// كل الأسباب بتتجمّع مع بعض بقيمتها الحرفية (الموظف لازم يشوف كل اللي ناقص مرة
// واحدة، مش يصلّح سبب وبعدين يلاقي التاني).
//
// `alreadyPaid` = السبب الوحيد إن الأوردر مدفوع بالكامل. ده مش فشل — ده
// «اتعمل خلاص» (status = 'already') ولازم يتفرّق عن الرفض الحقيقي (Step 5A ④).
function evaluateEligibility(o) {
  const reasons = [];

  if (o.cancelled) {
    reasons.push({ code: 'cancelled', text: 'الأوردر ملغي على شوبيفاي — مينفعش يتسجّل عليه تحصيل' });
  }
  if (o.s1 !== S1_REQUIRED) {
    reasons.push({ code: 's1', text: `S1 لازم يكون ${S1_REQUIRED} — الحالي: ${o.s1 || 'فارغ'}` });
  }
  if (o.s2) {
    reasons.push({ code: 's2', text: `S2 لازم يكون فارغ — الحالي: ${o.s2} (الأداة دي لأوردرات الدورة الأولى S1 بس)` });
  }

  if (!o.cancelled) {
    if (o.outstandingCents < -MONEY_EPS_CENTS) {
      reasons.push({ code: 'refund_due', text: `الأوردر مستحق له استرداد ${fmtMoney(-o.outstandingCents)} — الأداة دي مابتسجّلش استرداد` });
    } else if (o.outstandingCents <= MONEY_EPS_CENTS || o.financialStatus === 'PAID') {
      reasons.push({ code: 'paid', text: 'الأوردر مدفوع بالكامل — مفيش مستحق للتسجيل' });
    } else if (!o.canMarkAsPaid) {
      reasons.push({ code: 'cannot_mark_paid', text: `شوبيفاي مش بتسمح بتسجيل دفع على الأوردر ده دلوقتي (الحالة المالية: ${o.financialStatus || '—'})` });
    }
  }

  return {
    eligible:    reasons.length === 0,
    reasons,
    alreadyPaid: reasons.length === 1 && reasons[0].code === 'paid',
  };
}

// ─── §PAYMENT::publicOrder ───
// الشكل اللي بيروح للواجهة. القروش بتتحوّل لنص بكسرين هنا — الواجهة مابتحسبش.
function publicOrder(o) {
  return {
    orderId: o.orderId, orderNumber: o.orderName,
    currency: o.currency, cancelled: o.cancelled, cancelledAt: o.cancelledAt,
    s1: o.s1, s2: o.s2, courier: o.courier,
    financialStatus: o.financialStatus, fulfillmentStatus: o.fulfillmentStatus,
    preRegistered: o.preRegistered,
    outstanding: fmtMoney(o.outstandingCents), received: fmtMoney(o.receivedCents),
    total: fmtMoney(o.totalCents), subtotal: fmtMoney(o.subtotalCents),
    shippingAmount: fmtMoney(o.shippingCents),
    lineItems: o.lineItems,
  };
}

// ─── §PAYMENT::recentPaymentGuard ───
// تحصيل ناجح أو مش مؤكَّد على نفس الأوردر خلال DUP_GUARD_MS. بيغطي الضغطتين
// المتزامنتين (جهازين) اللي القراءة اللي قبل الكتابة مابتشوفهاش.
// فشل الاستعلام نفسه = fail-open + تحذير (D1 واقعة معناها كمان مفيش سجل
// أصلاً، وحجب التحصيل كله على استعلام حماية أسوأ من تنبيه الموظف).
async function recentPaymentGuard(db, numericId) {
  try {
    const since = new Date(Date.now() - DUP_GUARD_MS).toISOString();
    const row = await db.prepare(`
      SELECT COUNT(*) AS n FROM logs
      WHERE tool = ? AND type = 'payment' AND order_id = ? AND timestamp > ?
        AND json_extract(extra, '$.result') IN ('success','warning')
    `).bind(TOOL_NAME, numericId, since).first();
    return { duplicate: (row?.n || 0) > 0, skipped: false };
  } catch (e) {
    console.warn('recentPaymentGuard failed:', e.message);
    return { duplicate: false, skipped: true };
  }
}

// ─── §PAYMENT::validatePaymentBody ───
// بيرجّع { error } لطلب باظ (→ HTTP 400، مش بيتسجّل)، أو القيم المنضّفة.
const PM_KEYS = ['cash', 'instapay', 'wallet'];
function validatePaymentBody(b) {
  const orderId = String(b?.orderId ?? '').trim();
  if (!/^\d{1,20}$/.test(orderId)) return { error: 'orderId مطلوب (أرقام بس)' };

  const employee = String(b?.employee ?? '').trim();
  if (!employee) return { error: 'employee مطلوب — اسم الموظف اللي بيسجّل' };

  const amountNum = Number(b?.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) return { error: 'amount لازم يكون رقم أكبر من صفر — الأداة مابتسجّلش استرداد' };
  const amountCents = toCents(amountNum);
  if (Math.abs(amountNum * 100 - amountCents) > 0.001) return { error: 'amount بأكتر من خانتين عشرية' };

  const pm = b?.paymentMethods;
  if (!pm || typeof pm !== 'object') return { error: 'paymentMethods مطلوبة (cash · instapay · wallet)' };
  const methods = {};
  let sumCents = 0;
  for (const k of PM_KEYS) {
    const raw = pm[k] === undefined || pm[k] === null || pm[k] === '' ? 0 : Number(pm[k]);
    if (!Number.isFinite(raw) || raw < 0) return { error: `طريقة الدفع ${k} لازم تكون رقم صفر أو أكبر` };
    const c = toCents(raw);
    if (Math.abs(raw * 100 - c) > 0.001) return { error: `طريقة الدفع ${k} بأكتر من خانتين عشرية` };
    methods[k] = c / 100;
    sumCents += c;
  }
  if (Math.abs(sumCents - amountCents) > MONEY_EPS_CENTS) {
    return { error: `مجموع طرق الدفع (${fmtMoney(sumCents)}) ≠ المبلغ (${fmtMoney(amountCents)})` };
  }
  return { orderId, employee, amountCents, methods, orderNameHint: b?.orderName ? String(b.orderName).slice(0, 40) : null };
}

// ─── §PAYMENT::recordPayment ───
// الترتيب مقصود (Step 5A ⑩):
//   ① كل تحقق رخيص قبل أول كتابة على شوبيفاي  ② قراءة جديدة + إعادة الأهلية
//   ③ الفعل (capture)  ④ تحقق بقراءة بعده  ⑤ السجل (آخر حاجة، ومابيوقعش العملية)
// العقد: نتيجة واحدة لكل طلب. HTTP 200 دايمًا للنتايج التشغيلية.
async function recordPayment(env, request, body) {
  const v = validatePaymentBody(body);
  if (v.error) return json({ ok: false, success: false, status: 'error', error: v.error }, 400, request);

  const { orderId, employee, amountCents, methods } = v;
  let logName = v.orderNameHint;   // بيتحدّث باسم الأوردر الحقيقي بعد القراءة

  // ── ② قراءة جديدة وقت الكتابة — مش لقطة الشاشة ──
  // فشل البنية (إعدادات/OAuth/استعلام) قبل أي كتابة: بنسجّله `rejected` (اتوقفت
  // قبل أي محاولة — صف واحد لكل طلب، ⑭) وبعدين بنرمي → HTTP 500 برسالة السبب.
  let token, order;
  try {
    assertEnv(env, 'shopify');
    token = await getAccessToken(env);
    order = await getOrderForPayment(env, token, orderId);
  } catch (e) {
    await safeWriteLog(env.DB, {
      tool: TOOL_NAME, employee, orderId, orderName: logName, type: 'rejected', notes: `اتوقف قبل أي كتابة: ${e.message}`.slice(0, 500),
      extra: { result: 'rejected', stage: 'preflight', actions: [], reasons: ['infra'] },
    });
    throw e;
  }
  if (!order) {
    const msg = `الأوردر ${orderId} مش موجود على شوبيفاي`;
    const { logged, logError } = await safeWriteLog(env.DB, {
      tool: TOOL_NAME, employee, orderId, orderName: logName, type: 'rejected', notes: msg,
      extra: { result: 'rejected', stage: 'lookup', actions: [], reasons: ['not_found'] },
    });
    return json({ success: false, status: 'rejected', blocked: true, notFound: true, error: msg, actions: [], logged, logError }, 200, request);
  }
  logName = order.orderName;

  // ── ① أهلية: S1 = Confirmed · S2 = null · مش ملغي · فيه مستحق ──
  const elig = evaluateEligibility(order);
  if (!elig.eligible) {
    const status = elig.alreadyPaid ? 'already' : 'rejected';
    const msg = elig.alreadyPaid
      ? 'الأوردر ده اتدفع خلاص قبل كده — مفيش حاجة مطلوبة'
      : elig.reasons.map(r => r.text).join(' · ');
    const { logged, logError } = await safeWriteLog(env.DB, {
      tool: TOOL_NAME, employee, orderId, orderName: logName, type: 'rejected', notes: msg,
      extra: { result: status, stage: 'preflight', actions: [], reasons: elig.reasons.map(r => r.code), s1: order.s1, s2: order.s2,
               outstandingBefore: order.outstandingCents / 100, financialStatus: order.financialStatus },
    });
    return json({ success: false, status, blocked: true, error: msg, reasons: elig.reasons, order: publicOrder(order), actions: [], logged, logError }, 200, request);
  }

  // ── ① اتفاق المبلغ: اللي الموظف شافه == المستحق دلوقتي (تحصيل كامل بس) ──
  if (Math.abs(amountCents - order.outstandingCents) > MONEY_EPS_CENTS) {
    const msg = `المبلغ المعروض (${fmtMoney(amountCents)}) ≠ المستحق الحالي على شوبيفاي (${fmtMoney(order.outstandingCents)}) — ` +
                `الأوردر اتغيّر من ساعة ما اتعرض. اعمل بحث تاني قبل التسجيل (الأداة مابتسجّلش تحصيل جزئي)`;
    const { logged, logError } = await safeWriteLog(env.DB, {
      tool: TOOL_NAME, employee, orderId, orderName: logName, type: 'rejected', notes: msg,
      extra: { result: 'rejected', stage: 'preflight', actions: [], reasons: ['amount_mismatch'],
               requestedAmount: amountCents / 100, outstandingBefore: order.outstandingCents / 100 },
    });
    return json({ success: false, status: 'rejected', blocked: true, error: msg, order: publicOrder(order), actions: [], logged, logError }, 200, request);
  }

  // ── ① حارس التكرار ──
  const guard = await recentPaymentGuard(env.DB, orderId);
  if (guard.duplicate) {
    const msg = 'اتسجّل تحصيل على الأوردر ده من أقل من دقيقتين — استنى وراجع تاب السجل قبل ما تعيد';
    const { logged, logError } = await safeWriteLog(env.DB, {
      tool: TOOL_NAME, employee, orderId, orderName: logName, type: 'rejected', notes: msg,
      extra: { result: 'already', stage: 'preflight', actions: [], reasons: ['recent_payment'] },
    });
    return json({ success: false, status: 'already', blocked: true, error: msg, order: publicOrder(order), actions: [], logged, logError }, 200, request);
  }

  // ── ③ الفعل: تسجيل التحصيل على شوبيفاي ──
  const amountStr = fmtMoney(amountCents);
  const actions = [];        // Step 5A ⑤ — بتتملى أول بأول
  const warnings = [];
  if (guard.skipped) warnings.push('حارس التكرار ما اشتغلش (فشل استعلام D1) — اتأكد إن مفيش تحصيل تاني على الأوردر ده');

  const cap = await createCapture(env, token, orderId, amountStr, order.currency);

  if (!cap.success && !cap.uncertain) {
    // شوبيفاي ردّت ورفضت صراحةً → error (حاولنا وفشلنا). valueAfter = null.
    const { logged, logError } = await safeWriteLog(env.DB, {
      tool: TOOL_NAME, employee, orderId, orderName: logName, type: 'payment', valueBefore: order.outstandingCents / 100, valueAfter: null,
      notes: `فشل تسجيل التحصيل: ${cap.error}`.slice(0, 500),
      extra: payExtra({ result: 'error', stage: 'write', actions, methods, order, amountCents, error: cap.error }),
    });
    return json({ success: false, status: 'error', error: cap.error, actions, logged, logError, orderId, orderNumber: order.orderName }, 200, request);
  }

  let transactionId = cap.transactionId || null;
  if (cap.success) actions.push(`تحصيل ${amountStr} ${order.currency} على شوبيفاي (transaction ${transactionId})`);
  else warnings.push(cap.error);

  // ── ④ تحقق بقراءة بعد الفعل ──
  const after = await readOutstandingAfter(env, token, orderId);
  let status, applied;
  if (cap.success) {
    if (!after) {
      status = 'warning'; applied = true;
      warnings.push('التحصيل اتسجّل (شوبيفاي رجّعت transaction) بس ما قدرناش نقرا حالة الأوردر بعده — راجعه على شوبيفاي');
    } else if (after.outstandingCents > MONEY_EPS_CENTS) {
      status = 'warning'; applied = true;
      warnings.push(`التحصيل اتسجّل بس شوبيفاي لسه بتعرض متبقي ${fmtMoney(after.outstandingCents)} — راجع الأوردر`);
    } else {
      status = 'success'; applied = true;
      actions.push(`اتأكدنا من شوبيفاي: المتبقي ${fmtMoney(Math.max(after.outstandingCents, 0))} (${after.financialStatus || '—'})`);
    }
  } else {
    // uncertain: القراءة هي اللي بتحسم
    if (after && after.outstandingCents <= MONEY_EPS_CENTS) {
      status = 'warning'; applied = true;
      actions.push('التحصيل ظهر على شوبيفاي رغم إن الرد ما وصلش — الأوردر دلوقتي مدفوع');
      warnings.push('الرد من شوبيفاي ما وصلش لكن القراءة بعده أكدت إن التحصيل حصل');
    } else {
      status = 'warning'; applied = false;
      warnings.push('ما قدرناش نتأكد إن التحصيل اتسجّل — ⛔ متعيدش المحاولة قبل ما تراجع الأوردر على شوبيفاي وتاب السجل');
    }
  }

  // ── ⑤ السجل — valueAfter بس لما نكون متأكدين إن الفلوس اتسجّلت ──
  const { logged, logError } = await safeWriteLog(env.DB, {
    tool: TOOL_NAME, employee, orderId, orderName: logName, type: 'payment',
    valueBefore: order.outstandingCents / 100,
    valueAfter:  applied ? amountCents / 100 : null,
    notes: warnings.length ? `⚠ ${warnings.join(' | ')}`.slice(0, 500) : null,
    extra: payExtra({ result: status, stage: 'write', actions, methods, order, amountCents, transactionId, after,
                      uncertain: !cap.success, warnings }),
  });

  return json({
    success: applied, status, actions, warnings, logged, logError,
    orderId, orderNumber: order.orderName, transactionId,
    amount: amountStr, currency: order.currency,
    outstandingAfter: after ? fmtMoney(Math.max(after.outstandingCents, 0)) : null,
    financialStatusAfter: after?.financialStatus || null,
    verified: !!after,
    ...(warnings.length ? { warning: warnings.join(' | ') } : {}),
  }, 200, request);
}

// ─── §PAYMENT::payExtra ───
// عقد قراءة: الواجهة (تاب السجل) بتقرا result · actions · paymentMethods · s1 · s2
// · outstandingBefore · transactionId · warnings من هنا. تغيير اسم أي مفتاح =
// خلية فاضية بلا أي خطأ. غيّر في الاتنين معًا.
function payExtra({ result, stage, actions, methods, order, amountCents, transactionId = null, after = null, uncertain = false, warnings = [], error = null }) {
  return {
    result, stage,
    actions: Array.isArray(actions) ? actions : [],
    paymentMethods: methods,           // حصة الأوردر ده من طرق الدفع (مجموعها == amount)
    pmScope: 'order',
    amount: amountCents / 100,
    currency: order.currency,
    outstandingBefore: order.outstandingCents / 100,
    outstandingAfter:  after ? Math.max(after.outstandingCents, 0) / 100 : null,
    financialStatusBefore: order.financialStatus,
    financialStatusAfter:  after?.financialStatus || null,
    s1: order.s1, s2: order.s2, courier: order.courier,
    preRegistered: !!order.preRegistered,
    transactionId,
    uncertain,
    warnings: warnings.length ? warnings : undefined,
    error: error || undefined,
    stagePhase: 'pre_shipping',
  };
}

// ══════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    // preflight — أولاً دايماً
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: getCORS(request) });

    // 🔴 حارس السر الغايب — قبل فحص الـ auth (Step 8). من غيره `Bearer undefined` بيعدّي.
    if (typeof env.WORKER_SECRET !== 'string' || !env.WORKER_SECRET.trim())
      return json({ ok: false, error: 'WORKER_SECRET غير مضبوط على الـ Worker', step: 'env' }, 500, request);

    // WORKER_SECRET — ثانياً دايماً
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`) return json({ error: 'Unauthorized' }, 401, request);

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {
      if (!action) return json({ error: 'action is required' }, 400, request);

      // ─── §AUTH ──────────────────────────────────────────────────
      // ═══════════════════════════════════════════════════════════════
      // AUTH ENDPOINTS — copy verbatim (references/auth-endpoints.md)
      // ═══════════════════════════════════════════════════════════════

      // ── check_employee — GET ──
      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result }, 200, request);
      }

      // ── register_pin — POST (PIN in body — GET is FORBIDDEN) ──
      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }

      // ── verify_employee — POST (PIN in body — GET is FORBIDDEN) ──
      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin, appId } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);

        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);

        // الدخول نفسه نجح — فشل D1 بعد كده logged:false مش 500 (Step 5A ⑦)
        let logged = true;
        try {
          await writeLog(env.DB, {
            tool:     resolveAuthTool(appId),
            type:     'login',
            employee: username,
            notes:    `دخول: ${displayName}`,
          });
        } catch (e) {
          logged = false;
        }
        return json({ ok: true, displayName, logged }, 200, request);
      }

      // ── log_logout — GET ──
      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        const appId    = url.searchParams.get('appId');
        let logged = true;
        if (username) {
          try {
            await writeLog(env.DB, {
              tool:     resolveAuthTool(appId),
              type:     'logout',
              employee: username,
              notes:    `خروج: ${username.replace(/_/g, ' ')}`,
            });
          } catch (e) {
            logged = false;
          }
        }
        return json({ ok: true, logged }, 200, request);
      }

      // ── get_employees — GET (for HTML dropdown) ──
      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      // ─── §PAYMENT ───────────────────────────────────────────────
      // ── lookup_order — GET · قراءة بس (صفر كتابة على شوبيفاي أو D1) ──
      // kind=name  → رقم الأوردر (١–٧ أرقام)  ·  kind=id → Order ID (١٣–١٥ رقم)
      // العقد: found:false = الأوردر مش موجود فعلاً. أي فشل استعلام = HTTP 500
      // برسالة — «تعذّر الاستعلام» ≠ «غير موجود» (Step 5A ⑥).
      if (action === 'lookup_order') {
        const kind  = url.searchParams.get('kind');
        const value = String(url.searchParams.get('value') || '').trim().replace(/^#/, '');
        if (kind !== 'name' && kind !== 'id') return json({ ok: false, error: 'kind لازم يكون name أو id' }, 400, request);
        if (!/^\d+$/.test(value)) return json({ ok: false, error: 'value لازم يكون أرقام بس' }, 400, request);
        if (kind === 'name' && (value.length < 1 || value.length > 7))
          return json({ ok: false, error: 'رقم الأوردر لازم يكون من ١ لـ ٧ أرقام' }, 400, request);
        if (kind === 'id' && (value.length < 13 || value.length > 15))
          return json({ ok: false, error: 'Order ID لازم يكون من ١٣ لـ ١٥ رقم' }, 400, request);

        assertEnv(env, 'shopify');
        const token = await getAccessToken(env);
        const numericId = kind === 'name' ? await getOrderIdByName(env, token, value) : value;
        const order = numericId ? await getOrderForPayment(env, token, numericId) : null;
        if (!order) return json({ ok: true, found: false, kind, value }, 200, request);

        const elig = evaluateEligibility(order);
        return json({
          ok: true, found: true,
          orderId: order.orderId, orderNumber: order.orderName,
          eligible: elig.eligible, alreadyPaid: elig.alreadyPaid, reasons: elig.reasons,
          order: publicOrder(order),
        }, 200, request);
      }

      // ── record_payment — POST · الكتابة الوحيدة على شوبيفاي ──
      // عقد النتيجة: success | warning | error | already | rejected (HTTP 200)،
      // طلب باظ = 400 (مش بيتسجّل). التفاصيل في §PAYMENT::recordPayment.
      if (action === 'record_payment') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const body = await request.json().catch(() => null);
        if (!body) return json({ ok: false, success: false, status: 'error', error: 'الجسم لازم يكون JSON' }, 400, request);
        return await recordPayment(env, request, body);
      }
      // ──────────────────────────────────────────────────────────────

      // ─── §DIAG ──────────────────────────────────────────────────
      if (action === 'get_config') {
        return json({ ok: true, version: WORKER_VERSION, tool: TOOL_NAME }, 200, request);
      }

      // فحص ذاتي — صفر كتابة. ⛔ ممنوع يرجّع قيمة أي سر (أسماء وأطوال بس).
      if (action === 'diag') {
        const checks = [];
        const add = (ok, label, detail) => checks.push({ ok: !!ok, label, detail });

        add(typeof env.WORKER_SECRET === 'string' && env.WORKER_SECRET.trim().length > 0,
            'WORKER_SECRET', 'مضبوط (الطول ' + (env.WORKER_SECRET ? String(env.WORKER_SECRET).length : 0) + ')');
        add(!!env.SHOP_DOMAIN, 'SHOP_DOMAIN (var)', env.SHOP_DOMAIN || 'غايب — راجع [vars] في wrangler.toml');
        add(!!env.CLIENT_ID && !!env.CLIENT_SECRET, 'CLIENT_ID / CLIENT_SECRET',
            `CLIENT_ID ${env.CLIENT_ID ? 'مضبوط' : 'غايب'} · CLIENT_SECRET ${env.CLIENT_SECRET ? 'مضبوط' : 'غايب'}`);
        add(Object.keys(env).length > 0, 'أسماء الـ bindings والمتغيرات',
            Object.keys(env).map(k => `${k}(${typeof env[k] === 'string' ? env[k].length : typeof env[k]})`).join(' · '));

        // D1 — قراءة بس
        try {
          const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM employees WHERE is_active = 1').first();
          add(true, 'D1 (DB)', `شغّال — ${row?.n ?? 0} موظف نشط`);
        } catch (e) { add(false, 'D1 (DB)', 'FAILED: ' + e.message); }

        // جدول التنبيهات المشترك (الطبقة ٥)
        try {
          await env.DB.prepare('SELECT 1 FROM log_value_alerts LIMIT 1').first();
          add(true, 'log_value_alerts', 'موجود');
        } catch (e) { add(false, 'log_value_alerts', 'مش موجود — الحارس الديناميكي هيسكت عن القيم غير المسجّلة: ' + e.message); }

        // شوبيفاي: OAuth + الصلاحيات + التكلفة (بندين منفصلين — Step 5A ⑮)
        const costLog = [];
        try {
          const token = await getAccessToken(env);
          add(true, 'Shopify OAuth', 'التوكن اتجاب');
          const data = await shopifyGQL(env, token,
            `{ currentAppInstallation { accessScopes { handle } } }`, {}, 'diag:scopes', costLog);
          const scopes = (data?.data?.currentAppInstallation?.accessScopes || []).map(s => s.handle);
          for (const need of ['read_orders', 'write_orders']) {
            add(scopes.includes(need), `صلاحية ${need}`, scopes.includes(need) ? 'موجودة' : 'ناقصة — التسجيل هيفشل (REST transactions محتاجة write_orders)');
          }
          // 🟡 استشاري: من غير read_all_orders شوبيفاي بتخفي أي أوردر أقدم من ٦٠ يوم **من غير خطأ** —
          //    فالبحث عن أوردر قديم بيرجّع «مش موجود» (رسالة كاذبة). مش بتوقّف الأداة، فمش داخلة في `ok` العام.
          const hasAll = scopes.includes('read_all_orders');
          checks.push({ ok: hasAll, advisory: true, label: 'صلاحية read_all_orders (استشاري)',
            detail: hasAll ? 'موجودة' : 'ناقصة — أي أوردر أقدم من ٦٠ يوم هيرجع «مش موجود» بدل خطأ صلاحية' });
          add(true, 'كل الصلاحيات (معلومة)', scopes.join(' · ') || '—');
        } catch (e) { add(false, 'Shopify', 'FAILED: ' + e.message); }

        if (_lastThrottle) add(true, 'throttleStatus (الرصيد المتبقي)',
          `available ${_lastThrottle.currentlyAvailable} / ${_lastThrottle.maximumAvailable} · restore ${_lastThrottle.restoreRate}/s`);
        if (costLog.length) add(true, 'actualQueryCost (تكلفة النداء)',
          costLog.map(c => `${c.op}: requested ${c.requested} · actual ${c.actual}`).join(' | '));

        add(true, 'CORS', 'ALLOWED_ORIGINS: ' + ALLOWED_ORIGINS.join(' , '));
        add(true, 'قاعدة الأهلية', `S1 = ${S1_REQUIRED} · S2 = فاضي · تحصيل كامل بس · بدون استرداد`);
        add(true, 'نافذة حارس التكرار', `${DUP_GUARD_MS / 1000} ثانية`);

        return json({ ok: checks.filter(c => !c.advisory).every(c => c.ok), version: WORKER_VERSION, checks }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      // ─── §LOG-ENDPOINTS ─────────────────────────────────────────
      // get_logs — server-side filtering + pagination (100/page)
      if (action === 'get_logs') {
        const p = logParamsFrom(url, TOOL_NAME);
        // 🔴 parseInt('abc') → NaN وبيوصل لـ D1 كـ bind ويرجّع خطأ غامض — الحراسة إلزامية
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '100', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',   10);
        const limit  = Number.isFinite(limitRaw)  ? Math.min(Math.max(limitRaw, 1), 100) : 100;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        const sortBy  = url.searchParams.get('sortBy');
        const sortDir = url.searchParams.get('sortDir');
        const entries = await getLogs(env.DB, { ...p, limit, offset, sortBy, sortDir });
        return json({ ok: true, entries }, 200, request);
      }

      // get_logs_count — total for pagination + «النتائج»
      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, total }, 200, request);
      }

      // get_logs_export — الصفوف **والحقيقة** مع بعض (Standards #30)
      if (action === 'get_logs_export') {
        const p = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([
          getLogsExport(env.DB, p),
          getLogsCount(env.DB, p),          // العدّ الحقيقي بنفس الفلاتر بالظبط
        ]);
        return json({ ok: true, entries, cap: LOG_EXPORT_MAX, total, truncated: total > LOG_EXPORT_MAX }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      return json({ error: 'Unknown action' }, 404, request);

    } catch (err) {
      console.error(err);
      return json({ ok: false, error: err.message }, 500, request);
    }
  },
};
