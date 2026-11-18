import { zonedLocalToUtc } from "@/domain/analytics";
import { RESTAURANT_TIME_ZONE, type JournalEventType } from "@/domain/journal";
import type { KitchenStation } from "@/domain/kitchen";
import type { EventType, MenuItem, Order, OrderStatus, WaiterCall } from "@/types";

export const MONTH_HISTORY_DAYS = 30;
export const MONTH_HISTORY_GAP_MS = 6 * 60 * 60 * 1000;
const MIN = 60_000;

export interface HistoryTable {
  id: string;
  number: number;
  zone: string;
  capacity: number;
}

export interface HistoryOrderItem {
  id: string;
  orderId: string;
  menuItemId: string;
  name: string;
  qty: number;
  price: number;
}

export interface HistoryOrder {
  id: string;
  tableId: string;
  status: OrderStatus;
  total: number;
  createdAt: string;
  updatedAt: string;
  items: HistoryOrderItem[];
}

export interface HistoryCall {
  id: string;
  tableId: string;
  status: "RESOLVED";
  createdAt: string;
  acknowledgedAt: string;
  resolvedAt: string;
}

export interface HistoryPayment {
  id: string;
  orderId: string;
  tableId: string;
  amount: number;
  paidAt: string;
  note: string;
}

export interface HistoryTicketItem {
  id: string;
  ticketId: string;
  menuItemId: string;
  name: string;
  qty: number;
  done: number;
}

export interface HistoryTicket {
  id: string;
  number: number;
  orderId: string;
  tableId: string;
  station: KitchenStation;
  status: "COMPLETED" | "CANCELLED";
  createdAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  items: HistoryTicketItem[];
}

export interface HistoryTask {
  id: string;
  type: "deliver_order" | "respond_to_call";
  orderId: string | null;
  tableId: string;
  callId: string | null;
  status: "COMPLETED";
  priority: number;
  createdAt: string;
  acknowledgedAt: string | null;
  completedAt: string;
  assignedWaiterId: string;
}

export interface HistoryReservation {
  id: string;
  partySize: number;
  startAt: string;
  endAt: string;
  tableId: string | null;
  groupId: string | null;
  status: "COMPLETED" | "CANCELLED" | "CONFIRMED";
  createdAt: string;
}

export interface HistoryGroup {
  id: string;
  status: "DISSOLVED";
  createdAt: string;
  dissolvedAt: string;
  tableIds: string[];
}

export interface HistoryShift {
  id: string;
  waiterId: string;
  startedAt: string;
  endedAt: string;
}

export interface HistoryServiceEvent {
  id: string;
  tableId: string;
  timestamp: string;
  type: EventType;
  orderId: string | null;
  callId: string | null;
  metadata: Record<string, unknown>;
}

export interface HistoryJournalEvent {
  id: string;
  type: JournalEventType;
  occurredAt: string;
  occurredMs: number;
  rank: number;
  tableId: string | null;
  orderId: string | null;
  waiterId: string | null;
  zoneId: string | null;
  sessionId: string | null;
  commandId: string;
  payload: Record<string, unknown>;
}

export interface MonthHistory {
  orders: HistoryOrder[];
  calls: HistoryCall[];
  payments: HistoryPayment[];
  tickets: HistoryTicket[];
  tasks: HistoryTask[];
  reservations: HistoryReservation[];
  groups: HistoryGroup[];
  shifts: HistoryShift[];
  serviceEvents: HistoryServiceEvent[];
  journal: HistoryJournalEvent[];
}

interface Wave {
  hour: number;
  minute: number;
  count: number;
  meal: "lunch" | "dinner";
  group: boolean;
}

const WAITERS: Record<string, string[]> = {
  "Main Hall": ["waiter-marta", "waiter-sofia"],
  Terrace: ["waiter-oleh"],
  "Bar Lounge": ["waiter-iryna"],
};

const BASKETS: { ids: string[]; meal: "lunch" | "dinner" | "both" }[] = [
  { ids: ["menu-soup", "menu-water"], meal: "lunch" },
  { ids: ["menu-bruschetta", "menu-espresso"], meal: "lunch" },
  { ids: ["menu-risotto", "menu-lemonade"], meal: "both" },
  { ids: ["menu-burger", "menu-cola"], meal: "both" },
  { ids: ["menu-margherita", "menu-water"], meal: "both" },
  { ids: ["menu-tartare", "menu-flatwhite"], meal: "both" },
  { ids: ["menu-ribeye", "menu-water"], meal: "dinner" },
  { ids: ["menu-salmon", "menu-lemonade", "menu-tiramisu"], meal: "dinner" },
  { ids: ["menu-diavola", "menu-cola"], meal: "dinner" },
  { ids: ["menu-formaggi", "menu-burrata"], meal: "dinner" },
  { ids: ["menu-cheesecake", "menu-cappuccino"], meal: "both" },
];

