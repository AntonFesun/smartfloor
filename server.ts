import fs from "node:fs";
import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { Server } from "socket.io";
import { getDb } from "./src/lib/db";
import { resolvePublicUrl } from "./src/lib/public-url";
import { getSnapshot } from "./src/lib/repository";
import { runtimeContext } from "./src/lib/runtime";
import { setIo } from "./src/server/io";

function loadEnvFile(file = ".env"): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = Number(process.env.PORT || 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  getDb();
  const server = createServer((req, res) => {
    const parsed = parse(req.url || "", true);
    if (parsed.pathname?.startsWith("/socket.io")) return;
    handle(req, res, parsed).catch((error: unknown) => {
      console.error(error);
      res.statusCode = 500;
      res.end("internal error");
    });
  });

  const io = new Server(server, {
    path: "/socket.io",
    cors: { origin: true, credentials: true },
  });
  setIo(io);
  io.on("connection", (socket) => {
    socket.emit("snapshot", getSnapshot(getDb(), runtimeContext()));
  });

  server.listen(port, hostname, () => {
    const publicUrl = resolvePublicUrl();
    console.log(`Atelier SmartFloor listening on http://${hostname}:${port}`);
    console.log(`APP_PUBLIC_URL ${publicUrl}`);
  });
});
