"""Exhaustive FIFO grid on all known history. Descriptive, never held-out proof."""

import datetime as dt
import json
import math
import sys

from optimize_270023_rules import (BASE, CAP, FUND, HOLD, OUT, PERIODS, SOURCE, STEM,
                                   args, configurations, detailed, dump)
from backtest_270023_full_history import CapitalBudgetExceeded, compact_date, simulate

NAME = STEM + "_全历史事后前沿"


def main():
    preset_path = OUT / (NAME + "_预设.json")
    if preset_path.exists() and "--resume-after-error" not in sys.argv:
        raise RuntimeError("Descriptive study already registered; do not silently overwrite")
    if not preset_path.exists():
        dump(preset_path, {"registered_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds"),
                       "status": "descriptive_hindsight_only_after_failed_strict_cross_regime_gate",
                       "grid_count": len(configurations()), "lag": 2,
                       "fees": "current static subscription and FIFO redemption tiers",
                       "objective": "CAGR no lower than original and external<=.5 of initial, then minimize full-history MDD; tie higher CAGR, fewer trades, closer to original",
                       "not_out_of_sample_evidence": True, "does_not_replace_initial_lock": True})
    source = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    rows = source["rows"]
    dividends = [{"exdate": compact_date(x["EXDATE"]), "paydate": compact_date(x["DISTRIBUTEDATE"]),
                  "per_unit": float(x["UNITAMOUNT"])} for x in source["public_dividend_records"]]
    configs = configurations()
    base = detailed(rows, dividends, BASE, 2)["summary"]
    records = []
    pruned = []
    for i, config in enumerate(configs):
        try:
            result = simulate(rows, dividends, lag=2, fee=True, capital_limit=CAP, **args(config))
            records.append({"config": config, **result["summary"]})
        except CapitalBudgetExceeded as exc:
            pruned.append({"config": config, "external_lower_bound_norm": exc.external_lower_bound})
        if (i+1) % 400 == 0:
            print(json.dumps({"evaluated": i+1, "total": len(configs)}), flush=True)
    feasible = [r for r in records if r["twr_annualized_pct"] >= base["twr_annualized_pct"] - 1e-10 and
                r["external_added_norm"] <= CAP + 1e-10]
    winner = min(feasible, key=lambda r: (r["max_drawdown_pct"], -r["twr_annualized_pct"],
                                        r["buy_count"]+r["sell_count"],
                                        sum(abs(a-b) for a,b in zip(r["config"], BASE)), r["config"]))
    config = tuple(winner["config"])
    full = detailed(rows, dividends, config, 2)
    matched = simulate(rows, dividends, fee=True,
                       fixed_flows={x["date"]: x["value_norm"] for x in full["external_cashflows"]})
    periods = {p: [r for r in rows if a <= r["date"] <= b] for p, (a,b) in PERIODS.items()}
    period_diagnostics = {p: [detailed(part, dividends, config, lag)["summary"] for lag in (1,2,3)]
                          for p, part in periods.items()}
    lags = [detailed(rows, dividends, config, lag)["summary"] for lag in (0,1,2,3)]
    pareto = []
    for r in records:
        if r["external_added_norm"] > CAP + 1e-10:
            continue
        dominated = any(s["external_added_norm"] <= CAP + 1e-10 and
                        s["twr_annualized_pct"] >= r["twr_annualized_pct"] - 1e-10 and
                        s["max_drawdown_pct"] <= r["max_drawdown_pct"] + 1e-10 and
                        (s["twr_annualized_pct"] > r["twr_annualized_pct"] + 1e-9 or
                         s["max_drawdown_pct"] < r["max_drawdown_pct"] - 1e-9) for s in records)
        if not dominated:pareto.append(r)
    lookup = {tuple(r["config"]): r for r in records}
    from optimize_270023_rules import THRESHOLDS, FRACTIONS, canonical
    neighbors = []
    for dimension, values in enumerate((THRESHOLDS, THRESHOLDS, FRACTIONS, FRACTIONS)):
        position = values.index(config[dimension])
        for step in (-1,1):
            if 0 <= position+step < len(values):
                new=list(config);new[dimension]=values[position+step]
                key=canonical(tuple(new))
                neighbors.append(lookup[key] if key in lookup else {"config":key,"budget_pruned":True})
    output = {"analysis_date": "2026-10-16", "status": "HINDSIGHT_DESCRIPTION_NOT_VALIDATED_RECOMMENDATION",
              "grid_count": len(configs), "all_fifo_full_history_results": records,
              "budget_pruned": pruned,
              "feasible_count": len(feasible), "full_history_pareto": pareto,
              "selected": {"config": config, "full_history": full, "matched_cashflow_hold": matched,
                           "full_lag_sensitivity": lags, "period_diagnostics_not_independent_test": period_diagnostics,
                           "full_history_neighbors": neighbors},
              "original_summary_same_assumptions": base,
              "strict_cross_regime_study": STEM + "_双指标探索.json"}
    dump(OUT / (NAME + ".json"), output)
    print(json.dumps({"grid": len(configs), "feasible": len(feasible), "pareto":len(pareto),
                      "config": config, "summary": full["summary"],
                      "same_cashflows_hold": matched["summary"],
                      "by_period_lag2":{p:v[1] for p,v in period_diagnostics.items()}},ensure_ascii=False),flush=True)


if __name__ == "__main__":
    main()
