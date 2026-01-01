# Consolidated Reporting Pipeline

Generate a single report per run that combines round context, capital constraints, execution, options, risk checks, and a retrospective.

## Usage
Run the full pipeline:

```
npx ts-node scripts/generateConsolidatedReport.ts --runId runs/<runId>
```

or step by step:

```
npx ts-node scripts/buildRetrospectiveInputs.ts --runId runs/<runId>
npx ts-node scripts/generateReportNarrative.ts --runId runs/<runId> [--dry-run]
npx ts-node scripts/renderReport.ts --runId runs/<runId>
```

Outputs:
- `runs/<runId>/retrospective_inputs.json`: deterministic facts extracted from run artifacts.
- `runs/<runId>/report_narrative.json`: schema-locked narrative JSON (LLM or stub).
- `runs/<runId>/report.md`: human-readable consolidated report (numbers pulled from facts).

## Notes
- No trading logic is changed; this is reporting only.
- In harness runs, stub data is allowed. In paper/live, healthchecks remain strict.
- If artifacts are missing, inputs will include nulls and explanations; narrative should call that out.
- Key constraints explained: 70/30 wall, deploy% confidence scaling, whole-share rounding.

