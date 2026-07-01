/**
 * Turn the spoken verdict's math notation into words a speech engine can actually say.
 *
 * The grader's verdict is mostly ordinary prose ("Step 3: check your sign") with the odd
 * embedded formula: LaTeX between `$...$`, raw Unicode (x², √2, ≤), or plain ASCII (x^2,
 * a_1, 19/5). Fed straight into the browser's speech synthesiser that notation is read
 * literally ("dollar x caret two dollar") or dropped, in either language. This rewrites it
 * to spoken words, in English or Swiss Hochdeutsch, WITHOUT mangling the surrounding prose.
 *
 * Two tiers of rule, which is what keeps prose intact:
 *   - Unambiguous notation (LaTeX commands, Unicode math symbols, and the `^` / `_` scripts,
 *     which have no prose meaning) is spoken everywhere.
 *   - The ASCII operators that DO have a prose meaning (`= - * / :`, digit-letter spacing,
 *     `!`) only speak inside a `$`-span or a run that carries a real math signal. So control
 *     words (OK / CORRECT), hyphenated words (non-zero, z-component), "Step N:", snake_case,
 *     and prose ordinals all pass through untouched.
 *
 * The symbol table, transform order, and the prose-safety guards were designed and
 * adversarially verified as a spec before this was written. `speak()` in useFeedback pairs
 * it with the matching voice (`de-DE` for German), since a German phrase read by an en-US
 * voice is gibberish.
 */
export type SpeechLang = 'en' | 'de';

function pick(lang: SpeechLang, en: string, de: string): string {
  return lang === 'de' ? de : en;
}

// Control tokens (both languages) pass through verbatim; the chime/silence logic keys on them.
const CONTROL = new Set(['OK', 'CORRECT', 'RICHTIG', 'FALSCH', 'STIMMT']);

