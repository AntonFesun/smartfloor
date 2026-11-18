import { stationForMenuItem } from "@/domain/kitchen";
import type {
  Capacity,
  MenuItem,
  Order,
  OrderItem,
  OrderStatus,
  RestaurantTable,
  ServiceEvent,
  TableShape,
  WaiterCall,
  ZoneName,
} from "@/types";

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface SeedBundle {
  tables: RestaurantTable[];
  menu: MenuItem[];
  orders: Order[];
  calls: WaiterCall[];
  events: ServiceEvent[];
}

function table(
  number: number,
  zone: ZoneName,
  shape: TableShape,
  capacity: Capacity,
  x: number,
  y: number,
  status: RestaurantTable["status"],
  occupiedSeatCount: number,
  rotation = 0,
): RestaurantTable {
  return {
    id: `T${String(number).padStart(2, "0")}`,
    number,
    zone,
    shape,
    x,
    y,
    rotation,
    capacity,
    occupiedSeatCount,
    status,
  };
}

const MENU = [
  { id: "menu-burrata", name: "Burrata & tomato", category: "Starters", price: 280, description: "Cream, basil oil, sourdough", sort: 10, station: null },
  { id: "menu-tartare", name: "Tuna tartare", category: "Starters", price: 340, description: "Citrus, sesame, radish", sort: 11 },
  { id: "menu-soup", name: "Mushroom soup", category: "Starters", price: 160, description: "Thyme cream", sort: 12 },
  { id: "menu-bruschetta", name: "Tomato bruschetta", category: "Starters", price: 150, description: "Oregano, olive oil", sort: 13 },
  { id: "menu-ribeye", name: "Ribeye steak", category: "Mains", price: 620, description: "250g, pepper sauce", sort: 20 },
  { id: "menu-salmon", name: "Salmon fillet", category: "Mains", price: 480, description: "Beet, horseradish", sort: 21 },
  { id: "menu-risotto", name: "Wild mushroom risotto", category: "Mains", price: 360, description: "Parmesan, thyme", sort: 22 },
  { id: "menu-burger", name: "Atelier burger", category: "Mains", price: 290, description: "Cheddar, brioche", sort: 23 },
  { id: "menu-margherita", name: "Margherita", category: "Pizza", price: 240, description: "Tomato, mozzarella, basil", sort: 30 },
  { id: "menu-diavola", name: "Diavola", category: "Pizza", price: 280, description: "Spicy salami, honey", sort: 31 },
  { id: "menu-formaggi", name: "Quattro formaggi", category: "Pizza", price: 300, description: "Four cheeses", sort: 32 },
  { id: "menu-tiramisu", name: "Tiramisu", category: "Desserts", price: 180, description: "Espresso, mascarpone", sort: 40 },
  { id: "menu-cheesecake", name: "Basque cheesecake", category: "Desserts", price: 170, description: "Burnt vanilla top", sort: 41 },
  { id: "menu-espresso", name: "Espresso", category: "Coffee", price: 70, description: "Double shot", sort: 50 },
  { id: "menu-cappuccino", name: "Cappuccino", category: "Coffee", price: 95, description: "Steamed milk", sort: 51 },
  { id: "menu-flatwhite", name: "Flat white", category: "Coffee", price: 110, description: "Short milk, strong", sort: 52 },
  { id: "menu-lemonade", name: "Homemade lemonade", category: "Soft drinks", price: 90, description: "Lemon, mint", sort: 60 },
  { id: "menu-water", name: "Still water", category: "Soft drinks", price: 50, description: "500ml", sort: 61 },
  { id: "menu-cola", name: "Cola", category: "Soft drinks", price: 65, description: "Chilled", sort: 62, station: null },
].map((item) => ({ ...item, station: stationForMenuItem(item) }) as MenuItem);

function menuById(id: string): MenuItem {
  const item = MENU.find((entry) => entry.id === id);
  if (!item) throw new Error(`Missing menu item ${id}`);
  return item;
}

