import { getServiceHeatmap, type HeatMetricId } from "@/domain/analytics";
import type { TimeRangeKind } from "@/domain/journal";
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
    if (!RANGES.has(kind as TimeRangeKind)) {
      return Response.json({ error: "Unknown range" }, { status: 400 });
    }
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    if (kind === "custom" && (!from || !to)) {
      return Response.json({ error: "Custom range needs from and to" }, { status: 400 });
    }
    const context = runtimeContext();
    const snapshot = getSnapshot(getDb(), context);
    const report = getServiceHeatmap({
      events: snapshot.journal,
      tables: snapshot.tables,
      range: {
        kind: kind as TimeRangeKind,
        from,
        to,
      },
      now: context.now,
      thresholds: context.thresholds,
    });
    return ok({
      ...report,
      metric: (url.searchParams.get("metric") ?? "ack") as HeatMetricId,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
