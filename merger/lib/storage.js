// طبقة تخزين Blobs في Turso — كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP) ويُقرأ تدفقيًا بصفحات من 8
const { getDb } = require("./turso-client");
const { CONFIG } = require("./util");

// كتابة Buffer كصفوف مقسمة (للمصادر المرفوعة أو للناتج)
async function writeChunks(table, keyCols, keyArgs, buffer) {
  const db = getDb();
  const rows = Math.ceil(buffer.length / CONFIG.CHUNK_ROW_BYTES) || 0;
  const stmts = [];
  for (let i = 0; i < rows; i++) {
    const slice = buffer.subarray(i * CONFIG.CHUNK_ROW_BYTES, (i + 1) * CONFIG.CHUNK_ROW_BYTES);
    if (table === "source_chunks") {
      stmts.push({ sql: "INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)", args: [...keyArgs, i, slice] });
    } else {
      stmts.push({ sql: "INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)", args: [...keyArgs, i, slice] });
    }
  }
  // دفعة واحدة (Turso batch) — مع تجزئة للدفات الكبيرة تجنبًا لحد الطلب
  const BATCH = 40;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await db.batch(stmts.slice(i, i + BATCH), "write");
  }
  return rows;
}

// إضافة جزء مفرد مرفوع (upload endpoint) — الاستبدال عند إعادة المحاولة
async function upsertSourceChunk(jobId, seq, chunk, data) {
  const db = getDb();
  await db.execute({ sql: "DELETE FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk = ?", args: [jobId, seq, chunk] });
  await db.execute({ sql: "INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)", args: [jobId, seq, chunk, data] });
}

// تجميع مصدر كامل من صفوفه — يُستخدم أثناء الدمج
async function readSourceBuffer(jobId, seq) {
  return readBlob("source_chunks", ["job_id", "seq"], [jobId, seq]);
}

// تجميع الناتج الكامل
async function readOutputBuffer(jobId) {
  return readBlob("output_chunks", ["job_id"], [jobId]);
}

async function readBlob(table, keyCols, keyArgs) {
  const db = getDb();
  const where = keyCols.map((c) => `${c} = ?`).join(" AND ");
  const chunks = [];
  let page = 0;
  // قراءة بصفحات من 8 صفوف — تيار استهلاكي بدل تحميل كل شيء دفعة واحدة من الخادم
  // ملاحظة: نحتاج المجموع كاملًا للترميز، فنجمعه محليًا
  for (;;) {
    const rs = await db.execute({
      sql: `SELECT chunk, data FROM ${table} WHERE ${where} ORDER BY chunk ASC LIMIT ${CONFIG.READ_PAGE_ROWS} OFFSET ${page * CONFIG.READ_PAGE_ROWS}`,
      args: keyArgs,
    });
    if (!rs.rows.length) break;
    for (const r of rs.rows) {
      chunks[Number(r.chunk)] = typeof r.data === "string" ? Buffer.from(r.data, "base64") : Buffer.from(r.data);
    }
    page++;
    if (rs.rows.length < CONFIG.READ_PAGE_ROWS) break;
  }
  if (!chunks.length || chunks.some((c) => c === undefined)) return null;
  return Buffer.concat(chunks);
}

// عدد الصفوف وأحجامها لمصدر ما — للتحقق من اكتمال الرفع
async function sourceChunkStats(jobId, seq) {
  const db = getDb();
  const rs = await db.execute({
    sql: "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM source_chunks WHERE job_id = ? AND seq = ?",
    args: [jobId, seq],
  });
  return { rows: Number(rs.rows[0].n), bytes: Number(rs.rows[0].bytes) };
}

// قراءة مجال بايتات [start..end] من الناتج (لدعم Range في البث) — دون تحميل كل شيء
async function readOutputRange(jobId, start, end) {
  const db = getDb();
  const first = Math.floor(start / CONFIG.CHUNK_ROW_BYTES);
  const last = Math.floor(end / CONFIG.CHUNK_ROW_BYTES);
  const rs = await db.execute({
    sql: `SELECT chunk, data FROM output_chunks WHERE job_id = ? AND chunk >= ? AND chunk <= ? ORDER BY chunk ASC`,
    args: [jobId, first, last],
  });
  if (!rs.rows.length) return null;
  const parts = [];
  for (const r of rs.rows) {
    const buf = typeof r.data === "string" ? Buffer.from(r.data, "base64") : Buffer.from(r.data);
    parts.push({ chunk: Number(r.chunk), buf });
  }
  const out = [];
  for (const { chunk, buf } of parts) {
    const chunkStart = chunk * CONFIG.CHUNK_ROW_BYTES;
    const from = Math.max(0, start - chunkStart);
    const to = Math.min(buf.length, end + 1 - chunkStart);
    if (to > from) out.push(buf.subarray(from, to));
  }
  return Buffer.concat(out);
}

// الحجم الإجمالي للناتج المخزن
async function outputSize(jobId) {
  const db = getDb();
  const rs = await db.execute({
    sql: "SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes, COUNT(*) AS rows FROM output_chunks WHERE job_id = ?",
    args: [jobId],
  });
  return { bytes: Number(rs.rows[0].bytes), rows: Number(rs.rows[0].rows) };
}

// بعد نجاح الدمج: حذف أجزاء المصادر — الناتج فقط هو المطلوب
async function deleteSourceChunks(jobId) {
  await getDb().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
}

module.exports = {
  writeChunks,
  upsertSourceChunk,
  readSourceBuffer,
  readOutputBuffer,
  readOutputRange,
  sourceChunkStats,
  outputSize,
  deleteSourceChunks,
};
