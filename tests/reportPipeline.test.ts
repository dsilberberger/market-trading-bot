import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const runDir = path.resolve(process.cwd(), 'runs/2025-12-31T23-48');

describe('consolidated report pipeline', () => {
  it('builds retrospective inputs with core facts', () => {
    execSync(`ts-node scripts/buildRetrospectiveInputs.ts --runId=${runDir}`, { stdio: 'inherit' });
    const facts = JSON.parse(fs.readFileSync(path.join(runDir, 'retrospective_inputs.json'), 'utf-8'));
    expect(facts.capital.corePoolUsd).toBeTruthy();
    expect(facts.capital.deployPct).toBeTruthy();
    expect(facts.execution.plannedNotionalUSD).toBeGreaterThan(0);
  });

  it('renders markdown containing key phrases', () => {
    execSync(`ts-node scripts/generateReportNarrative.ts --runId=${runDir} --dry-run`, { stdio: 'inherit' });
    // Write a stub narrative for rendering
    const stubNarrative = {
      metadata: { runId: path.basename(runDir), generatedAtISO: new Date().toISOString(), mode: 'paper' },
      overview: 'Stub narrative for test.',
      rounds: [],
      market_assessment: 'regime summary',
      capital_constraints: '70/30 wall; confidence scaling; whole-share rounding.',
      etf_selection: 'regime reasoning',
      execution_summary: 'orders summary',
      options_summary: 'options summary',
      risk_and_invariants: 'risk',
      retrospective: 'retrospective text',
      glossary: 'definitions'
    };
    fs.writeFileSync(path.join(runDir, 'report_narrative.json'), JSON.stringify(stubNarrative, null, 2));
    execSync(`ts-node scripts/renderReport.ts --runId=${runDir}`, { stdio: 'inherit' });
    const md = fs.readFileSync(path.join(runDir, 'report.md'), 'utf-8');
    expect(md).toMatch(/70\/30 wall/);
    expect(md).toMatch(/confidence scaling/i);
    expect(md).toMatch(/whole-share rounding/i);
    expect(md).toMatch(/regime/i);
  });
});

