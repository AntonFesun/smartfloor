import { seatSchema } from "@/domain/schemas";
import { getDb } from "@/lib/db";
import { seatTable } from "@/lib/repository";
import { ok, readIdempotencyKey, toErrorResponse } from "@/server/http";
import { publishTable } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = seatSchema.parse(await request.json());
    const result = seatTable(getDb(), id, body.occupiedSeatCount, Date.now(), readIdempotencyKey(request) ?? body.idempotencyKey);
    publishTable(result);
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
