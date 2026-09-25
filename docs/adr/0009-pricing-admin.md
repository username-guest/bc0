# ADR 0009 — Pricing admin: per-tenant rates, validation, live preview, prospect-safe breakdowns

**Status:** Accepted · **Date:** 2026-09-23

## Context
Distributors price differently: their own margins, fees and decorator costs. The engine already
took a per-tenant config for markups and fees, but the per-method decoration rate tables were one
global constant (`PLACEHOLDER_RATES`), despite a comment saying admins could edit them. There was
no way to change any of it without a database edit.

Building the preview surfaced a worse problem: prospects were shown the distributor's internal
breakdown, blank cost and margin included.

## Decisions

1. **Rates are part of the tenant's pricing config.** `TenantPricingConfig.rates` holds every rate
   the nine decoration modules use, in integer cents. Each module now receives the rates as a
   parameter instead of reading a global. A config without `rates` prices exactly as before (the
   placeholder tables), and `resolveRates` fills any method missing from older saved data. Saving
   from the admin always stores the full table.

2. **The disclaimer says whose rates they are.** Quotes from the placeholder tables keep the
   "placeholder rate tables" disclaimer. Once a distributor has entered its own rates it becomes
   "Estimated pricing from this distributor's rate tables…". Either way every price stays labelled
   an estimate.

3. **Validation rebuilds the config.** `validatePricingConfig` constructs a new object field by
   field, so unknown keys (including `__proto__`) never reach storage. It checks integer cents
   within bounds (setup ≤ $5,000, per-item ≤ $500, fees ≤ $1,000), catching the classic slip of
   typing dollars into a cents field. Markups must be 0–400%, screen-print tiers 1–12 with strictly
   increasing quantities, categories must exist in the tenant's catalog, and rush must carry the
   value its mode needs. The currency is kept as is: changing it would need price conversion.
   Errors come back keyed by field path (`rates.screen_print.runByBreak.2.minQty`) so the form can
   flag the exact input. Likely typos (a higher quantity tier costing more, a larger print costing
   less, markup under 15%) are warnings that never block a save.

4. **Who can do what.** Pricing needs the Starter plan (`admin_pricing_config`), enforced by the
   API. Any admin can view pricing and use the preview; only the owner can save, because margins
   are commercially sensitive. Saves are audited with a readable summary, e.g.
   "blank markup 40% → 80%; rates: Screen Printing".

5. **Live preview before saving.** `POST /admin/settings/pricing/preview` validates an unsaved
   config and prices every product at a sample order (quantity, logo colours) through the same
   catalog search the storefront uses, beside today's prices. It stores nothing. The UI calls it
   as the owner types (debounced), so validation errors and price changes appear before saving.

6. **Prospects see selling prices only (bug fix).** The storefront catalog sent every item's
   internal quote lines ("Blanks @ break 144", "Margin"), revealing the distributor's supplier cost
   and markup, and ignored the "show breakdown" setting. Quote confirmations did the same.
   `prospectLines` now builds the prospect's breakdown: one "Products" line at the selling price
   (blanks + margin), decoration setup and run, and fees. The lines still sum to the total, and a
   "144 × $x" label appears only when it multiplies out exactly (a rounded unit price would not add
   up). With "show breakdown" off, prospects get totals only. The full internal breakdown still goes
   to the distributor's lead record and CRM, where it belongs.

7. **Money in the UI is dollars; the API is cents.** Inputs parse dollars and send integer cents
   (unparseable input is sent as null so the server flags it). Markups are entered as percentages
   and shown with their gross-margin equivalent ("80% markup = 44.4% gross margin"), because the two
   are routinely confused.

## Consequences
- Pricing changes apply to the storefront on its next request (other app instances within the 5 s
  directory cache TTL), including prices in the PDF leave-behind and new quote requests.
- The admin edits rates only for methods on the tenant's plan; others are preserved as saved.
- Currency stays USD and labels format dollars; multi-currency needs its own design.
- The Postgres save path (`updatePricingConfig`, an upsert on `tenant_settings`) is written but only
  the in-memory path is exercised in this sandbox.

## Verification
- `src/pricing/tenant-rates.test.ts` (10): unchanged prices without rates, tenant rates per method,
  disclaimer switch, `resolveRates` fallback, prospect lines never showing cost/margin and summing
  to the total (incl. a non-divisible unit price), validation by field path, rebuilt object (no
  unknown keys, no prototype pollution, currency fixed), rush modes, warnings.
- `src/server/admin.test.ts` (+6): plan gate, staff view/preview but no save, preview with unsaved
  values stores nothing, a save reaching storefront prices and disclaimer, stored config is the
  validated rebuild, audit summary, catalog never exposing cost/margin and hiding the breakdown
  when asked, field-level rejection. `src/server/leads.test.ts`: quote confirmation shows selling
  prices while the CRM copy keeps the internal lines.
- 13 targeted mutations (owner-only save, plan gate, storing raw input, fractional cents, tier
  order, editable currency, engine ignoring tenant rates, disclaimer, catalog leaking internal
  lines, breakdown setting ignored, quote response leaking margin, fees dropped, rounded unit
  shown) each fail at least one test.
- `npm run e2e:admin` (+10 checks, 38 total): preview of every product, margin equivalent, change
  visible before saving, field-level error, prospect-safe breakdown, save reaching the storefront,
  disclaimer switch, staff read-only, Free plan upgrade note, mobile layout.
- Screenshot review found the mobile pricing page 25 px too wide. The overflow check had missed it
  because in mobile emulation the layout viewport grows to fit oversized content; both browser
  suites now measure against the device width and name the elements that stick out.
