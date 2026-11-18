"use client";

import { useEffect } from "react";
import { getServiceHeatmap, zonedLocalToUtc } from "@/domain/analytics";
import { RESTAURANT_TIME_ZONE, type TimeRange } from "@/domain/journal";
import { getRevenueMap } from "@/domain/revenue";
import { usePresentedFloor } from "@/hooks/use-presented-floor";
import { EMPTY_THRESHOLDS, useRealtime } from "@/hooks/use-realtime";
import { useHeatmapStore } from "@/store/heatmap-store";
import { useReplayStore } from "@/store/replay-store";

export function HeatmapBinder() {
  const { tables } = usePresentedFloor();
  const { journal, metrics, now, orders, payments, tableGroups } = useRealtime();
  const replayMode = useReplayStore((state) => state.mode);
  const sequence = useReplayStore((state) => state.sequence);
  const mode = useHeatmapStore((state) => state.mode);
  const rangeKind = useHeatmapStore((state) => state.rangeKind);
  const customFrom = useHeatmapStore((state) => state.customFrom);
  const customTo = useHeatmapStore((state) => state.customTo);
  const setReport = useHeatmapStore((state) => state.setReport);
  const setRevenue = useHeatmapStore((state) => state.setRevenue);

  useEffect(() => {
    if (mode === "operations") return;
    const events = replayMode === "REPLAY" ? journal.filter((event) => event.sequence <= sequence) : journal;
    const at = replayMode === "REPLAY" ? replayInstant(events, now) : now;
    let range: TimeRange;
    try {
      range = customRange(rangeKind, customFrom, customTo);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The range is incomplete.";
      if (mode === "heatmap") setReport(null, message);
      else setRevenue(null, message);
      return;
    }
    if (mode === "heatmap") {
      setReport(getServiceHeatmap({
        events,
        tables,
        range,
        now: at,
        thresholds: metrics?.thresholds ?? EMPTY_THRESHOLDS,
        timeZone: RESTAURANT_TIME_ZONE,
      }));
      return;
    }
    const visiblePayments = replayMode === "REPLAY" ? payments.filter((payment) => Date.parse(payment.paidAt) <= at) : payments;
    setRevenue(getRevenueMap({
      payments: visiblePayments,
      orders,
      events,
      tables,
      groups: tableGroups,
      range,
      now: at,
      timeZone: RESTAURANT_TIME_ZONE,
    }));
  }, [journal, tables, metrics, now, orders, payments, tableGroups, replayMode, sequence, mode, rangeKind, customFrom, customTo, setReport, setRevenue]);

  return null;
}

function customRange(kind: TimeRange["kind"], customFrom: string, customTo: string): TimeRange {
  if (kind !== "custom") return { kind };
  if (!customFrom || !customTo) throw new Error("Choose the start and end of the custom range.");
  const from = zonedLocalToUtc(customFrom);
  const to = zonedLocalToUtc(customTo);
  if (Date.parse(from) >= Date.parse(to)) throw new Error("The custom range has to start before it ends.");
  return { kind: "custom", from, to };
}

function replayInstant(events: { sequence: number; occurredAt: string }[], fallback: number): number {
  let best: { sequence: number; occurredAt: string } | null = null;
  for (const event of events) {
    if (!best || event.sequence > best.sequence) best = event;
  }
  const parsed = best ? Date.parse(best.occurredAt) : Number.NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}
