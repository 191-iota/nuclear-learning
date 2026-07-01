<p align="center">
  <img src="docs/banner.png" alt="nuclear·learning, write on paper and get the correction the moment you settle on an answer" width="100%">
</p>

# nuclear-learning

![Vue 3](https://img.shields.io/badge/Vue-3-1a1915?style=flat-square) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-1a1915?style=flat-square) ![GPT-5.4 vision](https://img.shields.io/badge/GPT--5.4-vision-c39a27?style=flat-square) ![Web Bluetooth](https://img.shields.io/badge/Web%20Bluetooth-Chrome%20%2F%20Edge-1a1915?style=flat-square)

> You antisocial folks will particularly like this one

Real-time feedback on handwritten work. You write on paper with a Neo Smartpen, the strokes stream into the browser over Bluetooth, and the model checks your work as you go. When you settle on a result it speaks a one-line correction if something is off, and when a problem is finished and right it says so out loud. It names the first error and never gives the answer, so you fix it yourself and carry on, and it stays quiet while a line is still mid-working. It is most tuned for mathematics right now; the other subjects work but are lighter.

<p align="center">
  <img src="docs/app.png" alt="the app: a problem on the pad with the app's hint in the status bar" width="880">
</p>

## How it works

The pen streams (x, y, pressure) points over Web Bluetooth onto a canvas. When you pause, the page is cropped to just the ink and sent to the OpenAI API as a vision message. There is no OCR step; the model reads the ink directly.

The moment the whole question is written, GPT-5.4 solves it once at medium effort and keeps that answer as a checklist. From then on GPT-5.4 mini verifies every scan against the checklist, staying quiet while a line is mid-working and speaking the first wrong step once you settle on a result. GPT-5.4 signs off a finished, correct answer before it says so. So the strong model runs twice per problem, once to solve and once to confirm, and the cheap one carries the repetitive middle. It reads the mathematics aloud as words rather than symbols, so a hint comes through as "x squared" or "the square root of two", in English or Swiss German.

## What it remembers

Every mistake you fix is kept as a review card, built from your own error and the worked solution already in hand, so you re-test the actual fix on a spacing schedule rather than a generic question bank. And every solved problem tags the skills behind it against a fixed map of maths, from sign handling up through the chain rule and proof by induction. Underneath, each skill carries a rating that climbs on a clean solve, fades toward a guess as it goes stale, and stays provisional until enough problems have run through it. None of it costs an extra request, and it can be turned off.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/skill-dark.svg">
    <img src="docs/skill.svg" alt="a per-skill rating that climbs on clean solves, fades toward a coin-flip as it goes stale, and dips on a slip; on the right, coverage by domain that only fills once most skills are shown" width="820">
  </picture>
</p>

## Modes

A mode is a system prompt plus a few settings, edited live in the Presets tab or in `config/modes.json`. Maths ships with the full solve-then-verify loop above and the skill map; chemistry, German, and freeform note-reading ship as lighter graders. To add one, append an object, no code changes either way:

```json
{
  "id": "physics",
  "label": "Physics",
  "feedbackStyle": "both",
  "debounceMs": 1200,
  "cacheSolution": true,
  "systemPrompt": "You are checking handwritten physics working. Reply OK while it is correct but unfinished, CORRECT when finished and right, otherwise name the first error in one short sentence."
}
```

`feedbackStyle` is `"spoken"`, `"chime"`, or `"both"`; `debounceMs` is the pause before a check; `cacheSolution` turns on the solve-once-then-verify loop (leave it off for a plain one-shot grader). The engine settings, models, effort, and prices live in `config/settings.json` and the same panel.

## Run it

You need Node and a Chromium-based browser. Web Bluetooth is not in Safari or Firefox, and Brave has it off by default (enable it at `brave://flags/#brave-web-bluetooth-api`).

```bash
npm install
cp .env.example .env   # then add your OpenAI API key
npm run dev
```

Open the printed URL, connect the pen, pick a mode, and write. Pairing only works over `localhost` or `https`, and on macOS the browser needs Bluetooth permission. Once paired, the pen reconnects on its own. The key is read from `VITE_OPENAI_API_KEY` and used from the browser, so keep it local and use one you can rotate.

## Hardware

| Item | Price |
|---|---|
| Neo Smartpen (M1 / M1+ or compatible) | CHF 74 to 129 |
| D1 refills (3-pack) | CHF 5 |
| Ncode paper (print your own or buy a notebook) | CHF 0 to 16 |
| Any BLE earbud (optional, for spoken feedback in your ear) | CHF 15 to 20 |

## License

MIT
