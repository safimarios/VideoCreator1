// GET /api/jobs/<id>/video — بث الناتج بدعم Range (206 + Content-Range) للتقديم/الترجيع
// ?download=1 → تنزيل مباشر بترويسة Content-Disposition
const db = require("../../../lib/db");
const storage = require("../../../lib/storage");
const { errJson, cors } = require("../../../lib/util");

module.exports = async (req, res) => {
  if (req.method !== "GET") { errJson(res, 405, "الطريقة غير مسموحة — استخدم GET"); return; }
  const id = req.query.id;

  const job = await db.getJob(id);
  if (!job) { errJson(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)"); return; }
  if (job.status !== "done") { errJson(res, 409, "الناتج غير جاهز بعد"); return; }

  const total = (await storage.outputSize(id)).bytes;
  if (!total) { errJson(res, 404, "الناتج غير موجود في التخزين"); return; }

  cors(res);
  const filename = `merged-${id}.mp4`;
  const baseHeaders = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  };
  if (req.query.download) {
    baseHeaders["Content-Disposition"] = `attachment; filename="${filename}"`;
  }

  // تحليل ترويسة Range — نحن مسؤولون عن تقليم أول/آخر جزء حسب المدى المطلوب
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      let start = m[1] === "" ? null : parseInt(m[1], 10);
      let end = m[2] === "" ? null : parseInt(m[2], 10);
      if (start === null) {
        // لاحقة: آخر N بايت
        start = Math.max(0, total - (end || 0));
        end = total - 1;
      } else if (end === null || end >= total) {
        end = total - 1;
      }
      if (start >= total || start > end) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${total}`);
        res.end();
        return;
      }
      const slice = await storage.readOutputRange(id, start, end);
      if (!slice) { errJson(res, 404, "الناتج غير موجود في التخزين"); return; }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", String(end - start + 1));
      for (const [k, v] of Object.entries(baseHeaders)) res.setHeader(k, v);
      res.end(slice);
      return;
    }
  }

  // بث كامل: اقرأ صفحات من 8 صفوف واكتبها تتابعيًا (تيار حقيقي دون تحميل كل شيء مرة واحدة)
  const { getDb } = require("../../../lib/turso-client");
  const { CONFIG } = require("../../../lib/util");
  res.statusCode = 200;
  res.setHeader("Content-Length", String(total));
  for (const [k, v] of Object.entries(baseHeaders)) res.setHeader(k, v);
  let page = 0;
  for (;;) {
    const rs = await getDb().execute({
      sql: `SELECT chunk, data FROM output_chunks WHERE job_id = ? ORDER BY chunk ASC LIMIT ${CONFIG.READ_PAGE_ROWS} OFFSET ${page * CONFIG.READ_PAGE_ROWS}`,
      args: [id],
    });
    if (!rs.rows.length) break;
    for (const r of rs.rows) {
      const buf = typeof r.data === "string" ? Buffer.from(r.data, "base64") : Buffer.from(r.data);
      if (!res.write(buf)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    page++;
    if (rs.rows.length < CONFIG.READ_PAGE_ROWS) break;
  }
  res.end();
};
