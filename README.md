<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.png">
    <img alt="nuclear-learning — write on paper, read and checked the moment you pause" src="docs/hero-light.png" width="880">
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-1a1a1a?style=flat-square" alt="MIT license">&nbsp;
  <img src="https://img.shields.io/badge/Vue-3-1a1a1a?style=flat-square" alt="Vue 3">&nbsp;
  <img src="https://img.shields.io/badge/TypeScript-strict-1a1a1a?style=flat-square" alt="TypeScript strict">&nbsp;
  <img src="https://img.shields.io/badge/Claude-vision-cc785c?style=flat-square" alt="Claude vision">&nbsp;
  <img src="https://img.shields.io/badge/Web%20Bluetooth-Chrome%20%2F%20Edge-1a1a1a?style=flat-square" alt="Web Bluetooth, Chrome or Edge">
</p>

> You antisocial folks will particularly like this one

Real-time feedback for handwritten work. You write on paper with a Neo Smartpen, the strokes stream into the browser over Bluetooth, and a moment after you pause the page goes to Claude, which reads it and tells you, spoken aloud or with a chime, whether it found a mistake. It is a tight write, check, correct loop: you fix the error yourself from a one-line hint instead of being shown the answer.

<p align="center">
  <img src="docs/app.png" alt="the app: a problem on the pad with the app's hint in the status bar" width="880">
</p>

The same work starts on real Ncode paper, written with the Neo pen.

<p align="center">
  <img src="docs/paper.jpg" alt="a problem written on the real Ncode notebook" width="440">
</p>

## How it works

The pen streams (x, y, pressure) points over Web Bluetooth. The app draws them onto a canvas, fitting the page coordinates to the drawing area as it goes. When you pause for a beat (a per-mode debounce), the page is cropped to just the ink and sent to the Claude API as a vision message under the active mode's system prompt. There is no separate OCR step, Claude reads the ink directly.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/pipeline-dark.svg">
    <img src="docs/pipeline.svg" alt="Neo Smartpen to canvas to Claude vision to voice and chime" width="720">
  </picture>
</p>

It stays quiet while you are working correctly. Only an actual mistake, as a one-line spoken hint, or a finished and correct result, as a single chime, interrupts you. The model solves the problem itself and verifies the answer before it judges, so it errs toward silence rather than crying wolf.

When a solution is finished and right you get that single chime. Below, a quadratic that was written with a dropped sign, caught, corrected on the page, and confirmed.

<p align="center">
  <img src="docs/checked.png" alt="a handwritten quadratic solution the app has marked CORRECT" width="660">
</p>

## Modes

A mode is a system prompt plus a few settings. Four ship by default: math, chemistry notation, German, and freeform note-reading. Each one decides how the work is judged and how the result reaches you.

To add one, append an object to `config/modes.json`, or build it in the Presets tab, no code changes either way:

```json
{
  "id": "physics",
  "label": "Physics",
  "feedbackStyle": "both",
  "debounceMs": 1200,
  "errorChecking": true,
  "systemPrompt": "You are checking handwritten physics working. Reply OK while it is correct but unfinished, CORRECT when finished and right, otherwise name the first error in one short sentence."
}
```

`feedbackStyle` is `"spoken"`, `"chime"`, or `"both"`. `debounceMs` is how long to wait after the last stroke before checking. `errorChecking` is `true` for grading modes, and `false` for read-only modes that should never be given error-detector context.

## The interface

The app is three tabs. The pad is where you work: connect the pen, choose a mode, and write. It keeps the controls to a thin strip and gives the rest to the page.

<p align="center">
  <img src="docs/ui-pad.png" alt="the pad tab: a thin toolbar over a blank writing area" width="860">
</p>

Usage logs every scan's token cost and draws it per page, so you can watch a model or setting change move the number live, in a dark theme if you like. What a real run actually costs is below.

Presets is where the modes live. A mode's prompt, debounce, feedback style, and whether it caches a solved answer are all editable in place, with the engine settings, model, effort, image size, and prices, folded into the panel at the top. The defaults still come from `config/modes.json` and `config/settings.json`; this just edits them without a reload.

<p align="center">
  <img src="docs/ui-presets.png" alt="the presets tab: a math preset expanded for editing" width="860">
</p>

## What it costs

