export interface ScenarioEvent {
  weekIndex: number;
  cashInfusionUSD?: number;
  returns?: Record<string, number>; // weekly return multiplier - 1 (e.g., 0.05 = +5%)
  priceShock?: Record<string, number>; // absolute price override
  forceInsurance?: boolean;
  forceDislocationTier?: number;
  forceTierEngaged?: boolean;
}

export interface ScenarioPreset {
  baseReturns: Record<string, number>; // per-week % for default synthetic path
  events: ScenarioEvent[];
  name?: string;
}

export const presetDislocationRecovery: ScenarioPreset = {
  baseReturns: { SPY: -0.07, QQQ: -0.08, TLT: 0.01, SPYM: -0.07, QQQM: -0.08, IWM: -0.085, EFA: -0.065, EEM: -0.07, SHY: 0.002, GLD: 0.008 },
  events: [
    { weekIndex: 0 }, // baseline week
    { weekIndex: 1 }, // mild drop
    { weekIndex: 2 }, // deeper drop
    { weekIndex: 3, returns: { SPY: -0.1, QQQ: -0.1 }, forceInsurance: true }, // capitulation + rising edge trigger
    { weekIndex: 4, cashInfusionUSD: 1000, returns: { SPY: 0.05, QQQ: 0.05 } }, // recovery + cash
    { weekIndex: 5, returns: { SPY: 0.03, QQQ: 0.04 } },
    { weekIndex: 6, returns: { SPY: 0.02, QQQ: 0.03 } },
    { weekIndex: 7, returns: { SPY: 0.02, QQQ: 0.025 } },
    { weekIndex: 8, returns: { SPY: 0.015, QQQ: 0.02 } },
    { weekIndex: 9, returns: { SPY: 0.01, QQQ: 0.015 } },
    { weekIndex: 10, returns: { SPY: 0.01, QQQ: 0.012 } },
    { weekIndex: 11, returns: { SPY: 0.008, QQQ: 0.01 } },
    { weekIndex: 12, returns: { SPY: 0.008, QQQ: 0.01 } },
    // recovery tail to trigger growth
    { weekIndex: 13, returns: { SPY: 0.02, QQQ: 0.025 } },
    { weekIndex: 14, returns: { SPY: 0.025, QQQ: 0.03 } },
    { weekIndex: 15, returns: { SPY: 0.02, QQQ: 0.022 } },
    { weekIndex: 16, returns: { SPY: 0.018, QQQ: 0.02 } },
    { weekIndex: 17, returns: { SPY: 0.02, QQQ: 0.024 } },
    { weekIndex: 18, returns: { SPY: 0.02, QQQ: 0.024 } },
    { weekIndex: 19, returns: { SPY: 0.02, QQQ: 0.024 } },
    { weekIndex: 20, returns: { SPY: 0.02, QQQ: 0.024 } }
  ]
};

export const presetRebalanceChurn: ScenarioPreset = {
  baseReturns: { SPY: 0.0, QQQ: 0.0, TLT: 0.0, SPYM: 0.0, QQQM: 0.0, IWM: 0.0, EFA: 0.0, EEM: 0.0, SHY: 0.0, GLD: 0.0 },
  events: [
    { weekIndex: 0 },
    { weekIndex: 1, cashInfusionUSD: 300 },
    { weekIndex: 2, returns: { SPY: 0.1, QQQ: -0.05 } }, // relative shock -> drift
    { weekIndex: 3, returns: { SPY: -0.08, QQQ: 0.06 } } // reverse drift
  ]
};

export const presetStressThenRecovery: ScenarioPreset = {
  baseReturns: { SPY: -0.1, QQQ: -0.12, TLT: 0.01, SPYM: -0.1, QQQM: -0.12, IWM: -0.11, EFA: -0.095, EEM: -0.1, SHY: 0.002, GLD: 0.01 },
  events: [
    { weekIndex: 0 }, // baseline
    { weekIndex: 1, returns: { SPY: -0.2, QQQ: -0.2, SPYM: -0.2, QQQM: -0.2 } }, // severe stress tier>=2
    { weekIndex: 2, returns: { SPY: -0.05, QQQ: -0.05 } },
    { weekIndex: 3, returns: { SPY: 0.08, QQQ: 0.1, SPYM: 0.08, QQQM: 0.1 } }, // recovery
    { weekIndex: 4, returns: { SPY: 0.06, QQQ: 0.07, SPYM: 0.06, QQQM: 0.07 } }, // robust phase for growth
    { weekIndex: 5, returns: { SPY: 0.03, QQQ: 0.04 } }
  ],
  name: 'STRESS_THEN_RECOVERY'
};

export const presetStressNormalizeRobustWithInfusion1000: ScenarioPreset = {
  name: 'STRESS_NORMALIZE_ROBUST_WITH_INFUSION_1000',
  baseReturns: { SPY: 0, QQQ: 0, TLT: 0.0, SPYM: 0, QQQM: 0, IWM: 0, EFA: 0, EEM: 0, SHY: 0, GLD: 0 },
  events: [
    { weekIndex: 0 }, // normal
    { weekIndex: 1 }, // normal
    { weekIndex: 2, returns: { SPY: -0.12, QQQ: -0.14, SPYM: -0.12, QQQM: -0.14 } }, // tierEngaged rising edge
    { weekIndex: 3, returns: { SPY: -0.15, QQQ: -0.16, SPYM: -0.15, QQQM: -0.16 } }, // tier>=2
    { weekIndex: 4, returns: { SPY: -0.05, QQQ: -0.05 } }, // still stressed
    { weekIndex: 5, returns: { SPY: 0.08, QQQ: 0.08 } }, // normalization
    { weekIndex: 6, returns: { SPY: 0.05, QQQ: 0.05 } }, // normalization
    { weekIndex: 7, returns: { SPY: 0.02, QQQ: 0.03 }, cashInfusionUSD: 1000 }, // first robust week with infusion
    { weekIndex: 8, returns: { SPY: 0.03, QQQ: 0.04 } }, // robust
    { weekIndex: 9, returns: { SPY: 0.02, QQQ: 0.03 } }, // robust
    { weekIndex: 10, returns: { SPY: 0.01, QQQ: 0.02 } }
  ]
};
