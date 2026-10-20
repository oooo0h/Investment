"""Chronological, budget-aware search over a disclosed threshold-rule grid.

All values are ratios to a hypothetical initial contribution of one. This is a
retrospective parameter experiment, not a proof of future performance.
"""

import datetime as dt
import hashlib
import itertools
import json
from pathlib import Path

import numpy as np

from backtest_270023_full_history import SOURCE, compact_date, simulate

FUND = Path(__file__).resolve().parents[1]
OUT = FUND / "研究"
STEM = "270023_规则组合优化_截至2026-10-14"
THRESHOLDS = [.05, .10, .15, .20, .25, .30, .40]
FRACTIONS = [0, .05, .10, .15, .20, .30, .50]
BASE = (.15, .15, .10, .15)
HOLD = (.15, .15, 0., 0.)
CAP = .50
PERIODS = {
    "development": ("2010-08-18", "2018-12-31"),
    "validation": ("2019-01-01", "2023-12-31"),
    "reserved_test": ("2024-01-01", "2026-10-14"),
}


def canonical(config):
    up, down, sell, buy = config
    return (up if sell else .15, down if buy else .15, sell, buy)


def configurations():
    return sorted({canonical(x) for x in itertools.product(THRESHOLDS, THRESHOLDS, FRACTIONS, FRACTIONS)})


def protocol():
    return {
        "created_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds"),
        "fund_code": "270023", "scope": "retrospective_parameter_search",
        "grid": {"up": THRESHOLDS, "down": THRESHOLDS, "sell": FRACTIONS, "buy": FRACTIONS},
        "unique_configuration_count": len(configurations()), "periods": PERIODS,
        "primary_execution_lag": 2, "robustness_lags": [1, 2, 3],
        "screening_fees": {"subscription": .0016, "redemption_flat_proxy": .005},
        "final_fees": "current-platform static FIFO tiers, not actual historical fee reconstruction",
        "budget": {"main_max_external_to_initial_per_segment": CAP, "screening_sensitivity_caps": [0., .5, 1.]},
        "selection": [
            "Do not inspect reserved-test parameter results before a finalist is frozen.",
            "Screen all configurations on development and validation separately, reset initial fund/cash state per segment.",
            "Require each segment screening CAGR no lower than the original rule and external additions <=50% of initial.",
            "Rank by median axial-neighbor minimum development/validation Calmar, retain alternatives on Pareto frontier.",
            "Detailed shortlist: top24 robust, top8 minimum Calmar, top8 minimum CAGR, top8 lowest worst MDD; plus original, hold, and four preset late-sale controls.",
            "Recompute shortlist with FIFO and lags1/2/3 on development and validation only.",
            "Require median-lag CAGR in each segment no lower than original, and all lag/segment additions<=50%.",
            "Select the eligible candidate maximizing worst-segment/worst-lag Calmar; ties favor fewer trades, then lower additions.",
            "Freeze parameters before reserved-test and full-history presentation; never reselect based on test performance.",
        ],
        "limitations": [
            "The original-rule full history has already been seen; this is a reserved retrospective segment, not pristine unseen data.",
            "A large correlated grid causes multiple-testing risk; no statistical proof or future win probability is claimed.",
            "Raw NAV signals, cash dividends, zero cash yield, external additions allowed, execution/settlement simplifications inherited.",
            "2014 fund strategy transformation remains in development/full-history data and is disclosed.",
        ],
    }


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


def args(config):
    return dict(zip(("up", "down", "sell_fraction", "buy_fraction"), config))


def detailed(rows, dividends, config, lag=2):
    return simulate(rows, dividends, lag=lag, fee=True, **args(config))