export function buildSeed(now: number): SeedBundle {
  const iso = (delta: number) => new Date(now + delta).toISOString();
  let eventNo = 0;
  let lineNo = 0;
  const events: ServiceEvent[] = [];
  const orders: Order[] = [];
  const calls: WaiterCall[] = [];

  const pushEvent = (
    tableId: string,
    delta: number,
    type: ServiceEvent["type"],
    extra?: { orderId?: string; callId?: string; summary?: string },
  ) => {
    eventNo += 1;
    events.push({
      id: `evt-seed-${eventNo}`,
      tableId,
      timestamp: iso(delta),
      type,
      orderId: extra?.orderId ?? null,
      callId: extra?.callId ?? null,
      metadata: extra?.summary ? { summary: extra.summary } : {},
    });
  };

  const addOrder = (input: {
    id: string;
    tableId: string;
    status: OrderStatus;
    lines: { menuId: string; qty: number }[];
    submitted: number;
    accepted?: number;
    prep?: number;
    ready?: number;
    served?: number;
  }) => {
    const items: OrderItem[] = input.lines.map((line) => {
      const menu = menuById(line.menuId);
      lineNo += 1;
      return {
        id: `line-seed-${lineNo}`,
        menuItemId: menu.id,
        name: menu.name,
        qty: line.qty,
        price: menu.price,
      };
    });
    const total = items.reduce((sum, item) => sum + item.qty * item.price, 0);
    const summary = items.map((item) => `${item.name} × ${item.qty}`).join(", ");
    const updated =
      input.status === "SERVED"
        ? input.served
        : input.status === "READY"
          ? input.ready
          : input.status === "PREPARING"
            ? input.prep
            : input.status === "ACCEPTED"
              ? input.accepted
              : input.submitted;
    if (updated == null) throw new Error(`Order ${input.id} is missing a timestamp`);
    orders.push({
      id: input.id,
      tableId: input.tableId,
      status: input.status,
      items,
      total,
      createdAt: iso(input.submitted),
      updatedAt: iso(updated),
    });
    pushEvent(input.tableId, input.submitted, "order.submitted", { orderId: input.id, summary });
    if (input.accepted != null) pushEvent(input.tableId, input.accepted, "order.accepted", { orderId: input.id, summary });
    if (input.prep != null) pushEvent(input.tableId, input.prep, "order.prep_started", { orderId: input.id, summary });
    if (input.ready != null) pushEvent(input.tableId, input.ready, "order.ready", { orderId: input.id, summary });
    if (input.served != null) pushEvent(input.tableId, input.served, "order.served", { orderId: input.id, summary });
  };

  const addCall = (input: {
    id: string;
    tableId: string;
    called: number;
    acknowledged?: number;
    resolved?: number;
  }) => {
    const status = input.resolved != null ? "RESOLVED" : input.acknowledged != null ? "ACKNOWLEDGED" : "ACTIVE";
    calls.push({
      id: input.id,
      tableId: input.tableId,
      status,
      createdAt: iso(input.called),
      acknowledgedAt: input.acknowledged != null ? iso(input.acknowledged) : null,
      resolvedAt: input.resolved != null ? iso(input.resolved) : null,
    });
    pushEvent(input.tableId, input.called, "waiter.called", { callId: input.id });
    if (input.acknowledged != null) {
      pushEvent(input.tableId, input.acknowledged, "waiter.acknowledged", { callId: input.id });
    }
    if (input.resolved != null) pushEvent(input.tableId, input.resolved, "waiter.resolved", { callId: input.id });
  };

  const tables: RestaurantTable[] = [
    table(1, "Main Hall", "circle", 4, -6.4, -3.4, "AVAILABLE", 0),
    table(2, "Main Hall", "circle", 4, -3.4, -3.4, "OCCUPIED", 2),
    table(3, "Main Hall", "circle", 2, -6.4, -0.4, "OCCUPIED", 2),
    table(4, "Main Hall", "circle", 4, -3.4, -0.2, "OCCUPIED", 3, 8),
    table(5, "Main Hall", "circle", 6, -6.2, 2.8, "OCCUPIED", 4),
    table(6, "Main Hall", "circle", 6, -2.8, 2.9, "OCCUPIED", 2, -10),
    table(7, "Main Hall", "circle", 4, 0.4, -2.4, "OCCUPIED", 2),
    table(8, "Main Hall", "circle", 2, 0.4, 1.0, "RESERVED", 0),
    table(9, "Terrace", "circle", 4, 4.8, -4.0, "AVAILABLE", 0),
    table(10, "Terrace", "circle", 4, 4.8, -1.3, "OCCUPIED", 2),
    table(11, "Terrace", "circle", 2, 7.6, -4.0, "RESERVED", 0),
    table(12, "Terrace", "circle", 4, 7.6, -1.3, "AVAILABLE", 0),
    table(13, "Bar Lounge", "circle", 2, 4.0, 2.8, "AVAILABLE", 0),
    table(14, "Bar Lounge", "circle", 4, 6.5, 2.7, "OCCUPIED", 2, 6),
    table(15, "Bar Lounge", "circle", 2, 4.0, 4.9, "AVAILABLE", 0),
    table(16, "Bar Lounge", "circle", 2, 6.6, 4.9, "AVAILABLE", 0),
  ];

  pushEvent("T01", -5 * HOUR, "guests.seated", { summary: "Party of 2" });
  addOrder({
    id: "ord-seed-01",
    tableId: "T01",
    status: "SERVED",
    lines: [
      { menuId: "menu-margherita", qty: 1 },
      { menuId: "menu-lemonade", qty: 1 },
    ],
    submitted: -4.6 * HOUR,
    accepted: -4.6 * HOUR + 2 * MIN,
    prep: -4.6 * HOUR + 3 * MIN,
    ready: -4.6 * HOUR + 16 * MIN,
    served: -4.6 * HOUR + 20 * MIN,
  });
  addCall({ id: "call-seed-01", tableId: "T01", called: -4.7 * HOUR, acknowledged: -4.7 * HOUR + 70_000, resolved: -4.7 * HOUR + 4 * MIN });
  pushEvent("T01", -3.5 * HOUR, "table.cleared");

  pushEvent("T06", -4 * HOUR, "guests.seated", { summary: "Party of 4" });
  addOrder({
    id: "ord-seed-06",
    tableId: "T06",
    status: "SERVED",
    lines: [
      { menuId: "menu-burger", qty: 1 },
      { menuId: "menu-cola", qty: 1 },
    ],
    submitted: -3.7 * HOUR,
    accepted: -3.7 * HOUR + 90_000,
    prep: -3.7 * HOUR + 2 * MIN,
    ready: -3.7 * HOUR + 90_000 + 28 * MIN,
    served: -3.7 * HOUR + 90_000 + 40 * MIN,
  });
  addCall({ id: "call-seed-06", tableId: "T06", called: -3.8 * HOUR, acknowledged: -3.8 * HOUR + 5 * MIN, resolved: -3.8 * HOUR + 7 * MIN });
  pushEvent("T06", -2 * HOUR, "table.cleared");
  pushEvent("T06", -50 * MIN, "guests.seated", { summary: "Party of 2" });

  pushEvent("T03", -80 * MIN, "guests.seated", { summary: "Party of 2" });
  addOrder({
    id: "ord-seed-03",
    tableId: "T03",
    status: "SERVED",
    lines: [
      { menuId: "menu-ribeye", qty: 1 },
      { menuId: "menu-cappuccino", qty: 1 },
    ],
    submitted: -70 * MIN,
    accepted: -68 * MIN,
    prep: -67 * MIN,
    ready: -52 * MIN,
    served: -47 * MIN,
  });
  addCall({ id: "call-seed-03", tableId: "T03", called: -75 * MIN, acknowledged: -75 * MIN + 80_000, resolved: -72 * MIN });

  pushEvent("T05", -70 * MIN, "guests.seated", { summary: "Party of 4" });
  addOrder({
    id: "ord-seed-05",
    tableId: "T05",
    status: "SERVED",
    lines: [
      { menuId: "menu-salmon", qty: 1 },
      { menuId: "menu-water", qty: 1 },
      { menuId: "menu-tiramisu", qty: 1 },
    ],
    submitted: -60 * MIN,
    accepted: -57 * MIN,
    prep: -56 * MIN,
    ready: -39 * MIN,
    served: -33 * MIN,
  });

  pushEvent("T02", -40 * MIN, "guests.seated", { summary: "Party of 2" });
  addOrder({
    id: "ord-seed-02",
    tableId: "T02",
    status: "PREPARING",
    lines: [
      { menuId: "menu-risotto", qty: 1 },
      { menuId: "menu-flatwhite", qty: 1 },
    ],
    submitted: -20 * MIN,
    accepted: -18 * MIN,
    prep: -17 * MIN,
  });

  pushEvent("T04", -35 * MIN, "guests.seated", { summary: "Party of 3" });
  addOrder({
    id: "ord-seed-04",
    tableId: "T04",
    status: "READY",
    lines: [
      { menuId: "menu-diavola", qty: 1 },
      { menuId: "menu-lemonade", qty: 1 },
    ],
    submitted: -28 * MIN,
    accepted: -27 * MIN,
    prep: -26 * MIN,
    ready: -15 * MIN,
  });

  pushEvent("T10", -20 * MIN, "guests.seated", { summary: "Party of 2" });
  addOrder({
    id: "ord-seed-10",
    tableId: "T10",
    status: "ACCEPTED",
    lines: [
      { menuId: "menu-formaggi", qty: 1 },
      { menuId: "menu-water", qty: 1 },
    ],
    submitted: -8 * MIN,
    accepted: -6 * MIN,
  });

  pushEvent("T14", -15 * MIN, "guests.seated", { summary: "Party of 2" });
  addOrder({
    id: "ord-seed-14",
    tableId: "T14",
    status: "NEW",
    lines: [{ menuId: "menu-espresso", qty: 1 }],
    submitted: -3 * MIN,
  });
  addCall({ id: "call-seed-14", tableId: "T14", called: -6 * MIN });

  pushEvent("T07", -25 * MIN, "guests.seated", { summary: "Party of 2" });

  return { tables, menu: MENU, orders, calls, events };
}
