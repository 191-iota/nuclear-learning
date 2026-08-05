import katex from 'katex';

/**
 * Render a string that mixes prose with LaTeX math into safe HTML.
 *
 * Math is delimited `$...$` / `\(...\)` (inline) or `$$...$$` / `\[...\]` (display);
 * everything outside the delimiters is plain text — except that a bare TeX fragment
 * the model slipped in without any delimiter ("2^{2n}", "\frac{a}{b}") is detected
 * and rendered too (see promote), instead of showing up literally on screen. Only
 * KaTeX-produced markup is ever injected as HTML, the surrounding prose is escaped,
 * so a verdict or correction coming back from the model cannot smuggle markup into
 * the page. A malformed formula falls back to its literal source rather than throwing.
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function tryKatex(tex: string, display: boolean): string | null {
  try {
    // strict:'ignore' keeps legitimate-but-fussy input alive (umlauts inside math
    // mode, unicode minus); throwOnError:true so a real parse failure reaches the
    // repair pass below instead of KaTeX printing red source text into the panel.
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      output: 'html',
      strict: 'ignore',
    });
  } catch {
    return null;
  }
}

// Model output is not always valid KaTeX. The repairs below cover the recurring
// breakages seen in live replies; each is meaning-preserving, and anything still
// broken after them falls back to readable literal source instead of red garble.
const UNICODE_TEX: [RegExp, string][] = [
  [/×/g, '\\times '],
  [/÷/g, '\\div '],
  [/−|–|—/g, '-'],
  [/±/g, '\\pm '],
  [/∓/g, '\\mp '],
  [/≤/g, '\\le '],
  [/≥/g, '\\ge '],
  [/≠/g, '\\ne '],
  [/≈/g, '\\approx '],
  [/√/g, '\\sqrt '],
  [/∞/g, '\\infty '],
  [/→/g, '\\to '],
  [/⇒/g, '\\Rightarrow '],
  [/⇔/g, '\\Leftrightarrow '],
  [/°/g, '^{\\circ}'],
  [/²/g, '^{2}'],
  [/³/g, '^{3}'],
  [/¹/g, '^{1}'],
  [/½/g, '\\tfrac{1}{2}'],
  [/∈/g, '\\in '],
  [/∪/g, '\\cup '],
  [/∩/g, '\\cap '],
  [/∅/g, '\\emptyset '],
  [/ℝ/g, '\\mathbb{R}'],
  [/ℕ/g, '\\mathbb{N}'],
  [/ℤ/g, '\\mathbb{Z}'],
  [/ℚ/g, '\\mathbb{Q}'],
  [/…/g, '\\dots '],
  [/·/g, '\\cdot '],
  [/ /g, ' '],
];

function sanitizeTex(tex: string): string {
  let t = tex;
  // A bare % starts a TeX comment and silently eats the rest of the formula
  // ("steigt um 20%" renders as "steigt um 20"). Models mean the percent sign.
  t = t.replace(/(^|[^\\])%/g, '$1\\%');
  for (const [re, sub] of UNICODE_TEX) t = t.replace(re, sub);
  // align/align*/gather/eqnarray need the display-math wrapper KaTeX refuses to
  // fake; aligned is the drop-in that works in both modes.
  t = t.replace(/\\begin\{(align\*?|gather\*?|eqnarray\*?)\}/g, '\\begin{aligned}')
    .replace(/\\end\{(align\*?|gather\*?|eqnarray\*?)\}/g, '\\end{aligned}');
  // Unbalanced \left / \right (a truncated reply, usually) is fatal to the whole
  // formula; stripping the pair markers keeps the delimiters themselves visible.
  const lefts = (t.match(/\\left(?![a-zA-Z])/g) ?? []).length;
  const rights = (t.match(/\\right(?![a-zA-Z])/g) ?? []).length;
  if (lefts !== rights) {
    t = t.replace(/\\left(?![a-zA-Z])\s*/g, '').replace(/\\right(?![a-zA-Z])\s*/g, '');
  }
  // Missing closing braces (truncation again): append them; surplus closers are
  // left for the fallback, prepending an opener would change the meaning.
  let depth = 0;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}' && depth > 0) depth -= 1;
  }
  if (depth > 0) t += '}'.repeat(depth);
  // A lone trailing backslash is always a truncation artifact.
  t = t.replace(/\\$/, '');
  return t;
}

