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
  // Stress-onset then recovery; defensive FI/TIPS mildly positive during stress
  baseReturns: { VTI: -0.07, VXUS: -0.065, VTV: -0.06, USMV: -0.05, SHY: 0.003, IEF: 0.01, TIP: 0.007 },
  events: [
    { weekIndex: 0 }, // baseline week
    { weekIndex: 1 }, // mild drop
    { weekIndex: 2 }, // deeper drop
    { weekIndex: 3, returns: { VTI: -0.1, VXUS: -0.1, SHY: 0.003, IEF: 0.012, TIP: 0.01 }, forceInsurance: true }, // capitulation
    { weekIndex: 4, cashInfusionUSD: 1000, returns: { VTI: 0.05, VXUS: 0.04, IEF: -0.005, TIP: -0.003 } }, // recovery + cash; rates back up
    { weekIndex: 5, returns: { VTI: 0.03, VXUS: 0.03, IEF: -0.003, TIP: -0.002 } },
    { weekIndex: 6, returns: { VTI: 0.02, VXUS: 0.025, IEF: -0.002, TIP: -0.001 } },
    { weekIndex: 7, returns: { VTI: 0.02, VXUS: 0.025, IEF: -0.001, TIP: 0 } },
    { weekIndex: 8, returns: { VTI: 0.015, VXUS: 0.02, IEF: 0, TIP: 0 } },
    { weekIndex: 9, returns: { VTI: 0.01, VXUS: 0.015, IEF: 0.001, TIP: 0.001 } },
    { weekIndex: 10, returns: { VTI: 0.01, VXUS: 0.012, IEF: 0.001, TIP: 0.001 } },
    { weekIndex: 11, returns: { VTI: 0.008, VXUS: 0.01, IEF: 0.001, TIP: 0.001 } },
    { weekIndex: 12, returns: { VTI: 0.008, VXUS: 0.01, IEF: 0.001, TIP: 0.001 } },
    // recovery tail to trigger growth
    { weekIndex: 13, returns: { VTI: 0.02, VXUS: 0.022, IEF: -0.002, TIP: -0.001 } },
    { weekIndex: 14, returns: { VTI: 0.025, VXUS: 0.027, IEF: -0.002, TIP: -0.001 } },
    { weekIndex: 15, returns: { VTI: 0.02, VXUS: 0.022, IEF: -0.001, TIP: 0 } },
    { weekIndex: 16, returns: { VTI: 0.018, VXUS: 0.02, IEF: -0.001, TIP: 0 } },
    { weekIndex: 17, returns: { VTI: 0.02, VXUS: 0.022, IEF: 0, TIP: 0 } },
    { weekIndex: 18, returns: { VTI: 0.02, VXUS: 0.022, IEF: 0, TIP: 0 } },
    { weekIndex: 19, returns: { VTI: 0.02, VXUS: 0.022, IEF: 0.001, TIP: 0.001 } },
    { weekIndex: 20, returns: { VTI: 0.02, VXUS: 0.022, IEF: 0.001, TIP: 0.001 } }
  ]
};

export const presetRebalanceChurn: ScenarioPreset = {
  baseReturns: { VTI: 0.0, VXUS: 0.0, VTV: 0.0, USMV: 0.0, SHY: 0.0, IEF: 0.0, TIP: 0.0 },
  events: [
    { weekIndex: 0 },
    { weekIndex: 1, cashInfusionUSD: 300 },
    { weekIndex: 2, returns: { VTI: 0.1, VXUS: -0.05 } }, // relative shock -> drift
    { weekIndex: 3, returns: { VTI: -0.08, VXUS: 0.06 } } // reverse drift
  ]
};

export const presetStressThenRecovery: ScenarioPreset = {
  baseReturns: { VTI: -0.1, VXUS: -0.11, VTV: -0.09, USMV: -0.08, SHY: 0.003, IEF: 0.012, TIP: 0.009 },
  events: [
    { weekIndex: 0 }, // baseline
    { weekIndex: 1, returns: { VTI: -0.2, VXUS: -0.2, SHY: 0.004, IEF: 0.015, TIP: 0.012 } }, // severe stress tier>=2
    { weekIndex: 2, returns: { VTI: -0.05, VXUS: -0.05, SHY: 0.003, IEF: 0.01, TIP: 0.009 } },
    { weekIndex: 3, returns: { VTI: 0.08, VXUS: 0.1, IEF: -0.005, TIP: -0.003 } }, // recovery; rates back up
    { weekIndex: 4, returns: { VTI: 0.06, VXUS: 0.07, IEF: -0.003, TIP: -0.002 } }, // robust phase for growth
    { weekIndex: 5, returns: { VTI: 0.03, VXUS: 0.04, IEF: -0.001, TIP: -0.001 } }
  ],
  name: 'STRESS_THEN_RECOVERY'
};