const PREP_MINUTES: Record<string, number> = {
  "menu-ribeye": 24,
  "menu-salmon": 18,
  "menu-risotto": 16,
  "menu-burger": 12,
  "menu-margherita": 14,
  "menu-diavola": 15,
  "menu-formaggi": 15,
  "menu-soup": 9,
  "menu-burrata": 6,
  "menu-tartare": 8,
  "menu-bruschetta": 7,
  "menu-tiramisu": 4,
  "menu-cheesecake": 4,
  "menu-espresso": 3,
  "menu-cappuccino": 4,
  "menu-flatwhite": 4,
};

const PAYMENT_NOTE = "Demo payment. Not a card processor.";

export function buildMonthHistory(input: {
  now: number;
  tables: HistoryTable[];
  menu: MenuItem[];
  busy: { tableId: string; start: number; end: number }[];
}): MonthHistory {
  const historyEnd = input.now - MONTH_HISTORY_GAP_MS;
  const menu = new Map(input.menu.map((item) => [item.id, item]));
  const tables = [...input.tables].sort((a, b) => a.number - b.number);
  const byId = new Map(tables.map((table) => [table.id, table]));
  const booked = new Map<string, [number, number][]>();
  for (const interval of input.busy) {
    const list = booked.get(interval.tableId) ?? [];
    list.push([interval.start, interval.end]);
    booked.set(interval.tableId, list);
  }
  const rng = mulberry32(0x5f17e11);
  const ids = counter();
  const history: MonthHistory = {
    orders: [],
    calls: [],
    payments: [],
    tickets: [],
    tasks: [],
    reservations: [],
    groups: [],
    shifts: [],
    serviceEvents: [],
    journal: [],
  };
  let ticketNumber = 100;
  let hallTurn = 0;
  const today = kyivYmd(input.now);

  for (let offset = MONTH_HISTORY_DAYS - 1; offset >= 0; offset -= 1) {
    const day = addCalendarDays(today.year, today.month, today.day, -offset);
    const dayIndex = MONTH_HISTORY_DAYS - 1 - offset;
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
    addShifts(history, ids, day, weekday, historyEnd);
    if (weekday === 1 || weekday === 4) {
      addCancelledReservation(history, ids, byId, day, weekday, historyEnd);
    }
    for (const [waveIndex, wave] of wavesFor(weekday).entries()) {
      const waveStart = kyivMs(day, wave.hour, wave.minute);
      if (waveStart >= historyEnd) continue;
      const ranked = rankTables(tables, dayIndex, waveIndex);
      const picked: HistoryTable[] = [];
      for (const table of ranked) {
        if (picked.length >= wave.count) break;
        const probeEnd = waveStart + 100 * MIN;
        if (overlaps(booked, table.id, waveStart, probeEnd)) continue;
        picked.push(table);
      }
      ensureZone(picked, ranked, wave.count, booked, waveStart);
      if (wave.group) forcePair(picked, byId, booked, waveStart, "T05", "T06");
      const groupIds = wave.group && picked.some((table) => table.id === "T05") && picked.some((table) => table.id === "T06")
        ? ["T05", "T06"]
        : null;
      for (const table of picked) {
        if (groupIds && table.id === "T06") continue;
        const seat = waveStart + Math.floor(rng() * 8) * MIN;
        const companions = groupIds && table.id === "T05" ? groupIds.map((id) => byId.get(id)!) : [table];
        const visit = planVisit({
          rng,
          menu,
          table,
          companions,
          seat,
          meal: wave.meal,
          historyEnd,
          waiterId: waiterFor(table.zone, hallTurn),
          group: groupIds != null && table.id === "T05",
        });
        hallTurn += 1;
        if (!visit) continue;
        if (companions.some((item) => overlaps(booked, item.id, visit.seat, visit.leave))) continue;
        for (const item of companions) {
          const list = booked.get(item.id) ?? [];
          list.push([visit.seat, visit.leave]);
          booked.set(item.id, list);
        }
        ticketNumber = commitVisit(history, ids, visit, companions, ticketNumber);
      }
    }
  }

  addUpcomingReservations(history, ids, byId, input.now, historyEnd);
  history.journal.sort((a, b) => a.occurredMs - b.occurredMs || a.rank - b.rank || a.id.localeCompare(b.id));
  history.serviceEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  return history;
}