// LaTeX command -> [en, de]. Keyed without the leading backslash. Longer names are matched
// before their prefixes at apply time (\leq before \le, \subseteq before \subset, ...).
const LATEX: Record<string, [string, string]> = {
  cdot: ['times', 'mal'], times: ['times', 'mal'], div: ['divided by', 'geteilt durch'],
  pm: ['plus or minus', 'plus minus'], mp: ['minus or plus', 'minus plus'], ast: ['star', 'Stern'],
  le: ['less than or equal to', 'kleiner gleich'], leq: ['less than or equal to', 'kleiner gleich'],
  ge: ['greater than or equal to', 'grösser gleich'], geq: ['greater than or equal to', 'grösser gleich'],
  ne: ['not equal to', 'ungleich'], neq: ['not equal to', 'ungleich'],
  approx: ['approximately equal to', 'ungefähr gleich'],
  equiv: ['is equivalent to', 'identisch gleich'], cong: ['is congruent to', 'ist kongruent zu'],
  pmod: ['mod', 'modulo'], bmod: ['mod', 'modulo'],
  propto: ['is proportional to', 'proportional zu'], sim: ['is similar to', 'ähnlich zu'],
  to: ['goes to', 'gegen'], rightarrow: ['goes to', 'gegen'], longrightarrow: ['goes to', 'gegen'],
  Rightarrow: ['implies', 'daraus folgt'], implies: ['implies', 'daraus folgt'],
  Leftarrow: ['is implied by', 'folgt aus'],
  Leftrightarrow: ['if and only if', 'genau dann, wenn'], iff: ['if and only if', 'genau dann, wenn'],
  mapsto: ['maps to', 'wird abgebildet auf'],
  sum: ['the sum of', 'die Summe'], prod: ['the product of', 'das Produkt'],
  int: ['the integral of', 'das Integral'], oint: ['the contour integral of', 'das Umlaufintegral'],
  lim: ['the limit of', 'der Grenzwert'], partial: ['partial', 'partiell'], nabla: ['nabla', 'Nabla'],
  infty: ['infinity', 'unendlich'],
  in: ['is an element of', 'Element von'], notin: ['is not an element of', 'nicht Element von'],
  subset: ['is a subset of', 'echte Teilmenge von'], subseteq: ['is a subset of or equal to', 'Teilmenge von'],
  supset: ['is a superset of', 'echte Obermenge von'], supseteq: ['is a superset of or equal to', 'Obermenge von'],
  cup: ['union', 'vereinigt mit'], cap: ['intersect', 'geschnitten mit'], setminus: ['without', 'ohne'],
  forall: ['for all', 'für alle'], exists: ['there exists', 'es gibt'], nexists: ['there is no', 'es gibt kein'],
  emptyset: ['the empty set', 'die leere Menge'], neg: ['not', 'nicht'],
  land: ['and', 'und'], lor: ['or', 'oder'], oplus: ['exclusive or', 'exklusiv oder'],
  angle: ['angle', 'Winkel'], perp: ['perpendicular to', 'senkrecht zu'], parallel: ['parallel to', 'parallel zu'],
  circ: ['composed with', 'verkettet mit'], ldots: ['and so on', 'und so weiter'], dots: ['and so on', 'und so weiter'],
  cdots: ['and so on', 'und so weiter'],
  sin: ['sine', 'Sinus'], cos: ['cosine', 'Kosinus'], tan: ['tangent', 'Tangens'],
  cot: ['cotangent', 'Kotangens'], sec: ['secant', 'Sekans'], csc: ['cosecant', 'Kosekans'],
  arcsin: ['arcsine', 'Arkussinus'], arccos: ['arccosine', 'Arkuskosinus'], arctan: ['arctangent', 'Arkustangens'],
  sinh: ['hyperbolic sine', 'Sinus hyperbolicus'], cosh: ['hyperbolic cosine', 'Kosinus hyperbolicus'],
  tanh: ['hyperbolic tangent', 'Tangens hyperbolicus'],
  log: ['log', 'Logarithmus'], ln: ['natural log', 'natürlicher Logarithmus'], exp: ['exp', 'exp'],
  min: ['minimum', 'Minimum'], max: ['maximum', 'Maximum'], det: ['determinant', 'Determinante'],
  dim: ['dimension', 'Dimension'], deg: ['degree', 'Grad'], gcd: ['gcd', 'grösster gemeinsamer Teiler'],
  alpha: ['alpha', 'Alpha'], beta: ['beta', 'Beta'], gamma: ['gamma', 'Gamma'], delta: ['delta', 'Delta'],
  epsilon: ['epsilon', 'Epsilon'], varepsilon: ['epsilon', 'Epsilon'], zeta: ['zeta', 'Zeta'], eta: ['eta', 'Eta'],
  theta: ['theta', 'Theta'], vartheta: ['theta', 'Theta'], iota: ['iota', 'Jota'], kappa: ['kappa', 'Kappa'],
  lambda: ['lambda', 'Lambda'], mu: ['mu', 'Mü'], nu: ['nu', 'Nü'], xi: ['xi', 'Xi'], pi: ['pi', 'Pi'],
  rho: ['rho', 'Rho'], sigma: ['sigma', 'Sigma'], tau: ['tau', 'Tau'], upsilon: ['upsilon', 'Ypsilon'],
  phi: ['phi', 'Phi'], varphi: ['phi', 'Phi'], chi: ['chi', 'Chi'], psi: ['psi', 'Psi'], omega: ['omega', 'Omega'],
  Delta: ['delta', 'Delta'], Gamma: ['gamma', 'Gamma'], Theta: ['theta', 'Theta'], Lambda: ['lambda', 'Lambda'],
  Sigma: ['sigma', 'Sigma'], Pi: ['pi', 'Pi'], Phi: ['phi', 'Phi'], Omega: ['omega', 'Omega'],
  Xi: ['xi', 'Xi'], Psi: ['psi', 'Psi'], Upsilon: ['upsilon', 'Ypsilon'],
};

