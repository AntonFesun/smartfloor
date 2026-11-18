import { waiterCreateSchema } from "@/domain/schemas";
import { getDb } from "@/lib/db";
import { callWaiter } from "@/lib/repository";
import { ok, readIdempotencyKey, toErrorResponse } from "@/server/http";
import { publishWaiter } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = waiterCreateSchema.parse(await request.json());
    const result = callWaiter(getDb(), body.tableId, Date.now(), readIdempotencyKey(request) ?? body.idempotencyKey);
    publishWaiter("waiter.called", result);
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