export const presetStressNormalizeRobustWithInfusion1000: ScenarioPreset = {
  name: 'STRESS_NORMALIZE_ROBUST_WITH_INFUSION_1000',
  baseReturns: { VTI: 0, VXUS: 0, VTV: 0.0, USMV: 0, SHY: 0, IEF: 0, TIP: 0 },
  events: [
    { weekIndex: 0 }, // normal
    { weekIndex: 1 }, // normal
    { weekIndex: 2, returns: { VTI: -0.12, VXUS: -0.14 } }, // tierEngaged rising edge
    { weekIndex: 3, returns: { VTI: -0.15, VXUS: -0.16 } }, // tier>=2
    { weekIndex: 4, returns: { VTI: -0.05, VXUS: -0.05 } }, // still stressed
    { weekIndex: 5, returns: { VTI: 0.08, VXUS: 0.08 } }, // normalization
    { weekIndex: 6, returns: { VTI: 0.05, VXUS: 0.05 } }, // normalization
    { weekIndex: 7, returns: { VTI: 0.02, VXUS: 0.03 }, cashInfusionUSD: 1000 }, // first robust week with infusion
    { weekIndex: 8, returns: { VTI: 0.03, VXUS: 0.04 } }, // robust
    { weekIndex: 9, returns: { VTI: 0.02, VXUS: 0.03 } }, // robust
    { weekIndex: 10, returns: { VTI: 0.01, VXUS: 0.02 } }
  ]
};

// Whipsaw/sideways: small alternating shocks and recoveries.
export const presetWhipsaw: ScenarioPreset = {
  name: 'WHIPSAW_SIDEWAYS',
  baseReturns: { VTI: 0.002, VXUS: 0.002, VTV: 0.0015, USMV: 0.001, SHY: 0.0005, IEF: 0.001, TIP: 0.0008 },
  events: [
    { weekIndex: 4, returns: { VTI: -0.03, VXUS: -0.035, USMV: -0.02 } },
    { weekIndex: 5, returns: { VTI: 0.025, VXUS: 0.03, USMV: 0.02 } },
    { weekIndex: 9, returns: { VTI: -0.04, VXUS: -0.045, USMV: -0.03 } },
    { weekIndex: 10, returns: { VTI: 0.035, VXUS: 0.04, USMV: 0.03 } },
    { weekIndex: 14, returns: { VTI: -0.02, VXUS: -0.025, USMV: -0.015 } },
    { weekIndex: 15, returns: { VTI: 0.018, VXUS: 0.02, USMV: 0.015 } }
  ]
};

// Multi-shock sequence: two drawdowns separated by partial recovery.
export const presetMultiShock: ScenarioPreset = {
  name: 'MULTI_SHOCK',
  baseReturns: { VTI: 0.001, VXUS: 0.001, VTV: 0.001, USMV: 0.001, SHY: 0.0005, IEF: 0.001, TIP: 0.0008 },
  events: [
    { weekIndex: 8, returns: { VTI: -0.07, VXUS: -0.08, USMV: -0.05, IEF: 0.008 } },
    { weekIndex: 9, returns: { VTI: -0.05, VXUS: -0.06, USMV: -0.04, IEF: 0.006 } },
    { weekIndex: 16, returns: { VTI: 0.04, VXUS: 0.045, USMV: 0.035, IEF: -0.002 } }, // partial recovery
    { weekIndex: 24, returns: { VTI: -0.06, VXUS: -0.07, USMV: -0.05, IEF: 0.007 } },
    { weekIndex: 25, returns: { VTI: -0.04, VXUS: -0.05, USMV: -0.035, IEF: 0.005 } }
  ]
};

// Slow grind down: prolonged low-vol decline.
export const presetSlowGrind: ScenarioPreset = {
  name: 'SLOW_GRIND_DOWN',
  baseReturns: { VTI: -0.003, VXUS: -0.0035, VTV: -0.0025, USMV: -0.002, SHY: 0.0005, IEF: 0.0008, TIP: 0.0007 },
  events: [
    { weekIndex: 0 },
    { weekIndex: 12, returns: { VTI: -0.01, VXUS: -0.012, USMV: -0.008 } },
    { weekIndex: 24, returns: { VTI: -0.008, VXUS: -0.01, USMV: -0.006 } },
    { weekIndex: 36, returns: { VTI: -0.007, VXUS: -0.009, USMV: -0.005 } }
  ]
};

