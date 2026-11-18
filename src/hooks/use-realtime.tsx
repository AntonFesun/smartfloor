"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { computeMetrics } from "@/domain/metrics";
import type { DeliveryTask, KitchenTicket } from "@/domain/kitchen";
import type { Reservation, TableGroup } from "@/domain/seating";
import type { Waiter, WaiterShift, WaiterTask, WaiterZoneAssignment } from "@/domain/waiters";
import type { RestaurantEvent } from "@/domain/journal";
import type { PaymentRecord } from "@/domain/revenue";
import {
  kitchenTicketEventSchema,
  reservationEventSchema,
  restaurantEventCreatedSchema,
  tableGroupEventSchema,
  waiterTaskEventSchema,
  layoutUpdatedSchema,
  orderCreatedSchema,
  orderUpdatedSchema,
  snapshotSchema,
  tableUpdatedSchema,
  timelineEventSchema,
  waiterEventSchema,
} from "@/domain/schemas";
import type { MenuItem, Metrics, Order, RestaurantTable, ServiceEvent, Thresholds, WaiterCall } from "@/types";

export interface ToastItem {
  id: string;
  title: string;
  tone: "order" | "waiter" | "ready" | "info";
}

interface LiveState {
  tables: RestaurantTable[];
  orders: Order[];
  waiterCalls: WaiterCall[];
  events: ServiceEvent[];
  menu: MenuItem[];
  tickets: KitchenTicket[];
  deliveryTasks: DeliveryTask[];
  waiters: Waiter[];
  shifts: WaiterShift[];
  zoneAssignments: WaiterZoneAssignment[];
  waiterTasks: WaiterTask[];
  reservations: Reservation[];
  tableGroups: TableGroup[];
  payments: PaymentRecord[];
  journal: RestaurantEvent[];
  thresholds: Thresholds;
  publicUrl: string;
  restaurantName: string;
  generatedAt: string;
}

