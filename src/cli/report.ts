import { Command } from 'commander';
import path from 'path';
import { loadConfig, ensureDir } from '../core/utils';
import { getMarketDataProvider } from '../data/marketData';
import { buildEquityCurve } from '../analytics/performance';
import { computeSummaryMetrics } from '../analytics/metrics';
import fs from 'fs';

const program = new Command();

program
  .option('--from <date>', 'from date inclusive')
  .option('--to <date>', 'to date inclusive');

const runReport = async () => {
  const opts = program.parse(process.argv).opts();
  const from = opts.from as string | undefined;
  const to = opts.to as string | undefined;
  const configPath = path.resolve(process.cwd(), 'src/config/default.json');
  const config = loadConfig(configPath);
  const marketData = getMarketDataProvider();

  const curve = await buildEquityCurve(config, marketData);
  const filtered = curve.filter((p) => {
    const afterFrom = from ? p.date >= from : true;
    const beforeTo = to ? p.date <= to : true;
    return afterFrom && beforeTo;
  });

  ensureDir(path.resolve(process.cwd(), 'reports'));
  const csvLines = ['date,equity,drawdown,exposure,benchmarkSPY,deterministicEquity,randomEquity'];
  for (const p of filtered) {
    csvLines.push(
      [
        p.date,
        p.equity.toFixed(2),
        p.drawdown.toFixed(4),
        p.exposure.toFixed(4),
        p.benchmarkSPY.toFixed(2),
        (p.deterministicEquity ?? p.equity).toFixed(2),
        (p.randomEquity ?? p.equity).toFixed(2)
      ].join(',')
    );
  }
  const csvPath = path.resolve(process.cwd(), 'reports/performance.csv');
  const summaryPath = path.resolve(process.cwd(), 'reports/summary.json');
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  const metrics = computeSummaryMetrics(filtered, config.startingCapitalUSD);
  fs.writeFileSync(summaryPath, JSON.stringify(metrics, null, 2));

  console.log(`Reports written to ${csvPath} and ${summaryPath}`);
};

runReport().catch((err) => {
  console.error('Report generation failed', err);
  process.exitCode = 1;
});