interface PlannedVisit {
  seat: number;
  leave: number;
  meal: "lunch" | "dinner";
  waiterId: string;
  table: HistoryTable;
  party: number;
  companions: HistoryTable[];
  group: boolean;
  reserved: boolean;
  reservationStart: number;
  call: { called: number; acknowledged: number; resolved: number } | null;
  orders: PlannedOrder[];
}

interface PlannedOrder {
  submitted: number;
  accepted: number;
  prep: number | null;
  ready: number | null;
  served: number | null;
  cancelled: number | null;
  paid: number | null;
  lines: { menu: MenuItem; qty: number }[];
  status: OrderStatus;
}

function planVisit(input: {
  rng: () => number;
  menu: Map<string, MenuItem>;
  table: HistoryTable;
  companions: HistoryTable[];
  seat: number;
  meal: "lunch" | "dinner";
  historyEnd: number;
  waiterId: string;
  group: boolean;
}): PlannedVisit | null {
  const capacity = input.companions.reduce((sum, table) => sum + table.capacity, 0);
  const party = input.group ? 8 : partySize(input.rng, input.table.capacity);
  if (party > capacity) return null;
  const stay = 62 + Math.floor(input.rng() * 28);
  const cancelled = input.rng() < 0.06;
  const lines = linesFor(input.menu, input.rng, input.meal, party);
  if (lines.length === 0) return null;
  const prepMinutes = Math.max(8, ...lines.map((line) => PREP_MINUTES[line.menu.id] ?? 8)) + (input.rng() < 0.12 ? 8 : 0);
  const submitted = input.seat + 8 * MIN;
  const accepted = submitted + MIN;
  const first: PlannedOrder = cancelled
    ? {
        submitted,
        accepted,
        prep: null,
        ready: null,
        served: null,
        cancelled: accepted + 6 * MIN,
        paid: null,
        lines,
        status: "CANCELLED",
      }
    : {
        submitted,
        accepted,
        prep: accepted + MIN,
        ready: accepted + MIN + prepMinutes * MIN,
        served: accepted + MIN + prepMinutes * MIN + 4 * MIN,
        cancelled: null,
        paid: accepted + MIN + prepMinutes * MIN + 7 * MIN,
        lines,
        status: "SERVED",
      };
  const orders = [first];
  if (!cancelled && input.meal === "dinner" && input.rng() < 0.14) {
    const secondLines = linesFor(input.menu, input.rng, "lunch", 2).filter((line) => line.menu.category === "Desserts" || line.menu.category === "Coffee");
    const dessert = secondLines.length > 0 ? secondLines : linesFor(input.menu, input.rng, "lunch", 1).slice(0, 1);
    if (dessert.length > 0 && first.served != null) {
      const start = first.served + 6 * MIN;
      const prep = Math.max(...dessert.map((line) => PREP_MINUTES[line.menu.id] ?? 4));
      orders.push({
        submitted: start,
        accepted: start + 30_000,
        prep: start + MIN,
        ready: start + MIN + prep * MIN,
        served: start + MIN + prep * MIN + 3 * MIN,
        cancelled: null,
        paid: start + MIN + prep * MIN + 6 * MIN,
        lines: dessert,
        status: "SERVED",
      });
    }
  }
  const lastPaid = orders.reduce((max, order) => Math.max(max, order.paid ?? order.cancelled ?? 0), 0);
  const leave = Math.max(input.seat + stay * MIN, lastPaid + 4 * MIN);
  if (leave > input.historyEnd || input.seat >= input.historyEnd) return null;
  const slowCall = input.rng() < 0.12;
  const call = input.rng() < 0.34
    ? {
        called: input.seat + 3 * MIN,
        acknowledged: input.seat + 3 * MIN + (slowCall ? 7 : 1.5) * MIN,
        resolved: input.seat + 3 * MIN + (slowCall ? 9 : 3.5) * MIN,
      }
    : null;
  const reserved = input.meal === "dinner" && input.rng() < 0.48;
  return {
    seat: input.seat,
    leave,
    meal: input.meal,
    waiterId: input.waiterId,
    table: input.table,
    party,
    companions: input.companions,
    group: input.group,
    reserved,
    reservationStart: input.seat - 8 * 60 * MIN,
    call,
    orders,
  };
}