A page is scanned many times as you write, so the natural question is what that costs. To find out I played a deliberately clumsy student: a messy page, worked out in pieces and left to re-scan again and again as it came together.

<p align="center">
  <img src="docs/clumsy-run.jpg" alt="the reflection problem worked out by hand on Ncode paper, with a couple of self-corrected slips" width="440">
</p>

Nine scans of that page came to about nine cents.

<p align="center">
  <img src="docs/cost.png" alt="usage for the page: 9 scans, 19.5k input and 796 output tokens, $0.089" width="300">
</p>

That holds because the work is split across models by how hard each part is. The first scan that can read a complete problem is solved once, in full, by the strong model, and the worked answer is kept as a short checklist. Every scan after that is only a comparison against that checklist, is the work so far still on track, so it runs on a cheaper, faster model. The moment that cheap pass thinks the answer is finished, the strong model is brought back for one last look to confirm the result before it chimes; if it disagrees, the cheap model is dropped for the rest of that problem. The expensive model runs only at the two moments that matter, working the problem out and signing off the result, and the cheap one carries the repetitive middle.

Two things keep the scan count down. A scan only fires once enough new ink has arrived, so pausing to think spends nothing, and once a problem is solved it is never solved again. Most of what is left is input, the cropped image and the prompt re-sent on each scan, so a smaller image or fewer scans move the number more than anything on the output side.

There is a second way to route this, off by default. Instead of handing the repetitive middle to a cheaper model, a quick classifier judges each problem as simple or multi-step the first time it can read it, and everything then runs on the strong model: a light touch on a simple problem, more deliberation on a multi-step one. Whether the cheaper-middle split or the by-difficulty one comes out ahead depends on the problems you throw at it, and both live in the Presets panel.

## Staying coherent across a page

A page is checked many times as you write, so the scans stay consistent instead of each being a fresh shot. The same correction is never replayed: a verdict is spoken or chimed only when it differs from the last one, so while you are still fixing "Step 3: check your sign" it stays on screen but stops talking. Each request also carries the verdicts already given as context, so Claude stays consistent with itself, never re-flagging a line it already confirmed and keeping the same first unresolved error until you fix it. Feedback follows you to the problem you are on too, so several problems can share a page (1a, 1b, 2) and it grades the lowest unfinished one rather than staying pinned to an earlier error. Requests run one at a time and in order, so verdicts never arrive out of sequence.

Pressing Clear wipes the pad and resets the page context for a clean start on the next problem. Switching mode resets the context the same way but keeps your drawing.

## Running it

You need Node and a Chromium-based browser. Web Bluetooth is not in Safari or Firefox, and Brave has it off by default (enable it at `brave://flags/#brave-web-bluetooth-api`).

```bash
npm install
cp .env.example .env   # then put your Anthropic API key in .env
npm run dev
```

Open the printed localhost URL, click Connect pen, pick a mode, and start writing. Pairing only works over `localhost` or `https`, and on macOS the browser needs Bluetooth permission (System Settings, Privacy and Security, Bluetooth).

The key is read from `VITE_ANTHROPIC_API_KEY` and used directly from the browser, so it is visible to anyone who can open the page. Keep this local and use a key you can rotate.

## Settings

Everything tunable lives in `config/settings.json`, and can also be changed live in the Presets tab.

| Setting | What it does |
|---|---|
| `api.solveModel` / `verifyModel` / `confirmModel` | the per-role models: a strong model solves and confirms, a cheaper one runs the routine checks |
| `api.maxTokens` | room for the model's reasoning pass plus the one-line verdict |
| `canvas.maxScale` | zoom cap, higher renders your writing bigger and lower renders it smaller |
| `canvas.pressureMultiplier` | how much stroke width responds to pen pressure |
| `audio.voiceLang`, `audio.rate` | spoken-feedback voice and speed |
| `audio.chimeCorrect`, `audio.chimeError` | drop `.mp3` files in `public/` for real chimes, otherwise a tone is synthesised |

## Hardware

| Item | Price |
|---|---|
| Neo Smartpen (M1 / M1+ or compatible) | CHF 74 to 129 |
| D1 refills (3-pack) | CHF 5 |
| Ncode paper (print your own or buy a notebook) | CHF 0 to 16 |
| Any BLE earbud (optional, for spoken feedback in your ear) | CHF 15 to 20 |

## License

MIT