// Unicode math symbol -> [en, de]. Applied globally (unambiguous). Order the apply loop so
// multi-char sequences (°C) win before their parts.
const UNI: Record<string, [string, string]> = {
  '−': ['minus', 'minus'], '·': ['times', 'mal'], '⋅': ['times', 'mal'], '×': ['times', 'mal'],
  '÷': ['divided by', 'geteilt durch'], '±': ['plus or minus', 'plus minus'], '∓': ['minus or plus', 'minus plus'],
  '∗': ['star', 'Stern'], '≤': ['less than or equal to', 'kleiner gleich'],
  '≥': ['greater than or equal to', 'grösser gleich'], '≠': ['not equal to', 'ungleich'],
  '≈': ['approximately equal to', 'ungefähr gleich'], '≡': ['is equivalent to', 'identisch gleich'],
  '∝': ['is proportional to', 'proportional zu'], '≪': ['much less than', 'viel kleiner als'],
  '≫': ['much greater than', 'viel grösser als'], '→': ['goes to', 'gegen'], '⇒': ['implies', 'daraus folgt'],
  '⇔': ['if and only if', 'genau dann, wenn'], '↦': ['maps to', 'wird abgebildet auf'],
  '←': ['from', 'von'], '↔': ['corresponds to', 'entspricht'], '∑': ['the sum of', 'die Summe'],
  '∏': ['the product of', 'das Produkt'], '∫': ['the integral of', 'das Integral'],
  '∮': ['the contour integral of', 'das Umlaufintegral'], '∂': ['partial', 'partiell'], '∇': ['nabla', 'Nabla'],
  '∞': ['infinity', 'unendlich'], '∈': ['is an element of', 'Element von'], '∉': ['is not an element of', 'nicht Element von'],
  '⊂': ['is a subset of', 'echte Teilmenge von'], '⊆': ['is a subset of or equal to', 'Teilmenge von'],
  '⊃': ['is a superset of', 'echte Obermenge von'], '⊇': ['is a superset of or equal to', 'Obermenge von'],
  '∪': ['union', 'vereinigt mit'], '∩': ['intersect', 'geschnitten mit'], '∀': ['for all', 'für alle'],
  '∃': ['there exists', 'es gibt'], '∅': ['the empty set', 'die leere Menge'], '¬': ['not', 'nicht'],
  '∧': ['and', 'und'], '∨': ['or', 'oder'], '⊕': ['exclusive or', 'exklusiv oder'], '∠': ['angle', 'Winkel'],
  '⊥': ['perpendicular to', 'senkrecht zu'], '∥': ['parallel to', 'parallel zu'], '∘': ['composed with', 'verkettet mit'],
  '…': ['and so on', 'und so weiter'], '′': ['prime', 'Strich'], '″': ['double prime', 'zwei Strich'],
  '°': ['degrees', 'Grad'], 'α': ['alpha', 'Alpha'], 'β': ['beta', 'Beta'], 'γ': ['gamma', 'Gamma'],
  'δ': ['delta', 'Delta'], 'ε': ['epsilon', 'Epsilon'], 'θ': ['theta', 'Theta'], 'λ': ['lambda', 'Lambda'],
  'μ': ['mu', 'Mü'], 'π': ['pi', 'Pi'], 'σ': ['sigma', 'Sigma'], 'φ': ['phi', 'Phi'], 'ω': ['omega', 'Omega'],
  'Δ': ['delta', 'Delta'], 'Ω': ['omega', 'Omega'], 'Σ': ['sigma', 'Sigma'],
  '½': ['one half', 'ein Halb'], '⅓': ['one third', 'ein Drittel'], '¼': ['one quarter', 'ein Viertel'],
  '¾': ['three quarters', 'drei Viertel'], '⅔': ['two thirds', 'zwei Drittel'], '⅕': ['one fifth', 'ein Fünftel'],
  '⅛': ['one eighth', 'ein Achtel'],
};

const SUPER: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  'ⁿ': 'n', 'ⁱ': 'i', '⁺': '+', '⁻': '-',
};
const SUB: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  'ₙ': 'n', 'ᵢ': 'i', 'ⱼ': 'j', 'ₖ': 'k', '₊': '+', '₋': '-',
};

// Function words that make a following '(' read "of"/"von" rather than silent grouping.
const FUNC = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sine', 'cosine', 'tangent', 'log', 'ln', 'exp',
  'det', 'dim', 'gcd', 'min', 'max', 'lim', 'f', 'g', 'h', 'p', 'q', 'u', 'v', 'F', 'G', 'P',
  'prime', 'Strich',
]);

// Common element symbols, used to read H₂O as "H 2 O" (bare) rather than "H sub 2 O".
const ELEMENTS = new Set([
  'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl',
  'Ar', 'K', 'Ca', 'Fe', 'Cu', 'Zn', 'Ag', 'Au', 'Hg', 'Pb', 'Sn', 'Br', 'I',
]);

function ordinalEn(n: number): string {
  const s = String(n);
  if (n % 100 >= 11 && n % 100 <= 13) return s + 'th';
  const suf = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return s + suf;
}
const ORD_DE: Record<number, string> = {
  4: 'vierte', 5: 'fünfte', 6: 'sechste', 7: 'siebte', 8: 'achte', 9: 'neunte', 10: 'zehnte',
};

// Read a balanced group starting at s[i] === '{'; return [content, indexAfterClosingBrace].
function readBrace(s: string, i: number): [string, number] {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    if (s[j] === '{') depth += 1;
    else if (s[j] === '}') {
      depth -= 1;
      if (depth === 0) return [s.slice(i + 1, j), j + 1];
    }
  }
  return [s.slice(i + 1), s.length];
}

