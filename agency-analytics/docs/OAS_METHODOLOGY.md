# OAS Methodology — Phase 2

## What we compute

For every callable new issue, we compute two Option-Adjusted Spreads (OAS):

| Field | Definition |
|---|---|
| `oas_at_par_bp` | OAS that prices the bond at **100.00** clean — what a buyer at par earns over the curve, net of optionality |
| `oas_at_cost_bp` | OAS that prices the bond at **100 − (fees ÷ size × 100)** — what the *desk* earns net of dealer fees (a.k.a. takedown) |
| `z_spread_bp` | Z-spread to the curve ignoring optionality — diagnostic only |

The gap between Z-spread and OAS is the call option value (in bp running). For deeply ITM calls (high coupon, low curve), this gap is large.

## Model

| Component | Choice | Why |
|---|---|---|
| Discount curve | Today's UST curve from FRED, linearly-interpolated zero curve | Most-used benchmark for agency callables |
| Short-rate model | Hull-White 1-factor | Industry standard for callable agency analytics; closed-form bond pricing on a tree |
| Mean reversion (a) | 3.0% | Conventional starting value for USD rates |
| Short-rate vol (σ) | 1.0% (100 bp) | Reasonable starting value; will be replaced by calibration to swaption vol when available |
| Tree | Trinomial, 40 timesteps | Default in QuantLib's `TreeCallableFixedRateBondEngine` |
| Call exercise | Bermudan — issuer can call on any date in the published call schedule | Matches FHLB/FFCB convention |
| Day count | 30/360 | Agency new-issue convention |
| Frequency | Semiannual | Agency new-issue convention |

For bullet (non-callable) issues, OAS == Z-spread (no model needed).

## Inputs

Each OAS computation consumes:

- `issue` row from `issues` sheet — `coupon`, `pricing_date`, `settle_date`, `maturity_date`, `fees_dollars`, `size_dollars`
- `call_schedules` rows for the CUSIP — `call_date`, `call_price`
- That day's `curve_snapshots` rows — `tenor`, `yield_pct` (mapped to year fractions)

No external API calls are made during computation. The Python process is short-lived (~50–200 ms per issue) and stateless.

## Limitations

1. **Constant σ** — not calibrated to swaption vol surface. As a result, OAS values are sensitive to the assumed vol; absolute levels carry a ± a few bp uncertainty. Relative ranking across issues priced the same day is reliable.
2. **No floater handling** — issues without a numeric coupon are skipped (coupon = "" or non-fixed).
3. **No tax-equivalent adjustment** — these are taxable agency yields; client-side tax overlay handled separately.
4. **No bid/ask** — we treat target prices as mid.

## Calibration

The `hw_sigma` value can be overridden per call via the OAS endpoint's `hw_sigma` opt, or globally by passing through the API. Long-term we should calibrate σ daily from a small swaption set; for the prototype, 1.0% is the chosen constant.

## When to recompute

- Automatically: every weekday at 5pm ET via the new-issues cron (Phase 1)
- Manually: `POST /api/internal/agency/oas/compute { cusip }`

## Reference

- QuantLib documentation: <https://www.quantlib.org/docs.shtml>
- Hull-White short-rate model — see Hull, *Options, Futures, and Other Derivatives*, Ch. 32
- Agency callable conventions — FHLB Office of Finance issuance documents
