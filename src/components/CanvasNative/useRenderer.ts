import { useCallback, RefObject } from 'react';
import { useCanvasStore } from '../../store/canvasStore';
import { SpatialGrid } from './spatialGrid';
import { Shape } from '../../types';
import { DragState, DrawState } from './types';

// ─── Drawing helpers ──────────────────────────────────────────────────────────

/**
 * Traces a rounded rectangle path on `ctx`. Does not stroke or fill —
 * call `ctx.fill()` / `ctx.stroke()` after.
 */
export function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y,     x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x,     y + h, radius);
  ctx.arcTo(x,     y + h, x,     y,     radius);
  ctx.arcTo(x,     y,     x + w, y,     radius);
  ctx.closePath();
}

/**
 * Draws a single shape (filled + stroked rounded rect).
 * `x`/`y` are passed explicitly so the dragging shape can be rendered at its
 * in-flight position without mutating the store.
 * `zoom` is passed so `lineWidth` stays constant in screen-space pixels
 * regardless of the current zoom level.
 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  x: number,
  y: number,
  zoom: number,
  isDragging = false
) {
  roundedRect(ctx, x, y, shape.width, shape.height, 8);
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = shape.color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = isDragging ? '#ffffff' : shape.color;
  ctx.lineWidth = (isDragging ? 3 : 2) / zoom;
  roundedRect(ctx, x, y, shape.width, shape.height, 8);
  ctx.stroke();
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Provides `render` and `scheduleRender` for the main canvas.
 *
 * `render` — synchronous, imperative redraw:
 *   1. Queries the spatial grid to find shapes inside the current viewport.
 *   2. Applies the pan/zoom transform via `ctx.translate` + `ctx.scale`.
 *   3. Draws all visible shapes in Map insertion order (= zIndex order, no sort).
 *   4. Draws the actively dragged shape last (on top) at its in-flight position.
 *   5. Draws the in-progress draw rectangle with a dashed preview stroke.
 *
 * `scheduleRender` — debounced via `requestAnimationFrame`. Multiple calls
 *   within the same frame collapse into a single paint, preventing redundant
 *   redraws during rapid pointer events.
 *
 * All state is read from refs at call time — the hook never causes a React
 * re-render and has no reactive subscriptions.
 */
export function useRenderer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  ctxRef: RefObject<CanvasRenderingContext2D | null>,
  canvasOffsetRef: RefObject<{ x: number; y: number }>,
  zoomRef: RefObject<number>,
  spatialGridRef: RefObject<SpatialGrid>,
  visibleIdsRef: RefObject<Set<string>>,
  dragRef: RefObject<DragState | null>,
  drawRef: RefObject<DrawState | null>,
  rafRef: RefObject<number | null>,
) {
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = ctxRef.current;
    if (!ctx) return;

    const { shapes: currentShapes } = useCanvasStore.getState();
    const { x: ox, y: oy } = canvasOffsetRef.current;
    const zoom = zoomRef.current;

    const viewMinX = -ox / zoom;
    const viewMinY = -oy / zoom;
    const viewMaxX = viewMinX + canvas.width / zoom;
    const viewMaxY = viewMinY + canvas.height / zoom;
    // Reuse persistent Set — no allocation per frame.
    spatialGridRef.current.query(viewMinX, viewMinY, viewMaxX, viewMaxY, visibleIdsRef.current);
    const visibleIds = visibleIdsRef.current;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(zoom, zoom);

    // Collect only visible shapes, sort by zIndex, then draw.
    // Iterating visibleIds (typically ~20) is cheaper than iterating the full
    // Map (potentially thousands) when most shapes are off-screen.
    const dragId = dragRef.current?.id;
    const visibleShapes = [...visibleIds]
      .map(id => currentShapes.get(id))
      .filter((s): s is Shape => !!s && s.id !== dragId)
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const shape of visibleShapes) {
      drawShape(ctx, shape, shape.x, shape.y, zoom);
    }

    if (dragRef.current) {
      const { id, startShapeX, startShapeY, lastDx, lastDy } = dragRef.current;
      const shape = currentShapes.get(id);
      if (shape) {
        drawShape(ctx, shape, startShapeX + lastDx, startShapeY + lastDy, zoom, true);
      }
    }

    if (drawRef.current) {
      const { pendingX, pendingY, pendingW, pendingH, color } = drawRef.current;
      if (pendingW > 0 && pendingH > 0) {
        roundedRect(ctx, pendingX, pendingY, pendingW, pendingH, 8);
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 / zoom;
        ctx.setLineDash([6 / zoom, 4 / zoom]);
        roundedRect(ctx, pendingX, pendingY, pendingW, pendingH, 8);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.restore();
  }, [canvasRef, ctxRef, canvasOffsetRef, zoomRef, spatialGridRef, visibleIdsRef, dragRef, drawRef]);

  const scheduleRender = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      render();
    });
  }, [render, rafRef]);

  return { render, scheduleRender };
}
