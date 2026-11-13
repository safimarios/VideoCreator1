// تعطيل/تنشيط/حذف مفتاح يدويًا من الواجهة
import { getKey, setKeyStatus, deleteKey } from "@/lib/turso";
import { maskKey } from "@/lib/mask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  let body: { action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "طلب غير صالح — JSON مطلوب" }, { status: 400 });
  }

  const key = await getKey(id);
  if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });

  if (body.action === "disable") {
    await setKeyStatus(id, "disabled", "معطّل يدويًا من الواجهة");
  } else if (body.action === "activate") {
    // التنشيط يعيد المفتاح إلى active حتى لو كان exhausted (مثلًا بعد شحن الرصيد)
    await setKeyStatus(id, "active", undefined);
  } else {
    return Response.json({ error: "الإجراء يجب أن يكون disable أو activate" }, { status: 400 });
  }

  const updated = await getKey(id);
  return Response.json({
    key: updated
      ? {
          id: updated.id,
          provider: updated.provider,
          label: updated.label,
          maskedKey: maskKey(updated.apiKey),
          status: updated.status,
        }
      : null,
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const key = await getKey(id);
  if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return Response.json({ ok: true });
}
