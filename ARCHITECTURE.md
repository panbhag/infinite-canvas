# Infinite Canvas — Architecture & Flow Documentation

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [File Structure](#2-file-structure)
3. [Data Model](#3-data-model)
4. [State Management](#4-state-management)
5. [Two Canvas Implementations](#5-two-canvas-implementations)
6. [Coordinate System](#6-coordinate-system)
7. [Interaction Flows](#7-interaction-flows)
   - [Pan](#71-pan-flow)
   - [Draw](#72-draw-flow)
   - [Drag](#73-drag-flow)
   - [Zoom (CanvasNative only)](#74-zoom-flow-canvasnative-only)
8. [Performance Design](#8-performance-design)
9. [Minimap](#9-minimap)
10. [Toolbar](#10-toolbar)

---

## 1. Project Overview

An infinite canvas built with React + TypeScript where users can:
- Pan freely in all directions
- Draw rectangles by click-and-drag
- Move shapes around
- Zoom in/out (canvas implementation)
- See a real-time minimap overview

The application exists in two renderer variants — a **DOM-based renderer** (`Canvas.tsx`) and a **native HTML `<canvas>` renderer** (`CanvasNative.tsx`) — both sharing the same Zustand store.

---

## 2. File Structure

```
src/
├── App.tsx                          # Root: composes Toolbar + active canvas
├── types.tsx                        # Shape interface
├── store/
│   └── canvasStore.ts               # Zustand store (shapes, mode, actions)
├── hooks/
│   └── useCanvasInteractions.ts     # Pan/draw/drag logic for the DOM renderer
├── components/
│   ├── CanvasNative.tsx             # Active renderer: HTML <canvas> element
│   ├── Canvas.tsx                   # Alternate renderer: DOM divs + SVG
│   ├── ShapeItem.tsx                # Single shape div (used by Canvas.tsx only)
│   ├── Toolbar.tsx                  # Reset + Create buttons
│   └── Minimap.tsx                  # Scaled overview widget
└── utils/
    └── colors.ts                    # Color palette + getRandomColor()
```

**Active rendering path:**
```
App  →  Toolbar
     →  CanvasNative  →  Minimap
```

---

## 3. Data Model

```typescript
interface Shape {
  id: string;       // "shape-<timestamp>", unique
  type: 'rectangle';
  x: number;        // world-space left edge
  y: number;        // world-space top edge
  width: number;    // world-space width
  height: number;   // world-space height
  color: string;    // hex color string
  zIndex: number;   // paint order, higher = on top
}
```

All positions are stored in **world space** — independent of the current pan offset or zoom level. The renderer applies the transform at draw time.

---

## 4. State Management

**File:** `src/store/canvasStore.ts`

```typescript
interface CanvasState {
  shapes: Shape[];   // committed shape array
  mode: Mode;        // 'pan' | 'draw'
  updateShapes(updater: (prev: Shape[]) => Shape[]): void;
  setMode(mode: Mode): void;
  resetCanvas(): void;
}
```

Built with **Zustand**. Key design choices:

### Why Zustand
- Components subscribe to only the slices they need (`state.shapes`, `state.mode`), so unrelated changes don't cause re-renders.
- `useCanvasStore.getState()` gives synchronous access to the latest state inside event handlers **without subscribing**. This is the primary way high-frequency handlers (mousemove, wheel) avoid stale closures without creating new handler instances on every state change.

### What is NOT in the store
Pan offset, zoom level, and all in-progress interaction data live in **refs**, not the store:

| Data | Where | Why |
|---|---|---|
| `canvasOffsetRef` | ref | Mutated every mouse-move frame; putting it in the store would trigger re-renders 60+ times/second |
| `zoomRef` | ref | Same reason |
| `dragRef`, `panRef`, `drawRef` | refs | Transient interaction state; only the final committed result belongs in the store |

### updateShapes
The `updateShapes` action accepts a functional updater `(prev) => next`. This pattern:
- Avoids stale closure issues (the updater always receives the current state)
- Allows batching-friendly updates
- Keeps the shape array immutable — only the modified shape gets a new object reference, which matters for `React.memo` in the DOM renderer

---

## 5. Two Canvas Implementations

### Canvas.tsx — DOM Renderer
Uses a `<div>` tree. Each shape is its own `<div>` (`ShapeItem`). The canvas-content div is translated via `style.transform`.

- **Strengths:** Each shape is its own DOM node, so React's reconciler handles individual shape updates efficiently. `React.memo` prevents unmodified shapes from re-rendering during drag.
- **Drag technique:** CSS `transform: translate(dx, dy)` is applied imperatively to the dragged shape's DOM element, bypassing React entirely until mouseup.
- **Draw preview:** Uses a zero-size `<svg>` with `overflow: visible` containing a `<rect>`. Updating SVG geometry attributes (`x`, `y`, `width`, `height`) avoids triggering HTML layout entirely — unlike changing `style.width`/`style.height` on a div.
- **No zoom support** in this implementation.

### CanvasNative.tsx — HTML Canvas Renderer (active)
Uses a single `<canvas>` element. Everything is drawn imperatively via the 2D Context API.

- **Strengths:** All rendering is one `clearRect` + redraw loop. Supports zoom natively via `ctx.scale`. No DOM nodes per shape means no browser layout or style recalc overhead at any scale.
- **Weakness:** Requires manual hit-testing to find which shape the user clicked (no browser event routing per shape).
- **Zoom support:** Full scroll-wheel zoom with zoom-toward-cursor math.

---

## 6. Coordinate System

Two spaces are used throughout the code:

### Screen space (client coordinates)
Raw pixel coordinates from mouse/touch events (`e.clientX`, `e.clientY`). Origin is the top-left of the browser viewport.

### World space
The infinite canvas coordinate system where shapes are stored. Shapes' `x`, `y`, `width`, `height` are all in world space.

### The transform
```
screen = offset + world × zoom
world  = (screen − offset) / zoom
```

- `canvasOffsetRef.current` = `{ x, y }` — where world origin maps to on screen.
- `zoomRef.current` = current zoom level (default `1`).

**`toWorld` helper (CanvasNative):**
```typescript
const toWorld = (screenX, screenY) => ({
  x: (screenX - offset.x) / zoom,
  y: (screenY - offset.y) / zoom,
});
```

This is called any time a mouse position needs to become a world position: draw start, draw move, hit testing.

**In render:**
```typescript
ctx.translate(offset.x, offset.y);
ctx.scale(zoom, zoom);
// now draw shapes at their world-space x, y
```

---

## 7. Interaction Flows

### 7.1 Pan Flow

**Trigger:** mousedown on empty canvas area in pan mode, or single-finger touch.

#### Step by step

1. **mousedown** → `handleMouseDown` detects no shape under cursor, sets:
   ```typescript
   panRef.current = { lastX: e.clientX, lastY: e.clientY };
   canvas.style.cursor = 'grabbing';
   ```

2. **mousemove** (attached to `document`) → `handleMouseMove`:
   ```typescript
   canvasOffsetRef.current.x += e.clientX - panRef.current.lastX;
   canvasOffsetRef.current.y += e.clientY - panRef.current.lastY;
   panRef.current.lastX = e.clientX;
   panRef.current.lastY = e.clientY;
   scheduleRender();  // CanvasNative: rAF-throttled redraw
   ```
   The offset is a raw accumulation of mouse deltas — no math required because pan is a direct 1:1 translation in screen space.

   In the **DOM renderer**, instead of `scheduleRender()`, `applyCanvasTransform()` is called which writes `style.transform` directly on the content div.

3. **mouseup** → `handleMouseUp`:
   ```typescript
   panRef.current = null;
   canvas.style.cursor = 'grab';
   ```
   No store update — pan offset lives entirely in `canvasOffsetRef`.

#### Performance
Pan **never touches React state or the Zustand store**. It is purely:
- ref mutation (`canvasOffsetRef`)
- one DOM write per frame (`ctx.clearRect` + redraw, or `style.transform` in DOM renderer)

This is why panning is smooth regardless of how many shapes exist.

---

### 7.2 Draw Flow

**Trigger:** Click "Create" button → mode becomes `'draw'` → mousedown on canvas.

#### Step by step

1. **Toolbar "Create" click** → `setMode('draw')` → store updates, cursor becomes `crosshair`.

2. **mousedown** → `handleMouseDown` detects mode is `'draw'`, converts cursor to world coordinates:
   ```typescript
   const { x: startX, y: startY } = toWorld(e.clientX, e.clientY);
   drawRef.current = {
     id: `shape-${Date.now()}`,
     startX, startY,
     color: getRandomColor(),
     pendingX: startX, pendingY: startY, pendingW: 0, pendingH: 0,
   };
   ```
   In the DOM renderer, the SVG `<rect>` preview is made visible and positioned at the start point.

3. **mousemove** → `handleMouseMove` updates the pending bounds in world space:
   ```typescript
   const { x: wx, y: wy } = toWorld(e.clientX, e.clientY);
   drawRef.current.pendingX = Math.min(wx, startX);
   drawRef.current.pendingY = Math.min(wy, startY);
   drawRef.current.pendingW = Math.abs(wx - startX);
   drawRef.current.pendingH = Math.abs(wy - startY);
   scheduleRender();
   ```
   `min`/`abs` normalisation means you can drag in any direction — top-left, top-right, bottom-left, bottom-right — and always get a valid rect.

   In `render()`, if `drawRef.current` exists, the preview rectangle is drawn with dashed stroke and 30% fill opacity.

4. **mouseup** → `handleMouseUp`:
   - Cancels any pending rAF.
   - Checks minimum size (`w > 5 && h > 5`) to reject accidental clicks.
   - Commits to the store:
     ```typescript
     updateShapes(prev => [...prev, {
       id, type: 'rectangle', x, y, width: w, height: h, color,
       zIndex: maxZ + 1   // always on top of existing shapes
     }]);
     ```
   - Clears `drawRef.current`.
   - Calls `setMode('pan')` — automatically returns to pan mode.

#### Performance
During the drag, **nothing is written to React state or the store**. Only `drawRef` is mutated and `scheduleRender()` queues one canvas redraw per display frame. The store write happens exactly once on mouseup.

---

### 7.3 Drag Flow

**Trigger:** mousedown directly on an existing shape in pan mode.

#### Step by step

1. **mousedown on shape** → `handleMouseDown` (CanvasNative) or `handleShapeMouseDown` (DOM renderer):
   - Hit-tests to find the shape under the cursor (CanvasNative: manual AABB loop; DOM: event bubbles from the shape's own `onMouseDown`).
   - Records the start state in world space:
     ```typescript
     dragRef.current = {
       id: shape.id,
       startCursorX: e.clientX,   // screen space
       startCursorY: e.clientY,
       startShapeX: shape.x,      // world space
       startShapeY: shape.y,
       lastDx: 0, lastDy: 0,      // world-space deltas, updated each move
     };
     ```
   - Immediately commits a zIndex increment to the store so the shape renders on top:
     ```typescript
     updateShapes(prev => {
       const maxZ = prev.reduce((m, s) => Math.max(m, s.zIndex), 0);
       return prev.map(s => s.id === id ? { ...s, zIndex: maxZ + 1 } : s);
     });
     ```

   In the **DOM renderer**, the shape's DOM element also gets `will-change: transform` and a `dragging` CSS class applied imperatively (thicker border, shadow).

2. **mousemove** → `handleMouseMove`:
   ```typescript
   // Divide screen delta by zoom → world-space delta
   dragRef.current.lastDx = (e.clientX - startCursorX) / zoom;
   dragRef.current.lastDy = (e.clientY - startCursorY) / zoom;
   scheduleRender();
   ```
   In `render()`, the dragged shape is skipped in the normal paint pass, then drawn last (on top) at `startShapeX + lastDx`, `startShapeY + lastDy` with a white border to indicate active drag.

   In the **DOM renderer**: `el.style.transform = 'translate(dx, dy)'` is applied directly — no React, no store.

3. **mouseup** → `handleMouseUp`:
   - Commits the final world-space position:
     ```typescript
     updateShapes(prev => prev.map(s =>
       s.id === id
         ? { ...s, x: startShapeX + lastDx, y: startShapeY + lastDy }
         : s
     ));
     ```
   - Clears `dragRef.current`.
   - In the DOM renderer: removes `transform`, `will-change`, and `dragging` class from the element.

#### Why divide by zoom
Screen delta / zoom = world delta. Without this correction, dragging at zoom=2 would move the shape at double the cursor speed — the shape would appear to slide out from under the cursor.

#### Performance
The store is written **twice** per drag: once on mousedown (zIndex) and once on mouseup (final position). During the entire drag motion — which can be hundreds of mousemove events — no state is written anywhere. Only `dragRef.lastDx/lastDy` are mutated and the canvas is redrawn per frame.

---

### 7.4 Zoom Flow (CanvasNative only)

**Trigger:** scroll wheel on the canvas element.

#### Step by step

1. **wheel event** → `handleWheel` (registered with `{ passive: false }` to allow `preventDefault`):

   a. Compute new zoom level:
   ```typescript
   const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;  // scroll up = zoom in
   const newZoom = clamp(oldZoom * factor, MIN_ZOOM=0.05, MAX_ZOOM=20);
   ```
   Multiplicative steps (10% per tick) give perceptually uniform zoom — the same number of scroll ticks takes you from 1× to 2× as from 2× to 4×.

   b. Adjust offset to keep the world point under the cursor fixed:
   ```typescript
   const ratio = newZoom / oldZoom;
   offset.x = cursor.x - (cursor.x - offset.x) * ratio;
   offset.y = cursor.y - (cursor.y - offset.y) * ratio;
   ```
   **Derivation:** The world point under the cursor must satisfy:
   ```
   screen = offset + world × zoom
   world  = (screen − offset) / zoom
   ```
   After zoom, for the same world point to appear at the same screen position:
   ```
   world_old = (cursor − oldOffset) / oldZoom
   newOffset = cursor − world_old × newZoom
             = cursor − (cursor − oldOffset) × (newZoom / oldZoom)
   ```

   c. Commit and redraw:
   ```typescript
   zoomRef.current = newZoom;
   scheduleRender();
   ```

2. **render()** applies `ctx.scale(zoom, zoom)` after the translate, so all subsequent shape draws are automatically in the right screen position.

#### Line width correction
`ctx.scale(zoom, zoom)` scales everything — including stroke width. A `lineWidth = 2` at zoom=3 would render as 6px on screen. To keep borders visually constant:
```typescript
ctx.lineWidth = 2 / zoom;
```
This cancels out the scale factor, giving a consistent 2px border at all zoom levels.

#### Performance
Zoom **never touches the store**. `zoomRef` and `canvasOffsetRef` are mutated, `scheduleRender()` queues one canvas frame. The entire zoom interaction is zero React renders.

---

## 8. Performance Design

The central principle: **React state is expensive; refs and imperative DOM/canvas writes are cheap**. The architecture separates "data that drives React renders" from "data that changes every frame".

### The two-tier update model

| Tier | Mechanism | When used |
|---|---|---|
| **Committed state** | Zustand store → React re-render | Shape added, shape position finalised, mode changed |
| **In-flight state** | Ref mutation + canvas redraw / DOM write | Every mousemove during pan, drag, draw, and zoom |

A drag interaction may produce 300 mousemove events between mousedown and mouseup. Without this separation, each event would trigger a React re-render and cause all shapes to be re-processed by the reconciler.

### requestAnimationFrame throttling

`scheduleRender()` in CanvasNative:
```typescript
const scheduleRender = () => {
  if (rafRef.current !== null) return;   // already scheduled, skip
  rafRef.current = requestAnimationFrame(() => {
    rafRef.current = null;
    render();
  });
};
```
On a 1000 Hz mouse at 60 fps display, ~16 mousemove events arrive per frame. Without this throttle, each would call `render()` redundantly. The rAF guard means only the **last** event's data is drawn, once per frame, at the display's natural refresh rate.

The actual pending bounds (`drawRef.pendingX/Y/W/H`) and drag delta (`dragRef.lastDx/Dy`) are updated on every mousemove — data is always current — but the canvas draw is deferred to the next frame boundary.

### Stale closure avoidance

Event handlers registered with `useCallback` and attached once via `useEffect` cannot close over React state directly, because state captured at registration time becomes stale as the store updates. Two strategies are used:

1. **`useCanvasStore.getState()`** — synchronous read of current Zustand state without subscribing. Used anywhere a handler needs the latest `mode` or `shapes` without causing the handler itself to be recreated:
   ```typescript
   const handleMouseDown = useCallback((e) => {
     const { mode } = useCanvasStore.getState();  // always current
     ...
   }, []);  // no mode dependency — handler never recreated
   ```

2. **Refs as mirrors** — in the DOM renderer (`useCanvasInteractions`), `canvasOffsetRef` mirrors the pan offset. The handlers read `canvasOffsetRef.current` rather than closing over a state variable.

### DOM renderer specific: per-shape isolation

In `Canvas.tsx`, each shape is a `React.memo`-wrapped `ShapeItem`. During a drag:
- Only the dragged shape gets a new object reference in the store (zIndex increment on mousedown, position commit on mouseup).
- `React.memo` ensures all other shapes are skipped during reconciliation.
- Visual movement during the drag is applied with `element.style.transform` directly on the DOM node — React never sees it.
- `will-change: transform` is set imperatively on drag start and removed on drag end, promoting the element to its own GPU compositing layer only for the duration of the drag.

### Canvas renderer specific: z-order draw loop

The canvas renderer cannot skip drawing shapes (unlike DOM where unchanged divs are untouched by React). Every frame it redraws all shapes. To maintain correct stacking:
```typescript
const sorted = [...shapes].sort((a, b) => a.zIndex - b.zIndex);
for (const shape of sorted) {
  if (dragRef.current?.id === shape.id) continue;  // draw last
  drawShape(ctx, shape, ...);
}
// draw dragged shape last → always on top visually
if (dragRef.current) drawShape(ctx, draggedShape, dragged_x, dragged_y, isDragging=true);
```
Skipping and redrawing the dragged shape last is equivalent to the `zIndex: maxZ + 1` applied in the store, but at draw time without requiring a sort re-run.

---

## 9. Minimap

**File:** `src/components/Minimap.tsx`

A 15% × 15% viewport-sized overview widget, fixed to the bottom-right corner. Draggable to reposition.

### How it renders

1. **Content bounds** are calculated from the shapes array:
   - Iterates all shapes to find `minX`, `maxX`, `minY`, `maxY`.
   - Adds 200px padding on all sides.
   - Expands to include the current viewport area (read from `canvasOffsetRef` — the viewport in world space spans `[-offset.x, -offset.x + viewportWidth]`).
   - Falls back to a 3× viewport area when no shapes exist.

2. **Scale factor:**
   ```typescript
   const minimapScale = Math.min(
     minimapSize.width / contentBounds.width,
     minimapSize.height / contentBounds.height
   );
   ```
   Fits all content within the minimap box while preserving aspect ratio.

3. **Shape rendering:** Each shape maps to a small `<div>` positioned with:
   ```typescript
   left: (shape.x - contentBounds.minX) * minimapScale
   top:  (shape.y - contentBounds.minY) * minimapScale
   width:  shape.width  * minimapScale
   height: shape.height * minimapScale
   ```

### Why canvasOffsetRef instead of a store value

The minimap re-renders only when `shapes` changes (Zustand subscription). If the viewport position were in the store, every pan frame would re-render the minimap — 60 times/second. Instead, `canvasOffsetRef` is passed by reference: on the **next** shapes-triggered render, the minimap reads the current offset from the ref and includes the viewport in its content bounds calculation. The minimap's viewport indicator is therefore only updated when shapes change, not on every pan frame.

---

## 10. Toolbar

**File:** `src/components/Toolbar.tsx`

Two buttons, each reading directly from the Zustand store:

| Button | Action |
|---|---|
| **Reset** | `resetCanvas()` — sets `shapes: []`, keeping mode unchanged |
| **Create** | `setMode('draw')` — switches to draw mode; automatically returns to `'pan'` when the next shape is completed (or on mouseup in CanvasNative) |

`memo()` wraps the component so it only re-renders if its store subscriptions change. Since it subscribes to `setMode` and `resetCanvas` (action references, stable forever), it effectively **never re-renders** after mount.
