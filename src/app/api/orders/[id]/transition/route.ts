import { orderTransitionSchema } from "@/domain/schemas";
import { getDb } from "@/lib/db";
import { transitionOrder } from "@/lib/repository";
import { ok, readIdempotencyKey, toErrorResponse } from "@/server/http";
import { publishOrderUpdated } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = orderTransitionSchema.parse(await request.json());
    const result = transitionOrder(getDb(), id, body.status, Date.now(), readIdempotencyKey(request) ?? body.idempotencyKey);
    publishOrderUpdated(result);
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
