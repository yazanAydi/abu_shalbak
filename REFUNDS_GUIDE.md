# إدارة الاسترجاعات

## السير

1. **الكاشير** يُنشئ طلب استرجاع من شاشة الكاشير. يُحفظ في جدول `refund_requests` بحالة **قيد المراجعة** (`pending`) و**لا** يُحدَّث المخزون ولا النقد حتى الموافقة.
2. **الموافقة** تتم عبر:
   - **تيليجرام** (إن وُجدت المتغيرات): رسالة للمدير مع أزرار ✅ موافقة / ❌ رفض
   - **لوحة الإدارة**: `/refund-approvals` (موافقات الاسترجاع)
3. عند **الموافقة**: يُنشأ سجل في `refunds` (حالة `approved`)، يُعاد المخزون، وتُسجَّل حركة النقد للاسترجاع النقدي.
4. عند **الرفض**: لا تغييرات على المخزون أو النقد.

الكاشير يرى نافذة انتظار تتحقق من الحالة كل 3 ثوانٍ حتى الموافقة أو الرفض.

## Telegram (اختياري — بوتان منفصلان)

```env
# بوت الاسترجاعات (BotFather #1)
TELEGRAM_REFUND_BOT_TOKEN=
TELEGRAM_REFUND_WEBHOOK_SECRET=

# بوت تنبيهات الصلاحية (BotFather #2)
TELEGRAM_EXPIRY_BOT_TOKEN=

# مجموعة الاسترجاعات (بوت #1) — رقم سالب من getUpdates
TELEGRAM_REFUND_CHAT_ID=
# مجموعة الصلاحية (بوت #2) — رقم سالب من getUpdates
TELEGRAM_EXPIRY_CHAT_ID=
# بديل اختياري إذا لم تُعرّف المتغيرين أعلاه
TELEGRAM_MANAGER_CHAT_ID=

# على localhost: TELEGRAM_USE_POLLING=1 لتفعيل أزرار الموافقة/الرفض بدون HTTPS
TELEGRAM_USE_POLLING=1

TELEGRAM_EXPIRY_ALERT_HOUR=8
```

- **الاسترجاعات** (بوت #1): رسالة فورية عند كل طلب. الكاشير ينتظر في نقطة البيع؛ عند الموافقة من التيليجرام تتحدّث شاشته خلال ~3 ثوانٍ.
- **localhost**: `TELEGRAM_USE_POLLING=1` — الخادم يسحب ضغطات الأزرار من تيليجرام (لا حاجة لـ ngrok).
- **إنتاج**: أوقف polling (`TELEGRAM_USE_POLLING=0`) وسجّل webhook على بوت الاسترجاع.
- **الصلاحية** (بوت #2): ملخص يومي للأصناف والدفعات القريبة من الانتهاء (عدد الأيام من إعدادات المتجر → `expiry_alert_days`). إرسال يدوي: `POST /api/telegram/send-expiry-alert` أو زر في إعدادات المتجر. للتفاصيل الكاملة (تقارير، دورة الحياة، ما لا يُنفَّذ تلقائياً): `docs/EXPIRATION_PROCESS.md`.

Webhook (بوت الاسترجاع فقط، للإنتاج): `POST /api/telegram/webhook/:secret`  
Callback: `refund:approve:<requestId>` | `refund:reject:<requestId>`

**إعداد يدوي:**

1. أنشئ **بوتين** عبر [@BotFather](https://t.me/BotFather) — واحد للاسترجاعات وواحد للصلاحية
2. أضف كل بوت إلى **مجموعة تيليجرام** (مجموعة الاسترجاعات / مجموعة الصلاحية) وأرسل رسالة في كل مجموعة
3. احصل على `chat_id` لكل مجموعة عبر `https://api.telegram.org/bot<TOKEN>/getUpdates` (الرقم سالب، مثل `-1002345678901`) — بوت الاسترجاع → `TELEGRAM_REFUND_CHAT_ID`، بوت الصلاحية → `TELEGRAM_EXPIRY_CHAT_ID`
4. **localhost:** `TELEGRAM_USE_POLLING=1` في `.env` ثم أعد تشغيل الخادم
5. **إنتاج:** سجّل webhook **لبوت الاسترجاع فقط**: `https://api.telegram.org/bot<REFUND_TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram/webhook/<REFUND_SECRET>`
6. أعد تشغيل الخادم بعد إضافة المتغيرات إلى `.env`

**توافق خلفي:** `TELEGRAM_BOT_TOKEN` و `TELEGRAM_WEBHOOK_SECRET` يعملان كبديل لبوت الاسترجاع إن لم تُعرّف المتغيرات الجديدة.

بدون تيليجرام: استخدم `/refund-approvals` فقط.

## API (ملخص)

| الطلب | المسار | من يصل |
|--------|--------|--------|
| POST | `/api/refund-requests` | كاشير — يُنشئ `pending` |
| GET | `/api/refund-requests/:id` | الكاشير صاحب الطلب أو مدير/محاسب |
| GET | `/api/refund-requests/pending` | مدير، محاسب |
| PUT | `/api/refund-requests/:id` | `{ status: approved \| rejected, review_notes }` |
| POST | `/api/refunds` | كاشير — توافق خلفي مع `refund-requests` |
| GET | `/api/refunds/summary` | مدير، محاسب — `pending` من `refund_requests` |
| GET | `/api/refunds` | سجل الاسترجاعات المكتملة |
| POST | `/api/telegram/webhook/:secret` | تيليجرام فقط |

## الواجهات

- POS: `PosRefundWaitingModal` — انتظار الموافقة
- Admin: [`frontend/src/pages/RefundApprovals.jsx`](frontend/src/pages/RefundApprovals.jsx) — `/refund-approvals`
- Admin: [`frontend/src/pages/RefundsPage.jsx`](frontend/src/pages/RefundsPage.jsx) — `/refunds` (سجل مكتمل)

## الملفات (خادم)

- [`backend/services/refundRequestService.js`](backend/services/refundRequestService.js)
- [`backend/routes/refundRequests.js`](backend/routes/refundRequests.js)
- [`backend/routes/telegram.js`](backend/routes/telegram.js)
- [`backend/utils/telegram.js`](backend/utils/telegram.js)
- [`backend/database/migrations/004_refund_requests.sql`](backend/database/migrations/004_refund_requests.sql)

## ملاحظات

- **نسبة الموافقة** = موافق / (موافق + مرفوض)؛ الطلبات المعلّقة لا تدخل المقام.
- الطلبات المعلّقة القديمة في `refunds` تُنقل تلقائياً إلى `refund_requests` عند الترقية.
