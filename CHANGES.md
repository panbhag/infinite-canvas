# Infinite Canvas — Change Log

A chronological record of every change made to this codebase, grouped by theme.

---

## 1. Modularisation — break up monolithic App.tsx

**Before:** All state, interaction logic, and rendering lived inside a single `App.tsx` (~500+ lines).

**Changes:**

| What | File | Details |
|---|---|---|
| Created Zustand store | `src/store/canvasStore.ts` | Extracted all shape state and actions out of `App.tsx` |
| Created DOM canvas renderer | `src/components/Canvas.tsx` | Extracted the div-based rendering from `App.tsx` |
| Extracted shape item | `src/components/ShapeItem.tsx` | Single `React.memo`-wrapped shape div with callback ref |
| Extracted interaction hook | `src/hooks/useCanvasInteractions.ts` | Pan / draw / drag logic for the DOM renderer |
| Simplified Toolbar | `src/components/Toolbar.tsx` | Reads `setMode` / `resetCanvas` from store directly — no props |
| Updated Minimap | `src/components/Minimap.tsx` | Reads `shapes` from store directly — no props for shapes |
| Reduced App.tsx | `src/App.tsx` | Reduced to ~11 lines: compose `Toolbar` + active canvas |

---

## 2. Zustand store — initial version

**File:** `src/store/canvasStore.ts`

- `shapes: Shape[]` — single source of truth for all shape data
- `mode: 'pan' | 'draw'`
- Actions: `addShape`, `updateShape`, `setMode`, `resetCanvas`

---

## 3. HTML Canvas renderer — CanvasNative

**File:** `src/components/CanvasNative.tsx` (new)

Created a second canvas implementation using the HTML `<canvas>` API instead of DOM divs.

- Single `<canvas>` element; all shapes drawn imperatively via 2D Context API
- `ctx.translate(offsetX, offsetY)` + `ctx.scale(zoom, zoom)` applied each frame
- `requestAnimationFrame` throttle (`rafRef`) — at most one redraw per display frame
- Two-tier update model: refs for in-flight data, store for committed results
- `useCanvasStore.getState()` in handlers to avoid stale closures
- Touch support (single-finger pan, two-finger pinch-zoom)
- Draw preview rendered as a dashed rect directly on the canvas
- `App.tsx` switched to render `<CanvasNative>` instead of `<Canvas>`

---

## 4. Zoom support

Added scroll-wheel zoom to `CanvasNative`:

- `handleWheel` registered with `{ passive: false }` to allow `preventDefault`
- Zoom factor `×1.1` per tick, clamped to `[0.05, 20]`
- Zoom-toward-cursor math: `newOffset = cursor − (cursor − offset) × (newZoom / oldZoom)` — the world point under the cursor stays stationary
- `ctx.lineWidth = 2 / zoom` so borders remain 2 px on screen regardless of zoom level; same applied to dash pattern

---

## 5. Store optimisation — O(1) shape lookup

**Problem:** `shapes.find(s => s.id === id)` was O(n) on every drag move and `shapes.reduce()` was O(n) to find `maxZIndex` on every draw.

**Changes to `canvasStore.ts`:**

- Added `shapesById: Record<string, Shape>` — kept in sync alongside `shapes[]`
- Added `maxZIndex: number` — maintained as a running maximum, never recomputed

**Updated call sites:**
- `useCanvasInteractions.ts` — `shapesById[id]` instead of `shapes.find()`
- `CanvasNative.tsx` — `shapesById[id]` and `maxZIndex` instead of O(n) searches
- `updateShape` action renamed from `updateShapes` (plural), all call sites updated

---

## 6. Store refactor — consolidate to `Map<string, Shape>`

**Problem:** Every shape was stored twice — `shapes: Shape[]` for iteration and `shapesById: Record<string, Shape>` for lookup. Every `addShape`/`updateShape` had to keep both in sync, and both required O(n) copies on mutation (`Array.filter`/`Array.map` + object spread).

**Change:** Replaced both with a single `shapes: Map<string, Shape>`.

- `Map` preserves insertion order — iteration order stays zIndex-sorted (same invariant as before)
- `map.get(id)` — O(1) lookup, replaces `shapesById[id]`
- `map.set(id, updated)` — O(1) in-place update (position change), preserves order
- `map.delete(id); map.set(id, updated)` — O(1) move-to-end (zIndex change)

**Before vs after `updateShape`:**

| Case | Before | After |
|---|---|---|
| Position update | O(n) `Array.map` + O(n) object spread | O(1) `map.set` |
| zIndex update | O(n) `Array.filter` + O(n) object spread | O(1) `map.delete` + `map.set` |

