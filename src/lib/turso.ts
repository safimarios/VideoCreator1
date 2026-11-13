// طبقة قاعدة البيانات — عميل Turso واحد عبر HTTP (متوافق مع Serverless/Vercel)
// لا نستخدم أي ملف SQLite محلي في الإنتاج
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;

export function getDb(): Client {
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    });
  }
  return _client;
}

// فحص صحة قاعدة البيانات لـ /api/health
export async function dbHealthy(): Promise<boolean> {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// إنشاء الجداول عند أول وصول — بلا أداة migrations
let schemaPromise: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDb();
      await db.execute(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
    })().catch((e) => {
      schemaPromise = null; // اسمح بإعادة المحاولة في الطلب القادم
      throw e;
    });
  }
  return schemaPromise;
}

// ---------------- الأنواع ----------------

export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type KeyStatus = "active" | "exhausted" | "disabled";

export interface TaskAttempt {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface Task {
  id: string;
  provider: string | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  paramsJson: string;
  status: TaskStatus;
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: TaskAttempt[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ApiKey {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  apiKey: string;
  status: KeyStatus;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function mapTask(r: Record<string, unknown>): Task {
  let urls: string[] = [];
  try {
    urls = r.result_urls_json ? JSON.parse(String(r.result_urls_json)) : [];
  } catch { /* روابط غير صالحة — نتعامل كقائمة فارغة */ }
  let attempts: TaskAttempt[] = [];
  try {
    attempts = r.attempts_json ? JSON.parse(String(r.attempts_json)) : [];
  } catch { /* سجل محاولات تالف — نتجاهله */ }
  return {
    id: String(r.id),
    provider: (r.provider as string) ?? null,
    providerTaskId: (r.provider_task_id as string) ?? null,
    keyId: (r.key_id as string) ?? null,
    model: String(r.model),
    type: r.type as Task["type"],
    prompt: String(r.prompt ?? ""),
    paramsJson: String(r.params_json ?? "{}"),
    status: r.status as TaskStatus,
    progress: Number(r.progress ?? 0),
    resultUrls: urls,
    errorMessage: (r.error_message as string) ?? null,
    attempts,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
    completedAt: (r.completed_at as string) ?? null,
  };
}

function mapKey(r: Record<string, unknown>): ApiKey {
  return {
    id: String(r.id),
    provider: r.provider as ApiKey["provider"],
    label: String(r.label ?? ""),
    apiKey: String(r.api_key),
    status: (r.status ?? "active") as KeyStatus,
    usageCount: Number(r.usage_count ?? 0),
    successCount: Number(r.success_count ?? 0),
    failCount: Number(r.fail_count ?? 0),
    lastUsedAt: (r.last_used_at as string) ?? null,
    lastCheckedAt: (r.last_checked_at as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    createdAt: String(r.created_at ?? ""),
  };
}

// ---------------- عمليات المفاتيح ----------------

// الترتيب التسلسلي الصارم: أول مفتاح أُضيف يُجرَّب أولًا (ليس round-robin)
// المفتاح المستنزف يبقى في القائمة — الاستثناء الوحيد هو التعطيل اليدوي
export async function getKeyPool(providers: string[]): Promise<ApiKey[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const rs = await getDb().execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    args: providers as InValue[],
  });
  return rs.rows.map((r) => mapKey(r as unknown as Record<string, unknown>));
}

export async function listKeys(): Promise<ApiKey[]> {
  await ensureSchema();
  const rs = await getDb().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return rs.rows.map((r) => mapKey(r as unknown as Record<string, unknown>));
}

export async function insertKey(provider: "kie" | "cometapi", apiKey: string, label: string): Promise<ApiKey> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [id, provider, label, apiKey],
  });
  return (await getKey(id))!;
}

export async function getKey(id: string): Promise<ApiKey | null> {
  const rs = await getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return rs.rows[0] ? mapKey(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<ApiKey | null> {
  await ensureSchema();
  const rs = await getDb().execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return rs.rows[0] ? mapKey(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function setKeyStatus(id: string, status: KeyStatus, lastError?: string): Promise<void> {
  await ensureSchema();
  const args: InValue[] = [status];
  let sql = "UPDATE api_keys SET status = ?";
  if (lastError !== undefined) {
    sql += ", last_error = ?, last_checked_at = datetime('now')";
    args.push(lastError);
  }
  sql += " WHERE id = ?";
  args.push(id);
  await getDb().execute({ sql, args });
}

// تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — يُستدعى دائمًا
export async function bumpKeyCounters(keyId: string, ok: boolean, error?: string): Promise<void> {
  await ensureSchema();
  // usage دائمًا +1، والنجاح أو الفشل +1 حسب النتيجة
  const args: InValue[] = [1, ok ? 1 : 0, ok ? 0 : 1];
  let sql = `UPDATE api_keys SET usage_count = usage_count + ?, success_count = success_count + ?, fail_count = fail_count + ?, last_used_at = datetime('now'), last_checked_at = datetime('now')`;
  if (error) {
    sql += `, last_error = ?`;
    args.push(error.slice(0, 500));
  }
  sql += ` WHERE id = ?`;
  args.push(keyId);
  await getDb().execute({ sql, args });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

// ---------------- عمليات المهام ----------------

export async function insertTask(t: {
  id: string;
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  model: string;
  type: Task["type"];
  prompt?: string;
  paramsJson?: string;
  status: TaskStatus;
  progress?: number;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      t.provider ?? null,
      t.providerTaskId ?? null,
      t.keyId ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.paramsJson ?? "{}",
      t.status,
      t.progress ?? 0,
    ],
  });
}

export async function getTask(id: string): Promise<Task | null> {
  await ensureSchema();
  const rs = await getDb().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return rs.rows[0] ? mapTask(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

// patch جزئي — يضيف محاولة إلى attempts_json ويضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(
  id: string,
  patch: Partial<{
    provider: string | null;
    providerTaskId: string | null;
    keyId: string | null;
    status: TaskStatus;
    progress: number;
    resultUrls: string[];
    errorMessage: string | null;
    paramsJson: string;
  }>,
  appendAttempt?: TaskAttempt
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.providerTaskId !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.providerTaskId); }
  if (patch.keyId !== undefined) { sets.push("key_id = ?"); args.push(patch.keyId); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(patch.progress); }
  if (patch.resultUrls !== undefined) { sets.push("result_urls_json = ?"); args.push(JSON.stringify(patch.resultUrls)); }
  if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); args.push(patch.errorMessage); }
  if (patch.paramsJson !== undefined) { sets.push("params_json = ?"); args.push(patch.paramsJson); }
  if (appendAttempt) {
    const current = await getTask(id);
    const attempts = current?.attempts ?? [];
    attempts.push(appendAttempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts.slice(-50)));
  }
  if (patch.status === "completed") sets.push("completed_at = datetime('now')");
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: Task["type"]; status?: TaskStatus }
): Promise<Task[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) { where.push("type = ?"); args.push(filters.type); }
  if (filters?.status) { where.push("status = ?"); args.push(filters.status); }
  args.push(limit);
  const rs = await getDb().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return rs.rows.map((r) => mapTask(r as unknown as Record<string, unknown>));
}

export interface TaskStats { total: number; completed: number; failed: number; inProgress: number }

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const rs = await getDb().execute(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status IN ('processing', 'pending') THEN 1 ELSE 0 END), 0) AS in_progress
    FROM tasks`);
  const r = rs.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(r.total ?? 0),
    completed: Number(r.completed ?? 0),
    failed: Number(r.failed ?? 0),
    inProgress: Number(r.in_progress ?? 0),
  };
}
