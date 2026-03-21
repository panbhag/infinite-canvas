import React, { useState, useRef, useCallback, memo } from 'react';
import { useCanvasStore } from '../store/canvasStore';

interface MinimapProps {
  canvasOffsetRef: React.RefObject<{ x: number; y: number }>;
  viewportSize: { width: number; height: number };
}

const Minimap = memo(({ canvasOffsetRef, viewportSize }: MinimapProps) => {
  const shapes = useCanvasStore((state) => state.shapes);
  const [isDraggingMinimap, setIsDraggingMinimap] = useState(false);
  const lastPosition = useRef({ x: 0, y: 0 });
  const [minimapPosition, setMinimapPosition] = useState({ x: 20, y: 20 });

  const minimapSize = {
    width: viewportSize.width * 0.15,
    height: viewportSize.height * 0.15,
  };

  const getContentBounds = () => {
    if (shapes.length === 0) {
      return {
        minX: -viewportSize.width,
        maxX: viewportSize.width * 2,
        minY: -viewportSize.height,
        maxY: viewportSize.height * 2,
        width: viewportSize.width * 3,
        height: viewportSize.height * 3,
      };
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    shapes.forEach((shape) => {
      minX = Math.min(minX, shape.x);
      maxX = Math.max(maxX, shape.x + shape.width);
      minY = Math.min(minY, shape.y);
      maxY = Math.max(maxY, shape.y + shape.height);
    });

    const padding = 200;
    minX -= padding;
    maxX += padding;
    minY -= padding;
    maxY += padding;

    // Read canvas offset from ref (no reactive subscription — avoids re-renders on pan)
    const offset = canvasOffsetRef.current;
    if (offset) {
      const viewportMinX = -offset.x;
      const viewportMaxX = viewportMinX + viewportSize.width;
      const viewportMinY = -offset.y;
      const viewportMaxY = viewportMinY + viewportSize.height;

      minX = Math.min(minX, viewportMinX);
      maxX = Math.max(maxX, viewportMaxX);
      minY = Math.min(minY, viewportMinY);
      maxY = Math.max(maxY, viewportMaxY);
    }

    return {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    };
  };

  const contentBounds = getContentBounds();
  const minimapScale = Math.min(
    minimapSize.width / contentBounds.width,
    minimapSize.height / contentBounds.height
  );

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
      <div
        className="minimap"
        style={{ width: minimapSize.width, height: minimapSize.height }}
      >
        {[...shapes]
          .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))
          .map((shape) => (
            <div
              key={shape.id}
              className={`minimap-shape minimap-shape-${shape.type}`}
              style={{
                position: 'absolute',
                left: (shape.x - contentBounds.minX) * minimapScale,
                top: (shape.y - contentBounds.minY) * minimapScale,
                width: shape.width * minimapScale,
                height: shape.height * minimapScale,
                borderRadius: '2px',
                backgroundColor: shape.color,
                borderColor: shape.color,
                zIndex: shape.zIndex,
              }}
            />
          ))}
      </div>
    </div>
  );
});

Minimap.displayName = 'Minimap';

export default Minimap;
