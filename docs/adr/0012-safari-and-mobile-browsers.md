# ADR 0012 — Safari and mobile browser support

**Status:** Accepted · **Date:** 2026-09-24 · Amends ADR 0008 (admin cookies)

## Context
Distributor reps and their prospects use iPhones heavily. Everything had been tested in Chromium
only, and several Safari behaviours differ in ways Chromium never shows.

## Decisions
1. **Support floor: Safari / iOS Safari 15.4** (March 2022). The admin uses `structuredClone`; the
   CSS uses `overflow-wrap: anywhere`, `:focus-visible` and `accent-color`. Browser-side code has no
   syntax that would stop the bundle loading in older Safari (no regex lookbehind, no non-ISO date
   parsing); a scan of all `'use client'` code confirmed it.
2. **`Secure` cookies follow the real scheme, not NODE_ENV.** Safari drops `Secure` cookies on plain
   http, `localhost` included; Chrome exempts localhost. With `NODE_ENV=production` over
   `http://localhost` (the README's and smoke test's own setup), every Safari sign-in silently
   failed. `cookiesSecure()`: `PUBLIC_BASE_URL`'s scheme when set, otherwise production ⇒ Secure
   (production tenant hosts are https).
3. **Text fields are 16px+ on phones and touch devices.** iOS Safari zooms into any field under
   16px on focus and doesn't zoom out. One CSS floor (`!important`, because dense forms set 14px
   with more specific selectors) under `(max-width: 899px), (pointer: coarse)`. Desktop keeps
   compact sizes.
4. **No hidden sideways scrolling on phones.** Scroll-within-a-box layouts hid a "Remove" button
   (pricing tiers) and the "Needs attention" filter. The tier table now fits the width with a ×
   button (still "Remove tier N" to screen readers); the inbox filters wrap.
5. **Enforced by the browser suites**, not by review: both measure every visible field's font size
   and fail on any element past the 390px edge, even inside a scrolling box.
   `E2E_BROWSER=webkit|firefox` runs either suite in another engine; `npm run e2e:safari` runs both
   in WebKit.

## Consequences
- Both suites pass in WebKit 26.6 (Playwright on Linux; storefront 29/29, admin 55/55), the same
  checks as Chromium. That is Safari's engine but not Safari itself; a final check in Safari on an
  iPhone before launch is still worthwhile.
