import { getDb } from "@/lib/db";
import { readSimulationScenario } from "@/lib/simulation-store";
import { ok, toErrorResponse } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const scenario = readSimulationScenario(getDb(), id);
    if (!scenario) return Response.json({ error: "Scenario not found" }, { status: 404 });
    return ok({ scenario });
  } catch (error) {
    return toErrorResponse(error);
  }
}
