// اختبار HTTP كامل ضد خادم التطوير:
// إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع) →
// حذف → 404 → JSON تالف → config → cron
require("../lib/util").loadEnv();
const BASE = `http://localhost:${process.env.PORT || 3001}`;
const fs = require("fs");
const os = require("os");
const path = require("path");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}
async function j(method, p, body, raw) {
  const opts = { method };
  if (body !== undefined) {
    opts.body = raw ? body : JSON.stringify(body);
    opts.headers = raw ? { "Content-Type": "application/octet-stream" } : { "Content-Type": "application/json" };
  }
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* جسم غير JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  console.log(`== اختبار HTTP كامل ضد ${BASE} ==`);

  // 0) config
  const cfg = await j("GET", "/api/config");
  check("GET /api/config يعمل", cfg.status === 200 && cfg.json.version, JSON.stringify(cfg.json).slice(0, 80));

  // 1) إنشاء مهمة من روابط
  const create = await j("POST", "/api/jobs", {
    videos: [
      "https://www.w3schools.com/html/mov_bbb.mp4",
      "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
    ],
  });
  check("POST /api/jobs (روابط) يعيد 201", create.status === 201 && create.json.jobId, create.text.slice(0, 100));
  check("الاستجابة تحوي statusUrl و processUrl و expiresAt",
    Boolean(create.json.statusUrl && create.json.processUrl && create.json.expiresAt));
  const jobId = create.json.jobId;

  // 2) دمج متزامن
  const proc = await j("POST", `/api/jobs/${jobId}/process`);
  check("POST process يعيد 200 مع status=done", proc.status === 200 && proc.json.status === "done", proc.text.slice(0, 120));
  check("الناتج يحمل resolution و duration و size",
    Boolean(proc.json.resolution && proc.json.duration > 0 && proc.json.size > 0));

  // 3) بث مع Range → 206 + Content-Range
  const r0 = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=0-1023" } });
  check("بث Range يعيد 206", r0.status === 206, `status=${r0.status}`);
  check("ترويسة Content-Range صحيحة", (r0.headers.get("content-range") || "").startsWith("bytes 0-1023/"));
  const buf0 = Buffer.from(await r0.arrayBuffer());
  check("طول الجزء المطلوب صحيح", buf0.length === 1024);

  // 4) مهمة مختلطة: رابط + ملف حقيقي مرفوع بالأجزاء (نولّده بـ ffmpeg ثم نرفعه بجزأين)
  const { ffmpegBin } = require("../lib/merge");
  const tmpClip = path.join(os.tmpdir(), "http-test-clip.mp4");
  const g = require("child_process").spawnSync(ffmpegBin(), [
    "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", tmpClip,
  ], { stdio: "ignore" });
  if (g.status !== 0) throw new Error("فشل توليد مقطع الاختبار");
  const clipBuf = fs.readFileSync(tmpClip);
  const mixed = await j("POST", "/api/jobs", {
    sources: [
      { kind: "url", url: "https://www.w3schools.com/html/mov_bbb.mp4" },
      { kind: "file", name: "clip.mp4", size: clipBuf.length, mime: "video/mp4" },
    ],
  });
  check("مهمة مختلطة تُنشأ بحالة uploading", mixed.status === 201 && mixed.json.status === "uploading");
  const mJob = mixed.json.jobId;
  const half = Math.ceil(clipBuf.length / 2);
  const up1 = await j("POST", `/api/upload?job=${mJob}&seq=1&chunk=0`, clipBuf.subarray(0, half), true);
  const up2 = await j("POST", `/api/upload?job=${mJob}&seq=1&chunk=1`, clipBuf.subarray(half), true);
  check("رفع جزأين ثنائيين يعمل",
    up1.status === 200 && up1.json.received === half && up2.status === 200 && up2.json.received === clipBuf.length - half);
  const stMid = await j("GET", `/api/jobs/${mJob}`);
  check("بعد اكتمال الرفع الحالة queued", stMid.json.status === "queued", stMid.text.slice(0, 80));
  const procM = await j("POST", `/api/jobs/${mJob}/process`);
  check("دمج المهمة المختلطة يكتمل", procM.status === 200 && procM.json.status === "done", procM.text.slice(0, 120));

  // 5) حذف ثم 404
  const del = await j("DELETE", `/api/jobs/${mJob}`);
  check("حذف المهمة يعمل", del.status === 200 && del.json.ok === true);
  const gone = await j("GET", `/api/jobs/${mJob}`);
  check("الاستعلام بعد الحذف يعيد 404 برسالة عربية", gone.status === 404 && /غير موجود/.test(gone.json.error));

  // 6) JSON تالف
  const bad = await j("POST", "/api/jobs", "{not-json", true);
  check("JSON تالف يعيد 400", bad.status === 400 && Boolean(bad.json.error), bad.text.slice(0, 80));

  // 7) قائمة مصادر فارغة/ناقصة
  const few = await j("POST", "/api/jobs", { videos: ["https://example.com/a.mp4"] });
  check("مصدر واحد يُرفض برسالة عربية", few.status === 400 && /مقطعَين/.test(few.json.error));

  // 8) أكثر من 10 مصادر يُرفض
  const many = await j("POST", "/api/jobs", { videos: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) });
  check("أكثر من 10 مصادر يُرفض", many.status === 400 && /10/.test(many.json.error));

  // 9) رابط غير صالح
  const badUrl = await j("POST", "/api/jobs", { videos: ["ftp://x/y.mp4", "https://example.com/a.mp4"] });
  check("رابط غير http يُرفض", badUrl.status === 400 && /http/.test(badUrl.json.error));

  // 10) طريقة خاطئة
  const wrong = await j("PUT", `/api/jobs/${jobId}`);
  check("PUT يُرفض بـ 405", wrong.status === 405);

  // 11) process على مهمة غير موجودة → 404
  const p404 = await j("POST", "/api/jobs/doesnotexist/process");
  check("process لمهمة غير موجودة → 404", p404.status === 404);

  // 12) cron
  const cron = await j("GET", "/api/cron");
  check("GET /api/cron يعمل", cron.status === 200 && cron.json.ok === true);

  // تنظيف مهمة الاختبار الأولى من الخدمة
  await j("DELETE", `/api/jobs/${jobId}`);

  console.log(`\nالنتيجة: ${passed} نجح، ${failed} فشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("خطأ غير متوقع:", e); process.exit(1); });
