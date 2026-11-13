// إدارة المفاتيح — القائمة دائمًا مُقنَّعة، ولا يُعاد مفتاح كامل في أي استجابة
import { listKeys, insertKey, findDuplicateKey } from "@/lib/turso";
import { maskKey } from "@/lib/mask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const keys = await listKeys();
  return Response.json({
    keys: keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      maskedKey: maskKey(k.apiKey),
      status: k.status,
      usageCount: k.usageCount,
      successCount: k.successCount,
      failCount: k.failCount,
      lastUsedAt: k.lastUsedAt,
      lastError: k.lastError,
      createdAt: k.createdAt,
    })),
  });
}

export async function POST(req: Request): Promise<Response> {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "طلب غير صالح — JSON مطلوب" }, { status: 400 });
  }

  const provider = String(body.provider ?? "");
  const apiKey = String(body.api_key ?? "").trim();
  const label = String(body.label ?? "").trim();

  if (provider !== "kie" && provider !== "cometapi") {
    return Response.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey) {
    return Response.json({ error: "المفتاح مطلوب" }, { status: 400 });
  }

  // رفض التكرار لنفس المزود
  const dup = await findDuplicateKey(provider, apiKey);
  if (dup) {
    return Response.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
  }

  const created = await insertKey(provider, apiKey, label);
  return Response.json(
    {
      key: {
        id: created.id,
        provider: created.provider,
        label: created.label,
        maskedKey: maskKey(created.apiKey),
        status: created.status,
        createdAt: created.createdAt,
      },
    },
    { status: 201 }
  );
}
