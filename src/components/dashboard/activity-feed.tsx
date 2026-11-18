import { EVENT_LABEL, eventSummary } from "@/domain/labels";
import { formatAgo } from "@/lib/format";
import { useUiStore } from "@/store/ui-store";
import type { ServiceEvent } from "@/types";

export function ActivityFeed({ events, now }: { events: ServiceEvent[]; now: number }) {
  const selectTable = useUiStore((state) => state.selectTable);
  const latest = [...events].reverse().slice(0, 18);
  if (latest.length === 0) return <p className="text-sm text-muted-foreground">The floor is quiet.</p>;
  return (
    <ul className="space-y-1">
      {latest.map((event) => (
        <li key={event.id}>
          <button
            type="button"
            onClick={() => selectTable(event.tableId)}
            className="flex w-full items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent"
          >
            <span>
              <span className="text-xs font-semibold text-primary">{event.tableId}</span>
              <span className="mt-0.5 block text-sm">{EVENT_LABEL[event.type]}</span>
              {eventSummary(event.metadata) && <span className="block text-xs text-muted-foreground">{eventSummary(event.metadata)}</span>}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{formatAgo(event.timestamp, now)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
