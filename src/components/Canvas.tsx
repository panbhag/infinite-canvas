import { useRef } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { useCanvasInteractions } from '../hooks/useCanvasInteractions';
import ShapeItem from './ShapeItem';
import Minimap from './Minimap';

export default function Canvas() {
  const shapes = useCanvasStore((state) => state.shapes);
  const mode = useCanvasStore((state) => state.mode);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasContentRef = useRef<HTMLDivElement>(null);
  const drawingPreviewRef = useRef<SVGRectElement>(null);

  const {
    canvasOffsetRef,
    registerRef,
    handleShapeMouseDown,
    handleCanvasMouseDown,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useCanvasInteractions(containerRef, canvasContentRef, drawingPreviewRef);

  return (
    <>
      <div
        ref={containerRef}
        className={`infinite-canvas${mode === 'draw' ? ' draw-mode' : ''}`}
        onMouseDown={handleCanvasMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div
          ref={canvasContentRef}
          className="canvas-content"
          style={{
            transform: `translate(${canvasOffsetRef.current.x}px, ${canvasOffsetRef.current.y}px)`,
          }}
        >
          {[...shapes.values()].map((shape) => (
            <ShapeItem
              key={shape.id}
              shape={shape}
              onMouseDown={handleShapeMouseDown}
              registerRef={registerRef}
            />
          ))}

          {/* SVG drawing preview: geometry attribute changes never trigger HTML layout */}
          <svg
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 0,
              height: 0,
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            <rect ref={drawingPreviewRef} visibility="hidden" rx={8} ry={8} />
          </svg>
        </div>
      </div>

      <Minimap
        canvasOffsetRef={canvasOffsetRef}
        viewportSize={{ width: window.innerWidth, height: window.innerHeight }}
      />
    </>
  );
}
