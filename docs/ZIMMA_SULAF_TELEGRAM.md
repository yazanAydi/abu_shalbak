# ذمم وسلف — Telegram والموافقات

## السير

### ذمم (بيع على الذمة)

1. **الكاشير** يُكمل البيع ويختار دفع **ذمة** (أو دفع مختلط يتضمن ذمة).
2. يُحفظ الطلب في `on_account_requests` بحالة **قيد المراجعة** — **لا** يُخصم مخزون ولا يُحدَّث رصيد العميل حتى الموافقة.
3. **الموافقة** عبر:
   - **تيليجرام** (بوت الذمة): رسالة مع أزرار ✅ موافقة / ❌ رفض
   - **لوحة الإدارة**: `/on-account-approvals`
4. عند **الموافقة**: تُنشأ الفاتورة، يُخصم المخزون، ويُزاد رصيد العميل.
5. الكاشير يرى نافذة انتظار حتى القرار؛ عند الموافقة تُطبع الفاتورة تلقائياً.

### سلف (سلفة موظف)

1. **الكاشير** يفتح **سلف** من شريط أدوات نقطة البيع، يُدخل **اسم الموظف** و**المبلغ**.
2. يُحفظ في `advance_requests` بحالة **قيد المراجعة** — **لا** يُصرف نقد من الدرج حتى الموافقة.
3. **الموافقة** عبر:
   - **تيليجرام** (بوت السلف)
   - **لوحة الإدارة**: `/advance-approvals`
4. عند **الموافقة**: يُسجَّل خروج نقد من الدرج (`shift_cash_movements` نوع `advance`) إذا كان النقد كافياً.

## Telegram — بوتان جديدان

أضف إلى `.env.development` أو `.env.store`:

```env
# بوت الذمة (موافقة مبيعات على الذمة)
TELEGRAM_ZIMMA_BOT_TOKEN=
TELEGRAM_ZIMMA_CHAT_ID=
TELEGRAM_ZIMMA_WEBHOOK_SECRET=

# بوت السلف (موافقة سلف الموظفين)
TELEGRAM_SULAF_BOT_TOKEN=
TELEGRAM_SULAF_CHAT_ID=
TELEGRAM_SULAF_WEBHOOK_SECRET=

# على localhost: تفعيل polling لجميع بوتات الموافقة (استرجاع + ذمة + سلف)
TELEGRAM_USE_POLLING=1
```

### إعداد يدوي (خطوة بخطوة)

1. أنشئ **بوتين** عبر [@BotFather](https://t.me/BotFather):
   - بوت الذمة (مثلاً `abo_shalbak_zimma_bot`)
   - بوت السلف (مثلاً `abo_shalbak_sulaf_bot`)
2. أنشئ مجموعتين: **موافقات الذمة** و**موافقات السلف** — أضف كل بوت وأرسل رسالة.
3. احصل على `chat_id` لكل مجموعة:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. ضع القيم في `.env` وأعد تشغيل الخادم.
5. **localhost:** `TELEGRAM_USE_POLLING=1` — لا حاجة لـ webhook.
6. **إنتاج:** سجّل webhook لكل بوت:
   - الذمة: `https://api.telegram.org/bot<ZIMMA_TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram/webhook/zimma/<ZIMMA_SECRET>`
   - السلف: `https://api.telegram.org/bot<SULAF_TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram/webhook/sulaf/<SULAF_SECRET>`

Callback data:
- `zimma:approve:<id>` | `zimma:reject:<id>`
- `sulaf:approve:<id>` | `sulaf:reject:<id>`

بدون تيليجرام: استخدم صفحات الموافقات في لوحة الإدارة فقط.

## API (ملخص)

| الطلب | المسار | من يصل |
|--------|--------|--------|
| POST | `/api/checkout` | كاشير — إذا فيه ذمة يُرجع `pending_approval` |
| GET | `/api/on-account-requests/pending` | مدير/محاسب |
| PUT | `/api/on-account-requests/:id` | `{ status: approved \| rejected }` |
| GET | `/api/on-account-requests/:id` | الكاشير صاحب الطلب أو مدير |
| POST | `/api/advance-requests` | كاشير — `{ employee_name, amount, notes? }` |
| GET | `/api/advance-requests/pending` | مدير/محاسب |
| PUT | `/api/advance-requests/:id` | موافقة/رفض |
| POST | `/api/telegram/webhook/zimma/:secret` | تيليجرام فقط |
| POST | `/api/telegram/webhook/sulaf/:secret` | تيليجرام فقط |

## الواجهات

- POS: زر **سلف** + نافذة انتظار عند بيع ذمة
- Admin: [`OnAccountApprovals.jsx`](frontend/src/pages/OnAccountApprovals.jsx) — `/on-account-approvals`
- Admin: [`AdvanceApprovals.jsx`](frontend/src/pages/AdvanceApprovals.jsx) — `/advance-approvals`

## الملفات (خادم)

- [`backend/services/onAccountRequestService.js`](backend/services/onAccountRequestService.js)
- [`backend/services/advanceRequestService.js`](backend/services/advanceRequestService.js)
- [`backend/services/checkoutSaleService.js`](backend/services/checkoutSaleService.js)
- [`backend/routes/onAccountRequests.js`](backend/routes/onAccountRequests.js)
- [`backend/routes/advanceRequests.js`](backend/routes/advanceRequests.js)
- [`backend/utils/telegram.js`](backend/utils/telegram.js) — بوتا الذمة والسلف

## ملاحظات

- موافقات الذمة تتطلب **عميلاً** وتحترم **حد الائتمان** عند إنشاء الطلب.
- موافقات السلف ترفض الصرف إذا **النقد في الدرج غير كافٍ** (`INSUFFICIENT_CASH`).
- يُستخدم نفس إعداد `refund_telegram_manager_user_id` لمن يُنسب إليه قرار التيليجرام.
