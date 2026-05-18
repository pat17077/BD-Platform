#!/usr/bin/env python3
"""
Option-Adjusted Spread solver for callable agency bonds.

Reads a JSON request on stdin, returns JSON on stdout.

Request:
{
  "cusip": "...",
  "issue_date":    "YYYY-MM-DD",
  "settle_date":   "YYYY-MM-DD",
  "maturity_date": "YYYY-MM-DD",
  "coupon_pct": 5.25,
  "frequency": "semiannual" | "quarterly" | "annual",   # default semiannual
  "day_count": "ACT/ACT" | "30/360",                    # default ACT/ACT
  "call_schedule": [ {"date": "YYYY-MM-DD", "price": 100.0}, ... ],   # empty for bullet
  "curve": [ {"tenor_years": 0.25, "yield_pct": 4.30}, ... ],
  "target_prices": { "par": 100.0, "cost": 99.90 },
  "hw_mean_reversion": 0.03,   # default 3% — agency callable convention
  "hw_sigma":          0.01    # default 100bps short-rate vol
}

Response (success):
{
  "ok": true,
  "model_version": "qlib-1.42-hw-2026.05",
  "oas_at_par_bp": 35.4,
  "oas_at_cost_bp": 37.1,
  "z_spread_bp": 28.0,
  "bullet": false,
  "settled_on": "2026-05-12"
}

Response (failure):
{ "ok": false, "error": "..." }

The script is intentionally side-effect-free — it does NOT touch sheets, the network, or files. Callers compose the request from cached data and persist the result themselves.
"""

import json
import sys
import traceback
from datetime import datetime

MODEL_VERSION = "qlib-1.42-hw"

def _parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()

def _ql_date(py_date, ql):
    return ql.Date(py_date.day, py_date.month, py_date.year)

def _frequency(name, ql):
    return {
        "annual": ql.Annual,
        "semiannual": ql.Semiannual,
        "quarterly": ql.Quarterly,
        "monthly": ql.Monthly,
    }.get((name or "semiannual").lower(), ql.Semiannual)

def _day_count(name, ql):
    n = (name or "ACT/ACT").upper().replace(" ", "")
    if n in ("30/360", "30/360BOND", "30E/360"):
        return ql.Thirty360(ql.Thirty360.BondBasis)
    return ql.ActualActual(ql.ActualActual.Bond)

def _build_curve(curve_points, settle_ql, ql):
    """Build a piecewise zero curve from the request's curve list.

    curve_points: list of {"tenor_years", "yield_pct"} — yields are simple-compounded
    annual percentages for the prototype (agency-curve convention).
    """
    calendar = ql.UnitedStates(ql.UnitedStates.GovernmentBond)
    dates = [settle_ql]
    zeros = [curve_points[0]["yield_pct"] / 100.0]  # anchor at t=0 with shortest tenor
    for pt in curve_points:
        d = calendar.advance(settle_ql, ql.Period(int(round(pt["tenor_years"] * 365)), ql.Days))
        if d <= dates[-1]:
            d = calendar.advance(dates[-1], ql.Period(1, ql.Days))
        dates.append(d)
        zeros.append(pt["yield_pct"] / 100.0)
    zc = ql.ZeroCurve(dates, zeros, ql.ActualActual(ql.ActualActual.ISDA), calendar,
                      ql.Linear(), ql.Compounded, ql.Annual)
    zc.enableExtrapolation()
    return ql.YieldTermStructureHandle(zc)

def _build_call_schedule(calls, ql):
    sched = ql.CallabilitySchedule()
    for c in calls:
        d = _ql_date(_parse_date(c["date"]), ql)
        price = float(c.get("price", 100.0))
        callability_price = ql.BondPrice(price, ql.BondPrice.Clean)
        sched.append(ql.Callability(callability_price, ql.Callability.Call, d))
    return sched

def _build_schedule(issue, maturity, freq, calendar, ql):
    return ql.Schedule(
        issue, maturity,
        ql.Period(freq),
        calendar,
        ql.Unadjusted, ql.Unadjusted,
        ql.DateGeneration.Backward, False,
    )

