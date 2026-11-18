import { create } from "zustand";

export type CameraPreset = "iso" | "top" | "focus";

interface UiState {
  selectedTableId: string | null;
  dashboardView: "3d" | "2d";
  editMode: boolean;
  cameraPreset: CameraPreset;
  cameraNonce: number;
  selectTable: (id: string | null) => void;
  setDashboardView: (view: "3d" | "2d") => void;
  setEditMode: (editMode: boolean) => void;
  bumpCamera: (preset: CameraPreset) => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedTableId: "T07",
  dashboardView: "3d",
  editMode: false,
  cameraPreset: "iso",
  cameraNonce: 0,
  selectTable: (selectedTableId) => set({ selectedTableId }),
  setDashboardView: (dashboardView) => set({ dashboardView }),
  setEditMode: (editMode) => set({ editMode }),
  bumpCamera: (cameraPreset) => set((state) => ({ cameraPreset, cameraNonce: state.cameraNonce + 1 })),
}));
