# خدمة دمج الفيديو — Video Merger API v2

واجهة برمجية عامة (بلا تسجيل دخول، CORS مفتوح) لدمج عدة مقاطع فيديو في مقطع MP4 واحد عالي الجودة، جاهزة للنشر على Vercel. تشغّل `ffmpeg` داخل الدالة وتخزن كل شيء في **Turso** (لا S3 ولا خدمات خارجية).

- **المخرجات:** MP4 (H.264 CRF 18 + AAC 192k/44100Hz، `+faststart`) حتى 1080p/30fps — ثابتة بلا معاملات resolution/fps.
- **التوحيد:** scale+pad إلى أكبر دقة بين المدخلات (سقف 1920×1080، أبعاد زوجية)، `fps=30, setsar=1, format=yuv420p` ثم `concat`.
- **مصدر بلا صوت؟** يُضاف مسار صامت `anullsrc` بنفس مدته بدل الفشل.
- **الصلاحية:** كل ملفات المهمة تُحذف تلقائيًا بعد **24 ساعة** (تنظيف كسول + `/api/cron` يومي).

## الحدود (قابلة للضبط بمتغيرات البيئة)

| الحد | الافتراضي |
|---|---|
| عدد المقاطع | 10 كحد أقصى |
| حجم كل مصدر | 200MB |
| حجم الناتج | 150MB |
| مجموع المدد | 600 ثانية |
| حجم جزء الرفع | 4MB (حد طلبات Vercel ≈ 4.5MB) |

## واجهة API

| Method | Endpoint | الوظيفة |
|---|---|---|
| POST | `/api/jobs` | إنشاء مهمة — `{"videos":["رابط1","رابط2"]}` أو `{"sources":[{kind,url\|name,size,mime}]}` → `201 {jobId,status,statusUrl,processUrl,expiresAt[,uploads[],uploadChunkBytes]}` |
| POST | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء ثنائية ≤4MB (`application/octet-stream`) مع استبدال عند إعادة المحاولة |
| POST | `/api/jobs/<id>/process` | تنفيذ الدمج متزامنًا (~10–15 ثانية) → `{status:"done",videoUrl,downloadUrl,size,duration,resolution,expiresAt}` — قيد المعالجة → `202` |
| GET | `/api/jobs/<id>` | الحالة + التقدم 0–100 + الرابط عند الاكتمال (قد يحوي `error` بدون `status` → عامله فشلًا) |
| GET | `/api/jobs/<id>/video` | بث الناتج بدعم **Range** (206 + Content-Range) — `?download=1` للتحميل |
| DELETE | `/api/jobs/<id>` | حذف شامل فوري (المهمة + المصادر + كل الأجزاء) |
| GET | `/api/config` | الحدود العامة + version (لفحص الجهوزية) |
| GET | `/api/cron` | حذف المهام المنتهية (مجدول يوميًا في vercel.json) |

حالات المهمة: `queued → (uploading) → processing → done | failed` مع عمود `progress` (0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال).

الأخطاء دائمًا `{"error":"..."}` برسائل عربية: 400 مدخلات تالفة، 404 غير موجود، 409 حالة غير مناسبة، 413 تجاوز الحجم، 405 طريقة خاطئة.

### أمثلة curl

```bash
BASE=https://<your-merger>.vercel.app

# إنشاء مهمة من روابط
curl -X POST $BASE/api/jobs -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# → 201 {"jobId":"...","status":"queued","processUrl":"...","expiresAt":"..."}

# تنفيذ الدمج (متزامن)
curl -X POST $BASE/api/jobs/<jobId>/process
# → {"status":"done","videoUrl":"...","downloadUrl":"...","size":...,"duration":...,"resolution":"640x360"}

# الاستعلام عن الحالة
curl $BASE/api/jobs/<jobId>

# تحميل الناتج
curl -o merged.mp4 "$BASE/api/jobs/<jobId>/video?download=1"

# رفع ملف من الجهاز بأجزاء 4MB (مثال مبدئي)
curl -X POST "$BASE/api/jobs" -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"b.mp4","size":10485760,"mime":"video/mp4"}]}'
# ثم ارفع كل جزء: curl -X POST "$BASE/api/upload?job=<id>&seq=1&chunk=<k>" --data-binary @chunk -H "Content-Type: application/octet-stream"

# حذف فوري
curl -X DELETE $BASE/api/jobs/<jobId>
```