def main():
    import sys
    OUT.mkdir(exist_ok=True)
    protocol_path = OUT / (STEM + "_实验预设.json")
    if "--protocol-only" in sys.argv:
        if protocol_path.exists():
            raise RuntimeError("Registered protocol exists; use a new experiment identity")
        dump(protocol_path, protocol())
        print(json.dumps({"protocol": str(protocol_path), "configs": len(configurations())}))
        return
    if not protocol_path.exists():
        raise RuntimeError("Write the experiment protocol before running the search")
    if (OUT / (STEM + "_参数锁定.json")).exists():
        raise RuntimeError("Parameters already locked; do not overwrite a completed experiment")
    from threshold_grid_engine import grid_simulate
    source = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    allrows = source["rows"]
    dividends = [{"exdate": compact_date(x["EXDATE"]), "paydate": compact_date(x["DISTRIBUTEDATE"]),
                  "per_unit": float(x["UNITAMOUNT"])} for x in source["public_dividend_records"]]
    periods = {name: [r for r in allrows if start <= r["date"] <= end] for name, (start, end) in PERIODS.items()}
    configs = configurations()
    lookup = {x: i for i, x in enumerate(configs)}
    baseline = lookup[BASE]
    screened = {}
    for name in ("development", "validation"):
        result = grid_simulate(periods[name], dividends, np.asarray(configs), lag=2,
                               buy_fee=.0016, sell_fee=.005)
        screened[name] = {key: result[key] for key in result.dtype.names}
        print(json.dumps({"stage": "screened", "period": name, "configurations": len(configs)}, ensure_ascii=False), flush=True)

    def array(period, key):
        return np.asarray(screened[period][key], dtype=float)
    train_ret, valid_ret = (array(p, "twr_annualized_pct") for p in ("development", "validation"))
    train_dd, valid_dd = (array(p, "max_drawdown_pct") for p in ("development", "validation"))
    train_ext, valid_ext = (array(p, "external_added_norm") for p in ("development", "validation"))
    minimum_ret = np.minimum(train_ret, valid_ret)
    worst_dd = np.maximum(train_dd, valid_dd)
    max_ext = np.maximum(train_ext, valid_ext)
    minimum_calmar = np.minimum(train_ret / np.maximum(train_dd, 1e-9), valid_ret / np.maximum(valid_dd, 1e-9))
    feasible = ((train_ret >= train_ret[baseline] - 1e-10) & (valid_ret >= valid_ret[baseline] - 1e-10)
                & (max_ext <= CAP + 1e-10))
    neighbors = []
    robust = np.empty(len(configs))
    for index, config in enumerate(configs):
        adjacent = {index}
        for dimension, values in enumerate((THRESHOLDS, THRESHOLDS, FRACTIONS, FRACTIONS)):
            position = values.index(config[dimension])
            for step in (-1, 1):
                if 0 <= position + step < len(values):
                    new = list(config)
                    new[dimension] = values[position + step]
                    adjacent.add(lookup[canonical(tuple(new))])
        neighbors.append(sorted(adjacent))
        scores = [minimum_calmar[j] for j in adjacent if max_ext[j] <= CAP + 1e-10]
        robust[index] = float(np.median(scores)) if scores else -1e6
    ids = np.flatnonzero(feasible).tolist()
    shortlist = {baseline, lookup[HOLD]}
    for values, count, reverse in ((robust, 24, True), (minimum_calmar, 8, True), (minimum_ret, 8, True), (worst_dd, 8, False)):
        shortlist.update(sorted(ids, key=lambda i: values[i], reverse=reverse)[:count])
    for up in (.30, .40):
        for sell in (.05, .10):
            shortlist.add(lookup[(up, .15, sell, .15)])
    pareto = []
    for i in range(len(configs)):
        dominates = ((train_ret >= train_ret[i]) & (valid_ret >= valid_ret[i]) &
                     (train_dd <= train_dd[i]) & (valid_dd <= valid_dd[i]) & (max_ext <= max_ext[i]))
        strict = ((train_ret > train_ret[i] + 1e-10) | (valid_ret > valid_ret[i] + 1e-10) |
                  (train_dd < train_dd[i] - 1e-10) | (valid_dd < valid_dd[i] - 1e-10) |
                  (max_ext < max_ext[i] - 1e-10))
        if not np.any(dominates & strict):
            pareto.append(i)
    grid_records = [{"config": config, "development": {k: float(v[i]) for k, v in screened["development"].items()},
                     "validation": {k: float(v[i]) for k, v in screened["validation"].items()},
                     "feasible": bool(feasible[i]), "robust_neighbor_score": float(robust[i]),
                     "pareto": i in pareto} for i, config in enumerate(configs)]
    dump(OUT / (STEM + "_全部网格.json"), {"protocol": protocol_path.relative_to(FUND.parents[1]).as_posix(), "records": grid_records})
    records = []
    for i in sorted(shortlist):
        results = {}
        for period in ("development", "validation"):
            results[period] = [detailed(periods[period], dividends, configs[i], lag)["summary"] for lag in (1, 2, 3)]
        score = min(s["twr_annualized_pct"] / max(s["max_drawdown_pct"], 1e-9)
                    for values in results.values() for s in values)
        record = {"grid_index": i, "config": configs[i], "results": results, "score": score,
                  "max_external": max(s["external_added_norm"] for values in results.values() for s in values),
                  "trade_count": sum(s["sell_count"] + s["buy_count"] for values in results.values() for s in values)}
        records.append(record)
    original = next(x for x in records if x["grid_index"] == baseline)
    eligible = []
    for record in records:
        meets_return = all(np.median([s["twr_annualized_pct"] for s in record["results"][period]]) >=
                           np.median([s["twr_annualized_pct"] for s in original["results"][period]]) - 1e-10
                           for period in ("development", "validation"))
        record["eligible"] = bool(meets_return and record["max_external"] <= CAP + 1e-10)
        if record["eligible"]:
            eligible.append(record)
    if not eligible:
        raise RuntimeError("No eligible candidate, including original: report an empty feasible set without changing protocol")
    winner = max(eligible, key=lambda x: (x["score"], -x["trade_count"], -x["max_external"]))
    locked = {"locked_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds"),
              "config": winner["config"], "selection_score": winner["score"],
              "selected_using": ["development", "validation"], "reserved_test_not_yet_evaluated": True,
              "shortlisted_count": len(records), "eligible_count": len(eligible),
              "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest()}
    dump(OUT / (STEM + "_参数锁定.json"), locked)
    print(json.dumps({"stage": "locked", **locked}, ensure_ascii=False), flush=True)
    # From this point the selected parameter must never change in response to test results.
    selected = tuple(winner["config"])
    final = {}
    for name, config in (("selected", selected), ("original", BASE), ("buy_hold", HOLD)):
        tests = [detailed(periods["reserved_test"], dividends, config, lag)["summary"] for lag in (1, 2, 3)]
        full = detailed(allrows, dividends, config, 2)
        matched = simulate(allrows, dividends, fee=True,
                           fixed_flows={x["date"]: x["value_norm"] for x in full["external_cashflows"]}, label="同现金流买入持有")
        final[name] = {"config": config, "reserved_test": tests, "full_history": full,
                       "matched_cashflow_hold": matched}
    neighbor_details = []
    wi = winner["grid_index"]
    for i in neighbors[wi]:
        item = {"config": configs[i], "development": detailed(periods["development"], dividends, configs[i], 2)["summary"],
                "validation": detailed(periods["validation"], dividends, configs[i], 2)["summary"]}
        neighbor_details.append(item)
    budget_sensitivity = []
    for cap in (0., .5, 1.):
        eligible_screen = [i for i in range(len(configs)) if max_ext[i] <= cap + 1e-10 and
                           train_ret[i] >= train_ret[baseline] - 1e-10 and valid_ret[i] >= valid_ret[baseline] - 1e-10]
        budget_sensitivity.append({"cap": cap, "screening_eligible_count": len(eligible_screen)})
    payload = {"analysis_date": "2026-10-16", "objective": "收益与回撤平衡", "protocol": json.loads(protocol_path.read_text(encoding="utf-8")),
               "grid_count": len(configs), "pareto_count": len(pareto), "screening_feasible_count": len(ids),
               "shortlist": records, "locked_selection": locked, "budget_screening_sensitivity": budget_sensitivity,
               "neighbor_development_validation": neighbor_details, "final": final,
               "period_actual_dates": {p: [r[0]["date"], r[-1]["date"], len(r)] for p, r in periods.items()}}
    dump(OUT / (STEM + ".json"), payload)
    print(json.dumps({"stage": "finished", "grid": len(configs), "shortlist": len(records),
                      "selected": selected, "full": {k: v["full_history"]["summary"] for k, v in final.items()},
                      "test_lag2": {k: v["reserved_test"][1] for k, v in final.items()}}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
