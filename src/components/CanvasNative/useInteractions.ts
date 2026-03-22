import { useCallback, useEffect, RefObject } from 'react';
import React from 'react';
import { useCanvasStore } from '../../store/canvasStore';
import { getRandomColor } from '../../utils/colors';
import { Shape } from '../../types';
import { DragState, DrawState } from './types';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

/**
 * Wires up all user input handlers for the canvas.
 *
 * Wheel — zooms around the cursor position by adjusting `canvasOffsetRef` and
 *   `zoomRef` so the point under the cursor stays fixed. Registered with
 *   `{ passive: false }` to allow `preventDefault`.
 *
 * MouseDown — branches on the current store mode:
 *   - `draw`: records draw start position into `drawRef`.
 *   - `pan` (default): if a shape is under the cursor, starts a drag (`dragRef`)
 *     and brings it to the top of the z-order; otherwise starts canvas pan (`panRef`).
 *
 * MouseMove — updates whichever interaction is active (`dragRef`, `drawRef`,
 *   or `panRef`) and schedules a render.
 *
 * MouseUp — commits the active interaction:
 *   - Drag: writes the final position to the store.
 *   - Draw: adds the new shape to the store (if large enough) and resets to pan mode.
 *   - Pan: clears the pan state.
 *
 * Touch (single finger) — mirrors pan behaviour for mobile.
 *
 * All store actions are retrieved via `useCanvasStore.getState()` — no
 * subscription, so this hook never causes a React re-render.
 */
export function useInteractions(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  canvasOffsetRef: RefObject<{ x: number; y: number }>,
  zoomRef: RefObject<number>,
  dragRef: RefObject<DragState | null>,
  panRef: RefObject<{ lastX: number; lastY: number } | null>,
  drawRef: RefObject<DrawState | null>,
  rafRef: RefObject<number | null>,
  render: () => void,
  scheduleRender: () => void,
  toWorld: (screenX: number, screenY: number) => { x: number; y: number },
  getShapeAt: (clientX: number, clientY: number) => Shape | null,
) {
  const { addShape, updateShape, setMode } = useCanvasStore.getState();

  // ─── Wheel (zoom) ───────────────────────────────────────────────────────────

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const oldZoom = zoomRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
    const ratio = newZoom / oldZoom;
    canvasOffsetRef.current.x = e.clientX - (e.clientX - canvasOffsetRef.current.x) * ratio;
    canvasOffsetRef.current.y = e.clientY - (e.clientY - canvasOffsetRef.current.y) * ratio;
    zoomRef.current = newZoom;
    scheduleRender();
  }, [zoomRef, canvasOffsetRef, scheduleRender]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [canvasRef, handleWheel]);

  // ─── Mouse ──────────────────────────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { mode: currentMode } = useCanvasStore.getState();
      const canvas = canvasRef.current;

      if (currentMode === 'draw') {
        const { x: startX, y: startY } = toWorld(e.clientX, e.clientY);
        const color = getRandomColor();
        drawRef.current = {
          id: `shape-${Date.now()}`,
          startX, startY, color,
          pendingX: startX, pendingY: startY, pendingW: 0, pendingH: 0,
        };
      } else {
        const shape = getShapeAt(e.clientX, e.clientY);
        if (shape) {
          dragRef.current = {
            id: shape.id,
            startCursorX: e.clientX,
            startCursorY: e.clientY,
            startShapeX: shape.x,
            startShapeY: shape.y,
            lastDx: 0,
            lastDy: 0,
          };
          if (canvas) canvas.style.cursor = 'grabbing';
          const { maxZIndex } = useCanvasStore.getState();
          updateShape(shape.id, { zIndex: maxZIndex + 1 });
        } else {
          panRef.current = { lastX: e.clientX, lastY: e.clientY };
          if (canvas) canvas.style.cursor = 'grabbing';
        }
      }
    },
    [canvasRef, drawRef, dragRef, panRef, toWorld, getShapeAt, updateShape]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (dragRef.current) {
        const zoom = zoomRef.current;
        dragRef.current.lastDx = (e.clientX - dragRef.current.startCursorX) / zoom;
        dragRef.current.lastDy = (e.clientY - dragRef.current.startCursorY) / zoom;
        scheduleRender();
      } else if (drawRef.current) {
        const { startX, startY } = drawRef.current;
        const { x: wx, y: wy } = toWorld(e.clientX, e.clientY);
        drawRef.current.pendingX = Math.min(wx, startX);
        drawRef.current.pendingY = Math.min(wy, startY);
        drawRef.current.pendingW = Math.abs(wx - startX);
        drawRef.current.pendingH = Math.abs(wy - startY);
        scheduleRender();
      } else if (panRef.current) {
        canvasOffsetRef.current.x += e.clientX - panRef.current.lastX;
        canvasOffsetRef.current.y += e.clientY - panRef.current.lastY;
        panRef.current.lastX = e.clientX;
        panRef.current.lastY = e.clientY;
        scheduleRender();
      }
    },
    [dragRef, drawRef, panRef, zoomRef, canvasOffsetRef, scheduleRender, toWorld]
  );

  const handleMouseUp = useCallback(() => {
    if (dragRef.current) {
      const { id, startShapeX, startShapeY, lastDx, lastDy } = dragRef.current;
      updateShape(id, { x: startShapeX + lastDx, y: startShapeY + lastDy });
      dragRef.current = null;
    }

    if (drawRef.current) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const { id, color, pendingX: x, pendingY: y, pendingW: w, pendingH: h } = drawRef.current;
      if (w > 5 && h > 5) {
        const { maxZIndex } = useCanvasStore.getState();
        addShape({ id, type: 'rectangle', x, y, width: w, height: h, color, zIndex: maxZIndex + 1 });
      }
      drawRef.current = null;
      setMode('pan');
      render();
    }

    if (panRef.current) {
      panRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = 'grab';
    }
  }, [canvasRef, dragRef, drawRef, panRef, rafRef, addShape, updateShape, setMode, render]);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // ─── Touch ──────────────────────────────────────────────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1) {
      panRef.current = { lastX: e.touches[0].clientX, lastY: e.touches[0].clientY };
    }
  }, [panRef]);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (e.touches.length === 1 && panRef.current) {
        canvasOffsetRef.current.x += e.touches[0].clientX - panRef.current.lastX;
        canvasOffsetRef.current.y += e.touches[0].clientY - panRef.current.lastY;
        panRef.current.lastX = e.touches[0].clientX;
        panRef.current.lastY = e.touches[0].clientY;
        scheduleRender();
      }
    },
    [panRef, canvasOffsetRef, scheduleRender]
  );

  const handleTouchEnd = useCallback(() => {
    panRef.current = null;
  }, [panRef]);

  return { handleMouseDown, handleMouseMove, handleMouseUp, handleTouchStart, handleTouchMove, handleTouchEnd };
}
