import { create } from 'zustand';
import { Shape } from '../types';

export type Mode = 'pan' | 'draw';

interface CanvasState {
  // Ordered array — used for rendering iteration and React subscriptions.
  shapes: Shape[];
  // O(1) lookup map — used wherever a single shape is needed by id.
  shapesById: Record<string, Shape>;
  // Tracks current maximum zIndex — avoids an O(n) reduce on every interaction.
  maxZIndex: number;
  mode: Mode;

  addShape: (shape: Shape) => void;
  updateShape: (id: string, updates: Partial<Shape>) => void;
  setMode: (mode: Mode) => void;
  resetCanvas: () => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  shapes: [],
  shapesById: {},
  maxZIndex: 0,
  mode: 'pan',

  addShape: (shape) =>
    set((state) => ({
      shapes: [...state.shapes, shape],
      shapesById: { ...state.shapesById, [shape.id]: shape },
      maxZIndex: Math.max(state.maxZIndex, shape.zIndex),
    })),

  updateShape: (id, updates) =>
    set((state) => {
      const existing = state.shapesById[id];
      if (!existing) return state;
      const updated = { ...existing, ...updates };
      return {
        shapesById: { ...state.shapesById, [id]: updated },
        shapes: state.shapes.map((s) => (s.id === id ? updated : s)),
        maxZIndex:
          updates.zIndex !== undefined
            ? Math.max(state.maxZIndex, updates.zIndex)
            : state.maxZIndex,
      };
    }),

  setMode: (mode) => set({ mode }),

  resetCanvas: () => set({ shapes: [], shapesById: {}, maxZIndex: 0 }),
}));
