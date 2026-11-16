// A fast drop-in for marked 18.1.3 (defaults: GFM on, breaks off).
//
// parse(markdown) returns exactly the HTML marked.parse(markdown) returns.
// marked's own Lexer tokenizes the blocks; the inline runs are rendered by
// a fresh direct-emit engine below that walks each inline run once and
// appends HTML strings, instead of building inline token objects, a token
// tree, or a Parser walk. Plain text is consumed by a hand-written scanner
// that jumps straight to the next interesting character, and the emphasis
// mask plus closer scan are built lazily, only when an emphasis or
// strikethrough opener is actually attempted.

import { Lexer } from './vendor/marked/marked.esm.js';

// GFM inline grammar, taken from marked's public rule sets.
const INLINE = Lexer.rules.inline.gfm;

// --- small helpers (escapes, character references, URLs) -----------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(html, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(html)) return html.replace(ESCAPE_REPLACE, (ch) => ESCAPE_MAP[ch]);
  } else if (ESCAPE_TEST_NO_ENCODE.test(html)) {
    return html.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumeric(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function rtrim(str, c) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    if (str.charAt(l - suffLen - 1) === c) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

// --- character classes ----------------------------------------------------

const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;
const NEWLINE_GLOBAL = /\n/g;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const CARRIAGE_RETURN = /\r\n|\r/g;
const NON_SPACE = /[^ ]/;
const START_SPACE = /^ /;
const END_SPACE = / $/;

// Characters that may start an email local part in the text scanner's
// stop rules (the broad set the GFM text rule looks ahead for).
const LOCAL_SET = new Uint8Array(128);
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-") {
  LOCAL_SET[ch.charCodeAt(0)] = 1;
}
function isLocal(code) {
  return code < 128 && LOCAL_SET[code] === 1;
}
function isAlnum(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isSpace(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

// --- emphasis mask --------------------------------------------------------
// Links, code spans, HTML and escapes are blanked out of a copy of the
// inline run so emphasis and strikethrough never pair across them. The
// copy keeps every character's position, so indexes line up with the run.

function scanClosers(masked) {
  let ast = -1;
  let und = -1;
  let del = -1;
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked.charCodeAt(i);
    if (ch !== 42 && ch !== 95 && ch !== 126) continue;
    const prev = i === 0 ? 10 : masked.charCodeAt(i - 1);
    let j = i + 1;
    while (j < len && masked.charCodeAt(j) === ch) j++;
    if (prev !== 32 && prev !== 9 && prev !== 10 && prev !== 13 && prev !== 12) {
      if (ch === 126) del = i;
      else if (ch === 42) ast = i;
      else und = i;
    }
    i = j - 1;
  }
  return { ast, und, del };
}

function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(INLINE.reflinkSearch)) {
    const match0 = m[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

function maskReflink(match0, links) {
  const refStart = match0.lastIndexOf('[');
  if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
  if (refStart > 1 && match0.charAt(0) !== '!') {
    const text = match0.slice(1, refStart - 1);
    if (linkInText(text, links)) {
      // A candidate holding a link never becomes one, so mask the links it
      // holds instead of flattening the whole span.
      const fresh = new RegExp(INLINE.reflinkSearch.source, INLINE.reflinkSearch.flags);
      return '[' + text.replace(fresh, (inner) => maskReflink(inner, links))
        + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(match0.length - 2) + ']';
}

function buildMask(src, links) {
  let masked = src;
  if (links && src.includes('[')) {
    masked = masked.replace(INLINE.reflinkSearch, (m0) => maskReflink(m0, links));
  }
  if (src.includes('`') || src.includes('\\')) {
    masked = masked.replace(INLINE.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(INLINE.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return masked;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE.tag.exec(tokenSrc) || INLINE.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// --- inline constructs ----------------------------------------------------
// Each try* function returns how many characters of src it consumed, or 0
// when the construct does not match here. Successful ones append their HTML
// to out. `flat` renders the text-only form (image alt text): no tags, no
// escaping, links flatten to their label text. ctx is the shared run state
// { inLink, inRawBlock, linkEmitted }; paren says whether a ')' may occur
// in this run, which lets link attempts skip their regex when it cannot
// match.

function tryEscape(src, out, flat) {
  const cap = INLINE.escape.exec(src);
  if (!cap) return 0;
  if (flat) out.push(cap[1]);
  else out.push(escapeHtml(cap[1]));
  return cap[0].length;
}

function tryTag(src, out, ctx) {
  const cap = INLINE.tag.exec(src);
  if (!cap) return 0;
  if (!ctx.inLink && START_A_TAG.test(cap[0])) ctx.inLink = true;
  else if (ctx.inLink && END_A_TAG.test(cap[0])) ctx.inLink = false;
  if (!ctx.inRawBlock && START_PRE_TAG.test(cap[0])) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && END_PRE_TAG.test(cap[0])) ctx.inRawBlock = false;
  out.push(cap[0]);
  return cap[0].length;
}

function tryBr(src, out, flat) {
  const cap = INLINE.br.exec(src);
  if (!cap) return 0;
  if (!flat) out.push('<br>');
  return cap[0].length;
}

function tryCodespan(src, out, flat) {
  const cap = INLINE.code.exec(src);
  if (!cap) return 0;
  let text = cap[2].replace(NEWLINE_GLOBAL, ' ');
  if (NON_SPACE.test(text) && START_SPACE.test(text) && END_SPACE.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  if (flat) out.push(text);
  else out.push('<code>' + escapeHtml(text, true) + '</code>');
  return cap[0].length;
}

function emitAutolinkText(text, href, out, flat) {
  if (flat) {
    out.push(text);
    return;
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    out.push(escapeHtml(text, true));
    return;
  }
  out.push('<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>');
}

function tryAutolink(src, out, flat) {
  const cap = INLINE.autolink.exec(src);
  if (!cap) return 0;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  emitAutolinkText(text, href, out, flat);
  return cap[0].length;
}

function tryUrl(src, out, flat) {
  const cap = INLINE.url.exec(src);
  if (!cap) return 0;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = INLINE._backpedal.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  emitAutolinkText(text, href, out, flat);
  return cap[0].length;
}

// Renders a matched link or image. Returns the raw length consumed, or 0
// when the link is dropped because its label holds another link.
function emitLink(cap, href, title, raw, links, out, ctx, paren, flat) {
  const text = cap[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const labelParen = paren && text.indexOf(')') !== -1;
  if (isImage) {
    const tmp = [];
    renderInline(text, links, tmp, ctx, labelParen, true);
    ctx.linkEmitted = outerLinkEmitted;
    ctx.inLink = outerInLink;
    if (flat) {
      for (const s of tmp) out.push(s);
      return raw.length;
    }
    const alt = tmp.join('');
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      out.push(escapeHtml(alt));
      return raw.length;
    }
    out.push('<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(alt) + '"'
      + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>');
    return raw.length;
  }
  const tmp = [];
  renderInline(text, links, tmp, ctx, labelParen, flat);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;
  if (textHasLink) {
    ctx.inRawBlock = outerInRawBlock;
    return 0;
  }
  ctx.linkEmitted = true;
  if (flat) {
    for (const s of tmp) out.push(s);
    return raw.length;
  }
  const parsedText = tmp.join('');
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    out.push(parsedText);
    return raw.length;
  }
  out.push('<a href="' + escapeHtml(cleanHref) + '"'
    + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + parsedText + '</a>');
  return raw.length;
}

function tryLink(src, links, out, ctx, paren, flat) {
  if (paren === false) return 0;
  const cap = INLINE.link.exec(src);
  if (!cap) return 0;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return 0;
  const trimmedUrl = cap[2].trim();
  if (START_ANGLE.test(trimmedUrl)) {
    if (!END_ANGLE.test(trimmedUrl)) return 0;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return 0;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return 0;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return 0;
  const href = cap[2].trim();
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  return emitLink(
    cap,
    (START_ANGLE.test(href) ? href.slice(1, -1) : href).replace(INLINE.anyPunctuation, '$1'),
    title.replace(INLINE.anyPunctuation, '$1'),
    cap[0],
    links, out, ctx, paren, flat,
  );
}

// Returns the raw length consumed, -1 when the reference is unknown and
// only the opening character is plain text, or 0 when nothing matches.
function tryReflink(src, links, out, ctx, paren, flat) {
  const cap = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (!cap) return 0;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return 0;
  const link = links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    if (flat) out.push(ch);
    else out.push(escapeHtml(ch));
    return -1;
  }
  return emitLink(cap, link.href, link.title, cap[0], links, out, ctx, paren, flat);
}

function tryEmStrong(src, runSrc, maskBox, links, out, ctx, paren, flat, prevChar) {
  const match = INLINE.emStrongLDelim.exec(src);
  if (!match) return 0;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return 0;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = runSrc.length - src.length;
  // The delimiter run may reach back into text already consumed. The mask
  // can only blank delimiters out, never invent one, so when the character
  // before this run is not the delimiter the run starts here and the
  // previous character can be read from the run itself.
  let runStart;
  let runPrevChar;
  let runPrevPunct;
  if (srcStart === 0 || runSrc[srcStart - 1] !== delimChar) {
    runStart = srcStart;
    runPrevChar = lastChar(runSrc, srcStart);
    runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || INLINE.punctuation.exec(runPrevChar) !== null;
  } else {
    if (!maskBox.cur) maskBox.cur = buildMaskFull(runSrc, links);
    const masked = maskBox.cur.m;
    runStart = srcStart;
    while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
    runPrevChar = lastChar(masked, runStart);
    runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || INLINE.punctuation.exec(runPrevChar) !== null;
  }
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : INLINE.punctuation.exec(prevChar) !== null;
  if (match[4] && prevChar.match(UNICODE_ALNUM)) return 0;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    if (!maskBox.cur) maskBox.cur = buildMaskFull(runSrc, links);
    const masked = maskBox.cur.m;
    const lLength = codePointsMinusOne(match[0]);
    let delimTotal = lLength;
    let midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = runPrevChar.trim() !== '' && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return 0;
    const endReg = delimChar === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastIdx = delimChar === '*' ? maskBox.cur.ast : maskBox.cur.und;
    const windowStart = masked.length - src.length + lLength;
    if (lastIdx < windowStart) return 0;
    const clipped = masked.slice(-src.length + lLength);
    const lastInWindow = lastIdx - windowStart;
    endReg.lastIndex = 0;
    let m;
    while ((m = endReg.exec(clipped)) !== null) {
      if (m.index > lastInWindow) break;
      const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      const rLength = rDelim.length;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      } else if (m[5] || m[6] || openerCanClose) {
        if (midRun && (m[5] || m[6])) break;
        if (runLength % 3 !== 0 && (runLength + rLength) % 3 === 0) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      const rLen = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = firstCharLength(m[0]);
      const raw = src.slice(0, lLength + m.index + lastCharLength + rLen);
      if (Math.min(lLength, rLen) % 2 === 1) {
        const text = raw.slice(1, -1);
        if (flat) {
          renderInline(text, links, out, ctx, paren && text.indexOf(')') !== -1, true);
        } else {
          out.push('<em>');
          renderInline(text, links, out, ctx, paren && text.indexOf(')') !== -1, false);
          out.push('</em>');
        }
        return raw.length;
      }
      const text = raw.slice(2, -2);
      if (flat) {
        renderInline(text, links, out, ctx, paren && text.indexOf(')') !== -1, true);
      } else {
        out.push('<strong>');
        renderInline(text, links, out, ctx, paren && text.indexOf(')') !== -1, false);
        out.push('</strong>');
      }
      return raw.length;
    }
  }
  return 0;
}

function tryDel(src, runSrc, maskBox, links, out, ctx, paren, flat, prevChar) {
  const match = INLINE.delLDelim.exec(src);
  if (!match) return 0;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || INLINE.punctuation.exec(prevChar) !== null) {
    if (!maskBox.cur) maskBox.cur = buildMaskFull(runSrc, links);
    const masked = maskBox.cur.m;
    const lLength = codePointsMinusOne(match[0]);
    let delimTotal = lLength;
    const endReg = INLINE.delRDelim;
    const lastIdx = maskBox.cur.del;
    const windowStart = masked.length - src.length + lLength;
    if (lastIdx < windowStart) return 0;
    const clipped = masked.slice(-src.length + lLength);
    const lastInWindow = lastIdx - windowStart;
    endReg.lastIndex = 0;
    let m;
    while ((m = endReg.exec(clipped)) !== null) {
      if (m.index > lastInWindow) break;
      const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      const rLength = rDelim.length;
      if (rLength !== lLength) continue;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      const rLen = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = firstCharLength(m[0]);
      const raw = src.slice(0, lLength + m.index + lastCharLength + rLen);
      const text = raw.slice(lLength, -lLength);
      if (flat) {
        renderInline(text, links, out, ctx, paren && text.indexOf(')') !== -1, true);
      } else {
        out.push('<del>');
        renderInline(text, links, out, ctx, paren && text.indexOf(')') !== -1, false);
        out.push('</del>');
      }
      return raw.length;
    }
  }
  return 0;
}

function buildMaskFull(src, links) {
  // Without a bracket, backtick, angle bracket or backslash there is no
  // link, code span, tag or escape to blank out, so the mask is the run.
  if (!/[[`<\\]/.test(src)) {
    const idx = scanClosers(src);
    return { m: src, ast: idx.ast, und: idx.und, del: idx.del };
  }
  const masked = buildMask(src, links);
  const idx = scanClosers(masked);
  return { m: masked, ast: idx.ast, und: idx.und, del: idx.del };
}

// Last code point of str ending just before index end.
function lastChar(str, end) {
  if (end <= 0) return '';
  const lo = str.charCodeAt(end - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && end >= 2) {
    const hi = str.charCodeAt(end - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return str.slice(end - 2, end);
  }
  return str[end - 1];
}

// Code-point length of str, minus one when its last code point is astral.
function codePointsMinusOne(str) {
  const n = str.length;
  if (n === 0) return -1;
  const lo = str.charCodeAt(n - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && n >= 2) {
    const hi = str.charCodeAt(n - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return n - 2;
  }
  return n - 1;
}

// Unit length of the first code point of str (1, or 2 for an astral one).
function firstCharLength(str) {
  if (str.length === 0) return 0;
  const f = str.charCodeAt(0);
  if (f >= 0xD800 && f <= 0xDBFF && str.length > 1) {
    const s = str.charCodeAt(1);
    if (s >= 0xDC00 && s <= 0xDFFF) return 2;
  }
  return 1;
}

// --- plain-text scanner ---------------------------------------------------
// Marked's inline text rule is one giant pattern; this scanner finds the
// same chunk end with native indexOf searches instead. A chunk ends before
// the next `\`, `<`, `!`, `[`, backtick, `*`, `~` or `_`; before a `www.`
// autolink start, an http/https/ftp URL, an email address, or a `mailto:`
// start; or before the two spaces of a hard break. The first character (or
// backtick / tilde run) always belongs to the chunk.

const STOP_RE = /[\\<\[`*!_~]|www\.|:\/\/|@|\n|mailto:|xmpp:/g;

// Where the protocol name of a `://` at index j starts, or -1.
function protoStart(src, j) {
  const c1 = src.charCodeAt(j - 1);
  if (c1 === 115 || c1 === 83) {
    if ((src.charCodeAt(j - 2) === 112 || src.charCodeAt(j - 2) === 80)
      && (src.charCodeAt(j - 3) === 116 || src.charCodeAt(j - 3) === 84)
      && (src.charCodeAt(j - 4) === 116 || src.charCodeAt(j - 4) === 84)
      && (src.charCodeAt(j - 5) === 104 || src.charCodeAt(j - 5) === 72)) return j - 5;
    return -1;
  }
  if (c1 === 112 || c1 === 80) {
    if (src.charCodeAt(j - 2) === 116 || src.charCodeAt(j - 2) === 84) {
      if ((src.charCodeAt(j - 3) === 116 || src.charCodeAt(j - 3) === 84)
        && (src.charCodeAt(j - 4) === 104 || src.charCodeAt(j - 4) === 72)) return j - 4;
      if (src.charCodeAt(j - 3) === 102 || src.charCodeAt(j - 3) === 70) return j - 3;
    }
    return -1;
  }
  return -1;
}

function scanText(src) {
  const c0 = src.charCodeAt(0);
  let p;
  if (c0 === 96) {
    p = 1;
    while (src.charCodeAt(p) === 96) p++;
  } else if (c0 === 126) {
    p = 1;
    while (src.charCodeAt(p) === 126) p++;
  } else {
    p = 1;
  }
  if (p === 1 && !isAlnum(c0) && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) {
    return 1;
  }
  STOP_RE.lastIndex = p;
  let m;
  while ((m = STOP_RE.exec(src)) !== null) {
    const j = m.index;
    const hit = m[0];
    if (hit.length === 1) {
      const hc = hit.charCodeAt(0);
      if (hc === 64) {
        // '@': an email may start at the local run before it.
        let r = j;
        while (r > 0 && isLocal(src.charCodeAt(r - 1))) r--;
        if (r < j) return r < p ? p : r;
      } else if (hc === 10) {
        // newline: a hard break's spaces end the chunk before them.
        let q = j;
        while (q > 0 && src.charCodeAt(q - 1) === 32) q--;
        if (j - q >= 2) {
          if (q === 0) {
            if (p === 1 && j >= 3) return 1;
          } else {
            return q;
          }
        }
      } else {
        return j;
      }
    } else if (hit === 'www.') {
      if (j === 0 || /[\s*_~(]/.test(src[j - 1])) return j;
    } else if (hit === '://') {
      const st = protoStart(src, j);
      if (st !== -1 && st >= p) return st;
    } else if (j - 1 >= p && !isAlnum(src.charCodeAt(j - 1))) {
      // mailto: or xmpp:, preceded by a non-alphanumeric character.
      return j;
    }
  }
  return src.length;
}

// --- inline renderer ------------------------------------------------------

function renderInline(src, links, out, ctx, paren, flat) {
  const runSrc = src;
  const maskBox = { cur: null };
  let prevChar = '';
  let keepPrev = false;
  while (src.length !== 0) {
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    const c0 = src.charCodeAt(0);
    let n = 0;
    if (c0 === 92) {
      n = tryEscape(src, out, flat);
      if (n === 0) n = tryBr(src, out, flat);
    } else if (c0 === 60) {
      n = tryTag(src, out, ctx);
      if (n === 0) n = tryAutolink(src, out, flat);
    } else if (c0 === 91 || c0 === 33) {
      n = tryLink(src, links, out, ctx, paren, flat);
      if (n === 0) {
        const r = tryReflink(src, links, out, ctx, paren, flat);
        if (r === -1) {
          const ch = src.charAt(0);
          if (ch !== '_') prevChar = ch;
          keepPrev = true;
          src = src.slice(1);
          continue;
        }
        n = r;
      }
    } else if (c0 === 42 || c0 === 95) {
      n = tryEmStrong(src, runSrc, maskBox, links, out, ctx, paren, flat, prevChar);
      if (n === 0 && c0 === 95 && !ctx.inLink) n = tryUrl(src, out, flat);
    } else if (c0 === 96) {
      n = tryCodespan(src, out, flat);
    } else if (c0 === 32) {
      n = tryBr(src, out, flat);
    } else if (c0 === 126) {
      n = tryDel(src, runSrc, maskBox, links, out, ctx, paren, flat, prevChar);
    } else if (!ctx.inLink && (isAlnum(c0) || c0 === 46 || c0 === 95 || c0 === 43 || c0 === 45)) {
      n = tryUrl(src, out, flat);
    }
    if (n !== 0) {
      src = src.slice(n);
      continue;
    }
    const chunkLen = scanText(src);
    const chunk = src.slice(0, chunkLen);
    if (ctx.inRawBlock) {
      out.push(chunk);
    } else if (flat) {
      out.push(chunk.indexOf('&') === -1 ? chunk : decodeNumeric(chunk));
    } else {
      const decoded = chunk.indexOf('&') === -1 ? chunk : decodeNumeric(chunk);
      out.push(escapeHtml(decoded));
    }
    if (chunk.charAt(chunk.length - 1) !== '_') prevChar = chunk.charAt(chunk.length - 1);
    keepPrev = true;
    src = src.slice(chunkLen);
  }
}

// --- block renderer -------------------------------------------------------
// Walks the block tokens marked's Lexer produced and emits HTML directly.
// Inline runs are rendered from each token's text; the token's own inline
// token array stays empty, except for the checkbox a loose task list tucks
// into its first paragraph, which is handled below.

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderInlineToken(tok, links, out, ctx) {
  ctx.inRawBlock = false;
  const inner = tok.tokens;
  let text = tok.text;
  if (inner && inner.length > 0 && inner[0].type === 'checkbox') {
    out.push(checkboxHtml(inner[0].checked));
    text = text.slice(inner[0].raw.length);
  }
  renderInline(text, links, out, ctx, text.indexOf(')') !== -1, false);
}

function renderBlocks(tokens, links, out, ctx) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'heading':
        out.push('<h', String(tok.depth), '>');
        ctx.inRawBlock = false;
        renderInline(tok.text, links, out, ctx, tok.text.indexOf(')') !== -1, false);
        out.push('</h', String(tok.depth), '>\n');
        break;
      case 'code': {
        const langString = (tok.lang || '').match(NOT_SPACE_START)?.[0] || '';
        const code = tok.text ? tok.text.replace(ENDING_NEWLINE, '') + '\n' : '';
        if (!langString) {
          out.push('<pre><code>' + escapeHtml(code, true) + '</code></pre>\n');
        } else {
          out.push('<pre><code class="language-' + escapeHtml(langString) + '">'
            + escapeHtml(code, true) + '</code></pre>\n');
        }
        break;
      }
      case 'table': {
        let header = '';
        for (const cell of tok.header) header += tableCell(cell, links, ctx);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += tableCell(cell, links, ctx);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out.push('<table>\n<thead>\n<tr>\n' + header + '</tr>\n</thead>\n' + body + '</table>\n');
        break;
      }
      case 'blockquote':
        out.push('<blockquote>\n');
        renderBlocks(tok.tokens, links, out, ctx);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const type = tok.ordered ? 'ol' : 'ul';
        const startAttr = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out.push('<' + type + startAttr + '>\n');
        for (const item of tok.items) {
          out.push('<li>');
          renderBlocks(item.tokens, links, out, ctx);
          out.push('</li>\n');
        }
        out.push('</' + type + '>\n');
        break;
      }
      case 'checkbox':
        out.push(checkboxHtml(tok.checked));
        break;
      case 'html':
        out.push(tok.text);
        break;
      case 'paragraph':
        out.push('<p>');
        renderInlineToken(tok, links, out, ctx);
        out.push('</p>\n');
        break;
      case 'text':
        renderInlineToken(tok, links, out, ctx);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
}

function tableCell(cell, links, ctx) {
  const parts = [];
  const type = cell.header ? 'th' : 'td';
  parts.push(cell.align ? '<' + type + ' align="' + cell.align + '">' : '<' + type + '>');
  ctx.inRawBlock = false;
  renderInline(cell.text, links, parts, ctx, cell.text.indexOf(')') !== -1, false);
  parts.push('</' + type + '>\n');
  return parts.join('');
}

// --- entry point ----------------------------------------------------------

const lexer = new Lexer();

export function parse(markdown) {
  let src = markdown;
  if (src.includes('\r')) src = src.replace(CARRIAGE_RETURN, '\n');
  const toks = lexer.tokens;
  toks.length = 0;
  toks.links = Object.create(null);
  lexer.inlineQueue.length = 0;
  lexer.blockTokens(src, toks);
  const links = toks.links;
  const ctx = { inLink: false, inRawBlock: false, linkEmitted: false };
  const out = [];
  renderBlocks(toks, links, out, ctx);
  lexer.inlineQueue.length = 0;
  return out.join('');
}
