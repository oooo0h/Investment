"""Extract public holdings tables and compare issuer weights without ETF look-through."""

import sys
sys.dont_write_bytecode = True
import json
import re
from pathlib import Path
import pdfplumber

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "161620": (ROOT / "基金/观察基金/161620_融通核心价值混合QDIIA/定期报告/2026/2026-08-28_融通核心价值混合QDII_2026年中期报告.pdf", range(37, 41)),
    "006373": (ROOT / "基金/持仓基金/006373_国富全球科技互联混合_QDII_人民币A/定期报告/2026/2026-08-31_国富全球科技互联_2026年中期报告_AN202608311828779589.pdf", range(45, 49)),
}

def compact(value):
    return re.sub(r"\s+", "", value or "")

def extract(path, pages):
    records = []
    with pdfplumber.open(path) as pdf:
        for page_index in pages:
            for table in pdf.pages[page_index].extract_tables():
                for row in table:
                    if len(row) < 9 or not re.fullmatch(r"\d+", compact(row[0])):
                        continue
                    code = " ".join((row[3] or "").replace("\n", " ").split())
                    # Some numeric tickers wrap inside the six-digit code.
                    if re.fullmatch(r"[\d\s]+", code):
                        code = compact(code)
                    if code == "KEYS":
                        code = "KEYS US"  # The remaining US suffix continues on the next page.
                    nonempty = [cell for cell in row if cell is not None and cell.strip()]
                    weight = float(compact(nonempty[-1]))
                    issuer = "ALPHABET" if code in {"GOOG US", "GOOGL US"} else code
                    records.append({"issuer": issuer, "code": code, "name": compact(row[2]), "weight_pct": weight})
    return records

holdings = {code: extract(*args) for code, args in SOURCES.items()}
assert len(holdings["161620"]) == 43, len(holdings["161620"])
assert len(holdings["006373"]) == 42, len(holdings["006373"])

def aggregate(records):
    result = {}
    for record in records:
        key = record["issuer"]
        if key not in result:
            result[key] = {"name": record["name"], "codes": [], "weight_pct": 0}
        result[key]["codes"].append(record["code"])
        result[key]["weight_pct"] += record["weight_pct"]
    return result

aggregated = {code: aggregate(records) for code, records in holdings.items()}
common = []
for issuer in sorted(aggregated["161620"].keys() & aggregated["006373"].keys()):
    a, b = aggregated["161620"][issuer], aggregated["006373"][issuer]
    common.append({"issuer": issuer, "name": a["name"], "codes": {"161620": a["codes"], "006373": b["codes"]}, "weight_pct": {"161620": a["weight_pct"], "006373": b["weight_pct"]}, "minimum_weight_pct": round(min(a["weight_pct"], b["weight_pct"]), 2)})
common.sort(key=lambda item: item["minimum_weight_pct"], reverse=True)
output = {
    "holdings_date": "2026-06-30",
    "method": "Same issuer; Alphabet GOOG and GOOGL combined; sum of minimum NAV weights; published rounded two-decimal weights; direct stocks and ADRs only, no ETF look-through, bonds or cash.",
    "source_paths": {code: str(args[0]) for code, args in SOURCES.items()},
    "stock_counts": {code: len(records) for code, records in holdings.items()},
    "direct_weight_sums_pct": {code: round(sum(r["weight_pct"] for r in records), 2) for code, records in holdings.items()},
    "common_issuer_count": len(common),
    "overlap_pct_of_nav": round(sum(r["minimum_weight_pct"] for r in common), 2),
    "common_holdings": common,
    "all_direct_holdings": holdings,
}
dest = ROOT / "基金/观察基金/161620_融通核心价值混合QDIIA/研究/161620_006373_直接股票重叠_2026-06-30.json"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({key: output[key] for key in ("stock_counts", "direct_weight_sums_pct", "common_issuer_count", "overlap_pct_of_nav", "common_holdings")}, ensure_ascii=False, indent=2))
