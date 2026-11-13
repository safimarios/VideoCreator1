// GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية)
const { CONFIG, json } = require("../lib/util");

module.exports = async (req, res) => {
  if (req.method !== "GET") { json(res, 405, { error: "الطريقة غير مسموحة — استخدم GET" }); return; }
  json(res, 200, {
    version: CONFIG.VERSION,
    maxSources: CONFIG.MAX_SOURCES,
    sourceMaxMB: CONFIG.SOURCE_MAX_MB,
    outputMaxMB: CONFIG.OUTPUT_MAX_MB,
    maxTotalDurationSec: CONFIG.MAX_TOTAL_DURATION_SEC,
    uploadChunkBytes: CONFIG.UPLOAD_CHUNK_BYTES,
    ttlHours: CONFIG.TTL_HOURS,
    output: { format: "mp4", video: "h264 crf18", audio: "aac 192k 44100Hz", maxResolution: "1080p", fps: 30 },
  });
};
