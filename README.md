# نسخهٔ استاتیک کلاس آنلاین (با حساب کاربری، داشبورد و پنل مدیریت)

صفحه‌ها (`static/`) فقط HTML/CSS/JS هستند و روی هر هاست استاتیک اجرا می‌شوند.
بک‌اند یک Cloudflare Worker (پوشهٔ `worker/`) با پایگاه‌دادهٔ رایگان **D1** است و ویدیو را **LiveKit** انجام می‌دهد.

| بخش | کجا |
|---|---|
| صفحهٔ اصلی، ورود/ثبت‌نام، داشبورد، پنل مدیریت، اتاق | `static/` (هاست استاتیک) |
| کاربران، اتاق‌ها، پلن‌ها، پرداخت‌ها، تنظیمات، توکن ورود به اتاق | `worker/` + D1 |
| ویدیو، صدا، چت، اشتراک صفحه | LiveKit Cloud یا LiveKit خودتان |
| فایل PDF ارائه | مستقیم از مرورگر مدرس به بقیه (چیزی روی سرور ذخیره نمی‌شود) |

## انتشار با GitHub و Render (سایت استاتیک)
۱. این پوشه را کامل در یک مخزن GitHub بگذارید (`static/`، `worker/`، `render.yaml` و ...).
۲. **قبل از commit**، در `static/config.js` مقدار `api` را برابر آدرس Worker خودتان بگذارید (مراحل ساخت Worker در بخش B پایین است).
۳. در https://render.com ← New ← **Static Site** ← مخزن GitHub را انتخاب کنید و این‌ها را بگذارید:
   - Build Command: خالی بگذارید (یا `echo ok`)
   - Publish Directory: `static`
   (یا New ← Blueprint تا `render.yaml` خودکار استفاده شود.)
۴. آدرس سایت Render (مثل `https://classroom.onrender.com`) را به‌عنوان `SITE_URL` و `ALLOWED_ORIGIN` روی Worker بگذارید.
۵. هر بار که در GitHub تغییری بدهید، Render خودش دوباره منتشر می‌کند.

> Render فقط سایت استاتیک را نگه می‌دارد. بک‌اند (حساب‌ها، اتاق‌ها، پرداخت، مدیریت) روی Cloudflare Worker + D1 اجرا می‌شود (رایگان) و ویدیو روی LiveKit.

## A) اجرا روی رایانهٔ خودتان (تست)
۱. LiveKit: `start-livekit.bat` پروژهٔ قبلی را اجرا کنید (یا `livekit-server.exe --dev` با کلید `devkey` و رمز `secret`).
۲. داخل پوشهٔ `worker` فایل `.dev.vars` بسازید:
```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=یک-رمز-حداقل-۸-کاراکتری
SITE_URL=http://localhost:5500
```
۳. در همان پوشه: `npx wrangler dev --port 8787` (پایگاه‌داده به‌صورت محلی و خودکار ساخته می‌شود).
۴. در `static/config.js` مقدار `api` را `http://localhost:8787` بگذارید.
۵. در پوشهٔ `static`: `python -m http.server 5500` (یا `npx http-server -p 5500 -c-1`) و باز کردن `http://localhost:5500`.
۶. با `ADMIN_EMAIL` و `ADMIN_PASSWORD` وارد شوید؛ دکمهٔ «پنل مدیریت» در داشبورد دیده می‌شود.
   (حساب مدیر خودکار ساخته می‌شود. اگر قبلاً با همان ایمیل ثبت‌نام کرده‌اید و رمزتان با `ADMIN_PASSWORD` یکی است، همان حساب مدیر می‌شود. بعداً می‌توانید از پنل مدیریت ← کاربران، هر کاربر دیگری را هم مدیر کنید.)

## B) انتشار روی اینترنت
۱. **LiveKit Cloud:** در https://cloud.livekit.io پروژه بسازید و `wss://...livekit.cloud`، API Key و API Secret را بردارید.
۲. **پایگاه‌داده:** داخل پوشهٔ `worker`: `npx wrangler login` سپس `npx wrangler d1 create classroom`
   و `database_id` چاپ‌شده را در `wrangler.toml` جایگزین `PASTE-DATABASE-ID-HERE` کنید.
۳. **متغیرها** (هر کدام یک بار؛ مقدار را می‌پرسد):
```
npx wrangler secret put LIVEKIT_URL
npx wrangler secret put LIVEKIT_API_KEY
npx wrangler secret put LIVEKIT_API_SECRET
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SITE_URL          (آدرس سایت شما، مثل https://class.example.com)
```
   اختیاری: `ALLOWED_ORIGIN` (همان آدرس سایت، برای محدود کردن API)، `ZARINPAL_MERCHANT_ID` (پرداخت آنلاین؛ `ZARINPAL_SANDBOX=1` برای تست).
۴. `npx wrangler deploy` ← آدرس Worker را می‌دهد (مثل `https://classroom-api.xxx.workers.dev`).
۵. در `static/config.js` مقدار `api` را برابر همان آدرس بگذارید.
۶. فایل `livekit-client.umd.min.js` را از `https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js` دانلود و در `static/vendor/` بگذارید (اختیاری؛ وگرنه از CDN بارگیری می‌شود).
۷. کل پوشهٔ `static/` را با **https** روی هاست آپلود کنید.
۸. با ایمیل و رمز مدیر وارد شوید. جدول‌ها و پلن‌های پیش‌فرض در اولین درخواست خودکار ساخته می‌شوند.

## امکانات
- صفحهٔ اصلی با معرفی و پلن‌ها، ثبت‌نام و ورود، داشبورد کاربر (اتاق‌ها، پلن‌ها و خرید، پرداخت‌ها، پروفایل).
- پنل مدیریت: آمار، کاربران، اتاق‌ها (و اتاق‌های زندهٔ همین لحظه)، پلن‌ها، تأیید پرداخت‌ها، تنظیمات سایت (نام، رنگ، ثبت‌نام، شمارهٔ کارت).
- پرداخت: درگاه زرین‌پال یا کارت‌به‌کارت با تأیید مدیر.
- اتاق: ویدیو، صدا، چت، دست بالا بردن، اشتراک صفحه، وایت‌بورد، ارائهٔ PDF (فقط مدرس ورق می‌زند و می‌نویسد)، فقط کسانی که دوربین روشن دارند پنجره دارند.
- مهمان‌ها می‌توانند بدون حساب (با لینک، و رمز اتاق اگر گذاشته باشید) وارد شوند.

## تفاوت با نسخهٔ Node.js
- ضبط جلسه روی رایانهٔ مدرس ذخیره می‌شود (فایل `.webm`)؛ آرشیو ضبط روی سرور نیست. پلنِ «ضبط» همچنان تعیین می‌کند چه کسی دکمهٔ ضبط را ببیند.
- پاورپوینت باید در PowerPoint با Save as ← PDF تبدیل شود. اگر مدرس وسط جلسه خارج شود، تازه‌واردها فایل را تا برگشت او نمی‌گیرند.
- نشست ورود در مرورگر (localStorage) نگه داشته می‌شود.
