import { useCallback, RefObject } from 'react';
import { useCanvasStore } from '../../store/canvasStore';
import { SpatialGrid } from './spatialGrid';
import { Shape } from '../../types';

/**
 * Provides coordinate conversion and shape hit-testing against the spatial grid.
 *
 * `toWorld(screenX, screenY)` — converts a screen-space point (e.g. from a
 *   mouse event) to world-space coordinates by reversing the pan/zoom transform.
 *
 * `getShapeAt(clientX, clientY)` — returns the topmost shape under the cursor,
 *   or null if none. Uses a two-phase test:
 *   1. Coarse: queries the spatial grid for candidate shape IDs in the cursor's cell.
 *   2. Fine: exact AABB containment check on each candidate.
 *   Returns the candidate with the highest `zIndex` (i.e. visually on top).
 */
export function useHitTest(
  canvasOffsetRef: RefObject<{ x: number; y: number }>,
  zoomRef: RefObject<number>,
  spatialGridRef: RefObject<SpatialGrid>,
) {
  const toWorld = useCallback((screenX: number, screenY: number) => {
    const { x: ox, y: oy } = canvasOffsetRef.current;
    const zoom = zoomRef.current;
    return { x: (screenX - ox) / zoom, y: (screenY - oy) / zoom };
  }, [canvasOffsetRef, zoomRef]);

  // Query the grid at cursor world position, then exact AABB test on candidates.
  // Returns the topmost (highest zIndex) shape under the cursor, or null.
  const getShapeAt = useCallback((clientX: number, clientY: number): Shape | null => {
    const { x: wx, y: wy } = toWorld(clientX, clientY);
    const { shapes } = useCanvasStore.getState();

    const candidates = new Set<string>();
    spatialGridRef.current.query(wx, wy, wx, wy, candidates);

    let topShape: Shape | null = null;
    for (const id of candidates) {
      const shape = shapes.get(id);
      if (!shape) continue;
      if (wx >= shape.x && wx <= shape.x + shape.width &&
          wy >= shape.y && wy <= shape.y + shape.height) {
        if (!topShape || shape.zIndex > topShape.zIndex) {
          topShape = shape;
        }
      }
    }
    return topShape;
  }, [toWorld, spatialGridRef]);

  return { toWorld, getShapeAt };
}
