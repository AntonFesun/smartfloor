import type {
  DurationStat,
  EventType,
  Metrics,
  Order,
  RestaurantTable,
  ServiceEvent,
  Thresholds,
  UnresolvedItem,
  WaiterCall,
  ZoneDelay,
} from "@/types";

const ZONE_ORDER = ["Main Hall", "Terrace", "Bar Lounge"];

function stat(values: number[]): DurationStat {
  if (values.length === 0) return { count: 0, avgMs: null };
  const sum = values.reduce((total, value) => total + value, 0);
  return { count: values.length, avgMs: sum / values.length };
}

function groupBy(events: ServiceEvent[], keyOf: (event: ServiceEvent) => string | null): Map<string, ServiceEvent[]> {
  const map = new Map<string, ServiceEvent[]>();
  for (const event of events) {
    const key = keyOf(event);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(event);
    else map.set(key, [event]);
  }
  return map;
}

function earliest(events: ServiceEvent[], type: EventType): number | null {
  let min: number | null = null;
  for (const event of events) {
    if (event.type !== type) continue;
    const time = Date.parse(event.timestamp);
    if (Number.isNaN(time)) continue;
    if (min === null || time < min) min = time;
  }
  return min;
}

function zoneOf(tables: RestaurantTable[], tableId: string): string {
  return tables.find((table) => table.id === tableId)?.zone ?? "Unknown";
}

function zoneRank(zone: string): number {
  const index = ZONE_ORDER.indexOf(zone);
  return index === -1 ? 50 : index;
}

export function computeMetrics(input: {
  events: ServiceEvent[];
  tables: RestaurantTable[];
  orders: Order[];
  waiterCalls: WaiterCall[];
  now: number;
  thresholds: Thresholds;
}): Metrics {
  const { events, tables, orders, waiterCalls, now, thresholds } = input;
  const submitToAccept: number[] = [];
  const acceptToReady: number[] = [];
  const readyToServed: number[] = [];
  const prepDelays: { zone: string; kind: "prep" | "ready" }[] = [];

  for (const group of groupBy(events, (event) => event.orderId).values()) {
    const tableId = group[0]?.tableId ?? "";
    const zone = zoneOf(tables, tableId);
    const submitted = earliest(group, "order.submitted");
    const accepted = earliest(group, "order.accepted");
    const ready = earliest(group, "order.ready");
    const served = earliest(group, "order.served");
    if (submitted != null && accepted != null && accepted >= submitted) {
      submitToAccept.push(accepted - submitted);
    }
    if (accepted != null && ready != null && ready >= accepted) {
      const duration = ready - accepted;
      acceptToReady.push(duration);
      if (duration > thresholds.prepMs) prepDelays.push({ zone, kind: "prep" });
    }
    if (ready != null && served != null && served >= ready) {
      const duration = served - ready;
      readyToServed.push(duration);
      if (duration > thresholds.readyMs) prepDelays.push({ zone, kind: "ready" });
    }
  }

  const waiterSamples: { ms: number; zone: string }[] = [];
  for (const group of groupBy(events, (event) => event.callId).values()) {
    const called = earliest(group, "waiter.called");
    const acknowledged = earliest(group, "waiter.acknowledged");
    if (called != null && acknowledged != null && acknowledged >= called) {
      waiterSamples.push({
        ms: acknowledged - called,
        zone: zoneOf(tables, group[0]?.tableId ?? ""),
      });
    }
  }

  const occupancySamples: { ms: number; zone: string }[] = [];
  const turnover: number[] = [];
  const openOccupancy: { tableId: string; since: number }[] = [];

  for (const [tableId, group] of groupBy(events, (event) => event.tableId)) {
    const sorted = [...group].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
    let open: number | null = null;
    const seatings: number[] = [];
    for (const event of sorted) {
      const time = Date.parse(event.timestamp);
      if (Number.isNaN(time)) continue;
      if (event.type === "guests.seated" && open == null) {
        open = time;
        seatings.push(time);
      } else if (event.type === "table.cleared" && open != null) {
        if (time >= open) occupancySamples.push({ ms: time - open, zone: zoneOf(tables, tableId) });
        open = null;
      }
    }
    if (open != null) openOccupancy.push({ tableId, since: open });
    for (let index = 1; index < seatings.length; index += 1) {
      const current = seatings[index];
      const previous = seatings[index - 1];
      if (current != null && previous != null && current >= previous) turnover.push(current - previous);
    }
  }

  const zoneNames = [...new Set([...tables.map((table) => table.zone), ...ZONE_ORDER])].sort(
    (a, b) => zoneRank(a) - zoneRank(b),
  );
  const delaysByZone: ZoneDelay[] = zoneNames.map((zone) => ({
    zone,
    waiter: waiterSamples.filter((sample) => sample.zone === zone && sample.ms > thresholds.waiterMs).length,
    prep: prepDelays.filter((sample) => sample.zone === zone && sample.kind === "prep").length,
    ready: prepDelays.filter((sample) => sample.zone === zone && sample.kind === "ready").length,
    occupancy: occupancySamples.filter((sample) => sample.zone === zone && sample.ms > thresholds.occupancyMs).length,
  }));

  let longest: UnresolvedItem | null = null;
  const consider = (item: UnresolvedItem) => {
    if (!longest || item.ms > longest.ms) longest = item;
  };
  for (const call of waiterCalls) {
    if (call.status === "RESOLVED") continue;
    const table = tables.find((item) => item.id === call.tableId);
    consider({
      kind: "waiter",
      tableId: call.tableId,
      tableNumber: table?.number ?? 0,
      ms: Math.max(0, now - Date.parse(call.createdAt)),
    });
  }
  for (const order of orders) {
    if (order.status === "SERVED" || order.status === "CANCELLED") continue;
    const table = tables.find((item) => item.id === order.tableId);
    consider({
      kind: "order",
      tableId: order.tableId,
      tableNumber: table?.number ?? 0,
      ms: Math.max(0, now - Date.parse(order.createdAt)),
    });
  }
  for (const seating of openOccupancy) {
    const table = tables.find((item) => item.id === seating.tableId);
    consider({
      kind: "occupancy",
      tableId: seating.tableId,
      tableNumber: table?.number ?? 0,
      ms: Math.max(0, now - seating.since),
    });
  }

  return {
    submitToAccept: stat(submitToAccept),
    acceptToReady: stat(acceptToReady),
    readyToServed: stat(readyToServed),
    waiterResponse: stat(waiterSamples.map((sample) => sample.ms)),
    occupancy: stat(occupancySamples.map((sample) => sample.ms)),
    turnover: stat(turnover),
    delaysByZone,
    longestUnresolved: longest,
    thresholds,
  };
}
