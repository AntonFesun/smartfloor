import { resolveTimeRange, type RestaurantEvent, type TimeRange, type TimeRangeKind } from "@/domain/journal";
import type { AnalyticsTable } from "@/domain/analytics";

export const ATTRIBUTION_RULE =
  "A recorded payment is counted once, on the table that owns the order. Other tables in a group do not get a copy. Unpaid orders are not collected revenue. Cancelled orders are not completed sales. Profit is not estimated.";

export const REVENUE_COLORS = ["#d9f99d", "#4ade80", "#166534", "#a16207"] as const;
export const REVENUE_LABELS = ["Lower", "Steady", "Strong", "High"] as const;
export const REVENUE_SALES_CAP = 1500;

export const DEMO_PAID_ORDER_IDS = ["ord-seed-01", "ord-seed-06", "ord-seed-03"] as const;

export interface PaymentRecord {
  id: string;
  orderId: string;
  tableId: string;
  amount: number;
  paidAt: string;
  note: string;
}

export interface RevenueOrder {
  id: string;
  tableId: string;
  status: "NEW" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  total: number;
  createdAt: string;
}

export interface RevenueGroup {
  id: string;
  tableIds: string[];
  status: "ACTIVE" | "DISSOLVED";
}

export interface TableEconomics {
  recordedSales: number | null;
  orderCount: number;
  averageOrderValue: number | null;
  occupiedMinutes: number | null;
  salesPerOccupiedHour: number | null;
  completedSeatings: number;
}

export interface TableRevenue {
  tableId: string;
  zone: string;
  economics: TableEconomics;
  groupWith: string[];
}

export interface ZoneRevenue {
  zone: string;
  economics: TableEconomics;
}

export interface RevenueReport {
  kind: TimeRangeKind;
  from: string;
  to: string;
  attribution: string;
  tables: TableRevenue[];
  zones: ZoneRevenue[];
  restaurant: { economics: TableEconomics };
}

export interface RevenueQuery {
  payments: readonly PaymentRecord[];
  orders: readonly RevenueOrder[];
  events: readonly RestaurantEvent[];
  tables: readonly AnalyticsTable[];
  groups?: readonly RevenueGroup[];
  range: TimeRange;
  now: number;
  timeZone?: string;
}

const ZONE_ORDER = ["Main Hall", "Terrace", "Bar Lounge"];

export function getRevenueMap(query: RevenueQuery): RevenueReport {
  const window = resolveTimeRange(query.range, query.now, query.timeZone);
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const orders = new Map(query.orders.map((order) => [order.id, order]));
  const counted = new Set<string>();
  const sales = new Map<string, { amount: number; paidOrders: number }>();
  const orderCounts = new Map<string, number>();

  for (const payment of query.payments) {
    if (counted.has(payment.id)) continue;
    const paidAt = Date.parse(payment.paidAt);
    if (Number.isNaN(paidAt) || paidAt < fromMs || paidAt >= toMs) continue;
    const order = orders.get(payment.orderId);
    if (order?.status === "CANCELLED") continue;
    const tableId = order?.tableId ?? payment.tableId;
    if (!tableId) continue;
    counted.add(payment.id);
    const current = sales.get(tableId) ?? { amount: 0, paidOrders: 0 };
    current.amount += payment.amount;
    current.paidOrders += 1;
    sales.set(tableId, current);
  }

  for (const order of query.orders) {
    if (order.status === "CANCELLED") continue;
    const created = Date.parse(order.createdAt);
    if (Number.isNaN(created) || created < fromMs || created >= toMs) continue;
    orderCounts.set(order.tableId, (orderCounts.get(order.tableId) ?? 0) + 1);
  }

  const occupancy = occupancyByTable(query.events, fromMs, toMs, query.now);
  const activeGroups = (query.groups ?? []).filter((group) => group.status === "ACTIVE");
  const tables = [...query.tables].sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.id.localeCompare(b.id));
  const tableRows = tables.map((table) => ({
    tableId: table.id,
    zone: table.zone,
    economics: economicsFor(sales.get(table.id), orderCounts.get(table.id) ?? 0, occupancy.get(table.id)),
    groupWith: activeGroups.find((group) => group.tableIds.includes(table.id))?.tableIds.filter((id) => id !== table.id) ?? [],
  }));

  const zoneNames = [...new Set([...tables.map((table) => table.zone), ...ZONE_ORDER])].sort((a, b) => zoneRank(a) - zoneRank(b));
  const zones = zoneNames.map((zone) => ({
    zone,
    economics: combine(tableRows.filter((row) => row.zone === zone).map((row) => row.economics), sales, orderCounts, occupancy, tables.filter((table) => table.zone === zone).map((table) => table.id)),
  }));

  return {
    kind: query.range.kind,
    from: window.from,
    to: window.to,
    attribution: ATTRIBUTION_RULE,
    tables: tableRows,
    zones,
    restaurant: {
      economics: combine(tableRows.map((row) => row.economics), sales, orderCounts, occupancy, tables.map((table) => table.id)),
    },
  };
}

