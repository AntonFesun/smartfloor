import { z } from "zod";
import { ZONES } from "@/types";
import { getDb } from "@/lib/db";
import { setWaiterZones } from "@/lib/waiters";
import { ok, toErrorResponse } from "@/server/http";

const schema = z.object({ zones: z.array(z.enum(ZONES)) });

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = schema.parse(await request.json());
    return ok(setWaiterZones(getDb(), id, body.zones));
  } catch (error) {
    return toErrorResponse(error);
  }
}
