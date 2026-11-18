"use client";

import { HEAT_METRICS, metricInfo } from "@/domain/analytics";
import type { TimeRangeKind } from "@/domain/journal";
import { Button } from "@/components/ui/button";
import { useHeatmapStore } from "@/store/heatmap-store";

const RANGES: { id: TimeRangeKind; label: string }[] = [
  { id: "last_hour", label: "Last hour" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last_7_days", label: "Last 7 days" },
  { id: "custom", label: "Custom" },
];

export function HeatmapBar() {
  const mode = useHeatmapStore((state) => state.mode);
  const metric = useHeatmapStore((state) => state.metric);
  const rangeKind = useHeatmapStore((state) => state.rangeKind);
  const customFrom = useHeatmapStore((state) => state.customFrom);
  const customTo = useHeatmapStore((state) => state.customTo);
  const error = useHeatmapStore((state) => state.error);
  const setMode = useHeatmapStore((state) => state.setMode);
  const setMetric = useHeatmapStore((state) => state.setMetric);
  const setRangeKind = useHeatmapStore((state) => state.setRangeKind);
  const setCustom = useHeatmapStore((state) => state.setCustom);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <div className="flex gap-1 rounded-lg bg-secondary p-1">
        <Button size="sm" variant={mode === "operations" ? "default" : "ghost"} onClick={() => setMode("operations")}>
          Operations
        </Button>
        <Button size="sm" variant={mode === "heatmap" ? "default" : "ghost"} onClick={() => setMode("heatmap")}>
          Service heatmap
        </Button>
        <Button size="sm" variant={mode === "revenue" ? "default" : "ghost"} onClick={() => setMode("revenue")}>
          Revenue map
        </Button>
      </div>
      {mode === "heatmap" && (
        <>
          <select
            aria-label="Heatmap metric"
            value={metric}
            onChange={(event) => setMetric(event.target.value as typeof metric)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            {HEAT_METRICS.map((id) => (
              <option key={id} value={id}>
                {metricInfo(id).label}
              </option>
            ))}
          </select>
          {RANGES.map((range) => (
            <Button key={range.id} size="sm" variant={rangeKind === range.id ? "default" : "ghost"} onClick={() => setRangeKind(range.id)}>
              {range.label}
            </Button>
          ))}
          {rangeKind === "custom" && (
            <>
              <input
                aria-label="Range start"
                type="datetime-local"
                value={customFrom}
                onChange={(event) => setCustom(event.target.value, customTo)}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              />
              <input
                aria-label="Range end"
                type="datetime-local"
                value={customTo}
                onChange={(event) => setCustom(customFrom, event.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              />
              <span className="text-[11px] text-muted-foreground">Europe/Kyiv</span>
            </>
          )}
          {error && <span className="text-xs text-amber-200">{error}</span>}
        </>
      )}
      {mode === "revenue" && (
        <>
          {RANGES.map((range) => (
            <Button key={range.id} size="sm" variant={rangeKind === range.id ? "default" : "ghost"} onClick={() => setRangeKind(range.id)}>
              {range.label}
            </Button>
          ))}
          {rangeKind === "custom" && (
            <>
              <input aria-label="Range start" type="datetime-local" value={customFrom} onChange={(event) => setCustom(event.target.value, customTo)} className="h-8 rounded-md border bg-background px-2 text-xs" />
              <input aria-label="Range end" type="datetime-local" value={customTo} onChange={(event) => setCustom(customFrom, event.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs" />
              <span className="text-[11px] text-muted-foreground">Europe/Kyiv</span>
            </>
          )}
          <span className="text-[11px] text-muted-foreground">Payments stay on the ordering table. Unpaid checks are not revenue.</span>
          {error && <span className="text-xs text-amber-200">{error}</span>}
        </>
      )}
    </div>
  );
}
