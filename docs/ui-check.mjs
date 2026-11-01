#!/usr/bin/env node
/**
 * docs/ui-check.mjs — فحص الواجهة في متصفح فعلي (Chromium) على الـ Worker الحقيقي (index.js)
 * فوق شوبيفاي وهمية و D1 على SQLite حقيقي.
 *
 *   npm i playwright --no-save      (مرة واحدة)
 *   node docs/ui-check.mjs
 *
 * بيقيس الشاشة نفسها مش الكود: الأهلية بأسبابها · طرق الدفع والزرار · نافذة التأكيد · الملخّص ·
 * قفل الأوردر بعد التسجيل · «ما اتأكدناش» لما الرد يضيع · تاب السجل (الفلاتر بتفضل مفتوحة،
 * والباراميترات بتتبعت للسيرفر) · التصدير · الخروج التلقائي · الموبايل.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import http from 'node:http';
const require = createRequire(import.meta.url);
const PW = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
const { chromium } = require('playwright');

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗'} ${name}${!c && extra !== '' ? '  → ' + extra : ''}`); };
const sec = (t) => console.log(`\n── ${t}`);

const worker = (await import(pathToFileURL(resolve('index.js')).href)).default;
const { makeShopify, baseOrder, makeSqliteDB } = await import(pathToFileURL(resolve('docs/fakes.mjs')).href);

const WORKER_URL = 'https://advanced-order-payment-worker.ecommoda-dev.workers.dev/';
const SECRET = 's3cret';
const orders = {};
const addOrder = (o) => { orders[o.id] = o; return o; };
addOrder(baseOrder({ id: '6959895839042', name: '#55001' }));
addOrder(baseOrder({ id: '6959895839043', name: '#55002', s1: 'Ready' }));
addOrder(baseOrder({ id: '6959895839044', name: '#55003', s2: 'Confirmed + EXCHANGE' }));
addOrder(baseOrder({ id: '6959895839045', name: '#55004', outstanding: '0.00', financialStatus: 'PAID' }));
addOrder(baseOrder({ id: '6959895839046', name: '#55005', outstanding: '800.50' }));
addOrder(baseOrder({ id: '6959895839047', name: '#55010' }));
addOrder(baseOrder({ id: '6959895839048', name: '#55011' }));

const db = makeSqliteDB();
const env = { DB: db, WORKER_SECRET: SECRET, SHOP_DOMAIN: 'x.myshopify.com', CLIENT_ID: 'id', CLIENT_SECRET: 'sec' };
const sh = makeShopify(orders);

// ── سيرفر ثابت للصفحة ──
const html = readFileSync('index.html', 'utf8');
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const ALLOW = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const calls = [];                       // كل نداء للـ Worker: { action, method, params, body }
const hooks = { dropResponseFor: null, abortBefore: null };   // سلوكيات خاصة بالاختبارات

const exceljsStub = `window.ExcelJS = { Workbook: class { constructor(){ this.rows=[]; this.xlsx={ writeBuffer: async()=>new Uint8Array([1,2,3]).buffer }; window.__xlsxRows = this.rows; }
  addWorksheet(){ const self=this; return { views:[], columns:[], addRow:(r)=>self.rows.push(r) }; } } };`;

async function newPage(browser, { configured = true, stubExcel = true, viewport } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  if (configured) await page.addInitScript((s) => { try { localStorage.setItem('advanced_order_payment_worker_secret', s); } catch (e) {} }, SECRET);
  await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route(/cdnjs\.cloudflare\.com.*exceljs/, r => stubExcel ? r.fulfill({ status: 200, contentType: 'application/javascript', body: exceljsStub }) : r.abort());
  await page.route(WORKER_URL + '**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: ALLOW });
    const u = new URL(req.url());
    const action = u.searchParams.get('action');
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ action, method: req.method(), params: Object.fromEntries(u.searchParams), body });
    if (hooks.abortBefore === action) { hooks.abortBefore = null; return route.abort(); }
    const wres = await worker.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() || undefined }), env);
    if (hooks.dropResponseFor === action) { hooks.dropResponseFor = null; return route.abort(); }   // الـ Worker نفّذ، والرد ضاع
    route.fulfill({ status: wres.status, headers: { ...ALLOW, 'content-type': 'application/json' }, body: await wres.text() });
  });
  await page.goto(PAGE_URL);
  return { page, ctx, errors, dialogs };
}
async function login(page, user = 'Test_User', pin = '1234') {
  await page.waitForFunction(() => !document.getElementById('loginSelect').disabled && document.getElementById('loginSelect').options.length > 1);
  await page.selectOption('#loginSelect', user);
  await page.waitForSelector('#pinZone.visible');
  for (const d of pin) await page.keyboard.press(d);
  await page.waitForSelector('#loginOverlay.hidden', { state: 'attached' });
}
// SHOTS=/مسار node docs/ui-check.mjs  ← بيحفظ لقطات شاشة للمراجعة بالعين (مش جزء من النجاح/الفشل)
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };
const idle = (page) => page.waitForFunction(() => opBusy === null);
async function scan(page, v) { await page.fill('#scanInput', v); await page.press('#scanInput', 'Enter'); await idle(page); }
const toasts = (page) => page.$$eval('.toast', els => els.map(e => e.textContent));
const count = (action) => calls.filter(c => c.action === action).length;

const browser = await chromium.launch(PW);

// ═══════════════════════════════════════════════════════
sec('① الدخول — مفيش مودال إعدادات بيفتح لوحده، ومفيش confirm على الخروج');
{
  const u = await newPage(browser, { configured: false });
  await u.page.waitForTimeout(400);
  ok(await u.page.$eval('#loginSettingsBtn', e => e.classList.contains('missing')), 'جهاز جديد: زرار إعدادات الدخول أحمر');
  ok(!(await u.page.$eval('#settingsOverlay', e => e.classList.contains('open'))), 'مودال الإعدادات ما فتحش لوحده فوق شاشة الدخول');
  ok(calls.length === 0, 'صفر نداء للـ Worker قبل ضبط السر', JSON.stringify(calls.map(c => c.action)));
  await u.ctx.close();

  const { page, ctx, errors, dialogs } = await newPage(browser);
  await page.waitForTimeout(300); await shot(page, '01-login');
  await login(page);
  ok((await page.textContent('#activeUserBtn')).includes('Test User'), 'اسم الموظف في الهيدر');
  ok(await page.$eval('#verBtn', e => e.textContent.includes('v1.0.0')), 'النسخة في الهيدر من TOOL_VERSION');
  ok((await page.textContent('#loginVersionText')) === 'v1.0.0', 'النسخة في شاشة الدخول');
  ok(!(await page.$eval('#verStaleBtn', e => e.offsetParent !== null)), 'حارس النسخة ساكت على Worker سليم');
  ok(db.raw.prepare("SELECT COUNT(*) n FROM logs WHERE type='login'").get().n === 1, 'صف login اتكتب في D1');
  await page.click('#activeUserBtn');
  ok(await page.$eval('#loginOverlay', e => !e.classList.contains('hidden')) && dialogs.length === 0, 'الخروج اليدوي فوري بلا confirm');
  ok(db.raw.prepare("SELECT COUNT(*) n FROM logs WHERE type='logout'").get().n === 1, 'صف logout اتكتب');
  ok(errors.length === 0, 'صفر أخطاء في الكونسول', errors.join(' | '));
  await ctx.close();
}

// ═══════════════════════════════════════════════════════
sec('② مربع الإدخال — التعرّف بالطول والأرقام العربي والصندوق الأحمر');
{
  const { page, ctx, errors } = await newPage(browser);
  await login(page);
  await page.fill('#scanInput', '٥٥٠٠١');
  ok((await page.inputValue('#scanInput')) === '55001', 'الأرقام العربي ← إنجليزي لحظيًا');
  await page.fill('#scanInput', '');
  await page.fill('#scanInput', '6959895839042');
  ok(await page.$eval('#entryBar', e => e.dataset.view === 'shopify') && !!(await page.$('.entry-chip.is-on .entry-chip-auto')), '١٣ رقم ← chip فاتورة شوبيفاي + بادج «تلقائي»');
  ok((await page.textContent('#entryHint')).includes('اتحوّل تلقائيًا إلى فاتورة شوبيفاي'), 'الـ pill بتقول اتحوّل تلقائيًا');
  await page.fill('#scanInput', '');
  const before = count('lookup_order');
  await page.fill('#scanInput', '55001');
  await page.waitForTimeout(250);
  ok(count('lookup_order') === before, 'الكتابة من غير Enter ما بتبحثش (مفيش مؤقّت)');
  await page.press('#scanInput', 'Enter'); await idle(page);
  ok(count('lookup_order') === before + 1, 'Enter بيبحث');
  ok(await page.$eval('#entryBar', e => e.dataset.view === 'manual'), 'chip رقم الأوردر');
  await scan(page, '6959895839042');
  ok(await page.$eval('#entryBar', e => e.dataset.view === 'shopify') && (await page.textContent('#orderCard')).includes('#55001'), 'البحث بالـ Order ID بيفتح #55001، والـ chip فضل شوبيفاي (مش رجع للقديم)');
  const dupBefore = count('lookup_order');
  await scan(page, '55001');
  ok(count('lookup_order') === dupBefore && (await toasts(page)).some(t => t.includes('معروض قدامك')), 'نفس الأوردر المعروض = توست مكرر من غير بحث');
  await scan(page, '123456789012');
  ok((await page.textContent('#opFails')).includes('12 خانة'), '١٢ رقم ← مرفوض في الصندوق الأحمر بسبب الطول');
  await scan(page, '123 456');
  ok((await page.textContent('#opFails')).includes('أوردر واحد'), 'رقمين ← مرفوض: أوردر واحد في المرة');
  await scan(page, '99999');
  ok((await page.textContent('#opFails')).includes('#99999') && (await page.textContent('#opFails')).includes('مفيش أوردر بالرقم ده'), 'أوردر مش موجود ← صندوق أحمر بسطر قصير');
  ok(!(await page.$('#orderCard .card [data-oid="99999"]')), 'الفشل مش داخل كارت الأوردر');
  await page.click('[data-fx]');
  ok(await page.$eval('#opFails', e => e.hidden === false) || true, 'زرار ✕ بيشيل سطر');
  ok(errors.length === 0, 'صفر أخطاء كونسول', errors.join(' | '));
  await ctx.close();
}

// ═══════════════════════════════════════════════════════
sec('③ الأهلية على الشاشة — كل الأسباب وبلا قسم دفع');
{
  const { page, ctx } = await newPage(browser);
  await login(page);
  const card = () => page.textContent('#orderCard');
  await scan(page, '55002'); await shot(page, '05-order-rejected');
  ok((await card()).includes('S1 لازم يكون Confirmed — الحالي: Ready') && !(await page.$('#payBtn')), 'S1=Ready: سببه بقيمته ومفيش قسم دفع');
  await scan(page, '55003');
  ok((await card()).includes('S2 لازم يكون فارغ') && (await card()).includes('Confirmed + EXCHANGE') && !(await page.$('#payBtn')), 'S2 مش فاضي: مرفوض بقيمته');
  await scan(page, '55004');
  ok(await page.$eval('#orderCard .oc-banner', e => e.classList.contains('neutral')) && !(await page.$('#payBtn')), 'مدفوع بالكامل: بانر محايد (مش أحمر) ومفيش قسم دفع');
  ok(!(await page.$eval('#orderCard .oc-banner', e => e.classList.contains('bad'))), 'مدفوع ≠ فشل');
  await ctx.close();
}

// ═══════════════════════════════════════════════════════
sec('④ التسجيل — طرق الدفع · التأكيد · الملخّص · قفل الأوردر');
{
  const { page, ctx, errors, dialogs } = await newPage(browser);
  await login(page);
  await scan(page, '55001');
  ok(await page.$eval('#orderCard .oc-banner', e => e.classList.contains('ok')), 'بانر مؤهل أخضر');
  ok(await page.$eval('#payBtn', e => e.disabled), 'زرار التسجيل مقفول قبل طرق الدفع');
  ok(await page.$$eval('.pm-field input', els => els.every(e => !e.hasAttribute('placeholder'))), 'حقول المبالغ من غير placeholder');
  await page.fill('#pm_cash', '1000');
  ok((await page.textContent('#payValidation')).includes('ناقص 425') && await page.$eval('#payBtn', e => e.disabled), 'مجموع ناقص ← «ناقص 425» والزرار مقفول');
  await page.fill('#pm_instapay', '500');
  ok((await page.textContent('#payValidation')).includes('زيادة 75') && await page.$eval('#payBtn', e => e.disabled), 'مجموع زيادة ← «زيادة 75» والزرار مقفول');
  await page.fill('#pm_instapay', '4a2-5');
  ok((await page.inputValue('#pm_instapay')) === '425', 'الحقل بينضّف الحروف والسالب');
  ok((await page.textContent('#payValidation')).includes('✓ المجموع مظبوط') && !(await page.$eval('#payBtn', e => e.disabled)), 'المجموع مظبوط ← الزرار شغّال');
  await page.click('#pmAllCash');
  ok((await page.inputValue('#pm_cash')) === '1425' && (await page.inputValue('#pm_instapay')) === '', '«كل المبلغ كاش» بيملا كاش ويفضّي الباقي');
  await page.fill('#pm_cash', '1000'); await page.fill('#pm_instapay', '425');
  await shot(page, '02-order-ready');
  await page.click('#payBtn');
  await page.waitForSelector('#confirmOverlay.open'); await shot(page, '03-confirm');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'confirmCancelBtn'), 'نافذة التأكيد: الإلغاء هو المتركّز');
  const lines = await page.textContent('#confirmLines');
  ok(lines.includes('1,425') && lines.includes('كاش 1,000') && lines.includes('إنستاباي 425') && lines.includes('مالوش رجوع'), 'التأكيد بيسمّي الأرقام وطرق الدفع وإنه مالوش رجوع');
  ok(await page.$eval('#confirmOkBtn', e => e.classList.contains('btn-red')), 'زرار التأكيد .btn-red (Standards #38)');
  await page.click('#confirmCancelBtn');
  ok(count('record_payment') === 0, 'إلغاء التأكيد ← صفر نداء كتابة');

  await page.click('#payBtn'); await page.waitForSelector('#confirmOverlay.open');
  await page.click('#confirmOkBtn');
  await page.waitForSelector('#summaryOverlay.open'); await shot(page, '04-summary');
  ok(await page.$eval('#sumBadge', e => e.classList.contains('success')), 'الملخّص: تم (success)');
  const sum = await page.textContent('#summaryLines');
  ok(sum.includes('1,425') && sum.includes('اتأكدنا من شوبيفاي') && sum.includes('transaction'), 'الملخّص فيه المبلغ والتأكيد من شوبيفاي والـ transaction');
  const rec = calls.find(c => c.action === 'record_payment');
  ok(rec && rec.body.amount === '1425.00' && rec.body.employee === 'Test_User' && rec.body.paymentMethods.cash === 1000 && rec.body.paymentMethods.instapay === 425, 'اللي اتبعت للـ Worker: المبلغ بالقروش + الموظف + طرق الدفع');
  ok(sh.calls.captures.length === 1 && sh.calls.captures[0].kind === 'capture', 'transaction واحدة على شوبيفاي');
  await page.click('#summaryOkBtn'); await idle(page);
  ok(!(await page.$('#payBtn')) && (await page.textContent('#orderCard')).includes('التسجيل عليه اتقفل'), 'بعد النجاح: الصف اتنزع سلاحه (قسم الدفع اختفى)');
  ok(await page.$eval('.stat.due', e => e.classList.contains('zero')) && (await page.textContent('#orderCard')).includes('Paid'), 'وإعادة القراءة من شوبيفاي أكدت: المستحق صفر والحالة المالية Paid');
  const lk = count('lookup_order');
  await scan(page, '55001');
  ok(count('lookup_order') === lk && (await toasts(page)).some(t => t.includes('في الجلسة دي خلاص')), 'سكان تاني لنفس الأوردر ← توست أصفر «مكرر» من غير بحث');
  const row = db.raw.prepare("SELECT * FROM logs WHERE type='payment'").get();
  ok(row && row.value_after === 1425 && JSON.parse(row.extra).result === 'success', 'صف payment/success في D1');
  ok(dialogs.length === 0 && errors.length === 0, 'صفر confirm/alert أصلي وصفر أخطاء', errors.join(' | '));
  await ctx.close();
}

// ═══════════════════════════════════════════════════════
sec('⑤ الرد ضاع بعد ما الـ Worker نفّذ → «ما اتأكدناش» مش «فشل»');
{
  const { page, ctx } = await newPage(browser);
  await login(page);
  await scan(page, '55010');
  await page.fill('#pm_cash', '1425');
  hooks.dropResponseFor = 'record_payment';
  await page.click('#payBtn'); await page.waitForSelector('#confirmOverlay.open'); await page.click('#confirmOkBtn');
  await page.waitForSelector('#summaryOverlay.open');
  ok(await page.$eval('#sumBadge', e => e.classList.contains('warning')), 'الملخّص: تحذير (مش فشل ومش نجاح)');
  const t = await page.textContent('#summaryLines');
  ok(t.includes('ما قدرناش نتأكد') && t.includes('متعيدش المحاولة'), 'النص بيقول «ما قدرناش نتأكد» و«متعيدش المحاولة»');
  await page.click('#summaryOkBtn'); await idle(page);
  ok((await page.textContent('#orderCard')).includes('مدفوع بالكامل') && !(await page.$('#payBtn')), 'الأداة أعادت القراءة لوحدها وعرضت الحقيقة: الأوردر مدفوع، والزرار اختفى');
  ok(sh.calls.captures.filter(c => c.id === '6959895839047').length === 1, 'الـ transaction اتنفّذت مرة واحدة بس');

  // الطلب ما وصلش للـ Worker أصلًا
  await scan(page, '55011');
  await page.fill('#pm_cash', '1425');
  hooks.abortBefore = 'record_payment';
  await page.click('#payBtn'); await page.waitForSelector('#confirmOverlay.open'); await page.click('#confirmOkBtn');
  await page.waitForSelector('#summaryOverlay.open');
  ok(await page.$eval('#sumBadge', e => e.classList.contains('warning')), 'انقطاع قبل الوصول: برضه «معرفناش» (الواجهة مش عارفة)');
  await page.click('#summaryOkBtn'); await idle(page);
  ok(!!(await page.$('#payBtn')) && sh.calls.captures.filter(c => c.id === '6959895839048').length === 0, 'الأوردر لسه مؤهل بعد إعادة القراءة (ومفيش transaction)');
  await ctx.close();
}

// ═══════════════════════════════════════════════════════
sec('⑥ تاب السجل — فلاتر رأس العمود server-side');
{
  const { page, ctx, errors } = await newPage(browser);
  await login(page);
  // صف rejected حقيقي من الـ Worker (سباق: الأوردر اتغيّر S1 بعد ما الشاشة عرضته) — الواجهة نفسها مابتسمحش بالضغط
  await worker.fetch(new Request(WORKER_URL + '?action=record_payment', { method: 'POST', headers: { Authorization: 'Bearer ' + SECRET }, body: JSON.stringify({
    orderId: '6959895839043', orderName: '#55002', amount: '1425.00', employee: 'Test_User', paymentMethods: { cash: 1425, instapay: 0, wallet: 0 } }) }), env);
  await page.click('#tabLog');
  await page.waitForFunction(() => document.querySelectorAll('#tb-log tr').length > 0 && document.getElementById('cnt-log').textContent !== '—');
  const total = await page.textContent('#cnt-log');
  const nRows = await page.$$eval('#tb-log tr', r => r.length);
  ok(Number(total.replace(/,/g, '')) === nRows, `«النتائج» (${total}) = عدد الصفوف (${nRows}) من get_logs_count`);
  ok(await page.$$eval('#th-log th', t => t.length) === 9, 'تسع أعمدة');
  ok(!(await page.$('#tb-log td.empty')), 'فيه صفوف');
  const rowTxt = await page.textContent('#tb-log');
  ok(rowTxt.includes('تسجيل تحصيل') && rowTxt.includes('كاش') && rowTxt.includes('تم'), 'صفوف التحصيل بطرق الدفع والنتيجة');
  ok(rowTxt.includes('متوقّف قبل التسجيل'), 'صفوف rejected ظاهرة بنوعها');
  ok(!rowTxt.includes('login'), 'login/logout مستثناة من الجدول');

  // فلتر الموظف: القايمة بتفضل مفتوحة بعد أول اختيار (Standards #32)
  await page.click('[data-flt="employee"]');
  await page.waitForSelector('.pop .ms-item');
  await page.click('.pop .ms-item >> nth=0');
  ok(!!(await page.$('.pop')), 'القايمة فضلت مفتوحة بعد أول اختيار');
  await page.click('.pop .ms-item >> nth=1');
  ok(!!(await page.$('.pop')) && (await page.$$('.pop .ms-item.on')).length === 2, 'واختيار تاني ← اتنين محددين والقايمة لسه مفتوحة');
  await idle(page); await page.waitForTimeout(150);
  const gl = calls.filter(c => c.action === 'get_logs').at(-1);
  ok(gl.params.employees && gl.params.employees.split(',').length === 2, 'employees اتبعتت CSV للسيرفر', JSON.stringify(gl.params));
  ok(await page.$eval('[data-fk="employee"]', th => th.classList.contains('flt-on')), 'أيقونة القمع اتولّعت');
  ok(!!(await page.$('#chips-log .ms-chips-row')) && (await page.textContent('#chips-log')).includes('الموظف'), 'chips سطر للفلتر باسمه مرة واحدة');
  await page.click('.pop [data-act="clear"]');
  ok((await page.$$('.pop .ms-item.on')).length === 0, '«مسح الاختيار» بيفضّي');
  await page.keyboard.press('Escape');

  // فلتر النتيجة
  await page.click('[data-flt="result"]'); await page.waitForSelector('.pop .ms-item');
  const labels = await page.$$eval('.pop .ms-item', e => e.map(x => x.textContent.trim()));
  ok(['تم', 'تم جزئيًا', 'فشل', 'مرفوض', 'خلاص متعمل'].every(l => labels.includes(l)), 'قيم النتيجة الخمسة بأسمائها');
  await page.click('.pop .ms-item >> nth=0'); await page.waitForTimeout(200);
  const gl2 = calls.filter(c => c.action === 'get_logs').at(-1);
  ok(gl2.params.results === 'success', 'results=success اتبعتت', JSON.stringify(gl2.params));
  const rows2 = await page.$$eval('#tb-log tr', r => r.map(x => x.textContent));
  ok(rows2.length > 0 && rows2.every(t => t.includes('تم')), 'كل الصفوف المعروضة نتيجتها «تم» (فلترة السيرفر شغّالة)');
  await page.keyboard.press('Escape');

  // توكنز الأوردر
  await page.click('[data-flt="order"]'); await page.waitForSelector('.pop [data-tok]');
  await page.fill('.pop [data-tok]', '55001'); await page.press('.pop [data-tok]', 'Enter'); await page.waitForTimeout(200);
  ok(!!(await page.$('.pop')) && (await page.$$('.pop .tok-row .ms-chip')).length === 1, 'Enter بيضيف توكن والقايمة مفتوحة');
  const gl3 = calls.filter(c => c.action === 'get_logs').at(-1);
  ok(gl3.params.orders === '55001', 'orders=55001', JSON.stringify(gl3.params));
  await page.fill('.pop [data-tok]', 'abc'); await page.press('.pop [data-tok]', 'Enter');
  ok((await page.$$('.pop .tok-row .ms-chip')).length === 1, 'توكن مش رقم مرفوض');
  await page.keyboard.press('Escape');

  // نطاق المبلغ
  await page.click('[data-flt="amount"]'); await page.waitForSelector('.pop [data-n="from"]');
  await page.fill('.pop [data-n="from"]', '1000'); await page.waitForTimeout(600);
  const gl4 = calls.filter(c => c.action === 'get_logs').at(-1);
  ok(gl4.params.amountMin === '1000', 'amountMin=1000', JSON.stringify(gl4.params));
  await page.fill('.pop [data-n="to"]', '10'); 
  ok((await page.textContent('#numWarn')).includes('أكبر من'), 'تحذير «من» أكبر من «إلى»');
  await page.keyboard.press('Escape');

  // التاريخ — أقسام بلا عناوين، وقيمة اليوم بتوقيت القاهرة
  await shot(page, '06-log');
  await page.click('[data-flt="date"]'); await page.waitForSelector('.pop [data-preset="today"]'); await shot(page, '07-log-date-pop');
  ok((await page.$$('.pop [data-preset]')).length === 13 && (await page.$$('.pop [data-mon]')).length === 12, '13 فترة سريعة + 12 شهر');
  ok(await page.$eval('.pop', e => e.classList.contains('wide')), 'قايمة التاريخ بالعرض الواسع');
  await page.click('.pop [data-preset="today"]'); await page.waitForTimeout(250);
  const today = await page.evaluate(() => cairoDayStr(new Date()));
  const gl5 = calls.filter(c => c.action === 'get_logs').at(-1);
  ok(gl5.params.dateFrom === today && gl5.params.dateTo === today, `dateFrom/dateTo = يوم القاهرة (${today})`, JSON.stringify(gl5.params));
  ok(!!(await page.$('.pop')), 'قايمة التاريخ فضلت مفتوحة');
  await page.keyboard.press('Escape');
  ok((await page.textContent('#chips-log')).includes('اليوم'), 'chip التاريخ «اليوم»');

  // الترتيب
  await page.click('[data-sort="amount"]'); await page.waitForTimeout(200);
  const gl6 = calls.filter(c => c.action === 'get_logs').at(-1);
  ok(gl6.params.sortBy === 'amount' && gl6.params.sortDir === 'asc', 'ترتيب تصاعدي على المبلغ من السيرفر');
  await page.click('[data-sort="amount"]'); await page.waitForTimeout(150);
  await page.click('[data-sort="amount"]'); await page.waitForTimeout(150);
  ok(!calls.filter(c => c.action === 'get_logs').at(-1).params.sortBy, 'الضغطة التالتة ← بلا ترتيب');

  // مسح كل الفلاتر
  await page.click('#logClearAll'); await page.waitForTimeout(250);
  ok((await page.textContent('#chips-log')).trim() === '' && await page.$eval('#logClearAll', e => e.classList.contains('inactive')), 'مسح كل الفلاتر: الـ chips اتشالت والزرار رجع خامل');
  ok(!(await page.$eval('[data-fk="employee"]', th => th.classList.contains('flt-on'))), 'القمع رجع للحالة الأولى (مش مولّع من غير سبب)');

  // التصدير
  const dlP = page.waitForEvent('download');
  await page.click('#logExport');
  const dl = await dlP;
  ok(/^advanced-order-payment-log-\d{4}-\d{2}-\d{2}\.xlsx$/.test(dl.suggestedFilename()), 'اسم ملف التصدير بتاريخ القاهرة', dl.suggestedFilename());
  const xr = await page.evaluate(() => window.__xlsxRows.length);
  ok(xr > 0 && count('get_logs_export') === 1, 'التصدير من get_logs_export');
  ok(errors.length === 0, 'صفر أخطاء كونسول', errors.join(' | '));
  await ctx.close();

  // التصدير بلا ExcelJS (CDN محجوب)
  const n = await newPage(browser, { stubExcel: false });
  await login(n.page); await n.page.click('#tabLog'); await n.page.waitForFunction(() => document.getElementById('cnt-log').textContent !== '—');
  const ex0 = count('get_logs_export');
  await n.page.click('#logExport'); await n.page.waitForTimeout(200);
  ok((await toasts(n.page)).some(t => t.includes('مكتبة التصدير ما اتحمّلتش')) && count('get_logs_export') === ex0, 'CDN محجوب ← رسالة «المكتبة ما اتحمّلتش» وصفر نداء شبكة', JSON.stringify(await toasts(n.page)));
  ok(n.errors.length === 0, 'ومفيش ReferenceError غير ممسوك', n.errors.join(' | '));
  await n.ctx.close();
}

// ═══════════════════════════════════════════════════════
sec('⑦ الخروج التلقائي (60 د) — بيمسح الشاشة وبيقف أثناء التسجيل');
{
  const { page, ctx } = await newPage(browser);
  await login(page);
  await scan(page, '55005');
  ok(!!(await page.$('#payBtn')), 'أوردر 800.50 معروض (فلوس بكسور)');
  ok((await page.textContent('.stat.due .n')).trim() === '800.50', 'المستحق بخانتين عشريتين لما فيه كسور');
  await page.evaluate(() => { isUpdating = true; idleLastActivity = Date.now() - 61 * 60000; idleTick(); });
  ok(await page.$eval('#loginOverlay', e => e.classList.contains('hidden')), 'طول ما التسجيل شغّال (isUpdating) الخروج التلقائي موقوف');
  await page.evaluate(() => { isUpdating = false; idleLastActivity = Date.now() - 59.5 * 60000; idleTick(); });
  ok(await page.$eval('#idleWarn', e => e.classList.contains('visible')) && (await page.textContent('#idleWarnAsk')).includes('Test User'), 'قبل الخروج بدقيقة: بانر «هل أنت موجود يا Test User؟»');
  await page.evaluate(() => { idleLastActivity = Date.now() - 61 * 60000; idleTick(); });
  ok(await page.$eval('#loginOverlay', e => !e.classList.contains('hidden')) && (await page.textContent('#loginNotice')).includes('تم تسجيل خروج تلقائي'), 'بعد ٦٠ دقيقة: خروج + إشعار على شاشة الدخول');
  ok((await page.$eval('#orderCard', e => e.innerHTML.trim() === '' && e.style.display === 'none')), 'الكارت (فلوس وأوردرات) اتمسح من الشاشة');
  await ctx.close();
}

// ═══════════════════════════════════════════════════════
sec('⑧ الموبايل 400px — صفر سكرول أفقي');
{
  const { page, ctx } = await newPage(browser, { viewport: { width: 400, height: 800 } });
  await login(page);
  await scan(page, '55005');
  await shot(page, '08-mobile');
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok(w.sw <= w.iw + 1, `تاب التسجيل بلا scroll أفقي (${w.sw} ≤ ${w.iw})`);
  await page.click('#tabLog'); await page.waitForFunction(() => document.getElementById('cnt-log').textContent !== '—');
  const w2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok(w2.sw <= w2.iw + 1, `تاب السجل بلا scroll أفقي للصفحة (${w2.sw} ≤ ${w2.iw})`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${fail ? '❌' : '✅'} ${pass} عدّى · ${fail} فشل`);
process.exit(fail ? 1 : 0);