function commitVisit(history: MonthHistory, ids: () => number, visit: PlannedVisit, companions: HistoryTable[], ticketNumber: number): number {
  const sessionId = seqId("seat-m", ids());
  const commandId = seqId("cmd-m", ids());
  const seats = splitSeats(visit.party, companions);
  let groupId: string | null = null;
  if (visit.group) {
    groupId = seqId("grp-m", ids());
    history.groups.push({
      id: groupId,
      status: "DISSOLVED",
      createdAt: iso(visit.seat),
      dissolvedAt: iso(visit.leave),
      tableIds: companions.map((table) => table.id),
    });
    pushJournal(history, ids, {
      type: "TABLE_GROUP_CREATED",
      ms: visit.seat,
      rank: 10,
      tableId: visit.table.id,
      zoneId: visit.table.zone,
      sessionId,
      commandId,
      payload: { group: { id: groupId, status: "ACTIVE", tableIds: companions.map((table) => table.id), createdAt: iso(visit.seat), dissolvedAt: null } },
    });
  }
  if (visit.reserved && visit.reservationStart < visit.seat) {
    const reservationId = seqId("rsv-m", ids());
    history.reservations.push({
      id: reservationId,
      partySize: visit.party,
      startAt: iso(visit.seat),
      endAt: iso(visit.leave),
      tableId: visit.group ? null : visit.table.id,
      groupId,
      status: "COMPLETED",
      createdAt: iso(visit.reservationStart),
    });
    pushJournal(history, ids, {
      type: "RESERVATION_CREATED",
      ms: visit.reservationStart,
      rank: 5,
      tableId: visit.group ? null : visit.table.id,
      zoneId: visit.table.zone,
      sessionId,
      commandId,
      payload: { reservationId, partySize: visit.party, tableId: visit.table.id, groupId },
    });
  }
  companions.forEach((table, index) => {
    const occupied = seats[index] ?? 1;
    pushService(history, ids, table.id, visit.seat, "guests.seated", null, null, { summary: `Party of ${occupied}` });
    pushJournal(history, ids, {
      type: "GUEST_SEATED",
      ms: visit.seat,
      rank: 20,
      tableId: table.id,
      zoneId: table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { occupiedSeatCount: occupied, partySize: visit.party },
    });
    pushJournal(history, ids, {
      type: "TABLE_OCCUPIED",
      ms: visit.seat,
      rank: 21,
      tableId: table.id,
      zoneId: table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { occupiedSeatCount: occupied },
    });
  });
  if (visit.call) {
    const callId = seqId("call-m", ids());
    const call: HistoryCall = {
      id: callId,
      tableId: visit.table.id,
      status: "RESOLVED",
      createdAt: iso(visit.call.called),
      acknowledgedAt: iso(visit.call.acknowledged),
      resolvedAt: iso(visit.call.resolved),
    };
    history.calls.push(call);
    const taskId = seqId("task-m", ids());
    history.tasks.push({
      id: taskId,
      type: "respond_to_call",
      orderId: null,
      tableId: visit.table.id,
      callId,
      status: "COMPLETED",
      priority: 2,
      createdAt: call.createdAt,
      acknowledgedAt: call.acknowledgedAt,
      completedAt: call.resolvedAt,
      assignedWaiterId: visit.waiterId,
    });
    const replayCall: WaiterCall = { ...call, status: "ACTIVE", acknowledgedAt: null, resolvedAt: null };
    pushService(history, ids, visit.table.id, visit.call.called, "waiter.called", null, callId, {});
    pushService(history, ids, visit.table.id, visit.call.acknowledged, "waiter.acknowledged", null, callId, {});
    pushService(history, ids, visit.table.id, visit.call.resolved, "waiter.resolved", null, callId, {});
    pushJournal(history, ids, {
      type: "WAITER_CALLED",
      ms: visit.call.called,
      rank: 30,
      tableId: visit.table.id,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { callId, call: replayCall },
    });
    pushJournal(history, ids, {
      type: "WAITER_TASK_CREATED",
      ms: visit.call.called,
      rank: 31,
      tableId: visit.table.id,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { taskId, callId, type: "respond_to_call" },
    });
    pushJournal(history, ids, {
      type: "WAITER_CALL_ACKNOWLEDGED",
      ms: visit.call.acknowledged,
      rank: 32,
      tableId: visit.table.id,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { callId },
    });
    pushJournal(history, ids, {
      type: "WAITER_CALL_RESOLVED",
      ms: visit.call.resolved,
      rank: 33,
      tableId: visit.table.id,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { callId },
    });
    pushJournal(history, ids, {
      type: "WAITER_TASK_COMPLETED",
      ms: visit.call.resolved,
      rank: 34,
      tableId: visit.table.id,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { taskId, callId },
    });
  }
  for (const planned of visit.orders) {
    ticketNumber = commitOrder(history, ids, visit, planned, sessionId, commandId, ticketNumber);
  }
  companions.forEach((table) => {
    pushService(history, ids, table.id, visit.leave, "table.cleared", null, null, {});
    pushJournal(history, ids, {
      type: "GUEST_LEFT",
      ms: visit.leave,
      rank: 80,
      tableId: table.id,
      zoneId: table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: {},
    });
    pushJournal(history, ids, {
      type: "TABLE_RELEASED",
      ms: visit.leave,
      rank: 81,
      tableId: table.id,
      zoneId: table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { occupiedSeatCount: 0 },
    });
  });
  if (visit.group && groupId) {
    pushJournal(history, ids, {
      type: "TABLE_GROUP_DISSOLVED",
      ms: visit.leave,
      rank: 82,
      tableId: visit.table.id,
      zoneId: visit.table.zone,
      sessionId,
      commandId,
      payload: { groupId, tableIds: companions.map((table) => table.id) },
    });
  }
  return ticketNumber;
}

