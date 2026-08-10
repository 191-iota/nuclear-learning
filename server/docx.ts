import zlib from 'node:zlib';

/**
 * A minimum Word reader: exactly enough ZIP and WordprocessingML to LOOK at a .docx
 * that was filed into the notebook, and nothing more.
 *
 * The alternative was a converter library, and every one of them drags in a zip
 * stack, an XML stack and a few megabytes for a job the platform already does: a
 * .docx is a zip of XML files, and node ships the inflate. So this is one file with
 * no dependencies instead of a dependency tree.
 *
 * What survives the trip: headings, paragraphs, bold/italic/underline, lists,
 * tables, line breaks and embedded pictures. What does not: styles, columns, fields,
 * footnotes, comments, exact spacing. It is for reading a document you kept, not for
 * editing it, and the original bytes are always one Download away.
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const MAX_TEXT = 200_000; // the searchable/attachable text kept on the note
const MAX_MEDIA_BYTES = 24 * 1024 * 1024; // a single picture served out of a document

// ---- zip ----

/** The end-of-central-directory record, scanned for from the back as the format asks. */
function findEocd(buf: Buffer): number {
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

interface ZipEntry {
  method: number;
  start: number;
  compSize: number;
}

export interface Zip {
  buf: Buffer;
  entries: Map<string, ZipEntry>;
}

/**
 * Read the archive through its central directory rather than by walking local
 * headers: entries written in streaming mode leave their sizes out of the local
 * header, and the directory always carries them.
 *
 * Only offsets are read here. A document is mostly pictures, and viewing it needs
 * one XML file out of it, so nothing is decompressed until somebody asks for it.
 */
export function readZip(buf: Buffer): Zip {
  const entries = new Map<string, ZipEntry>();
  const eocd = findEocd(buf);
  if (eocd < 0) return { buf, entries };
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (localOff + 30 > buf.length) continue;
    // The local header repeats the name and carries its own extra field, which is
    // not always the same length as the directory's.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    entries.set(name, { method, start: localOff + 30 + lNameLen + lExtraLen, compSize });
  }
  return { buf, entries };
}

/** One member, inflated on demand; null when it is missing or unreadable. */
export function readEntry(zip: Zip, name: string): Buffer | null {
  const e = zip.entries.get(name);
  if (!e) return null;
  const raw = zip.buf.subarray(e.start, e.start + e.compSize);
  try {
    return e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
  } catch {
    return null; // one unreadable member must not cost the whole document
  }
}

/** The pictures a document carries, for the endpoint that serves them one by one. */
export function docxMedia(buf: Buffer, name: string): { bytes: Buffer; mime: string } | null {
  if (!name.startsWith('word/') || name.includes('..')) return null;
  const zip = readZip(buf);
  const entry = zip.entries.get(name);
  if (!entry || entry.compSize > MAX_MEDIA_BYTES) return null;
  const bytes = readEntry(zip, name);
  return bytes ? { bytes, mime: mimeOf(name) } : null;
}

function mimeOf(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'emf' || ext === 'wmf') return 'application/octet-stream';
  return `image/${ext || 'png'}`;
}

// ---- XML helpers ----

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The value of an attribute on a single tag, e.g. w:val on <w:pStyle w:val="…"/>. */
function attr(tag: string, name: string): string {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : '';
}

/**
 * Where the element starting at `from` ends. Depth is counted because the
 * interesting elements nest inside themselves: a table lives in a table cell, and a
 * paragraph lives in one too, so the first matching close tag is not always ours.
 */
function endOfBlock(xml: string, tag: string, from: number): number {
  const re = new RegExp(`<${tag}(?=[\\s/>])[^>]*>|</${tag}>`, 'g');
  re.lastIndex = from;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth <= 0) return re.lastIndex;
    } else if (!m[0].endsWith('/>')) {
      depth += 1;
    } else if (depth === 0) {
      return re.lastIndex; // an empty element holds nothing
    }
  }
  return xml.length;
}

