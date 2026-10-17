"""Run the registered A-class public-NAV study after fee verification."""
from pathlib import Path
import sys

FUND = Path(__file__).resolve().parents[1]
ROOT = FUND.parents[1]
sys.path.insert(0, str(ROOT/'公共资料/工具'))
from annual_threshold_study import run

if __name__ == '__main__':
    run(FUND, Path(__file__).with_name('016701_年度研究配置.json'), resume_after_error='--resume-after-error' in sys.argv)