function commitOrder(
  history: MonthHistory,
  ids: () => number,
  visit: PlannedVisit,
  planned: PlannedOrder,
  sessionId: string,
  commandId: string,
  ticketNumber: number,
): number {
  const orderId = seqId("ord-m", ids());
  const items = planned.lines.map((line) => ({
    id: seqId("line-m", ids()),
    orderId,
    menuItemId: line.menu.id,
    name: line.menu.name,
    qty: line.qty,
    price: line.menu.price,
  }));
  const total = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  const summary = items.map((item) => `${item.name} × ${item.qty}`).join(", ");
  const updated = planned.served ?? planned.cancelled ?? planned.submitted;
  const order: HistoryOrder = {
    id: orderId,
    tableId: visit.table.id,
    status: planned.status,
    total,
    createdAt: iso(planned.submitted),
    updatedAt: iso(updated),
    items,
  };
  history.orders.push(order);
  const createdOrder: Order = {
    id: orderId,
    tableId: visit.table.id,
    status: "NEW",
    items: items.map((item) => ({ id: item.id, menuItemId: item.menuItemId, name: item.name, qty: item.qty, price: item.price })),
    total,
    createdAt: order.createdAt,
    updatedAt: order.createdAt,
  };
  pushService(history, ids, visit.table.id, planned.submitted, "order.submitted", orderId, null, { summary, total });
  pushJournal(history, ids, {
    type: "ORDER_CREATED",
    ms: planned.submitted,
    rank: 40,
    tableId: visit.table.id,
    orderId,
    zoneId: visit.table.zone,
    waiterId: visit.waiterId,
    sessionId,
    commandId,
    payload: { order: createdOrder },
  });
  const stations = new Map<KitchenStation, HistoryOrderItem[]>();
  for (const item of items) {
    const menu = planned.lines.find((line) => line.menu.id === item.menuItemId)?.menu;
    const station = menu?.station ?? null;
    if (!station) continue;
    const list = stations.get(station) ?? [];
    list.push(item);
    stations.set(station, list);
  }
  for (const station of ["Hot Kitchen", "Cold Kitchen", "Bar"] as const) {
    const lines = stations.get(station);
    if (!lines || lines.length === 0) continue;
    ticketNumber += 1;
    const ticketId = seqId("tkt-m", ids());
    const done = planned.status === "SERVED" ? 1 : 0;
    history.tickets.push({
      id: ticketId,
      number: ticketNumber,
      orderId,
      tableId: visit.table.id,
      station,
      status: planned.status === "CANCELLED" ? "CANCELLED" : "COMPLETED",
      createdAt: iso(planned.submitted),
      acceptedAt: iso(planned.accepted),
      startedAt: planned.prep == null ? null : iso(planned.prep),
      readyAt: planned.ready == null ? null : iso(planned.ready),
      completedAt: iso(planned.served ?? planned.cancelled ?? planned.accepted),
      items: lines.map((line) => ({
        id: seqId("tki-m", ids()),
        ticketId,
        menuItemId: line.menuItemId,
        name: line.name,
        qty: line.qty,
        done,
      })),
    });
    pushJournal(history, ids, {
      type: "KITCHEN_TICKET_CREATED",
      ms: planned.submitted,
      rank: 41,
      tableId: visit.table.id,
      orderId,
      zoneId: visit.table.zone,
      sessionId,
      commandId,
      payload: { ticketId, station },
    });
    if (planned.prep != null) {
      pushJournal(history, ids, {
        type: "KITCHEN_TICKET_STARTED",
        ms: planned.prep,
        rank: 52,
        tableId: visit.table.id,
        orderId,
        zoneId: visit.table.zone,
        sessionId,
        commandId,
        payload: { ticketId, station },
      });
    }
    if (planned.ready != null) {
      pushJournal(history, ids, {
        type: "KITCHEN_TICKET_READY",
        ms: planned.ready,
        rank: 54,
        tableId: visit.table.id,
        orderId,
        zoneId: visit.table.zone,
        sessionId,
        commandId,
        payload: { ticketId, station },
      });
    }
  }
  pushService(history, ids, visit.table.id, planned.accepted, "order.accepted", orderId, null, { summary });
  pushJournal(history, ids, {
    type: "ORDER_ACCEPTED",
    ms: planned.accepted,
    rank: 50,
    tableId: visit.table.id,
    orderId,
    zoneId: visit.table.zone,
    waiterId: visit.waiterId,
    sessionId,
    commandId,
    payload: { orderId, to: "ACCEPTED" },
  });
  if (planned.prep != null) {
    pushService(history, ids, visit.table.id, planned.prep, "order.prep_started", orderId, null, { summary });
    pushJournal(history, ids, {
      type: "ORDER_PREPARING",
      ms: planned.prep,
      rank: 51,
      tableId: visit.table.id,
      orderId,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { orderId, to: "PREPARING" },
    });
  }
  if (planned.ready != null && planned.served != null && planned.paid != null) {
    pushService(history, ids, visit.table.id, planned.ready, "order.ready", orderId, null, { summary });
    pushService(history, ids, visit.table.id, planned.served, "order.served", orderId, null, { summary });
    pushJournal(history, ids, {
      type: "ORDER_READY",
      ms: planned.ready,
      rank: 55,
      tableId: visit.table.id,
      orderId,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { orderId, to: "READY" },
    });
    const taskId = seqId("task-m", ids());
    history.tasks.push({
      id: taskId,
      type: "deliver_order",
      orderId,
      tableId: visit.table.id,
      callId: null,
      status: "COMPLETED",
      priority: 1,
      createdAt: iso(planned.ready),
      acknowledgedAt: iso(planned.ready + 30_000),
      completedAt: iso(planned.served),
      assignedWaiterId: visit.waiterId,
    });
    pushJournal(history, ids, {
      type: "WAITER_TASK_CREATED",
      ms: planned.ready,
      rank: 56,
      tableId: visit.table.id,
      orderId,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { taskId, type: "deliver_order" },
    });
    pushJournal(history, ids, {
      type: "ORDER_SERVED",
      ms: planned.served,
      rank: 60,
      tableId: visit.table.id,
      orderId,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { orderId, to: "SERVED" },
    });
    pushJournal(history, ids, {
      type: "WAITER_TASK_COMPLETED",
      ms: planned.served,
      rank: 61,
      tableId: visit.table.id,
      orderId,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { taskId },
    });
    const paymentId = seqId("pay-m", ids());
    history.payments.push({
      id: paymentId,
      orderId,
      tableId: visit.table.id,
      amount: total,
      paidAt: iso(planned.paid),
      note: PAYMENT_NOTE,
    });
    pushJournal(history, ids, {
      type: "PAYMENT_RECORDED",
      ms: planned.paid,
      rank: 70,
      tableId: visit.table.id,
      orderId,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { paymentId, amount: total, orderId },
    });
  }
  if (planned.cancelled != null) {
    pushJournal(history, ids, {
      type: "ORDER_CANCELLED",
      ms: planned.cancelled,
      rank: 63,
      tableId: visit.table.id,
      orderId,
      zoneId: visit.table.zone,
      waiterId: visit.waiterId,
      sessionId,
      commandId,
      payload: { orderId, to: "CANCELLED" },
    });
  }
  return ticketNumber;
}

