// خادم تطوير محلي يحاكي بيئة Vercel:
// - يحل المسارات الديناميكية (api/jobs/<id> ...) ويضع قيمها في req.query
// - يحمّل .env يدويًا قبل أي شيء
require("./lib/util").loadEnv();

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = parseInt(process.env.PORT || "3001", 10);

// جدول التوجيه — نفس أسماء ملفات api/ كما في Vercel
const routes = [
  { pattern: /^\/api\/jobs\/([^/]+)\/video$/, file: "api/jobs/[id]/video.js", params: ["id"] },
  { pattern: /^\/api\/jobs\/([^/]+)\/process$/, file: "api/jobs/[id]/process.js", params: ["id"] },
  { pattern: /^\/api\/jobs\/([^/]+)$/, file: "api/jobs/[id].js", params: ["id"] },
  { pattern: /^\/api\/jobs$/, file: "api/jobs.js", params: [] },
  { pattern: /^\/api\/upload$/, file: "api/upload.js", params: [] },
  { pattern: /^\/api\/config$/, file: "api/config.js", params: [] },
  { pattern: /^\/api\/cron$/, file: "api/cron.js", params: [] },
];

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // الواجهة الثابتة على /
  if (u.pathname === "/" || u.pathname === "/index.html") {
    const html = fs.readFileSync(path.join(__dirname, "public", "index.html"));
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  // حل المسار الديناميكي ووضع المعاملات في req.query (كما تفعل Vercel)
  for (const r of routes) {
    const m = u.pathname.match(r.pattern);
    if (m) {
      req.query = Object.fromEntries(u.searchParams);
      r.params.forEach((p, i) => { req.query[p] = decodeURIComponent(m[i + 1]); });
      const handler = require(path.join(__dirname, r.file));
      try {
        await handler(req, res);
      } catch (e) {
        console.error("[dev-server]", e);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: e.message }));
        }
      }
      return;
    }
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "المسار غير موجود" }));
});

server.listen(PORT, () => {
  console.log(`[dev-server] خدمة الدمج تعمل محليًا على http://localhost:${PORT}`);
});
