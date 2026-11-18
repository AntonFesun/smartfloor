"use client";

import { useState } from "react";
import { Bell, CalendarClock, ConciergeBell, CreditCard, UserRound, UtensilsCrossed } from "lucide-react";
import type { JournalEventType, RestaurantEvent } from "@/domain/journal";
import { measureSpans, tableJournal, TIMELINE_FILTERS, type TimelineFilter } from "@/domain/replay";
import { Button } from "@/components/ui/button";
import { formatClock, formatDuration } from "@/lib/format";

const FILTER_LABEL: Record<TimelineFilter, string> = {
  all: "All",
  orders: "Orders",
  guests: "Guests",
  calls: "Waiter calls",
  payments: "Payments",
  reservations: "Reservations",
};

export function JournalTimeline({ events, tableId, throughSequence }: { events: RestaurantEvent[]; tableId: string; throughSequence?: number }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const recorded = tableJournal(events, tableId, "all", throughSequence);
  const shown = tableJournal(events, tableId, filter, throughSequence);
  const spans = measureSpans(shown);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {TIMELINE_FILTERS.map((item) => (
          <Button key={item} size="sm" variant={filter === item ? "default" : "ghost"} onClick={() => setFilter(item)}>
            {FILTER_LABEL[item]}
          </Button>
        ))}
      </div>
      {recorded.length === 0 ? (
        <p className="text-sm text-muted-foreground">No journal history for this table. Service that predates the journal is not reconstructed.</p>
      ) : (
        <>
          {spans.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {spans.length > 8 && <li>Latest durations. The list below keeps the full journal.</li>}
              {(spans.length > 8 ? spans.slice(-8) : spans).map((span, index) => (
                <li key={`${span.label}-${span.orderId ?? span.tableId}-${index}`}>
                  {span.label}
                  {span.orderId ? ` · ${span.orderId}` : ""}: {formatDuration(span.ms)}
                </li>
              ))}
            </ul>
          )}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events in this filter.</p>
          ) : (
            <ol className="space-y-0">
              {shown.map((event, index) => {
                const previous = shown[index - 1];
                const gap = previous ? Date.parse(event.occurredAt) - Date.parse(previous.occurredAt) : null;
                const Icon = iconFor(event.type);
                return (
                  <li key={event.id} className="grid grid-cols-[16px_1fr] gap-3">
                    <div className="flex flex-col items-center">
                      <Icon className="mt-0.5 h-3.5 w-3.5 text-primary" />
                      {index < shown.length - 1 && <span className="w-px flex-1 bg-border" />}
                    </div>
                    <div className="pb-4">
                      {gap != null && gap >= 1000 && <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{formatDuration(gap)} later</div>}
                      <div className="text-sm font-medium">{labelFor(event.type)}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatClock(event.occurredAt)} · seq {event.sequence}
                        {event.waiterId ? ` · ${event.waiterId}` : ""}
                        {event.orderId ? ` · ${event.orderId}` : ""}
                      </div>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11px] text-muted-foreground">Details</summary>
                        <pre className="mt-1 overflow-auto rounded bg-background/70 p-2 text-[10px] leading-relaxed text-muted-foreground">{JSON.stringify(event.payload, null, 2)}</pre>
                      </details>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function iconFor(type: JournalEventType) {
  if (type.startsWith("ORDER_")) return UtensilsCrossed;
  if (type.startsWith("WAITER_")) return Bell;
  if (type.startsWith("RESERVATION_") || type.startsWith("TABLE_GROUP_")) return CalendarClock;
  if (type === "PAYMENT_RECORDED") return CreditCard;
  if (type.startsWith("GUEST_") || type.startsWith("TABLE_")) return UserRound;
  return ConciergeBell;
}

function labelFor(type: JournalEventType): string {
  return type
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
