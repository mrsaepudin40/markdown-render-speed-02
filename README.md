# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/mrsaepudin40/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/mrsaepudin40/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in for marked 18.1.3: `parse(markdown)` returns exactly the HTML marked renders with its defaults, faster. Marked's own Lexer still tokenizes the blocks; the inline renderer is a fresh direct-emit engine that walks each inline run once and appends HTML strings, instead of building inline token objects, a token tree, or a Parser walk. A hand-written plain-text scanner replaces marked's giant inline text pattern, and the emphasis mask and closer scan are built lazily, only when an emphasis or strikethrough opener is actually attempted.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=path/to/cases MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads `cases.json` from the input directory, renders each case alone with `parse()`, and writes `html.json` — the HTML strings in the cases' order — to the output directory. It makes no network requests and keeps nothing between cases.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
