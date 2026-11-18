import { layoutSchema } from "@/domain/schemas";
import { getDb } from "@/lib/db";
import { saveLayout } from "@/lib/repository";
import { ok, readIdempotencyKey, toErrorResponse } from "@/server/http";
import { publishLayout } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: Request) {
  try {
    const body = layoutSchema.parse(await request.json());
    const result = saveLayout(getDb(), body.tables, readIdempotencyKey(request) ?? body.idempotencyKey);
    publishLayout(result);
    return ok({ tables: result.tables });
  } catch (error) {
    return toErrorResponse(error);
  }
}
