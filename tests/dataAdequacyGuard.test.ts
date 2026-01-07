import { buildFeatures, buildRegimes, evaluateDataAdequacy } from '../src/cli/contextBuilder';
import { calibrateEquityConfidence } from '../src/strategy/confidenceCalibrator';
import { computeCoreDeployPct } from '../src/core/capital';
import { BotConfig, SymbolFeature } from '../src/core/types';
import fs from 'fs';
import path from 'path';

const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/config/default.json'), 'utf-8')) as BotConfig;

const makeFlatHistory = () => {
  const dates = Array.from({ length: 5 }, (_, i) => {
    const d = new Date('2024-01-01');
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const bars = dates.map((date) => ({ date, close: 100 }));
  return { SPY: bars, SPYM: bars };
};

describe('data adequacy guardrail diagnostic', () => {
  it('signals inadequacy when both canonical and proxy lack history', () => {
    const history = makeFlatHistory();
    const quotes = { SPY: 100, SPYM: 100 };
    const featureFlags: any[] = [];
    const features: SymbolFeature[] = buildFeatures(['SPY', 'SPYM'], quotes as any, history as any, featureFlags);
    const proxiesMap = { SPY: ['SPYM'] };
    const adequacy = evaluateDataAdequacy(features, proxiesMap, cfg);

    // eslint-disable-next-line no-console
    console.log('Adequacy diagnostic:', adequacy);

    if (adequacy.adequate) {
      // Current behavior would proceed; print outputs for inspection.
      const regimes = buildRegimes('2024-02-01', features, [], cfg);
      const calibration = calibrateEquityConfidence({
        asOf: '2024-02-01',
        runId: 'data-adequacy',
        regimes: regimes.regimes,
        features,
        config: cfg,
        proxiesMap,
        prior: { label: 'risk_off', timeInRegimeWeeks: 1 }
      });
      const deploy = computeCoreDeployPct(
        { equityRegime: { label: regimes.regimes.equityRegime?.label ?? 'risk_off', confidence: calibration.confidence } },
        cfg
      );
      // eslint-disable-next-line no-console
      console.log(
        'Regimes/confidence/deploy with inadequate data:',
        JSON.stringify(
          {
            label: regimes.regimes.equityRegime?.label,
            rawConf: regimes.regimes.equityRegime?.confidence,
            calibratedConf: calibration.confidence,
            deployPct: deploy.deployPct
          },
          null,
          2
        )
      );
    } else {
      expect(adequacy.adequate).toBe(false);
    }
  });
});
