# ADR 0005 — Brand-Exact renderer, product templates, and local codec

**Status:** Accepted · **Date:** 2026-09-22

## Context
The core loop (§3.3) must show a prospect's logo on products *accurately* — right colours, right
place, and honest about what each decoration method can physically produce. ADR 0004 already
decided Brand-Exact needs no image model. This ADR fixes *how* it is built.

## Decision
1. **Pure-TypeScript raster pipeline** (`src/imaging`): RGBA buffers, premultiplied resampling,
   deterministic output (identical inputs → identical bytes → cacheable by content hash).
2. **Per-method shaders** in `compose.ts` encode physical constraints: spot methods snap every
   pixel to extracted brand inks; sublimation multiplies into the substrate and drops white;
   laser is a single substrate-derived tone; deboss is blind. The renderer also emits user-facing
   notes (e.g. WCAG-contrast legibility warnings) alongside the image.
3. **Template contract** = body mask + shading map + fixed parts + authored zones.
   Colourway = colour × shading. Procedural templates stand in for photography today; a real
   photo plugs in by supplying the same four things, with no downstream change.
4. **Confidence gate**: proofs render only for authored zones or vision zones ≥ 0.75; otherwise
   `needs_placement` and **no image** (§17).
5. **Local PNG codec** on `node:zlib` behind an `ImageCodec` seam. A `sharp` adapter will add
   JPEG/WebP/SVG/PDF; until then those uploads fail with a typed `decoder_unavailable` error.
6. **Background removal is conservative**: uniform backgrounds only; enclosed background-coloured
   areas are *reported*, not guessed; non-uniform backgrounds return `confidence: 'low'`.

## Consequences
+ Core loop runs with zero external services and is fully unit-testable.
+ Proofs are reproducible, so the render cache is just a content-addressed blob store.
− Rendering costs ~0.1–0.5 s per proof on one core: fine inline for one proof, but catalog-wide
  propagation belongs in the pg-boss worker (Phase 4 orchestration).
− Flat-perspective placement: no warping onto curved surfaces (tumbler wrap is approximated).
  A displacement-map extension to the template contract is the planned upgrade.
