import { z } from "zod";
import { getDb } from "@/lib/db";
import { reassignTask } from "@/lib/waiters";
import { ok, toErrorResponse } from "@/server/http";
import { publishTask } from "@/server/publish";

const schema = z.object({ waiterId: z.string().min(1).nullable() });

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = schema.parse(await request.json());
    const result = reassignTask(getDb(), id, body.waiterId);
    publishTask(result.task, "updated");
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
