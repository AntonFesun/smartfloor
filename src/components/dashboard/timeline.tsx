import { Bell, Check, ChefHat, Clock, ConciergeBell, UserRound, UtensilsCrossed } from "lucide-react";
import { EVENT_LABEL, eventSummary } from "@/domain/labels";
import { formatClock, formatDuration } from "@/lib/format";
import type { EventType, ServiceEvent } from "@/types";

const ICONS: Record<EventType, typeof Clock> = {
  "guests.seated": UserRound,
  "order.submitted": UtensilsCrossed,
  "order.accepted": Check,
  "order.prep_started": ChefHat,
  "order.ready": ConciergeBell,
  "order.served": Check,
  "waiter.called": Bell,
  "waiter.acknowledged": Bell,
  "waiter.resolved": Check,
  "table.cleared": Clock,
};

export function Timeline({ events }: { events: ServiceEvent[] }) {
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No service events yet. Timings appear after guests are seated.</p>;
  }
  return (
    <ol className="space-y-0">
      {sorted.map((event, index) => {
        const previous = sorted[index - 1];
        const gap = previous ? Date.parse(event.timestamp) - Date.parse(previous.timestamp) : null;
        const Icon = ICONS[event.type];
        const summary = eventSummary(event.metadata);
        return (
          <li key={event.id} className="grid grid-cols-[16px_1fr] gap-3">
            <div className="flex flex-col items-center">
              <span className="mt-1 h-2.5 w-2.5 rounded-full bg-primary" />
              {index < sorted.length - 1 && <span className="w-px flex-1 bg-border" />}
            </div>
            <div className="pb-4">
              {gap != null && gap >= 1000 && (
                <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{formatDuration(gap)} later</div>
              )}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon className="h-3.5 w-3.5 text-primary" />
                    {EVENT_LABEL[event.type]}
                  </div>
                  {summary && <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>}
                </div>
                <time className="shrink-0 text-xs text-muted-foreground">{formatClock(event.timestamp)}</time>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
