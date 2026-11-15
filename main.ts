// main.ts — the program the grader runs for this entry (Node 22).
//
// It reads every case from the input directory's cases.json, renders each
// case alone with parse() from parse.js, and writes the HTML strings, in
// the cases' order, as JSON to the output directory's html.json.
//
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output. Nothing here touches the network, the clock, or
// any file outside the input and output directories.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html = cases.map((c) => parse(c.markdown));
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
