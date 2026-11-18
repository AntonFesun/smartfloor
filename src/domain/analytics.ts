import { RESTAURANT_TIME_ZONE, resolveTimeRange, type RestaurantEvent, type TimeRange, type TimeRangeKind } from "@/domain/journal";
import type { Thresholds } from "@/types";

export const HEAT_METRICS = ["ack", "resolution", "prep", "delivery", "calls", "occupancy", "orders", "sla"] as const;
export type HeatMetricId = (typeof HEAT_METRICS)[number];
export type HeatDirection = "higher-worse" | "activity";

export const SEVERITY_COLORS = ["#22c55e", "#eab308", "#f97316", "#ef4444"] as const;
export const ACTIVITY_COLORS = ["#64748b", "#38bdf8", "#818cf8", "#c084fc"] as const;
export const SEVERITY_LABELS = ["Healthy", "Moderate", "Elevated", "Critical"] as const;
export const ACTIVITY_LABELS = ["Quiet", "Steady", "Busy", "Very busy"] as const;

const COUNT_CAP = { calls: 8, orders: 8, sla: 4 } as const;

export interface AnalyticsTable {
  id: string;
  zone: string;
  number?: number;
}

export interface MetricReading {
  id: HeatMetricId;
  value: number | null;
  observations: number;
  normalized: number | null;
  direction: HeatDirection;
  unit: "ms" | "count";
}

export interface TableMetrics {
  tableId: string;
  zone: string;
  metrics: Record<HeatMetricId, MetricReading>;
}

export interface ZoneMetrics {
  zone: string;
  metrics: Record<HeatMetricId, MetricReading>;
}

export interface RestaurantMetrics {
  metrics: Record<HeatMetricId, MetricReading>;
}

export interface ServiceHeatmap {
  kind: TimeRangeKind;
  from: string;
  to: string;
  thresholds: Thresholds;
  tables: TableMetrics[];
  zones: ZoneMetrics[];
  restaurant: RestaurantMetrics;
}

export interface AnalyticsQuery {
  events: readonly RestaurantEvent[];
  tables: readonly AnalyticsTable[];
  range: TimeRange;
  now: number;
  thresholds: Thresholds;
  timeZone?: string;
}

const ZONE_ORDER = ["Main Hall", "Terrace", "Bar Lounge"];

const METRIC_COPY: Record<HeatMetricId, { label: string; direction: HeatDirection; unit: "ms" | "count"; summary: string }> = {
  ack: {
    label: "Waiter ack",
    direction: "higher-worse",
    unit: "ms",
    summary: "Average time from a waiter call until it is acknowledged. Longer is worse.",
  },
  resolution: {
    label: "Resolution",
    direction: "higher-worse",
    unit: "ms",
    summary: "Average time from a waiter call until it is resolved. Longer is worse.",
  },
  prep: {
    label: "Prep",
    direction: "higher-worse",
    unit: "ms",
    summary: "Average time from prep start until the order is ready. Longer is worse.",
  },
  delivery: {
    label: "Delivery",
    direction: "higher-worse",
    unit: "ms",
    summary: "Average time from ready until the order is served. Longer is worse.",
  },
  calls: {
    label: "Calls",
    direction: "activity",
    unit: "count",
    summary: "How many waiter calls were placed. This is activity, not a failure.",
  },
  occupancy: {
    label: "Occupancy",
    direction: "higher-worse",
    unit: "ms",
    summary: "Average time a party occupied the table. Longer than the threshold is worse.",
  },
  orders: {
    label: "Orders",
    direction: "activity",
    unit: "count",
    summary: "How many orders were created. This is activity, not a failure.",
  },
  sla: {
    label: "SLA violations",
    direction: "higher-worse",
    unit: "count",
    summary: "Ack, resolution, prep, delivery, and occupancy samples that passed their thresholds.",
  },
};

export function metricInfo(id: HeatMetricId) {
  return METRIC_COPY[id];
}

export function scaleCaption(id: HeatMetricId, thresholds: Thresholds): string {
  if (id === "ack" || id === "resolution") return `Full scale is twice the ${formatShort(thresholds.waiterMs)} waiter threshold.`;
  if (id === "prep") return `Full scale is twice the ${formatShort(thresholds.prepMs)} prep threshold.`;
  if (id === "delivery") return `Full scale is twice the ${formatShort(thresholds.readyMs)} delivery threshold.`;
  if (id === "occupancy") return `Full scale is twice the ${formatShort(thresholds.occupancyMs)} occupancy threshold.`;
  if (id === "calls") return "Eight calls fill the scale. Color shows volume, not a problem.";
  if (id === "orders") return "Eight orders fill the scale. Color shows volume, not a problem.";
  return "Four violations fill the scale.";
}

