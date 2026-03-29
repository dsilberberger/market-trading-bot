import { BotConfig, PriceBar } from '../core/types';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const toIsoDate = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value.slice(0, 10) : d.toISOString().slice(0, 10);
};

const cumulativeReturn = (returns: number[]) => returns.reduce((acc, r) => acc * (1 + r), 1) - 1;

const sampleStdDev = (values: number[]) => {
  if (values.length < 2) return 0;
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

export interface PostRiskOffReentryDiagnostics {
  currentPrice: number | null;
  episodeLowPrice: number | null;
  episodeLowDateISO?: string;
  daysSinceLow: number;
  ret3: number | null;
  ret5: number | null;
  nonNegativeShare5: number;
  recentVol3: number | null;
  episodeVolPeak3: number | null;
  sma5: number | null;
  priorSma5: number | null;
  gates: {
    volCooling: boolean;
    ret3: boolean;
    ret5: boolean;
    nonNegativeShare5: boolean;
    offBottom: boolean;
    daysSinceLow: boolean;
    aboveSma5: boolean;
  };
}

export interface PostRiskOffReentryResult {
  eligible: boolean;
  diagnostics: PostRiskOffReentryDiagnostics;
}

export interface PostRiskOffReentryBudgetResult {
  requestedBudgetUSD: number;
  budgetUSD: number;
  flags: Array<{ code: string; severity: 'info' | 'warn'; message: string; observed?: Record<string, unknown> }>;
}

export const evaluatePostRiskOffStabilization = ({
  bars,
  episodeStartISO,
  config
}: {
  bars: PriceBar[];
  episodeStartISO?: string;
  config: BotConfig;
}): PostRiskOffReentryResult => {
  const cfg = config.dislocation?.earlyReentry || {};
  const minRet3 = cfg.minRet3 ?? 0.006;
  const minRet5 = cfg.minRet5 ?? 0.01;
  const minNonNegativeShare5 = cfg.minNonNegativeShare5 ?? 0.8;
  const offBottomPct = cfg.offBottomPct ?? 0.012;
  const minDaysSinceLow = cfg.minDaysSinceLow ?? 3;
  const volCoolingPctOfPeak = cfg.volCoolingPctOfPeak ?? 0.75;
  const episodeStartDate = episodeStartISO ? toIsoDate(episodeStartISO) : undefined;
  const episodeBars = episodeStartDate ? bars.filter((b) => toIsoDate(b.date) >= episodeStartDate) : [];
  const closes = episodeBars.map((b) => b.close).filter((v) => Number.isFinite(v));
  const dailyReturns = closes.slice(1).map((close, idx) => close / closes[idx] - 1);
  const last3 = dailyReturns.slice(-3);
  const last5 = dailyReturns.slice(-5);
  const currentPrice = closes.length ? closes[closes.length - 1] : null;
  const episodeLowPrice = closes.length ? Math.min(...closes) : null;
  const episodeLowIndex = episodeLowPrice === null ? -1 : closes.lastIndexOf(episodeLowPrice);
  const episodeLowDateISO =
    episodeLowIndex >= 0 ? toIsoDate(episodeBars[episodeLowIndex].date) : undefined;
  const daysSinceLow = episodeLowIndex >= 0 ? closes.length - 1 - episodeLowIndex : 0;
  const ret3 = last3.length === 3 ? cumulativeReturn(last3) : null;
  const ret5 = last5.length === 5 ? cumulativeReturn(last5) : null;
  const nonNegativeShare5 =
    last5.length === 5 ? last5.filter((r) => r >= 0).length / last5.length : 0;
  const recentVol3 = last3.length === 3 ? sampleStdDev(last3) : null;
  const rollingVol3: number[] = [];
  for (let i = 3; i <= dailyReturns.length; i++) rollingVol3.push(sampleStdDev(dailyReturns.slice(i - 3, i)));
  const episodeVolPeak3 = rollingVol3.length ? Math.max(...rollingVol3) : null;
  const close5 = closes.slice(-5);
  const close6 = closes.slice(-6);
  const sma5 = close5.length === 5 ? close5.reduce((acc, v) => acc + v, 0) / 5 : null;
  const priorSma5 = close6.length === 6 ? close6.slice(0, 5).reduce((acc, v) => acc + v, 0) / 5 : null;

  const gates = {
    volCooling:
      recentVol3 !== null &&
      episodeVolPeak3 !== null &&
      recentVol3 <= episodeVolPeak3 * volCoolingPctOfPeak,
    ret3: ret3 !== null && ret3 >= minRet3,
    ret5: ret5 !== null && ret5 >= minRet5,
    nonNegativeShare5: nonNegativeShare5 >= minNonNegativeShare5,
    offBottom:
      currentPrice !== null &&
      episodeLowPrice !== null &&
      currentPrice >= episodeLowPrice * (1 + offBottomPct),
    daysSinceLow: daysSinceLow >= minDaysSinceLow,
    aboveSma5:
      currentPrice !== null &&
      sma5 !== null &&
      priorSma5 !== null &&
      currentPrice >= sma5 &&
      sma5 >= priorSma5
  };

  return {
    eligible: Object.values(gates).every(Boolean),
    diagnostics: {
      currentPrice,
      episodeLowPrice,
      episodeLowDateISO,
      daysSinceLow,
      ret3,
      ret5,
      nonNegativeShare5,
      recentVol3,
      episodeVolPeak3,
      sma5,
      priorSma5,
      gates
    }
  };
};

export const computePostRiskOffReentryBudget = ({
  corePoolUsd,
  reservePoolUsd,
  reserveOnlyCashUsd,
  config
}: {
  corePoolUsd: number;
  reservePoolUsd: number;
  reserveOnlyCashUsd: number;
  config: BotConfig;
}): PostRiskOffReentryBudgetResult => {
  const cfg = config.dislocation?.earlyReentry || {};
  const requestedBudgetUSD = Math.max(0, corePoolUsd * (cfg.reserveDeployPctOfCore ?? 0.15));
  const budgetUSD = clamp(
    Math.min(requestedBudgetUSD, reservePoolUsd, reserveOnlyCashUsd),
    0,
    Number.POSITIVE_INFINITY
  );
  const flags: PostRiskOffReentryBudgetResult['flags'] = [
    {
      code: 'POST_RISK_OFF_REENTRY_BUDGET',
      severity: 'info',
      message: 'Post-risk-off re-entry budget computed',
      observed: { requestedBudgetUSD, budgetUSD, reservePoolUsd, reserveOnlyCashUsd }
    }
  ];
  if (budgetUSD <= 0) {
    flags.push({
      code: 'POST_RISK_OFF_REENTRY_NO_RESERVE_CAPACITY',
      severity: 'warn',
      message: 'No reserve capacity available for post-risk-off re-entry',
      observed: { requestedBudgetUSD, reservePoolUsd, reserveOnlyCashUsd }
    });
  }
  return { requestedBudgetUSD, budgetUSD, flags };
};
