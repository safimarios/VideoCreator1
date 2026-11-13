# مولد الوسائط MCP — Media Generator MCP

خادم MCP لتوليد **الصور** و**الفيديو** (بصوت متزامن أصلي) و**دمج المقاطع**، مع لوحة إدارة عربية RTL، ونظام مفاتيح متسلسلة مع **تبديل تلقائي صامت** عند أي خطأ أو نفاد رصيد.

- **المستودع:** https://github.com/safimarios/VideoCreator1
- **المجلد الجذر:** تطبيق Next.js (خادم MCP + لوحة الإدارة)
- **المجلد `merger/`:** خدمة دمج الفيديو المستقلة (البرومبت الثاني) — لها README خاص داخل المجلد

---

## المكونات

| الجزء | المسار | الوظيفة |
|---|---|---|
| خادم MCP | `/mcp` | 5 أدوات عبر Streamable HTTP (SDK رسمي) |
| لوحة الإدارة | `/` | إدارة المفاتيح + متابعة المهام حية + إعدادات الربط |
| صحة النظام | `/api/health` | فحص Turso + الموديلات + خدمة الدمج |
| إدارة المفاتيح | `/api/keys` | إضافة/تعطيل/حذف — المفاتيح مُقنَّعة دائمًا |
| المهام | `/api/tasks` | إحصائيات وأحدث المهام للوحة |

### الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت أصلي، image-to-video اختياري) |
| `merge_videos` | دمج حتى 10 مقاطع عبر `urls` أو `task_ids` بالترتيب |
| `get_task` | تتبع أي مهمة بمعرفها (تحديث حي من المزود/خدمة الدمج) |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

---

## قواعد جوهرية مطبقة

1. **روابط فقط** — لا يُنزَّل أي ملف وسائط إلى السيرفر؛ الروابط فقط تُخزَّن في Turso.
2. **ترتيب تسلسلي صارم** للمفاتيح حسب الإضافة (`created_at ASC, id ASC`) — ليس round-robin.
3. **لا توقف عند نفاد الرصيد** — انتقال تلقائي للمفتاح التالي واستئناف **نفس المهمة بنفس `task_id`**.
4. **النموذج لا يرى أخطاء المفاتيح/الرصيد أبدًا** — التبديل صامت تمامًا.
5. فشل على كل المفاتيح → المهمة تبقى `processing` وتُعاد محاولتها مع كل `get_task` (تهدئة ~45 ثانية).
6. أخطاء خدمة الدمج المعلنة (4xx/5xx) = فشل حتمي؛ أخطاء شبكتنا = مؤقتة.
7. ملفات الدمج تُحذف بعد 24 ساعة — مذكورة في وصف الأداة وتعليمات الخادم.
8. المفاتيح مُقنَّعة دائمًا في كل الاستجابات (`أول 7 + •••••••• + آخر 4`).

---

## التشغيل المحلي

```bash
# 1) المتغيرات البيئية — انسخ .env.example إلى .env.local واملأ القيم
cp .env.example .env.local

# 2) التثبيت والتشغيل
npm install
npm run dev          # أو: npm run build && npm start

# 3) خدمة الدمج محليًا (مجلد منفصل)
cd merger && npm install && node dev-server.js   # على المنفذ 3001
```

ثم افتح `http://localhost:3000` وأضف مفتاحًا واحدًا على الأقل (kie.ai أو CometAPI).

### اختبار MCP بالـ curl

```bash
# تهيئة جلسة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'
# خذ mcp-session-id من الترويسة ثم أرسل notifications/initialized ثم tools/list أو tools/call
```

---

## متغيرات البيئة (Vercel → Settings → Environment Variables)

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | `libsql://<db>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | نعم | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | نعم | رابط خدمة الدمج المنشورة (مثل `https://video-merger-xxx.vercel.app`) |
| `MCP_ACCESS_TOKEN` | اختياري | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` | اختياري | تجاوز اسم موديل الصور لدى kie |
| `KIE_VIDEO_MODEL` | اختياري | تجاوز اسم موديل الفيديو لدى kie |
| `COMETAPI_IMAGE_MODEL` | اختياري | تجاوز اسم موديل الصور لدى CometAPI |
| `COMETAPI_VIDEO_MODEL` | اختياري | تجاوز اسم موديل الفيديو لدى CometAPI |

> ملاحظة مقاسة: اسم موديل الفيديو لدى kie.ai هو بالشرطات `grok-imagine-video-1-5-preview` (التوثيق يذكر نقاطًا لكن الـ API الحي يرفضها) — الافتراضي هنا مضبوط على القيمة الصحيحة.

## إنشاء قاعدة Turso

```bash
turso db create <name>
turso db show <name> --url        # ← TURSO_DATABASE_URL
turso db tokens create <name>     # ← TURSO_AUTH_TOKEN
```

الجداول تُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا حاجة لأي أداة migrations.

---

## النشر على Vercel (مشروعان)

1. **اربط المستودع** بـ Vercel (Add New → Project).
2. **مشروع لوحة MCP:** Root Directory = **`.` (الجذر)** — أضف `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` و `MERGER_API_BASE` ثم Deploy.
3. **مشروع خدمة الدمج:** Add New Project من نفس المستودع مع **Root Directory = `merger`** — أضف متغيري Turso ثم Deploy (vercel.json يجعل `maxDuration=300` ويجدول `/api/cron` يوميًا).
4. انسخ رابط مشروع الدمج وضعه في `MERGER_API_BASE` لمشروع لوحة MCP، ثم أعد النشر.

## ربط العملاء بـ `/mcp`

- **ChatGPT:** Settings → Connectors → Create → Custom MCP server → ضع `<origin>/mcp` في «Server URL».
- **Claude Desktop:** في `claude_desktop_config.json`:
  ```json
  {"mcpServers": {"media-generator": {"type": "http", "url": "<origin>/mcp"}}}
  ```
- **Cursor / Windsurf / Cline:** نفس الصيغة في `mcp.json`.

لوحة الإدارة تعرض هذه الصيغ جاهزة للنسخ لكل عميل.

---

## الاختبارات التي اجتازها المشروع

- بناء نظيف: `tsc --noEmit` + `next build` بلا أخطاء.
- MCP: initialize / tools/list (5 أدوات) / tools/call بالـ curl.
- **توليد صورة حقيقي e2e** بمفتاح kie → رابط صورة يعمل (HTTP 200).
- **توليد فيديو حقيقي e2e** → task_id ثم رابط MP4 يعمل (206/video/mp4).
- **تبديل تسلسلي:** مفتاح خاطئ أولًا → عُطّل تلقائيًا (`disabled`) والمهمة اكتملت على المفتاح الصحيح دون أي ذكر للمفاتيح للعميل.
- **انتظار مفتاح:** مهمة بقيت `processing` ثم اكتملت تلقائيًا بعد تفعيل مفتاح من الواجهة (نفس task_id).
- تصنيف الأخطاء: 21 اختبار وحدة (402→exhausted قبل 400، 401→disabled، params، temporary، model→provider، الأسماء البديلة، الإخفاء).
- **دمج e2e عبر MCP** بمقطعين عامين → MP4 يعمل (h264، 640x360، المدة = المجموع) + دمج عبر `task_ids` بالترتيب الصحيح.
- رفض الدمج: أقل من مقطعين وأكثر من 10 برسائل عربية.
- خدمة الدمج: 12 اختبار وحدة + 21 اختبار HTTP (Range 206، رفع أجزاء، حدود، حذف شامل، 404، JSON تالف، 405).
