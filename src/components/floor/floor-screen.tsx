"use client";

import { AppShell } from "@/components/dashboard/app-shell";
import { EditorToolbar } from "@/components/floor/editor-toolbar";
import { FloorPlan } from "@/components/floor/floor-plan";
import { FloorCanvas } from "@/components/three/floor-canvas";
import { useReplayReadOnly } from "@/store/replay-store";
import { useUiStore } from "@/store/ui-store";

export function FloorScreen() {
  const editMode = useUiStore((state) => state.editMode);
  const readOnly = useReplayReadOnly();
  return (
    <AppShell toolbar={<EditorToolbar />}>
      <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-2">
        <FloorPlan editable={editMode && !readOnly} />
        <FloorCanvas />
      </div>
    </AppShell>
  );
}
