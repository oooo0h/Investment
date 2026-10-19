"""Conservation, causality and settlement tests on synthetic public-scale NAVs."""
import datetime as dt
import math
import unittest

import initial_position_quant_engine as engine


def sample(prices, start='2020-01-02', dividends=()):
    dates = []
    day = dt.date.fromisoformat(start)
    while len(dates) < len(prices):
        if day.weekday() < 5:
            dates.append(day.isoformat())
        day += dt.timedelta(days=1)
    return engine.prepare([{'date': day, 'nav': price} for day, price in zip(dates, prices)], dividends)


class InitialPositionEngineTests(unittest.TestCase):
    def test_existing_position_has_no_subscription_fee(self):
        data = sample([1., 1.2, .8, 1.1])
        result = engine.simulate(data, initial_only=True, detail=True)
        self.assertEqual(result['summary']['transaction_fees_norm'], 0.)
        self.assertEqual(result['summary']['buy_count'], 0)
        self.assertAlmostEqual(result['daily'][-1]['twr_index'], 1.1)
        self.assertAlmostEqual(result['summary']['mdd_pct'], 100./3.)
        self.assertEqual(result['cashflows'][0]['kind'], 'initial')
        self.assertEqual(result['cashflows'][0]['amount_norm'], 6.)

    def test_external_deposits_are_not_returns_and_share_daily_cap(self):
        data = sample([1.]*9)
        forced = {data['rows'][2]['date']: 1.3}
        result = engine.simulate(data, forced_extras=forced, buy_fee=0., detail=True)
        self.assertAlmostEqual(result['summary']['twr_total_pct'], 0.)
        self.assertAlmostEqual(result['summary']['ending_equity_norm'], 8.3)
        self.assertAlmostEqual(result['summary']['extra_total_norm'], 1.3)
        self.assertAlmostEqual(result['summary']['xirr_pct'], 0., places=9)
        self.assertTrue(all(row['gross_buy_today_norm'] <= .5 for row in result['daily']))
        self.assertEqual([round(trade['budget_norm'], 8) for trade in result['trades']], [.5,.5,.5,.5,.3])

    def test_large_deposit_cannot_erase_a_drawdown(self):
        data = sample([1.,.5,.5])
        result = engine.simulate(data, initial_only=True, buy_fee=0.,
                                 forced_extras={data['rows'][1]['date']: 10.}, detail=True)
        self.assertAlmostEqual(result['summary']['mdd_pct'], 50.)
        self.assertAlmostEqual(result['summary']['twr_total_pct'], -50.)

    def test_new_annual_plan_cancels_tactical_remainder(self):
        data = sample([1.,.7,.7,.7,.7,.7,.7,.7], start='2020-12-28')
        result = engine.simulate(data, (.2,.2,.2,.4), signal_lag=0,
                                 buy_fee=0., detail=True)
        self.assertEqual(result['summary']['cancelled_pending'], 1)
        self.assertGreater(result['summary']['cancelled_tactical_buy_budget_norm'], 0.)
        newyear = [trade for trade in result['trades'] if trade['date'] >= '2021-01-01']
        self.assertEqual([trade['kind'] for trade in newyear], ['scheduled_buy','scheduled_buy'])

    def test_signal_cannot_see_today_or_unpublished_trade_anchor(self):
        data = sample([1.,1.3,1.3,1.3,.7,2.,2.,2.,2.,2.,2.,2.])
        result = engine.simulate(data, (.2,.2,.5,.25), initial_only=True, buy_fee=0., detail=True)
        trades = result['trades']
        self.assertEqual(trades[0]['date'], data['rows'][4]['date'])
        self.assertEqual(trades[0]['known_nav_date'], data['rows'][1]['date'])
        self.assertAlmostEqual(trades[0]['budget_norm'], 2.1)
        # After execution at index 4, index 4 NAV is first known at index 7;
        # it equals the anchor, so no fresh signal is possible before index 8.
        self.assertGreaterEqual(trades[1]['date'], data['rows'][8]['date'])

    def test_dividend_is_receivable_and_does_not_generate_false_drop_signal(self):
        prices = [1.,1.,.9,.9,.9,.9,.9,.9]
        base = sample(prices)
        div = {'exdate': base['rows'][2]['date'], 'paydate': base['rows'][5]['date'], 'per_unit': .1}
        data = sample(prices, dividends=[div])
        result = engine.simulate(data, (.05,.05,.2,.2), initial_only=True, detail=True)
        self.assertEqual(result['trades'], [])
        self.assertAlmostEqual(result['summary']['twr_total_pct'], 0.)
        self.assertAlmostEqual(result['daily'][2]['dividend_receivable_norm'], .6)
        self.assertAlmostEqual(result['daily'][2]['cash_norm'], 0.)
        self.assertAlmostEqual(result['daily'][5]['cash_norm'], .6)
        self.assertAlmostEqual(result['daily'][5]['dividend_receivable_norm'], 0.)

    def test_fifo_fees_use_confirmation_age_and_unsellable_lots_wait(self):
        data = sample([1.,1.1,1.2,1.3,1.3,1.3,1.3,1.3,1.3,1.3])
        # Annual fills index 0,1. Immediate synthetic signals may sell only
        # the initial lot at index 2; later pending FIFO lots must wait.
        result = engine.simulate(data, (.01,.1,1.,0.), signal_lag=0,
                                 confirm_lag=4, sellability_lag=5, detail=True)
        sells = [trade for trade in result['trades'] if trade['kind']=='sell']
        self.assertEqual(sells[0]['date'], data['rows'][2]['date'])
        self.assertEqual(sells[0]['fee_components'][0]['fee_rate'], .003)
        for trade in sells[1:]:
            self.assertGreaterEqual(trade['date'], data['rows'][5]['date'])
            for part in trade['fee_components']:
                bought = dt.date.fromisoformat(part['subscription_confirmation_date'])
                sold = dt.date.fromisoformat(part['redemption_confirmation_date'])
                self.assertEqual(part['holding_age_days'], (sold-bought).days)
                self.assertEqual(part['fee_rate'], .015 if (sold-bought).days < 7 else .005)
        for row in result['daily']:
            self.assertGreaterEqual(row['cash_norm'], 0.)

    def test_redemption_fee_boundary_uses_confirmation_not_application(self):
        data = sample([1.,1.1,1.3,1.3,1.3,1.3])
        result = engine.simulate(data, (.2,.2,.5,.2), initial_only=True,
                                 initial_age_days=360, signal_lag=0, detail=True)
        sale = next(trade for trade in result['trades'] if trade['kind']=='sell')
        component = sale['fee_components'][0]
        self.assertEqual(sale['date'], '2020-01-06')
        self.assertEqual(component['holding_age_days'], 366)
        self.assertEqual(component['fee_rate'], .003)

    def test_redemption_is_not_spendable_until_settlement(self):
        data = sample([1.,1.3,.7,.7,.7,.7,.7,.7,.7,.7,.7])
        result = engine.simulate(data, (.2,.2,.5,1.), initial_only=True,
                                 signal_lag=0, buy_fee=0., redemption_settlement_workdays=10,
                                 detail=True)
        sell = next(trade for trade in result['trades'] if trade['kind']=='sell')
        buys = [trade for trade in result['trades'] if trade['kind']=='buy']
        self.assertTrue(buys)
        self.assertTrue(any(trade['extra_norm'] > 0 for trade in buys
                            if trade['date'] < sell['settlement_date']))
        self.assertTrue(any(row['redemption_receivable_norm'] > 0 and row['cash_norm']==0
                            for row in result['daily']))

    def test_buy_queue_preserves_original_budget_and_topups_only_fills(self):
        data = sample([1.,.7,.7,.7,.7,.7,.7,.7,.7])
        result = engine.simulate(data, (.2,.2,.2,.4), initial_only=True,
                                 signal_lag=0, buy_fee=0., detail=True)
        buys = [trade for trade in result['trades'] if trade['kind']=='buy']
        self.assertEqual(len(buys), 5)
        self.assertTrue(all(math.isclose(trade['original_budget_norm'], 2.4) for trade in buys))
        self.assertAlmostEqual(sum(trade['budget_norm'] for trade in buys), 2.4)
        self.assertAlmostEqual(result['summary']['extra_total_norm'], 2.4)
        self.assertEqual(result['summary']['tactical_buy_signal_count'], 1)

    def test_twr_fee_is_removed_after_same_price_deposit(self):
        data = sample([1.,1.,1.])
        result = engine.simulate(data, detail=True)
        fee_per_fill = .5-.5/1.0016
        expected = (1-fee_per_fill/7.)*(1-fee_per_fill/(7.-fee_per_fill))
        self.assertAlmostEqual(result['daily'][-1]['twr_index'], expected)
        self.assertAlmostEqual(result['summary']['transaction_fees_norm'], 2*fee_per_fill)

    def test_calendar_proration_does_not_depend_on_last_observation(self):
        short = sample([1.]*3, start='2020-06-09')
        long = sample([1.]*20, start='2020-06-09')
        self.assertAlmostEqual(short['annual'][0], 7./12.)
        self.assertEqual(short['annual'][0], long['annual'][0])


if __name__ == '__main__':
    unittest.main(verbosity=2)
