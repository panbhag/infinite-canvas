import { Shape } from '../types';

// World-space cell size. At zoom=1 the viewport covers roughly 4×2 cells.
// Smaller = fewer shapes per cell but more cells to query when zoomed out.
// Larger = fewer cells to query but more shapes per cell.
export const CELL_SIZE = 500;

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

function getCellRange(x: number, y: number, w: number, h: number) {
  return {
    minCx: Math.floor(x / CELL_SIZE),
    maxCx: Math.floor((x + w) / CELL_SIZE),
    minCy: Math.floor(y / CELL_SIZE),
    maxCy: Math.floor((y + h) / CELL_SIZE),
  };
}

/**
 * Sparse spatial grid for fast viewport queries and point hit tests.
 *
 * Cells are created lazily — only when a shape is inserted into them.
 * Empty cells are deleted on removal to keep memory proportional to shape count.
 *
 * A shape registers itself in every cell its AABB overlaps, so a query over
 * any region returns all shapes that could intersect that region.
 */
export class SpatialGrid {
  // cellKey → Set of shapeIds in that cell
  private grid = new Map<string, Set<string>>();

  insert(shape: Shape): void {
    const { minCx, maxCx, minCy, maxCy } = getCellRange(shape.x, shape.y, shape.width, shape.height);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = cellKey(cx, cy);
        if (!this.grid.has(key)) this.grid.set(key, new Set());
        this.grid.get(key)!.add(shape.id);
      }
    }
  }

  remove(shape: Shape): void {
    const { minCx, maxCx, minCy, maxCy } = getCellRange(shape.x, shape.y, shape.width, shape.height);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = cellKey(cx, cy);
        const cell = this.grid.get(key);
        if (!cell) continue;
        cell.delete(shape.id);
        if (cell.size === 0) this.grid.delete(key);  // don't keep empty cells
      }
    }
  }

  /**
   * Populates `result` with shapeIds whose registered cells overlap the given world-space rect.
   * Accepts an existing Set to reuse — caller should not clear it beforehand, this method does it.
   * May include shapes slightly outside the rect (cell granularity) — caller does exact test if needed.
   */
  query(minX: number, minY: number, maxX: number, maxY: number, result: Set<string>): void {
    result.clear();
    const minCx = Math.floor(minX / CELL_SIZE);
    const maxCx = Math.floor(maxX / CELL_SIZE);
    const minCy = Math.floor(minY / CELL_SIZE);
    const maxCy = Math.floor(maxY / CELL_SIZE);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const cell = this.grid.get(cellKey(cx, cy));
        if (cell) cell.forEach(id => result.add(id));
      }
    }
  }

  clear(): void {
    this.grid.clear();
  }
}
