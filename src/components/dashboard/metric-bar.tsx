import { formatDuration, formatUAH } from "@/lib/format";
import type { Metrics, Order, RestaurantTable, WaiterCall } from "@/types";

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-[108px] flex-1 rounded-lg border bg-card/80 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold leading-none">{value}</div>
      {hint && <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function MetricBar({
  tables,
  orders,
  waiterCalls,
  revenue,
  metrics,
}: {
  tables: RestaurantTable[];
  orders: Order[];
  waiterCalls: WaiterCall[];
  revenue: number;
  metrics: Metrics | null;
}) {
  const occupied = tables.filter((table) => table.status === "OCCUPIED").length;
  const available = tables.filter((table) => table.status === "AVAILABLE").length;
  const reserved = tables.filter((table) => table.status === "RESERVED").length;
  const calls = waiterCalls.filter((call) => call.status !== "RESOLVED").length;
  const pending = orders.filter((order) => order.status !== "SERVED" && order.status !== "CANCELLED").length;
  const response = metrics?.waiterResponse.avgMs ?? null;
  const prep = metrics?.acceptToReady.avgMs ?? null;
  const occupancy = metrics?.occupancy.avgMs ?? null;
  const longest = metrics?.longestUnresolved;

  return (
    <div className="space-y-2 border-b px-3 py-3">
      <div className="flex gap-2 overflow-x-auto">
        <Tile label="Tables" value={String(tables.length)} hint={`${occupied} occupied`} />
        <Tile label="Available" value={String(available)} hint={`${reserved} reserved`} />
        <Tile label="Waiter calls" value={String(calls)} hint="Active or acked" />
        <Tile label="Open orders" value={String(pending)} hint="Not served" />
        <Tile label="Served checks" value={formatUAH(revenue)} hint="Not collected payments" />
        <Tile label="Avg response" value={formatDuration(response)} hint={response == null ? "Not enough events" : "Call to ack"} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded-full border px-2 py-1">Avg prep {formatDuration(prep)}</span>
        <span className="rounded-full border px-2 py-1">Avg occupancy {formatDuration(occupancy)}</span>
        <span className="rounded-full border px-2 py-1">Turnover {formatDuration(metrics?.turnover.avgMs)}</span>
        <span className="rounded-full border px-2 py-1">
          Longest open {longest ? `${longest.kind} ${longest.tableId} ${formatDuration(longest.ms)}` : "—"}
        </span>
        {metrics?.delaysByZone
          .filter((zone) => zone.waiter + zone.prep + zone.ready + zone.occupancy > 0)
          .map((zone) => (
            <span key={zone.zone} className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-100">
              {zone.zone}: {zone.waiter} waiter · {zone.prep} prep · {zone.ready} pass · {zone.occupancy} stay
            </span>
          ))}
      </div>
    </div>
  );
}
