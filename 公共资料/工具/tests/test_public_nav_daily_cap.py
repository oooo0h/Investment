"""Independent accounting tests; only arbitrary hypothetical budget ratios."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from annual_threshold_backtest import prepare, simulate
from annual_threshold_settlement import simulate_settlement
from annual_threshold_daily_cap import simulate_capped


def path(pairs, dividends=()):
    return prepare([{'date': date, 'nav': nav} for date, nav in pairs], dividends)


class DailySubscriptionCap(unittest.TestCase):
    def close(self, actual, expected):
        self.assertAlmostEqual(actual, expected, delta=1e-9*max(1., abs(expected)))

    def test_no_cap_is_exact_original_and_settlement_output(self):
        data = path([('2020-01-02',1.),('2020-01-03',1.),('2020-03-02',.8),
                     ('2020-09-01',1.2),('2020-12-01',.9)])
        for detailed in (False, True):
            for settlement in (0, 7):
                with self.subTest(detail=detailed, settlement=settlement):
                    args = dict(detail=detailed, lag=0, buy_fee=.0015)
                    expected = (simulate(data, (.2,.2,.5,.5), **args) if not settlement else
                                simulate_settlement(data, (.2,.2,.5,.5),
                                                    redemption_settlement_workdays=settlement, **args))
                    self.assertEqual(simulate_capped(data, (.2,.2,.5,.5),
                                                     redemption_settlement_workdays=settlement, **args), expected)

    def test_annual_credit_is_upfront_and_partial_fills_obey_daily_cap(self):
        data = path([('2020-01-02',1.),('2020-01-03',2.),('2020-01-06',2.)])
        result = simulate_capped(data, daily_buy_cap_norm=.4, buy_fee=0.,
                                 redemption_tiers=(), detail=True)
        self.assertEqual([x['regular_today_norm'] for x in result['daily']], [1.,0.,0.])
        for actual, expected in zip([x['gross_buy_today_norm'] for x in result['daily']], [.4,.4,.2]):
            self.close(actual, expected)
        self.close(result['daily'][0]['cash_norm'], .6)
        self.close(result['daily'][1]['cash_norm'], .2)
        self.close(result['daily'][2]['cash_norm'], 0.)
        # 0.4 shares initially; next 0.4 buys 0.2 shares, then 0.2 buys
        # 0.1 shares. Final equity is 0.7*2, rather than the full-invested 2.
        self.close(result['summary']['end_total_norm'], 1.4)
        self.close(result['daily'][-1]['twr_index'], 1.4)
        self.assertIsNone(result['summary']['pending_order'])

    def test_annual_partial_fill_remains_explicitly_queued_at_cutoff(self):
        data = path([('2020-01-02',1.),('2020-01-03',1.)])
        result = simulate_capped(data, daily_buy_cap_norm=.3, buy_fee=0., detail=True)
        self.close(result['summary']['pending_scheduled_order']['remaining_budget_norm'], .4)
        self.close(result['daily'][-1]['cash_norm'], .4)
        self.close(result['daily'][-1]['twr_index'], 1.)

    def test_tactical_budget_fixed_while_filling_and_no_total_extra_cap(self):
        data = path([('2020-01-02',1.),('2020-01-03',1.),('2020-03-02',.8),
                     ('2020-09-01',.6),('2020-09-02',.6),
                     ('2020-12-01',.4),('2020-12-02',.4)])
        result = simulate_capped(data, (.6,.2,0.,.5), daily_buy_cap_norm=.5,
                                 buy_fee=0., redemption_tiers=(), lag=0, detail=True)
        buys = [x for x in result['trades'] if x['kind']=='buy']
        # First buy is 0.5 at NAV0.8. Its posttrade value becomes 1.3.
        # Next signal fixes budget 1.3*0.5=0.65, filled 0.5 then 0.15;
        # changing anchors after its first fill must not resize this order.
        self.close(buys[0]['budget_norm'], .5)
        self.close(buys[1]['budget_norm'], .5)
        self.close(buys[2]['budget_norm'], .15)
        self.assertEqual(buys[1]['signal_date'], buys[2]['signal_date'])
        self.assertEqual(result['summary']['tactical_buy_signal_count'], 3)
        self.assertGreater(result['summary']['extra_over_regular_pct'], 100.)
        self.assertFalse(result['summary'].get('pruned', False))
        for day in result['daily']:
            self.assertLessEqual(day['gross_buy_today_norm'], .5+1e-12)
            self.close(day['extra_today_norm'], max(0., day['gross_buy_today_norm']-
                       (1. if day['date']=='2020-01-02' else
                        .5 if day['date']=='2020-01-03' else 0.)))

    def test_new_annual_buy_cancels_only_unfilled_tactical_remainder(self):
        data = path([('2020-01-02',1.),('2020-01-03',1.),('2020-03-02',.8),
                     ('2020-12-30',.6),('2021-01-04',.6),('2021-01-05',.6)])
        result = simulate_capped(data, (.6,.2,0.,.5), daily_buy_cap_norm=.5,
                                 buy_fee=0., redemption_tiers=(), lag=0, detail=True)
        self.assertEqual(result['summary']['cancelled_pending'], 1)
        self.close(result['summary']['cancelled_tactical_buy_budget_norm'], .15)
        self.close(result['summary']['extra_contributed_norm'], 1.)
        self.assertEqual([x['kind'] for x in result['trades'][-2:]], ['scheduled_buy','scheduled_buy'])
        self.assertIsNone(result['summary']['pending_tactical_order'])

    def test_fifo_fee_uses_actual_partial_fill_dates(self):
        data = path([('2020-01-01',1.),('2022-01-01',1.),('2022-01-02',1.2)])
        result = simulate_capped(data, (.1,.9,.75,0.), initial_only=True,
                                 daily_buy_cap_norm=.5, lag=0, buy_fee=0., detail=True)
        # The original planned buy is filled half in2020 and half in2022.
        # A 0.75-share sale exhausts the old half-share (no fee) then a young
        # quarter-share (1.5%), rather than charging against an average age.
        self.close(result['summary']['transaction_fees_norm'], .25*1.2*.015)

    def test_dividend_settlement_and_only_actual_fill_shortfall_is_external(self):
        data = path([('2020-01-02',1.),('2020-01-03',1.),('2020-01-06',1.1),
                     ('2020-01-07',.8),('2020-01-08',.8)],
                    [{'exdate':'2020-01-06','paydate':'2020-01-08','per_unit':.1}])
        result = simulate_capped(data, (.1,.2,.5,.5), daily_buy_cap_norm=.5,
                                 redemption_settlement_workdays=2, lag=0, buy_fee=0.,
                                 redemption_tiers=(), detail=True)
        # Sell half a share at1.1; dividend entitlement0.1 plus sale0.55
        # remain receivable. Next buy gross0.275 requires that exact extra,
        # rather than spending unsettled proceeds or adding the whole cap.
        self.close(result['daily'][2]['receivable_norm'], .65)
        self.close(result['daily'][3]['extra_today_norm'], .275)
        self.close(result['daily'][3]['total_norm'], 1.325)
        self.close(result['daily'][4]['receivable_norm'], 0.)
        self.close(result['daily'][4]['cash_norm'], .65)
        self.close(result['daily'][4]['total_norm'], 1.325)
        self.close(result['daily'][3]['twr_index'], 1.05)
        self.close(result['daily'][4]['twr_index'], 1.05)

    def test_cap_queue_and_actual_trades_are_prefix_causal(self):
        pairs = [('2020-01-02',1.),('2020-01-03',1.),('2020-03-02',.8),
                 ('2020-09-01',.6),('2020-09-02',.6),('2020-12-01',.4)]
        args = dict(rule=(.6,.2,0.,.5), daily_buy_cap_norm=.5, buy_fee=0.,
                    redemption_tiers=(), lag=0, detail=True)
        full = simulate_capped(path(pairs), **args)
        for length in range(2, len(pairs)):
            with self.subTest(prefix=length):
                shorter = simulate_capped(path(pairs[:length]), **args)
                self.assertEqual(shorter['daily'], full['daily'][:length])
                self.assertEqual(shorter['trades'], [x for x in full['trades'] if x['date']<=pairs[length-1][0]])


if __name__=='__main__':
    unittest.main(verbosity=2)
