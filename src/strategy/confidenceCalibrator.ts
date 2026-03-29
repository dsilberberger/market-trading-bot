import fs from 'fs';
import path from 'path';
import { BotConfig, RegimeContext, SymbolFeature } from '../core/types';

type RampConfig = {
  minWeeks?: number;
  maxWeeks?: number;
  startProgress?: number;
  endProgress?: number;
};

export interface ConfidenceCalibrationResult {
  confidence: number;
  timeInRegimeWeeks: number;
  diagnostics: any;
  flags: Array<{ code: string; severity: 'info' | 'warn'; message: string }>;
}

export interface ConfidenceCalibrationOptions {
  asOf: string;
  runId?: string;
  regimes: RegimeContext;
  features: SymbolFeature[];
  config: BotConfig;
  proxiesMap?: Record<string, string[]>;
  prior?: { label?: string; timeInRegimeWeeks?: number };
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const bucketToScore = (b: string | undefined) => (b === 'high' ? 0.8 : b === 'mid' ? 0.5 : b === 'low' ? 0.2 : 0.4);

const sign = (v?: number): -1 | 0 | 1 => {
  if (v === undefined || v === null) return 0;
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
};

const deriveAgreementScore = (returns: Array<number | undefined>): number => {
  const signs = returns.map(sign);
  const directionalSigns = signs.filter((s) => s !== 0);
  if (!directionalSigns.length) return 0;
  const counts = directionalSigns.reduce<Record<string, number>>((acc, s) => {
    acc[String(s)] = (acc[String(s)] || 0) + 1;
    return acc;
  }, {});
  return Math.max(...Object.values(counts), 0) / 3;
};

export const computeBaseEquityConfidence = (f?: SymbolFeature | null): number | null => {
  if (!f) return null;
  const volBucket = f.vol20dPctileBucket ?? 'unknown';
  const retBucket = f.return60dPctileBucket ?? 'unknown';
  const ret60 = f.return60d ?? 0;
  const above200 = f.above200dma ?? false;
  const baseSignal = Math.max(0.2, Math.abs(ret60) * 5 + (above200 ? 0.2 : 0));
  const agreementScore = f.agreementScore ?? deriveAgreementScore([f.return4w, f.return12w, f.return24w]);
  const stability = f.stabilityScore ?? 0;
  const agreementBoost = 0.15 * agreementScore;
  const stabilityBoost = 0.15 * stability;
  let equityConf = clamp(baseSignal + agreementBoost + stabilityBoost, 0, 1);
  if (retBucket === 'unknown' || volBucket === 'unknown') {
    equityConf = Math.min(equityConf, 0.4);
  }
  return equityConf;
};

const computeConfidenceFromFeature = (f?: SymbolFeature | null): number | null => {
  const equityConfBase = computeBaseEquityConfidence(f);
  if (equityConfBase === null || !f) return null;
  // Mild adjustment toward bucket quality
  let equityConf = equityConfBase;
  const volBucket = f.vol20dPctileBucket ?? 'unknown';
  const retBucket = f.return60dPctileBucket ?? 'unknown';
  const volScore = bucketToScore(volBucket);
  const retScore = bucketToScore(retBucket);
  equityConf = Math.max(equityConf, Math.min(1, (volScore + retScore) / 2));
  return equityConf;
};

const resolveProxy = (
  symbol: string,
  configProxyMap?: Record<string, string>,
  proxiesMap?: Record<string, string[]>
): string | undefined => {
  if (configProxyMap && configProxyMap[symbol]) return configProxyMap[symbol];
  if (proxiesMap?.[symbol]?.length) return proxiesMap[symbol][0];
  if (proxiesMap) {
    const parent = Object.entries(proxiesMap).find(([, children]) => (children || []).includes(symbol));
    if (parent) return parent[0];
  }
  return undefined;
};

const loadPreviousRegimeState = (currentRunId?: string): { label?: string; timeInRegimeWeeks?: number } | undefined => {
  const runsDir = path.resolve(process.cwd(), 'runs');
  if (!fs.existsSync(runsDir)) return undefined;
  const dirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== currentRunId)
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const name of dirs) {
    const diagPath = path.join(runsDir, name, 'confidence_diagnostics.json');
    const regimesPath = path.join(runsDir, name, 'regimes.json');
    try {
      if (fs.existsSync(diagPath)) {
        const diag = JSON.parse(fs.readFileSync(diagPath, 'utf-8'));
        return { label: diag?.base?.label ?? diag?.regimeLabel, timeInRegimeWeeks: diag?.timeInRegimeWeeks };
      }
      if (fs.existsSync(regimesPath)) {
        const r = JSON.parse(fs.readFileSync(regimesPath, 'utf-8')) as RegimeContext;
        return { label: r?.equityRegime?.label, timeInRegimeWeeks: (r as any)?.equityRegime?.timeInRegimeWeeks };
      }
    } catch {
      continue;
    }
  }
  return undefined;
};

