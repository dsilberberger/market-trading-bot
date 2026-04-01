import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { runHistoricalReplay, HistoricalReplayInput } from '../replay/runHistoricalReplay';

const program = new Command();

program
  .requiredOption('--input <path>', 'Replay input JSON file')
  .option('--config <path>', 'Bot config file path')
  .option('--output-dir <path>', 'Directory for replay outputs')
  .option('--run-prefix <prefix>', 'Prefix for per-step run directories')
  .option('--strategy <strategy>', 'deterministic | random | llm', 'deterministic');

const run = async () => {
  const opts = program.parse(process.argv).opts();
  const inputPath = path.resolve(process.cwd(), opts.input);
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf-8')) as HistoricalReplayInput;
  const result = await runHistoricalReplay({
    input,
    configPath: opts.config,
    outputDir: opts.outputDir ? path.resolve(process.cwd(), opts.outputDir) : undefined,
    runPrefix: opts.runPrefix,
    strategy: opts.strategy
  });

  console.log(`Replay completed: ${result.outputDir}`);
  console.log(`Steps: ${result.summaryStats.stepCount}`);
  console.log(`Start equity: ${result.summaryStats.startEquity.toFixed(2)}`);
  console.log(`End equity: ${result.summaryStats.endEquity.toFixed(2)}`);
  console.log(`Total return: ${(result.summaryStats.totalReturnPct * 100).toFixed(2)}%`);
  console.log(`Validation summary: ${path.join(result.outputDir, 'validation_summary.json')}`);
  console.log(`Portfolio summary CSV: ${path.join(result.outputDir, 'validation_portfolio_summary.csv')}`);
  console.log(`Strategy diagnostics: ${path.join(result.outputDir, 'strategy_diagnostics.json')}`);
  if (result.performanceComparison.length) {
    console.log('Performance comparison:');
    result.performanceComparison.forEach((row) => {
      console.log(
        `  ${row.label}: return ${(row.totalReturnPct * 100).toFixed(2)}%, maxDD ${(row.maxDrawdownPct * 100).toFixed(2)}%, end ${row.endEquity.toFixed(2)}`
      );
    });
  }
};

run().catch((err) => {
  console.error('bot:replay failed', err);
  process.exitCode = 1;
});
