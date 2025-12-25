export const formatISODate = (date: Date): string => date.toISOString().slice(0, 10);

export const parseAsOf = (asOf?: string): string => {
  // Backward-compatible date-only parser
  if (!asOf) return formatISODate(new Date());
  const parsed = new Date(asOf);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid asOf date: ${asOf}`);
  }
  return formatISODate(parsed);
};

export const parseAsOfDateTime = (asOf?: string): { asOf: string; runId: string } => {
  let parsed: Date;
  if (!asOf) {
    parsed = new Date();
  } else if (asOf.includes('T')) {
    parsed = new Date(asOf);
  } else {
    parsed = new Date(`${asOf}T23:59:00Z`);
  }
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid asOf datetime: ${asOf}`);
  }
  // ISO up to minutes, safe for deterministic seeding; runId uses dash in place of colon for path safety.
  const isoMinute = parsed.toISOString().slice(0, 16); // e.g., 2026-01-03T22:22
  const runId = isoMinute.replace(/:/g, '-');
  return { asOf: isoMinute, runId };
};

export const runIdToAsOf = (runId: string): string => {
  // Convert runId with dashed time back to ISO minute string for data/risk calculations.
  if (runId.includes('T') && runId.match(/T\d{2}-\d{2}/)) {
    return runId.replace(/T(\d{2})-(\d{2})/, 'T$1:$2');
  }
  return runId;
};

const tzDate = (date: Date, tz: string): Date => {
  const iso = date.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
  return new Date(`${iso}Z`);
};

const weekdayToIndex = (day: string): number => {
  const map: Record<string, number> = {
    SUNDAY: 0,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6
  };
  return map[day.toUpperCase()] ?? 0;
};

export const isRebalanceDay = (now: Date, rebalanceDay: string, tz = 'America/Los_Angeles'): boolean => {
  const local = tzDate(now, tz);
  return local.getUTCDay() === weekdayToIndex(rebalanceDay);
};

export const getRebalanceKey = (now: Date, rebalanceDay: string, tz = 'America/Los_Angeles'): string => {
  const local = tzDate(now, tz);
  const dayIdx = weekdayToIndex(rebalanceDay);
  // ISO week-year
  const year = local.getUTCFullYear();
  const oneJan = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((local.getTime() - oneJan.getTime()) / 86400000 + oneJan.getUTCDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}-${rebalanceDay.toUpperCase()}`;
};

export const getCurrentRebalanceWindow = (now: Date, rebalanceDay: string, tz = 'America/Los_Angeles') => {
  const local = tzDate(now, tz);
  const dayIdx = weekdayToIndex(rebalanceDay);
  const diffToPrev = (local.getUTCDay() - dayIdx + 7) % 7;
  const start = new Date(local);
  start.setUTCDate(local.getUTCDate() - diffToPrev);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { startISO: start.toISOString(), endISO: end.toISOString(), key: getRebalanceKey(now, rebalanceDay, tz) };
};

export const previousDate = (asOf: string, days: number): string => {
  const d = new Date(asOf);
  d.setDate(d.getDate() - days);
  return formatISODate(d);
};

export const seedFromDate = (asOf: string): number => {
  return Array.from(asOf).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
};
