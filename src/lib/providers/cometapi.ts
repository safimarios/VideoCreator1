// مزود CometAPI — apidoc.cometapi.com (أشكال مقاسة)
// صور متزامنة: POST /v1/images/generations (متوافق مع OpenAI) تعيد url أو b64_json فورًا
// فيديو غير متزامن: POST /grok/v1/videos/generations → {request_id}
//              GET  /grok/v1/videos/{request_id} → {status: done|failed|expired|..., video:{url}}
import { ProviderError } from "../errors";
import type { ProviderAdapter, ProviderKey, RawInput, CheckResult } from "./types";

const COMET_BASE = "https://api.cometapi.com";

async function cometFetch(key: ProviderKey, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new ProviderError(0, `network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  if (!res.ok) {
    const errObj = body.error as { message?: string } | undefined;
    throw new ProviderError(res.status, String(errObj?.message ?? body.message ?? (text.slice(0, 300) || `HTTP ${res.status}`)));
  }
  return body;
}

export const cometAdapter: ProviderAdapter = {
  // CometAPI تعيد الصورة فورًا (متزامن) — يستخدمها المنسق بلا استطلاع
  async createImageSync(key, providerModel, input: RawInput) {
    const body = await cometFetch(key, `${COMET_BASE}/v1/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: providerModel, prompt: input.prompt }),
    });
    const data = body.data as Array<{ url?: string; b64_json?: string }> | undefined;
    const first = data?.[0];
    if (first?.url) return { urls: [first.url] };
    if (first?.b64_json) {
      // بعض الإجابات تعيد b64_json — نحولها لـ data URI (نرفض الأحجام الضخمة حفظًا للقاعدة)
      const b64 = first.b64_json;
      if (b64.length > 8_000_000) throw new ProviderError(0, "provider returned oversized b64 image");
      return { urls: [`data:image/png;base64,${b64}`] };
    }
    throw new ProviderError(0, "cometapi images response missing url/b64_json");
  },

  async createTask(key, providerModel, input: RawInput) {
    // حسب apidoc.cometapi.com: model=grok-imagine-video-1.5، الصورة تمرر كـ image:{url}
    const payload: Record<string, unknown> = { model: providerModel, prompt: input.prompt };
    if (input.duration) payload.duration = input.duration;
    if (input.aspect_ratio && input.aspect_ratio !== "auto") payload.aspect_ratio = input.aspect_ratio;
    if (input.resolution && input.resolution !== "auto") payload.resolution = input.resolution;
    if (input.image_url) payload.image = { url: input.image_url };

    const body = await cometFetch(key, `${COMET_BASE}/grok/v1/videos/generations`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const requestId = body.request_id ?? (body as { id?: string }).id;
    if (!requestId) throw new ProviderError(0, "cometapi video response missing request_id");
    return { providerTaskId: String(requestId) };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const body = await cometFetch(key, `${COMET_BASE}/grok/v1/videos/${encodeURIComponent(providerTaskId)}`);
    const status = String(body.status ?? "").toLowerCase();
    const video = body.video as { url?: string } | undefined;
    if (status === "done" || status === "succeeded") {
      const url = video?.url;
      if (!url) throw new ProviderError(0, "cometapi done without video.url");
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (status === "failed" || status === "expired" || status === "error") {
      return { status: "failed", error: String(body.error ?? `cometapi task ${status}`) };
    }
    return { status: "processing" };
  },
};
