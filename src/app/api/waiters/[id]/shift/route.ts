import { z } from "zod";
import { getDb } from "@/lib/db";
import { setShift } from "@/lib/waiters";
import { ok, toErrorResponse } from "@/server/http";

const schema = z.object({ action: z.enum(["start", "end"]) });

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = schema.parse(await request.json());
    return ok(setShift(getDb(), id, body.action));
  } catch (error) {
    return toErrorResponse(error);
  }
}
