#!/usr/bin/env python3
"""
Funding-Spread Solver — quarterly European call approximation.

Methodology for callable agency bonds:
  - All FHLB/FFCB callable auctions are American.
  - American calls are approximated as quarterly European.
  - Iteratively solve for the SOFR spread s such that the bond's model price at
    (SOFR_curve + s, parallel) equals the takedown price 100 − fees_bp/100.

Reads JSON request on stdin, returns JSON on stdout. Same I/O contract as oas.py.

Request:
{
  "cusip": "...",
  "issue_date":    "YYYY-MM-DD",
  "settle_date":   "YYYY-MM-DD",
  "maturity_date": "YYYY-MM-DD",
  "coupon_pct": 5.04,
  "frequency": "semiannual",
  "day_count": "30/360",
  "first_call_date": "YYYY-MM-DD",
  "call_price": 100.0,
  "fees_bp": 29.9,
  "sofr_curve": [ {"tenor_years": 0.0833, "yield_pct": 4.30}, ... ],
  "hw_mean_reversion": 0.03,
  "hw_sigma":          0.01
}

Response:
{
  "ok": true,
  "model_version": "funding-1.0",
  "sofr_spread_bp": 22.5,
  "model_fees_bp": 28.64,
  "n_quarterly_calls": 12,
  "iterations": 6,
  "converged": true
}
"""

import json
import sys
import traceback
from datetime import datetime, timedelta

MODEL_VERSION = "funding-1.0"

def _parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()

def _ql_date(py_date, ql):
    return ql.Date(py_date.day, py_date.month, py_date.year)

def _frequency(name, ql):
    return {
        "annual": ql.Annual, "semiannual": ql.Semiannual,
        "quarterly": ql.Quarterly, "monthly": ql.Monthly,
    }.get((name or "semiannual").lower(), ql.Semiannual)

def _day_count(name, ql):
    n = (name or "30/360").upper().replace(" ", "")
    if n in ("ACT/ACT", "ACTACT", "ACT/ACTBOND"):
        return ql.ActualActual(ql.ActualActual.Bond)
    return ql.Thirty360(ql.Thirty360.BondBasis)

def _expand_quarterly_calls(first_call_iso, maturity_iso, call_price):
    """American → quarterly European: enumerate dates from first call to
    maturity − 3mo, every 3 months."""
    start = _parse_date(first_call_iso)
    end   = _parse_date(maturity_iso)
    # Stop ≥ 3mo before maturity
    cap_month = end.month - 3
    cap_year = end.year
    while cap_month <= 0:
        cap_month += 12
        cap_year -= 1
    try:
        cap = end.replace(year=cap_year, month=cap_month)
    except ValueError:
        cap = end.replace(year=cap_year, month=cap_month, day=28)
    out = []
    cur = start
    while cur <= cap:
        out.append({"date": cur.isoformat(), "price": call_price})
        # Advance 3 months
        m = cur.month + 3
        y = cur.year
        while m > 12:
            m -= 12; y += 1
        try:
            cur = cur.replace(year=y, month=m)
        except ValueError:
            cur = cur.replace(year=y, month=m, day=28)
    return out

def _build_sofr_curve(curve_points, settle_ql, ql, shift_bp=0.0):
    """Build a parallel-shifted zero curve from the input points.
    shift_bp adds a flat spread (in basis points) to every node."""
    calendar = ql.UnitedStates(ql.UnitedStates.GovernmentBond)
    dates = [settle_ql]
    zeros = [curve_points[0]["yield_pct"] / 100.0 + shift_bp / 10000.0]
    for pt in curve_points:
        d = calendar.advance(settle_ql, ql.Period(int(round(pt["tenor_years"] * 365)), ql.Days))
        if d <= dates[-1]:
            d = calendar.advance(dates[-1], ql.Period(1, ql.Days))
        dates.append(d)
        zeros.append(pt["yield_pct"] / 100.0 + shift_bp / 10000.0)
    zc = ql.ZeroCurve(dates, zeros, ql.ActualActual(ql.ActualActual.ISDA), calendar,
                      ql.Linear(), ql.Compounded, ql.Annual)
    zc.enableExtrapolation()
    return ql.YieldTermStructureHandle(zc)