// Read a structural command's next argument: a braced group, or a single token (one char,
// or a backslash-command) when braceless (\frac12, \bar a).
function readArg(s: string, i: number): [string, number] {
  while (i < s.length && s[i] === ' ') i += 1;
  if (s[i] === '{') return readBrace(s, i);
  if (s[i] === '\\') {
    let j = i + 1;
    while (j < s.length && /[A-Za-z]/.test(s[j])) j += 1;
    return [s.slice(i, j), j];
  }
  return [s[i] ?? '', i + 1];
}

// ---- the math-fragment transform (a $-span, or a promoted bare run) ----
function render(input: string, lang: SpeechLang): string {
  let s = input;

  // 1. drop spacing / sizing / wrappers.
  s = s
    .replace(/\\(left|right|bigl|bigr|Bigl|Bigr|big|Big)\b/g, ' ')
    .replace(/\\(displaystyle|limits|nolimits)\b/g, ' ')
    .replace(/\\(quad|qquad)\b/g, ' ')
    .replace(/\\[,;:!]/g, ' ')
    .replace(/\\ /g, ' ')
    .replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, ' ')
    .replace(/&|\\\\/g, ' ');
  s = s.replace(/\\text\{([^{}]*)\}/g, ' $1 ');
  s = s.replace(/\\(mathrm|mathbf|mathbb|mathcal|mathsf|mathit|boldsymbol|operatorname)\{([^{}]*)\}/g, ' $2 ');

  // 2. big operators with bounds (before generic ^ / _ grab the limits).
  s = expandBigOps(s, lang);

  // 3. structural commands, innermost handled by recursion on each argument.
  s = expandStructural(s, lang);
  s = expandRadicals(s, lang);

  // 4. absolute value | A | (balanced ASCII pipes) and factorial.
  s = expandPipes(s, lang);
  s = s.replace(/([0-9A-Za-z)\]}])\s*!/g, (_m, a) => `${a} ${pick(lang, 'factorial', 'Fakultät')}`);

  // 5. unicode super/subscripts -> ascii ^ / _ notation (charge case handled inline).
  s = normalizeScripts(s, lang);

  // 6. ascii/LaTeX super- and subscripts.
  s = expandScripts(s, lang);

  // 7. LaTeX symbol table, longest name first. A modulo context reads ≡ as congruence.
  if (/\\pmod|\\bmod|\bmod\b|modulo/.test(s)) {
    s = s.replace(/\\equiv\b|≡/g, ` ${pick(lang, 'is congruent to', 'ist kongruent zu')} `);
  }
  s = applyLatex(s, lang);

  // 8. remaining unicode symbols.
  s = applyUnicode(s, lang);

  // 9. ascii operators + digit-letter spacing (this fragment is already known-math).
  s = applyAsciiOps(s, lang);

  // 10. primes and function application.
  s = s.replace(/([A-Za-z)\]])\s*''/g, (_m, a) => `${a} ${pick(lang, 'double prime', 'zwei Strich')}`);
  s = s.replace(/([A-Za-z)\]])\s*'/g, (_m, a) => `${a} ${pick(lang, 'prime', 'Strich')}`);
  s = applyFunctionApplication(s, lang);

  // 11. fallback: any surviving \command -> its bare name as a word.
  s = s.replace(/\\([A-Za-z]+)/g, ' $1 ').replace(/\\(.)/g, ' ');

  // 12. cleanup: drop leftover math punctuation, collapse whitespace.
  s = s.replace(/[{}$^_|\\]/g, ' ').replace(/[()]/g, ' ');
  s = s.replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return s;
}

