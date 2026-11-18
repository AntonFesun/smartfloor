import { addTableSchema } from "@/domain/schemas";
import { getDb } from "@/lib/db";
import { addTable } from "@/lib/repository";
import { ok, toErrorResponse } from "@/server/http";
import { publishLayout } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = addTableSchema.parse(await request.json());
    const result = addTable(getDb(), body);
    publishLayout({ tables: result.tables });
    return ok(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
