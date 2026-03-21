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
   - [Two-tier update model](#the-two-tier-update-model)
   - [rAF throttling](#requestanimationframe-throttling)
   - [Stale closure avoidance](#stale-closure-avoidance)
   - [Sorted shapes array](#sorted-shapes-array-no-per-frame-sort)
   - [Viewport culling](#viewport-culling)
   - [Color picking hit test](#color-picking-hit-test-o1)
   - [Picking dirty flag](#picking-dirty-flag)
   - [Zustand subscribe — no React re-render](#zustand-subscribe--no-react-re-render-on-shapes-change)
   - [DOM renderer specifics](#dom-renderer-specific-per-shape-isolation)
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
  id: string;       // "shape-<timestamp>", unique per session
  type: 'rectangle';
  x: number;        // world-space left edge
  y: number;        // world-space top edge
  width: number;    // world-space width
  height: number;   // world-space height
  color: string;    // hex color string
  zIndex: number;   // paint order, higher = on top; always increases
}
```

All positions are stored in **world space** — independent of the current pan offset or zoom level. The renderer applies the transform at draw time.

**ID generation:** `shape-${Date.now()}` at draw-start (mousedown). Millisecond precision is sufficient since a full mousedown→mouseup cycle is required per shape. Use `crypto.randomUUID()` for stricter uniqueness guarantees.

---

## 4. State Management

**File:** `src/store/canvasStore.ts`

```typescript
interface CanvasState {
  shapes: Map<string, Shape>;  // insertion-order = zIndex order; O(1) lookup by id
  maxZIndex: number;           // current maximum zIndex
  mode: 'pan' | 'draw';

  addShape(shape: Shape): void;
  updateShape(id: string, updates: Partial<Shape>): void;
  setMode(mode: Mode): void;
  resetCanvas(): void;
}
```

Built with **Zustand**.

### Why Zustand
- Components subscribe to only the slices they need, so unrelated changes don't cause re-renders.
- `useCanvasStore.getState()` gives synchronous access to the latest state inside event handlers **without subscribing** — the primary way high-frequency handlers avoid stale closures without recreating on every state change.
- `useCanvasStore.subscribe()` lets non-React code (imperative canvas redraws) react to state changes without triggering a React render at all.

### One structure, two roles

`shapes: Map<string, Shape>` replaces the previous `shapes: Shape[]` + `shapesById: Record<string, Shape>` pair.

| Operation | Mechanism | Complexity |
|---|---|---|
| Lookup by id | `shapes.get(id)` | O(1) |
| Render iteration | `shapes.values()` in insertion order | O(n) |
| Add shape | `shapes.set(id, shape)` | O(1) |
| Update position | `shapes.set(id, updated)` — preserves insertion order | O(1) |
| Update zIndex (bring to front) | `shapes.delete(id); shapes.set(id, updated)` — moves to end | O(1) |
| Max zIndex | `maxZIndex` field | O(1) |

Previously `updateShape` was O(n) — it had to `Array.filter` or `Array.map` over all shapes plus spread a full `shapesById` object copy. Now every mutation is O(1).

### Maintaining sort order
`zIndex` only ever increases (always assigned `maxZIndex + 1`). JavaScript `Map` preserves insertion order by spec. So:
- `addShape` — `map.set(id, shape)` appends to end (always the highest zIndex).
- `updateShape` with new zIndex — `map.delete(id); map.set(id, updated)` moves the entry to the end.
- `updateShape` position-only — `map.set(id, updated)` overwrites in-place, order unchanged.

`render()` calls `shapes.values()` directly — no sort ever runs at draw time.

### What is NOT in the store
Pan offset, zoom level, and all in-progress interaction data live in **refs** — not in the store:

| Data | Where | Why |
|---|---|---|
| `canvasOffsetRef` | ref | Mutated every mousemove frame — store would trigger 60+ renders/sec |
| `zoomRef` | ref | Same reason |
| `dragRef`, `panRef`, `drawRef` | refs | Transient; only the final committed result belongs in the store |
| Picking canvas state | refs | Renderer implementation detail, not app state |

---

## 5. Two Canvas Implementations

### Canvas.tsx — DOM Renderer
Uses a `<div>` tree. Each shape is its own `<div>` (`ShapeItem`). The canvas-content div is translated via `style.transform`.

- **Strengths:** Each shape is its own DOM node — React's reconciler handles individual shape updates efficiently. `React.memo` prevents unmodified shapes from re-rendering during drag.
- **Drag technique:** CSS `transform: translate(dx, dy)` applied imperatively to the dragged DOM element, bypassing React entirely until mouseup.
- **Draw preview:** A zero-size `<svg overflow="visible">` containing a `<rect>`. SVG geometry attribute changes (`x`, `y`, `width`, `height`) don't trigger HTML layout — unlike `style.width/height` on a div.
- **Hit testing:** Free — browser routes events to the correct div automatically.
- **No zoom support.**

### CanvasNative.tsx — HTML Canvas Renderer (active)
Uses a single `<canvas>` element. Everything is drawn imperatively via the 2D Context API.

- **Strengths:** Single `clearRect` + redraw loop. Zoom via `ctx.scale`. No DOM nodes per shape means no layout/style-recalc overhead at any scale.
- **Hit testing:** Manual — requires color picking (see §8).
- **Zoom support:** Full scroll-wheel zoom with zoom-toward-cursor math.

---

## 6. Coordinate System

Two spaces are used throughout:

### Screen space (client coordinates)
Raw pixel coordinates from mouse/touch events (`e.clientX`, `e.clientY`). Origin at the top-left of the browser viewport.

### World space
The infinite canvas coordinate system. All shape data is stored here.

### The transform
```
screen = offset + world × zoom
world  = (screen − offset) / zoom
```

- `canvasOffsetRef.current` — where world origin maps to on screen.
- `zoomRef.current` — current zoom level (default `1`).

**`toWorld` helper:**
```typescript
const toWorld = (screenX, screenY) => ({
  x: (screenX - offset.x) / zoom,
  y: (screenY - offset.y) / zoom,
});
```

Used at draw start, draw move, and hit testing — anywhere a mouse position needs to become a world position.

**In render:**
```typescript
ctx.translate(offset.x, offset.y);
ctx.scale(zoom, zoom);
// draw shapes at their world-space x, y
```

---

## 7. Interaction Flows

### 7.1 Pan Flow

**Trigger:** mousedown on empty canvas area in pan mode, or single-finger touch.

1. **mousedown** → no shape at cursor → `panRef.current = { lastX, lastY }`, cursor `grabbing`.
2. **mousemove** → accumulate delta into `canvasOffsetRef`, mark picking dirty, `scheduleRender()`.
3. **mouseup** → `panRef.current = null`, cursor `grab`.

**Zero store writes.** Pan lives entirely in `canvasOffsetRef`.

---

### 7.2 Draw Flow

**Trigger:** "Create" button → mode `'draw'` → mousedown on canvas.

1. **mousedown** → convert cursor to world coords via `toWorld`, populate `drawRef.current` with start position, assigned id and color.
2. **mousemove** → update `drawRef.current.pending*` bounds each event; `scheduleRender()` queues one canvas draw per frame showing the dashed preview rect.
3. **mouseup**:
   - Rejects if `w ≤ 5 || h ≤ 5` (accidental click).
   - Calls `addShape({ ..., zIndex: maxZIndex + 1 })` — **one store write**.
   - Calls `setMode('pan')` — returns to pan mode automatically.

**One store write** on mouseup. Nothing written during drag.

---

### 7.3 Drag Flow

**Trigger:** mousedown on an existing shape in pan mode.

1. **mousedown on shape** → `getShapeAt` returns the shape via color picking (O(1)):
   - Populates `dragRef.current` with start cursor and start world position.
   - Calls `updateShape(id, { zIndex: maxZIndex + 1 })` — **first store write** (bring to front, moves shape to end of sorted array).

2. **mousemove**:
   ```typescript
   dragRef.current.lastDx = (e.clientX - startCursorX) / zoom;  // world-space delta
   dragRef.current.lastDy = (e.clientY - startCursorY) / zoom;
   scheduleRender();
   ```
   In `render()`, the dragged shape is skipped in the main loop then drawn last at `startShapeX + lastDx/Dy` with a white border. **No store writes.**

3. **mouseup** → `updateShape(id, { x: startShapeX + lastDx, y: startShapeY + lastDy })` — **second store write** (commit final position).

**Two store writes total** per drag (mousedown + mouseup). Hundreds of mousemove events produce zero store writes.

#### Why divide delta by zoom
Screen delta / zoom = world delta. Without this, dragging at zoom=2 would move the shape at double cursor speed.

---

### 7.4 Zoom Flow (CanvasNative only)

**Trigger:** scroll wheel (`{ passive: false }` to allow `preventDefault`).

1. Compute new zoom: `oldZoom × 1.1` (in) or `× 1/1.1` (out), clamped to `[0.05, 20]`.
2. Adjust offset to keep the world point under the cursor stationary:
   ```
   newOffset = cursor − (cursor − oldOffset) × (newZoom / oldZoom)
   ```
3. Update `zoomRef`, mark picking dirty, `scheduleRender()`.

**Zero store writes.**

#### Line width correction
`ctx.scale(zoom)` scales stroke width too. `lineWidth = 2 / zoom` cancels this out — borders are always 2px on screen regardless of zoom level. Same applied to dash pattern.

---

## 8. Performance Design

The central principle: **React renders are expensive; ref mutations and imperative canvas draws are cheap.** The architecture strictly separates "data that must drive React renders" from "data that changes every frame."

---

### The two-tier update model

| Tier | Mechanism | Frequency |
|---|---|---|
| **Committed state** | `addShape` / `updateShape` → Zustand → React | Once per interaction (mousedown or mouseup) |
| **In-flight state** | Ref mutation + `scheduleRender()` | Every mousemove / wheel event |

---

### requestAnimationFrame throttling

`scheduleRender()` guarantees at most one canvas redraw per display frame:
```typescript
if (rafRef.current !== null) return;   // already queued
rafRef.current = requestAnimationFrame(() => {
  rafRef.current = null;
  render();
});
```
On a 1000 Hz mouse at 60 fps, ~16 mousemove events arrive per frame. Without this guard, each would call `render()`. Instead, `drawRef`/`dragRef` are updated on every event (data always current), but the draw is batched to the next frame boundary.

---

### Stale closure avoidance

Handlers registered once via `useEffect` cannot close over React state — it becomes stale. Two strategies:

1. **`useCanvasStore.getState()`** — synchronous read of the current store state, no subscription:
   ```typescript
   const handleMouseDown = useCallback((e) => {
     const { mode, maxZIndex } = useCanvasStore.getState();
     ...
   }, []);  // empty deps — handler is stable forever
   ```

2. **Refs** — `canvasOffsetRef`, `zoomRef`, `dragRef`, etc. are always current because they're mutated in-place, not re-assigned.

---

### Sorted Map — no per-frame sort

`shapes: Map<string, Shape>` is maintained in zIndex order as an invariant (see §4). Since zIndex only ever increases:
- `addShape` — `map.set` appends to end.
- `updateShape` with new zIndex — `map.delete` + `map.set` moves to end.

`render()` calls `shapes.values()` directly — **no sort, no array copy per frame.** Previously this was O(n log n) sort + O(n) array copy on every frame.

---

### Viewport culling

Before drawing any shape, `isVisible()` checks if its AABB intersects the current viewport in world space:

```typescript
const viewMinX = -offsetX / zoom;
const viewMaxX = viewMinX + canvasW / zoom;
// same for Y...
return shape.x + shape.width > viewMinX && shape.x < viewMaxX && ...
```

Applied in both `render()` and `renderPicking()`. Shapes entirely outside the viewport are skipped — constant time per shape, significant saving when panned far from a dense cluster.

---

### Color picking hit test — O(1)

The `<canvas>` API has no event routing per shape. The naive approach — iterating all shapes in reverse zIndex order to find which one contains the click — is O(n).

**Solution:** a hidden offscreen canvas rendered with one solid unique color per shape. On mousedown, `getImageData(x, y, 1, 1)` reads the single pixel under the cursor and decodes it back to a shape id.

```
integer pickingId → rgb(r, g, b)    encode: r=(id>>16)&0xff, g=(id>>8)&0xff, b=id&0xff
pixel rgba        → integer pickingId    decode: (r<<16)|(g<<8)|b
pickingId         → shapeId              O(1) Map lookup
shapeId           → Shape                O(1) shapesById[id]
```

The offscreen canvas uses `willReadFrequently: true` at context creation so the browser optimises the backing store for `getImageData`.

**Why a separate canvas?** The main canvas uses `globalAlpha`, strokes, and anti-aliasing — all of which corrupt the pixel color. The picking canvas draws shapes as opaque solid fills only, so every pixel decodes cleanly.

---

### Picking dirty flag

The picking canvas only needs to be current at mousedown time, not on every frame. A `pickingDirtyRef` boolean tracks whether a redraw is needed:

```typescript
// Marked true when:
//   - shapes change (added, moved, reset)   ← useCanvasStore.subscribe
//   - pan offset changes                    ← handleMouseMove pan branch
//   - zoom changes                          ← handleWheel
//   - canvas resized                        ← resize handler

// renderPicking() skips the draw if false, sets to false after drawing.
```

A series of rapid clicks with no movement between them redraws the picking canvas exactly once.

---

### Zustand subscribe — no React re-render on shapes change

`CanvasNative` needs to redraw when shapes change, but its JSX output (`<canvas>`, `<Minimap>`) doesn't depend on `shapes` at all. Subscribing via `useCanvasStore(state => state.shapes)` would cause a full React component re-render on every shape commit — just to call an imperative function.

**Solution:** `useCanvasStore.subscribe()` instead:
```typescript
useEffect(() => {
  return useCanvasStore.subscribe((state, prev) => {
    if (state.shapes === prev.shapes) return;  // new Map instance = changed
    // sync picking IDs, mark dirty, call render()
  });
}, [render]);
```

The `===` reference check works because every store update creates a `new Map(...)` — the reference changes even if the contents are the same shape.

The callback runs synchronously inside Zustand when the store updates — no React scheduler, no component re-render, no reconciliation. `CanvasNative` now only re-renders when `mode` changes (toolbar click or draw completion), which is rare.

---

### DOM renderer specific: per-shape isolation

In `Canvas.tsx` each shape is `React.memo`-wrapped. During drag:
- Only the dragged shape gets a new object reference (zIndex on mousedown, position on mouseup).
- All other `ShapeItem`s are skipped by the reconciler.
- Visual movement is `element.style.transform` — React never sees it.
- `will-change: transform` is set on drag start and removed on drag end — GPU layer only for the duration of the drag.

---

## 9. Minimap

**File:** `src/components/Minimap.tsx`

A 15% × 15% viewport-sized overview, fixed bottom-right, draggable.

### How it renders

1. **Content bounds** — iterates all shapes to find `minX/maxX/minY/maxY`, adds 200px padding, expands to include current viewport (read from `canvasOffsetRef`). Falls back to 3× viewport when no shapes exist.
2. **Scale factor** — `min(minimapW / boundsW, minimapH / boundsH)` to fit all content while preserving aspect ratio.
3. **Shape divs** — each shape is a `<div>` positioned at `(shape.x - minX) * scale`.

### Why canvasOffsetRef instead of a store value
Minimap re-renders when `shapes` changes (Zustand subscription). If viewport position were in the store, every pan frame would re-render it 60×/sec. `canvasOffsetRef` is passed by ref — on the next shapes-triggered render, Minimap reads the current offset directly from the ref, including the viewport in its bounds calculation with zero extra renders.

### Shapes already sorted
`shapes` from the store is maintained in zIndex order — Minimap iterates it directly with no sort.

---

## 10. Toolbar

**File:** `src/components/Toolbar.tsx`

| Button | Action |
|---|---|
| **Reset** | `resetCanvas()` — clears `shapes`, `shapesById`, `maxZIndex` |
| **Create** | `setMode('draw')` — mode returns to `'pan'` automatically on draw completion |

`memo()` wraps the component. It subscribes only to `setMode` and `resetCanvas` (stable action references) — effectively **never re-renders** after mount.