// Steady bull: long uptrend with low vol.
export const presetSteadyBull: ScenarioPreset = {
  name: 'STEADY_BULL',
  baseReturns: { VTI: 0.006, VXUS: 0.0065, VTV: 0.005, USMV: 0.0045, SHY: 0.0005, IEF: 0.0003, TIP: 0.0004 },
  events: [
    { weekIndex: 0 },
    { weekIndex: 24, returns: { VTI: 0.01, VXUS: 0.011, USMV: 0.008 } },
    { weekIndex: 48, returns: { VTI: 0.009, VXUS: 0.01, USMV: 0.007 } }
  ]
};
// Approximate 2007–2010 GFC path: long pre-stress drift, sharp 2008 drawdown, recovery through 2010.
export const presetGFC2007to2010: ScenarioPreset = {
  name: 'GFC_2007_2010',
  // Mild positive drift as baseline; events drive the stress/recovery.
  baseReturns: { VTI: 0.001, VXUS: 0.001, VTV: 0.001, USMV: 0.001, SHY: 0.0005, IEF: 0.001, TIP: 0.0008 },
  events: [
    { weekIndex: 0 }, // start 2007
    // Early stress signs mid-2007
    { weekIndex: 30, returns: { VTI: -0.02, VXUS: -0.025, USMV: -0.015 } },
    { weekIndex: 31, returns: { VTI: -0.03, VXUS: -0.035, USMV: -0.02 } },
    // Calm/sideways into early 2008
    { weekIndex: 45, returns: { VTI: 0, VXUS: 0, IEF: 0.002 } },
    // 2008 drawdown (multi-week cascade)
    { weekIndex: 55, returns: { VTI: -0.06, VXUS: -0.07, USMV: -0.05, SHY: 0.002, IEF: 0.01, TIP: 0.008 } },
    { weekIndex: 56, returns: { VTI: -0.08, VXUS: -0.09, USMV: -0.06, SHY: 0.002, IEF: 0.012, TIP: 0.009 } },
    { weekIndex: 57, returns: { VTI: -0.12, VXUS: -0.14, USMV: -0.09, SHY: 0.002, IEF: 0.015, TIP: 0.01 } },
    { weekIndex: 58, returns: { VTI: -0.1, VXUS: -0.11, USMV: -0.08, SHY: 0.002, IEF: 0.012, TIP: 0.009 } },
    { weekIndex: 59, returns: { VTI: -0.08, VXUS: -0.09, USMV: -0.07, SHY: 0.002, IEF: 0.01, TIP: 0.008 } },
    { weekIndex: 60, returns: { VTI: -0.05, VXUS: -0.06, USMV: -0.045, SHY: 0.002, IEF: 0.008, TIP: 0.006 } },
    // Bottoming / volatile sideways late 2008–early 2009
    { weekIndex: 70, returns: { VTI: -0.03, VXUS: -0.035, USMV: -0.025, SHY: 0.002, IEF: 0.006, TIP: 0.005 } },
    { weekIndex: 71, returns: { VTI: 0.0, VXUS: -0.01, USMV: -0.005, SHY: 0.002, IEF: 0.004, TIP: 0.003 } },
    // Recovery 2009
    { weekIndex: 80, returns: { VTI: 0.06, VXUS: 0.065, USMV: 0.05, IEF: -0.002, TIP: -0.001 } },
    { weekIndex: 81, returns: { VTI: 0.05, VXUS: 0.055, USMV: 0.04, IEF: -0.002, TIP: -0.001 } },
    { weekIndex: 82, returns: { VTI: 0.04, VXUS: 0.045, USMV: 0.035, IEF: -0.001, TIP: -0.001 } },
    { weekIndex: 90, returns: { VTI: 0.03, VXUS: 0.032, USMV: 0.025, IEF: 0, TIP: 0 } },
    // 2010 ongoing recovery/normalization
    { weekIndex: 110, returns: { VTI: 0.02, VXUS: 0.022, USMV: 0.018, IEF: 0, TIP: 0 } },
    { weekIndex: 130, returns: { VTI: 0.015, VXUS: 0.017, USMV: 0.013, IEF: 0, TIP: 0 } },
    { weekIndex: 150, returns: { VTI: 0.012, VXUS: 0.014, USMV: 0.01, IEF: 0, TIP: 0 } }
  ]
};

