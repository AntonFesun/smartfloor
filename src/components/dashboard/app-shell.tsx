"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChefHat, FlaskConical, LayoutDashboard, Map, RotateCcw, UserRound, Users, Wifi, WifiOff } from "lucide-react";
import { HeatmapBar } from "@/components/dashboard/heatmap-bar";
import { HeatmapBinder } from "@/components/dashboard/heatmap-binder";
import { MetricBar } from "@/components/dashboard/metric-bar";
import { ReplayBar } from "@/components/dashboard/replay-bar";
import { TablePanel } from "@/components/dashboard/table-panel";
import { Button } from "@/components/ui/button";
import { usePresentedFloor } from "@/hooks/use-presented-floor";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/lib/client-api";
import { useReplayReadOnly } from "@/store/replay-store";
import { cn } from "@/lib/utils";

export function AppShell({ toolbar, children, panel = true }: { toolbar?: React.ReactNode; children: React.ReactNode; panel?: boolean }) {
  const realtime = useRealtime();
  const presented = usePresentedFloor();
  const readOnly = useReplayReadOnly();
  const pathname = usePathname();
  const showHeat = pathname === "/dashboard" || pathname === "/floor";
  if (!realtime.ready) {
    return (
      <div className="grid h-screen place-items-center">
        <div className="text-center">
          <div className="text-sm uppercase tracking-[0.2em] text-primary">Atelier</div>
          <h1 className="mt-2 text-2xl font-semibold">SmartFloor</h1>
          <p className="mt-2 text-sm text-muted-foreground">{realtime.error ?? "Loading the floor…"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-card/50">
        <div className="border-b px-4 py-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-primary">Choice SmartFloor</div>
          <div className="mt-1 text-base font-semibold">{realtime.restaurantName}</div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            {readOnly ? <WifiOff className="h-3.5 w-3.5 text-amber-300" /> : realtime.connected ? <Wifi className="h-3.5 w-3.5 text-emerald-400" /> : <WifiOff className="h-3.5 w-3.5 text-amber-300" />}
            {readOnly ? "REPLAY" : realtime.connected ? "LIVE" : "Reconnecting"}
          </div>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          <NavLink href="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />} label="Dashboard" />
          <NavLink href="/floor" icon={<Map className="h-4 w-4" />} label="Floor editor" />
          <NavLink href="/kitchen" icon={<ChefHat className="h-4 w-4" />} label="Kitchen" />
          <NavLink href="/waiters" icon={<Users className="h-4 w-4" />} label="Waiters" />
          <NavLink href="/host" icon={<UserRound className="h-4 w-4" />} label="Host" />
          <NavLink href="/simulator" icon={<FlaskConical className="h-4 w-4" />} label="Simulator" />
        </nav>
        <div className="mt-auto p-3">
          <Button
            variant="outline"
            className="w-full"
            disabled={readOnly}
            title={readOnly ? "Replay is read-only" : undefined}
            onClick={() => {
              if (readOnly) return;
              void api("/api/demo/reset", { method: "POST" });
            }}
          >
            <RotateCcw className="h-4 w-4" />
            Reset demo
          </Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <MetricBar
          tables={presented.tables}
          orders={presented.orders}
          waiterCalls={presented.waiterCalls}
          revenue={readOnly ? presented.orders.filter((order) => order.status === "SERVED").reduce((sum, order) => sum + order.total, 0) : realtime.revenue}
          metrics={readOnly ? null : realtime.metrics}
        />
        {toolbar}
        <ReplayBar />
        <HeatmapBinder />
        {showHeat ? <HeatmapBar /> : null}
        {readOnly && (
          <div className="border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-100">
            Replay is read-only. Seating, orders, kitchen, waiters, host, and layout changes stay off. Return to Live loads a fresh snapshot and does not write this view back.
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">{children}</div>
          {panel ? <TablePanel /> : null}
        </div>
      </div>
    </div>
  );
}

function NavLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  const pathname = usePathname();
  const active = pathname === href;
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {icon}
      {label}
    </Link>
  );
}
