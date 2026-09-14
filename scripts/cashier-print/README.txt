أبو شلبك — طباعة الإيصالات (جهاز الكاشير)

1) انسخ هذا المجلد إلى جهاز الكاشير (فلاشة USB كافية).
2) انقر نقراً مزدوجاً: Install.bat
3) اختر طابعة RONGTA من القائمة.
4) أدخل عنوان نقطة البيع، مثال: http://192.168.1.10:3000/pos
5) انتظر نتيجة التشغيل. ظهور «جاهز» يعني أن المساعد يعمل — وليس أن الورق طُبع.

للتطوير على جهاز بلا طابعة إيصالات: فعّل «اختبار بدون طابعة — حفظ PDF».
عندها يُحفظ الإيصال كملف PDF ولا تُرسل مهمة طباعة إلى ويندوز.
لإلغاء وضع الاختبار أعد التثبيت بدون هذا الخيار واختر طابعة حقيقية.

لا يحتاج الجهاز Node أو npm أو المشروع الكامل.
لا يشغّل دوكر ولا قاعدة بيانات.

Abo Shalbak receipt helper (cashier PC)

Double-click Install.bat. Pick the USB printer. Enter the POS URL.
Success means the helper is running on http://127.0.0.1:17892 — not that paper printed.

Dev PC with no receipt printer: check "اختبار بدون طابعة — حفظ PDF".
That writes RECEIPT_PRINT_TEST_MODE=save and stores PDFs under tmp\receipt-test.
Uncheck it on the next install to return to real printing.

Updates: run Install.bat again from a new package. Your printer/URL are kept unless you change them.
