# CHOICE SmartFloor

Live digital twin and service floor for **Atelier Restaurant**. Two browsers share one Node process: Next.js for the UI, Socket.IO for broadcasts, and SQLite for the floor, orders, waiter calls, and service events.

Table status, order state, and waiter calls are independent. A table can be occupied, have an open check, and a waiter call at the same time.

## Architecture

- `server.ts` binds `0.0.0.0` and serves Next.js plus Socket.IO on the same origin.
- `src/domain` holds transitions, layout collision, and metrics. Metrics are derived only from event timestamps.
- `src/lib/repository.ts` is the SQLite write path. Operational rows and the append-only `restaurant_events` journal commit in one transaction. Socket.IO broadcasts, including `restaurant.event.created`, run only after that commit.
- The journal does not replace the live tables and does not invent events for rows that already existed. Demo reset keeps journal rows. Send `Idempotency-Key` to make a retried mutation write the event once.
- `projectRestaurantState` rebuilds tables, orders, and waiter calls from a baseline snapshot plus later journal events. Sequence is the order when timestamps tie. `getEvents` filters by table, waiter, zone, type, and a time range (`last_hour`, `today`, `yesterday`, `last_7_days`, `custom`) in `Europe/Kyiv` unless given instants.
- `/kitchen` splits a new order into station tickets. Pizza goes to Hot Kitchen, coffee (including cappuccino) to Bar, soft drinks get no ticket. A ticket moves New → accept → prep → item done → ready. The parent order becomes READY only when every required ticket is ready, and that transition creates one waiter delivery task.
- `/waiters` keeps shifts and zone assignments. A guest call, and a kitchen delivery, assign the on-duty waiter in that zone with the fewest active tasks. Equal load picks the smaller waiter id. If nobody is on duty the task stays unassigned and the dashboard shows an alert. Resolving the call completes its task. Reassignment is manual and broadcast.
- `/host` ranks tables for a party, time, duration, and optional zone with no randomness. A group is only adjacent tables in the same zone. Confirm rechecks the booking inside a transaction. Each table keeps its id and guest QR. A group dissolves only when it has no open orders, calls, or a live reservation.
- Replay uses the journal and `replayAt` (a single `projectRestaurantState` call for the chosen sequence). The same 2D plan and 3D room show occupancy, orders, active waiter calls, and recorded table positions. LIVE and REPLAY are the modes. Replay does not write. Return to Live fetches a fresh snapshot. Tables and checks that predate the journal stay out of that history.
- The service heatmap uses one journal aggregator, `getServiceHeatmap`, for both the 2D plan and the 3D room. `getTableMetrics`, `getZoneMetrics`, and `getRestaurantMetrics` share that pass. A table with no samples says No data. Call and order counts are activity. The selected metric stays put when the view switches between 2D and 3D. `GET /api/analytics/heatmap` returns the same numbers.
- The revenue map reads persisted `payments`. Three served demo checks have payment rows; the served check on T05 does not, so it is not collected revenue. Cancelled orders are refused. A payment stays on the ordering table when that table is grouped. Sales per occupied hour is N/A when occupied minutes are zero. `GET /api/analytics/revenue` uses the same ranges as the heatmap.
- `/simulator` runs the discrete-event engine in the browser against the current layout. Play, pause, step, and reset stay on that engine. A/B uses `runABComparison`. Scenarios are stored only in `simulation_scenarios`. Simulated events are not written to the journal, kitchen, or waiter alerts.
- Zustand stores selection, camera, and edit mode only. It is not a sync channel.
- `/dashboard` is the operations view (3D or read-only 2D). `/floor` is the editor plus a live 3D view. `/guest/[tableId]` is the guest menu.

Service durations:

- submit → accept
- accept → ready (prep)
- ready → served
- waiter called → acknowledged
- occupancy: guests seated → table cleared
- turnover: one seating → the next seating on the same table

If a pair does not exist yet, the average is empty (`—`). Delay chips use `LONG_*_MS` thresholds.

## Install

```bash
cd choice-smartfloor
npm install
cp .env.example .env
```

