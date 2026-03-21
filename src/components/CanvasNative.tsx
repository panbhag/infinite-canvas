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
  ctx.lineWidth = (isDragging ? 3 : 2) / zoom;
  roundedRect(ctx, x, y, shape.width, shape.height, 8);
  ctx.stroke();
}

// ─── Color picking helpers ────────────────────────────────────────────────────

/** Encode a picking ID (1-based integer) into an rgb() string. */
function encodePickingColor(id: number): string {
  const r = (id >> 16) & 0xff;
  const g = (id >>  8) & 0xff;
  const b =  id        & 0xff;
  return `rgb(${r},${g},${b})`;
}

/** Decode the RGBA pixel bytes read from getImageData back into a picking ID. */
function decodePickingColor(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

/** Returns true if the shape's AABB intersects the visible viewport (world space). */
function isVisible(
  shape: Shape,
  offsetX: number, offsetY: number,
  zoom: number,
  canvasW: number, canvasH: number,
): boolean {
  const viewMinX =  -offsetX / zoom;
  const viewMinY =  -offsetY / zoom;
  const viewMaxX = viewMinX + canvasW / zoom;
  const viewMaxY = viewMinY + canvasH / zoom;
  return (
    shape.x + shape.width  > viewMinX &&
    shape.x                < viewMaxX &&
    shape.y + shape.height > viewMinY &&
    shape.y                < viewMaxY
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CanvasNative() {
  const { addShape, updateShape, setMode } = useCanvasStore();
  const mode = useCanvasStore((state) => state.mode);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasOffsetRef = useRef({ x: -window.innerWidth, y: -window.innerHeight });
  const zoomRef = useRef(1);

  // ─── Offscreen picking canvas ─────────────────────────────────────────────
  // A hidden canvas rendered with solid unique colors per shape.
  // getImageData at the click position decodes directly to a shape ID — O(1).

  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  // pickingId (integer) → shapeId (string)
  const pickingMapRef = useRef<Map<number, string>>(new Map());
  // shapeId (string) → pickingId (integer)
  const shapeToPickingRef = useRef<Map<string, number>>(new Map());
  const nextPickingIdRef = useRef(1);
  // true whenever the picking canvas needs a redraw before the next hit test
  const pickingDirtyRef = useRef(true);

  // ─── Per-interaction refs ─────────────────────────────────────────────────

  const dragRef = useRef<{
    id: string;
    startCursorX: number;
    startCursorY: number;
    startShapeX: number;
    startShapeY: number;
    lastDx: number;
    lastDy: number;
  } | null>(null);

  const panRef = useRef<{ lastX: number; lastY: number } | null>(null);

  const drawRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    color: string;
    pendingX: number;
    pendingY: number;
    pendingW: number;
    pendingH: number;
  } | null>(null);

  const rafRef = useRef<number | null>(null);

  // ─── Coordinate helpers ───────────────────────────────────────────────────

  const toWorld = useCallback((screenX: number, screenY: number) => {
    const { x: ox, y: oy } = canvasOffsetRef.current;
    const zoom = zoomRef.current;
    return { x: (screenX - ox) / zoom, y: (screenY - oy) / zoom };
  }, []);

  // ─── Picking render ───────────────────────────────────────────────────────

  /** Redraws the offscreen picking canvas. Called at the end of every render(). */
  const renderPicking = useCallback(() => {
    if (!pickingDirtyRef.current) return;  // already up to date, skip redraw
    const offscreen = offscreenRef.current;
    if (!offscreen) return;
    // willReadFrequently hint is set at context creation (in the resize effect).
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const { shapes: currentShapes } = useCanvasStore.getState();
    const { x: ox, y: oy } = canvasOffsetRef.current;
    const zoom = zoomRef.current;

    ctx.clearRect(0, 0, offscreen.width, offscreen.height);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(zoom, zoom);

    // Each shape is a solid unique color — no alpha, no stroke, no anti-aliasing artifacts.
    for (const shape of currentShapes.values()) {
      if (!isVisible(shape, ox, oy, zoom, offscreen.width, offscreen.height)) continue;
      const pickId = shapeToPickingRef.current.get(shape.id);
      if (pickId === undefined) continue;
      ctx.fillStyle = encodePickingColor(pickId);
      roundedRect(ctx, shape.x, shape.y, shape.width, shape.height, 8);
      ctx.fill();
    }

    ctx.restore();
    pickingDirtyRef.current = false;
  }, []);

  // ─── Main render ──────────────────────────────────────────────────────────

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { shapes: currentShapes } = useCanvasStore.getState();
    const { x: ox, y: oy } = canvasOffsetRef.current;
    const zoom = zoomRef.current;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(zoom, zoom);

    // Map iteration order = insertion order = zIndex order — no sort needed.
    for (const shape of currentShapes.values()) {
      if (dragRef.current?.id === shape.id) continue;
      if (!isVisible(shape, ox, oy, zoom, canvas.width, canvas.height)) continue;
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

    // Create the offscreen picking canvas once, with willReadFrequently so the
    // browser can optimise the backing store for frequent getImageData calls.
    if (!offscreenRef.current) {
      offscreenRef.current = document.createElement('canvas');
      offscreenRef.current.getContext('2d', { willReadFrequently: true });
    }

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      offscreenRef.current!.width = canvas.width;
      offscreenRef.current!.height = canvas.height;
      render();
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [render]);

  // Subscribe to shapes changes without causing a React re-render.
  // Syncs picking IDs and triggers an imperative canvas redraw directly.
  useEffect(() => {
    return useCanvasStore.subscribe((state, prev) => {
      if (state.shapes === prev.shapes) return;

      for (const [pickId, shapeId] of pickingMapRef.current) {
        if (!state.shapes.has(shapeId)) {
          pickingMapRef.current.delete(pickId);
          shapeToPickingRef.current.delete(shapeId);
        }
      }
      for (const shape of state.shapes.values()) {
        if (!shapeToPickingRef.current.has(shape.id)) {
          const pickId = nextPickingIdRef.current++;
          pickingMapRef.current.set(pickId, shape.id);
          shapeToPickingRef.current.set(shape.id, pickId);
        }
      }

      pickingDirtyRef.current = true;
      render();
    });
  }, [render]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = mode === 'draw' ? 'crosshair' : 'grab';
  }, [mode]);

  // ─── Hit testing (O(1) color picking) ─────────────────────────────────────

  const getShapeAt = useCallback((clientX: number, clientY: number): Shape | null => {
    const offscreen = offscreenRef.current;
    if (!offscreen) return null;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    // Render picking canvas on demand — only runs on mousedown, not every frame.
    renderPicking();

    // Read the single pixel at the click position — screen coords map directly.
    const pixel = ctx.getImageData(clientX, clientY, 1, 1).data;
    if (pixel[3] === 0) return null;  // alpha 0 = transparent background = no shape

    const pickId = decodePickingColor(pixel[0], pixel[1], pixel[2]);
    const shapeId = pickingMapRef.current.get(pickId);
    if (!shapeId) return null;

    return useCanvasStore.getState().shapes.get(shapeId) ?? null;
  }, [renderPicking]);

  // ─── Wheel (zoom) ─────────────────────────────────────────────────────────

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();

    const oldZoom = zoomRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));

    const ratio = newZoom / oldZoom;
    canvasOffsetRef.current.x = e.clientX - (e.clientX - canvasOffsetRef.current.x) * ratio;
    canvasOffsetRef.current.y = e.clientY - (e.clientY - canvasOffsetRef.current.y) * ratio;

    zoomRef.current = newZoom;
    pickingDirtyRef.current = true;
    scheduleRender();
  }, [scheduleRender]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
        pickingDirtyRef.current = true;
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
        pickingDirtyRef.current = true;
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