interface RealtimeContextValue {
  ready: boolean;
  connected: boolean;
  error: string | null;
  tables: RestaurantTable[];
  orders: Order[];
  waiterCalls: WaiterCall[];
  events: ServiceEvent[];
  menu: MenuItem[];
  tickets: KitchenTicket[];
  deliveryTasks: DeliveryTask[];
  waiters: Waiter[];
  shifts: WaiterShift[];
  zoneAssignments: WaiterZoneAssignment[];
  waiterTasks: WaiterTask[];
  reservations: Reservation[];
  tableGroups: TableGroup[];
  payments: PaymentRecord[];
  journal: RestaurantEvent[];
  metrics: Metrics | null;
  revenue: number;
  publicUrl: string;
  restaurantName: string;
  now: number;
  toasts: ToastItem[];
  dismissToast: (id: string) => void;
  refresh: () => Promise<void>;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const EMPTY_THRESHOLDS: Thresholds = { waiterMs: 180000, prepMs: 1200000, readyMs: 480000, occupancyMs: 5400000 };

function fromSnapshot(data: ReturnType<typeof snapshotSchema.parse>): LiveState {
  return {
    tables: data.tables,
    orders: data.orders,
    waiterCalls: data.waiterCalls,
    events: data.events,
    menu: data.menu,
    tickets: data.tickets,
    deliveryTasks: data.deliveryTasks,
    waiters: data.waiters,
    shifts: data.shifts,
    zoneAssignments: data.zoneAssignments,
    waiterTasks: data.waiterTasks,
    reservations: data.reservations,
    tableGroups: data.tableGroups,
    payments: data.payments,
    journal: data.journal,
    thresholds: data.metrics.thresholds,
    publicUrl: data.publicUrl,
    restaurantName: data.restaurant.name,
    generatedAt: data.generatedAt,
  };
}

function upsert<T extends { id: string }>(list: T[], item: T, prepend = false): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return prepend ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function mergeEvents(current: ServiceEvent[], incoming: ServiceEvent[]): ServiceEvent[] {
  if (incoming.length === 0) return current;
  const known = new Set(current.map((event) => event.id));
  const added = incoming.filter((event) => !known.has(event.id));
  if (added.length === 0) return current;
  return [...current, ...added].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [live, setLive] = useState<LiveState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const connectedOnce = useRef(false);

  const dismissToast = (id: string) => setToasts((current) => current.filter((toast) => toast.id !== id));

  const pushToast = (title: string, tone: ToastItem["tone"]) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-4), { id, title, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4600);
  };

  const refetch = async () => {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`Snapshot failed (${response.status})`);
    const parsed = snapshotSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.error(parsed.error);
      throw new Error("Snapshot did not match the contract");
    }
    setLive(fromSnapshot(parsed.data));
    setError(null);
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let socket: Socket | null = null;
    let closed = false;
    refetch().catch((reason: unknown) => {
      if (!closed) setError(reason instanceof Error ? reason.message : "Unable to load the floor");
    });

    socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      setConnected(true);
      setError(null);
      if (connectedOnce.current) {
        refetch().catch(() => setError("Reconnected, but the snapshot refresh failed"));
      }
      connectedOnce.current = true;
    });
    socket.on("disconnect", () => setConnected(false));

    const replaceIfEmpty = (payload: unknown) => {
      const parsed = snapshotSchema.safeParse(payload);
      if (!parsed.success) {
        console.error(parsed.error);
        return;
      }
      setLive((current) => current ?? fromSnapshot(parsed.data));
    };

    socket.on("snapshot", replaceIfEmpty);
    socket.on("demo.reset", (payload: unknown) => {
      const parsed = snapshotSchema.safeParse(payload);
      if (!parsed.success) {
        void refetch();
        return;
      }
      setLive(fromSnapshot(parsed.data));
      pushToast("Demo data restored", "info");
    });
    socket.on("order.created", (payload: unknown) => {
      const parsed = orderCreatedSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) =>
        current
          ? {
              ...current,
              orders: upsert(current.orders, parsed.data.order, true),
              tables: upsert(current.tables, parsed.data.table),
              events: mergeEvents(current.events, parsed.data.events),
            }
          : current,
      );
      pushToast(`New order · ${parsed.data.order.tableId}`, "order");
    });
    socket.on("order.updated", (payload: unknown) => {
      const parsed = orderUpdatedSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) =>
        current
          ? { ...current, orders: upsert(current.orders, parsed.data.order, true), events: mergeEvents(current.events, parsed.data.events) }
          : current,
      );
      if (parsed.data.order.status === "READY") pushToast(`Order ready · ${parsed.data.order.tableId}`, "ready");
    });
    socket.on("waiter.called", (payload: unknown) => {
      const parsed = waiterEventSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) =>
        current
          ? { ...current, waiterCalls: upsert(current.waiterCalls, parsed.data.call, true), events: mergeEvents(current.events, parsed.data.events) }
          : current,
      );
      pushToast(`Waiter called · ${parsed.data.call.tableId}`, "waiter");
    });
    socket.on("waiter.acknowledged", (payload: unknown) => {
      const parsed = waiterEventSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) =>
        current
          ? { ...current, waiterCalls: upsert(current.waiterCalls, parsed.data.call), events: mergeEvents(current.events, parsed.data.events) }
          : current,
      );
    });
    socket.on("waiter.resolved", (payload: unknown) => {
      const parsed = waiterEventSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) =>
        current
          ? { ...current, waiterCalls: upsert(current.waiterCalls, parsed.data.call), events: mergeEvents(current.events, parsed.data.events) }
          : current,
      );
      pushToast(`Waiter resolved · ${parsed.data.call.tableId}`, "info");
    });
    socket.on("table.updated", (payload: unknown) => {
      const parsed = tableUpdatedSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) =>
        current
          ? { ...current, tables: upsert(current.tables, parsed.data.table), events: mergeEvents(current.events, parsed.data.events) }
          : current,
      );
    });
    socket.on("layout.updated", (payload: unknown) => {
      const parsed = layoutUpdatedSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) => (current ? { ...current, tables: parsed.data.tables } : current));
    });
    socket.on("kitchen.ticket.created", (payload: unknown) => {
      const parsed = kitchenTicketEventSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) => (current ? { ...current, tickets: upsert(current.tickets, parsed.data.ticket) } : current));
    });
    socket.on("kitchen.ticket.updated", (payload: unknown) => {
      const parsed = kitchenTicketEventSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) => (current ? { ...current, tickets: upsert(current.tickets, parsed.data.ticket) } : current));
    });
    const applyTask = (payload: unknown, created: boolean) => {
      const parsed = waiterTaskEventSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) => {
        if (!current) return current;
        const waiterTasks = upsert(current.waiterTasks, parsed.data.task, created);
        const deliveryTasks =
          parsed.data.task.type === "deliver_order"
            ? upsert(current.deliveryTasks, { ...parsed.data.task, type: "deliver_order" as const, orderId: parsed.data.task.orderId ?? "", status: parsed.data.task.status === "ACKNOWLEDGED" ? "OPEN" : parsed.data.task.status }, created)
            : current.deliveryTasks;
        return { ...current, waiterTasks, deliveryTasks };
      });
      if (created && parsed.data.task.assignedWaiterId == null) {
        pushToast(`No waiter on duty · ${parsed.data.task.tableId}`, "waiter");
      }
    };
    socket.on("waiter.task.created", (payload: unknown) => applyTask(payload, true));
    socket.on("waiter.task.updated", (payload: unknown) => applyTask(payload, false));
    socket.on("waiter.assignment.updated", (payload: unknown) => applyTask(payload, false));
    socket.on("reservation.updated", (payload: unknown) => {
      const parsed = reservationEventSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) => (current ? { ...current, reservations: upsert(current.reservations, parsed.data.reservation, true) } : current));
    });
    socket.on("table.group.updated", (payload: unknown) => {
      const parsed = tableGroupEventSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) => (current ? { ...current, tableGroups: upsert(current.tableGroups, parsed.data.group, true) } : current));
    });
    socket.on("restaurant.event.created", (payload: unknown) => {
      const parsed = restaurantEventCreatedSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) => {
        if (!current) return current;
        if (current.journal.some((event) => event.id === parsed.data.event.id)) return current;
        return {
          ...current,
          journal: [...current.journal, parsed.data.event].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)),
        };
      });
    });
    socket.on("timeline.event", (payload: unknown) => {
      const parsed = timelineEventSchema.safeParse(payload);
      if (!parsed.success) return void refetch();
      setLive((current) => (current ? { ...current, events: mergeEvents(current.events, [parsed.data.event]) } : current));
    });

    return () => {
      closed = true;
      socket?.close();
    };
    // The socket is created once for the lifetime of the app shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const metrics = useMemo(() => {
    if (!live) return null;
    return computeMetrics({
      events: live.events,
      tables: live.tables,
      orders: live.orders,
      waiterCalls: live.waiterCalls,
      now,
      thresholds: live.thresholds,
    });
  }, [live, now]);

  const revenue = useMemo(
    () => (live ? live.orders.filter((order) => order.status === "SERVED").reduce((sum, order) => sum + order.total, 0) : 0),
    [live],
  );

  const value: RealtimeContextValue = {
    ready: live !== null,
    connected,
    error,
    tables: live?.tables ?? [],
    orders: live?.orders ?? [],
    waiterCalls: live?.waiterCalls ?? [],
    events: live?.events ?? [],
    menu: live?.menu ?? [],
    tickets: live?.tickets ?? [],
    deliveryTasks: live?.deliveryTasks ?? [],
    waiters: live?.waiters ?? [],
    shifts: live?.shifts ?? [],
    zoneAssignments: live?.zoneAssignments ?? [],
    waiterTasks: live?.waiterTasks ?? [],
    reservations: live?.reservations ?? [],
    tableGroups: live?.tableGroups ?? [],
    payments: live?.payments ?? [],
    journal: live?.journal ?? [],
    metrics,
    revenue,
    publicUrl: live?.publicUrl ?? "",
    restaurantName: live?.restaurantName ?? "Atelier Restaurant",
    now,
    toasts,
    dismissToast,
    refresh: refetch,
  };

  return (
    <RealtimeContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[70] flex w-[min(92vw,320px)] flex-col gap-2">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            onClick={() => dismissToast(toast.id)}
            className={`pointer-events-auto rounded-lg border px-3 py-2 text-left text-sm shadow-lg ${
              toast.tone === "waiter"
                ? "border-orange-500/50 bg-orange-950/90 text-orange-50"
                : toast.tone === "ready"
                  ? "border-emerald-500/40 bg-emerald-950/90 text-emerald-50"
                  : toast.tone === "order"
                    ? "border-primary/40 bg-zinc-950/95"
                    : "border-border bg-card"
            }`}
          >
            {toast.title}
          </button>
        ))}
      </div>
    </RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error("useRealtime must be used within RealtimeProvider");
  return value;
}

export { EMPTY_THRESHOLDS };
