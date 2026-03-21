import { memo, useCallback } from 'react';
import { Shape } from '../types';

interface ShapeItemProps {
  shape: Shape;
  onMouseDown: (e: React.MouseEvent, id: string) => void;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}

const ShapeItem = memo(({ shape, onMouseDown, registerRef }: ShapeItemProps) => {
  // Callback ref: registers/unregisters this DOM node in the parent's lookup map.
  // Stable for the lifetime of the shape (id never changes, registerRef is stable).
  const callbackRef = useCallback(
    (el: HTMLDivElement | null) => registerRef(shape.id, el),
    [registerRef, shape.id]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => onMouseDown(e, shape.id),
    [onMouseDown, shape.id]
  );

  return (
    <div
      ref={callbackRef}
      className="shape shape-rectangle"
      style={{
        left: shape.x,
        top: shape.y,
        width: shape.width,
        height: shape.height,
        backgroundColor: shape.color,
        borderColor: shape.color,
        zIndex: shape.zIndex,
      }}
      onMouseDown={handleMouseDown}
    />
  );
});

ShapeItem.displayName = 'ShapeItem';

export default ShapeItem;
