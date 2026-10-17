"""Validate only public NAV archives and record source/fee evidence for A and C."""
from __future__ import annotations
import csv
import datetime as dt
from decimal import Decimal
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
ASOF = "2026-10-16"
RAW_A = "基金/016701_银华海外数字经济量化选股混合发起_QDII_A/临时资料"
PROSPECTUS = "https://statics.citics.com/product/file/prospectus/016702.pdf"
ANNUAL = "https://pdf.dfcfw.com/pdf/H2_AN202603281820829854_1.pdf"
INTERIM = "https://pdf.dfcfw.com/pdf/H2_AN202608291828680755_1.pdf"
OPENING = "https://epaper.cs.com.cn/zgzqb/html/2023-06/12/nw.D110000zgzqb_20230612_9-B004.htm"
SAMPLES = {
    "016701": {"2023-12-31": "1.1422", "2024-12-31": "1.4319", "2025-12-31": "1.7794", "2026-06-30": "2.2478"},
    "016702": {"2023-12-31": "1.1382", "2024-12-31": "1.4192", "2025-12-31": "1.7564", "2026-06-30": "2.2146"},
}
TIERS = {
    "016701": [{"holding_days_lt": 7, "rate": "0.015"}, {"holding_days_lt": 30, "rate": "0.0075"}, {"holding_days_lt": 180, "rate": "0.005"}, {"holding_days_gte": 180, "rate": "0"}],
    "016702": [{"holding_days_lt": 7, "rate": "0.015"}, {"holding_days_lt": 30, "rate": "0.005"}, {"holding_days_gte": 30, "rate": "0"}],
}


