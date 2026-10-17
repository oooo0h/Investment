"""Exploratory, explicitly labelled dominance check; preserves original lock."""

import datetime as dt
import hashlib
import json
from pathlib import Path

import numpy as np

from optimize_270023_rules import (BASE, CAP, FUND, HOLD, OUT, PERIODS, SOURCE, STEM,
                                   args, canonical, configurations, detailed, dump)
from backtest_270023_full_history import compact_date, simulate

SUFFIX = STEM + "_双指标探索"


def main():
    # The initial winner remains unchanged. This additional family is exploratory.
    preset = {
        "created_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds"),
        "status": "exploratory_extension_after_review_of_initial_experiment",
        "initial_parameter_lock_preserved": True,
        "reason": "Initial Calmar winner was hold; many configurations had identical zero-trade paths. A Calmar improvement is not simultaneous return/drawdown dominance.",
        "pool": "all213 screening Pareto points plus every screening configuration not worse than original in development/validation return and drawdown, external<=.5",
        "detailed_model": "FIFO current static fees, lag1/2/3, cash dividends",
        "strict_gate": "Every development/validation x lag1/2/3 cell: CAGR>=same-lag original, MDD<=same-lag original, additions<=.5; both buy/sell occur in every cell",
        "material_improvement": "at least one cell: CAGR improves by .5 percentage point or MDD improves by2 percentage points",
        "rank": "maximum worst-cell Calmar; then fewer trades; then lower extra contributions",
        "equivalent_path_representative": "minimum L1 distance to original tuple, then lexicographic config; never use reserved-test result",
        "no_relaxation_if_empty": True,
        "retrospective_only": True,
    }
    preset_path = OUT / (SUFFIX + "_预设.json")
    if preset_path.exists():
        raise RuntimeError("Exploratory preset already exists; do not silently rerun a locked experiment")
    dump(preset_path, preset)
    source = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    rows = source["rows"]
    dividends = [{"exdate": compact_date(x["EXDATE"]), "paydate": compact_date(x["DISTRIBUTEDATE"]),
                  "per_unit": float(x["UNITAMOUNT"])} for x in source["public_dividend_records"]]
    periods = {p: [r for r in rows if a <= r["date"] <= b] for p, (a, b) in PERIODS.items()}
    original_result = json.loads((OUT / (STEM + ".json")).read_text(encoding="utf-8"))
    grid = json.loads((OUT / (STEM + "_全部网格.json")).read_text(encoding="utf-8"))["records"]
    base_screen = next(x for x in grid if tuple(x["config"]) == BASE)
    original = next(x for x in original_result["shortlist"] if tuple(x["config"]) == BASE)
    pool = []
    for record in grid:
        dominates = all(record[p]["twr_annualized_pct"] >= base_screen[p]["twr_annualized_pct"] - 1e-10 and
                        record[p]["max_drawdown_pct"] <= base_screen[p]["max_drawdown_pct"] + 1e-10
                        for p in ("development", "validation"))
        capital = max(record[p]["external_added_norm"] for p in ("development", "validation")) <= CAP + 1e-10
        if (record["pareto"] or dominates) and capital:
            pool.append(tuple(record["config"]))
    existing = {tuple(x["config"]): x for x in original_result["shortlist"]}
    results = []
    groups = {}
    for config in pool:
        cells = {}
        signature = []
        for period in ("development", "validation"):
            values = []
            for lag in (1, 2, 3):
                full = detailed(periods[period], dividends, config, lag)
                values.append(full["summary"])
                signature.append([(x["execution_date"], x["side"], round(x["trade_value_norm"], 12), round(x["external_added_norm"], 12))
                                  for x in full["trades"]])
            cells[period] = values
        signature = hashlib.sha256(json.dumps(signature).encode()).hexdigest()
        active = config[2] > 0 and config[3] > 0 and all(s["buy_count"] > 0 and s["sell_count"] > 0 for values in cells.values() for s in values)
        strict = active
        material = False
        for period in ("development", "validation"):
            for s, b in zip(cells[period], original["results"][period]):
                strict &= (s["twr_annualized_pct"] >= b["twr_annualized_pct"] - 1e-9 and
                           s["max_drawdown_pct"] <= b["max_drawdown_pct"] + 1e-9 and s["external_added_norm"] <= CAP + 1e-9)
                material |= (s["twr_annualized_pct"] >= b["twr_annualized_pct"] + .5 or
                             s["max_drawdown_pct"] <= b["max_drawdown_pct"] - 2)
        record = {"config": config, "results": cells, "active": bool(active), "strict_pass": bool(strict and material),
                  "score": min(s["twr_annualized_pct"] / s["max_drawdown_pct"] for values in cells.values() for s in values),
                  "trade_count": sum(s["buy_count"] + s["sell_count"] for values in cells.values() for s in values),
                  "max_external": max(s["external_added_norm"] for values in cells.values() for s in values),
                  "path_group": signature}
        results.append(record)
        groups.setdefault(signature, []).append(record)
    def representative(group):
        return min(group, key=lambda x: (sum(abs(a-b) for a,b in zip(x["config"], BASE)), x["config"]))
    representatives = [representative(group) for group in groups.values()]
    passing = [x for x in representatives if x["strict_pass"]]
    winner = max(passing, key=lambda x: (x["score"], -x["trade_count"], -x["max_external"])) if passing else None
    lock = {"locked_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds"),
            "config": winner["config"] if winner else None, "strict_passing_path_groups": len(passing),
            "reserved_results_not_used_for_selection": True, "exploratory_not_pristine_test": True}
    dump(OUT / (SUFFIX + "_锁定.json"), lock)
    final = None
    if winner:
        config = tuple(winner["config"])
        tests = [detailed(periods["reserved_test"], dividends, config, lag)["summary"] for lag in (1, 2, 3)]
        full = detailed(rows, dividends, config, 2)
        matched = simulate(rows, dividends, fee=True, fixed_flows={x["date"]: x["value_norm"] for x in full["external_cashflows"]})
        neighbors = []
        vals = ([.05,.10,.15,.20,.25,.30,.40], [.05,.10,.15,.20,.25,.30,.40], [0,.05,.10,.15,.20,.30,.50], [0,.05,.10,.15,.20,.30,.50])
        for dim, values in enumerate(vals):
            pos = values.index(config[dim])
            for step in (-1, 1):
                if 0 <= pos + step < len(values):
                    new = list(config);new[dim] = values[pos + step];new = canonical(tuple(new))
                    neighbors.append({"config": new, **{p: detailed(periods[p], dividends, new, 2)["summary"] for p in ("development", "validation")}})
        final = {"config": config, "reserved_test": tests, "full_history": full, "matched_cashflow_hold": matched,
                 "neighbors": neighbors, "budget_filter_full_pass": full["summary"]["external_added_norm"] <= CAP,
                 "budget_filter_reserved_pass": all(s["external_added_norm"] <= CAP for s in tests)}
    output = {"preset": preset, "screening_pool_count": len(pool), "path_group_count": len(groups),
              "strict_parameter_count": sum(x["strict_pass"] for x in results), "strict_path_count": len(passing),
              "records": results, "lock": lock, "final": final,
              "original_lock_sha256": hashlib.sha256((OUT / (STEM + "_参数锁定.json")).read_bytes()).hexdigest()}
    dump(OUT / (SUFFIX + ".json"), output)
    print(json.dumps({"pool": len(pool), "path_groups": len(groups), "passing": len(passing), "selected": lock["config"],
                      "full": final["full_history"]["summary"] if final else None,
                      "test_lag2": final["reserved_test"][1] if final else None}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