export function revenueColor(recordedSales: number | null): string | null {
  if (recordedSales == null || !Number.isFinite(recordedSales)) return null;
  const normalized = Math.min(1, Math.max(0, recordedSales / REVENUE_SALES_CAP));
  if (normalized < 0.25) return REVENUE_COLORS[0];
  if (normalized < 0.5) return REVENUE_COLORS[1];
  if (normalized < 0.75) return REVENUE_COLORS[2];
  return REVENUE_COLORS[3];
}

export function revenueColors(report: RevenueReport | null): Record<string, string | null> {
  if (!report) return {};
  const colors: Record<string, string | null> = {};
  for (const table of report.tables) colors[table.tableId] = revenueColor(table.economics.recordedSales);
  return colors;
}

function economicsFor(
  paid: { amount: number; paidOrders: number } | undefined,
  orderCount: number,
  stay: { minutes: number; closed: number } | undefined,
): TableEconomics {
  const recordedSales = paid ? paid.amount : null;
  const occupiedMinutes = stay ? stay.minutes : null;
  return {
    recordedSales,
    orderCount,
    averageOrderValue: paid && paid.paidOrders > 0 ? paid.amount / paid.paidOrders : null,
    occupiedMinutes,
    salesPerOccupiedHour: recordedSales != null && occupiedMinutes != null && occupiedMinutes > 0 ? recordedSales / (occupiedMinutes / 60) : null,
    completedSeatings: stay?.closed ?? 0,
  };
}

function combine(
  rows: TableEconomics[],
  sales: Map<string, { amount: number; paidOrders: number }>,
  orderCounts: Map<string, number>,
  occupancy: Map<string, { minutes: number; closed: number }>,
  tableIds: string[],
): TableEconomics {
  let amount = 0;
  let paidOrders = 0;
  let sawPayment = false;
  let minutes = 0;
  let sawStay = false;
  let closed = 0;
  let orders = 0;
  for (const tableId of tableIds) {
    const paid = sales.get(tableId);
    if (paid) {
      sawPayment = true;
      amount += paid.amount;
      paidOrders += paid.paidOrders;
    }
    orders += orderCounts.get(tableId) ?? 0;
    const stay = occupancy.get(tableId);
    if (stay) {
      sawStay = true;
      minutes += stay.minutes;
      closed += stay.closed;
    }
  }
  if (rows.length === 0 && tableIds.length === 0) {
    return { recordedSales: null, orderCount: 0, averageOrderValue: null, occupiedMinutes: null, salesPerOccupiedHour: null, completedSeatings: 0 };
  }
  const recordedSales = sawPayment ? amount : null;
  const occupiedMinutes = sawStay ? minutes : null;
  return {
    recordedSales,
    orderCount: orders,
    averageOrderValue: paidOrders > 0 ? amount / paidOrders : null,
    occupiedMinutes,
    salesPerOccupiedHour: recordedSales != null && occupiedMinutes != null && occupiedMinutes > 0 ? recordedSales / (occupiedMinutes / 60) : null,
    completedSeatings: closed,
  };
}

function occupancyByTable(events: readonly RestaurantEvent[], fromMs: number, toMs: number, now: number): Map<string, { minutes: number; closed: number }> {
  const result = new Map<string, { minutes: number; closed: number }>();
  const groups = new Map<string, RestaurantEvent[]>();
  for (const event of events) {
    if (!event.tableId) continue;
    if (event.type !== "GUEST_SEATED" && event.type !== "TABLE_OCCUPIED" && event.type !== "GUEST_LEFT" && event.type !== "TABLE_RELEASED") continue;
    const list = groups.get(event.tableId) ?? [];
    list.push(event);
    groups.set(event.tableId, list);
  }
  for (const [tableId, list] of groups) {
    const sorted = [...list].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    let open: string | null = null;
    let minutes = 0;
    let closed = 0;
    let saw = false;
    const add = (startIso: string, endIso: string | null) => {
      const ms = measure(startIso, endIso, fromMs, toMs, now);
      if (ms == null) return;
      saw = true;
      minutes += ms / 60000;
      if (endIso) closed += 1;
    };
    for (const event of sorted) {
      if ((event.type === "GUEST_SEATED" || event.type === "TABLE_OCCUPIED") && !open) open = event.occurredAt;
      if (open && (event.type === "GUEST_LEFT" || event.type === "TABLE_RELEASED")) {
        add(open, event.occurredAt);
        open = null;
      }
    }
    if (open) add(open, null);
    if (saw) result.set(tableId, { minutes, closed });
  }
  return result;
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

function zoneRank(zone: string): number {
  const index = ZONE_ORDER.indexOf(zone);
  return index === -1 ? 50 : index;
}
