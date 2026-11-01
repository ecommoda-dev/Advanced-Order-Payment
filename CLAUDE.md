<div dir="rtl" style="text-align: right;">

# تسجيل التحصيل قبل الشحن (`Advanced-Order-Payment`)

![version](https://img.shields.io/badge/version-v1.0.0-blue)

**بتعمل إيه:** الموظف بيسجّل **تحصيل أوردر واحد على شوبيفاي قبل ما يتشحن** (كاش · إنستاباي · محفظة) ويشوف سجل العمليات. **أوردر واحد في المرة — مفيش دفعات.**
**مين بيستخدمها:** حسابات · مخزن
**الإصدار:** Worker `v1.0.0` · الواجهة `v1.0.0`   ← الاتنين مستقلين، طبيعي يختلفوا

## 🔴 قاعدة الأهلية — قرار أحمد 01-11-2026

الأداة بتسجّل تحصيل على الأوردر **لو وبس لو**:

| الشرط | القاعدة |
|---|---|
| `custom.manual_status` (S1) | `Confirmed` بالظبط (الحروف جزء من القيمة) |
| `custom.status_2_r_e` (S2) | **فاضي** — أي قيمة (استبدال/مرتجع) = رفض |
| الأوردر | مش ملغي |
| المتبقي على شوبيفاي (`totalOutstandingSet`) | **أكبر من صفر** |
| `canMarkAsPaid` | `true` |
| المبلغ | **تحصيل كامل** بس — لازم == المتبقي بالقرش |

- ⛔ **مفيش استرداد** — لا في الواجهة ولا في الـ Worker (مفيش `refundCreate` ولا action اسمه `refund`). أوردر مستحق له استرداد (متبقي سالب) **بيترفض بسببه**. وفيه بند في `docs/worker-check.mjs` بيقفل ده.
- ⛔ **مفيش تحصيل جزئي** — لو اتطلب يوم، ده قرار منفصل (الأداة كلها مبنية على «المبلغ المعروض == المستحق»).
- 🔴 **الأهلية بتتحسب في الـ Worker** (`evaluateEligibility`) — الواجهة بترسم ردّه وبتقفل الزرار، لكنها **مش الحارس**. والـ Worker بيعيد الفحص على **قراءة جديدة وقت الكتابة** (worker-builder Step 5A ⑩ ④) — الشاشة ممكن تكون قديمة.
- كل أسباب الرفض بتتعرض **مع بعض بقيمتها الحرفية** (مثلاً: `S1 لازم يكون Confirmed — الحالي: Ready` + `S2 لازم يكون فارغ — الحالي: Confirmed + EXCHANGE`).
- **«مدفوع بالكامل» مش فشل** — بيرجع `already` (بادج محايد، مش أحمر).

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Advanced-Order-Payment/
الـ Worker : https://advanced-order-payment-worker.ecommoda-dev.workers.dev
اسم الـ Worker في الداشبورد: advanced-order-payment-worker     ← مطابق لـ name في wrangler.toml
```

## الـ Endpoints

كلها `?action=` — الجسم JSON في POST بس (PIN وبيانات الدفع).

| `action` | الطريقة | بيعمل إيه |
|---|---|---|
| `check_employee` · `log_logout` · `get_employees` | GET | الدخول / الموظفين |
| `register_pin` · `verify_employee` | POST | الدخول (PIN في الجسم بس) |
| `lookup_order` | GET | `kind=name\|id` + `value` — بحث + أهلية. **قراءة بس: صفر كتابة** |
| `record_payment` | POST | **الكتابة الوحيدة على شوبيفاي** (REST `transactions.json` · `kind=capture` · `gateway=manual`) + صف D1 |
| `get_logs` · `get_logs_count` · `get_logs_export` | GET | السجل (فلاتر: `employees` `types` `results` `orders` `amountMin` `amountMax` `search` `dateFrom` `dateTo` + `sortBy` `sortDir`) |
| `get_config` · `diag` | GET | نسخة الـ Worker · فحص ذاتي بلا كتابة (يرجّع `checks[]` = `[{ ok, label, detail }]`) |

### `record_payment` — الترتيب مقصود

1. تحقق رخيص (HTTP 400 للطلب الباظ: مبلغ ≤ 0 · طرق دفع مجموعها ≠ المبلغ · موظف ناقص) — **مابيتسجّلش ولا بيلمس شوبيفاي**.
2. قراءة جديدة للأوردر من شوبيفاي → `evaluateEligibility`.
3. اتفاق المبلغ: `amount` == المتبقي الحالي (تحصيل كامل).
4. حارس التكرار: تحصيل `success`/`warning` على نفس الأوردر خلال **120 ثانية** (D1) = رفض.
5. الفعل: `createCapture` (REST).
6. **تحقق بقراءة بعد الفعل**: المتبقي بقى صفر؟ (`readOutstandingAfter`)
7. السجل (`safeWriteLog` — فشل D1 = `logged:false` مش 500).

**النتيجة (HTTP 200 دايمًا للنتايج التشغيلية):** `status` ∈ `success` · `warning` · `error` · `already` · `rejected`

| الحالة | امتى |
|---|---|
| `success` | اتسجّل واتأكد (المتبقي بعده صفر) |
| `warning` | اتسجّل لكن التحقق ناقص (القراءة بعده فشلت / المتبقي لسه > 0) **أو** «مش متأكدين» (الاتصال انقطع بعد الإرسال — `success:false` و`uncertain:true` في السجل و`valueAfter = null`) |
| `error` | شوبيفاي رفضت صراحةً (HTTP 4xx بـ `errors`) |
| `already` | مدفوع خلاص / تحصيل حديث |
| `rejected` | الأهلية أو المبلغ — اتوقف **قبل أي محاولة** |

⚠️ **`warning` ≠ نجاح ≠ فشل.** الواجهة بتعامله «معرفناش»: بتقول **متعيدش المحاولة**، وبتعيد قراءة الأوردر لوحدها عشان تعرض الحقيقة.

## D1

```
tool  : advanced_order_payment
type  : payment · rejected · login · logout
```

الجداول المشتركة المستخدَمة: `logs` · `employees` · `log_value_alerts` (مفيش جداول خاصة بالأداة دي).

| `type` | `extra.result` | `value_after` |
|---|---|---|
| `payment` | `success` | المبلغ المسجّل |
| `payment` | `warning` | المبلغ لو اتأكد، **`null` لو مش متأكدين** (`extra.uncertain = true`) |
| `payment` | `error` | `null` |
| `rejected` | `rejected` · `already` | `null` |

🔴 **أي مجموع فلوس لازم يفلتر على `extra.result = 'success'`** (و`warning` مع `uncertain` غير true لو عايز اللي اتسجّل ولسه ما اتأكدش). `type='payment'` لوحده بيعدّ **المحاولات**:

```sql
SELECT SUM(value_after) FROM logs WHERE tool = 'advanced_order_payment' AND type = 'payment' AND json_extract(extra, '$.result') = 'success';
```

🔴 **عقد قراءة `extra`:** واجهة تاب السجل بتقرا `result` · `paymentMethods` · `s1` · `s2` · `outstandingBefore` · `outstandingAfter` · `transactionId` · `warnings` · `error` · `reasons` من `extra`. تغيير اسم أي مفتاح = خلية فاضية بلا أي خطأ — غيّر في `payExtra` في `index.js` **وفي** `§LOG-JS` في `index.html` معًا.

## المضبوط (الداشبورد)

> هنا **اللي المفروض يتعمل عند إنشاء الـ Worker** — الأداة جديدة ولسه ما اتنشرتش.

```
Bindings : DB → ecommoda-dev-logs   (D1)        ← من wrangler.toml
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET     ← الداشبورد + Promote
Vars     : SHOP_DOMAIN               ← من [vars] في wrangler.toml
Build watch paths : index.js  +  wrangler.toml      ← chip لكل واحد في سطر لوحده
```

- `WORKER_SECRET` **فريد للأداة دي** (مش عضو في أي مجموعة سر). لو اتقرر تنضم لمجموعة `delivery_cod_ops` بعد ما تتدمج في مركز الشحن والتحصيل، التسجيل في `ecommoda-constants` → `references/secret-groups.md` **قبل** التدوير (قاعدة ٢).
- الصلاحيات على الـ Custom App: **`read_orders` + `write_orders`** — `?action=diag` بيتأكد منهم بالاسم.
- ⛔ مفيش KV ولا Service Binding — الأداة **مابتلمسش `PRE_REG_KV`** ولا بتنده أي Worker تاني (خطأ 1042).

## CORS

`ALLOWED_ORIGINS` **صارمة** — `https://ecommoda-dev.github.io` بس (وهي كمان قيمة الـ fallback). أداة مالية/كتابة: مفيش wildcard.

## الواجهة — ملاحظات

- مربع الإدخال الموحّد (v8.5.0) **بنوعين بس**: رقم الأوردر (١–٧) · فاتورة شوبيفاي/Order ID (١٣–١٥). **Enter فقط** — مفيش مؤقّت. الفشل في صندوق أحمر.
- Tier **M (1200)** — أوسع تاب: سجل بتسع أعمدة.
- الأوردر اللي اتسجّل بيتقفل في الجلسة (`sessionDone`) — سكان تاني = توست «مكرر» من غير بحث.
- أثناء التسجيل (`isUpdating`): الإدخال مقفول والخروج (اليدوي والتلقائي) موقوف.
- السر الوحيد في `localStorage` (`advanced_order_payment_worker_secret`) وجنبه عروض أعمدة السجل (`advanced_order_payment_col_widths_v1`). الهوية في الذاكرة بس.
- `ExcelJS` من CDN — التصدير محروس بـ `typeof ExcelJS` **قبل** أي نداء شبكة.

## الفحوصات (كلها بلا dependency ما عدا `playwright`)

```bash
node check-log-values.mjs                 # قيم اللوج مسجّلة في log-values.json (لازم exit 0)
node docs/worker-check.mjs                # ٧٩ بند — الـ Worker الحقيقي على شوبيفاي وD1 وهميين
npm i playwright --no-save && node docs/ui-check.mjs    # ٩٨ بند — Chromium فعلي (الشاشة + الـ Worker معًا + D1 على SQLite حقيقي)
```

> `docs/ui-check.mjs` و`docs/fakes.mjs` محتاجين **Node 22.5+** (`node:sqlite`). `SHOTS=<مجلد> node docs/ui-check.mjs` بيحفظ لقطات شاشة للمراجعة بالعين.

## ⚠️ اللي ما اتجرّبش فعليًا

- **ما اتجرّبش على شوبيفاي حقيقية (كتابة).** الـ Worker اتقاس على شوبيفاي وهمية بتحاكي ردود `transactions.json` و GraphQL. أول تحصيل حقيقي بعد النشر هو الاختبار الفعلي — **ابدأ بأوردر بمبلغ صغير**، وراجع `?action=diag` الأول.
- شكل رد `transactions.json` (`transaction.id` · `errors` على 4xx) مأخوذ من سلوك `cod-payment-center-worker` الشغّال في الإنتاج، مش من اختبار حي في الجلسة دي.
- الأصوات ما اتسمعتش على جهاز (الفحص الآلي بيتأكد من الاستدعاء بس).

## مسائل مفتوحة

- 🔴 **تسجيل `advanced_order_payment` في `ecommoda-constants` §7.1** (فهرس `tool` → ريبو: `advanced_order_payment` ← `Advanced-Order-Payment`). `log-values.json` جنب الكود اتعمل في نفس الـ commit (Rule 7)، لكن فهرس الأسماء في المهارة خارج الريبو ده.
- 🟡 **مفيش تحصيل جزئي** — لو اتطلب (عربون مثلاً) لازم قرار: حد أدنى؟ تقفيل الأوردر؟ شكل `valueAfter` في السجل؟
- 🟡 **علاقة الأداة دي بـ `cod-pre-register-payment` و`COD-Payment-Center`:** `COD-Payment-Center` بيقرا مفتاح `preReg:` في `PRE_REG_KV` وميتا `custom.pre_register_payment`. الأداة دي **مابتكتبهمش**. الأوردر اللي اتحصّل عليه هنا بيبقى متبقيه صفر على شوبيفاي، فـ`COD-Payment-Center` هيعرضه «مدفوع بالكامل» ومش قابل للتحصيل (لو الغرض إنه يتعامل معاه كتسجيل مسبق ويظهر في جلسة المندوب بمبلغ، ده قرار منفصل — بيحتاج كتابة الميتافيلد/المفتاح).
- 🟡 **طرق الدفع** (`cash` · `instapay` · `wallet`) مأخوذة من `COD-Payment-Center` — لو الأداة دي محتاجة طرق تانية (فيزا/تحويل بنكي) تتضاف في `PM` (الواجهة) و`PM_KEYS` (الـ Worker) مع بعض.
- 🟡 **`check-log-values.mjs`** منسوخ من ريبو `COD-Payment-Center` (يقرا shorthand) لكنه **بلا `CHECK_VERSION`** — وصفة `LOG-checker-blind-shorthand` في `worker-builder/sweep-checks.yaml` بتدوّر على `CHECK_VERSION = 'v3.2'` وهتعلّمه. مفيش نسخة v3.2 في المهارة نفسها أقدر أنسخها — استبدله بالنسخة المعتمدة.
- 🟡 **انحرافات مقصودة عن المعيار** (موثّقة في الكود): ① فلتر الجدول `orders` و`amountMin/Max` و`results` في `buildLogFilterSQL` زيادة عن `shared-functions.md`، وفلتر التاريخ بحدود يوم القاهرة مش UTC. ② جدول السجل **من غير فلتر وقت** وبلا اقتراحات لايف في فلتر الأوردر (server-side — الاقتراحات محتاجة endpoint) وفلتر المبلغ نطاق من–إلى بس. ③ `playBeep('fail'|'dup')` بقيم `unified-entry-box.md` § ٦ (نسخة الهب في `shared/core.js` مختلفة).

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v3.10.0 |
| ecommoda-html-builder | v8.6.0 |
| ecommoda-constants | v4.4.0 |
| ecommoda-order-lifecycle | v1.9.0 |

آخر مطابقة: 01-11-2026 · `index.js` v1.0.0 · `index.html` v1.0.0
🔴 معلّقة: تسجيل `advanced_order_payment` في `ecommoda-constants` §7.1 · إنشاء الـ Worker وربط Workers Builds والأسرار + Promote · تفعيل GitHub Pages

آخر تحديث: 01-11-2026 — 12:18

</div>
