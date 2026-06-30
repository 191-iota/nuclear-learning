import katex from 'katex';

/**
 * Render a string that mixes prose with LaTeX math into safe HTML.
 *
 * Math is delimited `$...$` (inline) or `$$...$$` (display); everything outside
 * the delimiters is plain text. Only KaTeX-produced markup is ever injected as
 * HTML, the surrounding prose is escaped, so a verdict or correction coming back
 * from the model cannot smuggle markup into the page. A malformed formula falls
 * back to its literal source rather than throwing.
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
  } catch {
    const d = display ? '$$' : '$';
    return escapeHtml(d + tex + d);
  }
}

export function renderMath(input: string): string {
  if (!input) return '';
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    // A backslash-escaped dollar is a literal $, never a delimiter.
    if (ch === '\\' && input[i + 1] === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (ch === '$') {
      const display = input[i + 1] === '$';
      const delim = display ? '$$' : '$';
      const start = i + delim.length;
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
        out += escapeHtml(input.slice(i));
        break;
      }
      out += renderTex(input.slice(start, close), display);
      i = close + delim.length;
      continue;
    }
    // Plain run up to the next delimiter.
    let k = i;
    while (k < n && input[k] !== '$' && !(input[k] === '\\' && input[k + 1] === '$')) k += 1;
    out += escapeHtml(input.slice(i, k));
    i = k;
  }
  return out;
}
