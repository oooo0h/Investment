"""C NAV evaluates the A-selected parameters; no C-class winner search."""
from pathlib import Path
import sys

FUND = Path(__file__).resolve().parents[1]
ROOT = FUND.parents[1]
sys.path.insert(0, str(ROOT/'公共资料/工具'))
from annual_threshold_study import run

if __name__ == '__main__':
    primary = ROOT/'基金/持仓基金/016701_银华海外数字经济量化选股混合发起_QDII_A/研究/016701_年度投入规则优化_截至2026-10-15.json'
    run(FUND, Path(__file__).with_name('016702_年度研究配置.json'), primary)
