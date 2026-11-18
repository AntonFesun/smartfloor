import { z } from "zod";
import { getDb } from "@/lib/db";
import { bookTables } from "@/lib/seating";
import { ok, toErrorResponse } from "@/server/http";
import { publishSeating } from "@/server/publish";

const schema = z.object({
  tableIds: z.array(z.string().min(1)).min(1),
  partySize: z.number().int().min(1).max(24),
  start: z.string().min(1),
  durationMinutes: z.number().int().min(30).max(300).optional(),
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const result = bookTables(getDb(), body);
    publishSeating(result);
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
