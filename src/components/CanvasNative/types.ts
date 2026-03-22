export interface DragState {
  id: string;
  startCursorX: number;
  startCursorY: number;
  startShapeX: number;
  startShapeY: number;
  lastDx: number;
  lastDy: number;
}

export interface DrawState {
  id: string;
  startX: number;
  startY: number;
  color: string;
  pendingX: number;
  pendingY: number;
  pendingW: number;
  pendingH: number;
}
