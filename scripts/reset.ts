import { getDb } from "../src/lib/db";
import { resetDemo } from "../src/lib/repository";
import { runtimeContext } from "../src/lib/runtime";

// Rebuilds the known demo: the current floor plus about 30 days of Europe/Kyiv
// history in the SQLite tables and the event journal. The in-app Reset button
// calls the same path.
const db = getDb();
const snapshot = resetDemo(db, runtimeContext());
const names = [
  "tables",
  "menu_items",
  "orders",
  "order_items",
  "payments",
  "waiter_calls",
  "events",
  "kitchen_tickets",
  "kitchen_ticket_items",
  "waiter_tasks",
  "reservation_intervals",
  "table_groups",
  "table_group_members",
  "waiter_shifts",
  "restaurant_events",
];
console.log(`Restored ${snapshot.tables.length} tables, served checks ₴${snapshot.revenue}`);
for (const name of names) {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number };
  console.log(`${name}\t${count.c}`);
}
