"use client";

import { useEffect, useState } from "react";
import { QrCode } from "lucide-react";
import { compareToRestaurant, formatMetricValue, metricInfo, type HeatMetricId, type ServiceHeatmap } from "@/domain/analytics";
import { ATTRIBUTION_RULE, type RevenueReport } from "@/domain/revenue";
import { RESTAURANT_TIME_ZONE } from "@/domain/journal";
import { ORDER_LABEL, TABLE_LABEL } from "@/domain/labels";
import { isOpenOrder, primaryOrderAction } from "@/domain/orders";
import { isActiveWaiter } from "@/domain/waiter";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { JournalTimeline } from "@/components/dashboard/journal-timeline";
import { QrDialog } from "@/components/dashboard/qr-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePresentedFloor } from "@/hooks/use-presented-floor";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/lib/client-api";
import { formatAgo, formatClock, formatUAH } from "@/lib/format";
import { useHeatmapStore } from "@/store/heatmap-store";
import { useReplayStore } from "@/store/replay-store";
import { useUiStore } from "@/store/ui-store";
import type { OrderStatus, TableStatus } from "@/types";

const STATUS_VARIANT: Record<TableStatus, "green" | "blue" | "amber"> = {
  AVAILABLE: "green",
  OCCUPIED: "blue",
  RESERVED: "amber",
};

