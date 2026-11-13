// أدوات مشتركة — الحدود من متغيرات البيئة، الردود، CORS، تحميل .env يدويًا
const fs = require("fs");
const path = require("path");

// تحميل .env يدويًا (محاكاة بسيطة لدور dotenv بدون اعتماديات إضافية)
function loadEnv() {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
    }
  } catch { /* تجاهل — البيئة قد تأتي من المنصة مباشرة */ }
}
loadEnv();

const CONFIG = {
  MAX_SOURCES: parseInt(process.env.MAX_SOURCES || "10", 10),
  SOURCE_MAX_MB: parseInt(process.env.SOURCE_MAX_MB || "200", 10),
  OUTPUT_MAX_MB: parseInt(process.env.OUTPUT_MAX_MB || "150", 10),
  MAX_TOTAL_DURATION_SEC: parseInt(process.env.MAX_TOTAL_DURATION_SEC || "600", 10),
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || "medium",
  UPLOAD_CHUNK_BYTES: 4 * 1024 * 1024, // حد Vercel ≈ 4.5MB — نرفع بأجزاء 4MB
  CHUNK_ROW_BYTES: 2 * 1024 * 1024, // حد صف Blob في Turso عبر HTTP
  READ_PAGE_ROWS: 8, // قراءة صفوف Blob بصفحات من 8
  TTL_HOURS: 24,
  VERSION: "1.0.0",
};

// CORS مفتوح — واجهة API عامة
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, obj) {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function errJson(res, status, message) {
  json(res, status, { error: message });
}

// قراءة جسم JSON مع رفض التالف
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) {
        reject(new Error("جسم الطلب كبير جدًا"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        reject(new Error("JSON تالف — تعذر تحليل جسم الطلب"));
      }
    });
    req.on("error", reject);
  });
}

// ثوانٍ حتى نهاية الصلاحية (24 ساعة)
function expiryDate(from = new Date()) {
  return new Date(from.getTime() + CONFIG.TTL_HOURS * 3600 * 1000).toISOString();
}

function jobId() {
  // معرف قصير فريد مشابه لصيغة الأمثلة (10 أحرف)
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
}

module.exports = { CONFIG, cors, json, errJson, readJsonBody, expiryDate, jobId, loadEnv };
