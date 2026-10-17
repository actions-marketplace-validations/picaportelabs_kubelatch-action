// Entry point of the action (action.yml runs it on node24).
import { ActionError, escapeData, run } from './action.js';

try {
  await run(process.env, process.stdout);
} catch (err) {
  const message = err instanceof ActionError ? err.message : `unexpected failure: ${err?.stack ?? err}`;
  process.stdout.write(`::error title=kubelatch::${escapeData(message)}\n`);
  process.exitCode = 1;
}
