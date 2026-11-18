import { z } from "zod";
import { JOURNAL_EVENT_TYPES } from "@/domain/journal";
import {
  CAPACITIES,
  EVENT_TYPES,
  MENU_CATEGORIES,
  ORDER_STATUSES,
  TABLE_SHAPES,
  TABLE_STATUSES,
  WAITER_STATUSES,
  ZONES,
} from "@/types";

const capacitySchema = z.union([
  z.literal(CAPACITIES[0]),
  z.literal(CAPACITIES[1]),
  z.literal(CAPACITIES[2]),
  z.literal(CAPACITIES[3]),
]);

export const tableSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  zone: z.enum(ZONES),
  shape: z.enum(TABLE_SHAPES),
  x: z.number(),
  y: z.number(),
  rotation: z.number(),
  capacity: capacitySchema,
  occupiedSeatCount: z.number().int().nonnegative(),
  status: z.enum(TABLE_STATUSES),
});

export const menuItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(MENU_CATEGORIES),
  price: z.number().int().nonnegative(),
  description: z.string(),
  sort: z.number().int(),
  station: z.enum(["Hot Kitchen", "Cold Kitchen", "Bar"]).nullable(),
});

export const orderItemSchema = z.object({
  id: z.string(),
  menuItemId: z.string(),
  name: z.string(),
  qty: z.number().int().positive(),
  price: z.number().int().nonnegative(),
});