def _z_spread_for_bullet(coupon, schedule, day_count, curve_handle, target_price, ql):
    bond = ql.FixedRateBond(0, 100.0, schedule, [coupon / 100.0], day_count)
    bond.setPricingEngine(ql.DiscountingBondEngine(curve_handle))
    bp = ql.BondPrice(target_price, ql.BondPrice.Clean)
    z = ql.BondFunctions.zSpread(bond, bp, curve_handle.currentLink(),
                                 day_count, ql.Compounded, ql.Semiannual)
    return z * 10000.0

def _oas_for_callable(coupon, schedule, call_sched, day_count, curve_handle,
                      target_price, hw_a, hw_sigma, ql):
    hw = ql.HullWhite(curve_handle, hw_a, hw_sigma)
    engine = ql.TreeCallableFixedRateBondEngine(hw, 40)
    bond = ql.CallableFixedRateBond(
        0, 100.0, schedule, [coupon / 100.0],
        day_count, ql.Unadjusted, 100.0,
        schedule.startDate(), call_sched,
    )
    bond.setPricingEngine(engine)
    oas = bond.OAS(target_price, curve_handle, day_count, ql.Compounded, ql.Semiannual)
    return oas * 10000.0

def compute(req):
    import QuantLib as ql

    issue_date    = _parse_date(req["issue_date"])
    settle_date   = _parse_date(req["settle_date"])
    maturity_date = _parse_date(req["maturity_date"])
    coupon_pct    = float(req["coupon_pct"])
    calls         = req.get("call_schedule") or []
    target_par    = float(req.get("target_prices", {}).get("par", 100.0))
    target_cost   = req.get("target_prices", {}).get("cost")
    target_cost   = float(target_cost) if target_cost is not None else None
    hw_a          = float(req.get("hw_mean_reversion", 0.03))
    hw_sigma      = float(req.get("hw_sigma", 0.01))

    settle_ql   = _ql_date(settle_date, ql)
    issue_ql    = _ql_date(issue_date, ql)
    maturity_ql = _ql_date(maturity_date, ql)
    ql.Settings.instance().evaluationDate = settle_ql

    freq   = _frequency(req.get("frequency"), ql)
    dc     = _day_count(req.get("day_count"), ql)
    calend = ql.UnitedStates(ql.UnitedStates.GovernmentBond)
    schedule = _build_schedule(issue_ql, maturity_ql, freq, calend, ql)

    if not req.get("curve"):
        raise ValueError("curve is required")
    curve_handle = _build_curve(req["curve"], settle_ql, ql)

    bullet = len(calls) == 0
    out = {
        "ok": True,
        "model_version": MODEL_VERSION,
        "bullet": bullet,
        "settled_on": settle_date.isoformat(),
    }

    if bullet:
        out["z_spread_bp"]    = round(_z_spread_for_bullet(coupon_pct, schedule, dc, curve_handle, target_par, ql), 2)
        out["oas_at_par_bp"]  = out["z_spread_bp"]  # bullet: OAS == Z-spread
        if target_cost is not None:
            out["oas_at_cost_bp"] = round(_z_spread_for_bullet(coupon_pct, schedule, dc, curve_handle, target_cost, ql), 2)
    else:
        call_sched = _build_call_schedule(calls, ql)
        out["oas_at_par_bp"] = round(_oas_for_callable(coupon_pct, schedule, call_sched, dc,
                                                       curve_handle, target_par, hw_a, hw_sigma, ql), 2)
        if target_cost is not None:
            out["oas_at_cost_bp"] = round(_oas_for_callable(coupon_pct, schedule, call_sched, dc,
                                                             curve_handle, target_cost, hw_a, hw_sigma, ql), 2)
        out["z_spread_bp"] = round(_z_spread_for_bullet(coupon_pct, schedule, dc, curve_handle, target_par, ql), 2)
    return out

def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw)
        if isinstance(req, list):
            results = []
            for r in req:
                try:
                    results.append(compute(r))
                except Exception as e:
                    results.append({"ok": False, "error": str(e), "cusip": r.get("cusip")})
            print(json.dumps(results))
        else:
            print(json.dumps(compute(req)))
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