def _price_callable(coupon_pct, schedule, day_count, call_sched, curve_handle,
                    hw_a, hw_sigma, ql):
    hw = ql.HullWhite(curve_handle, hw_a, hw_sigma)
    engine = ql.TreeCallableFixedRateBondEngine(hw, 40)
    bond = ql.CallableFixedRateBond(
        0, 100.0, schedule, [coupon_pct / 100.0],
        day_count, ql.Unadjusted, 100.0,
        schedule.startDate(), call_sched,
    )
    bond.setPricingEngine(engine)
    return bond.cleanPrice()

def compute(req):
    import QuantLib as ql

    settle    = _parse_date(req["settle_date"])
    issue     = _parse_date(req.get("issue_date") or req["settle_date"])
    maturity  = _parse_date(req["maturity_date"])
    coupon    = float(req["coupon_pct"])
    fees_bp   = float(req["fees_bp"])
    first_call= req.get("first_call_date")
    call_price= float(req.get("call_price", 100.0))
    hw_a      = float(req.get("hw_mean_reversion", 0.03))
    hw_sigma  = float(req.get("hw_sigma", 0.01))

    settle_ql   = _ql_date(settle, ql)
    issue_ql    = _ql_date(issue, ql)
    maturity_ql = _ql_date(maturity, ql)
    ql.Settings.instance().evaluationDate = settle_ql

    freq   = _frequency(req.get("frequency"), ql)
    dc     = _day_count(req.get("day_count"), ql)
    cal    = ql.UnitedStates(ql.UnitedStates.GovernmentBond)
    schedule = ql.Schedule(
        issue_ql, maturity_ql, ql.Period(freq), cal,
        ql.Unadjusted, ql.Unadjusted, ql.DateGeneration.Backward, False,
    )

    # American → quarterly European call expansion
    if not first_call:
        return {"ok": False, "error": "first_call_date required for callable funding spread"}
    expanded_calls = _expand_quarterly_calls(first_call, req["maturity_date"], call_price)
    n_calls = len(expanded_calls)
    call_sched = ql.CallabilitySchedule()
    for c in expanded_calls:
        d = _ql_date(_parse_date(c["date"]), ql)
        bp = ql.BondPrice(float(c["price"]), ql.BondPrice.Clean)
        call_sched.append(ql.Callability(bp, ql.Callability.Call, d))

    target_price = 100.0 - fees_bp / 100.0  # 1bp = 0.01 price points

    # Newton/secant on the parallel spread (bps) over the SOFR curve.
    # We rebuild the curve each iteration with shift_bp = s.
    def price_at(s_bp):
        h = _build_sofr_curve(req["sofr_curve"], settle_ql, ql, shift_bp=s_bp)
        return _price_callable(coupon, schedule, dc, call_sched, h, hw_a, hw_sigma, ql)

    # Start with two bracketing guesses
    s_lo, s_hi = -200.0, 500.0
    p_lo, p_hi = price_at(s_lo), price_at(s_hi)
    # Higher spread → lower price (more discounting), so p_lo > p_hi typically
    # We bisect within [s_lo, s_hi] then switch to Newton-like refinement.
    iterations = 0
    converged = False
    s_mid = 0.0
    for _ in range(40):
        iterations += 1
        s_mid = (s_lo + s_hi) / 2.0
        p_mid = price_at(s_mid)
        if abs(p_mid - target_price) < 0.001:
            converged = True
            break
        # Bracket update
        if (p_lo - target_price) * (p_mid - target_price) < 0:
            s_hi = s_mid; p_hi = p_mid
        else:
            s_lo = s_mid; p_lo = p_mid
        if abs(s_hi - s_lo) < 0.01:
            converged = True
            break

    # Round model-implied fees (in bps) to 2 decimals
    final_price = price_at(s_mid)
    model_fees_bp = round((100.0 - final_price) * 100.0, 2)

    return {
        "ok": True,
        "model_version": MODEL_VERSION,
        "sofr_spread_bp": round(s_mid, 2),
        "model_fees_bp": model_fees_bp,
        "n_quarterly_calls": n_calls,
        "iterations": iterations,
        "converged": converged,
    }

