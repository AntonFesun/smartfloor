import { ticketActionSchema } from "@/domain/schemas";
import { actOnTicket } from "@/lib/kitchen";
import { getDb } from "@/lib/db";
import { ok, readIdempotencyKey, toErrorResponse } from "@/server/http";
import { publishKitchen } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = ticketActionSchema.parse(await request.json());
    const result = actOnTicket(getDb(), id, body.action, {
      itemId: body.itemId,
      idempotencyKey: readIdempotencyKey(request) ?? body.idempotencyKey,
    });
    publishKitchen(result);
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
