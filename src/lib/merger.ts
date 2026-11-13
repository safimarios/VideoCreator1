// عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق)
// القاعدة الحتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري
// أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → تُستطلع من جديد
const MERGER_BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

export function mergerBase(): string {
  return MERGER_BASE;
}

// خطأ معلن من خدمة الدمج (حتمي — لا إعادة محاولة)
export class MergerHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MergerHttpError";
    this.status = status;
  }
}

export interface MergerJob {
  jobId: string;
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  expiresAt?: string;
}

async function mergerFetch(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${MERGER_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // خطأ شبكتنا = مؤقت (يُستطلع لاحقًا) — ليس MergerHttpError
    throw new Error(`merger network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  if (!res.ok) {
    // خطأ HTTP معلن من الخدمة = حتمي
    throw new MergerHttpError(res.status, String(body.error ?? body.message ?? (text.slice(0, 300) || `HTTP ${res.status}`)));
  }
  return { status: res.status, body };
}

// تحليل حالة دفاعي — الخدمة قد ترسل صيغًا مختلفة
const DONE_STATES = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED_STATES = new Set(["error", "failed", "failure", "cancelled"]);

function normalizeStatus(raw: unknown, hasError: boolean): MergerJob["status"] {
  const s = String(raw ?? "").toLowerCase();
  if (FAILED_STATES.has(s) || (hasError && !s)) return "failed";
  if (DONE_STATES.has(s)) return "done";
  if (s === "processing" || s === "queued" || s === "uploading") return s === "queued" || s === "uploading" ? "queued" : "processing";
  // حالة غير معروفة مع error → فشل؛ بدون → قيد المعالجة
  return hasError ? "failed" : "processing";
}

function normalizeProgress(raw: unknown): number {
  let p = Number(raw ?? 0);
  if (!Number.isFinite(p) || p < 0) p = 0;
  // قد يأتي كسرًا 0..1 → اضربه في 100
  if (p > 0 && p <= 1) p *= 100;
  return Math.min(100, Math.round(p));
}

// رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا استخدم رابط البث المباشر
export function mergerResultUrl(jobId: string, videoUrl?: string, downloadUrl?: string): string {
  return videoUrl || downloadUrl || `${MERGER_BASE}/api/jobs/${jobId}/video`;
}

export function parseMergerJob(body: Record<string, unknown>, fallbackJobId?: string): MergerJob {
  const jobId = String(body.jobId ?? body.id ?? fallbackJobId ?? "");
  const hasError = Boolean(body.error);
  const status = normalizeStatus(body.status, hasError);
  return {
    jobId,
    status,
    progress: status === "done" ? 100 : normalizeProgress(body.progress),
    videoUrl: body.videoUrl ? String(body.videoUrl) : undefined,
    downloadUrl: body.downloadUrl ? String(body.downloadUrl) : undefined,
    error: body.error ? String(body.error) : undefined,
    expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
  };
}

// إنشاء مهمة دمج — POST /api/jobs {"videos":[...]}
export async function createMergeJob(urls: string[]): Promise<MergerJob> {
  const { body } = await mergerFetch("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ videos: urls }),
  });
  return parseMergerJob(body);
}

// تشغيل الدمج — POST /api/jobs/{id}/process (متزامن ~10–15 ثانية)
export async function startMergeProcess(jobId: string): Promise<MergerJob> {
  const { body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 240_000);
  return parseMergerJob(body, jobId);
}

// استعلام حالة — GET /api/jobs/{id}
// انتبه: قد يرد الجسم فيه error بدون حقل status → يُعامل failed فورًا (داخل parseMergerJob)
export async function getMergeJob(jobId: string): Promise<MergerJob> {
  const { body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  return parseMergerJob(body, jobId);
}

// حذف فوري — DELETE /api/jobs/{id}
export async function deleteMergeJob(jobId: string): Promise<void> {
  await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}

// فحص الجهوزية لـ /api/health — GET /api/config بمهلة 4 ثوانٍ
export async function mergerHealthy(): Promise<boolean> {
  if (!MERGER_BASE) return false;
  try {
    const res = await fetch(`${MERGER_BASE}/api/config`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body === "object" && body !== null;
  } catch {
    return false;
  }
}