**Updated call sites:**
- `CanvasNative.tsx` — `currentShapes.values()` for iteration, `currentShapes.get(id)` for lookup
- `Canvas.tsx` — `[...shapes.values()].map(...)` for JSX rendering
- `Minimap.tsx` — `shapes.size`, `shapes.values()` for bounds, `[...shapes.values()].map(...)` for JSX
- `useCanvasInteractions.ts` — `shapes.get(id)` instead of `shapesById[id]`

---

## 7. Color picking hit test — O(1)

**Problem:** Finding which shape is under the cursor on mousedown required iterating all shapes in reverse zIndex order — O(n).

**Solution:** Offscreen canvas color picking.

Added to `CanvasNative.tsx`:

- `offscreenRef` — a hidden `<canvas>` with `willReadFrequently: true`
- `pickingMapRef: Map<number, string>` — maps integer picking ID → shape string ID
- `shapeToPickingRef: Map<string, number>` — reverse map for sync
- `nextPickingIdRef` — monotonic integer counter, one per shape

On mousedown:
1. `renderPicking()` draws each shape as a solid opaque fill using its unique RGB-encoded picking ID
2. `getImageData(x, y, 1, 1)` reads the single pixel under the cursor
3. `decodePickingColor(r, g, b)` → integer picking ID → shape string ID → O(1) `shapesById` lookup

Encode/decode:
```
pickingId → rgb(r, g, b)    r=(id>>16)&0xff, g=(id>>8)&0xff, b=id&0xff
pixel rgb → pickingId       (r<<16)|(g<<8)|b
```

---

## 8. Picking dirty flag

**Problem:** `renderPicking()` was redrawing the entire offscreen canvas on every mousedown, even when nothing had changed.

**Change:** Added `pickingDirtyRef: boolean`.

- `renderPicking()` exits immediately if `!pickingDirtyRef.current`
- Flag set to `true` when: shapes change, pan offset changes, zoom changes, canvas resizes
- Flag set to `false` after a successful picking redraw

A series of rapid clicks with no movement redraws the picking canvas exactly once.

---

## 9. Viewport culling

**Problem:** All shapes were drawn every frame regardless of whether they were on screen.

**Change:** Added `isVisible(shape, offsetX, offsetY, zoom, canvasW, canvasH)` helper.

Converts the current viewport to world space and performs an AABB intersection check:
```typescript
const viewMinX = -offsetX / zoom;
const viewMaxX = viewMinX + canvasW / zoom;
// same for Y
return shape.x + shape.width > viewMinX && shape.x < viewMaxX && ...
```

Applied in both `render()` and `renderPicking()` — off-screen shapes are skipped entirely.

---

## 10. Spatial grid — replaced color picking and AABB loop

**Problem:**
- Color picking required a full offscreen canvas redraw on every scene change
- `isVisible()` loop still iterated all n shapes every frame to find visible ones
- Both approaches scale with total shape count rather than visible shape count

**Solution:** Replaced both with a sparse spatial grid (`src/utils/spatialGrid.ts`).

- World space divided into 500px cells — cells created lazily, deleted when empty
- Each shape registers in every cell its AABB overlaps on `insert`
- `query(minX, minY, maxX, maxY, result)` populates a reusable Set with ids of shapes in overlapping cells — only those shapes are drawn
- `getShapeAt` queries the grid at the cursor world position, then does an exact AABB test on candidates to find the topmost shape

**Removed entirely:**
- Offscreen canvas (`offscreenRef`)
- Picking ID maps (`pickingMapRef`, `shapeToPickingRef`, `nextPickingIdRef`)
- `pickingDirtyRef` dirty flag
- `renderPicking()` function
- `encodePickingColor` / `decodePickingColor` helpers
- `isVisible()` helper

**Hit test flow (new):**
```
mousedown → toWorld(cursor) → grid.query(wx, wy, wx, wy) → AABB test on candidates → topmost shape
```

---

## 11. Canvas context cached in ref

**Problem:** `canvas.getContext('2d')` was called on every `render()` invocation — once per frame.

**Change:** Added `ctxRef` — context obtained once on mount in the resize `useEffect`, reused every frame.

```typescript
ctxRef.current = canvas.getContext('2d');  // once
const ctx = ctxRef.current;                // every render()
```

---

## 12. Reusable Set for grid query — zero allocations per frame

**Problem:** `spatialGrid.query()` returned a `new Set<string>()` on every call — 60 allocations/sec at 60fps, causing GC pressure.

**Change:**
- `query()` signature changed to accept a caller-provided Set and populate it in-place (calls `result.clear()` first)
- `CanvasNative` keeps a persistent `visibleIdsRef = useRef(new Set<string>())` reused every frame
- `getShapeAt` uses a local Set (one-off call on mousedown — allocation there is fine)

---

## 13. Minimap converted to canvas

