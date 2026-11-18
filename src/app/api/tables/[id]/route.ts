import { getDb } from "@/lib/db";
import { removeTable } from "@/lib/repository";
import { ok, toErrorResponse } from "@/server/http";
import { publishLayout } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = removeTable(getDb(), id);
    publishLayout({ tables: result.tables });
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
