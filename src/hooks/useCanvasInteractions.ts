import React, { useRef, useCallback, useEffect } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { getRandomColor } from '../utils/colors';

export function useCanvasInteractions(
  containerRef: React.RefObject<HTMLDivElement | null>,
  canvasContentRef: React.RefObject<HTMLDivElement | null>,
  drawingPreviewRef: React.RefObject<SVGRectElement | null>,
) {
  const { addShape, updateShape, setMode } = useCanvasStore();

  // Canvas translation — mutated every pan frame, applied directly to the DOM.
  const canvasOffsetRef = useRef({ x: -window.innerWidth, y: -window.innerHeight });

  // Map from shape id → its DOM element, used for imperative drag updates.
  const shapeElsRef = useRef(new Map<string, HTMLDivElement>());

  // ─── Per-interaction state (refs, not state) ────────────────────────────
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

  const drawRafRef = useRef<number | null>(null);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const applyCanvasTransform = useCallback(() => {
    const el = canvasContentRef.current;
    if (el) {
      const { x, y } = canvasOffsetRef.current;
      el.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [canvasContentRef]);

  const toCanvasCoords = useCallback((clientX: number, clientY: number) => ({
    x: clientX - canvasOffsetRef.current.x,
    y: clientY - canvasOffsetRef.current.y,
  }), []);

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) shapeElsRef.current.set(id, el);
    else shapeElsRef.current.delete(id);
  }, []);

  // ─── Mouse event handlers ─────────────────────────────────────────────────

  const handleShapeMouseDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      // Read latest mode from store without subscribing (avoids stale closure).
      const { mode } = useCanvasStore.getState();
      if (mode === 'draw') return;

      e.stopPropagation();
      e.preventDefault();

      const { shapes, maxZIndex } = useCanvasStore.getState();
      const shape = shapes.get(id);
      if (!shape) return;

      const dragEl = shapeElsRef.current.get(id);
      if (dragEl) {
        dragEl.style.willChange = 'transform';
        dragEl.classList.add('dragging');
      }

      dragRef.current = {
        id,
        startCursorX: e.clientX,
        startCursorY: e.clientY,
        startShapeX: shape.x,
        startShapeY: shape.y,
        lastDx: 0,
        lastDy: 0,
      };

      updateShape(id, { zIndex: maxZIndex + 1 });
    },
    [updateShape]
  );

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (dragRef.current) return;

      const { mode } = useCanvasStore.getState();

      if (mode === 'draw') {
        const coords = toCanvasCoords(e.clientX, e.clientY);
        const id = `shape-${Date.now()}`;
        const color = getRandomColor();

        drawRef.current = {
          id, startX: coords.x, startY: coords.y, color,
          pendingX: coords.x, pendingY: coords.y, pendingW: 0, pendingH: 0,
        };

        const rect = drawingPreviewRef.current;
        if (rect) {
          rect.setAttribute('visibility', 'visible');
          rect.setAttribute('x', String(coords.x));
          rect.setAttribute('y', String(coords.y));
          rect.setAttribute('width', '0');
          rect.setAttribute('height', '0');
          rect.setAttribute('fill', color);
          rect.setAttribute('fill-opacity', '0.3');
          rect.setAttribute('stroke', color);
          rect.setAttribute('stroke-width', '2');
          rect.setAttribute('stroke-dasharray', '6 4');
        }
      } else {
        containerRef.current?.classList.add('panning');
        panRef.current = { lastX: e.clientX, lastY: e.clientY };
      }
    },
    [toCanvasCoords, drawingPreviewRef, containerRef]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (dragRef.current) {
        const { id, startCursorX, startCursorY } = dragRef.current;
        const dx = e.clientX - startCursorX;
        const dy = e.clientY - startCursorY;
        dragRef.current.lastDx = dx;
        dragRef.current.lastDy = dy;

        const el = shapeElsRef.current.get(id);
        if (el) el.style.transform = `translate(${dx}px, ${dy}px)`;

      } else if (drawRef.current) {
        const { startX, startY } = drawRef.current;
        const coords = toCanvasCoords(e.clientX, e.clientY);

        drawRef.current.pendingX = Math.min(coords.x, startX);
        drawRef.current.pendingY = Math.min(coords.y, startY);
        drawRef.current.pendingW = Math.abs(coords.x - startX);
        drawRef.current.pendingH = Math.abs(coords.y - startY);

        if (drawRafRef.current === null) {
          drawRafRef.current = requestAnimationFrame(() => {
            drawRafRef.current = null;
            if (!drawRef.current) return;
            const { pendingX, pendingY, pendingW, pendingH } = drawRef.current;
            const rect = drawingPreviewRef.current;
            if (rect) {
              rect.setAttribute('x', String(pendingX));
              rect.setAttribute('y', String(pendingY));
              rect.setAttribute('width', String(pendingW));
              rect.setAttribute('height', String(pendingH));
            }
          });
        }
      } else if (panRef.current) {
        const dx = e.clientX - panRef.current.lastX;
        const dy = e.clientY - panRef.current.lastY;
        canvasOffsetRef.current.x += dx;
        canvasOffsetRef.current.y += dy;
        applyCanvasTransform();
        panRef.current.lastX = e.clientX;
        panRef.current.lastY = e.clientY;
      }
    },
    [applyCanvasTransform, toCanvasCoords, drawingPreviewRef]
  );

  const handleMouseUp = useCallback(() => {
    if (dragRef.current) {
      const { id, startShapeX, startShapeY, lastDx, lastDy } = dragRef.current;

      const el = shapeElsRef.current.get(id);
      if (el) {
        el.style.transform = '';
        el.style.willChange = '';
        el.classList.remove('dragging');
      }

      updateShape(id, { x: startShapeX + lastDx, y: startShapeY + lastDy });

      dragRef.current = null;
    }

    if (drawRef.current) {
      if (drawRafRef.current !== null) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }

      const { id, color, pendingX: x, pendingY: y, pendingW: w, pendingH: h } = drawRef.current;

      const rect = drawingPreviewRef.current;
      if (rect) {
        if (w > 5 && h > 5) {
          const { maxZIndex } = useCanvasStore.getState();
          addShape({ id, type: 'rectangle', x, y, width: w, height: h, color, zIndex: maxZIndex + 1 });
        }
        rect.setAttribute('visibility', 'hidden');
      }

      drawRef.current = null;
      setMode('pan');
    }

    if (panRef.current) {
      containerRef.current?.classList.remove('panning');
      panRef.current = null;
    }
  }, [addShape, updateShape, setMode, drawingPreviewRef, containerRef]);

  // ─── Touch support ──────────────────────────────────────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      panRef.current = { lastX: e.touches[0].clientX, lastY: e.touches[0].clientY };
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 1 && panRef.current) {
        const dx = e.touches[0].clientX - panRef.current.lastX;
        const dy = e.touches[0].clientY - panRef.current.lastY;
        canvasOffsetRef.current.x += dx;
        canvasOffsetRef.current.y += dy;
        applyCanvasTransform();
        panRef.current.lastX = e.touches[0].clientX;
        panRef.current.lastY = e.touches[0].clientY;
      }
    },
    [applyCanvasTransform]
  );

  const handleTouchEnd = useCallback(() => {
    panRef.current = null;
  }, []);

  // Attach global listeners once.
  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return {
    canvasOffsetRef,
    registerRef,
    handleShapeMouseDown,
    handleCanvasMouseDown,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