function addCancelledReservation(
  history: MonthHistory,
  ids: () => number,
  tables: Map<string, HistoryTable>,
  day: { year: number; month: number; day: number },
  weekday: number,
  historyEnd: number,
): void {
  const tableId = weekday === 1 ? "T13" : "T15";
  const table = tables.get(tableId);
  if (!table) return;
  const created = kyivMs(day, 11, 5);
  const cancelled = kyivMs(day, 15, 20);
  const start = kyivMs(day, 19, 0);
  if (cancelled >= historyEnd || created >= historyEnd) return;
  const id = seqId("rsv-m", ids());
  const commandId = seqId("cmd-m", ids());
  history.reservations.push({
    id,
    partySize: 2,
    startAt: iso(start),
    endAt: iso(start + 90 * MIN),
    tableId,
    groupId: null,
    status: "CANCELLED",
    createdAt: iso(created),
  });
  pushJournal(history, ids, {
    type: "RESERVATION_CREATED",
    ms: created,
    rank: 5,
    tableId,
    zoneId: table.zone,
    commandId,
    payload: { reservationId: id, partySize: 2, tableId },
  });
  pushJournal(history, ids, {
    type: "RESERVATION_CANCELLED",
    ms: cancelled,
    rank: 6,
    tableId,
    zoneId: table.zone,
    commandId,
    payload: { reservationId: id, tableId },
  });
}

