"use client";

import { AppShell } from "@/components/dashboard/app-shell";
import { FloorPlan } from "@/components/floor/floor-plan";
import { FloorCanvas } from "@/components/three/floor-canvas";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/store/ui-store";

export function DashboardScreen() {
  const view = useUiStore((state) => state.dashboardView);
  const setView = useUiStore((state) => state.setDashboardView);
  return (
    <AppShell
      toolbar={
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div>
            <div className="text-sm font-medium">Service floor</div>
            <div className="text-xs text-muted-foreground">Operations view. Move tables from the floor editor.</div>
          </div>
          <div className="flex gap-1 rounded-lg bg-secondary p-1">
            <Button size="sm" variant={view === "3d" ? "default" : "ghost"} onClick={() => setView("3d")}>
              3D
            </Button>
            <Button size="sm" variant={view === "2d" ? "default" : "ghost"} onClick={() => setView("2d")}>
              2D
            </Button>
          </div>
        </div>
      }
    >
      {view === "3d" ? <FloorCanvas /> : <FloorPlan editable={false} />}
    </AppShell>
  );
}