function expandStructural(s: string, lang: SpeechLang): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\') {
      const m = /^\\([A-Za-z]+)/.exec(s.slice(i));
      if (m) {
        const cmd = m[1];
        let k = i + m[0].length;
        if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac' || cmd === 'cfrac') {
          const [a, k1] = readArg(s, k);
          const [b, k2] = readArg(s, k1);
          const ra = fracSide(a, lang);
          const rb = fracSide(b, lang);
          out += ` ${ra} ${pick(lang, 'over', 'durch')} ${rb} `;
          i = k2;
          continue;
        }
        if (cmd === 'sqrt') {
          let idx: string | null = null;
          while (k < s.length && s[k] === ' ') k += 1;
          if (s[k] === '[') {
            const close = s.indexOf(']', k);
            idx = render(s.slice(k + 1, close), lang);
            k = close + 1;
          }
          const [a, k1] = readArg(s, k);
          out += ` ${rootPhrase(idx, render(a, lang), lang)} `;
          i = k1;
          continue;
        }
        if (cmd === 'binom' || cmd === 'dbinom' || cmd === 'tbinom') {
          const [a, k1] = readArg(s, k);
          const [b, k2] = readArg(s, k1);
          out += ` ${render(a, lang)} ${pick(lang, 'choose', 'über')} ${render(b, lang)} `;
          i = k2;
          continue;
        }
        const ACCENT: Record<string, [string, string]> = {
          overline: ['bar', 'quer'], bar: ['bar', 'quer'], hat: ['hat', 'Dach'],
          dot: ['dot', 'Punkt'], ddot: ['double dot', 'zwei Punkt'], tilde: ['tilde', 'Schlange'],
        };
        if (ACCENT[cmd]) {
          const [a, k1] = readArg(s, k);
          const inner = render(a, lang);
          const multi = /\s/.test(inner.trim());
          const word = pick(lang, ACCENT[cmd][0], ACCENT[cmd][1]);
          const scoped =
            (cmd === 'overline' || cmd === 'bar') && multi
              ? `${inner} ${pick(lang, 'all ' + word, 'alles ' + word)}`
              : `${inner} ${word}`;
          out += ` ${scoped} `;
          i = k1;
          continue;
        }
        if (cmd === 'vec') {
          const [a, k1] = readArg(s, k);
          out += ` ${pick(lang, 'vector', 'Vektor')} ${render(a, lang)} `;
          i = k1;
          continue;
        }
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

// A fraction side that is itself a fraction gets a spoken grouping cue.
function fracSide(arg: string, lang: SpeechLang): string {
  const r = render(arg, lang);
  if (/\b(over|durch)\b/.test(r)) return `${pick(lang, 'the fraction', 'den Bruch')} ${r}`;
  return r;
}

function rootPhrase(idx: string | null, a: string, lang: SpeechLang): string {
  if (!idx || idx === '2') return pick(lang, `the square root of ${a}`, `die Wurzel aus ${a}`);
  if (idx === '3') return pick(lang, `the cube root of ${a}`, `die dritte Wurzel aus ${a}`);
  const n = Number(idx);
  if (Number.isInteger(n) && n >= 4) {
    return pick(lang, `the ${ordinalEn(n)} root of ${a}`, `die ${ORD_DE[n] ?? n + '-te'} Wurzel aus ${a}`);
  }
  return pick(lang, `the ${idx}th root of ${a}`, `die ${idx}-te Wurzel aus ${a}`);
}

function expandPipes(s: string, lang: SpeechLang): string {
  // Balanced ASCII |A| with a single operand between; non-greedy, no nested pipes.
  return s.replace(/\|([^|]+)\|/g, (_m, a) =>
    ` ${pick(lang, 'the absolute value of', 'der Betrag von')} ${render(a, lang)} `,
  ).replace(/‖([^‖]+)‖/g, (_m, a) =>
    ` ${pick(lang, 'the norm of', 'die Norm von')} ${render(a, lang)} `,
  );
}

function expandBigOps(s: string, lang: SpeechLang): string {
  const OPS: Record<string, [string, string]> = {
    sum: ['the sum', 'die Summe'], prod: ['the product', 'das Produkt'],
    int: ['the integral', 'das Integral'], oint: ['the contour integral', 'das Umlaufintegral'],
  };
  s = s.replace(/\\(sum|prod|int|oint)((?:_(?:\{[^{}]*\}|.)|\^(?:\{[^{}]*\}|.))*)/g, (_m, op, subsup) => {
    const lower = /_(\{[^{}]*\}|.)/.exec(subsup);
    const upper = /\^(\{[^{}]*\}|.)/.exec(subsup);
    const strip = (x: string | undefined) => (x ? x.replace(/^[{]|[}]$/g, '') : '');
    const lo = lower ? render(strip(lower[1]), lang) : '';
    const hi = upper ? render(strip(upper[1]), lang) : '';
    let head = pick(lang, OPS[op][0], OPS[op][1]);
    if (lo && hi) head += pick(lang, ` from ${lo} to ${hi}`, ` von ${lo} bis ${hi}`);
    return ` ${head} ${pick(lang, 'of', 'von')} `;
  });
  s = s.replace(/\\lim(_(?:\{[^{}]*\}|.))?/g, (_m, sub) => {
    const inner = sub ? sub.slice(1).replace(/^[{]|[}]$/g, '') : '';
    const body = inner ? render(inner, lang) : '';
    const head = body
      ? pick(lang, `the limit as ${body}`, `der Grenzwert für ${body}`)
      : pick(lang, 'the limit', 'der Grenzwert');
    return ` ${head} ${pick(lang, 'of', 'von')} `;
  });
  // A trailing differential dx / dt / dr reads as two tokens.
  s = s.replace(/\bd([a-z])\b/g, 'd $1');
  return s;
}

