import { runSimulation } from '../scripts/simDislocation';

describe('dislocation sim harness', () => {
  it('overlay deploys when base respects cap', () => {
    const res = runSimulation({ baselineInitMode: 'respect_cap' });
    // Cash never negative
    res.forEach((w) => expect(w.cash).toBeGreaterThanOrEqual(0));
    // Find first ADD week
    const addWeek = res.find((w) => w.phase === 'ADD');
    expect(addWeek).toBeDefined();
    // Expect overlay orders present proxy-only
    const overlay = res.find((w) => w.overlayOrders.length > 0);
    expect(overlay).toBeDefined();
    if (overlay) {
      overlay.overlayOrders.forEach((o) => {
        expect(['SPYM', 'QQQM']).toContain(o.symbol);
        expect(o.side).toBe('BUY');
      });
    }
  });

  it('overlay does not deploy when fully invested baseline', () => {
    const res = runSimulation({ baselineInitMode: 'fully_invested' });
    res.forEach((w) => expect(w.cash).toBeGreaterThanOrEqual(0));
    const overlay = res.find((w) => w.overlayOrders.length > 0);
    expect(overlay).toBeUndefined();
  });

  it('reintegrate resumes sells and stops overlay', () => {
    const res = runSimulation({ baselineInitMode: 'respect_cap' });
    const reintegrateWeeks = res.filter((w) => w.phase === 'REINTEGRATE');
    expect(reintegrateWeeks.length).toBeGreaterThan(0);
    reintegrateWeeks.forEach((w) => {
      expect(w.controls.protectFromSells).toBe(false);
      expect(w.overlayOrders.length).toBe(0);
    });
    const anyReintegrateSell = reintegrateWeeks.some((w) => w.orders.some((o) => o.side === 'SELL'));
    expect(anyReintegrateSell).toBe(true);
  });
});
