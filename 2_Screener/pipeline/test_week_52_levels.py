#!/usr/bin/env python3
"""Tests for the 52-week percent -> price-level conversion.

Run: python3 2_Screener/pipeline/test_week_52_levels.py

Finviz's v=152 export gives 52-week high/low as PERCENT DISTANCE from the
extreme, while the CNBC quote ingest writes absolute dollars into the same two
fields. These tests pin the conversion that makes both agree, and — more
importantly — pin the cases where it must refuse to convert rather than write a
plausible-looking wrong number.
"""
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location(
    "elite", pathlib.Path(__file__).with_name("fetch_finviz_elite_to_mongo.py"))
elite = importlib.util.module_from_spec(spec)
sys.modules["elite"] = elite
spec.loader.exec_module(elite)
levels = elite._week_52_levels

failures = []


def check(label, got, want, tol=0.01):
    ok = (got is None and want is None) or (
        got is not None and want is not None and abs(got - want) <= tol)
    if not ok:
        failures.append(f"{label}: got {got}, want {want}")
    print(f"  {'ok  ' if ok else 'FAIL'} {label}")


# The worked example from the original finding, verified against production.
high, low = levels(26.07, -24.08, 124.55)
check("ADEA high == 34.34", high, 34.34)
check("ADEA low  == 11.61", low, 11.61)
rp = (26.07 - low) / (high - low) * 100
check("ADEA range position ~63.6%", rp, 63.6, tol=0.2)

# A deep-discount name: large negative high, large positive low.
high, low = levels(823.83, -34.36, 696.89)
check("MU high == 1255.07", high, 1255.07, tol=0.05)
check("MU low  == 103.38", low, 103.38, tol=0.05)

# Sitting essentially AT the 52-week high. The percent columns and the price
# column are snapshotted at slightly different moments, so the derived high can
# land a hair BELOW the last trade. That is expected and must still convert.
high, low = levels(200.17, 0.2, 40.86)
check("PM at-high still converts", high, 199.77, tol=0.05)
high, low = levels(23.55, 0.06, 58.27)
check("EBC at-high still converts", high, 23.54, tol=0.05)

# Beyond the 2% tolerance the positive value cannot be explained as timing skew,
# so its meaning is genuinely unknown. Refuse rather than guess: a null costs one
# score component, a wrong level corrupts the range position silently.
# Failing either side discards both: if one level cannot be squared with the
# price, the pair is being misread and the other is only accidentally plausible.
high, low = levels(129.93, 7.64, 86.43)
check("INCY implausible high -> None", high, None)
check("INCY low dropped with it", low, None)
high, low = levels(56.93, 2.95, 141.33)
check("RNG implausible high -> None", high, None)
check("RNG low dropped with it", low, None)

# Degenerate and hostile input must never raise and never invent a level.
check("no price -> None", levels(None, -10, 50)[0], None)
check("zero price -> None", levels(0, -10, 50)[0], None)
check("negative price -> None", levels(-5, -10, 50)[0], None)
check("no percentages -> None", levels(26.07, None, None)[0], None)
check("-100% (divide by ~zero) -> None", levels(26.07, -100, 124.55)[0], None)
check("beyond -100% -> None", levels(26.07, -150, 124.55)[0], None)

# A nonsensical low (price 50% BELOW its own 52-week low) is implausible, so the
# whole pair goes — even though the high on its own was fine.
h, l = levels(50.0, -1.0, -50.0)
check("implausible low drops the pair (high)", h, None)
check("implausible low drops the pair (low)", l, None)

# A genuinely inverted but individually-plausible range is still rejected.
h, l = levels(50.0, -60.0, -20.0)
check("inverted range drops high", h, None)
check("inverted range drops low", l, None)

# Already-price-form input must NOT be silently accepted as percentages. Feeding
# a price level in gives an absurd result, which the plausibility guard rejects —
# this is what protects a CNBC row if it ever reached this function.
high, low = levels(253.60, 257.67, 188.08)
check("price-form input rejected (high)", high, None)
check("price-form input rejected (low)", low, None)

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print(f"  {f}")
    sys.exit(1)
print("all week_52 conversion tests passed")