function normalizeScripts(s: string, lang: SpeechLang): string {
  // Superscript run: digits-then-sign is an ion charge; otherwise an exponent.
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿⁱ⁺⁻]+/g, (run) => {
    const ascii = [...run].map((c) => SUPER[c] ?? '').join('');
    if (/^\d+[+-]$/.test(ascii)) {
      const sign = ascii.endsWith('+') ? pick(lang, 'plus', 'plus') : pick(lang, 'minus', 'minus');
      return ` ${ascii.slice(0, -1)} ${sign} `;
    }
    return `^{${ascii}}`;
  });
  s = s.replace(/[₀-₉ₙᵢⱼₖ₊₋]+/g, (run) => `_{${[...run].map((c) => SUB[c] ?? '').join('')}}`);
  return s;
}

function expandScripts(s: string, lang: SpeechLang): string {
  // Superscripts (LaTeX ^{...}/^x and the ASCII form; unicode + charge already normalized).
  s = replaceAll(s, /\^(\{[^{}]*\}|-?[A-Za-z0-9]+|.)/g, (_m, raw: string) => {
    const inner = raw.replace(/^\{|\}$/g, '');
    if (inner === '2') return ` ${pick(lang, 'squared', 'hoch 2')} `;
    if (inner === '3') return ` ${pick(lang, 'cubed', 'hoch 3')} `;
    if (inner === '\\circ' || inner === 'circ' || inner === '°') return ` ${pick(lang, 'degrees', 'Grad')} `;
    if (/^-/.test(inner)) return ` ${pick(lang, 'to the minus', 'hoch minus')} ${inner.slice(1)} `;
    return ` ${pick(lang, 'to the power of', 'hoch')} ${render(inner, lang)} `;
  });

  // Subscripts. snake_case (word_word) collapses to a space instead.
  s = s.replace(/([A-Za-z]{2,})_([A-Za-z]{2,})\b/g, '$1 $2');
  s = replaceAll(s, /([A-Za-z0-9)\]}])_(\{[^{}]*\}|[A-Za-z0-9]+|.)/g, (_m, base: string, raw: string) => {
    const tokens = raw.replace(/^\{|\}$/g, '').replace(/[{}]/g, '').trim();
    const single = /^[A-Za-z0-9]$/.test(tokens);
    const spoken = /^[A-Za-z0-9 ]+$/.test(tokens)
      ? tokens.split('').join(' ').replace(/\s+/g, ' ').trim()
      : render(tokens, lang);
    // A chemical-element base + a digit run is a formula count, spoken bare (H₂O -> "H 2 O").
    if (ELEMENTS.has(base) && /^\d+$/.test(tokens)) return `${base} ${tokens} `;
    if (lang === 'de') {
      // German drops "Index" for a single-token subscript, keeps it to group a multi-token one.
      return single ? `${base} ${tokens} ` : `${base} Index ${spoken} `;
    }
    return `${base} sub ${spoken} `;
  });
  return s;
}

// Unicode radicals as prefix operators: √A, ∛A (cube), ∜A (fourth). The operand is the next
// braced/parenthesised group or single token, rendered so √(a+b) speaks its inside.
function expandRadicals(s: string, lang: SpeechLang): string {
  return s.replace(/([√∛∜])\s*(\{[^{}]*\}|\([^()]*\)|[A-Za-z0-9]+|.)/g, (_m, r: string, arg: string) => {
    const idx = r === '∛' ? '3' : r === '∜' ? '4' : null;
    const inner = arg.replace(/^[({]|[)}]$/g, '');
    return ` ${rootPhrase(idx, render(inner, lang), lang)} `;
  });
}

// Space out a chemical formula so a digit count is spoken apart from its element (H2O -> "H 2 O").
function spaceFormula(s: string): string {
  return s
    .replace(/([a-z0-9])(?=[A-Z])/g, '$1 ')
    .replace(/([A-Za-z])(?=\d)/g, '$1 ')
    .replace(/(\d)(?=[A-Za-z])/g, '$1 ');
}

function applyLatex(s: string, lang: SpeechLang): string {
  const names = Object.keys(LATEX).sort((a, b) => b.length - a.length);
  const re = new RegExp('\\\\(' + names.join('|') + ')(?![A-Za-z])', 'g');
  return s.replace(re, (_m, name: string) => ` ${pick(lang, LATEX[name][0], LATEX[name][1])} `);
}

