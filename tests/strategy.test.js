const { test, describe } = require('node:test');
const assert = require('node:assert');
const { buildGrid, gridTotal, computeTpPlan, shouldEmergencyStop } = require('../src/strategy');

const P = {
  initialOrder: 10, orderMultiplier: 1.05, maxOrders: 30, priceDropPercent: 1.33,
};
const TP = { mode: 'base', profitTargetPercent: 8, minUsdProfitPct: 0.5 };

describe('buildGrid', () => {
  test('levels, spacing and cumulative totals', () => {
    const g = buildGrid(200, P);
    assert.equal(g.length, 30);
    assert.equal(g[0].limitPrice, 200);
    assert.ok(Math.abs(g[1].limitPrice - 200 * (1 - 0.0133)) < 1e-9);
    assert.ok(Math.abs(g[29].limitPrice - 200 * (1 - 0.3857)) < 1e-9);
    // geometric sum: 10 * (1.05^30 - 1) / 0.05 = 664.39…
    assert.ok(Math.abs(gridTotal(g) - 10 * (Math.pow(1.05, 30) - 1) / 0.05) < 1e-9);
  });
  test('rejects bad entry', () => assert.throws(() => buildGrid(0, P)));
});

describe('computeTpPlan — regressions for the original bugs', () => {
  test('sellBase NEVER exceeds holdings (original sold 108%)', () => {
    for (const [invested, holdings] of [[10, 0.05], [20.5, 0.1032], [664, 4.1], [1, 0.001]]) {
      const avg = invested / holdings;
      const plan = computeTpPlan({ invested, holdings, avgEntry: avg }, TP);
      assert.ok(plan.armed);
      assert.ok(plan.sellBase <= holdings + 1e-12, `sellBase ${plan.sellBase} > holdings ${holdings}`);
      assert.ok(plan.keepBase >= 0);
    }
  });

  test('exit price is ABOVE avg entry (original was below → fake profit)', () => {
    const plan = computeTpPlan({ invested: 10, holdings: 0.05, avgEntry: 200 }, TP);
    assert.ok(plan.exitPrice > 200, `exit ${plan.exitPrice} must exceed avgEntry 200`);
    assert.ok(plan.profitUsd > 0, 'USD P/L must be positive at plan exit');
  });

  test('base mode recovers capital + floor while keeping ~8% extra', () => {
    const plan = computeTpPlan({ invested: 20.5, holdings: 0.1032, avgEntry: 198.64 }, TP);
    assert.equal(plan.mode, 'base');
    assert.ok(Math.abs(plan.keepBase / 0.1032 - 0.08) < 1e-9);
    assert.ok(plan.expectedProceeds >= 20.5 * 1.005 - 1e-9, 'proceeds ≥ invested×(1+floor)');
    assert.ok(plan.sellBase > 0);
  });

  test('usd mode sells everything at +p% over avg', () => {
    const plan = computeTpPlan({ invested: 10, holdings: 0.05, avgEntry: 200 }, { ...TP, mode: 'usd' });
    assert.equal(plan.sellBase, 0.05);
    assert.equal(plan.keepBase, 0);
    assert.ok(Math.abs(plan.exitPrice - 216) < 1e-9); // 200×1.08
    assert.ok(Math.abs(plan.profitUsd - 0.8) < 1e-9); // +8% of $10
  });

  test('zero state returns null', () => {
    assert.equal(computeTpPlan({ invested: 0, holdings: 0, avgEntry: 0 }, TP), null);
  });
});

describe('shouldEmergencyStop', () => {
  test('disabled → never fires', () => {
    assert.equal(shouldEmergencyStop(100, 200, { emergencyStopEnabled: false, emergencyStopPercent: 30 }), false);
  });
  test('fires at/below threshold only', () => {
    const p = { emergencyStopEnabled: true, emergencyStopPercent: 30 };
    assert.equal(shouldEmergencyStop(140.01, 200, p), false); // above threshold
    assert.equal(shouldEmergencyStop(140, 200, p), true);     // exactly at threshold fires
    assert.equal(shouldEmergencyStop(100, 200, p), true);
  });
});
