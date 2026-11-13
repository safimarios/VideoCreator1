// GET/DELETE /api/jobs/<id> — حالة المهمة + التقدم، أو حذف شامل فوري
const db = require("../../lib/db");
const { json, errJson } = require("../../lib/util");

module.exports = async (req, res) => {
  const id = req.query.id;

  if (req.method === "GET") {
    const job = await db.getJob(id);
    if (!job) { errJson(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)"); return; }
    // الجسم قد يحوي error — العميل المدافع يعامله فشلًا حتى بدون status
    json(res, 200, {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      videoUrl: job.videoUrl,
      downloadUrl: job.downloadUrl,
      size: job.size,
      duration: job.duration,
      resolution: job.resolution,
      expiresAt: job.expiresAt,
      ...(job.error ? { error: job.error } : {}),
    });
    return;
  }

  if (req.method === "DELETE") {
    const job = await db.getJob(id);
    if (!job) { errJson(res, 404, "المهمة غير موجودة"); return; }
    await db.deleteJobCascade(id);
    json(res, 200, { ok: true });
    return;
  }

  errJson(res, 405, "الطريقة غير مسموحة — استخدم GET أو DELETE");
};
