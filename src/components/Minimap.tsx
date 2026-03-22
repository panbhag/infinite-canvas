import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { scheduleIdle, cancelIdle } from '../utils/idleCallback';

interface MinimapProps {
  canvasOffsetRef: React.RefObject<{ x: number; y: number }>;
  viewportSize: { width: number; height: number };
}

const Minimap = memo(({ canvasOffsetRef, viewportSize }: MinimapProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDraggingMinimap, setIsDraggingMinimap] = useState(false);
  const lastPosition = useRef({ x: 0, y: 0 });
  const [minimapPosition, setMinimapPosition] = useState({ x: 20, y: 20 });

  const minimapW = viewportSize.width * 0.15;
  const minimapH = viewportSize.height * 0.15;

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { shapes } = useCanvasStore.getState();

    // Compute content bounds — O(n) but only called when shapes actually change,
    // never on pan or every frame.
    let minX: number, maxX: number, minY: number, maxY: number;

    if (shapes.size === 0) {
      // No shapes — show the current viewport area as the default view.
      minX = -viewportSize.width;
      maxX = viewportSize.width * 2;
      minY = -viewportSize.height;
      maxY = viewportSize.height * 2;
    } else {
      minX = Infinity; maxX = -Infinity;
      minY = Infinity; maxY = -Infinity;
      for (const shape of shapes.values()) {
        minX = Math.min(minX, shape.x);
        maxX = Math.max(maxX, shape.x + shape.width);
        minY = Math.min(minY, shape.y);
        maxY = Math.max(maxY, shape.y + shape.height);
      }
      const padding = 200;
      minX -= padding; maxX += padding;
      minY -= padding; maxY += padding;
    }

    // Expand to include current viewport so the minimap always shows where we are.
    const offset = canvasOffsetRef.current;
    if (offset) {
      minX = Math.min(minX, -offset.x);
      maxX = Math.max(maxX, -offset.x + viewportSize.width);
      minY = Math.min(minY, -offset.y);
      maxY = Math.max(maxY, -offset.y + viewportSize.height);
    }

    const boundsW = maxX - minX;
    const boundsH = maxY - minY;
    const scale = Math.min(canvas.width / boundsW, canvas.height / boundsH);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw all shapes — one fillRect per shape, no DOM nodes.
    ctx.globalAlpha = 0.7;
    for (const shape of shapes.values()) {
      ctx.fillStyle = shape.color;
      ctx.fillRect(
        (shape.x - minX) * scale,
        (shape.y - minY) * scale,
        Math.max(1, shape.width * scale),   // min 1px so tiny shapes are still visible
        Math.max(1, shape.height * scale),
      );
    }
    ctx.globalAlpha = 1;
  }, [canvasOffsetRef, viewportSize]);

  // Set canvas size once on mount and re-render.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = minimapW;
    canvas.height = minimapH;
    render();
  }, [minimapW, minimapH, render]);

  // Re-render whenever shapes change — deferred to idle time since the minimap
  // is low priority and should not compete with the main canvas during interactions.
  const idleCallbackRef = useRef<number | null>(null);

  useEffect(() => {
    return useCanvasStore.subscribe((state, prev) => {
      if (state.shapes === prev.shapes) return;
      // Cancel any previously queued idle render — only the latest matters.
      if (idleCallbackRef.current !== null) {
        cancelIdle(idleCallbackRef.current);
      }
      idleCallbackRef.current = scheduleIdle(() => {
        idleCallbackRef.current = null;
        render();
      });
    });
  }, [render]);

  const handleMinimapMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingMinimap(true);
    lastPosition.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMinimapMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDraggingMinimap) return;
      const deltaX = e.clientX - lastPosition.current.x;
      const deltaY = e.clientY - lastPosition.current.y;
      setMinimapPosition((prev) => ({ x: prev.x + deltaX, y: prev.y + deltaY }));
      lastPosition.current = { x: e.clientX, y: e.clientY };
    },
    [isDraggingMinimap]
  );

  const handleMinimapMouseUp = useCallback(() => {
    setIsDraggingMinimap(false);
  }, []);

  return (
    <div
      className="minimap-container"
      style={{
        position: 'fixed',
        bottom: minimapPosition.y,
        right: minimapPosition.x,
        cursor: isDraggingMinimap ? 'grabbing' : 'grab',
      }}
      onMouseDown={handleMinimapMouseDown}
      onMouseMove={handleMinimapMouseMove}
      onMouseUp={handleMinimapMouseUp}
    >
      <canvas
        ref={canvasRef}
        className="minimap"
        style={{ display: 'block' }}
      />
    </div>
  );
});

Minimap.displayName = 'Minimap';

export default Minimap;
