"use client";

import { useMemo, useState } from "react";
import { Bell, Minus, Plus, ShoppingBag, Wifi, WifiOff } from "lucide-react";
import { ORDER_LABEL } from "@/domain/labels";
import { isActiveWaiter } from "@/domain/waiter";
import { Button } from "@/components/ui/button";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/lib/client-api";
import { formatUAH } from "@/lib/format";
import { MENU_CATEGORIES, type MenuCategory, type MenuItem, type OrderStatus } from "@/types";

const STEPS: OrderStatus[] = ["NEW", "ACCEPTED", "PREPARING", "READY", "SERVED"];

export function GuestScreen({ tableId }: { tableId: string }) {
  const { ready, error, connected, tables, menu, orders, waiterCalls, restaurantName, now } = useRealtime();
  const [category, setCategory] = useState<MenuCategory | "All">("All");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<"menu" | "orders" | "cart">("menu");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const table = tables.find((item) => item.id === tableId) ?? null;
  const serviceCutoff = now - 10 * 60 * 60 * 1000;
  const tableOrders = orders.filter(
    (order) => order.tableId === tableId && ((order.status !== "SERVED" && order.status !== "CANCELLED") || Date.parse(order.createdAt) >= serviceCutoff),
  );
  const call = waiterCalls.find((item) => item.tableId === tableId && isActiveWaiter(item.status));
  const items = useMemo(() => menu.filter((item) => category === "All" || item.category === category), [menu, category]);
  const cartLines = menu.filter((item) => (cart[item.id] ?? 0) > 0);
  const cartCount = cartLines.reduce((sum, item) => sum + (cart[item.id] ?? 0), 0);
  const cartTotal = cartLines.reduce((sum, item) => sum + item.price * (cart[item.id] ?? 0), 0);

  function setQty(item: MenuItem, qty: number) {
    setCart((current) => {
      const next = { ...current };
      if (qty <= 0) delete next[item.id];
      else next[item.id] = Math.min(20, qty);
      return next;
    });
  }

  async function placeOrder() {
    if (cartLines.length === 0) return;
    setPending(true);
    setNotice(null);
    try {
      await api("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          tableId,
          items: cartLines.map((item) => ({ menuItemId: item.id, qty: cart[item.id] })),
        }),
      });
      setCart({});
      setTab("orders");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not place the order");
    } finally {
      setPending(false);
    }
  }

  async function callWaiter() {
    setPending(true);
    setNotice(null);
    try {
      await api("/api/waiter", { method: "POST", body: JSON.stringify({ tableId }) });
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not call a waiter");
    } finally {
      setPending(false);
    }
  }

  if (!ready) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">{error ?? "Opening the menu…"}</p>
      </main>
    );
  }

  if (!table) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <p className="text-xs uppercase tracking-[0.2em] text-primary">{restaurantName}</p>
        <h1 className="mt-2 text-2xl font-semibold">Table {tableId} is not on the floor</h1>
        <p className="mt-2 text-sm text-muted-foreground">Ask the host for a new QR code.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-[#0d1016]">
      <header className="sticky top-0 z-10 border-b bg-[#0d1016]/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-primary">{restaurantName}</div>
            <h1 className="text-lg font-semibold">
              {table.id}
              <span className="ml-2 text-sm font-normal text-muted-foreground">{table.zone}</span>
            </h1>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {connected ? <Wifi className="h-3.5 w-3.5 text-emerald-400" /> : <WifiOff className="h-3.5 w-3.5" />}
            {table.occupiedSeatCount}/{table.capacity}
          </div>
        </div>
        {call && (
          <div className="mt-2 rounded-md border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-sm">
            {call.status === "ACTIVE" ? "Calling a waiter…" : "A waiter is on the way."}
          </div>
        )}
      </header>

      <div className="flex gap-2 px-4 py-3">
        {(["menu", "orders", "cart"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-full px-3 py-1 text-sm ${tab === value ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}
          >
            {value === "menu" ? "Menu" : value === "orders" ? `Orders (${tableOrders.length})` : `Cart (${cartCount})`}
          </button>
        ))}
      </div>

      {tab === "menu" && (
        <>
          <div className="flex gap-2 overflow-x-auto px-4 pb-2">
            <Chip active={category === "All"} onClick={() => setCategory("All")} label="All" />
            {MENU_CATEGORIES.map((item) => (
              <Chip key={item} active={category === item} onClick={() => setCategory(item)} label={item} />
            ))}
          </div>
          <div className="flex-1 space-y-2 px-4 pb-28">
            {items.map((item) => (
              <article key={item.id} className="flex items-center justify-between gap-3 rounded-xl border bg-card px-3 py-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.category}</div>
                  <h2 className="font-medium">{item.name}</h2>
                  <p className="text-xs text-muted-foreground">{item.description}</p>
                  <div className="mt-1 text-sm text-primary">{formatUAH(item.price)}</div>
                </div>
                {(cart[item.id] ?? 0) > 0 ? (
                  <Qty value={cart[item.id] ?? 0} onChange={(qty) => setQty(item, qty)} />
                ) : (
                  <Button size="icon" onClick={() => setQty(item, 1)} aria-label={`Add ${item.name}`}>
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </article>
            ))}
          </div>
        </>
      )}

      {tab === "orders" && (
        <div className="flex-1 space-y-3 px-4 pb-28">
          {tableOrders.length === 0 && <p className="text-sm text-muted-foreground">No orders yet. Coffee and pizza are on the menu.</p>}
          {tableOrders.map((order) => (
            <article key={order.id} className="rounded-xl border bg-card p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{formatUAH(order.total)}</span>
                <span className="text-xs text-primary">{ORDER_LABEL[order.status]}</span>
              </div>
              <ul className="mt-2 text-sm text-muted-foreground">
                {order.items.map((item) => (
                  <li key={item.id}>
                    {item.qty} × {item.name}
                  </li>
                ))}
              </ul>
              {order.status !== "CANCELLED" && (
                <div className="mt-3 grid grid-cols-5 gap-1">
                  {STEPS.map((step, index) => {
                    const current = STEPS.indexOf(order.status);
                    const done = current >= index && order.status !== "CANCELLED";
                    return <span key={step} className={`h-1.5 rounded-full ${done ? "bg-primary" : "bg-secondary"}`} />;
                  })}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {tab === "cart" && (
        <div className="flex-1 space-y-3 px-4 pb-28">
          {cartLines.length === 0 && <p className="text-sm text-muted-foreground">Your cart is empty.</p>}
          {cartLines.map((item) => (
            <div key={item.id} className="flex items-center justify-between rounded-xl border bg-card px-3 py-3">
              <div>
                <div className="font-medium">{item.name}</div>
                <div className="text-sm text-primary">{formatUAH(item.price * (cart[item.id] ?? 0))}</div>
              </div>
              <Qty value={cart[item.id] ?? 0} onChange={(qty) => setQty(item, qty)} />
            </div>
          ))}
          {notice && <p className="text-sm text-red-300">{notice}</p>}
          <Button className="h-12 w-full" disabled={pending || cartLines.length === 0} onClick={() => void placeOrder()}>
            Place order · {formatUAH(cartTotal)}
          </Button>
        </div>
      )}

      <div className="fixed bottom-0 left-1/2 z-20 flex w-full max-w-md -translate-x-1/2 gap-2 border-t bg-[#0d1016]/95 p-3 backdrop-blur">
        <Button variant="secondary" className="flex-1" disabled={pending || Boolean(call)} onClick={() => void callWaiter()}>
          <Bell className="h-4 w-4" />
          {call ? "Waiter called" : "Call waiter"}
        </Button>
        <Button className="flex-1" onClick={() => setTab("cart")}>
          <ShoppingBag className="h-4 w-4" />
          {cartCount > 0 ? formatUAH(cartTotal) : "Cart"}
        </Button>
      </div>
    </main>
  );
}

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`shrink-0 rounded-full px-3 py-1 text-xs ${active ? "bg-white text-black" : "bg-secondary text-muted-foreground"}`}>
      {label}
    </button>
  );
}

function Qty({ value, onChange }: { value: number; onChange: (qty: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" className="grid h-8 w-8 place-items-center rounded-md bg-secondary" onClick={() => onChange(value - 1)} aria-label="Decrease">
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-4 text-center text-sm">{value}</span>
      <button type="button" className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground" onClick={() => onChange(value + 1)} aria-label="Increase">
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
