import { z } from "zod";
import { getDb } from "@/lib/db";
import { createManagerTask } from "@/lib/waiters";
import { ok, toErrorResponse } from "@/server/http";
import { publishTask } from "@/server/publish";

const schema = z.object({
  type: z.enum(["clear_table", "seat_guests", "general_assistance"]),
  tableId: z.string().min(1),
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const result = createManagerTask(getDb(), body);
    publishTask(result.task, "created");
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
