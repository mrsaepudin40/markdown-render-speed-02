// parse.js — a fast drop-in for marked 18.1.3 (defaults: gfm on, breaks off).
//
// The block structure comes from marked's own Lexer, run for block tokens
// only; the inline rendering is a fresh engine written for this entry that
// walks each inline run once and appends HTML strings directly, instead of
// building inline token objects and walking them again. marked's own inline
// regular expressions are reused through one throwaway Lexer instance that
// lexes nothing, and the helper behaviours (escaping, URL cleaning, numeric
// reference decoding, label folding, bracket search) are ported here so the
// output matches marked code unit for code unit.
//
// Nothing is cached between calls: every parse starts from a fresh Lexer and
// fresh inline state, so one case can never leak into the next.

import { Lexer } from './vendor/marked/marked.esm.js';

// The rule sets of a Lexer that never lexes: block is the gfm block grammar,
// inline the gfm inline grammar, other the shared small patterns. The
// underlying regular expressions are marked's own, shared module-wide.
const RULES = new Lexer().tokenizer.rules;
const IL = RULES.inline;
const OT = RULES.other;

// The characters an email address may hold, for the text scan's email stops.
const EMAIL_CHARS = new Uint8Array(128);
for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&\'*+/=?^_`{|}~-') {
  EMAIL_CHARS[ch.charCodeAt(0)] = 1;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape the five HTML characters of `html`. With `encode`, every `&`
 * becomes `&amp;`; without it, an `&` that already starts a character
 * reference or a named entity is left alone.
 */
function escapeHtmlEntities(html, encode) {
  if (encode) {
    return OT.escapeTest.test(html) ? html.replace(OT.escapeReplace, (ch) => ESCAPES[ch]) : html;
  }
  return OT.escapeTestNoEncode.test(html) ? html.replace(OT.escapeReplaceNoEncode, (ch) => ESCAPES[ch]) : html;
}

/**
 * Turn the numeric character references of `text` into the characters they
 * name. A reference that is zero, out of range, or a surrogate becomes the
 * replacement character, and a decoded `&` is escaped so it cannot join its
 * neighbours into a new reference.
 */
function decodeNumericCharacterReferences(text) {
  if (!OT.numericCharacterReference.test(text)) return text;
  return text.replace(OT.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

/**
 * Encode a link destination for an href or src attribute. A destination
 * that cannot be encoded is not a link at all.
 */
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(OT.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

/**
 * Fold a link label so definitions and references compare equal: trim it,
 * collapse inner whitespace to one space, and fold case through upper case
 * (so `ẞ` meets `SS`, which a single lower-casing never does).
 */
function normalizeLabel(label) {
  return label.trim().replace(OT.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/**
 * Where the bracket pair in `str` closes, or -1 when it never does and -2
 * when it opens more than it closes. A backslash skips the next character.
 */
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
  return level > 0 ? -2 : -1;
}

/**
 * Strip a suffix of `c` characters from `str` (or, with `invert`, a suffix
 * of characters that are not `c`).
 */
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

/**
 * Split a table row on its unescaped pipes, dropping an empty first or last
 * cell, padding or trimming to `count` cells, and trimming each cell.
 */
function splitCells(tableRow, count) {
  const row = tableRow.replace(OT.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(OT.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(OT.slashPipe, '|');
  }
  return cells;
}

/**
 * The last delimiter run in a masked inline source that can close
 * emphasis, strong, or strikethrough: a run whose character before it is
 * not ASCII whitespace, and not at the start. The scan walks backward from
 * the end and stops at the first such run, so a run that holds a closer
 * near its end costs almost nothing. Returns the run's start index, or -1.
 * The scan is lazy: it runs only when an opener for that delimiter is
 * actually attempted in the run.
 */
function lastCloser(src, delimChar) {
  let i = src.length - 1;
  while (i >= 0) {
    if (src[i] !== delimChar) { i--; continue; }
    let start = i;
    while (start > 0 && src[start - 1] === delimChar) start--;
    if (start > 0) {
      const prev = src[start - 1];
      if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
        return start;
      }
    }
    i = start - 1;
  }
  return -1;
}

/**
 * Whether `text` holds a link already. An image does not count: an image
 * may hold a link, a link may not.
 */
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(IL.blockSkip)) {
    if (IL.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(IL.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

/**
 * A length-preserving mask of an inline run that hides code spans, links,
 * escapes and raw HTML from emphasis and strikethrough pairing, so a
 * delimiter inside one of them can never pair. Every replacement keeps the
 * length it replaces, so the mask lines up with the source by index.
 */
function maskSrc(src, links) {
  let masked = src;
  if (links && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, links)) {
          return '[' + text.replace(IL.reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(IL.reflinkSearch, maskReflink);
  }
  masked = masked.replace(IL.anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  masked = masked.replace(IL.blockSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return masked;
}

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isEmailCode(c) {
  return c < 128 && EMAIL_CHARS[c] === 1;
}

function isWwwPrev(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
    || ch === '*' || ch === '_' || ch === '~' || ch === '(';
}

/** Two or more spaces starting at `i`, then a newline. */
function twoSpacesNewline(s, i) {
  if (s[i] !== ' ' || s[i + 1] !== ' ') return false;
  let j = i + 2;
  while (s[j] === ' ') j++;
  return s[j] === '\n';
}

/** Where the first http://, https:// or ftp:// starts, or -1. */
function protocolSlashPos(s) {
  let p = s.indexOf('://');
  while (p !== -1) {
    if (s.slice(Math.max(0, p - 5), p).toLowerCase() === 'https') return p - 5;
    if (s.slice(Math.max(0, p - 4), p).toLowerCase() === 'http') return p - 4;
    if (s.slice(Math.max(0, p - 4), p).toLowerCase() === 'ftp') return p - 4;
    p = s.indexOf('://', p + 3);
  }
  return -1;
}

/** Where the first www. that starts an autolink stands, or -1. */
function wwwPos(s) {
  let w = s.indexOf('www.');
  while (w !== -1) {
    if (w === 0 || isWwwPrev(s[w - 1])) return w;
    w = s.indexOf('www.', w + 1);
  }
  return -1;
}

/**
 * Whether an email-character run holding an at-sign starts at `i`: at least
 * one email character, then an at-sign.
 */
function emailRunAt(s, i) {
  if (i >= s.length || !isEmailCode(s.charCodeAt(i))) return false;
  let j = i + 1;
  while (j < s.length && isEmailCode(s.charCodeAt(j))) j++;
  return j < s.length && s[j] === '@';
}

/** Where the first mailto: or xmpp: stands, or -1. Only used when the run holds an at-sign. */
function mailtoPos(s, hasAt) {
  if (!hasAt) return -1;
  const m = s.indexOf('mailto:');
  const x = s.indexOf('xmpp:');
  if (m === -1) return x;
  if (x === -1) return m;
  return Math.min(m, x);
}

/**
 * Where the plain-text run starting at the head of `rest` ends, as marked's
 * inline text pattern would end it. The run stops at a backslash, an angle
 * bracket, a bang, an open bracket, a backtick, a star, a tilde or an
 * underscore, at two or more spaces before a newline, at a protocol prefix,
 * at a www prefix after a start, a space or a delimiter, and at an
 * email-character run holding an at-sign. `hasAt` is the run's one at-sign
 * search: without an at-sign the email stops can never fire. The loop works
 * on character codes and inlines its stops, so a long run of prose costs
 * almost nothing per character.
 */
function scanText(rest, hasAt) {
  const mp = mailtoPos(rest, hasAt);
  if (mp === 1 && !isAlnumCode(rest.charCodeAt(0))) return 1;
  let i;
  const c0 = rest.charCodeAt(0);
  if (c0 === 96 || c0 === 126) {
    i = 1;
    while (i < rest.length && rest.charCodeAt(i) === c0) i++;
  } else {
    i = 1;
  }
  if (twoSpacesNewline(rest, i)) return i;
  if (hasAt && emailRunAt(rest, i)) return i;
  const ps = protocolSlashPos(rest);
  const wp = wwwPos(rest);
  const len = rest.length;
  for (let j = i; j < len; j++) {
    const ch = rest.charCodeAt(j);
    // Stop characters: \ < ! [ ` * ~ _
    if (ch === 92 || ch === 60 || ch === 33 || ch === 91 || ch === 96 || ch === 42 || ch === 126 || ch === 95) return j;
    if (j === ps || j === wp) return j;
    // Two or more spaces before a newline end the run at the first space.
    if (ch !== 32 && rest.charCodeAt(j + 1) === 32 && rest.charCodeAt(j + 2) === 32 && twoSpacesNewline(rest, j + 1)) return j + 1;
    if (mp !== -1 && j === mp - 1 && !isAlnumCode(ch)) return mp;
    if (hasAt && !isEmailCode(ch) && emailRunAt(rest, j + 1)) return j + 1;
  }
  return len;
}

/**
 * Emit a plain-text run. Inside a raw block the text is kept as written;
 * elsewhere a numeric character reference stands for the character itself,
 * and the result is escaped, unless the run is rendered as plain text (an
 * image's alt text), where it is left unescaped for the caller to escape
 * once at the end.
 */
function emitText(raw, st, out, plain) {
  const t = st.inRawBlock ? raw : decodeNumericCharacterReferences(raw);
  if (plain || st.inRawBlock) out.push(t);
  else out.push(escapeHtmlEntities(t));
}

/**
 * Whether a link label ends inside a token: a `<` in the label that opens a
 * tag or an autolink running past the label's end means the label is not a
 * label at all.
 */
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = IL.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = IL.tag.exec(tokenSrc) || IL.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

/**
 * Render a link or image once its destination is known. The label is
 * rendered as a nested inline run, in plain-text mode for an image (its
 * label becomes the alt text) and in the run's own mode for a link. A link
 * whose label already holds a link is not a link: it bails so the caller
 * falls through to text and the inner link is the one kept. Returns the
 * HTML or plain text to emit, or null when it bails.
 */
function outputLink(cap, link, raw, ctx, plain) {
  const st = ctx.st;
  const text = cap[1].replace(OT.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const labelPlain = plain || isImage;
  const outerInLink = st.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const label = inlineNested(text, ctx, labelPlain);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      st.inRawBlock = outerInRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }
  if (plain) return label;
  const href = link.href;
  const title = link.title || null;
  if (!isImage) {
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return label;
    let out = '<a href="' + escapeHtmlEntities(cleanHref) + '"';
    if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
    return out + '>' + label + '</a>';
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return escapeHtmlEntities(label);
  let out = '<img src="' + escapeHtmlEntities(cleanHref) + '" alt="' + escapeHtmlEntities(label) + '"';
  if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
  return out + '>';
}

/**
 * An inline link or image `[text](destination "title")`, or null. The
 * destination is trimmed of balanced parentheses and a trailing escaped
 * closing paren is destination text, not the closer.
 */
function tryLink(rest, ctx, plain) {
  const st = ctx.st;
  if (st.linkParenPossible === false) return null;
  const cap = IL.link.exec(rest);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (OT.startAngleBracket.test(trimmedUrl)) {
    if (!OT.endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (OT.startAngleBracket.test(href)) {
    href = href.slice(1, -1);
  }
  const html = outputLink(cap, {
    href: href ? href.replace(IL.anyPunctuation, '$1') : href,
    title: title ? title.replace(IL.anyPunctuation, '$1') : title,
  }, cap[0], ctx, plain);
  if (html === null) return null;
  return { html, len: cap[0].length };
}

/**
 * A reference link or image `[text][label]` or `[label]`, or null. When the
 * label names no definition, only its first character is plain text.
 */
function tryReflink(rest, ctx, plain) {
  const cap = IL.reflink.exec(rest) || IL.nolink.exec(rest);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;
  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    return { text: cap[0].charAt(0), len: 1 };
  }
  const html = outputLink(cap, link, cap[0], ctx, plain);
  if (html === null) return null;
  return { html, len: cap[0].length };
}

/**
 * An emphasis or strong span starting at the head of `rest`, or null.
 * `masked` is the run's masked source and `lastPossible` the last run of
 * this delimiter that can close; the opener is found against the mask so
 * delimiters inside code, links and HTML never pair, and the rule of three
 * keeps a run from closing against a delimiter that would steal a later
 * opener.
 */
function tryEmStrong(rest, masked, lastPossible, prevChar, ctx, plain) {
  let match = IL.emStrongLDelim.exec(rest);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = masked.length - rest.length;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!IL.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!IL.punctuation.exec(prevChar);
  if (match[4] && prevChar.match(OT.unicodeAlphaNumeric)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? IL.emStrongRDelimAst : IL.emStrongRDelimUnd;
    const windowStart = masked.length - rest.length + lLength;
    if (lastPossible < windowStart) return null;
    const windowMasked = masked.slice(-1 * rest.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(windowMasked)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rest.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        return { tag: 'em', text: raw.slice(1, -1), len: raw.length };
      }
      return { tag: 'strong', text: raw.slice(2, -2), len: raw.length };
    }
  }
  return null;
}

/**
 * A strikethrough span starting at the head of `rest`, or null. Only one
 * or two tildes open and close, and the closer must use the same count.
 */
function tryDel(rest, masked, lastPossible, prevChar, ctx, plain) {
  let match = IL.delLDelim.exec(rest);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || IL.punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = IL.delRDelim;
    const windowStart = masked.length - rest.length + lLength;
    if (lastPossible < windowStart) return null;
    const windowMasked = masked.slice(-1 * rest.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(windowMasked)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rest.slice(0, lLength + match.index + lastCharLength + rLength);
      return { tag: 'del', text: raw.slice(lLength, -lLength), len: raw.length };
    }
  }
  return null;
}

/** Whether `ch` can start an extended autolink: a letter, a digit, or one of . _ + -. */
function isUrlStart(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 46 || c === 95 || c === 43 || c === 45;
}

/**
 * The HTML for an autolink or an extended autolink, or its bare text in
 * plain-text mode (an image's alt text). A destination that cannot be
 * encoded leaves only the text.
 */
function autolinkHtml(text, href, plain) {
  if (plain) return text;
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return escapeHtmlEntities(text, true);
  return '<a href="' + escapeHtmlEntities(cleanHref, true) + '">' + escapeHtmlEntities(text, true) + '</a>';
}

/**
 * Render an inline run that a link label or an emphasis span holds. It
 * shares the outer run's link and raw-block state and restores the
 * paren flag when it returns, but it never resets the raw-block flag.
 */
function inlineNested(src, ctx, plain) {
  const out = [];
  inlineRun(src, ctx, out, plain);
  return out.join('');
}

/**
 * Render a top-level inline run: a heading, a paragraph, a table cell, or
 * a block of text. A raw block left open by an earlier run ends here.
 */
function inlineTop(src, ctx) {
  ctx.st.inRawBlock = false;
  const out = [];
  inlineRun(src, ctx, out, false);
  return out.join('');
}

/**
 * Walk one inline run once, appending HTML to `out`. The order is marked's:
 * backslash escape, tag, link, reference link, emphasis, code span, hard
 * break, strikethrough, autolink, extended autolink, then plain text. The
 * mask and the closer scan are built lazily, only when an emphasis or
 * strikethrough opener is actually attempted. `plain` renders as an image's
 * alt text does: no tags, no escaping, the caller escapes once at the end.
 */
function inlineRun(src, ctx, out, plain) {
  const st = ctx.st;
  const prevParen = st.linkParenPossible;
  st.linkParenPossible = prevParen && src.includes(')');
  const hasAt = src.includes('@');
  let masked = null;
  const closerCache = { '*': undefined, '_': undefined, '~': undefined };
  const ensureMask = () => {
    if (masked === null) masked = maskSrc(src, ctx.links);
  };
  const closerFor = (delim) => {
    if (closerCache[delim] === undefined) closerCache[delim] = lastCloser(masked, delim);
    return closerCache[delim];
  };
  let rest = src;
  let keepPrevChar = false;
  let prevChar = '';
  while (rest) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const c0 = rest[0];
    let m;
    if (c0 === '\\' && (m = IL.escape.exec(rest))) {
      out.push(plain ? m[1] : escapeHtmlEntities(m[1]));
      rest = rest.slice(m[0].length);
      continue;
    }
    if (c0 === '<' && (m = IL.tag.exec(rest))) {
      if (!st.inLink && OT.startATag.test(m[0])) st.inLink = true;
      else if (st.inLink && OT.endATag.test(m[0])) st.inLink = false;
      if (!st.inRawBlock && OT.startPreScriptTag.test(m[0])) st.inRawBlock = true;
      else if (st.inRawBlock && OT.endPreScriptTag.test(m[0])) st.inRawBlock = false;
      out.push(m[0]);
      rest = rest.slice(m[0].length);
      continue;
    }
    if ((c0 === '[' || c0 === '!') && (m = tryLink(rest, ctx, plain))) {
      out.push(m.html);
      rest = rest.slice(m.len);
      continue;
    }
    if ((c0 === '[' || c0 === '!') && (m = tryReflink(rest, ctx, plain))) {
      if (m.html !== undefined) {
        out.push(m.html);
        rest = rest.slice(m.len);
      } else {
        emitText(m.text, st, out, plain);
        rest = rest.slice(1);
      }
      continue;
    }
    if (c0 === '*' || c0 === '_') {
      ensureMask();
      const em = tryEmStrong(rest, masked, closerFor(c0), prevChar, ctx, plain);
      if (em) {
        const inner = inlineNested(em.text, ctx, plain);
        if (!plain) out.push(em.tag === 'em' ? '<em>' : '<strong>');
        out.push(inner);
        if (!plain) out.push(em.tag === 'em' ? '</em>' : '</strong>');
        rest = rest.slice(em.len);
        continue;
      }
    }
    if (c0 === '`' && (m = IL.code.exec(rest))) {
      let text = m[2].replace(OT.newLineCharGlobal, ' ');
      const hasNonSpace = OT.nonSpaceChar.test(text);
      const hasSpaceBothEnds = OT.startingSpaceChar.test(text) && OT.endingSpaceChar.test(text);
      if (hasNonSpace && hasSpaceBothEnds) text = text.substring(1, text.length - 1);
      out.push(plain ? text : '<code>' + escapeHtmlEntities(text, true) + '</code>');
      rest = rest.slice(m[0].length);
      continue;
    }
    if ((c0 === ' ' || c0 === '\\') && (m = IL.br.exec(rest))) {
      if (!plain) out.push('<br>');
      rest = rest.slice(m[0].length);
      continue;
    }
    if (c0 === '~') {
      ensureMask();
      const d = tryDel(rest, masked, closerFor('~'), prevChar, ctx, plain);
      if (d) {
        const inner = inlineNested(d.text, ctx, plain);
        if (!plain) out.push('<del>');
        out.push(inner);
        if (!plain) out.push('</del>');
        rest = rest.slice(d.len);
        continue;
      }
    }
    if (c0 === '<' && (m = IL.autolink.exec(rest))) {
      const text = m[1];
      const href = m[2] === '@' ? 'mailto:' + text : text;
      out.push(autolinkHtml(text, href, plain));
      rest = rest.slice(m[0].length);
      continue;
    }
    if (!st.inLink && isUrlStart(c0) && (m = IL.url.exec(rest))) {
      let text, href;
      if (m[2] === '@') {
        text = m[0];
        href = 'mailto:' + text;
      } else {
        let prevCapZero;
        do {
          prevCapZero = m[0];
          m[0] = IL._backpedal.exec(m[0])?.[0] ?? '';
        } while (prevCapZero !== m[0]);
        text = m[0];
        href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
      }
      out.push(autolinkHtml(text, href, plain));
      rest = rest.slice(m[0].length);
      continue;
    }
    const n = scanText(rest, hasAt);
    if (n > 0) {
      const raw = rest.slice(0, n);
      emitText(raw, st, out, plain);
      if (raw.charCodeAt(raw.length - 1) !== 95) prevChar = raw[raw.length - 1];
      keepPrevChar = true;
      rest = rest.slice(n);
      continue;
    }
    emitText(rest[0], st, out, plain);
    rest = rest.slice(1);
  }
  st.linkParenPossible = prevParen;
}

/** The HTML for a task-list checkbox. */
function checkboxHtml(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

/** The HTML for a fenced or indented code block. */
function codeHtml(token) {
  const langString = (token.lang || '').match(OT.notSpaceStart)?.[0];
  const code = token.text ? token.text.replace(OT.endingNewline, '') + '\n' : '';
  const body = escapeHtmlEntities(code, true);
  if (!langString) return '<pre><code>' + body + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtmlEntities(langString) + '">' + body + '</code></pre>\n';
}

/**
 * The inline HTML of a paragraph or a block of text. In a loose task list
 * marked puts the checkbox inside the first paragraph or text token and
 * prepends its raw marker to that token's text, so the marker is stripped
 * here and the checkbox is rendered inside the paragraph.
 */
function inlinePara(token, ctx) {
  const toks = token.tokens;
  if (toks && toks.length > 0 && toks[0].type === 'checkbox') {
    const cb = toks[0];
    return checkboxHtml(cb) + inlineTop(token.text.slice(cb.raw.length), ctx);
  }
  return inlineTop(token.text, ctx);
}

/** One table cell: an aligned header or body cell holding inline HTML. */
function tableCellHtml(cell, ctx) {
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + inlineTop(cell.text, ctx) + `</${type}>\n`;
}

/**
 * Walk the block tokens and append HTML to `out`. The block tokens come
 * from marked's own Lexer, so the block structure is marked's; only the
 * rendering is this entry's.
 */
function renderBlocks(tokens, ctx, out) {
  for (const token of tokens) {
    switch (token.type) {
      case 'space': {
        break;
      }
      case 'hr': {
        out.push('<hr>\n');
        break;
      }
      case 'heading': {
        out.push(`<h${token.depth}>`, inlineTop(token.text, ctx), `</h${token.depth}>\n`);
        break;
      }
      case 'code': {
        out.push(codeHtml(token));
        break;
      }
      case 'table': {
        let header = '';
        for (const cell of token.header) header += tableCellHtml(cell, ctx);
        let body = '';
        for (const row of token.rows) {
          let cells = '';
          for (const cell of row) cells += tableCellHtml(cell, ctx);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out.push('<table>\n<thead>\n<tr>\n' + header + '</tr>\n</thead>\n' + body + '</table>\n');
        break;
      }
      case 'blockquote': {
        out.push('<blockquote>\n');
        renderBlocks(token.tokens, ctx, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'list': {
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
        out.push('<' + type + startAttr + '>\n');
        for (const item of token.items) {
          out.push('<li>');
          renderBlocks(item.tokens, ctx, out);
          out.push('</li>\n');
        }
        out.push('</' + type + '>\n');
        break;
      }
      case 'checkbox': {
        out.push(checkboxHtml(token));
        break;
      }
      case 'html': {
        out.push(token.text);
        break;
      }
      case 'def': {
        break;
      }
      case 'paragraph': {
        out.push('<p>', inlinePara(token, ctx), '</p>\n');
        break;
      }
      case 'text': {
        out.push(inlinePara(token, ctx));
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
}

/**
 * The HTML marked 18.1.3 renders for `markdown` with its defaults. A fresh
 * Lexer tokenizes the blocks and a fresh inline state renders them, so one
 * call keeps nothing from an earlier one.
 */
export function parse(markdown) {
  const src = markdown.replace(OT.carriageReturn, '\n');
  const lexer = new Lexer();
  const tokens = lexer.blockTokens(src, lexer.tokens);
  const ctx = {
    links: lexer.tokens.links,
    st: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true },
  };
  const out = [];
  renderBlocks(tokens, ctx, out);
  return out.join('');
}
