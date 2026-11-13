// POST /api/jobs — إنشاء مهمة دمج (روابط مباشرة أو مصادر ملفات تُرفع لاحقًا بالأجزاء)
const db = require("../lib/db");
const { CONFIG, json, errJson, readJsonBody, expiryDate, jobId } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { json(res, 204, {}); return; }
  if (req.method !== "POST") { errJson(res, 405, "الطريقة غير مسموحة — استخدم POST"); return; }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    errJson(res, 400, e.message);
    return;
  }

  // تنظيف كسول للمهام المنتهية عند كل إنشاء
  try { await db.cleanupExpired(); } catch { /* التنظيف ليس حرجًا */ }

  // الصيغتان المقبولتان: {"videos":[...]} أو {"sources":[{kind,url|name,size,mime}]}
  let sources = [];
  if (Array.isArray(body.videos)) {
    sources = body.videos.map((u) => ({ kind: "url", url: String(u) }));
  } else if (Array.isArray(body.sources)) {
    sources = body.sources.map((s) => ({
      kind: s.kind === "file" ? "file" : "url",
      url: s.url ? String(s.url) : undefined,
      name: s.name ? String(s.name) : undefined,
      size: s.size == null ? undefined : Number(s.size),
      mime: s.mime ? String(s.mime) : undefined,
    }));
  }

  if (sources.length < 2) {
    errJson(res, 400, "الدمج يحتاج مقطعَين على الأقل — أرسل videos[] أو sources[]");
    return;
  }
  if (sources.length > CONFIG.MAX_SOURCES) {
    errJson(res, 400, `أقصى عدد مقاطع للدمج هو ${CONFIG.MAX_SOURCES}`);
    return;
  }
  for (const s of sources) {
    if (s.kind === "url" && !/^https?:\/\/\S+$/i.test(s.url || "")) {
      errJson(res, 400, "كل الروابط يجب أن تكون http/https مباشرة وعامة");
      return;
    }
    if (s.kind === "file" && s.size != null && s.size > CONFIG.SOURCE_MAX_MB * 1024 * 1024) {
      errJson(res, 413, `حجم المصدر يتجاوز الحد (${CONFIG.SOURCE_MAX_MB}MB لكل مصدر)`);
      return;
    }
  }

  const id = jobId();
  const expiresAt = expiryDate();
  await db.insertJob({ id, status: sources.some((s) => s.kind === "file") ? "uploading" : "queued", sources, expiresAt });
  await db.insertSources(id, sources);

  const base = `https://${req.headers.host || "localhost"}`;
  const reply = {
    jobId: id,
    status: sources.some((s) => s.kind === "file") ? "uploading" : "queued",
    statusUrl: `${base}/api/jobs/${id}`,
    processUrl: `${base}/api/jobs/${id}/process`,
    expiresAt,
  };

  // عند وجود ملفات: أعِد روابط رفع لكل مصدر + حجم الجزء
  if (sources.some((s) => s.kind === "file")) {
    reply.uploads = sources.map((s, i) => ({
      seq: i,
      name: s.name,
      uploadUrl: `${base}/api/upload?job=${id}&seq=${i}&chunk=<k>`,
      size: s.size,
    }));
    reply.uploadChunkBytes = CONFIG.UPLOAD_CHUNK_BYTES;
  }

  json(res, 201, reply);
};