export function TablePanel() {
  const { tables, orders, waiterCalls, readOnly, sequence } = usePresentedFloor();
  const { events, publicUrl, now, deliveryTasks, journal } = useRealtime();
  const replayMode = useReplayStore((state) => state.mode);
  const heatMode = useHeatmapStore((state) => state.mode);
  const heatMetric = useHeatmapStore((state) => state.metric);
  const heatReport = useHeatmapStore((state) => state.report);
  const revenueReport = useHeatmapStore((state) => state.revenueReport);
  const selectedId = useUiStore((state) => state.selectedTableId);
  const table = tables.find((item) => item.id === selectedId) ?? null;
  const [qrOpen, setQrOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seats, setSeats] = useState(2);

  useEffect(() => {
    if (!table) return;
    setSeats(Math.min(table.capacity, Math.max(1, table.occupiedSeatCount || Math.min(2, table.capacity))));
  }, [table]);

  async function run(key: string, action: () => Promise<unknown>) {
    if (useReplayStore.getState().mode === "REPLAY") return;
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      setPending(null);
    }
  }

  if (!table) {
    return (
      <aside className="flex w-[360px] shrink-0 flex-col border-l bg-card/40">
        <div className="border-b p-4">
          <h2 className="text-sm font-semibold">Table</h2>
          <p className="mt-2 text-sm text-muted-foreground">Select a table on the floor. T07 is the guest demo table.</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <ActivityFeed events={events} now={now} />
        </div>
      </aside>
    );
  }

  const serviceCutoff = now - 10 * 60 * 60 * 1000;
  const tableOrders = orders
    .filter((order) => order.tableId === table.id)
    .filter((order) => (order.status !== "SERVED" && order.status !== "CANCELLED") || Date.parse(order.createdAt) >= serviceCutoff)
    .sort((a, b) => Number(a.status === "SERVED" || a.status === "CANCELLED") - Number(b.status === "SERVED" || b.status === "CANCELLED") || b.createdAt.localeCompare(a.createdAt));
  const tableJournalEvents = journal.filter((event) => event.tableId === table.id && (replayMode !== "REPLAY" || event.sequence <= sequence));
  const call = waiterCalls.find((item) => item.tableId === table.id && isActiveWaiter(item.status));
  const delivery = readOnly ? undefined : deliveryTasks.find((task) => task.tableId === table.id && task.status === "OPEN");
  const bill = currentBill(table.id, orders, events);
  const last = tableJournalEvents[tableJournalEvents.length - 1];

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l bg-card/40">
      <div className="space-y-3 border-b p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{table.zone}</div>
            <h2 className="text-xl font-semibold">{table.id}</h2>
          </div>
          <Badge variant={STATUS_VARIANT[table.status]}>{TABLE_LABEL[table.status]}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-[11px] text-muted-foreground">Capacity</dt>
            <dd>
              {table.occupiedSeatCount}/{table.capacity} · {table.shape}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">Bill</dt>
            <dd>{formatUAH(bill)}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-[11px] text-muted-foreground">Last activity</dt>
            <dd>{last ? `${formatClock(last.occurredAt)} · ${formatAgo(last.occurredAt, now)}` : "—"}</dd>
          </div>
        </dl>
        {delivery && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-sm">Delivery task open</div>}
        {call && (
          <div className="rounded-md border border-orange-500/40 bg-orange-500/10 p-2 text-sm">
            Waiter {call.status === "ACTIVE" ? "called" : "on the way"} · {formatAgo(call.createdAt, now)}
            <div className="mt-2 flex gap-2">
              {call.status === "ACTIVE" && (
                <Button size="sm" variant="secondary" disabled={readOnly || pending !== null} onClick={() => run(call.id, () => api(`/api/waiter/${call.id}/acknowledge`, { method: "POST" }))}>
                  Acknowledge
                </Button>
              )}
              <Button size="sm" disabled={readOnly || pending !== null} onClick={() => run(call.id, () => api(`/api/waiter/${call.id}/resolve`, { method: "POST" }))}>
                Resolve
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setQrOpen(true)}>
            <QrCode className="h-3.5 w-3.5" /> QR
          </Button>
          {(table.status === "AVAILABLE" || table.status === "RESERVED") && (
            <Button
              size="sm"
              disabled={readOnly || pending !== null}
              onClick={() => run("seat", () => api(`/api/tables/${table.id}/seat`, { method: "POST", body: JSON.stringify({ occupiedSeatCount: seats }) }))}
            >
              Seat
            </Button>
          )}
          {table.status === "AVAILABLE" && (
            <Button size="sm" variant="secondary" disabled={readOnly || pending !== null} onClick={() => run("reserve", () => api(`/api/tables/${table.id}/reserve`, { method: "POST" }))}>
              Reserve
            </Button>
          )}
          {table.status === "RESERVED" && (
            <Button size="sm" variant="secondary" disabled={readOnly || pending !== null} onClick={() => run("release", () => api(`/api/tables/${table.id}/release`, { method: "POST" }))}>
              Release
            </Button>
          )}
          {table.status === "OCCUPIED" && (
            <Button size="sm" variant="secondary" disabled={readOnly || pending !== null} onClick={() => run("clear", () => api(`/api/tables/${table.id}/clear`, { method: "POST" }))}>
              Clear
            </Button>
          )}
        </div>
        {(table.status === "AVAILABLE" || table.status === "RESERVED") && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Party size
            <input
              type="number"
              min={1}
              max={table.capacity}
              value={seats}
              onChange={(event) => setSeats(Number(event.target.value))}
              className="h-8 w-16 rounded-md border bg-background px-2 text-foreground"
            />
          </label>
        )}
        {error && <p className="text-xs text-red-300">{error}</p>}
        {heatMode === "heatmap" && heatReport && (
          <HeatReading tableId={table.id} metric={heatMetric} report={heatReport} />
        )}
        {heatMode === "revenue" && revenueReport && (
          <RevenueReading tableId={table.id} report={revenueReport} />
        )}
      </div>
      <Tabs defaultValue="service" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-3 mt-3">
          <TabsTrigger value="service">Orders</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="activity">Floor</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
          <TabsContent value="service" className="space-y-2">
            {tableOrders.length === 0 && <p className="text-sm text-muted-foreground">No orders on this table.</p>}
            {tableOrders.map((order) => {
              const action = primaryOrderAction(order.status);
              return (
                <article key={order.id} className="rounded-lg border bg-background/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{formatUAH(order.total)}</span>
                    <OrderBadge status={order.status} />
                  </div>
                  <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                    {order.items.map((item) => (
                      <li key={item.id}>
                        {item.qty} × {item.name}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex gap-2">
                    {action && (
                      <Button
                        size="sm"
                        disabled={readOnly || pending !== null}
                        onClick={() =>
                          run(order.id, () =>
                            api(`/api/orders/${order.id}/transition`, { method: "POST", body: JSON.stringify({ status: action.status }) }),
                          )
                        }
                      >
                        {action.label}
                      </Button>
                    )}
                    {isOpenOrder(order.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={readOnly || pending !== null}
                        onClick={() =>
                          run(`${order.id}-cancel`, () =>
                            api(`/api/orders/${order.id}/transition`, { method: "POST", body: JSON.stringify({ status: "CANCELLED" }) }),
                          )
                        }
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </TabsContent>
          <TabsContent value="timeline">
            <JournalTimeline events={journal} tableId={table.id} throughSequence={replayMode === "REPLAY" ? sequence : undefined} />
          </TabsContent>
          <TabsContent value="activity">
            <ActivityFeed events={events} now={now} />
          </TabsContent>
        </div>
      </Tabs>
      <QrDialog open={qrOpen} onOpenChange={setQrOpen} tableId={table.id} publicUrl={publicUrl} />
    </aside>
  );
}

function HeatReading({ tableId, metric, report }: { tableId: string; metric: HeatMetricId; report: ServiceHeatmap }) {
  const table = report.tables.find((item) => item.tableId === tableId);
  const reading = table?.metrics[metric];
  const restaurant = report.restaurant.metrics[metric];
  const info = metricInfo(metric);
  return (
    <div className="rounded-md border bg-background/60 p-2 text-sm">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{info.label}</div>
      <div className="mt-1 font-medium">{reading && reading.value != null ? formatMetricValue(reading.value, reading.unit) : "No data"}</div>
      <div className="mt-1 text-xs text-muted-foreground">{reading?.observations ?? 0} observations</div>
      <div className="text-xs text-muted-foreground">{formatWindow(report.from)} – {formatWindow(report.to)}</div>
      <div className="mt-1 text-xs">{reading ? compareToRestaurant(reading, restaurant) : "No data"}</div>
    </div>
  );
}

function RevenueReading({ tableId, report }: { tableId: string; report: RevenueReport }) {
  const row = report.tables.find((item) => item.tableId === tableId);
  const economics = row?.economics;
  return (
    <div className="rounded-md border bg-background/60 p-2 text-sm">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Table economics</div>
      <dl className="mt-1 space-y-1 text-xs">
        <Money label="Recorded sales" value={economics?.recordedSales ?? null} />
        <Row label="Orders" value={economics ? String(economics.orderCount) : "0"} />
        <Money label="Average order value" value={economics?.averageOrderValue ?? null} />
        <Row label="Occupied minutes" value={economics?.occupiedMinutes == null ? "N/A" : `${Math.round(economics.occupiedMinutes)} min`} />
        <Money label="Sales per occupied hour" value={economics?.salesPerOccupiedHour ?? null} />
        <Row label="Completed seatings" value={economics ? String(economics.completedSeatings) : "0"} />
      </dl>
      <div className="mt-1 text-xs text-muted-foreground">{formatWindow(report.from)} – {formatWindow(report.to)}</div>
      {row && row.groupWith.length > 0 && <div className="mt-1 text-xs text-muted-foreground">Grouped with {row.groupWith.join(", ")}. The payment is not copied.</div>}
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{ATTRIBUTION_RULE}</p>
    </div>
  );
}

function Money({ label, value }: { label: string; value: number | null }) {
  return <Row label={label} value={value == null ? "N/A" : formatUAH(value)} />;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function currentBill(tableId: string, orders: { tableId: string; status: string; total: number; createdAt: string }[], events: { tableId: string; type: string; timestamp: string; id: string }[]): number {
  const timeline = events
    .filter((event) => event.tableId === tableId && (event.type === "guests.seated" || event.type === "table.cleared"))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  let since: string | null = null;
  for (const event of timeline) since = event.type === "guests.seated" ? event.timestamp : null;
  return orders
    .filter((order) => order.tableId === tableId && order.status !== "CANCELLED" && (since ? order.createdAt >= since : order.status !== "SERVED"))
    .reduce((sum, order) => sum + order.total, 0);
}

function formatWindow(iso: string): string {
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: RESTAURANT_TIME_ZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function OrderBadge({ status }: { status: OrderStatus }) {
  const variant = status === "READY" ? "green" : status === "NEW" ? "default" : status === "CANCELLED" ? "red" : "secondary";
  return <Badge variant={variant}>{ORDER_LABEL[status]}</Badge>;
}