function renderTex(tex: string, display: boolean): string {
  const direct = tryKatex(tex, display);
  if (direct !== null) return direct;
  const repaired = sanitizeTex(tex);
  if (repaired !== tex) {
    const second = tryKatex(repaired, display);
    if (second !== null) return second;
  }
  // Both attempts failed: show the source legibly (monospace, quietly styled by
  // MathText) rather than KaTeX's red inline error soup.
  const d = display ? '$$' : '$';
  return `<code class="tex-fallback">${escapeHtml(d + tex + d)}</code>`;
}

// ---- bare-TeX promotion: undelimited fragments the model forgot to wrap ----
//
// Promotion must be TIGHT: unlike the speech pipeline (which turns math into words and
// can afford to touch a whole run), rendering a prose word through KaTeX would set it
// in math italics. So only whitespace-delimited tokens that are unmistakably TeX act
// as anchors, and a span grows from an anchor only across operator glue and operand
// tokens, never across a prose word. Sentence punctuation clinging to a token ends the
// span there and stays outside the math.

// Unmistakably TeX, never prose: a \command, or a ^/_ script attached to something.
const STRONG_TEX = /\\[a-zA-Z]+|[\^_](\{|[0-9A-Za-z(])/;

// The whole token is made of math-charset characters (no umlauts, no `$`).
const MATH_CHARSET = /^[0-9A-Za-z(){}[\]^_+\-*/=<>.,:;|!'\\]+$/;

// A prose word, possibly with clinging punctuation ("Vereinfache:", "gilt,").
const PROSE_WORD = /^[A-Za-z]{2,}[.,;:!?]*$/;

// Pure operator glue between operands ("=", "+", "<=").
const CONNECTOR = /^[+\-*/=<>]+$/;

type TokenKind = 'strong' | 'operand' | 'connector' | 'prose';

// Trailing sentence punctuation is not part of a formula ("... gilt 2^{2n}, weil").
function splitTrail(token: string): [string, string] {
  const m = /[.,;:!?]+$/.exec(token);
  return m ? [token.slice(0, m.index), m[0]] : [token, ''];
}

function classify(token: string): TokenKind {
  const [core] = splitTrail(token);
  if (!core || !MATH_CHARSET.test(core) || PROSE_WORD.test(token)) return 'prose';
  if (STRONG_TEX.test(core)) return 'strong';
  if (CONNECTOR.test(core)) return 'connector';
  if (/[0-9A-Za-z\\]/.test(core)) return 'operand';
  return 'prose';
}

// Escape a plain segment, rendering any bare-TeX spans found inside it.
function promote(text: string): string {
  if (!STRONG_TEX.test(text)) return escapeHtml(text);
  // split(/(\s+)/) alternates token / separator; tokens sit at even indices.
  const parts = text.split(/(\s+)/);
  const kinds = parts.map((p, idx) => (idx % 2 === 0 && p ? classify(p) : null));
  // Two-pass: mark which tokens join a span around each strong anchor, then emit.
  const inSpan = new Array<boolean>(parts.length).fill(false);
  for (let a = 0; a < parts.length; a += 2) {
    if (kinds[a] !== 'strong') continue;
    let lo = a;
    let hi = a;
    // Left: absorb operands/connectors, but a token whose own punctuation separates it
    // from us ("x=2, ...") stays out.
    while (lo - 2 >= 0 && (kinds[lo - 2] === 'operand' || kinds[lo - 2] === 'connector' || kinds[lo - 2] === 'strong')) {
      if (splitTrail(parts[lo - 2])[1]) break;
      lo -= 2;
    }
    // Right: absorb likewise; a token carrying trailing punctuation joins but ends the span.
    while (splitTrail(parts[hi])[1] === '' && hi + 2 < parts.length
      && (kinds[hi + 2] === 'operand' || kinds[hi + 2] === 'connector' || kinds[hi + 2] === 'strong')) {
      hi += 2;
    }
    // Bare connectors at the edges are prose glue ("und - x^2"), not part of the math.
    while (lo < a && kinds[lo] === 'connector') lo += 2;
    while (hi > a && kinds[hi] === 'connector') hi -= 2;
    for (let k = lo; k <= hi; k += 1) inSpan[k] = true;
  }
  let out = '';
  let i = 0;
  while (i < parts.length) {
    if (!inSpan[i]) {
      out += escapeHtml(parts[i]);
      i += 1;
      continue;
    }
    // Collect the contiguous span (tokens and their separators).
    const cores: string[] = [];
    let trail = '';
    while (i < parts.length && inSpan[i]) {
      if (i % 2 === 0) {
        const [core, t] = splitTrail(parts[i]);
        cores.push(core);
        trail = t; // only the last token's punctuation survives the span
      }
      i += 1;
    }
    out += renderTex(cores.join(' '), false) + escapeHtml(trail);
  }
  return out;
}

// ---- shared math segmentation ----

type MathSeg = { kind: 'text'; text: string } | { kind: 'math'; tex: string; display: boolean };

function splitMath(input: string): MathSeg[] {
  const segs: MathSeg[] = [];
  let plain = '';
  const flush = () => {
    if (plain) {
      segs.push({ kind: 'text', text: plain });
      plain = '';
    }
  };
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    const next = input[i + 1];
    // A backslash-escaped dollar is a literal $, never a delimiter.
    if (ch === '\\' && next === '$') {
      plain += '$';
      i += 2;
      continue;
    }
    // \( ... \) and \[ ... \], the delimiters GPT models default to.
    if (ch === '\\' && (next === '(' || next === '[')) {
      const display = next === '[';
      const closer = display ? ']' : ')';
      let j = i + 2;
      let close = -1;
      while (j < n) {
        if (input[j] === '\\') {
          if (input[j + 1] === closer) {
            close = j;
            break;
          }
          j += 2;
          continue;
        }
        j += 1;
      }
      // No closing delimiter: leave the rest as plain text rather than eating it.
      if (close === -1) {
        plain += input.slice(i);
        break;
      }
      flush();
      segs.push({ kind: 'math', tex: input.slice(i + 2, close), display });
      i = close + 2;
      continue;
    }
    if (ch === '$') {
      const display = next === '$';
      const delim = display ? '$$' : '$';
      const start = i + delim.length;
      // An opening $ followed by whitespace (or nothing) is prose, not a delimiter:
      // without this, one stray $ pairs with the next unrelated $ and renders the
      // prose between them as garbled math.
      if (!display && (start >= n || /\s/.test(input[start]))) {
        plain += '$';
        i += 1;
        continue;
      }
      let j = start;
      let close = -1;
      while (j < n) {
        if (input[j] === '\\') {
          j += 2;
          continue;
        }
        if (display ? input[j] === '$' && input[j + 1] === '$' : input[j] === '$') {
          close = j;
          break;
        }
        j += 1;
      }
      // No closing delimiter: treat the rest as plain text rather than eating it.
      if (close === -1) {
        plain += input.slice(i);
        break;
      }
      flush();
      segs.push({ kind: 'math', tex: input.slice(start, close), display });
      i = close + delim.length;
      continue;
    }
    // Plain run up to the next potential delimiter.
    let k = i;
    while (k < n && input[k] !== '$' && !(input[k] === '\\' && k + 1 < n && '$(['.includes(input[k + 1]))) {
      k += 1;
    }
    if (k === i) k = i + 1; // lone trailing backslash: consume it, never stall
    plain += input.slice(i, k);
    i = k;
  }
  flush();
  return segs;
}

export function renderMath(input: string): string {
  if (!input) return '';
  return splitMath(input)
    .map((s) => (s.kind === 'math' ? renderTex(s.tex, s.display) : promote(s.text)))
    .join('');
}

// ---- rich rendering: full markdown on top of the math pipeline ----
//
// Chat replies render as study material: headings, lists, tables, code, quotes,
// links, emphasis, with LaTeX live everywhere prose is. The safety model is the
// one renderMath has: the only injected HTML is KaTeX output and the fixed set of
// md-* wrappers built right here; every piece of prose passes through escaping.
// Block elements swallow the newlines they consume, so the pre-wrap containers the
// output lands in do not double-space around lists and headings.

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

function isTableSep(line: string): boolean {
  return /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// Emphasis inside one prose run: *italic* pairs stay within a text segment.
function italicRun(text: string): string {
  const parts = text.split(/(?<![\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g);
  let html = '';
  for (let i = 0; i < parts.length; i += 1) {
    html += i % 2 === 1 ? `<em>${promote(parts[i])}</em>` : promote(parts[i]);
  }
  return html;
}

// [label](https://...) links; only http(s) targets, everything escaped.
function linkRun(text: string): string {
  const parts = text.split(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g);
  let html = '';
  for (let i = 0; i < parts.length; i += 3) {
    html += italicRun(parts[i] ?? '');
    if (i + 2 < parts.length) {
      html += `<a class="md-a" href="${escapeHtml(parts[i + 2])}" target="_blank" rel="noopener noreferrer">${italicRun(parts[i + 1])}</a>`;
    }
  }
  return html;
}

// One line of prose+math. Inline code is lifted out first (its content is
// literal), then math is segmented, then **bold** toggles ACROSS segments (models
// bold across formulas: "**wichtig: $x=2$**"), italic and links resolve within
// each text segment, and promote() escapes whatever remains.
function renderInline(line: string): string {
  // NUL sentinels cannot collide with content: cleanText strips \x00 from every
  // model reply before it reaches a store.
  const codes: string[] = [];
  const src = line.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code class="md-c">${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  let html = '';
  let bold = false;
  for (const seg of splitMath(src)) {
    if (seg.kind === 'math') {
      html += renderTex(seg.tex, seg.display);
      continue;
    }
    const parts = seg.text.split('**');
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        bold = !bold;
        html += bold ? '<strong>' : '</strong>';
      }
      html += linkRun(parts[i]);
    }
  }
  if (bold) html += '</strong>';
  return html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? '');
}

// A $$ block spread over several lines becomes one line before block parsing, so
// the line-based renderer still hands KaTeX the whole formula. (Inside a code
// fence a stray $$ could mis-join lines; code fences carrying display-math
// delimiters have not appeared in practice.)
function joinDisplayMath(lines: string[]): string[] {
  const out: string[] = [];
  let buf: string[] | null = null;
  for (const line of lines) {
    const odd = ((line.match(/\$\$/g) ?? []).length % 2) === 1;
    if (buf === null) {
      if (odd) buf = [line];
      else out.push(line);
    } else {
      buf.push(line);
      if (odd) {
        out.push(buf.join(' '));
        buf = null;
      }
    }
  }
  if (buf) out.push(...buf); // unclosed $$: keep the lines as they were
  return out;
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

// One nesting level: an item indented by 2+ spaces joins a sublist of the item
// above it. Deeper indents clamp to that same level.
function renderList(items: ListItem[]): string {
  let html = '';
  let top: string | null = null;
  let sub: string | null = null;
  let liOpen = false;
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    if (it.indent >= 2 && liOpen) {
      if (sub && sub !== tag) {
        html += `</${sub}>`;
        sub = null;
      }
      if (!sub) {
        html += `<${tag} class="md-l md-sub">`;
        sub = tag;
      }
      html += `<li>${renderInline(it.text)}</li>`;
      continue;
    }
    if (sub) {
      html += `</${sub}>`;
      sub = null;
    }
    if (liOpen) {
      html += '</li>';
      liOpen = false;
    }
    if (top !== tag) {
      if (top) html += `</${top}>`;
      html += `<${tag} class="md-l">`;
      top = tag;
    }
    html += `<li>${renderInline(it.text)}`;
    liOpen = true;
  }
  if (sub) html += `</${sub}>`;
  if (liOpen) html += '</li>';
  if (top) html += `</${top}>`;
  return html;
}

export function renderRich(input: string): string {
  if (!input) return '';
  const lines = joinDisplayMath(input.split('\n'));
  const out: string[] = [];
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<div class="md-p">${para.map(renderInline).join('\n')}</div>`);
      para.length = 0;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // past the closing fence (or the end)
      out.push(`<pre class="md-code"><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const th = splitRow(line)
        .map((c) => `<th>${renderInline(c)}</th>`)
        .join('');
      i += 2;
      let body = '';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body += `<tr>${splitRow(lines[i])
          .map((c) => `<td>${renderInline(c)}</td>`)
          .join('')}</tr>`;
        i += 1;
      }
      out.push(
        `<div class="md-tw"><table class="md-t"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      out.push('<hr class="md-hr">');
      i += 1;
      continue;
    }
    if (LIST_RE.test(line)) {
      flushPara();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        items.push({ indent: m[1].length, ordered: /^\d/.test(m[2]), text: m[3] });
        i += 1;
      }
      out.push(renderList(items));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote class="md-q">${buf.map(renderInline).join('\n')}</blockquote>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      out.push(`<div class="md-h md-h${Math.min(4, h[1].length)}">${renderInline(h[2])}</div>`);
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return out.join('');
}