const computeRampProgress = (weeks: number, ramp: RampConfig): number => {
  const minWeeks = ramp.minWeeks ?? 0;
  const maxWeeks = Math.max(minWeeks + 1, ramp.maxWeeks ?? 4);
  const startProgress = ramp.startProgress ?? 0;
  const endProgress = ramp.endProgress ?? 1;
  const span = maxWeeks - minWeeks;
  const position = clamp((weeks - minWeeks) / span, 0, 1);
  return clamp(startProgress + (endProgress - startProgress) * position, 0, 1);
};

export const calibrateEquityConfidence = (opts: ConfidenceCalibrationOptions): ConfidenceCalibrationResult => {
  const { asOf, runId, regimes, features, config, proxiesMap, prior } = opts;
  const calibCfg = config.confidenceCalibration || {};
  const anchorSymbol = calibCfg.anchorSymbol || features[0]?.symbol || 'SPY';
  const minHistoryDays = calibCfg.minHistoryDays ?? 120;
  const coverageFloor = calibCfg.coverageFloorConfidence ?? 0.55;
  const anchor = features.find((f) => f.symbol === anchorSymbol) || features[0];
  const barInterval = anchor?.barInterval === '1w' ? '1w' : '1d';
  const coverageDays = (anchor?.historySamples ?? 0) * (barInterval === '1w' ? 7 : 1);
  const coverageSufficient = coverageDays >= minHistoryDays;
  const baseConfidence = regimes?.equityRegime?.confidence ?? 0;
  const baseLabel = regimes?.equityRegime?.label;

  // Proxy candidate (for confidence normalization only)
  const proxyMap = calibCfg.proxyMap as Record<string, string> | undefined;
  const proxySymbol = resolveProxy(anchor?.symbol || anchorSymbol, proxyMap, proxiesMap);
  const proxyFeature = proxySymbol ? features.find((f) => f.symbol === proxySymbol) : undefined;
  const proxyConfidence = !coverageSufficient ? computeConfidenceFromFeature(proxyFeature) : null;

  // Target confidence floor when coverage is lacking
  const targetConfidence = Math.max(
    baseConfidence,
    coverageSufficient ? 0 : coverageFloor,
    proxyConfidence ?? 0
  );

  // Time-in-regime ramp
  const prev = prior || loadPreviousRegimeState(runId);
  const timeInRegimeWeeks =
    prev && prev.label && prev.label === baseLabel ? (prev.timeInRegimeWeeks ?? 0) + 1 : 1;
  const rampCfg: RampConfig = calibCfg.timeInRegimeRamp || { minWeeks: 0, maxWeeks: 2, startProgress: 0, endProgress: 1 };
  const rampProgress = computeRampProgress(timeInRegimeWeeks, rampCfg);
  const calibratedConfidence =
    baseConfidence + (targetConfidence - baseConfidence) * rampProgress;
  const finalConfidence = clamp(calibratedConfidence, 0, 1);
  let confidenceQuality: 'full' | 'degraded' | 'blocked' = 'full';
  if (!coverageSufficient && proxyConfidence === null) confidenceQuality = 'blocked';
  else if (!coverageSufficient || proxyConfidence !== null) confidenceQuality = 'degraded';

  const diagnostics = {
    asOf,
    runId,
    regimeLabel: baseLabel,
    base: {
      label: baseLabel,
      confidence: baseConfidence,
      historySamples: anchor?.historySamples ?? null,
      historyUniqueCloses: anchor?.historyUniqueCloses ?? null,
      coverageDays,
      barInterval
    },
    proxy: proxySymbol
      ? {
          symbol: proxySymbol,
          confidence: proxyConfidence,
          historySamples: proxyFeature?.historySamples ?? null,
          historyUniqueCloses: proxyFeature?.historyUniqueCloses ?? null
        }
      : null,
    thresholds: { minHistoryDays, coverageFloorConfidence: coverageFloor },
    coverage: { sufficient: coverageSufficient, ratio: minHistoryDays ? coverageDays / minHistoryDays : 1 },
    timeInRegimeWeeks,
    ramp: { ...rampCfg, progress: rampProgress },
    confidence: { base: baseConfidence, target: targetConfidence, calibrated: finalConfidence, quality: confidenceQuality }
  };

  const flags: Array<{ code: string; severity: 'info' | 'warn'; message: string }> = [];
  if (!coverageSufficient) {
    flags.push({ code: 'CONFIDENCE_COVERAGE_EXTENDED', severity: 'info', message: 'Confidence calibrated due to limited history.' });
  }
  if (proxySymbol && proxyConfidence !== null) {
    flags.push({ code: 'CONFIDENCE_PROXY_USED', severity: 'info', message: `Confidence normalization used proxy ${proxySymbol}.` });
  }
  if (rampProgress > 0 && !coverageSufficient) {
    flags.push({ code: 'CONFIDENCE_RAMP_APPLIED', severity: 'info', message: 'Time-in-regime ramp applied to confidence.' });
  }

  return { confidence: finalConfidence, timeInRegimeWeeks, diagnostics, flags };
};