/** The outermost <tag>…</tag> ranges inside xml, in document order. */
function blocks(xml: string, tag: string): string[] {
  const open = new RegExp(`<${tag}(?=[\\s/>])[^>]*>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    if (m[0].endsWith('/>')) continue;
    const end = endOfBlock(xml, tag, m.index);
    out.push(xml.slice(m.index, end));
    open.lastIndex = end;
  }
  return out;
}

// ---- WordprocessingML ----

/** What one level of one list looks like: bulleted, or numbered in some style. */
interface NumFmt {
  ordered: boolean;
  type: string; // the HTML ol type attribute: 1, a, A, i, I
}

type Numbering = Map<string, Map<number, NumFmt>>; // numId → level → format

interface Ctx {
  zip: Zip;
  rels: Map<string, string>; // relationship id → zip path
  numbering: Numbering;
  // Where the pictures come from. A URL prefix keeps them OUT of the converted HTML
  // (a thesis with 90 photographs is megabytes of base64 otherwise) and lets the
  // browser fetch them lazily, one request each. Empty inlines them instead, which
  // is what a caller without a server wants.
  mediaBase: string;
  text: string[];
}

const HEADING = /^(Heading|berschrift|Titre|Ttulo)(\d)?$/i;

/** Which HTML block a paragraph style maps to; unknown styles stay paragraphs. */
function blockTag(style: string): string {
  if (!style) return 'p';
  const clean = style.replace(/[^A-Za-z0-9]/g, '');
  if (/^(Title|Titel)$/i.test(clean)) return 'h1';
  const m = HEADING.exec(clean);
  if (m) return `h${Math.min(4, Number(m[2] || 1) + 1)}`;
  return 'p';
}

function imageHtml(runXml: string, ctx: Ctx): string {
  const embed = /<a:blip[^>]*r:embed="([^"]+)"/.exec(runXml);
  if (!embed) return '';
  const target = ctx.rels.get(embed[1]);
  if (!target || !ctx.zip.entries.has(target)) return '<span class="docx-missing">[picture]</span>';
  if (ctx.mediaBase) {
    return `<img loading="lazy" alt="" src="${esc(ctx.mediaBase)}${encodeURIComponent(target)}" />`;
  }
  const bytes = readEntry(ctx.zip, target);
  if (!bytes) return '<span class="docx-missing">[picture]</span>';
  return `<img alt="" src="data:${mimeOf(target)};base64,${bytes.toString('base64')}" />`;
}

/** One run: its formatting, its text, and whatever it draws. */
function runHtml(runXml: string, ctx: Ctx): { html: string; text: string } {
  const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(runXml)?.[0] ?? '';
  const bold = /<w:b\b(?![^>]*w:val="(?:0|false)")/.test(rPr);
  const italic = /<w:i\b(?![^>]*w:val="(?:0|false)")/.test(rPr);
  const under = /<w:u\b(?![^>]*w:val="none")/.test(rPr);
  let html = '';
  let text = '';
  // Children in document order, so a run of "text <br> text" keeps its break.
  const body = runXml.replace(rPr, '');
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/?>|<w:tab\s*\/?>|<w:drawing>[\s\S]*?<\/w:drawing>|<w:pict>[\s\S]*?<\/w:pict>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      const raw = m[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
      html += esc(raw);
      text += raw;
    } else if (m[0].startsWith('<w:br')) {
      html += '<br />';
      text += '\n';
    } else if (m[0].startsWith('<w:tab')) {
      html += '<span class="docx-tab"></span>';
      text += '\t';
    } else {
      html += imageHtml(m[0], ctx);
    }
  }
  if (!html) return { html: '', text: '' };
  if (bold) html = `<strong>${html}</strong>`;
  if (italic) html = `<em>${html}</em>`;
  if (under) html = `<u>${html}</u>`;
  return { html, text };
}

function paraContent(paraXml: string, ctx: Ctx): { html: string; text: string } {
  let html = '';
  let text = '';
  // Runs are collected wherever they sit, which is how hyperlinks, bookmarks and
  // revision marks come through as their plain text instead of vanishing.
  for (const run of blocks(paraXml, 'w:r')) {
    const r = runHtml(run, ctx);
    html += r.html;
    text += r.text;
  }
  return { html, text };
}

function tableHtml(tblXml: string, ctx: Ctx): string {
  let html = '<table class="docx-table">';
  for (const row of blocks(tblXml, 'w:tr')) {
    html += '<tr>';
    const cells = blocks(row, 'w:tc');
    const cellTexts: string[] = [];
    for (const cell of cells) {
      let inner = '';
      let cellText = '';
      for (const p of blocks(cell, 'w:p')) {
        const c = paraContent(p, ctx);
        inner += `<p>${c.html || '&nbsp;'}</p>`;
        cellText += `${c.text} `;
      }
      cellTexts.push(cellText.trim());
      html += `<td>${inner || '<p>&nbsp;</p>'}</td>`;
    }
    ctx.text.push(cellTexts.join(' | '));
    html += '</tr>';
  }
  return `${html}</table>`;
}

/**
 * The body, block by block, in document order. Consecutive numbered or bulleted
 * paragraphs are gathered into one list so a Word list reads like a list.
 */
function bodyHtml(xml: string, ctx: Ctx): string {
  const from = xml.indexOf('<w:body>');
  const to = xml.lastIndexOf('</w:body>');
  const body = from < 0 || to < from ? xml : xml.slice(from + 8, to);
  const re = /<w:p(?=[\s/>])|<w:tbl(?=[\s/>])/g;
  const parts: string[] = [];
  // Open lists, outermost first. Word gives each list paragraph a level, so nesting
  // is a matter of opening and closing to match the level the next one asks for.
  const stack: ('ul' | 'ol')[] = [];
  const closeTo = (depth: number) => {
    while (stack.length > depth) parts.push(`</${stack.pop()}>`);
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const isTable = m[0].startsWith('<w:tbl');
    // Skipping to the end of each block is what keeps this linear over a long
    // document, and it is also what stops a table's own paragraphs from being
    // emitted a second time outside the table.
    const end = endOfBlock(body, isTable ? 'w:tbl' : 'w:p', m.index);
    const block = body.slice(m.index, end);
    re.lastIndex = end;
    if (isTable) {
      closeTo(0);
      parts.push(tableHtml(block, ctx));
      continue;
    }
    const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(block)?.[0] ?? '';
    const style = attr(/<w:pStyle[^>]*>/.exec(pPr)?.[0] ?? '', 'w:val');
    const listed = /<w:numPr>/.test(pPr);
    const c = paraContent(block, ctx);
    if (listed) {
      const numId = attr(/<w:numId[^>]*\/?>/.exec(pPr)?.[0] ?? '', 'w:val');
      const raw = Number(attr(/<w:ilvl[^>]*\/?>/.exec(pPr)?.[0] ?? '', 'w:val'));
      const level = Math.max(0, Math.min(8, Number.isFinite(raw) ? raw : 0));
      const fmt = ctx.numbering.get(numId)?.get(level);
      const want: 'ul' | 'ol' = fmt?.ordered ? 'ol' : 'ul';
      closeTo(level + 1);
      // A bulleted list followed by a numbered one at the same level is two lists.
      if (stack.length === level + 1 && stack[level] !== want) closeTo(level);
      while (stack.length < level + 1) {
        const target = stack.length === level;
        const tag = target ? want : 'ul';
        const type = target && want === 'ol' && fmt ? ` type="${fmt.type}"` : '';
        parts.push(`<${tag} class="docx-list"${type}>`);
        stack.push(tag);
      }
      parts.push(`<li>${c.html || '&nbsp;'}</li>`);
      ctx.text.push(`${'  '.repeat(level)}- ${c.text}`);
      continue;
    }
    closeTo(0);
    const tag = blockTag(style);
    parts.push(c.html ? `<${tag}>${c.html}</${tag}>` : '<p class="docx-blank">&nbsp;</p>');
    ctx.text.push(c.text);
  }
  closeTo(0);
  return parts.join('\n');
}

const OL_TYPE: Record<string, string> = {
  decimal: '1',
  lowerLetter: 'a',
  upperLetter: 'A',
  lowerRoman: 'i',
  upperRoman: 'I',
};

/**
 * numbering.xml is what says whether a list level is bulleted or numbered. Without
 * it every Word list came out as the same disc, so a numbered procedure lost its
 * numbers and every nesting level sat flat at the same indent.
 *
 * The bullet CHARACTER is deliberately not taken from w:lvlText. Word writes those
 * in Symbol and Wingdings, where the glyph is a private-use code point that renders
 * as an empty box in any normal font. CSS markers are used instead, so a bullet is
 * always a bullet.
 */
function readNumbering(zip: Zip): Numbering {
  const out: Numbering = new Map();
  const xml = readEntry(zip, 'word/numbering.xml')?.toString('utf8') ?? '';
  if (!xml) return out;
  const abstract = new Map<string, Map<number, NumFmt>>();
  for (const a of blocks(xml, 'w:abstractNum')) {
    const id = attr(/<w:abstractNum[^>]*>/.exec(a)?.[0] ?? '', 'w:abstractNumId');
    if (!id) continue;
    const levels = new Map<number, NumFmt>();
    for (const lvl of blocks(a, 'w:lvl')) {
      const n = Number(attr(/<w:lvl[^>]*>/.exec(lvl)?.[0] ?? '', 'w:ilvl'));
      const fmt = attr(/<w:numFmt[^>]*\/?>/.exec(lvl)?.[0] ?? '', 'w:val') || 'bullet';
      levels.set(Number.isFinite(n) ? n : 0, {
        ordered: fmt !== 'bullet' && fmt !== 'none',
        type: OL_TYPE[fmt] ?? '1',
      });
    }
    abstract.set(id, levels);
  }
  // A numId points at an abstract definition, and several can share one.
  for (const num of blocks(xml, 'w:num')) {
    const id = attr(/<w:num[^>]*>/.exec(num)?.[0] ?? '', 'w:numId');
    const aid = attr(/<w:abstractNumId[^>]*\/?>/.exec(num)?.[0] ?? '', 'w:val');
    const levels = abstract.get(aid);
    if (id && levels) out.set(id, levels);
  }
  return out;
}

/** rId → the zip path it points at, for the pictures a document embeds. */
function readRels(zip: Zip): Map<string, string> {
  const out = new Map<string, string>();
  const xml = readEntry(zip, 'word/_rels/document.xml.rels')?.toString('utf8') ?? '';
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target').replace(/^\/?word\//, '').replace(/^\.\.\//, '');
    if (id && target) out.set(id, `word/${target}`);
  }
  return out;
}

export interface DocxView {
  html: string;
  text: string;
}

/**
 * Convert .docx bytes into viewable HTML plus the plain text worth searching.
 * `mediaBase` is the URL prefix a picture's zip path is appended to; leave it empty
 * to get a self-contained document with its pictures inlined.
 */
export function docxToHtml(buf: Buffer, mediaBase = ''): DocxView {
  const zip = readZip(buf);
  const doc = readEntry(zip, 'word/document.xml');
  if (!doc) throw new Error('not a Word document (no word/document.xml)');
  const ctx: Ctx = { zip, rels: readRels(zip), numbering: readNumbering(zip), mediaBase, text: [] };
  const html = bodyHtml(doc.toString('utf8'), ctx);
  const text = ctx.text
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);
  return { html, text };
}
