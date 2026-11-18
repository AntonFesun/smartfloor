import { getDb } from "@/lib/db";
import { dissolveGroup } from "@/lib/seating";
import { ok, toErrorResponse } from "@/server/http";
import { publishSeating } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = dissolveGroup(getDb(), id);
    publishSeating({ group: result.group, journal: result.journal });
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
