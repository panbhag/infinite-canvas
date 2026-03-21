import { create } from 'zustand';
import { Shape } from '../types';

export type Mode = 'pan' | 'draw';

interface CanvasState {
  // Map<id, Shape> — insertion order = zIndex order, so iteration is always sorted.
  // Serves as both the render list and the O(1) id lookup (replaces a separate shapesById).
  shapes: Map<string, Shape>;
  // Tracks current maximum zIndex — avoids an O(n) reduce on every interaction.
  maxZIndex: number;
  mode: Mode;

  addShape: (shape: Shape) => void;
  updateShape: (id: string, updates: Partial<Shape>) => void;
  setMode: (mode: Mode) => void;
  resetCanvas: () => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  shapes: new Map(),
  maxZIndex: 0,
  mode: 'pan',

  addShape: (shape) =>
    set((state) => {
      const shapes = new Map(state.shapes);
      shapes.set(shape.id, shape);
      return { shapes, maxZIndex: Math.max(state.maxZIndex, shape.zIndex) };
    }),

  updateShape: (id, updates) =>
    set((state) => {
      const existing = state.shapes.get(id);
      if (!existing) return state;
      const updated = { ...existing, ...updates };
      const shapes = new Map(state.shapes);
      if (updates.zIndex !== undefined) {
        // Delete + re-insert moves the entry to the end of the Map's insertion order,
        // keeping the Map sorted by zIndex without an explicit sort.
        shapes.delete(id);
      }
      shapes.set(id, updated);
      return {
        shapes,
        maxZIndex: updates.zIndex !== undefined
          ? Math.max(state.maxZIndex, updates.zIndex)
          : state.maxZIndex,
      };
    }),

  setMode: (mode) => set({ mode }),

  resetCanvas: () => set({ shapes: new Map(), maxZIndex: 0 }),
}));
