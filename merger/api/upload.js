// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء ثنائية ≤4MB (octet-stream)
// مع إعادة المحاولة من الواجهة — الاستبدال الصامت عند إعادة رفع نفس الجزء
const db = require("../lib/db");
const storage = require("../lib/storage");
const { CONFIG, errJson, json } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method !== "POST") { errJson(res, 405, "الطريقة غير مسموحة — استخدم POST"); return; }

  const jobId = req.query.job;
  const seq = parseInt(req.query.seq, 10);
  const chunk = parseInt(req.query.chunk, 10);
  if (!jobId || !Number.isInteger(seq) || !Number.isInteger(chunk)) {
    errJson(res, 400, "معاملات ناقصة — مطلوب job و seq و chunk");
    return;
  }

  const job = await db.getJob(jobId);
  if (!job) { errJson(res, 404, "المهمة غير موجودة"); return; }
  if (job.status !== "uploading" && job.status !== "queued") {
    errJson(res, 409, "المهمة لم تعد في حالة الرفع");
    return;
  }
  // seq هو فهرس المصدر في قائمة المهمة كاملة (بين الروابط والملفات)
  const src = job.sources[seq];
  if (!src || src.kind !== "file") {
    errJson(res, 404, "لا يوجد مصدر ملف بهذا الرقم في المهمة");
    return;
  }

  // اقرأ الجسم الثنائي مع فرض حد 4MB
  const limit = CONFIG.UPLOAD_CHUNK_BYTES + 1024 * 1024;
  const parts = [];
  let size = 0;
  await new Promise((resolve) => {
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(); return; }
      parts.push(c);
    });
    req.on("end", resolve);
    req.on("error", resolve);
  });
  if (!size) { errJson(res, 400, "جسم فارغ — البيانات الثنائية مطلوبة"); return; }
  if (size > CONFIG.UPLOAD_CHUNK_BYTES) { errJson(res, 413, "حجم الجزء يتجاوز 4MB"); return; }

  await storage.upsertSourceChunk(jobId, seq, chunk, Buffer.concat(parts));

  // إن اكتملت كل الأجزاء غيّر الحالة إلى queued
  const sources = await db.listSources(jobId);
  let allComplete = true;
  for (const s of sources) {
    if (s.kind !== "file") continue;
    const stats = await storage.sourceChunkStats(jobId, s.seq);
    if (s.size != null && stats.bytes < s.size) { allComplete = false; break; }
  }
  if (allComplete && job.status === "uploading") {
    await db.updateJob(jobId, { status: "queued" });
  }

  json(res, 200, { ok: true, seq, chunk, received: size });
};
