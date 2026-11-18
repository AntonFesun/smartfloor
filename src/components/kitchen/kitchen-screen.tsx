"use client";

import { useState } from "react";
import { ORDER_READY_RULE, kitchenMetrics, type KitchenStation, type KitchenTicket, type TicketAction } from "@/domain/kitchen";
import { AppShell } from "@/components/dashboard/app-shell";
import { Button } from "@/components/ui/button";
import { useRealtime } from "@/hooks/use-realtime";
import { useReplayReadOnly, useReplayStore } from "@/store/replay-store";
import { api } from "@/lib/client-api";
import { formatDuration } from "@/lib/format";

const COLUMNS: { status: KitchenTicket["status"][]; title: string }[] = [
  { title: "New", status: ["NEW", "ACCEPTED"] },
  { title: "Preparing", status: ["PREPARING"] },
  { title: "Ready", status: ["READY"] },
  { title: "Completed", status: ["COMPLETED"] },
];

export function KitchenScreen() {
  const { tickets, now, metrics } = useRealtime();
  const readOnly = useReplayReadOnly();
  const [station, setStation] = useState<KitchenStation | "All">("All");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recentCompleted = now - 18 * 60 * 60 * 1000;
  const visible = tickets.filter((ticket) => {
    if (station !== "All" && ticket.station !== station) return false;
    if (ticket.status === "CANCELLED") return false;
    if (ticket.status === "COMPLETED") return ticket.completedAt != null && Date.parse(ticket.completedAt) >= recentCompleted;
    return true;
  });
  const stats = kitchenMetrics(tickets, now, metrics?.thresholds.prepMs ?? readThresholdsFallback());

  async function act(ticket: KitchenTicket, action: TicketAction, itemId?: string) {
    if (useReplayStore.getState().mode === "REPLAY") return;
    setPending(ticket.id);
    setError(null);
    try {
      await api(`/api/kitchen/tickets/${ticket.id}/transition`, {
        method: "POST",
        body: JSON.stringify({ action, itemId }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ticket update failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <AppShell panel={false} toolbar={<div className="border-b px-4 py-3 text-sm text-muted-foreground">{ORDER_READY_RULE}</div>}>
      <div className="flex h-full min-h-0 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {(["All", "Hot Kitchen", "Cold Kitchen", "Bar"] as const).map((value) => (
            <Button key={value} size="sm" variant={station === value ? "default" : "secondary"} onClick={() => setStation(value)}>
              {value}
            </Button>
          ))}
          <span className="text-xs text-muted-foreground">
            Avg prep {stats.avgPrepMs == null ? "No data" : formatDuration(stats.avgPrepMs)} · Active {stats.activeTickets} · Over threshold {stats.overThreshold}
          </span>
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-4">
          {COLUMNS.map((column) => (
            <section key={column.title} className="flex min-h-0 flex-col rounded-xl border bg-card/40">
              <header className="border-b px-3 py-2 text-sm font-semibold">
                {column.title}
                <span className="ml-2 text-muted-foreground">{visible.filter((ticket) => column.status.includes(ticket.status)).length}</span>
              </header>
              <div className="flex flex-1 flex-col gap-2 overflow-auto p-2">
                {visible
                  .filter((ticket) => column.status.includes(ticket.status))
                  .map((ticket) => (
                    <article key={ticket.id} className="rounded-lg border bg-background p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs text-primary">{ticket.station}</div>
                          <h2 className="text-lg font-semibold">
                            #{ticket.number} · {ticket.tableId}
                          </h2>
                        </div>
                        <div className="text-right text-xs text-muted-foreground">
                          {formatDuration(now - Date.parse(ticket.createdAt))}
                          <div>{ticket.status}</div>
                        </div>
                      </div>
                      <ul className="mt-2 space-y-1 text-sm">
                        {ticket.items.map((item) => (
                          <li key={item.id} className="flex items-center justify-between gap-2">
                            <span className={item.done ? "text-muted-foreground line-through" : ""}>
                              {item.qty} × {item.name}
                            </span>
                            {ticket.status === "PREPARING" && !item.done && (
                              <Button size="sm" variant="secondary" disabled={readOnly || pending === ticket.id} onClick={() => void act(ticket, "complete_item", item.id)}>
                                Done
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-3">
                        {ticket.status === "NEW" && (
                          <Button className="w-full" disabled={readOnly || pending === ticket.id} onClick={() => void act(ticket, "accept")}>
                            Accept
                          </Button>
                        )}
                        {ticket.status === "ACCEPTED" && (
                          <Button className="w-full" disabled={readOnly || pending === ticket.id} onClick={() => void act(ticket, "start")}>
                            Start prep
                          </Button>
                        )}
                        {ticket.status === "PREPARING" && (
                          <Button className="w-full" disabled={readOnly || pending === ticket.id || ticket.items.some((item) => !item.done)} onClick={() => void act(ticket, "complete")}>
                            Ticket ready
                          </Button>
                        )}
                        {ticket.status === "READY" && (
                          <Button className="w-full" variant="secondary" disabled={readOnly || pending === ticket.id} onClick={() => void act(ticket, "bump")}>
                            Complete
                          </Button>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function readThresholdsFallback(): number {
  return 20 * 60 * 1000;
}
