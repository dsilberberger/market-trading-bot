import fs from 'fs';
import path from 'path';
import { getLLMClient, OpenAIClient } from '../src/strategy/openaiClient';

const schemaPath = path.resolve(process.cwd(), 'schemas', 'report_narrative.schema.json');

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

const cleanJsonString = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match && match[1]) return match[1].trim();
  }
  return trimmed;
};

const buildPrompt = (facts: any, schema: any) => {
  return [
    'You are a reporting assistant for a trading bot.',
    'You must produce JSON that VALIDATES against the provided schema.',
    'Do NOT invent numbers. Refer only to fields present in retrospective_inputs.',
    'If a field is null/missing, say so explicitly in plain language.',
    'Tone: calm, concise, layman-friendly. Explain why things happened.',
    '',
    'Schema:',
    JSON.stringify(schema),
    '',
    'Facts (retrospective_inputs):',
    JSON.stringify(facts),
    '',
    'Now produce the narrative JSON.'
  ].join('\n');
};

const main = async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const runArg = args.find((a) => a.startsWith('--run'));
  const runId = runArg ? runArg.split('=')[1] : args[0];
  if (!runId) throw new Error('runId or --runId is required');
  const runDir = path.isAbsolute(runId)
    ? runId
    : path.resolve(process.cwd(), runId.startsWith('runs') ? runId : path.join('runs', runId));
  const factsPath = path.join(runDir, 'retrospective_inputs.json');
  const facts = readJson(factsPath);
  const schema = readJson(schemaPath);
  const prompt = buildPrompt(facts, schema);

  if (dryRun) {
    console.log(`Prompt length: ${prompt.length} chars`);
    return;
  }

  const client = getLLMClient() as OpenAIClient | null;
  let content: string;
  if (!client) {
    // Fallback stub narrative to avoid failures when LLM is unavailable
    content = JSON.stringify({
      metadata: {
        runId: facts.metadata?.runId || path.basename(runDir),
        generatedAtISO: new Date().toISOString(),
        mode: 'unknown'
      },
      overview: 'Consolidated report generated with stub narrative. No live LLM available.',
      rounds: [],
      market_assessment: 'Not available (no LLM).',
      capital_constraints: 'Refer to capital section in facts.',
      etf_selection: 'Refer to execution and ranking in facts.',
      execution_summary: 'Refer to execution section in facts.',
      options_summary: 'Refer to options in facts.',
      risk_and_invariants: 'Refer to risk section in facts.',
      retrospective: 'No retrospective narrative generated (stub).',
      glossary: 'N/A'
    });
  } else {
    const resp = await client.complete(prompt);
    content = cleanJsonString(resp);
  }

  const outPath = path.join(runDir, 'report_narrative.json');
  fs.writeFileSync(outPath, content);
  console.log(`report_narrative.json written to ${outPath}`);
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
