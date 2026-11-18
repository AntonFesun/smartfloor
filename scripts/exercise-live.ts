import { io, type Socket } from "socket.io-client";

const base = process.env.APP_BASE ?? "http://127.0.0.1:3000";

function connect(label: string): Promise<Socket> {
  const socket = io(base, { transports: ["websocket", "polling"], timeout: 8000 });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} connect timeout`)), 8000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function once<T>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`${path} ${response.status} ${data.error ?? ""}`);
  return data;
}

async function main() {
  const health = await fetch(`${base}/api/snapshot`);
  if (!health.ok) throw new Error(`snapshot ${health.status}`);
  const snap = (await health.json()) as {
    menu: { id: string; name: string }[];
    tables: { id: string; x: number; y: number; rotation: number; shape: string; capacity: number; zone: string }[];
    publicUrl: string;
  };
  const coffee = snap.menu.find((item) => item.name === "Cappuccino");
  const pizza = snap.menu.find((item) => item.name === "Margherita");
  const table = snap.tables.find((item) => item.id === "T07");
  if (!coffee || !pizza || !table) throw new Error("seed is missing T07, coffee, or pizza");
  if (snap.publicUrl.includes("localhost")) throw new Error(`public URL forced localhost: ${snap.publicUrl}`);

  const dashboard = await connect("dashboard");
  const guest = await connect("guest");
  const orderOnDashboard = once<{ order: { id: string; total: number; tableId: string } }>(dashboard, "order.created");
  const orderOnGuest = once<{ order: { id: string } }>(guest, "order.created");
  const timeline = once<{ event: { type: string; tableId: string } }>(dashboard, "timeline.event");

  const created = await post<{ order: { id: string; total: number; items: { name: string }[] }; events: { type: string }[] }>(
    "/api/orders",
    {
      tableId: "T07",
      items: [
        { menuItemId: coffee.id, qty: 1 },
        { menuItemId: pizza.id, qty: 1 },
      ],
    },
  );
  if (created.order.total !== 335) throw new Error(`unexpected total ${created.order.total}`);
  const [fromDashboard, fromGuest, timelineEvent] = await Promise.all([orderOnDashboard, orderOnGuest, timeline]);
  if (fromDashboard.order.id !== created.order.id || fromGuest.order.id !== created.order.id) {
    throw new Error("order.created was not delivered to both clients");
  }
  if (timelineEvent.event.type !== "order.submitted" || timelineEvent.event.tableId !== "T07") {
    throw new Error(`unexpected timeline event ${timelineEvent.event.type}`);
  }

  const calledDash = once<{ call: { id: string; tableId: string; status: string } }>(dashboard, "waiter.called");
  const calledGuest = once<{ call: { id: string } }>(guest, "waiter.called");
  const call = await post<{ call: { id: string } }>("/api/waiter", { tableId: "T07" });
  const [callDash, callGuest] = await Promise.all([calledDash, calledGuest]);
  if (callDash.call.id !== call.call.id || callGuest.call.id !== call.call.id || callDash.call.status !== "ACTIVE") {
    throw new Error("waiter.called was not delivered");
  }
  const duplicate = await fetch(`${base}/api/waiter`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tableId: "T07" }),
  });
  if (duplicate.status !== 409) throw new Error(`duplicate call status ${duplicate.status}`);

  const acked = once<{ call: { status: string } }>(guest, "waiter.acknowledged");
  await post(`/api/waiter/${call.call.id}/acknowledge`);
  if ((await acked).call.status !== "ACKNOWLEDGED") throw new Error("acknowledge did not broadcast");

  const resolved = once<{ call: { status: string } }>(guest, "waiter.resolved");
  await post(`/api/waiter/${call.call.id}/resolve`);
  if ((await resolved).call.status !== "RESOLVED") throw new Error("resolve did not broadcast");

  const fresh = (await fetch(`${base}/api/snapshot`).then((response) => response.json())) as typeof snap;
  const current = fresh.tables.find((item) => item.id === "T07");
  if (!current) throw new Error("T07 missing before move");
  const nextX = current.x > 1.1 ? 0.4 : Math.round((current.x + 0.8) * 100) / 100;
  const layoutDash = once<{ tables: { id: string; x: number }[] }>(dashboard, "layout.updated");
  const layoutGuest = once<{ tables: { id: string; x: number }[] }>(guest, "layout.updated");
  const saved = await fetch(`${base}/api/layout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tables: fresh.tables.map((item) =>
        item.id === "T07"
          ? { id: item.id, x: nextX, y: item.y, rotation: item.rotation, shape: item.shape, capacity: item.capacity, zone: item.zone }
          : { id: item.id, x: item.x, y: item.y, rotation: item.rotation, shape: item.shape, capacity: item.capacity, zone: item.zone },
      ),
    }),
  });
  if (!saved.ok) throw new Error(`layout ${saved.status} ${await saved.text()}`);
  const [movedDash, movedGuest] = await Promise.all([layoutDash, layoutGuest]);
  const dashTable = movedDash.tables.find((item) => item.id === "T07");
  const guestTable = movedGuest.tables.find((item) => item.id === "T07");
  if (dashTable?.x !== nextX || guestTable?.x !== nextX) {
    throw new Error(`layout sync failed ${dashTable?.x} ${guestTable?.x} expected ${nextX}`);
  }

  const after = (await fetch(`${base}/api/snapshot`).then((response) => response.json())) as {
    orders: { id: string; tableId: string; status: string }[];
    waiterCalls: { id: string; status: string }[];
    tables: { id: string; x: number }[];
  };
  if (!after.orders.some((order) => order.id === created.order.id && order.tableId === "T07")) {
    throw new Error("order missing from snapshot");
  }
  if (after.waiterCalls.find((item) => item.id === call.call.id)?.status !== "RESOLVED") {
    throw new Error("call was not resolved in the database");
  }
  if (after.tables.find((item) => item.id === "T07")?.x !== nextX) throw new Error("moved position was not stored");

  dashboard.close();
  guest.close();
  console.log(`LIVE OK order=${created.order.id} call=${call.call.id} T07.x=${nextX} public=${snap.publicUrl}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
