export const ZONES = ["Main Hall", "Terrace", "Bar Lounge"] as const;
export const CAPACITIES = [2, 4, 6, 8] as const;
export const TABLE_STATUSES = ["AVAILABLE", "OCCUPIED", "RESERVED"] as const;
export const ORDER_STATUSES = ["NEW", "ACCEPTED", "PREPARING", "READY", "SERVED", "CANCELLED"] as const;
export const WAITER_STATUSES = ["ACTIVE", "ACKNOWLEDGED", "RESOLVED"] as const;
export const TABLE_SHAPES = ["circle", "rect"] as const;
export const MENU_CATEGORIES = ["Starters", "Mains", "Pizza", "Desserts", "Coffee", "Soft drinks"] as const;

export const EVENT_TYPES = [
  "guests.seated",
  "order.submitted",
  "order.accepted",
  "order.prep_started",
  "order.ready",
  "order.served",
  "waiter.called",
  "waiter.acknowledged",
  "waiter.resolved",
  "table.cleared",
] as const;

export type ZoneName = (typeof ZONES)[number];
export type Capacity = (typeof CAPACITIES)[number];
export type TableStatus = (typeof TABLE_STATUSES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type WaiterStatus = (typeof WAITER_STATUSES)[number];
export type TableShape = (typeof TABLE_SHAPES)[number];
export type MenuCategory = (typeof MENU_CATEGORIES)[number];
export type EventType = (typeof EVENT_TYPES)[number];

export interface RestaurantTable {
  id: string;
  number: number;
  zone: ZoneName;
  shape: TableShape;
  x: number;
  y: number;
  rotation: number;
  capacity: Capacity;
  occupiedSeatCount: number;
  status: TableStatus;
}

export interface MenuItem {
  id: string;
  name: string;
  category: MenuCategory;
  price: number;
  description: string;
  sort: number;
  station: "Hot Kitchen" | "Cold Kitchen" | "Bar" | null;
}

export interface OrderItem {
  id: string;
  menuItemId: string;
  name: string;
  qty: number;
  price: number;
}

export interface Order {
  id: string;
  tableId: string;
  status: OrderStatus;
  items: OrderItem[];
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface WaiterCall {
  id: string;
  tableId: string;
  status: WaiterStatus;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface ServiceEvent {
  id: string;
  tableId: string;
  timestamp: string;
  type: EventType;
  orderId: string | null;
  callId: string | null;
  metadata: Record<string, unknown>;
}

export interface Thresholds {
  waiterMs: number;
  prepMs: number;
  readyMs: number;
  occupancyMs: number;
}

export interface DurationStat {
  count: number;
  avgMs: number | null;
}

export interface ZoneDelay {
  zone: string;
  waiter: number;
  prep: number;
  ready: number;
  occupancy: number;
}

export interface UnresolvedItem {
  kind: "waiter" | "order" | "occupancy";
  tableId: string;
  tableNumber: number;
  ms: number;
}

export interface Metrics {
  submitToAccept: DurationStat;
  acceptToReady: DurationStat;
  readyToServed: DurationStat;
  waiterResponse: DurationStat;
  occupancy: DurationStat;
  turnover: DurationStat;
  delaysByZone: ZoneDelay[];
  longestUnresolved: UnresolvedItem | null;
  thresholds: Thresholds;
}

export interface Snapshot {
  restaurant: { name: string };
  tables: RestaurantTable[];
  orders: Order[];
  waiterCalls: WaiterCall[];
  events: ServiceEvent[];
  menu: MenuItem[];
  tickets: import("@/domain/kitchen").KitchenTicket[];
  deliveryTasks: import("@/domain/kitchen").DeliveryTask[];
  waiters: import("@/domain/waiters").Waiter[];
  shifts: import("@/domain/waiters").WaiterShift[];
  zoneAssignments: import("@/domain/waiters").WaiterZoneAssignment[];
  waiterTasks: import("@/domain/waiters").WaiterTask[];
  reservations: import("@/domain/seating").Reservation[];
  tableGroups: import("@/domain/seating").TableGroup[];
  payments: import("@/domain/revenue").PaymentRecord[];
  journal: import("@/domain/journal").RestaurantEvent[];
  metrics: Metrics;
  revenue: number;
  publicUrl: string;
  generatedAt: string;
}

export interface LayoutPatch {
  id: string;
  x: number;
  y: number;
  rotation: number;
  shape: TableShape;
  capacity: Capacity;
  zone: ZoneName;
}

export const RESTAURANT_NAME = "Atelier Restaurant";
