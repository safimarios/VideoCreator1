// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP: كل شيء مخزن فيها (مهام، أجزاء المصادر، الناتج Blobs)
const { createClient } = require("@libsql/client");
const { getDb } = require("./turso-client");

let schemaPromise = null;

// إنشاء الجداول عند أول وصول — بلا أداة migrations، بمفاتيح أساسية مركبة
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDb();
      await db.execute(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'queued',
        progress INTEGER DEFAULT 0,
        sources_json TEXT DEFAULT '[]',
        video_url TEXT,
        download_url TEXT,
        size INTEGER,
        duration REAL,
        resolution TEXT,
        error TEXT,
        expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS sources (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        url TEXT,
        name TEXT,
        size INTEGER,
        mime TEXT,
        PRIMARY KEY (job_id, seq)
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS source_chunks (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB,
        PRIMARY KEY (job_id, seq, chunk)
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB,
        PRIMARY KEY (job_id, chunk)
      )`);
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

function mapJob(r) {
  let sources = [];
  try { sources = r.sources_json ? JSON.parse(r.sources_json) : []; } catch { /* تجاهل */ }
  return {
    jobId: r.id,
    status: r.status,
    progress: Number(r.progress || 0),
    sources,
    videoUrl: r.video_url || undefined,
    downloadUrl: r.download_url || undefined,
    size: r.size == null ? undefined : Number(r.size),
    duration: r.duration == null ? undefined : Number(r.duration),
    resolution: r.resolution || undefined,
    error: r.error || undefined,
    expiresAt: r.expires_at || undefined,
    createdAt: r.created_at,
  };
}

async function insertJob(job) {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO jobs (id, status, progress, sources_json, expires_at) VALUES (?, ?, ?, ?, ?)`,
    args: [job.id, job.status || "queued", 0, JSON.stringify(job.sources || []), job.expiresAt],
  });
}

async function getJob(id) {
  await ensureSchema();
  const rs = await getDb().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
  return rs.rows[0] ? mapJob(rs.rows[0]) : null;
}

// patch جزئي لحالة المهمة — يُكتب فورًا بعد كل تغيير
async function updateJob(id, patch) {
  const sets = [];
  const args = [];
  for (const k of ["status", "progress", "video_url", "download_url", "size", "duration", "resolution", "error"]) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      args.push(patch[k]);
    }
  }
  if (!sets.length) return;
  args.push(id);
  await getDb().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

// حذف شامل في batch واحد: المهام + المصادر + أجزاء المصادر + أجزاء الناتج
async function deleteJobCascade(id) {
  await ensureSchema();
  await getDb().batch(
    [
      { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
    ],
    "write"
  );
}

async function insertSources(jobId, sources) {
  await ensureSchema();
  const stmts = sources.map((s, i) => ({
    sql: "INSERT INTO sources (job_id, seq, kind, url, name, size, mime) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [jobId, i, s.kind, s.url || null, s.name || null, s.size == null ? null : s.size, s.mime || null],
  }));
  if (stmts.length) await getDb().batch(stmts, "write");
}

async function listSources(jobId) {
  await ensureSchema();
  const rs = await getDb().execute({
    sql: "SELECT seq, kind, url, name, size, mime FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [jobId],
  });
  return rs.rows.map((r) => ({
    seq: Number(r.seq),
    kind: r.kind,
    url: r.url || undefined,
    name: r.name || undefined,
    size: r.size == null ? undefined : Number(r.size),
    mime: r.mime || undefined,
  }));
}

// تنظيف كسول: حذف كل المهام المنتهية (تُستدعى عند كل إنشاء/دمج + من /api/cron)
async function cleanupExpired() {
  await ensureSchema();
  const rs = await getDb().execute({
    sql: "SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at < ?",
    args: [new Date().toISOString()],
  });
  for (const row of rs.rows) {
    await deleteJobCascade(row.id);
  }
  return rs.rows.length;
}

module.exports = {
  ensureSchema,
  insertJob,
  getJob,
  updateJob,
  deleteJobCascade,
  insertSources,
  listSources,
  cleanupExpired,
};
