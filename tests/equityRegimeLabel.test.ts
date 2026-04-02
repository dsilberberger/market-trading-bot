import fs from 'fs';
import path from 'path';
import { buildRegimes } from '../src/cli/contextBuilder';
import { BotConfig, SymbolFeature } from '../src/core/types';

const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/config/default.json'), 'utf-8')) as BotConfig;
const recoveryFriendlyCfg = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), 'src/config/default.recovery_friendly_regime_gate.position_size_scaled_risk_gate.json'),
    'utf-8'
  )
) as BotConfig;
const makeConfig = (mutate?: (config: BotConfig) => void): BotConfig => {
  const next = JSON.parse(JSON.stringify(cfg)) as BotConfig;
  mutate?.(next);
  return next;
};

const makeAnchor = (overrides: Partial<SymbolFeature> = {}): SymbolFeature =>
  ({
    symbol: 'VTI',
    price: 100,
    barInterval: '1w',
    return60d: 0,
    return12w: 0,
    return24w: 0,
    return60dPctileBucket: 'mid',
    vol20dPctileBucket: 'mid',
    above200dma: false,
    agreementScore: 0,
    stabilityScore: 0.4,
    historySamples: 36,
    historyUniqueCloses: 36,
    ...overrides
  }) as SymbolFeature;

describe('equity regime label multi-horizon rule', () => {
  it('promotes quiet downside alignment from neutral to risk_off', () => {
    const { regimes } = buildRegimes(
      '2026-01-22',
      [makeAnchor({ return12w: -0.0117, return24w: -0.007, agreementScore: 1, stabilityScore: 0.73 })],
      [],
      cfg
    );

    expect(regimes.equityRegime?.label).toBe('risk_off');
  });

  it('promotes quiet upside alignment from neutral to risk_on', () => {
    const { regimes } = buildRegimes(
      '2026-02-05',
      [makeAnchor({ return12w: 0.0082, return24w: 0.0111, agreementScore: 2 / 3, stabilityScore: 0.64 })],
      [],
      cfg
    );

    expect(regimes.equityRegime?.label).toBe('risk_on');
  });

  it('keeps conflicting-horizon structure neutral', () => {
    const { regimes } = buildRegimes(
      '2026-01-29',
      [makeAnchor({ return12w: -0.005, return24w: 0.0045, agreementScore: 2 / 3, stabilityScore: 0.36 })],
      [],
      cfg
    );

    expect(regimes.equityRegime?.label).toBe('neutral');
  });

  it('keeps the vol-based safety trigger forcing risk_off', () => {
    const { regimes } = buildRegimes(
      '2026-01-15',
      [makeAnchor({ return12w: 0.01, return24w: 0.02, agreementScore: 1, stabilityScore: 0.9, vol20dPctileBucket: 'high' })],
      [],
      cfg
    );

    expect(regimes.equityRegime?.label).toBe('risk_off');
  });

  it('keeps clearly weak upside neutral under the experimental regime gate', () => {
    const { regimes } = buildRegimes(
      '2026-04-03',
      [makeAnchor({ return12w: 0.003, return24w: 0.004, agreementScore: 2 / 3, stabilityScore: 0.53, vol20dPctileBucket: 'mid' })],
      [],
      recoveryFriendlyCfg
    );

    expect(regimes.equityRegime?.label).toBe('neutral');
  });

  it('allows borderline favorable mid-vol upside to qualify as risk_on under the experimental gate', () => {
    const anchor = makeAnchor({ return12w: 0.0082, return24w: 0.0111, agreementScore: 2 / 3, stabilityScore: 0.54 });

    const baseline = buildRegimes('2026-04-10', [anchor], [], cfg);
    const experimental = buildRegimes('2026-04-10', [anchor], [], recoveryFriendlyCfg);

    expect(baseline.regimes.equityRegime?.label).toBe('neutral');
    expect(experimental.regimes.equityRegime?.label).toBe('risk_on');
  });

  it('allows a strong high-vol recovery to override into risk_on under the experimental gate', () => {
    const anchor = makeAnchor({
      return60d: 0.12,
      return12w: 0.014,
      return24w: 0.02,
      agreementScore: 1,
      stabilityScore: 0.74,
      vol20dPctileBucket: 'high',
      above200dma: true
    });

    const baseline = buildRegimes('2026-04-17', [anchor], [], cfg);
    const experimental = buildRegimes('2026-04-17', [anchor], [], recoveryFriendlyCfg);

    expect(baseline.regimes.equityRegime?.label).toBe('risk_off');
    expect(experimental.regimes.equityRegime?.label).toBe('risk_on');
  });

  it('keeps clearly weak high-vol conditions out of risk_on under the promoted recovery-friendly config', () => {
    const { regimes } = buildRegimes(
      '2026-04-24',
      [
        makeAnchor({
          return60d: 0.01,
          return12w: 0.004,
          return24w: 0.002,
          agreementScore: 2 / 3,
          stabilityScore: 0.53,
          vol20dPctileBucket: 'high'
        })
      ],
      [],
      recoveryFriendlyCfg
    );

    expect(regimes.equityRegime?.label).not.toBe('risk_on');
  });

  it('keeps weak aligned downside neutral', () => {
    const { regimes } = buildRegimes(
      '2026-03-27',
      [makeAnchor({ return12w: -0.0008, return24w: -0.0055, agreementScore: 1, stabilityScore: 0.58 })],
      [],
      cfg
    );

    expect(regimes.equityRegime?.label).toBe('neutral');
  });
});
