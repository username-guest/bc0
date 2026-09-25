# ADR 0004 — Image generation / editing provider

Status: accepted · Date: 2026-09-18

## Context
§4 Stage C needs a convincing decorated proof. §11 notes Anthropic models do not generate
images, so AI Lifestyle renders call a third-party reference-conditioned image-editing/inpainting
model, and asks us to "confirm the current best model at build time" and keep the interface
stable. The model landscape moves fast and post-dates this author's knowledge cutoff.

## Decision
1. **Brand-Exact mode does not use a generative model at all.** It is deterministic compositing:
   perspective-warp the *actual* logo pixels onto the detected zone mask, then apply a per-method
   material shader (embroidery = raised-thread bevel + texture; screen = flat matte; laser =
   monochrome etch; sublimation = full-bleed dye; deboss = recessed). Implemented with a raster
   pipeline (e.g. sharp/canvas). This is the default proof and the core-loop "wow" — so the
   critical path has **zero external-model dependency**.
2. **AI Lifestyle mode** is the only consumer of `ImageGenerationProvider`, an interface taking
   `{ logoRef, zoneMask, brandHexes, method, scenePrompt }` and returning an image reference,
   with an explicit instruction to preserve the passed brand hex values.
3. **Adapter selection by config** (`IMAGE_PROVIDER`). Candidate real adapters as of the author's
   cutoff: FLUX-based inpainting via fal.ai or Replicate, Google Gemini image editing, OpenAI
   image edit. **The specific model MUST be confirmed and benchmarked at wire-up time** — this is
   recorded as an open task, not decided from stale memory. Until then, `IMAGE_PROVIDER=mock`
   ships a working deterministic placeholder so the rest of the app is fully functional (§17).

## Consequences
+ Core loop is resilient: a proof renders even with no image API configured.
+ Swapping/benchmarking models is an adapter change behind a stable interface.
− AI Lifestyle quality is unproven until a real adapter is benchmarked (tracked open task).
