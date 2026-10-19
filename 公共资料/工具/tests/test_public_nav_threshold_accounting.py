"""Independent small-path checks for the public-NAV accounting engine.

All contributions below are arbitrary normalized research units. No account
files, real positions, or investor amounts are read.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from annual_threshold_backtest import YEAR, prepare, simulate, xirr
from annual_threshold_settlement import following_weekday, simulate_settlement


def public_path(pairs):
    return prepare([{"date": date, "nav": nav} for date, nav in pairs])


class PublicNavThresholdAccounting(unittest.TestCase):
    def assert_close(self, actual, expected):
        self.assertAlmostEqual(actual, expected, delta=1e-10 * max(1., abs(expected)))

    def test_constant_nav_no_fee_has_zero_return_despite_contributions(self):
        data = public_path([
            ("2020-01-02", 1.), ("2020-06-01", 1.),
            ("2021-01-04", 1.), ("2021-06-01", 1.),
            ("2022-01-04", 1.),
        ])
        result = simulate(data, buy_fee=0., redemption_tiers=(), detail=True,
                          forced_extras={"2020-06-01": .3, "2021-06-01": .2})
        self.assert_close(result["summary"]["twr_annualized_pct"], 0.)
        self.assert_close(result["summary"]["xirr_pct"], 0.)
        self.assert_close(result["summary"]["max_drawdown_pct"], 0.)
        self.assert_close(result["summary"]["end_total_norm"], 3.5)
        for row in result["daily"]:
            self.assert_close(row["twr_index"], 1.)

    def test_fully_invested_no_fee_twr_equals_nav_ratio(self):
        data = public_path([
            ("2020-01-02", 1.25), ("2020-06-01", 1.1),
            ("2021-01-04", 1.5), ("2021-06-01", 1.2),
            ("2022-01-04", 1.75),
        ])
        result = simulate(data, buy_fee=0., redemption_tiers=(), detail=True,
                          forced_extras={"2020-06-01": .3, "2021-06-01": .2})
        self.assert_close(result["daily"][-1]["twr_index"], 1.75 / 1.25)
        elapsed = (dt.date(2022, 1, 4) - dt.date(2020, 1, 2)).days / YEAR
        expected = ((1.75 / 1.25) ** (1. / elapsed) - 1.) * 100
        self.assert_close(result["summary"]["twr_annualized_pct"], expected)
        for row, (_, price) in zip(result["daily"], [
            ("2020-01-02", 1.25), ("2020-06-01", 1.1),
            ("2021-01-04", 1.5), ("2021-06-01", 1.2),
            ("2022-01-04", 1.75),
        ]):
            self.assert_close(row["twr_index"], price / 1.25)

    def test_lag_two_executes_at_second_later_nav(self):
        data = public_path([
            ("2020-01-02", 1.), ("2020-01-03", 1.21),
            ("2020-01-06", 1.30), ("2020-01-07", 1.40),
        ])
        result = simulate(data, (.2, .5, .5, 0.), initial_only=True,
                          lag=2, buy_fee=0., redemption_tiers=(), detail=True)
        sales = [event for event in result["trades"] if event["kind"] == "sell"]
        self.assertEqual(len(sales), 1)
        self.assertEqual(sales[0]["signal_date"], "2020-01-03")
        self.assertEqual(sales[0]["date"], "2020-01-07")
        self.assert_close(sales[0]["budget_norm"], .5 * 1.40)
        self.assert_close(result["daily"][2]["cash_norm"], 0.)
        self.assert_close(result["daily"][3]["cash_norm"], .7)

    def test_fifo_age_tier_boundaries(self):
        origin = dt.date(2020, 1, 1)
        # Independently specified half-open holding-age bands: <7, <365, <730.
        for age, expected_rate in [(1, .015), (6, .015), (7, .005),
                                   (364, .005), (365, .003),
                                   (729, .003), (730, 0.)]:
            with self.subTest(age=age):
                sold_on = (origin + dt.timedelta(days=age)).isoformat()
                result = simulate(public_path([("2020-01-01", 1.), (sold_on, 1.2)]),
                                  (.1, .9, .25, 0.), initial_only=True, lag=0,
                                  buy_fee=0., detail=True)
                # One initial share; a quarter is redeemed at NAV 1.2.
                self.assert_close(result["summary"]["transaction_fees_norm"],
                                  .25 * 1.2 * expected_rate)
                self.assert_close(result["daily"][-1]["cash_norm"],
                                  .25 * 1.2 * (1. - expected_rate))

    def test_fifo_redeems_old_lot_before_young_lot(self):
        data = public_path([
            ("2020-01-01", 1.), ("2022-01-01", 1.), ("2022-01-02", 1.2),
        ])
        result = simulate(data, (.1, .9, .75, 0.), initial_only=True,
                          forced_extras={"2022-01-01": 1.}, lag=0,
                          buy_fee=0., detail=True)
        # Two shares acquired in separate lots. Selling 1.5 shares exhausts
        # the 732-day-old share for no fee and 0.5 of the one-day-old share
        # at 1.5%; a pro-rata-lot or LIFO implementation gives another fee.
        expected_fee = .5 * 1.2 * .015
        self.assert_close(result["summary"]["transaction_fees_norm"], expected_fee)
        self.assert_close(result["daily"][-1]["cash_norm"], 1.5 * 1.2 - expected_fee)

    def test_flow_matched_hold_uses_identical_external_flows(self):
        data = public_path([
            ("2020-01-02", 1.), ("2020-01-03", .8),
            ("2020-01-06", 1.2), ("2020-01-07", .9),
        ])
        rule = (.2, .2, .5, .5)
        strategy = simulate(data, rule, initial_only=True, lag=0,
                            buy_fee=0., redemption_tiers=(), detail=True)
        matched_extras = {row["date"]: row["extra_today_norm"]
                          for row in strategy["daily"] if row["extra_today_norm"]}
        matched = simulate(data, initial_only=True, buy_fee=0.,
                           redemption_tiers=(), forced_extras=matched_extras,
                           detail=True)
        self.assertEqual(matched_extras, {"2020-01-03": .5})
        self.assertEqual(strategy["cashflows"][:-1], matched["cashflows"][:-1])
        # Hold: one share initially, another 0.5/0.8 shares on the extra-flow
        # day, all valued at terminal NAV 0.9.
        self.assert_close(matched["summary"]["end_total_norm"], (1. + .5 / .8) * .9)
        # Tactical path: sell 0.8125 shares at 1.2; use half the new anchor
        # fund value to buy at 0.9, funding entirely from sale proceeds.
        retained_units = (1. + .5 / .8) * .5
        sale_cash = retained_units * 1.2
        later_buy = retained_units * 1.2 * .5
        expected_strategy = (retained_units + later_buy / .9) * .9 + sale_cash - later_buy
        self.assert_close(strategy["summary"]["end_total_norm"], expected_strategy)
        self.assert_close(strategy["summary"]["extra_contributed_norm"], .5)
        self.assert_close(matched["summary"]["extra_contributed_norm"], .5)

    def test_prefix_preparation_and_trades_do_not_use_future_rows(self):
        pairs = [
            ("2023-11-01", 1.), ("2023-11-20", .8),
            ("2023-12-15", .7), ("2024-01-02", .9),
            ("2024-01-03", 1.2), ("2024-01-04", 1.25),
            ("2024-01-05", 1.3), ("2024-02-01", .6),
        ]
        full_data = public_path(pairs)
        for schedule in ("annual", "monthly", "daily"):
            full = simulate(full_data, (.2, .2, .5, .5), schedule=schedule,
                            buy_fee=0., redemption_tiers=(), detail=True)
            for length in range(2, len(pairs)):
                with self.subTest(schedule=schedule, prefix=length):
                    prefix_data = public_path(pairs[:length])
                    for field in ("annual", "monthly", "daily"):
                        self.assertEqual(prefix_data[field], full_data[field][:length])
                    prefix = simulate(prefix_data, (.2, .2, .5, .5), schedule=schedule,
                                      buy_fee=0., redemption_tiers=(), detail=True)
                    self.assertEqual(prefix["daily"], full["daily"][:length])
                    self.assertEqual(prefix["trades"], [event for event in full["trades"]
                                                       if event["date"] <= pairs[length-1][0]])

    def test_cash_dividend_ex_date_drop_and_payment_preserve_total_return(self):
        data = prepare([{'date':'2020-01-02','nav':1.},
                        {'date':'2020-01-03','nav':.9},
                        {'date':'2020-01-06','nav':.9}],
                       [{'exdate':'2020-01-03','paydate':'2020-01-06','per_unit':.1}])
        result = simulate(data, initial_only=True, buy_fee=0., redemption_tiers=(), detail=True)
        self.assert_close(result['daily'][1]['receivable_norm'], .1)
        self.assert_close(result['daily'][1]['cash_norm'], 0.)
        self.assert_close(result['daily'][2]['receivable_norm'], 0.)
        self.assert_close(result['daily'][2]['cash_norm'], .1)
        for row in result['daily']:
            self.assert_close(row['total_norm'], 1.)
            self.assert_close(row['twr_index'], 1.)

    def test_dividend_entitlement_survives_sale_before_dividend_payment(self):
        data = prepare([{'date':'2020-01-02','nav':1.},
                        {'date':'2020-01-03','nav':.9},
                        {'date':'2020-01-06','nav':1.1},
                        {'date':'2020-01-08','nav':1.1}],
                       [{'exdate':'2020-01-03','paydate':'2020-01-08','per_unit':.1}])
        result = simulate(data, (.05,.5,.5,0.), initial_only=True, lag=0,
                          buy_fee=0., redemption_tiers=(), detail=True)
        self.assert_close(result['daily'][2]['receivable_norm'], .1)
        self.assert_close(result['daily'][2]['cash_norm'], .55)
        self.assert_close(result['daily'][3]['cash_norm'], .65)
        self.assert_close(result['daily'][3]['total_norm'], 1.2)
        self.assert_close(result['daily'][3]['twr_index'], 1.2)

    @unittest.expectedFailure
    def test_known_xirr_lower_bracket_rejects_valid_short_loss_root(self):
        # The valid conventional root is r = 0.8**(365/3)-1, which is below
        # the engine's hardcoded -0.9999 lower bracket. Kept explicitly as a
        # known limitation, independent of the longer-period accounting tests.
        flows = [(dt.date(2020, 1, 1), -1.), (dt.date(2020, 1, 4), .8)]
        expected = (.8 ** (365. / 3.) - 1.) * 100.
        self.assert_close(xirr(flows), expected)


class RedemptionSettlementSensitivity(unittest.TestCase):
    def assert_close(self, actual, expected):
        self.assertAlmostEqual(actual, expected, delta=1e-10 * max(1., abs(expected)))

    def test_zero_delay_returns_original_output_exactly(self):
        data = public_path([
            ("2020-01-02", 1.), ("2020-01-03", 1.2),
            ("2020-01-06", .8), ("2020-01-07", .8),
            ("2020-01-08", 1.), ("2021-01-04", .9),
        ])
        for schedule in ("annual", "monthly", "daily"):
            for detailed in (False, True):
                with self.subTest(schedule=schedule, detailed=detailed):
                    arguments = dict(schedule=schedule, detail=detailed,
                                     lag=0, buy_fee=.0015,
                                     forced_extras={"2020-01-07": .1})
                    self.assertEqual(simulate_settlement(data, (.2, .2, .5, .5),
                                                        redemption_settlement_workdays=0,
                                                        **arguments),
                                     simulate(data, (.2, .2, .5, .5), **arguments))

    def test_sale_receivable_and_release_preserve_equity(self):
        data = public_path([
            ("2020-01-02", 1.), ("2020-01-03", 1.2),
            ("2020-01-06", 1.2), ("2020-01-07", 1.2),
            ("2020-01-08", 1.2),
        ])
        args = dict(initial_only=True, lag=0, buy_fee=0., detail=True)
        delayed = simulate_settlement(data, (.2, .9, .5, 0.),
                                      redemption_settlement_workdays=3, **args)
        original = simulate(data, (.2, .9, .5, 0.), **args)
        # Sale on Friday 3 Jan releases on Wednesday 8 Jan. A one-day-old
        # half-share has 1.5% redemption fee; neither deferral nor release is
        # an external flow or an investment gain/loss.
        proceeds = .5 * 1.2 * (1. - .015)
        for index in (1, 2, 3):
            self.assert_close(delayed["daily"][index]["receivable_norm"], proceeds)
            self.assert_close(delayed["daily"][index]["cash_norm"], 0.)
        self.assert_close(delayed["daily"][4]["receivable_norm"], 0.)
        self.assert_close(delayed["daily"][4]["cash_norm"], proceeds)
        for actual, reference in zip(delayed["daily"], original["daily"]):
            self.assert_close(actual["total_norm"], reference["total_norm"])
            self.assert_close(actual["twr_index"], reference["twr_index"])
        self.assertEqual(delayed["cashflows"], original["cashflows"])

    def test_buy_before_settlement_needs_extra_external_contribution(self):
        data = public_path([
            ("2020-01-02", 1.), ("2020-01-03", 1.2),
            ("2020-01-06", .8), ("2020-01-07", .8),
            ("2020-01-08", .8),
        ])
        args = dict(initial_only=True, lag=0, buy_fee=0.,
                    redemption_tiers=(), detail=True)
        delayed = simulate_settlement(data, (.2, .2, .5, .5),
                                      redemption_settlement_workdays=3, **args)
        original = simulate(data, (.2, .2, .5, .5), **args)
        # Jan 3 sale leaves fund anchor value 0.6. Jan 6's buy budget is
        # half of that anchor = 0.3, although sale proceeds 0.6 are unsettled.
        self.assert_close(delayed["daily"][2]["extra_today_norm"], .3)
        self.assert_close(delayed["summary"]["extra_contributed_norm"], .3)
        self.assert_close(original["summary"]["extra_contributed_norm"], 0.)
        self.assert_close(delayed["daily"][2]["receivable_norm"], .6)
        self.assert_close(delayed["daily"][2]["total_norm"], 1.3)
        self.assert_close(delayed["daily"][4]["cash_norm"], .6)
        self.assert_close(delayed["daily"][4]["total_norm"], 1.3)
        self.assert_close(original["daily"][4]["total_norm"], 1.)
        # Flat NAV from the cash-injection day: the extra contribution does
        # not produce an artificial TWR gain.
        self.assert_close(delayed["daily"][-1]["twr_index"], 1.)
        self.assert_close(original["daily"][-1]["twr_index"], 1.)

    def test_weekday_count_skips_weekends_and_release_waits_for_observation(self):
        self.assertEqual(following_weekday(dt.date(2020, 1, 3), 1), dt.date(2020, 1, 6))
        self.assertEqual(following_weekday(dt.date(2020, 1, 3), 3), dt.date(2020, 1, 8))
        data = public_path([("2020-01-02", 1.), ("2020-01-03", 1.2),
                            ("2020-01-07", 1.2), ("2020-01-10", 1.2)])
        result = simulate_settlement(data, (.2, .9, .5, 0.), initial_only=True,
                                     lag=0, buy_fee=0., redemption_tiers=(), detail=True,
                                     redemption_settlement_workdays=3)
        self.assert_close(result["daily"][2]["receivable_norm"], .6)
        self.assert_close(result["daily"][3]["receivable_norm"], 0.)
        self.assert_close(result["daily"][3]["cash_norm"], .6)

    def test_delayed_contributions_still_enforce_funding_cap(self):
        data = public_path([("2020-01-02", 1.), ("2020-01-03", 1.2),
                            ("2020-01-06", .8), ("2020-01-08", .8)])
        result = simulate_settlement(data, (.2, .2, .5, .5), initial_only=True,
                                     lag=0, buy_fee=0., redemption_tiers=(),
                                     redemption_settlement_workdays=3, max_extra_ratio=.2)
        self.assertTrue(result["pruned"])
        self.assertEqual(result["violation_date"], "2020-01-06")
        self.assert_close(result["peak_extra_to_regular_ratio"], .3)

    def test_dividend_and_redemption_receivables_release_independently(self):
        data = prepare([{'date':'2020-01-02','nav':1.},
                        {'date':'2020-01-03','nav':1.1},
                        {'date':'2020-01-07','nav':1.1},
                        {'date':'2020-01-08','nav':1.1}],
                       [{'exdate':'2020-01-03','paydate':'2020-01-07','per_unit':.1}])
        result = simulate_settlement(data, (.1,.9,.5,0.), initial_only=True, lag=0,
                                     buy_fee=0., redemption_tiers=(), detail=True,
                                     redemption_settlement_workdays=3)
        self.assert_close(result['daily'][1]['receivable_norm'], .65)
        self.assert_close(result['daily'][2]['receivable_norm'], .55)
        self.assert_close(result['daily'][2]['cash_norm'], .1)
        self.assert_close(result['daily'][3]['receivable_norm'], 0.)
        self.assert_close(result['daily'][3]['cash_norm'], .65)
        for row in result['daily'][1:]:
            self.assert_close(row['total_norm'], 1.2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
