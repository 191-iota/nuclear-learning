<p align="center">
  <img src="docs/banner.png" alt="nuclear·math" width="100%">
</p>

<h3 align="center">A math tutor for the paper notebook: handwriting graded on request, hints that name the rule behind the mistake.</h3>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="#run-it">Run it</a> •
  <a href="#hardware">Hardware</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1a1915?style=flat-square" alt="MIT license"></a>
  <a href="https://vuejs.org"><img src="https://img.shields.io/badge/Vue-3-1a1915?style=flat-square" alt="Vue 3"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-strict-1a1915?style=flat-square" alt="TypeScript strict"></a>
  <img src="https://img.shields.io/badge/GPT--5.6-vision-c39a27?style=flat-square" alt="GPT-5.6 vision">
  <img src="https://img.shields.io/badge/Web%20Bluetooth-Chrome%20%2F%20Edge-1a1915?style=flat-square" alt="Web Bluetooth">
</p>

You write with a Neo Smartpen and the strokes stream into the browser over Web Bluetooth. A vision model reads the handwriting directly from the page image, so nothing gets typed and nothing gets photographed. Four buttons drive the loop: problem written, check, hint, finish. Every reply comes back spoken, in Swiss German.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/pad-dark.png">
    <img src="docs/pad-light.png" alt="the pad with a handwritten quadratic, and the side panel showing the diagnosis of a sign slip, the statement as read, and the session summary" width="880">
  </picture>
  <br><sub>A check mid-problem. The diagnosis names the violated rule; applying it stays your job.</sub>
</p>

## Features

### The hint names the rule

Hints climb a ladder, one rung per failed fix, the way a human tutor escalates. The first rung is a diagnosis: what the written step actually did, and the rule that kind of step must keep, stated so it holds with any numbers. If your fix fails, the next rung states the corrected step, that one line with its value and only that line; the steps after it stay yours. The last rung repeats the corrected step and points at the printed solutions. A question mark written next to a flagged spot advances the ladder without waiting for a failed attempt.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/ladder-dark.svg">
    <img src="docs/ladder.svg" alt="the three rungs of the hint ladder: first the diagnosis naming the wrong move and the violated rule, then the corrected step, last the printed solutions for the full working" width="820">
  </picture>
</p>

The same ladder serves when nothing is wrong and you are stuck: first the technique that applies next and where it attaches, then that technique bound to your numbers, then the next line itself. Pressing hint again without writing anything goes one level deeper; write something and the judgement starts fresh.

The first rung carries no values from your page for a reason. In a randomized trial with about a thousand math students, an answer-revealing chatbot made exam scores worse than no help at all, while the same model behind a no-reveal guardrail helped.

### Nothing runs on its own

Each button press evaluates the page exactly once, so a half-written line is never judged behind your back. A check always answers out loud: correct-so-far is spoken, a still-standing error is repeated word for word, and only a wrong answer chimes. Ask twice, hear it twice.

### Paper conventions still count

A line struck through, or marked "falsch" with an arrow to the redo, is settled business and stays unflagged. Rewriting a solution from scratch supersedes the flagged attempt, so the newest version is what gets judged, and an intermediate result is left alone while you are still simplifying it. Done is declared with the finish button: the page only comes back correct when every question the statement asks has its answer, so a multi-part problem cannot pass with part b) still open.

### Review cards from your own mistakes

Every mistake you fix becomes a review card, built from your error and the worked solution already in hand, so what comes back on the spacing schedule is the actual fix. Corrected errors are the most memorable kind of correction, and they fade after about a week; the expanding schedule is what makes the fix permanent.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/lessons-dark.png">
    <img src="docs/lessons-light.png" alt="the Lessons tab: due, learning, and mastered counts, and a list of review cards each built from one corrected mistake" width="880">
  </picture>
</p>

### A rating built like chess

