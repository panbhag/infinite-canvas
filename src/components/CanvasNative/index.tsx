import { useRef, useEffect } from 'react';
import { useCanvasStore } from '../../store/canvasStore';
import { SpatialGrid } from './spatialGrid';
import { useRenderer } from './useRenderer';
import { useHitTest } from './useHitTest';
import { useInteractions } from './useInteractions';
import Minimap from '../Minimap';

export default function CanvasNative() {
  // ─── Core refs ──────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const canvasOffsetRef = useRef({ x: -window.innerWidth, y: -window.innerHeight });
  const zoomRef = useRef(1);

  // ─── Spatial grid refs ──────────────────────────────────────────────────────
  const spatialGridRef = useRef(new SpatialGrid());
  const visibleIdsRef = useRef(new Set<string>());

  // ─── Interaction refs ───────────────────────────────────────────────────────
  const dragRef = useRef<import('./types').DragState | null>(null);
  const panRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const drawRef = useRef<import('./types').DrawState | null>(null);
  const rafRef = useRef<number | null>(null);

  // ─── Hooks ──────────────────────────────────────────────────────────────────
  const { render, scheduleRender } = useRenderer(
    canvasRef, ctxRef, canvasOffsetRef, zoomRef,
    spatialGridRef, visibleIdsRef, dragRef, drawRef, rafRef,
  );

  const { toWorld, getShapeAt } = useHitTest(canvasOffsetRef, zoomRef, spatialGridRef);

  const { handleMouseDown, handleTouchStart, handleTouchMove, handleTouchEnd } = useInteractions(
    canvasRef, canvasOffsetRef, zoomRef,
    dragRef, panRef, drawRef, rafRef,
    render, scheduleRender, toWorld, getShapeAt,
  );

  // ─── Canvas sizing ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    ctxRef.current = canvas.getContext('2d');

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      render();
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [render]);

  // ─── Store subscription ─────────────────────────────────────────────────────
  // Handles mode changes (cursor) and shapes changes (grid sync + redraw).
  // No React state — component never re-renders after mount.
  useEffect(() => {
    return useCanvasStore.subscribe((state, prev) => {
      if (state.mode !== prev.mode) {
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = state.mode === 'draw' ? 'crosshair' : 'grab';
      }

      if (state.shapes === prev.shapes) return;

      const grid = spatialGridRef.current;

      for (const [id, shape] of prev.shapes) {
        if (!state.shapes.has(id)) grid.remove(shape);
      }

      for (const [id, shape] of state.shapes) {
        const prevShape = prev.shapes.get(id);
        if (!prevShape) {
          grid.insert(shape);
        } else if (
          prevShape.x !== shape.x || prevShape.y !== shape.y ||
          prevShape.width !== shape.width || prevShape.height !== shape.height
        ) {
          grid.remove(prevShape);
          grid.insert(shape);
        }
      }

      render();
    });
  }, [render]);

  // ─── JSX ────────────────────────────────────────────────────────────────────
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