function addUpcomingReservations(
  history: MonthHistory,
  ids: () => number,
  tables: Map<string, HistoryTable>,
  now: number,
  historyEnd: number,
): void {
  for (const tableId of ["T08", "T11"]) {
    const table = tables.get(tableId);
    if (!table) continue;
    const id = seqId("rsv-m", ids());
    const commandId = seqId("cmd-m", ids());
    const start = now + 150 * MIN;
    history.reservations.push({
      id,
      partySize: Math.min(table.capacity, 2),
      startAt: iso(start),
      endAt: iso(start + 90 * MIN),
      tableId,
      groupId: null,
      status: "CONFIRMED",
      createdAt: iso(historyEnd - MIN),
    });
    pushJournal(history, ids, {
      type: "RESERVATION_CREATED",
      ms: historyEnd - MIN,
      rank: 90,
      tableId,
      zoneId: table.zone,
      commandId,
      payload: { reservationId: id, partySize: Math.min(table.capacity, 2), tableId },
    });
    pushJournal(history, ids, {
      type: "TABLE_STATUS_CHANGED",
      ms: historyEnd - 30_000,
      rank: 91,
      tableId,
      zoneId: table.zone,
      commandId,
      payload: { to: "RESERVED", occupiedSeatCount: 0 },
    });
  }
}

function addShifts(
  history: MonthHistory,
  ids: () => number,
  day: { year: number; month: number; day: number },
  weekday: number,
  historyEnd: number,
): void {
  const weekend = weekday === 0 || weekday === 5 || weekday === 6;
  const plan = [
    { waiterId: "waiter-marta", start: kyivMs(day, 11, 30), end: kyivMs(day, 23, 0) },
    { waiterId: "waiter-sofia", start: kyivMs(day, 11, 30), end: kyivMs(day, 23, 0) },
    { waiterId: "waiter-oleh", start: kyivMs(day, weekend ? 11 : 17, weekend ? 30 : 0), end: kyivMs(day, 23, 0) },
    { waiterId: "waiter-iryna", start: kyivMs(day, 16, 0), end: kyivMs(day, 23, 15) },
  ];
  for (const shift of plan) {
    if (shift.start >= historyEnd) continue;
    const ended = Math.min(shift.end, historyEnd);
    if (ended <= shift.start) continue;
    history.shifts.push({
      id: seqId("shift-m", ids()),
      waiterId: shift.waiterId,
      startedAt: iso(shift.start),
      endedAt: iso(ended),
    });
  }
}

function linesFor(menu: Map<string, MenuItem>, rng: () => number, meal: "lunch" | "dinner", party: number): { menu: MenuItem; qty: number }[] {
  const choices = BASKETS.filter((basket) => basket.meal === meal || basket.meal === "both");
  const basket = choices[Math.floor(rng() * choices.length)];
  if (!basket) return [];
  return basket.ids.flatMap((id) => {
    const item = menu.get(id);
    if (!item) return [];
    const qty = party >= 4 && (item.category === "Soft drinks" || item.category === "Pizza" || item.category === "Mains") && rng() < 0.45 ? 2 : 1;
    return [{ menu: item, qty }];
  });
}

function partySize(rng: () => number, capacity: number): number {
  const roll = rng();
  const wanted = roll < 0.62 ? 2 : roll < 0.9 ? Math.min(4, capacity) : capacity;
  return Math.max(1, Math.min(capacity, wanted));
}

function splitSeats(party: number, tables: HistoryTable[]): number[] {
  const seats = tables.map(() => 1);
  let left = party - seats.length;
  let index = 0;
  while (left > 0 && seats.some((seat, seatIndex) => seat < tables[seatIndex]!.capacity)) {
    const table = tables[index % tables.length]!;
    if (seats[index % tables.length]! < table.capacity) {
      seats[index % tables.length]! += 1;
      left -= 1;
    }
    index += 1;
    if (index > party * tables.length + 4) break;
  }
  return seats;
}

