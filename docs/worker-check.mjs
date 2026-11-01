#!/usr/bin/env node
/**
 * docs/worker-check.mjs — فحص سلوك الـ Worker على شوبيفاي وD1 وهميين.
 * الاستخدام:  node docs/worker-check.mjs        (بلا أي dependency — node 18+)
 *
 * بيشغّل index.js الحقيقي (مش نسخة) ويستبدل fetch بشوبيفاي وهمية و D1 بـ SQLite
 * وهمي في الذاكرة. اللي بيقيسه: الأهلية (S1/S2) · عدم وجود مسار استرداد ·
 * اتفاق المبلغ · طرق الدفع · التحقق بعد الكتابة · حارس التكرار · الحالات الأربع
 * في الرد وفي D1 · عقد السجل.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗'} ${name}${!c && extra ? '  → ' + extra : ''}`); };
const sec = (t) => console.log(`\n── ${t}`);

const worker = (await import(pathToFileURL(resolve('index.js')).href)).default;
const { makeShopify, baseOrder } = await import(pathToFileURL(resolve('docs/fakes.mjs')).href);

// ── D1 وهمي (مجموعة صفوف + دعم الاستعلامات اللي الـ Worker بيعملها) ─────────
function makeDB() {
  const logs = [];
  const employees = [{ username: 'Test_User', display_name: 'Test User', pin: '1234', is_active: 1 }];
  const api = {
    logs, employees,
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      const run = (binds) => ({
        async first() {
          if (/FROM employees WHERE username = \? AND pin = \?/.test(q)) return employees.find(e => e.username === binds[0] && e.pin === binds[1]) || null;
          if (/SELECT is_active, pin FROM employees/.test(q)) return employees.find(e => e.username === binds[0]) || null;
          if (/SELECT COUNT\(\*\) AS n FROM employees/.test(q)) return { n: employees.length };
          if (/SELECT 1 FROM log_value_alerts/.test(q)) return { 1: 1 };
          if (/SELECT COUNT\(\*\) AS n FROM logs/.test(q)) {           // حارس التكرار
            const [tool, orderId, since] = binds;
            return { n: logs.filter(l => l.tool === tool && l.type === 'payment' && l.order_id === orderId && l.timestamp > since &&
              ['success', 'warning'].includes(JSON.parse(l.extra || '{}').result)).length };
          }
          if (/SELECT COUNT\(\*\) as total FROM logs/.test(q)) return { total: logs.length };
          throw new Error('fake D1: unsupported first(): ' + q);
        },
        async all() {
          if (/FROM employees WHERE is_active = 1/.test(q)) return { results: employees };
          if (/SELECT \* FROM logs/.test(q)) return { results: logs.slice().reverse() };
          throw new Error('fake D1: unsupported all(): ' + q);
        },
        async run() {
          if (/INSERT INTO logs/.test(q)) {
            const [timestamp, tool, type, employee, order_id, order_name, sku, product_title, delta, value_before, value_after, notes, extra] = binds;
            logs.push({ timestamp, tool, type, employee, order_id, order_name, value_before, value_after, notes, extra });
            return {};
          }
          if (/INSERT INTO log_value_alerts/.test(q)) { api.alerts = (api.alerts || 0) + 1; return {}; }
          if (/UPDATE employees SET last_login/.test(q)) return {};
          if (/UPDATE employees SET pin/.test(q)) return {};
          throw new Error('fake D1: unsupported run(): ' + q);
        },
      });
      return { bind: (...b) => run(b), ...run([]) };
    },
  };
  return api;
}

const mkEnv = (db) => ({ DB: db, WORKER_SECRET: 's3cret', SHOP_DOMAIN: 'x.myshopify.com', CLIENT_ID: 'id', CLIENT_SECRET: 'sec' });
const H = { Authorization: 'Bearer s3cret', 'Content-Type': 'application/json', Origin: 'https://ecommoda-dev.github.io' };
const call = async (env, action, { method = 'GET', params = {}, body } = {}) => {
  const u = new URL('https://w.test/'); u.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await worker.fetch(new Request(u, { method, headers: H, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: await res.json(), headers: res.headers };
};
const payBody = (over = {}) => ({ orderId: '6959895839042', orderName: '#55001', amount: '1425.00', employee: 'Test_User', paymentMethods: { cash: 1000, instapay: 425, wallet: 0 }, ...over });

// ═══════════════════════════════════════════════════════
sec('① أمان الدخول');
{
  const db = makeDB(); const env = mkEnv(db); makeShopify({});
  let r = await worker.fetch(new Request('https://w.test/?action=get_config', { headers: { Authorization: 'Bearer wrong' } }), env);
  ok(r.status === 401, 'سر غلط → 401');
  r = await worker.fetch(new Request('https://w.test/?action=get_config', { headers: { Authorization: 'Bearer undefined' } }), { ...env, WORKER_SECRET: undefined });
  ok(r.status === 500, 'WORKER_SECRET غايب → 500 مش "Bearer undefined" مقبول');
  r = await worker.fetch(new Request('https://w.test/?action=get_config', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
  ok(r.headers.get('Access-Control-Allow-Origin') === 'https://ecommoda-dev.github.io', 'CORS صارم: origin غريب بيرجع للـ fallback');
  const c = await call(env, 'get_config'); ok(c.body.version === '1.0.0', 'get_config بيرجّع النسخة');
  const v = await call(env, 'verify_employee', { method: 'POST', body: { username: 'Test_User', pin: '1234' } });
  ok(v.body.ok && v.body.displayName === 'Test User', 'verify_employee يشتغل'); ok(db.logs.at(-1)?.type === 'login' && db.logs.at(-1).tool === 'advanced_order_payment', 'صف login تحت tool الأداة');
  const g = await call(env, 'verify_employee', { method: 'GET', params: { username: 'Test_User', pin: '1234' } });
  ok(g.status === 405, 'PIN مابيقبلش GET');
}

sec('② lookup_order — الأهلية (S1 = Confirmed · S2 = فاضي)');
{
  const orders = {
    A: baseOrder({ id: '6959895839042', name: '#55001' }),
    B: baseOrder({ id: '6959895839043', name: '#55002', s1: 'Ready' }),
    C: baseOrder({ id: '6959895839044', name: '#55003', s2: 'Confirmed + EXCHANGE' }),
    D: baseOrder({ id: '6959895839045', name: '#55004', s1: 'Ready', s2: 'Confirmed + RETURN' }),
    E: baseOrder({ id: '6959895839046', name: '#55005', cancelledAt: '2026-10-30T10:00:00Z' }),
    F: baseOrder({ id: '6959895839047', name: '#55006', outstanding: '0.00', financialStatus: 'PAID' }),
    G: baseOrder({ id: '6959895839048', name: '#55007', outstanding: '-200.00', financialStatus: 'PARTIALLY_REFUNDED' }),
    H: baseOrder({ id: '6959895839049', name: '#55008', s1: null }),
    I: baseOrder({ id: '6959895839050', name: '#55009', canMarkAsPaid: false, financialStatus: 'VOIDED' }),
  };
  const byId = Object.fromEntries(Object.values(orders).map(o => [o.id, o]));
  const db = makeDB(); const env = mkEnv(db); makeShopify(byId);
  const L = (n) => call(env, 'lookup_order', { params: { kind: 'name', value: n } });

  let r = await L('55001'); ok(r.body.found && r.body.eligible && r.body.reasons.length === 0, 'S1=Confirmed + S2=null → مؤهل');
  ok(r.body.order.outstanding === '1425.00' && r.body.orderNumber === '#55001' && r.body.orderId === '6959895839042', 'المستحق والرقم والـ orderId الرقمي راجعين');
  r = await L('55002'); ok(!r.body.eligible && r.body.reasons.some(x => x.code === 's1' && x.text.includes('Ready')), 'S1=Ready → مرفوض وبيقول القيمة الحالية');
  r = await L('55003'); ok(!r.body.eligible && r.body.reasons.some(x => x.code === 's2' && x.text.includes('Confirmed + EXCHANGE')), 'S1=Confirmed + S2=EXCHANGE → مرفوض (S2 لازم null)');
  r = await L('55004'); ok(r.body.reasons.map(x => x.code).join() === 's1,s2', 'S1 وS2 غلط معًا → السببين مع بعض');
  r = await L('55005'); ok(!r.body.eligible && r.body.reasons.some(x => x.code === 'cancelled'), 'ملغي → مرفوض');
  r = await L('55006'); ok(!r.body.eligible && r.body.alreadyPaid === true, 'مدفوع بالكامل → alreadyPaid (مش فشل)');
  r = await L('55007'); ok(!r.body.eligible && r.body.reasons.some(x => x.code === 'refund_due'), 'مستحق استرداد → مرفوض (مفيش استرداد)');
  r = await L('55008'); ok(!r.body.eligible && r.body.reasons[0].text.includes('فارغ'), 'S1 فاضي → مرفوض');
  r = await L('55009'); ok(!r.body.eligible && r.body.reasons.some(x => x.code === 'cannot_mark_paid'), 'canMarkAsPaid=false → مرفوض');
  r = await L('5500'); ok(r.body.found === false, 'بحث بالاسم بيطابق حرفيًا: #5500 ≠ #55001 (شوبيفاي رجّعت قريب) → found:false');
  r = await call(env, 'lookup_order', { params: { kind: 'id', value: '6959895839042' } }); ok(r.body.found && r.body.orderNumber === '#55001', 'بحث بالـ Order ID');
  r = await call(env, 'lookup_order', { params: { kind: 'id', value: '6959895839999' } }); ok(r.body.found === false, 'Order ID مش موجود → found:false');
  r = await call(env, 'lookup_order', { params: { kind: 'id', value: '12345' } }); ok(r.status === 400, 'Order ID بطول غلط → 400');
  r = await call(env, 'lookup_order', { params: { kind: 'name', value: '12345678' } }); ok(r.status === 400, 'رقم أوردر ٨ أرقام → 400');
  r = await call(env, 'lookup_order', { params: { kind: 'name', value: 'abc' } }); ok(r.status === 400, 'حروف → 400');
  ok(db.logs.filter(l => l.type !== 'login').length === 0, 'lookup_order قراءة بس — صفر صفوف في D1');
}

sec('③ record_payment — المسار الناجح');
{
  const o = { '6959895839042': baseOrder() };
  const db = makeDB(); const env = mkEnv(db); const sh = makeShopify(o);
  const r = await call(env, 'record_payment', { method: 'POST', body: payBody() });
  ok(r.status === 200 && r.body.status === 'success' && r.body.success === true, 'تحصيل ناجح → success');
  ok(sh.calls.captures.length === 1, 'transaction واحدة بس على شوبيفاي');
  const t = sh.calls.captures[0];
  ok(t.kind === 'capture' && t.gateway === 'manual' && t.amount === '1425.00' && t.currency === 'EGP', 'kind=capture · gateway=manual · amount بكسرين · EGP');
  ok(r.body.verified === true && r.body.outstandingAfter === '0.00', 'اتأكد بقراءة بعد الكتابة (المتبقي 0)');
  const row = db.logs.at(-1); const ex = JSON.parse(row.extra);
  ok(row.type === 'payment' && row.tool === 'advanced_order_payment' && row.employee === 'Test_User', 'صف payment تحت tool الأداة وباسم الموظف');
  ok(row.value_after === 1425 && row.value_before === 1425 && row.order_id === '6959895839042' && row.order_name === '#55001', 'valueAfter = المبلغ · الـ order_id الرقمي مخزّن');
  ok(ex.result === 'success' && ex.stage === 'write' && ex.pmScope === 'order', 'extra.result/stage/pmScope');
  ok(ex.paymentMethods.cash === 1000 && ex.paymentMethods.instapay === 425 && ex.paymentMethods.wallet === 0, 'طرق الدفع محفوظة على الصف');
  ok(ex.s1 === 'Confirmed' && ex.s2 === null && ex.outstandingBefore === 1425 && ex.outstandingAfter === 0, 'S1/S2 والمستحق قبل وبعد محفوظين');
  ok(r.body.logged === true, 'logged:true');
  ok(!db.alerts, 'مفيش تنبيه قيمة غير مسجّلة (الطبقة ٥ ساكتة)');
  // ضغطة تانية فورًا
  const r2 = await call(env, 'record_payment', { method: 'POST', body: payBody() });
  ok(r2.body.status === 'already' && sh.calls.captures.length === 1, 'ضغطة تانية → already ومفيش transaction تانية');
  const row2 = db.logs.at(-1); ok(row2.type === 'rejected' && JSON.parse(row2.extra).result === 'already', 'الرفض مسجّل rejected/already (صف لكل طلب)');
}

sec('④ record_payment — الرفض قبل أي كتابة');
{
  const mk = async (orderOver, bodyOver = {}) => {
    const o = { '6959895839042': baseOrder(orderOver) };
    const db = makeDB(); const env = mkEnv(db); const sh = makeShopify(o);
    const r = await call(env, 'record_payment', { method: 'POST', body: payBody(bodyOver) });
    return { r, db, sh };
  };
  let x = await mk({ s1: 'Ready' });
  ok(x.r.body.status === 'rejected' && x.r.body.blocked && x.sh.calls.captures.length === 0, 'S1 غلط وقت الكتابة → rejected وصفر transactions');
  ok(x.r.body.error.includes('S1') && x.db.logs.at(-1).type === 'rejected', 'السبب بقيمته + صف rejected');
  x = await mk({ s2: 'Confirmed + EXCHANGE' });
  ok(x.r.body.status === 'rejected' && x.sh.calls.captures.length === 0, 'S2 مش فاضي → rejected وصفر transactions');
  x = await mk({ cancelledAt: '2026-10-30T10:00:00Z' }); ok(x.r.body.status === 'rejected' && x.sh.calls.captures.length === 0, 'ملغي → rejected');
  x = await mk({ outstanding: '-100.00' }); ok(x.r.body.status === 'rejected' && x.sh.calls.captures.length === 0, 'متبقي سالب → rejected (مفيش استرداد)');
  x = await mk({ outstanding: '0.00', financialStatus: 'PAID' }); ok(x.r.body.status === 'already' && x.sh.calls.captures.length === 0, 'مدفوع خلاص → already (محايد مش فشل)');
  x = await mk({ outstanding: '1500.00' }); ok(x.r.body.status === 'rejected' && x.r.body.error.includes('1500.00') && x.sh.calls.captures.length === 0, 'المستحق اتغيّر (1425 ≠ 1500) → rejected');
  x = await mk({}, { amount: '700.00', paymentMethods: { cash: 700, instapay: 0, wallet: 0 } }); ok(x.r.body.status === 'rejected' && x.sh.calls.captures.length === 0, 'تحصيل جزئي مرفوض');
  x = await mk({ id: '6959895839042' }, { orderId: '6959895839999' }); ok(x.r.body.status === 'rejected' && x.r.body.notFound && x.sh.calls.captures.length === 0, 'أوردر مش موجود → rejected');
}

sec('⑤ طلبات باظة → 400 (مش بتتسجّل ولا بتلمس شوبيفاي)');
{
  const o = { '6959895839042': baseOrder() };
  const db = makeDB(); const env = mkEnv(db); const sh = makeShopify(o);
  const bad = async (name, over) => { const r = await call(env, 'record_payment', { method: 'POST', body: payBody(over) }); ok(r.status === 400 && sh.calls.captures.length === 0, name, r.status + ' ' + (r.body.error || '')); };
  await bad('مبلغ سالب (استرداد) → 400', { amount: '-100', paymentMethods: { cash: -100, instapay: 0, wallet: 0 } });
  await bad('مبلغ صفر → 400', { amount: '0', paymentMethods: { cash: 0, instapay: 0, wallet: 0 } });
  await bad('مبلغ مش رقم → 400', { amount: 'abc' });
  await bad('طرق دفع مجموعها ≠ المبلغ → 400', { paymentMethods: { cash: 1000, instapay: 0, wallet: 0 } });
  await bad('طريقة دفع سالبة → 400', { paymentMethods: { cash: 1925, instapay: -500, wallet: 0 } });
  await bad('طرق الدفع ناقصة → 400', { paymentMethods: undefined });
  await bad('موظف ناقص → 400', { employee: '' });
  await bad('orderId مش أرقام → 400', { orderId: 'abc' });
  await bad('خانات عشرية زيادة → 400', { amount: '1425.005' });
  ok(db.logs.filter(l => l.type !== 'login').length === 0, 'صفر صفوف في D1 للطلبات الباظة');
}

sec('⑥ شوبيفاي بترفض / مش متأكدين / التحقق بيفشل');
{
  // رفض صريح
  let o = { '6959895839042': baseOrder() }; let db = makeDB(); let env = mkEnv(db); let sh = makeShopify(o);
  sh.state.failCapture = { base: ['Cannot capture'] };
  let r = await call(env, 'record_payment', { method: 'POST', body: payBody() });
  ok(r.body.status === 'error' && r.body.success === false && r.body.error.includes('Cannot capture'), 'شوبيفاي رفضت → error بالسبب');
  let row = db.logs.at(-1); let ex = JSON.parse(row.extra);
  ok(row.type === 'payment' && ex.result === 'error' && row.value_after === null, 'صف payment/error وvalueAfter = null (مادخلش أي مجموع)');

  // انقطاع اتصال والتحصيل ما اتطبقش
  o = { '6959895839042': baseOrder() }; db = makeDB(); env = mkEnv(db); sh = makeShopify(o);
  sh.state.uncertainCapture = true;
  r = await call(env, 'record_payment', { method: 'POST', body: payBody() });
  ok(r.body.status === 'warning' && r.body.success === false && r.body.warning.includes('متعيدش'), 'انقطاع + المتبقي لسه → warning «متعيدش المحاولة» (مش error ومش success)');
  row = db.logs.at(-1); ok(JSON.parse(row.extra).uncertain === true && row.value_after === null, 'مش متأكدين → valueAfter = null');
  r = await call(env, 'record_payment', { method: 'POST', body: payBody() });
  ok(r.body.status === 'already' && sh.calls.captures.length === 1, 'إعادة محاولة فورية بعد «مش متأكدين» → محجوبة (حارس التكرار)');

  // انقطاع بس التحصيل اتطبق فعلاً
  o = { '6959895839042': baseOrder() }; db = makeDB(); env = mkEnv(db); sh = makeShopify(o);
  sh.state.uncertainCapture = true; sh.state.captureAppliesOnUncertain = true;
  r = await call(env, 'record_payment', { method: 'POST', body: payBody() });
  ok(r.body.status === 'warning' && r.body.success === true && r.body.verified === true, 'انقطع بس القراءة أكدت إنه اتطبق → warning لكن success:true');
  ok(db.logs.at(-1).value_after === 1425, 'اتسجّل valueAfter لأن القراءة أكدت');

  // التحقق بعد الكتابة فشل
  o = { '6959895839042': baseOrder() }; db = makeDB(); env = mkEnv(db); sh = makeShopify(o);
  sh.state.verifyFails = true;
  r = await call(env, 'record_payment', { method: 'POST', body: payBody() });
  ok(r.body.status === 'warning' && r.body.verified === false && r.body.success === true, 'القراءة بعد الكتابة فشلت → warning (التحصيل اتسجّل بس مش متأكدين)');
  ok(db.logs.at(-1).value_after === 1425, 'اتسجّل valueAfter لأن شوبيفاي رجّعت transaction id');
}

sec('⑦ D1 واقعة بعد التحصيل (Step 5A ⑦)');
{
  const o = { '6959895839042': baseOrder() }; const db = makeDB(); const env = mkEnv(db); const sh = makeShopify(o);
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => { if (/INSERT INTO logs/.test(sql)) throw new Error('D1 down'); return realPrepare(sql); };
  const r = await call(env, 'record_payment', { method: 'POST', body: payBody() });
  ok(r.status === 200 && r.body.status === 'success' && r.body.logged === false && r.body.logError, 'D1 وقعت بعد التحصيل → success + logged:false (مش 500)');
  ok(sh.calls.captures.length === 1, 'التحصيل حصل مرة واحدة');
}

sec('⑧ خروج شوبيفاي / بنية');
{
  const db = makeDB(); const env = mkEnv(db); makeShopify({});
  const r = await call(env, 'record_payment', { method: 'POST', body: payBody() , });
  ok(r.body.status === 'rejected' && r.body.notFound, 'أوردر مش موجود (من غير أي أوردر وهمي)');
  const env2 = { ...env, CLIENT_SECRET: undefined };
  const r2 = await call(env2, 'record_payment', { method: 'POST', body: payBody() });
  ok(r2.status === 500 && r2.body.error.includes('CLIENT_SECRET'), 'متغير ناقص → 500 برسالة باسمه');
  ok(db.logs.at(-1).type === 'rejected' && JSON.parse(db.logs.at(-1).extra).reasons[0] === 'infra', 'وفشل البنية متسجّل rejected/infra');
  const d = await call(env, 'diag'); ok(Array.isArray(d.body.checks) && d.body.checks.every(c => 'ok' in c && 'label' in c), 'diag.checks مصفوفة [{ok,label,detail}]');
  ok(d.body.checks.some(c => /throttleStatus/.test(c.label)) && d.body.checks.some(c => /actualQueryCost/.test(c.label)), 'diag بيعرض throttleStatus وactualQueryCost كبندين منفصلين');
  ok(!JSON.stringify(d.body).includes('s3cret') && !JSON.stringify(d.body).includes('"sec"'), 'diag مابيكشفش أي قيمة سر');
  const u = await call(env, 'refund', { method: 'POST', body: {} }); ok(u.status === 404, 'action اسمه refund مش موجود → 404 (مفيش استرداد)');
  const code = readFileSync('index.js', 'utf8');
  ok(!/refundCreate|action === 'refund'|createRefund/.test(code), 'مفيش كود استرداد في index.js');
  ok(!/CAIRO_OFFSET|3 \* 3600 \* 1000/.test(code), 'مفيش إزاحة توقيت مكتوبة ثابت');
}

sec('⑨ تاب السجل — فلاتر وعد وتصدير');
{
  const db = makeDB(); const env = mkEnv(db); makeShopify({});
  const g = await call(env, 'get_logs', { params: { limit: 'abc', offset: '-5', sortBy: 'amount; DROP TABLE logs', sortDir: 'asc' } });
  ok(g.status === 200, 'limit/offset/sortBy غلط ما بيوقعوش الـ endpoint (حراسة + قايمة بيضاء)');
  const c = await call(env, 'get_logs_count', { params: { results: 'success,warning', employees: 'Test_User', dateFrom: '2026-11-01' } }); ok(c.status === 200, 'get_logs_count بالفلاتر الجديدة');
  const e = await call(env, 'get_logs_export'); ok('cap' in e.body && 'total' in e.body && 'truncated' in e.body && e.body.cap === 2000, 'get_logs_export بيرجّع cap/total/truncated');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} عدّى · ${fail} فشل`);
process.exit(fail ? 1 : 0);
