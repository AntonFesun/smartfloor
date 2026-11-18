import { create } from "zustand";
import type { ReplayMode } from "@/domain/replay";

export const REPLAY_SPEEDS = [1, 5, 20, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

interface ReplayState {
  mode: ReplayMode;
  sequence: number;
  playing: boolean;
  speed: ReplaySpeed;
  enter: (sequence: number) => void;
  scrub: (sequence: number) => void;
  step: (delta: number, max: number) => void;
  setPlaying: (playing: boolean, max: number) => void;
  setSpeed: (speed: ReplaySpeed) => void;
  tick: (max: number) => void;
  exit: () => void;
}

export const useReplayStore = create<ReplayState>((set) => ({
  mode: "LIVE",
  sequence: 0,
  playing: false,
  speed: 1,
  enter: (sequence) => set({ mode: "REPLAY", sequence, playing: false }),
  scrub: (sequence) => set({ sequence: Math.max(0, sequence), playing: false }),
  step: (delta, max) =>
    set((state) => ({
      playing: false,
      sequence: Math.min(max, Math.max(0, state.sequence + delta)),
    })),
  setPlaying: (playing, max) =>
    set((state) => {
      if (!playing) return { playing: false };
      return { playing: true, sequence: state.sequence >= max ? 0 : state.sequence };
    }),
  setSpeed: (speed) => set({ speed }),
  tick: (max) =>
    set((state) => {
      if (!state.playing) return state;
      if (state.sequence >= max) return { playing: false };
      return { sequence: state.sequence + 1 };
    }),
  exit: () => set({ mode: "LIVE", playing: false }),
}));

export function useReplayReadOnly(): boolean {
  return useReplayStore((state) => state.mode === "REPLAY");
}