Every solved problem tags the skills behind it against a fixed map of 125 skills, from sign handling up through the chain rule and proof by induction. Each skill carries a rating that climbs on a clean solve, fades toward a guess as it goes stale, and stays provisional until enough problems have run through it. The Progress tab turns that into a recommendation (the weakest skill worth drilling, the strongest one going stale) and generates a practice problem for it on demand, pitched so you get it right about four times in five.

The same data drives one number, chess-style: every problem is a rated game and its difficulty is the opponent's strength. 1600 means solid at the BM median, and each step of 400 is one stage of a ladder that runs from secondary school into degree mathematics. Grinding easy material cannot farm it: a win the rating already expected teaches it nothing, so climbing means beating problems at your level or above.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/progress-dark.png">
    <img src="docs/progress-light.png" alt="the Progress tab: rank and rating with the rating curve, the gate to the next rank, and the weak spots list with a drill button per skill" width="880">
  </picture>
</p>

### Cost you can see

The strong model carries solve, hints, and the finish; the cheap one carries the repeated middle checks. The Usage tab prices every request from per-model rates pinned in `src/models.ts` and shows where the money went, per purpose and per problem.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/usage-dark.png">
    <img src="docs/usage-light.png" alt="the Usage tab: estimated cost, token totals, spend by purpose and by model, and a per-problem cost chart" width="880">
  </picture>
</p>

## How it works

The pen streams (x, y, pressure) points onto a canvas. On every button press the page is cropped to just the ink and sent to the OpenAI API as a vision message; the model reads the handwriting itself.

| Button | What happens | Model |
|---|---|---|
| Problem written | Reads the statement and solves it once, every sub-question of it; the answers become an internal checklist | GPT-5.6 Terra |
| Check | Grades the settled work against the checklist | GPT-5.4 mini |
| Hint | Names what the page needs next | GPT-5.6 Terra |
| Finish | Judges the declared-done page against the full checklist | GPT-5.6 Terra |

Forgetting the first button costs nothing: any of the other three runs the capture pass itself when no checklist exists yet. The capture echoes the statement into the side panel, editable: fix a misread given by hand and it re-solves against your text, which from then on outranks the ink. Sub-questions a check has confirmed stay confirmed; later checks are barred from re-flagging approved work unless you visibly rework it.

Grading follows school convention. A simplification task assumes its expressions are defined, so the tutor accepts the textbook answer without absolute-value bars, while a lost solution of an equation is always flagged. Everything is spoken as words ("x squared", "the square root of two") and the German voice keeps Swiss spelling.

## Presets

The grader is one system prompt plus a few settings, edited live in the Presets tab or in `config/modes.json`. New presets clone the shipped math grader, so a variant starts from the tuned baseline with its conventions, hint ladder, and self-correction protocol. `feedbackStyle` is `"spoken"`, `"chime"`, or `"both"`. The engine settings live in `config/settings.json` and the same panel: models, effort, image quality, and the auto-clear after a finished page.

## Run it

You need Node and a Chromium-based browser.

```bash
npm install
cp .env.example .env   # then add your OpenAI API key
npm run dev
```

Open the printed URL, connect the pen, and write. Connecting is always the button; the app never grabs the pen on its own.

> [!NOTE]
> Web Bluetooth is not in Safari or Firefox, and Brave ships with it off (enable it at `brave://flags/#brave-web-bluetooth-api`). Pairing works over `localhost` or `https`, and on macOS the browser needs Bluetooth permission.

> [!WARNING]
> The key is read from `VITE_OPENAI_API_KEY` and used from the browser. Keep it local and use one you can rotate.

## Hardware

| Item | Price |
|---|---|
| Neo Smartpen (M1 / M1+ or compatible) | CHF 74 to 129 |
| D1 refills (3-pack) | CHF 5 |
| Ncode paper (print your own or buy a notebook) | CHF 0 to 16 |
| Any BLE earbud (optional, for spoken feedback in your ear) | CHF 15 to 20 |

## License

[MIT](LICENSE)
