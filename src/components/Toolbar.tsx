import { memo } from 'react';
import { useCanvasStore } from '../store/canvasStore';

const Toolbar = memo(() => {
  const setMode = useCanvasStore((state) => state.setMode);
  const resetCanvas = useCanvasStore((state) => state.resetCanvas);

  return (
    <div className="toolbar">
      <div className="toolbar-content">
        <button className="reset-btn" onClick={resetCanvas}>
          Reset
        </button>
        <button className="create-btn" onClick={() => setMode('draw')}>
          Create
        </button>
      </div>
    </div>
  );
});

Toolbar.displayName = 'Toolbar';

export default Toolbar;
