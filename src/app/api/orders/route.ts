import { orderCreateSchema } from "@/domain/schemas";
import { getDb } from "@/lib/db";
import { createOrder } from "@/lib/repository";
import { ok, readIdempotencyKey, toErrorResponse } from "@/server/http";
import { publishOrderCreated } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = orderCreateSchema.parse(await request.json());
    const result = createOrder(getDb(), { ...body, idempotencyKey: readIdempotencyKey(request) ?? body.idempotencyKey });
    publishOrderCreated(result);
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
