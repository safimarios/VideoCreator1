// GET /api/cron — حذف المهام المنتهية (مجدول يوميًا في vercel.json)
const db = require("../lib/db");
const { json, errJson } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method !== "GET") { errJson(res, 405, "الطريقة غير مسموحة — استخدم GET"); return; }
  try {
    const deleted = await db.cleanupExpired();
    json(res, 200, { ok: true, deleted });
  } catch (e) {
    errJson(res, 500, e.message.slice(0, 300));
  }
};