export const orderSchema = z.object({
  id: z.string(),
  tableId: z.string(),
  status: z.enum(ORDER_STATUSES),
  items: z.array(orderItemSchema),
  total: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const waiterCallSchema = z.object({
  id: z.string(),
  tableId: z.string(),
  status: z.enum(WAITER_STATUSES),
  createdAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

export const serviceEventSchema = z.object({
  id: z.string(),
  tableId: z.string(),
  timestamp: z.string(),
  type: z.enum(EVENT_TYPES),
  orderId: z.string().nullable(),
  callId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const durationStatSchema = z.object({
  count: z.number().int().nonnegative(),
  avgMs: z.number().nullable(),
});

export const metricsSchema = z.object({
  submitToAccept: durationStatSchema,
  acceptToReady: durationStatSchema,
  readyToServed: durationStatSchema,
  waiterResponse: durationStatSchema,
  occupancy: durationStatSchema,
  turnover: durationStatSchema,
  delaysByZone: z.array(
    z.object({
      zone: z.string(),
      waiter: z.number().int().nonnegative(),
      prep: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      occupancy: z.number().int().nonnegative(),
    }),
  ),
  longestUnresolved: z
    .object({
      kind: z.enum(["waiter", "order", "occupancy"]),
      tableId: z.string(),
      tableNumber: z.number().int(),
      ms: z.number(),
    })
    .nullable(),
  thresholds: z.object({
    waiterMs: z.number(),
    prepMs: z.number(),
    readyMs: z.number(),
    occupancyMs: z.number(),
  }),
});

export const journalEventSchema = z.object({
  id: z.string(),
  sequence: z.number().int(),
  restaurantId: z.string(),
  tableId: z.string().nullable(),
  orderId: z.string().nullable(),
  waiterId: z.string().nullable(),
  zoneId: z.string().nullable(),
  sessionId: z.string().nullable(),
  type: z.enum(JOURNAL_EVENT_TYPES),
  occurredAt: z.string(),
  payload: z.record(z.unknown()),
  schemaVersion: z.number().int(),
  idempotencyKey: z.string().nullable(),
  commandId: z.string(),
});

export const restaurantEventCreatedSchema = z.object({ event: journalEventSchema });

export const snapshotSchema = z.object({
  restaurant: z.object({ name: z.string() }),
  tables: z.array(tableSchema),
  orders: z.array(orderSchema),
  waiterCalls: z.array(waiterCallSchema),
  events: z.array(serviceEventSchema),
  menu: z.array(menuItemSchema),
  tickets: z.array(z.object({
    id: z.string(),
    number: z.number().int(),
    orderId: z.string(),
    tableId: z.string(),
    station: z.enum(["Hot Kitchen", "Cold Kitchen", "Bar"]),
    status: z.enum(["NEW", "ACCEPTED", "PREPARING", "READY", "COMPLETED", "CANCELLED"]),
    priority: z.number().int(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    acceptedAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    readyAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    items: z.array(z.object({
      id: z.string(),
      menuItemId: z.string(),
      name: z.string(),
      qty: z.number().int(),
      notes: z.string().nullable(),
      done: z.boolean(),
    })),
  })),
  deliveryTasks: z.array(z.object({
    id: z.string(),
    type: z.literal("deliver_order"),
    orderId: z.string(),
    tableId: z.string(),
    status: z.enum(["OPEN", "COMPLETED"]),
    priority: z.number().int(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    assignedWaiterId: z.string().nullable(),
  })),
  waiters: z.array(z.object({ id: z.string(), name: z.string() })),
  shifts: z.array(z.object({ id: z.string(), waiterId: z.string(), startedAt: z.string(), endedAt: z.string().nullable() })),
  zoneAssignments: z.array(z.object({ id: z.string(), waiterId: z.string(), zone: z.enum(ZONES) })),
  waiterTasks: z.array(z.object({
    id: z.string(),
    type: z.enum(["respond_to_call", "deliver_order", "clear_table", "seat_guests", "general_assistance"]),
    tableId: z.string(),
    orderId: z.string().nullable(),
    callId: z.string().nullable(),
    assignedWaiterId: z.string().nullable(),
    status: z.enum(["OPEN", "ACKNOWLEDGED", "COMPLETED"]),
    priority: z.number().int(),
    createdAt: z.string(),
    acknowledgedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })),
  reservations: z.array(z.object({
    id: z.string(),
    partySize: z.number().int(),
    start: z.string(),
    end: z.string(),
    tableId: z.string().nullable(),
    groupId: z.string().nullable(),
    status: z.enum(["CONFIRMED", "SEATED", "CANCELLED", "COMPLETED"]),
    createdAt: z.string(),
  })),
  tableGroups: z.array(z.object({
    id: z.string(),
    status: z.enum(["ACTIVE", "DISSOLVED"]),
    tableIds: z.array(z.string()),
    createdAt: z.string(),
    dissolvedAt: z.string().nullable(),
  })),
  payments: z.array(z.object({
    id: z.string(),
    orderId: z.string(),
    tableId: z.string(),
    amount: z.number().int(),
    paidAt: z.string(),
    note: z.string(),
  })),
  journal: z.array(journalEventSchema),
  metrics: metricsSchema,
  revenue: z.number(),
  publicUrl: z.string(),
  generatedAt: z.string(),
});

export const orderCreateSchema = z.object({
  tableId: z.string().min(1).max(16),
  items: z
    .array(
      z.object({
        menuItemId: z.string().min(1),
        qty: z.number().int().min(1).max(20),
      }),
    )
    .min(1)
    .max(30),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const orderTransitionSchema = z.object({
  status: z.enum(["ACCEPTED", "PREPARING", "READY", "SERVED", "CANCELLED"]),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const waiterCreateSchema = z.object({
  tableId: z.string().min(1).max(16),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const seatSchema = z.object({
  occupiedSeatCount: z.number().int().min(1).max(8),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const layoutSchema = z.object({
  tables: z
    .array(
      z.object({
        id: z.string().min(1),
        x: z.number().finite(),
        y: z.number().finite(),
        rotation: z.number().finite(),
        shape: z.enum(TABLE_SHAPES),
        capacity: capacitySchema,
        zone: z.enum(ZONES),
      }),
    )
    .min(1),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const addTableSchema = z.object({
  zone: z.enum(ZONES),
  shape: z.enum(TABLE_SHAPES),
  capacity: capacitySchema,
});

export const orderCreatedSchema = z.object({
  order: orderSchema,
  table: tableSchema,
  events: z.array(serviceEventSchema),
});

export const orderUpdatedSchema = z.object({
  order: orderSchema,
  events: z.array(serviceEventSchema),
});

export const waiterEventSchema = z.object({
  call: waiterCallSchema,
  events: z.array(serviceEventSchema),
});

export const tableUpdatedSchema = z.object({
  table: tableSchema,
  events: z.array(serviceEventSchema),
});

export const layoutUpdatedSchema = z.object({
  tables: z.array(tableSchema),
});

export const timelineEventSchema = z.object({
  event: serviceEventSchema,
});

export const kitchenTicketSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  orderId: z.string(),
  tableId: z.string(),
  station: z.enum(["Hot Kitchen", "Cold Kitchen", "Bar"]),
  status: z.enum(["NEW", "ACCEPTED", "PREPARING", "READY", "COMPLETED", "CANCELLED"]),
  priority: z.number().int(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  readyAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      menuItemId: z.string(),
      name: z.string(),
      qty: z.number().int(),
      notes: z.string().nullable(),
      done: z.boolean(),
    }),
  ),
});

export const deliveryTaskSchema = z.object({
  id: z.string(),
  type: z.literal("deliver_order"),
  orderId: z.string(),
  tableId: z.string(),
  status: z.enum(["OPEN", "COMPLETED"]),
  priority: z.number().int(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  assignedWaiterId: z.string().nullable(),
});

export const waiterTaskSchema = z.object({
  id: z.string(),
  type: z.enum(["respond_to_call", "deliver_order", "clear_table", "seat_guests", "general_assistance"]),
  tableId: z.string(),
  orderId: z.string().nullable(),
  callId: z.string().nullable(),
  assignedWaiterId: z.string().nullable(),
  status: z.enum(["OPEN", "ACKNOWLEDGED", "COMPLETED"]),
  priority: z.number().int(),
  createdAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const waiterTaskEventSchema = z.object({
  task: waiterTaskSchema,
  unassigned: z.boolean().optional(),
});

export const kitchenTicketEventSchema = z.object({ ticket: kitchenTicketSchema });
export const deliveryTaskEventSchema = z.object({ task: deliveryTaskSchema });

export const reservationSchema = z.object({
  id: z.string(),
  partySize: z.number().int(),
  start: z.string(),
  end: z.string(),
  tableId: z.string().nullable(),
  groupId: z.string().nullable(),
  status: z.enum(["CONFIRMED", "SEATED", "CANCELLED", "COMPLETED"]),
  createdAt: z.string(),
});

export const tableGroupSchema = z.object({
  id: z.string(),
  status: z.enum(["ACTIVE", "DISSOLVED"]),
  tableIds: z.array(z.string()),
  createdAt: z.string(),
  dissolvedAt: z.string().nullable(),
});

export const reservationEventSchema = z.object({ reservation: reservationSchema });
export const tableGroupEventSchema = z.object({ group: tableGroupSchema });

export const ticketActionSchema = z.object({
  action: z.enum(["accept", "start", "complete_item", "complete", "bump"]),
  itemId: z.string().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});