**Problem:** Minimap rendered one `<div>` per shape — 10,000 shapes = 10,000 DOM nodes with layout and style recalc on every update.

**Changes:**
- Replaced the inner div + per-shape divs with a single `<canvas>` element
- `render()` draws all shapes with `fillRect` — no DOM nodes per shape
- Subscribes imperatively via `useCanvasStore.subscribe()` — no React re-render on shape changes
- Bounds (minX/maxX/minY/maxY) computed O(n) inside the subscribe callback — only when shapes actually change, never on pan or every frame

---

## 14. Minimap render deferred to `requestIdleCallback`

**Problem:** Minimap redraws fired synchronously on every store update — competing with the main canvas during drag and draw interactions.

**Change:** Wrapped minimap `render()` in `requestIdleCallback` — browser schedules it during idle time, after the main canvas has finished its frame work.

- Previous pending idle callback is cancelled if a new store update arrives — only the latest redraw runs
- `src/utils/idleCallback.ts` added — `scheduleIdle`/`cancelIdle` wrappers with `setTimeout(0)` fallback for Safari

---

## 15. Sorted Map — no per-frame sort

**Problem:** `render()` was sorting the `shapes` array by `zIndex` on every frame — O(n log n) + O(n) copy.

**Change:** Made sort order an invariant of the store (maintained via `Map` insertion order).

- `zIndex` only ever increases (always assigned `maxZIndex + 1`)
- `addShape` — `map.set` appends to end, always the highest zIndex
- `updateShape` with new zIndex — `map.delete` + `map.set` moves to end
- `updateShape` position-only — `map.set` overwrites in-place, order unchanged

`render()` calls `shapes.values()` with no sort. Per-frame cost reduced from O(n log n) to O(n).

---

## 16. Zustand subscribe — no React re-render on shapes change

**Problem:** `CanvasNative` needed to redraw when shapes changed, but subscribing via `useCanvasStore(state => state.shapes)` caused a full React component re-render — just to call an imperative canvas function.

**Change:** Replaced the React hook subscription with `useCanvasStore.subscribe()`:

```typescript
useEffect(() => {
  return useCanvasStore.subscribe((state, prev) => {
    if (state.shapes === prev.shapes) return;
    // sync picking IDs, mark dirty, call render()
  });
}, [render]);
```

The callback runs synchronously inside Zustand — no React scheduler, no reconciler, no component re-render. `CanvasNative` now only re-renders when `mode` changes (toolbar click or draw completion).

---

## 17. tsconfig target change

**File:** `tsconfig.json`

Changed `"target"` from `"es5"` to `"es2015"`.

**Reason:** TypeScript `Map` iteration (`for...of map`) requires either `--downlevelIteration` or a target of ES2015+. The `pickingMapRef` / `shapeToPickingRef` Maps triggered a compile error on `es5`.

---

## 18. Architecture documentation

**File:** `ARCHITECTURE.md` (new)

Comprehensive document covering:
- File structure
- Data model and coordinate system
- Interaction flows: pan, draw, drag, zoom
- All performance decisions and the reasoning behind each:
  - Two-tier update model
  - rAF throttling
  - Stale closure avoidance
  - Sorted shapes array
  - Viewport culling
  - Color picking hit test
  - Picking dirty flag
  - Zustand subscribe

Updated incrementally as each optimisation was added.

---

## Summary of complexity improvements

| Operation | Before | After |
|---|---|---|
| Shape lookup by id | O(n) `Array.find` | O(1) `map.get(id)` |
| Max zIndex | O(n) `Array.reduce` | O(1) `maxZIndex` field |
| `updateShape` position | O(n) `Array.map` + O(n) object spread | O(1) `map.set` |
| `updateShape` zIndex | O(n) `Array.filter` + O(n) object spread | O(1) `map.delete` + `map.set` |
| Hit test (mousedown) | O(n) reverse scan → O(1) color picking | O(candidates) spatial grid + AABB |
| Render loop iteration | O(n) all shapes + AABB check per shape | O(k) visible shapes only via grid |
| Per-frame sort | O(n log n) + copy | Eliminated — Map insertion order |
| Per-frame Set allocation | New `Set` every frame (GC pressure) | Reused `visibleIdsRef` — zero allocs |
| `getContext('2d')` per frame | Every `render()` call | Cached once in `ctxRef` on mount |
| Picking canvas redraw | Every mousedown | Removed — replaced by grid |
| Minimap DOM nodes | One `<div>` per shape | Single `<canvas>`, `fillRect` per shape |
| Minimap bounds calculation | O(n) every React render | O(n) only when shapes change |
| Minimap redraw timing | Synchronous on every store update | Deferred to `requestIdleCallback` |
| React re-render on shapes | Every shape commit | Never (subscribe instead) |
