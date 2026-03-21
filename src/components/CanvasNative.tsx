import { useRef, useEffect, useCallback } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { getRandomColor } from '../utils/colors';
import { Shape } from '../types';
import Minimap from './Minimap';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

// ─── Drawing helpers ─────────────────────────────────────────────────────────

function roundedRect(
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

// zoom is passed so lineWidth stays constant in screen-space pixels regardless of zoom level
function drawShape(
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
  ctx.lineWidth = (isDragging ? 3 : 2) / zoom;   // counteract ctx.scale so width is always ~2px on screen
  roundedRect(ctx, x, y, shape.width, shape.height, 8);
  ctx.stroke();
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CanvasNative() {
  const { addShape, updateShape, setMode } = useCanvasStore();
  const shapes = useCanvasStore((state) => state.shapes);
  const mode = useCanvasStore((state) => state.mode);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasOffsetRef = useRef({ x: -window.innerWidth, y: -window.innerHeight });
  const zoomRef = useRef(1);

  // ─── Per-interaction refs ─────────────────────────────────────────────────

  const dragRef = useRef<{
    id: string;
    startCursorX: number;
    startCursorY: number;
    startShapeX: number;
    startShapeY: number;
    lastDx: number;  // world-space delta
    lastDy: number;
  } | null>(null);

  const panRef = useRef<{ lastX: number; lastY: number } | null>(null);

  const drawRef = useRef<{
    id: string;
    startX: number;   // world-space
    startY: number;
    color: string;
    pendingX: number;
    pendingY: number;
    pendingW: number;
    pendingH: number;
  } | null>(null);

  const rafRef = useRef<number | null>(null);

  // ─── Coordinate helpers ───────────────────────────────────────────────────

  /** Convert screen (client) coordinates to world coordinates. */
  const toWorld = useCallback((screenX: number, screenY: number) => {
    const { x: ox, y: oy } = canvasOffsetRef.current;
    const zoom = zoomRef.current;
    return {
      x: (screenX - ox) / zoom,
      y: (screenY - oy) / zoom,
    };
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { shapes: currentShapes, shapesById } = useCanvasStore.getState();
    const { x: ox, y: oy } = canvasOffsetRef.current;
    const zoom = zoomRef.current;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(zoom, zoom);  // world → screen: all subsequent draws are in world coords

    // Draw all shapes sorted by zIndex, skipping the one being dragged
    const sorted = [...currentShapes].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
    for (const shape of sorted) {
      if (dragRef.current?.id === shape.id) continue;
      drawShape(ctx, shape, shape.x, shape.y, zoom);
    }

    // Draw dragged shape on top with live world-space offset
    if (dragRef.current) {
      const { id, startShapeX, startShapeY, lastDx, lastDy } = dragRef.current;
      const shape = shapesById[id];
      if (shape) {
        drawShape(ctx, shape, startShapeX + lastDx, startShapeY + lastDy, zoom, true);
      }
    }

    // Draw preview rect while in draw interaction
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
  }, []);

  /** Schedule at most one render per display frame. */
  const scheduleRender = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      render();
    });
  }, [render]);

  // ─── Canvas sizing ────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      render();
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [render]);

  // Re-render when shapes are committed to the store
  useEffect(() => {
    render();
  }, [shapes, render]);

  // Sync cursor with mode
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = mode === 'draw' ? 'crosshair' : 'grab';
  }, [mode]);

  // ─── Hit testing ──────────────────────────────────────────────────────────

  const getShapeAt = useCallback((clientX: number, clientY: number): Shape | null => {
    const { shapes: currentShapes } = useCanvasStore.getState();
    const { x: wx, y: wy } = toWorld(clientX, clientY);

    // Topmost first
    const sorted = [...currentShapes].sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0));
    for (const shape of sorted) {
      if (wx >= shape.x && wx <= shape.x + shape.width &&
          wy >= shape.y && wy <= shape.y + shape.height) {
        return shape;
      }
    }
    return null;
  }, [toWorld]);

  // ─── Wheel (zoom) ─────────────────────────────────────────────────────────

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();

    const oldZoom = zoomRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));

    // Keep the world point under the cursor stationary:
    // screen = offset + world * zoom  →  newOffset = cursor - world * newZoom
    //                                             = cursor - (cursor - offset) * (newZoom / oldZoom)
    const ratio = newZoom / oldZoom;
    canvasOffsetRef.current.x = e.clientX - (e.clientX - canvasOffsetRef.current.x) * ratio;
    canvasOffsetRef.current.y = e.clientY - (e.clientY - canvasOffsetRef.current.y) * ratio;

    zoomRef.current = newZoom;
    scheduleRender();
  }, [scheduleRender]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // passive: false so we can call preventDefault and block browser page-zoom
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // ─── Mouse handlers ───────────────────────────────────────────────────────

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

          // Bring dragged shape to front
          const { maxZIndex } = useCanvasStore.getState();
          updateShape(shape.id, { zIndex: maxZIndex + 1 });
        } else {
          panRef.current = { lastX: e.clientX, lastY: e.clientY };
          if (canvas) canvas.style.cursor = 'grabbing';
        }
      }
    },
    [getShapeAt, toWorld, updateShape]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (dragRef.current) {
        // Divide screen-space delta by zoom to get world-space delta
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
    [scheduleRender, toWorld]
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
  }, [addShape, updateShape, setMode, render]);

  // Global listeners
  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // ─── Touch support ────────────────────────────────────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1) {
      panRef.current = { lastX: e.touches[0].clientX, lastY: e.touches[0].clientY };
    }
  }, []);

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
    [scheduleRender]
  );

  const handleTouchEnd = useCallback(() => {
    panRef.current = null;
  }, []);

  // ─── JSX ─────────────────────────────────────────────────────────────────

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', background: '#3a3a3a' }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
      <Minimap
        canvasOffsetRef={canvasOffsetRef}
        viewportSize={{ width: window.innerWidth, height: window.innerHeight }}
      />
    </>
  );
}
