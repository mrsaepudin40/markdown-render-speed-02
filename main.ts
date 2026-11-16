// Driver for the markdown-render-speed entry: reads every case from
// /input/cases.json, renders each one alone with parse(), and writes
// /output/html.json, the HTML strings in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input
// and /output. When MAKEFUN_REFERENCE_DIR is set as well (a local check
// run), it also compares the output with the reference expected.json,
// reports how many cases are identical to marked, times several full
// passes, and prints the median full-set CPU.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const REFERENCE_DIR = process.env.MAKEFUN_REFERENCE_DIR;

type Case = { id: string; markdown: string };

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as Case[];

function renderAll(): string[] {
  const html: string[] = [];
  for (const c of cases) html.push(parse(c.markdown));
  return html;
}

function cpuMs(fn: () => void): number {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

const html = renderAll();
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
console.log(`wrote ${html.length} cases to ${join(OUTPUT_DIR, 'html.json')}`);

if (REFERENCE_DIR) {
  const expected = JSON.parse(readFileSync(join(REFERENCE_DIR, 'expected.json'), 'utf8')) as { cases: { id: string; html: string }[] };
  let passed = 0;
  const failed: string[] = [];
  for (let i = 0; i < expected.cases.length; i++) {
    if (html[i] === expected.cases[i].html) {
      passed++;
    } else if (failed.length < 10) {
      failed.push(expected.cases[i].id);
    }
  }
  console.log(`identical: ${passed}/${expected.cases.length}` + (failed.length ? ` (first failures: ${failed.join(', ')})` : ''));
  const samples: number[] = [cpuMs(renderAll)];
  for (let r = 0; r < 4; r++) samples.push(cpuMs(renderAll));
  samples.sort((a, b) => a - b);
  console.log(`median full-set CPU: ${samples[2].toFixed(1)} ms (n=${samples.length}; samples: ${samples.map((s) => s.toFixed(1)).join(', ')})`);
  if (passed !== expected.cases.length) process.exit(1);
}
