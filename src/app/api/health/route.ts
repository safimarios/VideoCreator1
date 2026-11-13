// فحص صحة النظام — Turso + الموديلات + خدمة الدمج + حالة التوثيق
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy, mergerBase } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const dbOk = await dbHealthy();
  const mergerOk = await mergerHealthy();

  return Response.json({
    ok: dbOk,
    database: dbOk ? "turso-connected" : "disconnected",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: mergerBase(), healthy: mergerOk },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