def solve_coupon(req):
    """Reverse mode: given target funding spread + fees + structure, find the coupon
    that makes the model price match the takedown price.

    Required req fields: same as compute(), except `coupon_pct` is replaced by
    `target_funding_spread_bp`. Bisect on coupon in a realistic agency-coupon
    range. At extreme coupons the inner spread-bisection in compute() saturates
    at its bracket edge and the result is unreliable.
    """
    target = float(req["target_funding_spread_bp"])
    lo, hi = 3.5, 8.0  # realistic agency coupon range
    fees_target = float(req.get("fees_bp", 0.0))

    def fund_at(coupon):
        sub = dict(req)
        sub["coupon_pct"] = coupon
        sub.pop("target_funding_spread_bp", None)
        sub.pop("mode", None)
        r = compute(sub)
        if not r.get("ok"):
            raise RuntimeError(r.get("error", "compute failed"))
        # Inner solver saturated → model_fees is far from target fees. Reject.
        if abs(r.get("model_fees_bp", 0) - fees_target) > 50:
            return None
        return r["sofr_spread_bp"]

    f_lo, f_hi = fund_at(lo), fund_at(hi)
    # If a side is degenerate, walk inward toward a usable bracket.
    if f_lo is None:
        for c in [4.0, 4.5, 5.0, 5.5]:
            v = fund_at(c)
            if v is not None: lo, f_lo = c, v; break
    if f_hi is None:
        for c in [7.5, 7.0, 6.5, 6.0]:
            v = fund_at(c)
            if v is not None: hi, f_hi = c, v; break
    if f_lo is None or f_hi is None:
        return {"ok": False, "error": "could not find a usable coupon bracket; check structure/dates"}
    if not (min(f_lo, f_hi) - 5 <= target <= max(f_lo, f_hi) + 5):
        return {"ok": False, "error": f"target {target:.1f} bp outside coupon bracket [{lo:.2f}, {hi:.2f}]% (funding range [{f_lo:.1f}, {f_hi:.1f}])"}

    iterations = 0
    mid = (lo + hi) / 2
    for _ in range(30):
        iterations += 1
        mid = (lo + hi) / 2
        f_mid = fund_at(mid)
        if f_mid is None:
            # Degenerate at this coupon — shrink toward the side that's still good.
            mid = (mid + lo) / 2
            continue
        if abs(f_mid - target) < 0.1:
            break
        if (f_lo - target) * (f_mid - target) < 0:
            hi = mid; f_hi = f_mid
        else:
            lo = mid; f_lo = f_mid
        if abs(hi - lo) < 0.0005:  # 0.05 bp coupon resolution
            break

    return {
        "ok": True,
        "model_version": MODEL_VERSION,
        "coupon_pct": round(mid, 4),
        "target_funding_spread_bp": target,
        "iterations": iterations,
    }


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw)
        # Route by req.mode (default = compute funding spread from coupon)
        def dispatch(r):
            if r.get("mode") == "solve_coupon":
                return solve_coupon(r)
            return compute(r)
        if isinstance(req, list):
            out = []
            for r in req:
                try:
                    out.append(dispatch(r))
                except Exception as e:
                    out.append({"ok": False, "error": str(e), "cusip": r.get("cusip")})
            print(json.dumps(out))
        else:
            print(json.dumps(dispatch(req)))
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
