import { getDb } from "@/lib/db";
import { clearTable } from "@/lib/repository";
import { ok, readIdempotencyKey, toErrorResponse } from "@/server/http";
import { publishTable } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = clearTable(getDb(), id, Date.now(), readIdempotencyKey(request));
    publishTable(result);
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
