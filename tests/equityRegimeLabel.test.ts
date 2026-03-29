import fs from 'fs';
import path from 'path';
import { buildRegimes } from '../src/cli/contextBuilder';
import { BotConfig, SymbolFeature } from '../src/core/types';

const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/config/default.json'), 'utf-8')) as BotConfig;

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
