import { resolvePublicUrl } from "@/lib/public-url";
import { readThresholds } from "@/lib/thresholds";

export function runtimeContext(now = Date.now()) {
  return {
    now,
    publicUrl: resolvePublicUrl(),
    thresholds: readThresholds(),
  };
}
