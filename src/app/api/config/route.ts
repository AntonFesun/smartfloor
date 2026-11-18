import { resolvePublicUrl } from "@/lib/public-url";
import { RESTAURANT_NAME } from "@/types";
import { ok } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return ok({ publicUrl: resolvePublicUrl(), restaurant: RESTAURANT_NAME });
}