export function getTableMetrics(query: AnalyticsQuery): TableMetrics[] {
  return analyze(query).tables;
}

export function getZoneMetrics(query: AnalyticsQuery): ZoneMetrics[] {
  return analyze(query).zones;
}

export function getRestaurantMetrics(query: AnalyticsQuery): RestaurantMetrics {
  return analyze(query).restaurant;
}

export function getServiceHeatmap(query: AnalyticsQuery): ServiceHeatmap {
  return analyze(query);
}

export function heatColor(normalized: number | null, direction: HeatDirection): string | null {
  const band = bandIndex(normalized);
  if (band == null) return null;
  return (direction === "activity" ? ACTIVITY_COLORS : SEVERITY_COLORS)[band];
}

export function heatBand(normalized: number | null, direction: HeatDirection): "no-data" | "healthy" | "moderate" | "elevated" | "critical" | "quiet" | "steady" | "busy" | "very-busy" {
  const band = bandIndex(normalized);
  if (band == null) return "no-data";
  if (direction === "activity") return (["quiet", "steady", "busy", "very-busy"] as const)[band];
  return (["healthy", "moderate", "elevated", "critical"] as const)[band];
}

export function colorsFor(report: ServiceHeatmap | null, metric: HeatMetricId): Record<string, string | null> {
  if (!report) return {};
  const colors: Record<string, string | null> = {};
  for (const table of report.tables) {
    const reading = table.metrics[metric];
    colors[table.tableId] = heatColor(reading.normalized, reading.direction);
  }
  return colors;
}

export function compareToRestaurant(table: MetricReading, restaurant: MetricReading): string {
  if (table.value == null || table.observations === 0) return "No data";
  if (restaurant.value == null || restaurant.observations === 0) return "No restaurant average";
  const delta = table.value - restaurant.value;
  const average = formatMetricValue(restaurant.value, restaurant.unit);
  const same = table.unit === "ms" ? Math.abs(delta) < 500 : Math.abs(delta) < 0.05;
  if (same) return `Same as the restaurant average (${average})`;
  const amount = formatMetricValue(Math.abs(delta), table.unit);
  if (table.unit === "ms" && table.direction === "higher-worse") {
    return delta > 0
      ? `${amount} slower than the restaurant average (${average})`
      : `${amount} faster than the restaurant average (${average})`;
  }
  return delta > 0
    ? `${amount} above the restaurant average (${average})`
    : `${amount} below the restaurant average (${average})`;
}

export function formatMetricValue(value: number, unit: "ms" | "count"): string {
  if (unit === "ms") return formatShort(value);
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function zonedLocalToUtc(local: string, timeZone = RESTAURANT_TIME_ZONE): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error("Use YYYY-MM-DDTHH:mm");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  let utc = Date.UTC(year, month - 1, day, hour, minute);
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(format.formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
    const partHour = parts.hour === "24" ? 0 : Number(parts.hour);
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), partHour, Number(parts.minute), Number(parts.second));
    const desired = Date.UTC(year, month - 1, day, hour, minute);
    const delta = asUtc - desired;
    if (delta === 0) return new Date(utc).toISOString();
    utc -= delta;
  }
  return new Date(utc).toISOString();
}

interface DurationSample {
  tableId: string;
  zone: string;
  kind: "ack" | "resolution" | "prep" | "delivery" | "occupancy";
  ms: number;
}

interface CountSample {
  tableId: string;
  zone: string;
  kind: "calls" | "orders";
}

