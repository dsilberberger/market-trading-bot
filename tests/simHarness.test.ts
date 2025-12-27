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
});
