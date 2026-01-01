import path from 'path';
import { spawnSync } from 'child_process';

const runStep = (cmd: string, args: string[]) => {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with code ${res.status}`);
  }
};

const main = () => {
  const args = process.argv.slice(2);
  const runArg = args.find((a) => a.startsWith('--run'));
  const runId = runArg ? runArg.split('=')[1] : args[0];
  if (!runId) throw new Error('runId or --runId is required');
  const runDir = runId.startsWith('runs') ? runId : path.join('runs', runId);

  runStep('ts-node', ['scripts/buildRetrospectiveInputs.ts', `--runId=${runDir}`]);
  runStep('ts-node', ['scripts/generateReportNarrative.ts', `--runId=${runDir}`]);
  runStep('ts-node', ['scripts/renderReport.ts', `--runId=${runDir}`]);
};

if (require.main === module) {
  main();
}

