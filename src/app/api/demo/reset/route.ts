import { getDb } from "@/lib/db";
import { resetDemo } from "@/lib/repository";
import { runtimeContext } from "@/lib/runtime";
import { ok, toErrorResponse } from "@/server/http";
import { publishReset } from "@/server/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST() {
  try {
    const snapshot = resetDemo(getDb(), runtimeContext());
    publishReset(snapshot);
    return ok(snapshot);
  } catch (error) {
    return toErrorResponse(error);
  }
}
