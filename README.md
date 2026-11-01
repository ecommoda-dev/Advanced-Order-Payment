<div dir="rtl" style="text-align: right;">

# تسجيل التحصيل قبل الشحن — Advanced Order Payment

![version](https://img.shields.io/badge/version-v1.0.0-blue)

أداة بتسجّل **تحصيل أوردر واحد على شوبيفاي قبل الشحن**، للأوردرات اللي حالتها `S1 = Confirmed` و`S2` فاضية بس. مفيش استرداد ومفيش تحصيل جزئي.

- **الواجهة:** `index.html` (ملف واحد · GitHub Pages)
- **الـ Worker:** `index.js` + `wrangler.toml` (`advanced-order-payment-worker`)
- **التفاصيل والقرارات والفخاخ:** `CLAUDE.md`

## تشغيل الفحوصات

```bash
node check-log-values.mjs
node docs/worker-check.mjs
npm i playwright --no-save && node docs/ui-check.mjs
```

## النشر (مرة واحدة)

1. GitHub Pages → Deploy from a branch → `main` / (root).
2. Cloudflare → Workers Builds على الريبو → Worker باسم `advanced-order-payment-worker`.
3. **Build watch paths:** `index.js` و`wrangler.toml` — **chip لكل واحد في سطر لوحده**.
4. الأسرار من الداشبورد: `WORKER_SECRET` · `CLIENT_ID` · `CLIENT_SECRET` ← **Promote**.
5. افتح الواجهة، الصق الـ `WORKER_SECRET` في ⚙️ الإعدادات، واضغط 🩺 «افحص الأداة».

آخر تحديث: 01-11-2026 — 12:18

</div>