function wavesFor(weekday: number): Wave[] {
  const friSat = weekday === 5 || weekday === 6;
  const sunday = weekday === 0;
  const monday = weekday === 1;
  const busy = friSat || sunday;
  const waves: Wave[] = [
    { hour: 12, minute: 15, count: monday ? 3 : busy ? 5 : 4, meal: "lunch", group: false },
    { hour: 18, minute: 5, count: monday ? 4 : busy ? 7 : 5, meal: "dinner", group: weekday === 6 },
  ];
  if (!monday) waves.push({ hour: 20, minute: 10, count: friSat ? 4 : 3, meal: "dinner", group: false });
  return waves;
}

function waiterFor(zone: string, turn: number): string {
  const pool = WAITERS[zone] ?? WAITERS["Main Hall"]!;
  return pool[turn % pool.length] ?? pool[0]!;
}

function rankTables(tables: HistoryTable[], dayIndex: number, waveIndex: number): HistoryTable[] {
  return [...tables].sort((a, b) => {
    const score = (table: HistoryTable) => (table.number * 13 + dayIndex * 5 + waveIndex * 7) % 64;
    return score(a) - score(b) || a.number - b.number;
  });
}

function ensureZone(
  picked: HistoryTable[],
  ranked: HistoryTable[],
  count: number,
  booked: Map<string, [number, number][]>,
  start: number,
): void {
  for (const zone of ["Main Hall", "Terrace", "Bar Lounge"]) {
    if (picked.some((table) => table.zone === zone)) continue;
    const candidate = ranked.find((table) => table.zone === zone && !picked.includes(table) && !overlaps(booked, table.id, start, start + 100 * MIN));
    if (!candidate) continue;
    if (picked.length < count) {
      picked.push(candidate);
      continue;
    }
    const swapIndex = picked.findIndex((table, index) => table.zone === "Main Hall" && picked.filter((item) => item.zone === "Main Hall").length > 1 && index > 0);
    if (swapIndex >= 0) picked.splice(swapIndex, 1, candidate);
  }
}

function forcePair(
  picked: HistoryTable[],
  tables: Map<string, HistoryTable>,
  booked: Map<string, [number, number][]>,
  start: number,
  leftId: string,
  rightId: string,
): void {
  for (const id of [leftId, rightId]) {
    const table = tables.get(id);
    if (!table || picked.some((item) => item.id === id) || overlaps(booked, id, start, start + 100 * MIN)) return;
  }
  for (const id of [leftId, rightId]) {
    if (!picked.some((item) => item.id === id)) picked.push(tables.get(id)!);
  }
}

function overlaps(booked: Map<string, [number, number][]>, tableId: string, start: number, end: number): boolean {
  return (booked.get(tableId) ?? []).some(([from, to]) => start < to && end > from);
}

function pushService(
  history: MonthHistory,
  ids: () => number,
  tableId: string,
  ms: number,
  type: EventType,
  orderId: string | null,
  callId: string | null,
  metadata: Record<string, unknown>,
): void {
  history.serviceEvents.push({
    id: seqId("evt-m", ids()),
    tableId,
    timestamp: iso(ms),
    type,
    orderId,
    callId,
    metadata,
  });
}

function pushJournal(
  history: MonthHistory,
  ids: () => number,
  input: {
    type: JournalEventType;
    ms: number;
    rank: number;
    tableId?: string | null;
    orderId?: string | null;
    waiterId?: string | null;
    zoneId?: string | null;
    sessionId?: string | null;
    commandId: string;
    payload: Record<string, unknown>;
  },
): void {
  history.journal.push({
    id: seqId("rev-m", ids()),
    type: input.type,
    occurredAt: iso(input.ms),
    occurredMs: input.ms,
    rank: input.rank,
    tableId: input.tableId ?? null,
    orderId: input.orderId ?? null,
    waiterId: input.waiterId ?? null,
    zoneId: input.zoneId ?? null,
    sessionId: input.sessionId ?? null,
    commandId: input.commandId,
    payload: input.payload,
  });
}

function kyivYmd(now: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RESTAURANT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function addCalendarDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function kyivMs(day: { year: number; month: number; day: number }, hour: number, minute: number): number {
  const local = `${day.year}-${pad(day.month)}-${pad(day.day)}T${pad(hour)}:${pad(minute)}`;
  return Date.parse(zonedLocalToUtc(local));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function seqId(prefix: string, value: number): string {
  return `${prefix}-${String(value).padStart(4, "0")}`;
}

function counter(): () => number {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