// COVID-era style path: sharp early 2020 crash, strong rebound through 2021, 2022 drawdown.
export const presetCovid2020to2022: ScenarioPreset = {
  name: 'COVID_2020_2022',
  baseReturns: { VTI: 0.003, VXUS: 0.0032, VTV: 0.0025, USMV: 0.002, SHY: 0.0004, IEF: 0.0006, TIP: 0.0006 },
  events: [
    { weekIndex: 0 }, // start 2020
    // Sharp COVID crash Feb–Mar 2020
    { weekIndex: 8, returns: { VTI: -0.1, VXUS: -0.11, USMV: -0.08, SHY: 0.001, IEF: 0.008, TIP: 0.006 } },
    { weekIndex: 9, returns: { VTI: -0.12, VXUS: -0.13, USMV: -0.1, SHY: 0.001, IEF: 0.01, TIP: 0.008 } },
    { weekIndex: 10, returns: { VTI: -0.08, VXUS: -0.09, USMV: -0.07, SHY: 0.001, IEF: 0.008, TIP: 0.006 } },
    { weekIndex: 11, returns: { VTI: -0.06, VXUS: -0.07, USMV: -0.05, SHY: 0.001, IEF: 0.006, TIP: 0.004 } },
    { weekIndex: 12, returns: { VTI: -0.04, VXUS: -0.05, USMV: -0.035, SHY: 0.001, IEF: 0.004, TIP: 0.003 } },
    // Strong rebound mid/late 2020
    { weekIndex: 20, returns: { VTI: 0.08, VXUS: 0.09, USMV: 0.07, IEF: -0.003, TIP: -0.002 } },
    { weekIndex: 21, returns: { VTI: 0.07, VXUS: 0.08, USMV: 0.06, IEF: -0.002, TIP: -0.001 } },
    { weekIndex: 22, returns: { VTI: 0.05, VXUS: 0.055, USMV: 0.045, IEF: -0.001, TIP: -0.001 } },
    { weekIndex: 30, returns: { VTI: 0.04, VXUS: 0.045, USMV: 0.035, IEF: -0.001, TIP: -0.001 } },
    { weekIndex: 40, returns: { VTI: 0.035, VXUS: 0.04, USMV: 0.03, IEF: 0, TIP: 0 } },
    { weekIndex: 50, returns: { VTI: 0.03, VXUS: 0.035, USMV: 0.028, IEF: 0, TIP: 0 } },
    { weekIndex: 60, returns: { VTI: 0.025, VXUS: 0.03, USMV: 0.023, IEF: 0, TIP: 0 } },
    { weekIndex: 70, returns: { VTI: 0.02, VXUS: 0.025, USMV: 0.02, IEF: 0, TIP: 0 } },
    // Mild chop/sideways 2021
    { weekIndex: 80, returns: { VTI: 0.01, VXUS: 0.012, USMV: 0.01, IEF: 0, TIP: 0 } },
    { weekIndex: 90, returns: { VTI: 0.008, VXUS: 0.01, USMV: 0.008, IEF: 0, TIP: 0 } },
    // 2022 drawdown
    { weekIndex: 110, returns: { VTI: -0.04, VXUS: -0.045, USMV: -0.035, SHY: 0.001, IEF: 0.004, TIP: 0.003 } },
    { weekIndex: 115, returns: { VTI: -0.05, VXUS: -0.055, USMV: -0.04, SHY: 0.001, IEF: 0.005, TIP: 0.004 } },
    { weekIndex: 120, returns: { VTI: -0.03, VXUS: -0.035, USMV: -0.025, SHY: 0.001, IEF: 0.004, TIP: 0.003 } },
    { weekIndex: 125, returns: { VTI: -0.025, VXUS: -0.03, USMV: -0.02, SHY: 0.001, IEF: 0.003, TIP: 0.002 } },
    // Late-period mild recovery/normalization
    { weekIndex: 140, returns: { VTI: 0.02, VXUS: 0.022, USMV: 0.018, IEF: 0, TIP: 0 } },
    { weekIndex: 150, returns: { VTI: 0.015, VXUS: 0.017, USMV: 0.014, IEF: 0, TIP: 0 } }
  ]
};