function analyze(query: AnalyticsQuery): ServiceHeatmap {
  const timeZone = query.timeZone ?? RESTAURANT_TIME_ZONE;
  const window = resolveTimeRange(query.range, query.now, timeZone);
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const zoneOf = new Map(query.tables.map((table) => [table.id, table.zone]));
  const durations: DurationSample[] = [];
  const counts: CountSample[] = [];

  for (const group of groupEvents(query.events, callKey).values()) {
    const called = earliest(group, "WAITER_CALLED");
    if (!called?.tableId) continue;
    const zone = zoneOf.get(called.tableId) ?? called.zoneId ?? "Unknown";
    if (inWindow(called.occurredAt, fromMs, toMs)) counts.push({ tableId: called.tableId, zone, kind: "calls" });
    const acked = earliest(group, "WAITER_CALL_ACKNOWLEDGED");
    const resolved = earliest(group, "WAITER_CALL_RESOLVED");
    pushDuration(durations, called.tableId, zone, "ack", measure(called.occurredAt, acked?.occurredAt ?? resolved?.occurredAt ?? null, fromMs, toMs, query.now));
    pushDuration(durations, called.tableId, zone, "resolution", measure(called.occurredAt, resolved?.occurredAt ?? null, fromMs, toMs, query.now));
  }

  for (const group of groupEvents(query.events, (event) => event.orderId).values()) {
    const created = earliest(group, "ORDER_CREATED");
    const preparing = earliest(group, "ORDER_PREPARING");
    const ready = earliest(group, "ORDER_READY");
    const served = earliest(group, "ORDER_SERVED");
    const anchor = created ?? preparing ?? ready ?? served;
    if (!anchor?.tableId) continue;
    const zone = zoneOf.get(anchor.tableId) ?? anchor.zoneId ?? "Unknown";
    if (created && inWindow(created.occurredAt, fromMs, toMs)) counts.push({ tableId: anchor.tableId, zone, kind: "orders" });
    if (preparing) pushDuration(durations, anchor.tableId, zone, "prep", measure(preparing.occurredAt, ready?.occurredAt ?? null, fromMs, toMs, query.now));
    if (ready) pushDuration(durations, anchor.tableId, zone, "delivery", measure(ready.occurredAt, served?.occurredAt ?? null, fromMs, toMs, query.now));
  }

  for (const [tableId, group] of groupEvents(query.events, (event) => event.tableId)) {
    const zone = zoneOf.get(tableId) ?? group[0]?.zoneId ?? "Unknown";
    let open: string | null = null;
    for (const event of [...group].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))) {
      if ((event.type === "GUEST_SEATED" || event.type === "TABLE_OCCUPIED") && !open) open = event.occurredAt;
      if (open && (event.type === "GUEST_LEFT" || event.type === "TABLE_RELEASED")) {
        pushDuration(durations, tableId, zone, "occupancy", measure(open, event.occurredAt, fromMs, toMs, query.now));
        open = null;
      }
    }
    if (open) pushDuration(durations, tableId, zone, "occupancy", measure(open, null, fromMs, toMs, query.now));
  }

  const tables = [...query.tables].sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.id.localeCompare(b.id));
  const tableMetrics = tables.map((table) => ({
    tableId: table.id,
    zone: table.zone,
    metrics: readingsFor(
      durations.filter((sample) => sample.tableId === table.id),
      counts.filter((sample) => sample.tableId === table.id),
      query.thresholds,
      "table",
    ),
  }));

  const zoneNames = [...new Set([...tables.map((table) => table.zone), ...ZONE_ORDER])].sort((a, b) => zoneRank(a) - zoneRank(b));
  const zones = zoneNames.map((zone) => ({
    zone,
    metrics: readingsFor(
      durations.filter((sample) => sample.zone === zone),
      counts.filter((sample) => sample.zone === zone),
      query.thresholds,
      "group",
    ),
  }));

  return {
    kind: query.range.kind,
    from: window.from,
    to: window.to,
    thresholds: query.thresholds,
    tables: tableMetrics,
    zones,
    restaurant: {
      metrics: readingsFor(durations, counts, query.thresholds, "group"),
    },
  };
}

function readingsFor(durations: DurationSample[], counts: CountSample[], thresholds: Thresholds, scope: "table" | "group"): Record<HeatMetricId, MetricReading> {
  const ack = durations.filter((sample) => sample.kind === "ack").map((sample) => sample.ms);
  const resolution = durations.filter((sample) => sample.kind === "resolution").map((sample) => sample.ms);
  const prep = durations.filter((sample) => sample.kind === "prep").map((sample) => sample.ms);
  const delivery = durations.filter((sample) => sample.kind === "delivery").map((sample) => sample.ms);
  const occupancy = durations.filter((sample) => sample.kind === "occupancy").map((sample) => sample.ms);
  const checked = [...ack, ...resolution, ...prep, ...delivery, ...occupancy];
  const violations = [
    ...ack.filter((ms) => ms > thresholds.waiterMs),
    ...resolution.filter((ms) => ms > thresholds.waiterMs),
    ...prep.filter((ms) => ms > thresholds.prepMs),
    ...delivery.filter((ms) => ms > thresholds.readyMs),
    ...occupancy.filter((ms) => ms > thresholds.occupancyMs),
  ];
  return {
    ack: durationReading("ack", ack, thresholds.waiterMs),
    resolution: durationReading("resolution", resolution, thresholds.waiterMs),
    prep: durationReading("prep", prep, thresholds.prepMs),
    delivery: durationReading("delivery", delivery, thresholds.readyMs),
    calls: countReading("calls", counts.filter((sample) => sample.kind === "calls"), COUNT_CAP.calls, "activity", scope),
    occupancy: durationReading("occupancy", occupancy, thresholds.occupancyMs),
    orders: countReading("orders", counts.filter((sample) => sample.kind === "orders"), COUNT_CAP.orders, "activity", scope),
    sla: slaReading(violations.length, checked.length),
  };
}

