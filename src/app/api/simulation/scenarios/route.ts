import { SimulationConfigError, type SimulationScenario } from "@/simulation";
import { getDb } from "@/lib/db";
import { listSimulationScenarios, saveSimulationScenario } from "@/lib/simulation-store";
import { ok, toErrorResponse } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  try {
    return ok({ scenarios: listSimulationScenarios(getDb()) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { scenario?: unknown };
    if (!body.scenario || typeof body.scenario !== "object") {
      return Response.json({ error: "A scenario document is required" }, { status: 400 });
    }
    const saved = saveSimulationScenario(getDb(), body.scenario as SimulationScenario);
    return ok(saved);
  } catch (error) {
    if (error instanceof SimulationConfigError) return Response.json({ error: error.message, issues: error.issues }, { status: 400 });
    return toErrorResponse(error);
  }
}
