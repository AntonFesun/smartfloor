import os from "node:os";

export function resolvePublicUrl(options?: {
  env?: Record<string, string | undefined>;
  port?: string;
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string {
  const env = options?.env ?? process.env;
  const explicit = env.APP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const port = options?.port ?? env.PORT ?? "3000";
  const interfaces = options?.interfaces ?? os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      const isIpv4 = family === "IPv4" || family === 4;
      if (isIpv4 && !entry.internal) return `http://${entry.address}:${port}`;
    }
  }
  return `http://127.0.0.1:${port}`;
}
