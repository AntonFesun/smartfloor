"use client";

import { ACTIVITY_COLORS, ACTIVITY_LABELS, metricInfo, scaleCaption, SEVERITY_COLORS, SEVERITY_LABELS } from "@/domain/analytics";
import { ATTRIBUTION_RULE, REVENUE_COLORS, REVENUE_LABELS, REVENUE_SALES_CAP } from "@/domain/revenue";
import { formatUAH } from "@/lib/format";
import { useHeatmapStore } from "@/store/heatmap-store";

export function HeatmapLegend() {
  const mode = useHeatmapStore((state) => state.mode);
  const metric = useHeatmapStore((state) => state.metric);
  const report = useHeatmapStore((state) => state.report);
  if (mode === "revenue") {
    return (
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-[min(92%,520px)] rounded-md bg-black/70 px-3 py-2 text-[11px] text-zinc-100">
        <div className="font-medium">Recorded sales</div>
        <p className="mt-1 text-zinc-300">Deeper green and gold are higher recorded payments. Lower sales stay green. This is not a failure scale.</p>
        <p className="mt-1 text-zinc-400">Full scale is {formatUAH(REVENUE_SALES_CAP)}. {ATTRIBUTION_RULE}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {REVENUE_COLORS.map((color, index) => (
            <span key={color} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
              {REVENUE_LABELS[index]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full border border-zinc-500 bg-transparent" />
            No data
          </span>
        </div>
      </div>
    );
  }
  if (mode !== "heatmap") return null;
  const info = metricInfo(metric);
  const colors = info.direction === "activity" ? ACTIVITY_COLORS : SEVERITY_COLORS;
  const labels = info.direction === "activity" ? ACTIVITY_LABELS : SEVERITY_LABELS;
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-[min(92%,520px)] rounded-md bg-black/70 px-3 py-2 text-[11px] text-zinc-100">
      <div className="font-medium">{info.label}</div>
      <p className="mt-1 text-zinc-300">{info.summary}</p>
      <p className="mt-1 text-zinc-400">{report ? scaleCaption(metric, report.thresholds) : "Waiting for the journal range."}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {colors.map((color, index) => (
          <span key={color} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            {labels[index]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full border border-zinc-500 bg-transparent" />
          No data
        </span>
      </div>
    </div>
  );
}