## البنية

```
merger/
├── api/                 # دوال Vercel Serverless (Node.js خالص CommonJS)
│   ├── jobs.js            # POST /api/jobs
│   ├── upload.js          # POST /api/upload
│   ├── config.js          # GET /api/config
│   ├── cron.js            # GET /api/cron
│   └── jobs/[id]/         # [id].js + process.js + video.js
├── lib/                 # المنطق
│   ├── db.js              # Turso: المخطط + عمليات المهام (CREATE TABLE IF NOT EXISTS)
│   ├── storage.js         # Blobs: صفوف 2MB، قراءة بصفحات 8، قراءة مجال للـ Range
│   ├── merge.js           # ffprobe + filter_complex + ffmpeg -progress + ensureExecutable
│   ├── turso-client.js    # عميل Turso واحد
│   └── util.js            # الحدود + الردود + تحميل .env يدويًا
├── public/index.html    # الواجهة العربية RTL (ثيم داكن سماوي/بنفسجي)
├── scripts/             # اختبارات: test-unit.js + test-http.js
├── dev-server.js        # خادم تطوير يحاكي Vercel (يحل المسارات الديناميكية إلى req.query)
└── vercel.json          # maxDuration 300 لكل الدوال + cron يومي
```

## التشغيل المحلي

```bash
cp .env.example .env      # ثم ضع متغيري Turso الحقيقيين
npm install
npm run dev               # http://localhost:3001
npm run test:unit         # 12 اختبار وحدة (محرك الدمج + التخزين)
npm run test:http         # 21 اختبار HTTP ضد خادم التطوير
```

## النشر على Vercel

1. اربط المستودع بمشروع جديد في Vercel واضبط **Root Directory = `merger`**.
2. أضف متغيرَي البيئة `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (نفس قاعدة Turso أو قاعدة منفصلة إن رغبت).
3. Deploy — `vercel.json` يضبط `maxDuration: 300` ويجدول `/api/cron` يوميًا (تنظيف المنتهي).
4. لا ملفات دائمة: المعالجة في `/tmp` فقط وتُنظف في `finally`.

## متغيرات البيئة

| المتغير | إلزامي | الافتراضي |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | — |
| `TURSO_AUTH_TOKEN` | نعم | — |
| `MAX_SOURCES` | لا | 10 |
| `SOURCE_MAX_MB` | لا | 200 |
| `OUTPUT_MAX_MB` | لا | 150 |
| `MAX_TOTAL_DURATION_SEC` | لا | 600 |
| `FFMPEG_PRESET` | لا | medium |
| `PORT` (محلي فقط) | لا | 3001 |

## حدود الخطة المجانية التي يجب معرفتها

- **مدة الدالة:** خطة Hobby تسمح حتى 60 ثانية افتراضيًا (وحدنا يطلب `maxDuration: 300` — متاح على Hobby وPro للمهام الطويلة). الدمج المتزامن يحتاج وقتًا يتناسب مع طول المقاطع.
- **حجم الطلب:** ≈ 4.5MB — لهذا تُرفع الملفات أجزاءً 4MB من الواجهة تلقائيًا.
- **حجم قاعدة Turso:** الخطة المجانية حتى 500MB — الناتج يُخزن فيها فتُحذف تلقائيًا بعد 24 ساعة لتحرير المساحة.
- **التنزيل من URLs:** يجب أن تكون روابط عامة مباشرة (مصادر ترفض التحميل تفشل فشلًا حتميًا).