def relative(path):
    return str(path.relative_to(ROOT)).replace("\\", "/")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    summaries = []
    all_dates = []
    for code in ("016701", "016702"):
        directory, = ROOT.glob("基金/" + code + "_*")
        source, = (directory / "历史净值").glob(code + "_全部历史净值_截至*.json")
        doc = json.loads(source.read_text(encoding="utf-8-sig"))
        rows = doc["rows"]
        navs = {x["date"]: x for x in rows}
        assert len(rows) == len(navs) == doc["count"] == 779
        assert list(navs) == sorted(navs)
        assert all(Decimal(x["nav"]) == Decimal(x["accumulated_nav"]) for x in rows)
        assert all(not x["event"] for x in rows)
        csv_path = source.with_suffix(".csv")
        assert csv_path.read_bytes().startswith(b"\xef\xbb\xbf")
        with csv_path.open(encoding="utf-8-sig", newline="") as f:
            saved = list(csv.DictReader(f))
        assert len(saved) == len(rows)
        for exported, row in zip(saved, rows):
            assert exported["基金代码"] == code
            assert exported["基金名称"] == doc["name"]
            for csv_key, key in (("净值日期", "date"), ("单位净值", "nav"), ("累计净值", "accumulated_nav"), ("日增长率(%)", "daily_growth_pct"), ("分红事件", "event"), ("数据来源", "source")):
                assert exported[csv_key] == (row[key] if row[key] is not None else "")
        sample_results = []
        for date, value in SAMPLES[code].items():
            assert Decimal(navs[date]["nav"]) == Decimal(value)
            sample_results.append({"date": date, "official_document_nav": value, "local_nav": navs[date]["nav"], "equal": True, "document": "2025年年度报告 §3.1" if date < "2026" else "2026年中期报告 §3.1", "document_url": ANNUAL if date < "2026" else INTERIM})
        preopen = [x["date"] for x in rows if x["date"] < "2023-06-14"]
        weekends = [x["date"] for x in rows if dt.date.fromisoformat(x["date"]).weekday() >= 5]
        opened_weekdays = [x for x in rows if x["date"] >= "2023-06-14" and x["date"] not in weekends]
        assert len(preopen) == 16 and len(opened_weekdays) == 761
        identity = "A" if code == "016701" else "C"
        audit = {
            "schema": "public-fund-nav-fee-audit-v1", "verified_at": ASOF, "code": code, "share_class": identity,
            "official_full_name": "银华海外数字经济量化选股混合型发起式证券投资基金（QDII）",
            "identity_status": "用户指定研究对象，未将其加入持仓；用户实际份额类别不作推断",
            "inception_date": "2023-03-15", "ordinary_subscription_redemption_open_date": "2023-06-14", "opening_notice_publish_date": "2023-06-12",
            "transformation": {"found": False, "note": "合同成立及现行招募说明书使用同一基金名称；未发现由旧基金转型而来，未将未发现当作穷尽所有公告的证明"},
            "source_json": relative(source), "source_json_sha256": sha(source), "csv_file": relative(csv_path), "csv_sha256": sha(csv_path),
            "count": len(rows), "first_date": rows[0]["date"], "last_date": rows[-1]["date"],
            "download_checks": doc["validation"],
            "csv_validation": {"utf8_bom": True, "ascending_dates": True, "row_count": len(saved), "all_eight_fields_exact_json_match": True, "artifact_tool_authored_and_read_back": True, "additional_independent_python_csv_reader_check": True},
            "calendar": {"preopen_observation_count": len(preopen), "preopen_dates": preopen, "weekend_accounting_nav_dates": weekends, "open_date_first_nav": navs["2023-06-14"]["nav"], "open_date_and_weekday_only_count": len(opened_weekdays), "note": "净值观察日不等于实际允许申赎日。删除开放前与周末仅为固定敏感性，尚未逐日重建中外同时开市及停复牌申赎日历。"},
            "official_document_nav_samples": sample_results,
            "independent_manager_website_full_history_check": {"completed": False, "url": "https://www.yhfund.com.cn/", "observed_failure": "urllib HTTPS证书链校验失败 self-signed certificate in certificate chain；PowerShell和网页工具亦不能正常打开。HTTP会转HTTPS，/main亦失败。未绕过TLS证书验证。", "effect": "东财f10与pingzhongdata属于同供应商全量互检；管理人原始定期报告仅核对4个日期的净值样本，不能表述为官网全历史双源全量验证。"},
            "dividend_events": [], "split_events": [],
            "distribution_evidence": [
                {"period": "2023-03-15—2025-12-31", "finding": "管理人2025年报§3.3确认三个会计期间均未分配利润", "url": ANNUAL, "physical_pdf_page": 10},
                {"period": "2026-01-01—2026-06-30", "finding": "管理人2026中报§4.7确认报告期未分配利润", "url": INTERIM, "physical_pdf_page": 14},
                {"period": "2023-03-15—2026-10-15", "finding": "全部779条累计净值等于单位净值且事件字段为空；东财公开分红与拆分表均为空", "url": f"https://fundf10.eastmoney.com/fhsp_{code}.html", "limitation": "尤其2026下半年尚无已发布定期报告覆盖；未能取回管理人官网全历史事件登记簿。空事件用于模型是有证据支持的工作假设。"},
            ],
            "fees": {
                "source_url": PROSPECTUS, "document": "管理人原始2026年第1号招募说明书；中信证券官方销售文件镜像", "subscription_standard_ordinary_rate": "0.015" if identity == "A" else "0", "subscription_model_rate": "0.0015" if identity == "A" else "0", "subscription_model_note": "A类0.15%为项目静态折扣假设；C类无申购费。不是用户实际成交费率或全历史渠道费率重建。", "redemption_tiers": TIERS[code], "redemption_fee_base": "赎回份额乘当日该类净值，再乘对应赎回费率", "fifo": True, "fifo_basis": "基金份额登记日期先后，招募说明书正文第64页", "redemption_tier_pages": {"printed_page": 67, "physical_pdf_page": 68}, "annual_sales_service_rate_embedded_in_nav": "0.004" if identity == "C" else "0", "embedded_cost_note": "管理费、托管费及C类销售服务费从基金财产中计提，已在相应份额NAV体现，使用净值回测不得再次扣除。", "subscription_formula": "A净申购=申购预算/(1+申购费率)；C净申购=预算。", "model_limits": "当前静态费率与连续归一化份额模型，不复刻历史渠道优惠；官方份额/金额小数处理及确认日持有期边界可能与模型代理不同。"
            },
            "execution_facts": {"nav_calculation": "T+1内计算", "nav_publication": "T+2内公告，特殊情况可延迟", "subscription_registration": "T+2登记权益", "earliest_redemption_after_purchase": "T+3（含）以后", "reference": "招募说明书正文第70页（物理71页）", "simulation_note": "观察日lag1/2/3是信息滞后情景，不能等同逐日复原的实际披露和可成交时点。"},
            "current_subscription_status": "公开页面显示大额限制，直销与代销存在差异；仅简述有额度/暂停约束，不重建历次限额，不将理想成交回测解释为可执行订单。",
            "primary_documents": [
                {"url": PROSPECTUS, "file": RAW_A + "/prospectus_2026_1_official_mirror.pdf", "sha256": sha(ROOT / RAW_A / "prospectus_2026_1_official_mirror.pdf")},
                {"url": ANNUAL, "file": RAW_A + "/annual_report_2025.pdf", "sha256": sha(ROOT / RAW_A / "annual_report_2025.pdf")},
                {"url": INTERIM, "file": RAW_A + "/interim_report_2026.pdf", "sha256": sha(ROOT / RAW_A / "interim_report_2026.pdf")},
                {"url": OPENING, "file": RAW_A + "/opening_notice_2023-06-12.html", "sha256": sha(ROOT / RAW_A / "opening_notice_2023-06-12.html")},
            ],
        }
        out = directory / "研究" / f"{code}_年度策略数据与费率核验_{ASOF}.json"
        out.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        fee_text = "不足7日1.50%；7至不足30日0.75%；30至不足180日0.50%；180日及以上0。" if identity == "A" else "不足7日1.50%；7至不足30日0.50%；30日及以上0。"
        md = f"""# 银华海外数字经济 {identity} 类公开数据与费率核验

核验日：{ASOF}；净值截止：{rows[-1]['date']}。这是公开产品研究档案，不代表用户持仓或实际份额类别。

已保存成立以来 **779 条**公开净值，覆盖 **2023-03-15 至 2026-10-15**，日期升序。东财历史接口全部39页已归档，并与同供应商走势图779条逐项匹配。CSV 为UTF-8-BOM，8个字段与JSON逐行完全一致，保留六位代码和ISO日期。两个东财接口不能算两个独立数据源。

管理人2025年报与2026中报核对2023、2024、2025年末及2026-06-30共4个期末净值，均与本地一致。银华主站在本次环境中证书链校验失败，未能取得官网全量历史净值，**尚未完成独立官方全量比对**。

## 成立与开放

基金合同生效日为2023-03-15，普通申赎从2023-06-14开放。6月12日是公告发布日期。全量档案含16条开放前观察；另含2023-12-31、2024-06-30两条周末会计净值。仅保留开放日起且非周末的观察共761条，仍不等于已逐日复原所有实际可申赎日期。[管理人招募说明书正文第63页]({PROSPECTUS})、[原始开放公告]({OPENING})。

## 分红与拆分

管理人2025年报§3.3确认成立至2025年三个会计期间均未分配利润，2026中报§4.7确认2026上半年未分配。全779条累计净值等于单位净值、事件文字为空，公开分红与拆分表为空，模型采用空分红事件表。2026下半年尚无定期报告覆盖，且未取得管理人官网完整事件登记簿，此处不声称穷尽验证全部公告。[2025年报]({ANNUAL})、[2026中报]({INTERIM})、[公开分红拆分表](https://fundf10.eastmoney.com/fhsp_{code}.html)。

## 费用与交易口径

{identity}类赎回费：{fee_text}先进先出按基金份额登记日期排序。A类模型申购0.15%是项目静态假设，官方普通标准申购为1.50%；C类申购为0，年销售服务费0.40%已内含C类净值。管理、托管与销售服务费用均不得在净值回测中重复扣除。[管理人招募说明书正文第64、66—70、107—108页]({PROSPECTUS})。

净值通常T+1内计算、T+2内公告；买入T+2登记权益，T+3起可赎回。观察日lag情景与理想连续归一化份额不能完整复刻实际披露时点、确认日、最小成交单位、赎回款到账及历次限购。当前静态费率也不等于各历史渠道实际费率。公开页面存在大额限制，仅保留约束提示，不在此处重建额度或推断账户。

## 本地资料

- [全历史JSON](../历史净值/{source.name})
- [全历史CSV](../历史净值/{csv_path.name})
- [核验细表]({out.name})
- 全页原始响应：`../历史净值/原始数据/东财全页_{ASOF}/`

正式文件原文与哈希见核验JSON；A、C共享的管理人原始文件仅归档于A类临时资料，避免重复保存。
"""
        out.with_suffix(".md").write_text(md, encoding="utf-8")
        all_dates.append(list(navs))
        summaries.append({"code": code, "count": len(rows), "open_weekday_count": len(opened_weekdays), "official_nav_samples": len(sample_results), "audit": relative(out)})
    assert all_dates[0] == all_dates[1]
    print(json.dumps({"funds": summaries, "identical_A_C_date_calendar": True, "all_csv_fields_exact": True}, ensure_ascii=True))


if __name__ == "__main__":
    main()
