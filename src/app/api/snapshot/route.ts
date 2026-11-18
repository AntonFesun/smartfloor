import { getDb } from "@/lib/db";
import { getSnapshot } from "@/lib/repository";
import { runtimeContext } from "@/lib/runtime";
import { ok, toErrorResponse } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  try {
    return ok(getSnapshot(getDb(), runtimeContext()));
  } catch (error) {
    return toErrorResponse(error);
  }
}
