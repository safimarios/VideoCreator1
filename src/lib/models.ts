// سجل الموديلات — الاسماء الثابتة كما يراها عميل MCP مع قبول الصيغ البديلة (نقاط/شرطات)
// يمكن تجاوز اسم الموديل المرسل لكل مزود عبر متغيرات البيئة

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها
  type: MediaType;
  providers: ProviderId[]; // المزودون القادرون على خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسَل لكل مزود
}

// الأسماء المرسلة للمزودين — مأخوذة من التوثيق الرسمي والمقاسة فعليًا:
// kie.ai: gpt-image-2-6/flare-text-to-image و grok-imagine-video-1-5-preview (شرطات — مقاس من API حي)
// CometAPI: apidoc.cometapi.com (gpt-image-2.6-flare-text-to-image و grok-imagine-video-1.5)
const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1.5";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

// توحيد اسم الموديل: نقاط ↔ شرطات داخل أرقام الإصدار
export function normalizeModelName(name: string): string {
  return name.trim().replace(/(\d)\.(\d)/g, "$1-$2");
}

export function findModel(name?: string): ModelDef | null {
  if (!name) return null;
  const normalized = normalizeModelName(name);
  return (
    MODELS.find((m) => m.canonical === normalized || m.aliases.includes(normalized)) ?? null
  );
}

// توحيد قيم enum العامة: auto يعني عدم الإرسال للمزود إطلاقًا
export function cleanOptional(v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && (v === "auto" || v.trim() === "")) return undefined;
  return v;
}
