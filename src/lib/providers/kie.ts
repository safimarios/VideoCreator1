// مزود kie.ai — Jobs API الموحد (الأشكال مقاسة من docs.kie.ai الرسمي)
// createTask: POST /api/v1/jobs/createTask → {"code":200,"data":{"taskId":"..."}}
// recordInfo: GET  /api/v1/jobs/recordInfo?taskId=... → data.state + resultJson (نص JSON داخل JSON!)
import { ProviderError } from "../errors";
import type { ProviderAdapter, ProviderKey, RawInput, CheckResult } from "./types";

const KIE_BASE = "https://api.kie.ai";

// إزالة الحقول الفارغة/auto حتى لا يرفض المزود الطلب بـ 400
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && (v === "auto" || v.trim() === "")) continue;
    out[k] = v;
  }
  return out;
}

async function kieFetch(key: ProviderKey, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    // انقطاع شبكة/timeout = خطأ مؤقت
    throw new ProviderError(0, `network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  if (!res.ok) {
    throw new ProviderError(res.status, String(body.msg ?? body.message ?? (text.slice(0, 300) || `HTTP ${res.status}`)));
  }
  // بعض أخطاء kie تصل بحالة HTTP 200 لكن code != 200 — نحوّلها لأخطاء حقيقية
  const code = Number(body.code ?? 200);
  if (code !== 200) {
    throw new ProviderError(code, String(body.msg ?? `kie code ${code}`));
  }
  return body;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, providerModel, input: RawInput) {
    // حسب التوثيق المقاس: gpt-image input = prompt/aspect_ratio/resolution/quality/background/output_format
    // grok-imagine video input = prompt/image_urls/aspect_ratio/resolution/duration (الصوت دائمًا مولَّد — لا حقل لإيقافه)
    const kieInput =
      providerModel.includes("image")
        ? compact({
            prompt: input.prompt,
            aspect_ratio: input.aspect_ratio,
            resolution: input.resolution,
            background: input.background,
            output_format: input.output_format,
          })
        : compact({
            prompt: input.prompt,
            image_urls: input.image_url ? [input.image_url] : undefined,
            aspect_ratio: input.aspect_ratio,
            resolution: input.resolution,
            duration: input.duration,
          });

    const body = await kieFetch(key, `${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input: kieInput }),
    });
    const data = body.data as { taskId?: string } | undefined;
    const taskId = data?.taskId;
    if (!taskId) throw new ProviderError(0, "kie response missing data.taskId");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const body = await kieFetch(key, `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`);
    const data = (body.data ?? {}) as {
      state?: string;
      resultJson?: string;
      failMsg?: string;
    };
    const state = String(data.state ?? "waiting");
    // تقدير تقدم مبني على الحالة — kie لا يرسل نسبة مئوية
    const progress = state === "waiting" ? 5 : state === "queuing" ? 15 : state === "generating" ? 50 : undefined;

    if (state === "success") {
      // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانية (مقاس من docs.kie.ai)
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(String(data.resultJson ?? "{}")) as { resultUrls?: string[] };
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls.filter(Boolean) : [];
      } catch {
        throw new ProviderError(0, "kie resultJson is not valid JSON");
      }
      if (!urls.length) throw new ProviderError(0, "kie succeeded but returned no resultUrls");
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      return { status: "failed", error: String(data.failMsg ?? "kie task failed"), progress };
    }
    return { status: "processing", progress };
  },
};
