import fs from 'fs';
import path from 'path';
import {
  round0Summary,
  round1Summary,
  round2Summary,
  round3Summary,
  round4Summary,
  round5Summary
} from './templates';

type Round = 0 | 1 | 2 | 3 | 4 | 5;

const writers: Record<Round, (runId: string) => string> = {
  0: round0Summary,
  1: round1Summary,
  2: round2Summary,
  3: round3Summary,
  4: round4Summary,
  5: round5Summary
};

const narrativeFlagPath = (runId: string) => path.resolve(process.cwd(), 'runs', runId, 'narrative_flags.json');

const appendFlag = (runId: string, flag: any) => {
  const p = narrativeFlagPath(runId);
  let arr: any[] = [];
  if (fs.existsSync(p)) {
    try {
      arr = JSON.parse(fs.readFileSync(p, 'utf-8')) || [];
    } catch {
      arr = [];
    }
  }
  arr.push(flag);
  fs.writeFileSync(p, JSON.stringify(arr, null, 2));
};

export const generateRoundNarrative = (runId: string, round: Round) => {
  const writer = writers[round];
  if (!writer) return;
  try {
    const content = writer(runId);
    const outPath = path.resolve(process.cwd(), 'runs', runId, `round${round}_summary.md`);
    fs.writeFileSync(outPath, content);
  } catch (err) {
    appendFlag(runId, {
      code: 'NARRATIVE_FALLBACK_USED',
      severity: 'warn',
      message: `Failed to generate round ${round} narrative`,
      observed: { error: (err as Error).message }
    });
  }
};
