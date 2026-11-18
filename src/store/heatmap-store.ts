import { create } from "zustand";
import { colorsFor, type HeatMetricId, type ServiceHeatmap } from "@/domain/analytics";
import type { TimeRangeKind } from "@/domain/journal";
import { revenueColors, type RevenueReport } from "@/domain/revenue";

export type FloorMode = "operations" | "heatmap" | "revenue";

interface HeatmapState {
  mode: FloorMode;
  metric: HeatMetricId;
  rangeKind: TimeRangeKind;
  customFrom: string;
  customTo: string;
  report: ServiceHeatmap | null;
  revenueReport: RevenueReport | null;
  colors: Record<string, string | null>;
  error: string | null;
  setMode: (mode: FloorMode) => void;
  setMetric: (metric: HeatMetricId) => void;
  setRangeKind: (rangeKind: TimeRangeKind) => void;
  setCustom: (customFrom: string, customTo: string) => void;
  setReport: (report: ServiceHeatmap | null, error?: string | null) => void;
  setRevenue: (revenueReport: RevenueReport | null, error?: string | null) => void;
}

export const useHeatmapStore = create<HeatmapState>((set) => ({
  mode: "operations",
  metric: "ack",
  rangeKind: "today",
  customFrom: "",
  customTo: "",
  report: null,
  revenueReport: null,
  colors: {},
  error: null,
  setMode: (mode) =>
    set((state) => ({
      mode,
      colors: mode === "heatmap" ? colorsFor(state.report, state.metric) : mode === "revenue" ? revenueColors(state.revenueReport) : {},
    })),
  setMetric: (metric) =>
    set((state) => ({
      metric,
      colors: state.mode === "heatmap" ? colorsFor(state.report, metric) : state.colors,
    })),
  setRangeKind: (rangeKind) => set({ rangeKind }),
  setCustom: (customFrom, customTo) => set({ customFrom, customTo }),
  setReport: (report, error = null) =>
    set((state) => {
      const colors = state.mode === "heatmap" ? colorsFor(report, state.metric) : state.colors;
      if (state.error === error && state.report === report && sameColors(state.colors, colors)) return state;
      if (state.error === error && sameHeat(state.report, report) && sameColors(state.colors, colors)) return state;
      return {
        report: sameHeat(state.report, report) ? state.report : report,
        colors: sameColors(state.colors, colors) ? state.colors : colors,
        error,
      };
    }),
  setRevenue: (revenueReport, error = null) =>
    set((state) => {
      const colors = state.mode === "revenue" ? revenueColors(revenueReport) : state.colors;
      if (state.error === error && sameRevenue(state.revenueReport, revenueReport) && sameColors(state.colors, colors)) return state;
      return {
        revenueReport: sameRevenue(state.revenueReport, revenueReport) ? state.revenueReport : revenueReport,
        colors: sameColors(state.colors, colors) ? state.colors : colors,
        error,
      };
    }),
}));

function sameColors(left: Record<string, string | null>, right: Record<string, string | null>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function sameRevenue(left: RevenueReport | null, right: RevenueReport | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.from !== right.from || left.to !== right.to) return false;
  if (left.tables.length !== right.tables.length) return false;
  for (let index = 0; index < left.tables.length; index += 1) {
    const a = left.tables[index];
    const b = right.tables[index];
    if (!a || !b || a.tableId !== b.tableId) return false;
    if (a.economics.recordedSales !== b.economics.recordedSales || a.economics.orderCount !== b.economics.orderCount) return false;
    if (a.economics.salesPerOccupiedHour !== b.economics.salesPerOccupiedHour) return false;
  }
  return true;
}

function sameHeat(left: ServiceHeatmap | null, right: ServiceHeatmap | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.from !== right.from || left.to !== right.to || left.kind !== right.kind) return false;
  if (left.tables.length !== right.tables.length) return false;
  for (let index = 0; index < left.tables.length; index += 1) {
    const a = left.tables[index];
    const b = right.tables[index];
    if (!a || !b || a.tableId !== b.tableId) return false;
    for (const id of Object.keys(a.metrics) as HeatMetricId[]) {
      if (a.metrics[id].value !== b.metrics[id].value || a.metrics[id].observations !== b.metrics[id].observations) return false;
    }
  }
  return true;
}
