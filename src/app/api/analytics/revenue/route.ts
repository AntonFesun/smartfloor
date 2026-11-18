import type { TimeRangeKind } from "@/domain/journal";
import { getRevenueMap } from "@/domain/revenue";
import { getDb } from "@/lib/db";
import { getSnapshot } from "@/lib/repository";
import { runtimeContext } from "@/lib/runtime";
import { ok, toErrorResponse } from "@/server/http";

const RANGES = new Set<TimeRangeKind>(["last_hour", "today", "yesterday", "last_7_days", "custom"]);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const kind = url.searchParams.get("range") ?? "today";
    if (!RANGES.has(kind as TimeRangeKind)) return Response.json({ error: "Unknown range" }, { status: 400 });
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    if (kind === "custom" && (!from || !to)) return Response.json({ error: "Custom range needs from and to" }, { status: 400 });
    const context = runtimeContext();
    const snapshot = getSnapshot(getDb(), context);
    return ok(getRevenueMap({
      payments: snapshot.payments,
      orders: snapshot.orders,
      events: snapshot.journal,
      tables: snapshot.tables,
      groups: snapshot.tableGroups,
      range: { kind: kind as TimeRangeKind, from, to },
      now: context.now,
    }));
  } catch (error) {
    return toErrorResponse(error);
  }
}