function durationReading(id: HeatMetricId, samples: number[], threshold: number): MetricReading {
  if (samples.length === 0) return emptyReading(id, "ms", "higher-worse");
  const value = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  return {
    id,
    value,
    observations: samples.length,
    normalized: clamp(value / (threshold * 2)),
    direction: "higher-worse",
    unit: "ms",
  };
}

function countReading(id: HeatMetricId, samples: CountSample[], cap: number, direction: HeatDirection, scope: "table" | "group"): MetricReading {
  if (samples.length === 0) return emptyReading(id, "count", direction);
  if (scope === "table") {
    return {
      id,
      value: samples.length,
      observations: samples.length,
      normalized: clamp(samples.length / cap),
      direction,
      unit: "count",
    };
  }
  const perTable = new Map<string, number>();
  for (const sample of samples) perTable.set(sample.tableId, (perTable.get(sample.tableId) ?? 0) + 1);
  const counts = [...perTable.values()];
  const value = counts.reduce((sum, count) => sum + count, 0) / counts.length;
  return {
    id,
    value,
    observations: counts.length,
    normalized: clamp(value / cap),
    direction,
    unit: "count",
  };
}

function slaReading(violations: number, checked: number): MetricReading {
  if (checked === 0) return emptyReading("sla", "count", "higher-worse");
  return {
    id: "sla",
    value: violations,
    observations: checked,
    normalized: clamp(violations / COUNT_CAP.sla),
    direction: "higher-worse",
    unit: "count",
  };
}

function emptyReading(id: HeatMetricId, unit: "ms" | "count", direction: HeatDirection): MetricReading {
  return { id, value: null, observations: 0, normalized: null, direction, unit };
}

function pushDuration(samples: DurationSample[], tableId: string, zone: string, kind: DurationSample["kind"], ms: number | null) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return;
  samples.push({ tableId, zone, kind, ms });
}

function measure(startIso: string, endIso: string | null, fromMs: number, toMs: number, now: number): number | null {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  if (endIso != null) {
    const end = Date.parse(endIso);
    if (Number.isNaN(end) || end < start) return null;
    if (end >= fromMs && end < toMs) return end - start;
    return null;
  }
  if (now >= fromMs && now < toMs && start <= now && start < toMs) return now - start;
  return null;
}

function inWindow(iso: string, fromMs: number, toMs: number): boolean {
  const time = Date.parse(iso);
  return !Number.isNaN(time) && time >= fromMs && time < toMs;
}

function groupEvents(events: readonly RestaurantEvent[], keyOf: (event: RestaurantEvent) => string | null): Map<string, RestaurantEvent[]> {
  const groups = new Map<string, RestaurantEvent[]>();
  for (const event of events) {
    const key = keyOf(event);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }
  return groups;
}

function earliest(events: RestaurantEvent[], type: RestaurantEvent["type"]): RestaurantEvent | null {
  let found: RestaurantEvent | null = null;
  for (const event of events) {
    if (event.type !== type) continue;
    if (!found || event.sequence < found.sequence) found = event;
  }
  return found;
}

function callKey(event: RestaurantEvent): string | null {
  if (event.type !== "WAITER_CALLED" && event.type !== "WAITER_CALL_ACKNOWLEDGED" && event.type !== "WAITER_CALL_RESOLVED") return null;
  if (typeof event.payload.callId === "string") return event.payload.callId;
  const call = event.payload.call;
  if (call && typeof call === "object" && typeof (call as { id?: unknown }).id === "string") return (call as { id: string }).id;
  return event.id;
}

function bandIndex(normalized: number | null): 0 | 1 | 2 | 3 | null {
  if (normalized == null || Number.isNaN(normalized)) return null;
  const value = clamp(normalized);
  if (value < 0.25) return 0;
  if (value < 0.5) return 1;
  if (value < 0.75) return 2;
  return 3;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function zoneRank(zone: string): number {
  const index = ZONE_ORDER.indexOf(zone);
  return index === -1 ? 50 : index;
}

function formatShort(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const totalSeconds = Math.round(Math.abs(ms) / 1000);
  if (totalSeconds < 60) return `${sign}${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${sign}${minutes}m` : `${sign}${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${sign}${hours}h` : `${sign}${hours}h ${remainder}m`;
}