function applyUnicode(s: string, lang: SpeechLang): string {
  s = s.replace(/°C/g, ` ${pick(lang, 'degrees Celsius', 'Grad Celsius')} `);
  s = s.replace(/°F/g, ` ${pick(lang, 'degrees Fahrenheit', 'Grad Fahrenheit')} `);
  let out = '';
  for (const ch of s) {
    const hit = UNI[ch];
    out += hit ? ` ${pick(lang, hit[0], hit[1])} ` : ch;
  }
  return out;
}

function applyAsciiOps(s: string, lang: SpeechLang): string {
  s = s
    .replace(/<=|≤/g, ` ${pick(lang, 'less than or equal to', 'kleiner gleich')} `)
    .replace(/>=|≥/g, ` ${pick(lang, 'greater than or equal to', 'grösser gleich')} `)
    .replace(/!=|<>/g, ` ${pick(lang, 'not equal to', 'ungleich')} `)
    .replace(/==?/g, ` ${pick(lang, 'equals', 'gleich')} `)
    .replace(/</g, ` ${pick(lang, 'less than', 'kleiner als')} `)
    .replace(/>/g, ` ${pick(lang, 'greater than', 'grösser als')} `)
    .replace(/\+/g, ` ${pick(lang, 'plus', 'plus')} `)
    .replace(/\*/g, ` ${pick(lang, 'times', 'mal')} `)
    .replace(/([0-9A-Za-z)\]])\s*\/\s*([0-9A-Za-z(\[])/g, `$1 ${pick(lang, 'over', 'durch')} $2`)
    .replace(/(^|[\s(=+])-\s*(?=[0-9A-Za-z.\\(])/g, `$1${pick(lang, 'minus', 'minus')} `)
    .replace(/([0-9A-Za-z)\]])\s*-\s*(?=[0-9A-Za-z(])/g, `$1 ${pick(lang, 'minus', 'minus')} `)
    .replace(/(\d):(\d)/g, `$1 ${pick(lang, 'to', 'zu')} $2`);
  // digit immediately followed by a letter -> speak them apart (5x -> 5 x), never adds "times".
  // An ordinal suffix (4th, 2nd) is left whole so a spoken "the 4th root" is not split.
  s = s.replace(/(\d)(?=[A-Za-z])(?!(?:st|nd|rd|th)\b)/g, '$1 ');
  return s;
}

function applyFunctionApplication(s: string, lang: SpeechLang): string {
  // A '(' straight after a function word, single letter, or prime reads "of"/"von".
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '(') {
      const before = out.match(/([A-Za-z]+|['’])\s*$/);
      const word = before ? before[1] : '';
      const isFn = FUNC.has(word) || /^[A-Za-z]$/.test(word) || word === "'" || word === '’';
      out += isFn ? ` ${pick(lang, 'of', 'von')} ` : ' ';
    } else if (s[i] === ')') {
      out += ' ';
    } else {
      out += s[i];
    }
  }
  return out;
}

// String.replace with a function can skip overlapping matches; a fixed-point sweep is safer
// for the script handlers, which rewrite left-to-right without overlap anyway.
function replaceAll(s: string, re: RegExp, fn: (...a: string[]) => string): string {
  return s.replace(re, fn as (substring: string, ...args: unknown[]) => string);
}

// ---- prose-safe segmentation: decide what is math, leave the rest alone ----
export function mathToSpeech(input: string, lang: SpeechLang): string {
  if (!input) return input;
  if (CONTROL.has(input.trim())) return input;

  const masks: string[] = [];
  const seal = (text: string): string => {
    masks.push(text);
    return `${String.fromCharCode(0xe100 + masks.length - 1)}`;
  };

  // Escaped $ and % first, so \$ can never open a span.
  let s = input
    .replace(/\\\$/g, () => seal(pick(lang, 'dollar', 'Dollar')))
    .replace(/\\%/g, () => seal(pick(lang, 'percent', 'Prozent')));

  // Protect hyphenated words and contractions BEFORE anything else can mathify them.
  s = s.replace(/[A-Za-zÀ-ÿ]+(?:-[A-Za-zÀ-ÿ]+)+/g, (m) => seal(m));
  s = s.replace(/[A-Za-zÀ-ÿ]+['’][A-Za-zÀ-ÿ]/g, (m) => seal(m.slice(0, -1)) + m.slice(-1));

  // $$...$$ then $...$ -> render inner -> sealed (protected, spaced) result.
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner) => ` ${seal(render(inner, lang))} `);
  s = s.replace(/\$([^$]+)\$/g, (_m, inner) => ` ${seal(render(inner, lang))} `);
  s = s.replace(/\$/g, () => seal(pick(lang, 'dollar', 'Dollar')));

  // Arrow context that must beat the default limit reading "goes to"/"gegen": a mapping
  // declaration (f: A → B) reads "to"/"nach", and a reaction between two chemical formulas
  // reads "yields"/"ergibt", spacing the formulas so H2O speaks as "H 2 O".
  s = s.replace(
    /(?<![A-Za-z])([A-Za-z])\s*:\s*([A-Za-z0-9]+)\s*(?:→|\\(?:to|rightarrow|longrightarrow))\s*([A-Za-z0-9]+)/g,
    (_m, f: string, a: string, b: string) => `${f}: ${a} ${seal(pick(lang, 'to', 'nach'))} ${b}`,
  );
  s = s.replace(
    /\b((?:[A-Z][a-z]?\d*)+)\s*(?:→|\\(?:to|rightarrow|longrightarrow))\s*((?:[A-Z][a-z]?\d*)+)\b/g,
    (m: string, l: string, r: string) =>
      /\d/.test(l + r) || /[A-Z][a-z]/.test(l + r)
        ? `${spaceFormula(l)} ${seal(pick(lang, 'yields', 'ergibt'))} ${spaceFormula(r)}`
        : m,
  );

  // Unambiguous notation is spoken everywhere (LaTeX commands, Unicode, and the ^/_ scripts
  // have no prose meaning). ASCII =,-,*,/,: stay untouched here — those wait for a math run.
  s = expandStructural(s, lang);
  s = expandRadicals(s, lang);
  s = normalizeScripts(s, lang);
  s = expandScripts(s, lang);
  s = applyLatex(s, lang);
  s = applyUnicode(s, lang);
  s = s.replace(/\\([A-Za-z]+)/g, ' $1 ');

  // Promote bare ASCII math runs: a maximal charset run that carries a real signal.
  s = promoteRuns(s, lang);

  // Leftover prose numerics: a standalone digit-hyphen-digit is a range, a lone digit/digit
  // is odds. Both read "to"/"bis"/"zu"; neither is a subtraction or a fraction.
  s = s.replace(/(?<![\d.])(\d+)-(\d+)(?![\d.])/g, `$1 ${pick(lang, 'to', 'bis')} $2`);
  s = s.replace(/(?<![\d.\/])(\d+)\/(\d+)(?![\d.\/])/g, `$1 ${pick(lang, 'to', 'zu')} $2`);
  // snake_case that never reached a run.
  s = s.replace(/([A-Za-z]{2,})_([A-Za-z0-9]+)/g, '$1 $2');

  // Restore sealed text verbatim, tidy whitespace.
  s = s.replace(/([-])/g, (_m, c: string) => masks[c.charCodeAt(0) - 0xe100]);
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1').trim();
  // A label colon that ran straight into its content gets a breath ("Step 3:2x" -> "Step 3: 2 x").
  s = s.replace(/([A-Za-z0-9]):(?=[A-Za-z0-9])/g, '$1: ');

  if (lang === 'de') {
    // Swiss orthography, and a spoken decimal point (German reads the separator "Komma").
    s = s.replace(/(\d)[.,](\d)/g, `$1 Komma $2`).replace(/ß/g, 'ss');
  }
  return s;
}

// A run carries a real math signal if it has a relational/exponent operator, a '+'/'*'
// between operands, a balanced |...|, a function call, a trailing prime, or '**'. A lone
// hyphen or slash does NOT qualify (those are ranges / odds, handled as prose).
function hasSignal(run: string): boolean {
  if (/[=<>]/.test(run)) return true;
  if (/\*\*/.test(run)) return true;
  if (/[A-Za-z0-9)\]]\s*[+*]\s*[A-Za-z0-9(]/.test(run)) return true;
  if (/\|[^|]+\|/.test(run)) return true;
  if (/[A-Za-z]\s*'/.test(run)) return true;
  if (/[A-Za-z0-9]!/.test(run)) return /[=<>]/.test(run); // '!' alone is not a signal
  return false;
}

function promoteRuns(s: string, lang: SpeechLang): string {
  // Candidate runs never cross a sealed placeholder (those chars are outside the charset).
  return s.replace(/[A-Za-z0-9 ^_(){}+\-*/=<>.,|!'′″]+/g, (run) => {
    if (!hasSignal(run)) return run;
    // Keep leading/trailing whitespace so words rejoin cleanly around the rendered run.
    const lead = run.match(/^\s*/)?.[0] ?? '';
    const trail = run.match(/\s*$/)?.[0] ?? '';
    return lead + render(run.trim(), lang) + trail;
  });
}
