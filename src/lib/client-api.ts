export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}
