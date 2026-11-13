// POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن): سحب المصادر → ترميز → حفظ الناتج
// التقدم: 0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال — يُكتب في القاعدة فورًا
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../../../lib/db");
const storage = require("../../../lib/storage");
const { mergeVideos } = require("../../../lib/merge");
const { json, errJson } = require("../../../lib/util");

module.exports = async (req, res) => {
  if (req.method !== "POST") { errJson(res, 405, "الطريقة غير مسموحة — استخدم POST"); return; }
  const id = req.query.id;

  const job = await db.getJob(id);
  if (!job) { errJson(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)"); return; }
  if (job.status === "done") {
    json(res, 200, doneReply(job));
    return;
  }
  if (job.status === "processing") {
    json(res, 202, { status: "processing", progress: job.progress });
    return;
  }
  if (job.status === "failed") {
    errJson(res, 409, `المهمة فشلت سابقًا: ${job.error || "سبب غير معروف"}`);
    return;
  }

  // queued | uploading → تحقق من اكتمال ملفات الرفع قبل البدء
  const sources = await db.listSources(id);
  for (const s of sources) {
    if (s.kind !== "file") continue;
    const stats = await storage.sourceChunkStats(id, s.seq);
    if (s.size != null && stats.bytes !== s.size) {
      errJson(res, 409, `المصدر ${s.seq + 1} غير مكتمل الرفع (${stats.bytes}/${s.size} بايت)`);
      return;
    }
  }

  await db.updateJob(id, { status: "processing", progress: 0, error: null });

  const outPath = path.join(os.tmpdir(), `out-${id}.mp4`);
  try {
    // جهّز buffers الملفات المرفوعة (من صفوف Turso) وأكمل قائمة المصادر
    const prepared = [];
    for (const s of sources) {
      if (s.kind === "url") {
        prepared.push({ kind: "url", url: s.url });
      } else {
        const buf = await storage.readSourceBuffer(id, s.seq);
        if (!buf) throw new Error(`المصدر ${s.seq + 1} غير موجود في التخزين`);
        prepared.push({ kind: "file", buffer: buf });
      }
    }

    const result = await mergeVideos(prepared, outPath, async (pct) => {
      try { await db.updateJob(id, { progress: pct }); } catch { /* التقدم ليس حرجًا */ }
    });

    // احفظ الناتج كصفوف 2MB ثم احذف أجزاء المصادر — الناتج فقط هو المطلوب
    const buffer = fs.readFileSync(outPath);
    await storage.writeChunks("output_chunks", ["job_id"], [id], buffer);
    await storage.deleteSourceChunks(id);

    const base = `https://${req.headers.host || "localhost"}`;
    const videoUrl = `${base}/api/jobs/${id}/video`;
    const downloadUrl = `${videoUrl}?download=1`;
    await db.updateJob(id, {
      status: "done",
      progress: 100,
      videoUrl,
      downloadUrl,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
    });

    json(res, 200, {
      status: "done",
      videoUrl,
      downloadUrl,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: (await db.getJob(id)).expiresAt,
    });
  } catch (e) {
    // فشل معلن واضح — ليس انهيارًا: رسالة عربية + حالة failed
    await db.updateJob(id, { status: "failed", error: e.message.slice(0, 500) });
    errJson(res, 500, e.message.slice(0, 500));
  } finally {
    try { fs.rmSync(outPath, { force: true }); } catch { /* تجاهل */ }
  }
};

function doneReply(job) {
  return {
    status: "done",
    videoUrl: job.videoUrl,
    downloadUrl: job.downloadUrl,
    size: job.size,
    duration: job.duration,
    resolution: job.resolution,
    expiresAt: job.expiresAt,
  };
}
