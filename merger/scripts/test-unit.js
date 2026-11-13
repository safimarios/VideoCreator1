// اختبار وحدات محرك الدمج والتخزين (بدون HTTP):
// 1) توليد مقطعَين مختلفي الدقة بـ ffmpeg (أحدهما بلا صوت)
// 2) دمجهما والتحقق: الاكتمال، الدقة = أكبر دقة، المدة ≈ المجموع، وجود صوت
// 3) تخزين Turso والاسترجاع بتطابق sha256
// 4) مسار رفع الأجزاء (upsert + إحصاءات)
// 5) الحذف الشامل
require("../lib/util").loadEnv();
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { probeSource, mergeVideos } = require("../lib/merge");
const storage = require("../lib/storage");
const db = require("../lib/db");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}

function genClip(out, w, h, dur, withAudio) {
  const args = ["-y", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=30:duration=${dur}`];
  if (withAudio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  const r = spawnSync(require("../lib/merge").ffmpegBin(), args, { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`فشل توليد المقطر ${out}`);
}

async function main() {
  console.log("== اختبار وحدات محرك الدمج والتخزين ==");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mu-"));

  // 1) توليد المقاطع
  const clipA = path.join(tmp, "a.mp4"); genClip(clipA, 320, 240, 3, true);   // صغير + صوت
  const clipB = path.join(tmp, "b.mp4"); genClip(clipB, 640, 360, 2, false);  // أكبر + بلا صوت
  const pa = await probeSource(clipA), pb = await probeSource(clipB);
  check("توليد مقطعين مختلفي الدقة", pa.width === 320 && pb.width === 640);
  check("المقطع B بلا صوت", pb.hasAudio === false);

  // 2) الدمج المباشر عبر المحرك
  const out = path.join(tmp, "out.mp4");
  const result = await mergeVideos(
    [{ kind: "file", buffer: fs.readFileSync(clipA) }, { kind: "file", buffer: fs.readFileSync(clipB) }],
    out,
    () => {}
  );
  const po = await probeSource(out);
  check("اكتمال الدمج (الناتج موجود وغير فارغ)", result.size > 0);
  check(`الدقة = أكبر دقة مدخل (${result.resolution})`, po.width === 640 && po.height === 360);
  const durOk = Math.abs(po.duration - 5) < 1.2; // 3+2 مع سماحية ترميز
  check(`المدة ≈ مجموع المدخلات (${po.duration.toFixed(2)}≈5)`, durOk);
  check("وجود مسار صوت في الناتج", po.hasAudio === true);

  // 3) تخزين Turso والاسترجاع بتطابق sha256
  const jobId = "unit-" + crypto.randomBytes(4).toString("hex");
  const payload = crypto.randomBytes(5 * 1024 * 1024 + 12345); // حجم غير مضاعف لـ 2MB
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  await db.insertJob({ id: jobId, status: "processing", sources: [], expiresAt: new Date(Date.now() + 3600e3).toISOString() });
  const rows = await storage.writeChunks("source_chunks", ["job_id", "seq"], [jobId, 0], payload);
  check(`تقسيم Blob إلى صفوف 2MB (${rows} صف)`, rows === 3);
  const back = await storage.readSourceBuffer(jobId, 0);
  const hashBack = crypto.createHash("sha256").update(back).digest("hex");
  check("استرجاع مطابق sha256", hash === hashBack);

  // 4) مسار رفع الأجزاء
  await storage.upsertSourceChunk(jobId, 1, 0, Buffer.from("hello-hello"));
  await storage.upsertSourceChunk(jobId, 1, 0, Buffer.from("replaced")); // إعادة محاولة = استبدال
  const st = await storage.sourceChunkStats(jobId, 1);
  check("رفع أجزاء مع استبدال عند الإعادة", st.rows === 1 && st.bytes === 8);

  // 5) الحذف الشامل
  await db.deleteJobCascade(jobId);
  const gone = await db.getJob(jobId);
  check("الحذف الشامل (المهمة غير موجودة)", gone === null);
  const emptyBuf = await storage.readSourceBuffer(jobId, 0);
  check("أجزاء المصدر حُذفت", emptyBuf === null);

  // حدود الحجم: مصدر أكبر من SOURCE_MAX_MB (محاكاة عبر فرض حد صغير على التنزيل مباشرة)
  const { CONFIG } = require("../lib/util");
  const { downloadSource } = require("../lib/merge");
  const realLimit = CONFIG.SOURCE_MAX_MB;
  CONFIG.SOURCE_MAX_MB = 0; // 0MB — أي تنزيل يُرفض فورًا
  try {
    await downloadSource("https://www.w3schools.com/html/mov_bbb.mp4", path.join(tmp, "x.mp4"), () => {});
    check("رفض مصدر يتجاوز حد الحجم", false);
  } catch (e) {
    check("رفض مصدر يتجاوز حد الحجم", /يتجاوز الحد/.test(e.message), e.message.slice(0, 80));
  }
  CONFIG.SOURCE_MAX_MB = realLimit;

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nالنتيجة: ${passed} نجح، ${failed} فشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("خطأ غير متوقع:", e); process.exit(1); });