Set `APP_PUBLIC_URL` to the origin other devices can open, for example `http://192.168.1.20:3000`. When it is unset, the server uses the first non-internal IPv4 and `PORT` (default 3000). QR codes never prefer localhost over a LAN address.

The server that is running now reports `APP_PUBLIC_URL=http://172.30.0.2:3000`. Phones and a second browser must use that origin, not `localhost`.

## Start

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

Both commands listen on `0.0.0.0:$PORT`. With the current `APP_PUBLIC_URL`, open:

- Dashboard: `http://172.30.0.2:3000/dashboard`
- Floor editor: `http://172.30.0.2:3000/floor`
- Kitchen: `http://172.30.0.2:3000/kitchen`
- Waiters: `http://172.30.0.2:3000/waiters`
- Host: `http://172.30.0.2:3000/host`
- Simulator: `http://172.30.0.2:3000/simulator`
- Guest for table 7: `http://172.30.0.2:3000/guest/T07`

On another machine, replace the host with the `APP_PUBLIC_URL` printed at startup.

## Seed and reset

The database `data/atelier.db` is created and seeded on first start: 3 zones, 16 tables, 19 menu items in UAH, served and in-progress checks, and one active waiter call on T14.

- In the app, **Reset demo** restores that seed and broadcasts `demo.reset`.
- From the shell, stop isn't required for the script, but prefer the in-app button while the server is running: `npm run reset` rewrites the same file.

## Demo script

These eight scenes are the phase 2 acceptance pass. Do them against the running server. The guest URL is `APP_PUBLIC_URL/guest/T07`.

1. **Guest order.** On `/guest/T07`, add **Margherita** and **Cappuccino** and place the order. The check is ₴335. A second dashboard session receives it without a refresh. The guest **Orders** tab shows the same check.
2. **Kitchen.** `/kitchen` opens two tickets: Margherita on **Hot Kitchen**, Cappuccino on **Bar**. Accept, start, mark each item done, then mark the ticket ready. The parent order becomes **Ready** only after both tickets are ready, and one delivery task appears.
3. **Waiter.** The delivery task is assigned to the on-duty Main Hall waiter with the lighter load. On `/waiters`, reassign it. The other session shows the new waiter. Resolving a guest call completes that call's task.
4. **Heatmap.** On the dashboard, choose **Service heatmap** and **Orders**. T07 shows a real observation count. A table with no journal orders stays **No data**. Switching **2D** keeps the metric.
5. **Time machine.** Choose **Replay**. Scrub to the sequence before this order: it is absent. Step onto `ORDER_CREATED`: it appears as **New**. Step onto `ORDER_READY`: that same check is **Ready**. **Return to Live** reloads the snapshot and does not write the replay back.
6. **Payment and revenue.** Choose **Revenue map**. Recorded sales are the demo payments (T01 ₴330, T06 ₴355, T03 ₴715 over the last 7 days, ₴1400 together). The new unpaid T07 check and the served-but-unpaid T05 check stay **N/A**. A payment is counted once, on the ordering table.
7. **Party of six.** On `/host`, ask for 6 guests about three hours ahead. The top suggestion is a single table that seats 6, with the reason spelled out. Confirm it. A second booking of that table for the same time is rejected.
8. **Simulator.** Open `/simulator`. Keep one seed and compare 3 waiters with 5. The rows, diffs, and percent changes come from the engine (`n/a` when the baseline is 0). Play, pause, step, and the speed buttons only move the virtual clock. Afterwards the live orders and `restaurant_events` journal are unchanged.

`npm test` covers the domain, journal, kitchen, waiters, seating, replay, analytics, revenue, and the simulation isolation check. `npm run test:simulation` runs the engine suite. `npm run exercise` drives the guest order, waiter call, and layout move against a running server with two sockets.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server, LAN bind |
| `npm run build` | Next.js production build |
| `npm start` | Production server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | App tests, including simulation isolation |
| `npm run test:simulation` | Engine suite (determinism, A/B, isolation from React and the database) |
| `npm run reset` | Restore seed data |
| `npm run exercise` | Live order, waiter, and layout check |
