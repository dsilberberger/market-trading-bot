import fs from 'fs';
import path from 'path';
import { parseAsOfDateTime } from '../src/core/time';
import { loadConfig, loadUniverse } from '../src/core/utils';
import { getMarketDataProvider } from '../src/data/marketData';
import { getBroker } from '../src/broker/broker';
import { generateBaseArtifacts } from '../src/cli/contextBuilder';

describe('bot:dump context packet', () => {
  it('creates llm_context with features and meta', async () => {
    const { asOf, runId } = parseAsOfDateTime('2026-01-15T10:00');
    const config = loadConfig(path.resolve(process.cwd(), 'src/config/default.json'));
    const universe = loadUniverse(path.resolve(process.cwd(), config.universeFile));
    const md = getMarketDataProvider('paper');
    const broker = getBroker(config, md, 'paper');
    const result = await generateBaseArtifacts(asOf, runId, config, universe, md, {}, broker);
    const ctxPath = path.resolve(process.cwd(), 'runs', runId, 'llm_context.json');
    const metaPath = path.resolve(process.cwd(), 'runs', runId, 'context_meta.json');
    expect(fs.existsSync(ctxPath)).toBe(true);
    expect(fs.existsSync(metaPath)).toBe(true);
    const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
    expect(Array.isArray(ctx.features)).toBe(true);
    expect(ctx.features.length).toBeGreaterThan(0);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.maxBytes).toBeGreaterThan(0);
    expect(result.inputs.history).toBeDefined();
  });
});
