// parse.js — a fast direct-emit Markdown renderer, byte-identical to marked 18.1.3
// with its default options (gfm on, breaks off, no header ids). Written from the
// CommonMark 0.31.2 and GFM 0.29 specifications and the marked reference behaviour.
// No dependency, no file reads, no state kept between calls.

// ---------- character helpers ----------
function isWS(c) { // c: code unit
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}
function isWSCh(ch) { // ch: one-character string
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
  return /\s/.test(ch);
}
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.indexOf(ch) >= 0;
  return /[\p{P}\p{S}]/u.test(ch);
}
// ASCII punctuation only — used for backslash escapes (CommonMark: only
// ASCII punctuation may be backslash-escaped).
function isAsciiPunctCh(ch) {
  return ch.charCodeAt(0) < 128 && ASCII_PUNCT.indexOf(ch) >= 0;
}
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlphaNum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// ---------- HTML escaping ----------
// escText: text run escaping. Numeric references are decoded (invalid ones become
// U+FFFD); named references (&name;) are kept as-is; any other & becomes &amp;.
function decodeNumericRef(m) {
  const hex = m.charCodeAt(2) === 120 || m.charCodeAt(2) === 88;
  const num = hex ? m.slice(3, -1) : m.slice(2, -1);
  let cp = parseInt(num, hex ? 16 : 10);
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) || Number.isNaN(cp)) cp = 0xFFFD;
  return String.fromCodePoint(cp);
}
const ESC_MAP = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escText(s) {
  if (s.indexOf('&') !== -1) {
    s = s.replace(/&#[0-9]{1,7};|&#[xX][0-9A-Fa-f]{1,6};/g, decodeNumericRef);
    s = s.replace(/&(?![A-Za-z][A-Za-z0-9]*;)/g, '&amp;');
  }
  if (/[<>"']/.test(s)) s = s.replace(/[<>"']/g, (ch) => ESC_MAP[ch]);
  return s;
}
// escRaw: unconditional escaping (code spans, code blocks).
function escRaw(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// cleanUrl: encodeURI, falling back to the raw string on lone surrogates.
function cleanUrl(u) {
  // encodeURI encodes '%' to '%25'; marked restores it so pre-existing
  // percent-encodings (and stray '%' like '%zz') pass through unchanged
  try { return encodeURI(u).replace(/%25/g, '%'); } catch { return u; }
}
function escAttr(s) { return escText(s); }
// Resolve backslash escapes (ASCII punctuation only) in a string.
function unescapeAscii(s) {
  if (s.indexOf('\\') === -1) return s;
  return s.replace(/\\(.)/g, (m, ch) => isAsciiPunctCh(ch) ? ch : m);
}

// ---------- link reference labels ----------
function normalizeLabel(s) {
  // Unicode case folding: sharp s (both cases) folds to "ss"
  return s.replace(/[\t\n ]+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

// true if s contains a '[' or ']' that is not backslash-escaped
function hasUnescapedBracket(s) {
  for (let k = 0; k < s.length; k++) {
    if (s.charCodeAt(k) === 92 && k + 1 < s.length && isAsciiPunctCh(s[k + 1])) { k++; continue; }
    if (s.charCodeAt(k) === 91 || s.charCodeAt(k) === 93) return true;
  }
  return false;
}

// true if s contains a backtick run that is not part of a valid code span:
// marked's label pattern only allows backticks inside code spans, so a
// label with a stray backtick is not a link label at all
function hasStrayBacktick(s) {
  let k = 0;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 92 && k + 1 < s.length && s[k + 1] === '`') { k += 2; continue; }
    if (c !== 96) { k++; continue; }
    // opening run: skip its backticks, then find the next run
    const runStart = k;
    while (k < s.length && s.charCodeAt(k) === 96) k++;
    // a run of 2+ backticks immediately before the closing ']' is allowed
    // (marked's label pattern has a `` `+ (?=\]) `` alternative); a single
    // trailing backtick is stray
    if (k >= s.length) { if (k - runStart < 2) return true; k = s.length; continue; }
    let j = k;
    while (j < s.length && s.charCodeAt(j) !== 96) {
      if (s.charCodeAt(j) === 92 && j + 1 < s.length && s[j + 1] === '`') j += 2;
      else j++;
    }
    if (j >= s.length) return true; // no closing run: stray
    while (j < s.length && s.charCodeAt(j) === 96) j++;
    k = j;
  }
  return false;
}

// true if s has a stray backtick run of length >= 2 (a stray single
// backtick does not block emphasis inside a failed label, a stray run
// of 2+ does — probe60 vs probe62)
function hasStrayBacktickRun2(s) {
  let k = 0;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 92 && k + 1 < s.length && s[k + 1] === '`') { k += 2; continue; }
    if (c !== 96) { k++; continue; }
    const runStart = k;
    while (k < s.length && s.charCodeAt(k) === 96) k++;
    const runLen = k - runStart;
    if (k >= s.length) { if (runLen >= 2) return true; k = s.length; continue; }
    let j = k;
    while (j < s.length && s.charCodeAt(j) !== 96) {
      if (s.charCodeAt(j) === 92 && j + 1 < s.length && s[j + 1] === '`') j += 2;
      else j++;
    }
    if (j >= s.length) { if (runLen >= 2) return true; return false; }
    while (j < s.length && s.charCodeAt(j) === 96) j++;
    k = j;
  }
  return false;
}

// ---------- inline parsing ----------
// A delimiter record: {ch, len, orig, canO, canC, piece, open[], close[], usedO, usedC, rem}
function processEmphasis(ds, src) {
  let i = 0;
  const n = ds.length;
  while (i < n) {
    const d = ds[i];
    if (!d.canC || d.rem === 0) { i++; continue; }
    let j = i - 1;
    let found = -1;
    while (j >= 0) {
      const o = ds[j];
      if (o.trapped) { j--; continue; }
      if (o.ch === d.ch && o.canO && o.rem > 0) {
        if ((o.canC || d.canO) && ((o.orig + d.orig) % 3 === 0) && !(o.orig % 3 === 0 && d.orig % 3 === 0)) { j--; continue; }
        found = j; break;
      }
      j--;
    }
    if (found === -1) { i++; continue; }
    const o = ds[found];
    const use = (o.rem >= 2 && d.rem >= 2) ? 2 : 1;
    const tag = d.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    o.open.push(tag);
    d.close.push(tag);
    o.usedO += use; d.usedC += use;
    o.rem -= use; d.rem -= use;
    // openers strictly between the matched pair are trapped inside the
    // new span: they can no longer match a closer outside it, or the
    // spans would partially overlap instead of nesting properly
    for (let k = found + 1; k < i; k++) {
      if (ds[k].canO) ds[k].trapped = true;
    }
    if (d.rem === 0) i++;
  }
}

// GFM extended autolink helpers
function isEmailLocal(c) { // code unit; local part of an extended autolink email
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45;
}
function isEmailDomain(c) { // code unit; domain label of an extended autolink email
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
}
function matchEmail(s, i, allowBacktrack) {
  const n = s.length;
  let j = i;
  if (j >= n || !isEmailLocal(s.charCodeAt(j))) return -1;
  j++;
  while (j < n && isEmailLocal(s.charCodeAt(j))) j++;
  if (j >= n || s.charCodeAt(j) !== 64) return -1; // @
  j++;
  // domain: labels separated by '.', each label starts and ends with an
  // alphanumeric char; a trailing '.' backtracks to the previous label end
  let labels = 0, lastGood = -1;
  while (j < n) {
    const c0 = s.charCodeAt(j);
    if (!((c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) break;
    while (j < n && isEmailDomain(s.charCodeAt(j))) j++;
    // A label ending in '_' backtracks to its last alphanumeric char
    // ONLY when an unmatched '_' opener is waiting (the trailing run is
    // then an emphasis closer, e.g. the '__' after a@b.com); a trailing
    // '-' never backtracks, and without an opener the email is invalid.
    let lastC = s.charCodeAt(j - 1);
    let endsAlnum = (lastC >= 48 && lastC <= 57) || (lastC >= 65 && lastC <= 90) || (lastC >= 97 && lastC <= 122);
    if (!endsAlnum) {
      if (!allowBacktrack || lastC !== 95) return -1;
      while (j > 0 && s.charCodeAt(j - 1) === 95) j--;
      lastC = s.charCodeAt(j - 1);
      endsAlnum = (lastC >= 48 && lastC <= 57) || (lastC >= 65 && lastC <= 90) || (lastC >= 97 && lastC <= 122);
      if (!endsAlnum) return -1;
    }
    labels++;
    lastGood = j;
    if (j < n && s.charCodeAt(j) === 46) { j++; continue; }
    break;
  }
  if (labels < 2) return -1;
  return lastGood;
}
const TRAIL_PUNCT = '?!,.:;*_~\'"';
// marked's GFM _backpedal regex, applied until stable: it keeps the longest
// prefix made of plain runs, balanced (...) groups, bare & and trailing
// punctuation that is not at the very end. This is what decides where an
// extended autolink URL ends (incl. the ')' rules).
const BACKPEDAL = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimUrlEnd(u) {
  let cur = u, prev;
  do {
    prev = cur;
    const m = BACKPEDAL.exec(cur);
    cur = m ? m[0] : '';
  } while (cur !== prev);
  return cur.length;
}
function matchUrlRun(s, i) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60) break; // space, tab, LF, <
    j++;
  }
  return j;
}
const WWW_PREV = new Set([' ', '\t', '\n', '\r', '(', '*', '_', '~', '[']);

// ---------- inline link destination / title ----------
function parseInlineLink(s, i) {
  const n = s.length;
  let p = i;
  while (p < n && isWS(s.charCodeAt(p))) p++;
  if (p >= n) return null;
  let dest = '';
  if (s.charCodeAt(p) === 60) { // <
    let q = p + 1;
    let buf = '';
    while (q < n) {
      const c = s.charCodeAt(q);
      if (c === 10 || c === 60) return null;
      if (c === 62) break;
      if (c === 92 && q + 1 < n && isAsciiPunctCh(s[q + 1])) { buf += s[q + 1]; q += 2; continue; }
      buf += s[q]; q++;
    }
    if (q >= n) return null;
    dest = buf; p = q + 1;
  } else {
    let q = p, depth = 0, buf = '';
    while (q < n) {
      const c = s.charCodeAt(q);
      if (c === 32 || c === 9 || c === 10 || c === 13) break;
      if (c < 32) return null;
      if (c === 40) { depth++; buf += s[q]; q++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; buf += s[q]; q++; continue;
      }
      if (c === 92 && q + 1 < n && isAsciiPunctCh(s[q + 1])) { buf += s[q + 1]; q += 2; continue; }
      buf += s[q]; q++;
    }
    if (depth !== 0) return null;
    dest = buf; p = q;
  }
  let title = null;
  let q = p;
  while (q < n && isWS(s.charCodeAt(q))) q++;
  if (q < n) {
    const qc = s.charCodeAt(q);
    if (qc === 34 || qc === 39 || qc === 40) {
      const close = qc === 40 ? 41 : qc;
      let r = q + 1, tb = '', ok = false;
      while (r < n) {
        const c = s.charCodeAt(r);
        if (c === close) { ok = true; break; }
        if (qc === 40 && c === 40) return null;
        if (c === 92 && r + 1 < n && isAsciiPunctCh(s[r + 1])) { tb += s[r + 1]; r += 2; continue; }
        tb += s[r]; r++;
      }
      if (!ok) return null;
      title = tb; q = r + 1;
      while (q < n && isWS(s.charCodeAt(q))) q++;
    }
  }
  if (q >= n || s.charCodeAt(q) !== 41) return null;
  return { dest, title, end: q + 1 };
}

// ---------- raw HTML tag matching ----------
function matchHtmlTag(s, i) {
  const n = s.length;
  if (s.charCodeAt(i) !== 60) return -1;
  // comment: ends at the first --> ('--' inside is allowed by marked)
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const k = s.indexOf('-->', i + 4);
    return k === -1 ? -1 : k + 3;
  }
  // processing instruction
  if (s.startsWith('<?', i)) {
    const k = s.indexOf('?>', i + 2);
    return k === -1 ? -1 : k + 2;
  }
  // declaration <!A
  if (s.startsWith('<!', i) && i + 2 < n) {
    const c = s.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const k = s.indexOf('>', i + 3);
      return k === -1 ? -1 : k + 1;
    }
  }
  // CDATA
  if (s.startsWith('<![CDATA[', i)) {
    const k = s.indexOf(']]>', i + 9);
    return k === -1 ? -1 : k + 3;
  }
  // closing tag
  let j = i + 1;
  let closing = false;
  if (j < n && s.charCodeAt(j) === 47) { closing = true; j++; }
  // tag name
  const nameStart = j;
  if (j >= n) return -1;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && isWS(s.charCodeAt(j))) j++;
    return (j < n && s.charCodeAt(j) === 62) ? j + 1 : -1;
  }
  // attributes: each attribute must be preceded by whitespace
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) return j + 1;
    if (c === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2;
    if (!isWS(c)) return -1;
    while (j < n && isWS(s.charCodeAt(j))) j++;
    if (j >= n) return -1;
    const d0 = s.charCodeAt(j);
    if (d0 === 62) return j + 1;
    if (d0 === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2;
    // attribute name
    if (!((d0 >= 65 && d0 <= 90) || (d0 >= 97 && d0 <= 122) || d0 === 95 || d0 === 58)) return -1;
    j++;
    while (j < n) {
      const d = s.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 45 || d === 46) j++;
      else break;
    }
    const nameEnd = j;
    // optional = value (whitespace allowed around =); if there is no '=',
    // leave j right after the name so the loop top sees the whitespace
    let k = j;
    while (k < n && isWS(s.charCodeAt(k))) k++;
    if (k < n && s.charCodeAt(k) === 61) { // =
      j = k + 1;
      while (j < n && isWS(s.charCodeAt(j))) j++;
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && s.charCodeAt(j) !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        if (j < n) {
          const d = s.charCodeAt(j);
          if (d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) return -1;
        }
        while (j < n) {
          const d = s.charCodeAt(j);
          if (isWS(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          j++;
        }
      }
    } else {
      j = nameEnd;
    }
  }
  return -1;
}

// ---------- the inline parser ----------
// Whether an <a> tag is currently open (never closed): while true, the
// extended autolinks (www / scheme / email) are suppressed, matching
// marked's lexer state.inLink. Reset at the start of each parse().
let inLink = false;
function inlineParse(src, refs) {
  const n = src.length;
  const out = []; // pieces: string | {a,t,cancelled} autolink | {h,alt} image
  const delims = []; // active delimiter records
  const allDelims = []; // every delimiter record, for the final rebuild
  const brackets = [];
  // Is there an ACTIVE bracket? Extended autolinks are suppressed inside
  // link text (an active '['), but NOT after an inner link deactivated
  // the outer brackets (those are literal text, autolinks form normally).
  const hasActiveBracket = () => {
    for (let k = 0; k < brackets.length; k++) if (brackets[k].active) return true;
    return false;
  };
  // Is there an unmatched '_' opener waiting? If so, a trailing '_' run
  // after an email domain is its closer (backtrack allowed in matchEmail).
  const hasOpenUnderscore = () => {
    for (let k = 0; k < delims.length; k++) {
      const d = delims[k];
      if (d.ch === '_' && d.canO && d.rem > 0) return true;
    }
    return false;
  };
  let i = 0;
  let ts = 0;
  const flush = (to) => { if (to > ts) out.push(escText(src.slice(ts, to))); ts = to; };

  function rebuildDelim(d) {
    // a run's used delimiters hug the content: closers take the leading
    // chars, openers the trailing chars; leftovers sit in the middle
    let s = '';
    for (let k = 0; k < d.close.length; k++) s += '</' + d.close[k] + '>';
    s += d.ch.repeat(d.rem);
    for (let k = d.open.length - 1; k >= 0; k--) s += '<' + d.open[k] + '>';
    out[d.piece] = s;
  }

  function addDelim(ch, start, len) {
    const before = start > 0 ? src[start - 1] : '';
    const after = start + len < n ? src[start + len] : '';
    const beforeWS = start === 0 || isWSCh(before);
    const afterWS = start + len >= n || isWSCh(after);
    const beforeP = start > 0 && isPunctCh(before);
    const afterP = start + len < n && isPunctCh(after);
    const leftF = !afterWS && (!afterP || beforeWS || beforeP);
    const rightF = !beforeWS && (!beforeP || afterWS || afterP);
    let canO, canC;
    if (ch === '_') {
      canO = leftF && (!rightF || beforeP);
      canC = rightF && (!leftF || afterP);
    } else {
      canO = leftF; canC = rightF;
    }
    if (!canO && !canC) return false;
    const piece = out.length;
    out.push(src.slice(start, start + len));
    const d = { ch, len, orig: len, canO, canC, piece, open: [], close: [], usedO: 0, usedC: 0, rem: len, cleared: false, trapped: false, start, end: start + len };
    delims.push(d);
    allDelims.push(d);
    return true;
  }

  // resolve a link/image for bracket b (already popped by the ] handler)
  function resolveLink(b) {
    const labelText = src.slice(b.textStart, i);
    if (hasStrayBacktick(labelText)) return null;
    let dest = null, title = null, end = -1;
    if (i + 1 < n && src.charCodeAt(i + 1) === 40) { // (
      const r = parseInlineLink(src, i + 2);
      if (r) { dest = r.dest; title = r.title; end = r.end; }
    }
    if (dest === null && i + 1 < n && src.charCodeAt(i + 1) === 91) { // [
      let q = i + 2, label = '', ok = false;
      while (q < n) {
        const c = src.charCodeAt(q);
        if (c === 92 && q + 1 < n && isAsciiPunctCh(src[q + 1])) { label += src.slice(q, q + 2); q += 2; continue; }
        if (c === 91) break; // label may not contain '['
        if (c === 93) { ok = true; break; }
        label += src[q]; q++;
      }
      if (ok) {
        const key = label === '' ? normalizeLabel(labelText) : normalizeLabel(label);
        const ref = refs.get(key);
        if (ref) { dest = ref.href; title = ref.title; end = q + 1; }
        else return null; // [label] present but undefined: no shortcut fallback
      } else {
        return null; // unclosed [label: not a link at all
      }
    }
    if (dest === null && !hasUnescapedBracket(labelText)) {
      const ref = refs.get(normalizeLabel(labelText));
      if (ref) { dest = ref.href; title = ref.title; end = i + 1; }
    }
    if (dest === null) return null;
    return { dest, title, end };
  }

  while (i < n) {
    const c = src.charCodeAt(i);
    // --- extended autolinks: scheme / mailto ---
    // (never formed inside link text: a [ bracket is open)
    if (!inLink && !hasActiveBracket() && (c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 77)) {
      const low = src.slice(i, i + 8).toLowerCase();
      let schemeLen = 0;
      if (low.startsWith('http://')) schemeLen = 7;
      else if (low.startsWith('https://')) schemeLen = 8;
      else if (low.startsWith('ftp://')) schemeLen = 6;
      if (schemeLen > 0) {
        const j = matchUrlRun(src, i);
        const end = i + trimUrlEnd(src.slice(i, j));
        if (end > i + schemeLen) {
          const text = src.slice(i, end);
          flush(i);
          out.push({ a: '<a href="' + escAttr(cleanUrl(text)) + '">' + escText(text) + '</a>', t: escText(text), cancelled: false });
          ts = end; i = end; continue;
        }
      }
      if (src.startsWith('mailto:', i)) {
        const em = matchEmail(src, i + 7, hasOpenUnderscore());
        if (em > i + 7) {
          const text = src.slice(i, em);
          flush(i);
          out.push({ a: '<a href="' + escAttr(cleanUrl(text)) + '">' + escText(text) + '</a>', t: escText(text), cancelled: false });
          ts = em; i = em; continue;
        }
      }
    }
    // --- scheme:email autolink (any scheme + email, e.g. xmpp:foo@bar.baz) ---
    if (!inLink && !hasActiveBracket() && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
      let q = i;
      while (q < n && q - i < 32) {
        const d = src.charCodeAt(q);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 45 || d === 46) q++;
        else break;
      }
      if (q - i >= 2 && q < n && src.charCodeAt(q) === 58) { // ':'
        const em = matchEmail(src, q + 1, hasOpenUnderscore());
        if (em > q + 1) {
          // optional single path segment after the email
          let end = em;
          if (end < n && src.charCodeAt(end) === 47) { // '/'
            let r = end + 1;
            while (r < n) {
              const d = src.charCodeAt(r);
              if (d === 32 || d === 9 || d === 10 || d === 60 || d === 47) break;
              r++;
            }
            const segEnd = end + 1 + trimUrlEnd(src.slice(end + 1, r));
            if (segEnd > end + 1) end = segEnd;
          }
          const text = src.slice(i, end);
          flush(i);
          out.push({ a: '<a href="' + escAttr(cleanUrl(text)) + '">' + escText(text) + '</a>', t: escText(text), cancelled: false });
          ts = end; i = end; continue;
        }
      }
    }
    // --- www autolink ---
    if (!inLink && !hasActiveBracket() && c === 119 && src.startsWith('www.', i)) {
      if (i === 0 || WWW_PREV.has(src[i - 1])) {
        const j = matchUrlRun(src, i);
        const end = i + trimUrlEnd(src.slice(i, j));
        if (end > i + 4) {
          const text = src.slice(i, end);
          flush(i);
          out.push({ a: '<a href="http://' + escAttr(cleanUrl(text)) + '">' + escText(text) + '</a>', t: escText(text), cancelled: false });
          ts = end; i = end; continue;
        }
      }
    }
    // --- email autolink ---
    // An email never starts with '_' here: a leading '_' run is an
    // emphasis delimiter (the email inside it starts at the next alnum).
    if (!inLink && !hasActiveBracket() && c !== 95 && isEmailLocal(c)) {
      const em = matchEmail(src, i, hasOpenUnderscore());
      if (em > i) {
        const text = src.slice(i, em);
        flush(i);
        out.push({ a: '<a href="mailto:' + escAttr(cleanUrl(text)) + '">' + escText(text) + '</a>', t: escText(text), cancelled: false });
        ts = em; i = em; continue;
      }
    }
    // --- newline: hard / soft break ---
    if (c === 10) {
      let sp = 0, k = i - 1;
      while (k >= ts && src.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        flush(i - sp); out.push('<br>');
        // a hard break strips leading whitespace of the next line
        let j = i + 1;
        while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
        ts = j; i = j;
      }
      else { flush(i); out.push('\n'); ts = i + 1; i++; }
      continue;
    }
    // --- backslash escape ---
    if (c === 92) {
      if (i + 1 < n) {
        const d = src.charCodeAt(i + 1);
        if (d === 10) {
          flush(i); out.push('<br>');
          let j = i + 2;
          while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
          ts = j; i = j; continue;
        }
        if (isAsciiPunctCh(src[i + 1])) {
          flush(i);
          out.push(escText(src[i + 1]));
          ts = i + 2; i += 2; continue;
        }
      }
      i++;
      continue;
    }
    // --- code span ---
    if (c === 96) {
      let m = 0;
      while (i + m < n && src.charCodeAt(i + m) === 96) m++;
      let q = i + m, found = -1, flen = 0;
      while (q < n) {
        if (src.charCodeAt(q) === 96) {
          let r = 0;
          while (q + r < n && src.charCodeAt(q + r) === 96) r++;
          if (r === m) { found = q; flen = r; break; }
          q += r;
        } else {
          // a code span may not swallow a ']' that closes an active
          // bracket into a link: the link is resolved before the span.
          // Only when the label is valid (no stray backtick) — otherwise
          // the link cannot form and the span wins (cm-342, cm-525).
          if (src.charCodeAt(q) === 93 && brackets.length > 0 && brackets[brackets.length - 1].active && q + 1 < n && src.charCodeAt(q + 1) === 40 && parseInlineLink(src, q + 2)) {
            const bb = brackets[brackets.length - 1];
            if (!hasStrayBacktick(src.slice(bb.textStart, q))) { found = -1; break; }
          }
          q++;
        }
      }
      if (found === -1) { i += m; continue; }
      let content = src.slice(i + m, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && !/^[ ]+$/.test(content)) {
        content = content.slice(1, -1);
      }
      flush(i);
      out.push('<code>' + escRaw(content) + '</code>');
      ts = found + flen; i = found + flen;
      continue;
    }
    // --- emphasis / strikethrough runs ---
    if (c === 42 || c === 95 || c === 126) {
      const ch = src[i];
      let m = 0;
      while (i + m < n && src.charCodeAt(i + m) === c) m++;
      if (ch === '~' && m > 2) { i += m; continue; } // runs of 3+ tildes are literal
      flush(i);
      if (addDelim(ch, i, m)) ts = i + m;
      i += m;
      continue;
    }
    // --- image / link brackets ---
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) { // ![
      flush(i);
      out.push('![');
      brackets.push({ img: true, piece: out.length - 1, textStart: i + 2, delimsLen: delims.length, active: true });
      ts = i + 2; i += 2;
      continue;
    }
    if (c === 91) { // [
      flush(i);
      out.push('[');
      brackets.push({ img: false, piece: out.length - 1, textStart: i + 1, delimsLen: delims.length, active: true });
      ts = i + 1; i++;
      continue;
    }
    if (c === 93) { // ]
      flush(i);
      // strict stack discipline: this ] closes the most recently opened
      // bracket, active or not. An inactive bracket makes the ] literal
      // (its link already failed or was deactivated by an inner link);
      // an active bracket is resolved, and on failure the ] is literal.
      // Either way the bracket is popped by this ].
      if (brackets.length === 0) { i++; continue; }
      const bi = brackets.length - 1;
      const b = brackets[bi];
      brackets.pop();
      if (!b.active) { i++; continue; }
      const r = resolveLink(b);
      if (r === null) {
        // a label with a stray backtick is not a link label at all, and
        // marked does not let emphasis form inside such a failed label
        // when the stray run is 2+ backticks (probe62); a stray single
        // backtick leaves the emphasis intact (probe60)
        if (hasStrayBacktickRun2(src.slice(b.textStart, i))) {
          for (let k = b.delimsLen; k < delims.length; k++) delims[k].trapped = true;
        }
        i++; continue; // literal ]
      }
      // (link formation continues below with b and r)
      const slice = delims.slice(b.delimsLen);
      if (slice.length > 0) processEmphasis(slice, src);
      delims.length = b.delimsLen;
      // a link deactivates outer LINK brackets (no nested links); an image
      // bracket stays active (an image may contain a link)
      if (!b.img) for (let k = 0; k < bi; k++) if (!brackets[k].img) brackets[k].active = false;
      brackets.length = bi;
      const href = escAttr(cleanUrl(r.dest));
      if (b.img) {
        const dmap = new Map();
        for (const d of slice) { dmap.set(d.piece, d); d.cleared = true; }
        let alt = '';
        for (let p = b.piece + 1; p < out.length; p++) {
          const pc = out[p];
          if (pc && typeof pc === 'object') {
            if (pc.a !== undefined) alt += pc.t;
            else if (pc.h !== undefined) alt += pc.alt;
            continue;
          }
          const d = dmap.get(p);
          if (d) { alt += d.ch.repeat(d.rem); continue; }
          alt += pc;
        }
        alt = alt.replace(/<[^>]*>/g, '');
        out[b.piece] = { h: '<img src="' + href + '" alt="' + alt + '"' + (r.title !== null ? ' title="' + escAttr(r.title) + '"' : '') + '>', alt };
        for (let p = b.piece + 1; p < out.length; p++) out[p] = '';
      } else {
        // extended autolinks inside link text stay plain text
        for (let p = b.piece + 1; p < out.length; p++) {
          const pc = out[p];
          if (pc && typeof pc === 'object' && pc.a !== undefined) pc.cancelled = true;
        }
        out[b.piece] = '<a href="' + href + '"' + (r.title !== null ? ' title="' + escAttr(r.title) + '"' : '') + '>';
        out.push('</a>');
      }
      ts = r.end; i = r.end;
      continue;
    }
    // --- autolink <...> / raw HTML ---
    if (c === 60) {
      // <scheme:...>
      let matched = false;
      if (i + 1 < n) {
        const c1 = src.charCodeAt(i + 1);
        if ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) {
          let q = i + 2;
          while (q < n && q - (i + 1) <= 31) {
            const d = src.charCodeAt(q);
            if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 45 || d === 46) q++;
            else break;
          }
          if (q - (i + 1) >= 2 && q < n && src.charCodeAt(q) === 58) {
            let s2 = q + 1;
            while (s2 < n) {
              const d = src.charCodeAt(s2);
              if (d === 62 || d === 60 || isWS(d)) break;
              s2++;
            }
            if (s2 > q + 1 && s2 < n && src.charCodeAt(s2) === 62) {
              const text = src.slice(i + 1, s2);
              flush(i);
              out.push('<a href="' + escAttr(cleanUrl(text)) + '">' + escText(text) + '</a>');
              ts = s2 + 1; i = s2 + 1;
              matched = true;
            }
          }
        }
      }
      if (matched) continue;
      // <email>
      const em = matchEmail(src, i + 1, hasOpenUnderscore());
      if (em > i + 1 && src.charCodeAt(em) === 62) {
        const text = src.slice(i + 1, em);
        flush(i);
        out.push('<a href="mailto:' + escAttr(cleanUrl(text)) + '">' + escText(text) + '</a>');
        ts = em + 1; i = em + 1;
        continue;
      }
      // raw HTML tag
      const tagEnd = matchHtmlTag(src, i);
      if (tagEnd !== -1) {
        flush(i);
        const tagText = src.slice(i, tagEnd);
        out.push(tagText);
        // an <a> start tag opens a link (suppressing extended autolinks
        // until a matching </a>); a </a> closes it again
        const lowTag = tagText.toLowerCase();
        if (lowTag.startsWith('</a') && (lowTag.length === 3 || lowTag[3] === '>' || lowTag[3] === ' ' || lowTag[3] === '\t' || lowTag[3] === '\n')) inLink = false;
        // <a followed by whitespace or '>' opens a link (even <a  /> with
        // spaces); <a/> with no whitespace does not (marked's startATag)
        else if (lowTag.startsWith('<a') && (lowTag.length === 2 || lowTag[2] === '>' || lowTag[2] === ' ' || lowTag[2] === '\t' || lowTag[2] === '\n')) inLink = true;
        ts = tagEnd; i = tagEnd;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(n);
  processEmphasis(delims, src);
  for (const d of allDelims) {
    if (!d.cleared) rebuildDelim(d);
  }
  let result = '';
  for (let p = 0; p < out.length; p++) {
    const pc = out[p];
    if (pc === '') continue;
    if (typeof pc === 'string') { result += pc; continue; }
    if (pc.a !== undefined) { result += pc.cancelled ? pc.t : pc.a; continue; }
    result += pc.h;
  }
  return result;
}

// ---------- block parsing ----------
// Node types: 0 doc, 1 para, 2 heading, 3 code, 4 fence, 5 html, 6 quote,
// 7 list, 8 item, 9 table, 10 hr
function blankStr(s, from) {
  for (let k = from; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function indentOfStr(s, baseCol) {
  let col = baseCol, p = 0;
  while (p < s.length) {
    const ch = s.charCodeAt(p);
    if (ch === 32) { col++; p++; }
    else if (ch === 9) { col += 4 - (col % 4); p++; }
    else break;
  }
  return [col, p];
}
// Remove n columns of indentation from s (which starts at column baseCol).
// Returns null when the line has less than n columns of indent.
function stripIndentStr(s, baseCol, n) {
  let col = baseCol, p = 0, rem = n;
  while (rem > 0 && p < s.length) {
    const ch = s.charCodeAt(p);
    if (ch === 32) { col++; p++; rem--; }
    else if (ch === 9) {
      const adv = 4 - (col % 4);
      if (adv <= rem) { col += adv; p++; rem -= adv; }
      else return { s: ' '.repeat(adv - rem) + s.slice(p + 1), col: col + rem };
    } else return null;
  }
  if (rem > 0) return null;
  return { s: s.slice(p), col };
}
// Skip up to 3 columns of spaces from the start of s (baseCol). Returns [pos, col].
function skipUpTo3(s, baseCol) {
  let col = baseCol, p = 0;
  while (p < s.length && col - baseCol < 3) {
    const ch = s.charCodeAt(p);
    if (ch === 32) { col++; p++; }
    else if (ch === 9) {
      const adv = 4 - (col % 4);
      if (col - baseCol + adv <= 3) { col += adv; p++; }
      else break;
    } else break;
  }
  return [p, col];
}
function trimRightSpaces(s) {
  let e = s.length;
  while (e > 0 && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
  return s.slice(0, e);
}

// --- block-start checks (on the content string s, starting at column baseCol) ---
function atxHeading(s, baseCol) {
  const [p, col] = skipUpTo3(s, baseCol);
  let q = p, level = 0;
  while (q < s.length && s.charCodeAt(q) === 35 && level < 7) { level++; q++; }
  if (level === 0 || level > 6) return null;
  if (q < s.length && s.charCodeAt(q) !== 32 && s.charCodeAt(q) !== 9) return null;
  let text = s.slice(q);
  // closing sequence of #'s at the end, preceded by a space/tab
  const m = /[ \t]+#+[ \t]*$/.exec(text);
  if (m) text = text.slice(0, m.index);
  text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level, text };
}
function fenceStart(s, baseCol) {
  const [p, col] = skipUpTo3(s, baseCol);
  if (p >= s.length) return null;
  const ch = s.charCodeAt(p);
  if (ch !== 96 && ch !== 126) return null;
  let q = p, len = 0;
  while (q < s.length && s.charCodeAt(q) === ch) { len++; q++; }
  if (len < 3) return null;
  let info = s.slice(q);
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  info = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { ch: String.fromCharCode(ch), len, info, indent: col - baseCol };
}
// Strip up to n columns of leading whitespace (tab-aware); a straddled tab
// becomes spaces. Unlike stripIndentStr it never fails for short indent.
function stripUpTo(s, baseCol, n) {
  let col = baseCol, p = 0, rem = n;
  while (rem > 0 && p < s.length) {
    const ch = s.charCodeAt(p);
    if (ch === 32) { col++; p++; rem--; }
    else if (ch === 9) {
      const adv = 4 - (col % 4);
      if (adv <= rem) { col += adv; p++; rem -= adv; }
      else return { s: ' '.repeat(adv - rem) + s.slice(p + 1), col: col + rem };
    } else break;
  }
  return { s: s.slice(p), col };
}
function fenceEnd(s, baseCol, ch, len) {
  const [p, col] = skipUpTo3(s, baseCol);
  let q = p, n = 0;
  while (q < s.length && s.charCodeAt(q) === ch.charCodeAt(0)) { n++; q++; }
  if (n < len) return false;
  return blankStr(s, q);
}
function thematicBreak(s, baseCol) {
  const [p, col] = skipUpTo3(s, baseCol);
  if (p >= s.length) return false;
  const ch = s.charCodeAt(p);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let q = p, n = 0;
  while (q < s.length) {
    const c = s.charCodeAt(q);
    if (c === ch) { n++; q++; }
    else if (c === 32 || c === 9) q++;
    else return false;
  }
  return n >= 3;
}
function setextUnderline(s, baseCol) {
  const [p, col] = skipUpTo3(s, baseCol);
  if (p >= s.length) return 0;
  const ch = s.charCodeAt(p);
  if (ch !== 61 && ch !== 45) return 0;
  let q = p;
  while (q < s.length && s.charCodeAt(q) === ch) q++;
  if (!blankStr(s, q)) return 0;
  return ch === 61 ? 1 : 2;
}
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
// Returns the html block type (1-7) starting at s, or 0.
function htmlBlockType(s, baseCol) {
  const [p, col] = skipUpTo3(s, baseCol);
  if (p >= s.length || s.charCodeAt(p) !== 60) return 0;
  const low = s.slice(p, p + 12).toLowerCase();
  if (low.startsWith('<script') || low.startsWith('<pre') || low.startsWith('<style') || low.startsWith('<textarea')) {
    const nameLen = low.startsWith('<textarea') ? 9 : low.startsWith('<script') ? 7 : low.startsWith('<style') ? 6 : 4;
    const afterPos = p + nameLen;
    if (afterPos >= s.length) return 1;
    const after = s.charCodeAt(afterPos);
    if (after === 32 || after === 9 || after === 62) return 1;
  }
  if (s.startsWith('<!--', p)) return 2;
  if (s.startsWith('<?', p)) return 3;
  if (s.startsWith('<!', p) && p + 2 < s.length) {
    const c = s.charCodeAt(p + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 4;
  }
  if (s.startsWith('<![CDATA[', p)) return 5;
  // tag name
  let q = p + 1;
  if (q < s.length && s.charCodeAt(q) === 47) q++;
  const ns = q;
  if (q >= s.length) return 0;
  const c0 = s.charCodeAt(q);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return 0;
  q++;
  while (q < s.length) {
    const c = s.charCodeAt(q);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) q++;
    else break;
  }
  const name = s.slice(ns, q).toLowerCase();
  if (q >= s.length) return 0;
  const after = s.charCodeAt(q);
  if (!(after === 32 || after === 9 || after === 62 || after === 47)) return 0;
  if (BLOCK_TAGS.has(name)) return 6;
  // type 7: a complete open or closing tag followed only by whitespace
  const tagEnd = matchHtmlTag(s.slice(p), 0);
  if (tagEnd === -1) return 0;
  return blankStr(s, p + tagEnd) ? 7 : 0;
}
// List marker at the start of s. Returns null or {ordered,start,delim,mwidth,indent,content,col}.
function listStart(s, baseCol, inPara) {
  const [p, col] = skipUpTo3(s, baseCol);
  if (p >= s.length) return null;
  const c = s.charCodeAt(p);
  let ordered = false, start = 0, delim = '', mwidth = 0;
  if (c === 45 || c === 43 || c === 42) {
    mwidth = 1;
  } else if (c >= 48 && c <= 57) {
    let q = p, digits = 0;
    while (q < s.length && s.charCodeAt(q) >= 48 && s.charCodeAt(q) <= 57) { digits++; q++; }
    if (digits > 9) return null;
    if (q >= s.length) return null;
    const d = s.charCodeAt(q);
    if (d !== 46 && d !== 41) return null;
    ordered = true;
    start = parseInt(s.slice(p, q), 10);
    delim = String.fromCharCode(d);
    mwidth = digits + 1;
  } else return null;
  // must be followed by a space/tab or end of line
  const after = p + mwidth;
  if (after < s.length && s.charCodeAt(after) !== 32 && s.charCodeAt(after) !== 9) return null;
  // whitespace columns after the marker
  const mcol = col;
  let wcol = mcol + mwidth, wp = after;
  while (wp < s.length) {
    const ch = s.charCodeAt(wp);
    if (ch === 32) { wcol++; wp++; }
    else if (ch === 9) { wcol += 4 - (wcol % 4); wp++; }
    else break;
  }
  const w = wcol - (mcol + mwidth);
  const empty = wp >= s.length;
  if (inPara && empty) return null; // an empty item cannot interrupt a paragraph
  if (inPara && ordered && start !== 1) return null; // only a "1." list interrupts a paragraph
  let contentCols;
  if (empty) contentCols = 1;
  else if (w >= 1 && w <= 4) contentCols = w;
  else contentCols = 1;
  const indent = (mcol - baseCol) + mwidth + contentCols;
  // content position: strip the content indent from just after the marker
  const stripped = stripIndentStr(s.slice(after), mcol + mwidth, contentCols);
  const content = stripped ? stripped.s : '';
  const contentCol = stripped ? stripped.col : mcol + mwidth + contentCols;
  return { ordered, start, delim, mwidth, indent, content, contentCol, marker: ordered ? delim : String.fromCharCode(c) };
}
// Table delimiter row. Returns the alignment array or null. A bare setext-style
// line (only = or -) is never a delimiter row.
function delimiterRow(s) {
  const t = s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^[=-]+$/.test(t)) return null;
  const cells = splitTableRow(s);
  if (cells === null) return null;
  const align = [];
  for (const cell of cells) {
    const t = cell.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    const m = /^(:?)-+(:?)$/.exec(t);
    if (!m) return null;
    if (m[1] && m[2]) align.push('center');
    else if (m[1]) align.push('left');
    else if (m[2]) align.push('right');
    else align.push(null);
  }
  return align;
}
function splitTableRow(s) {
  // split on unescaped |; leading/trailing | make empty edge cells that are dropped
  const cells = [];
  let cur = '', i = 0;
  let hasPipe = false;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
    if (c === 124) { cells.push(cur); cur = ''; hasPipe = true; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur);
  if (!hasPipe) return cells.length === 1 ? [cells[0]] : cells;
  // drop the empty edge cells from a leading / trailing pipe
  let start = 0, end = cells.length;
  if (cells[0].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === '') start = 1;
  if (end > start && cells[end - 1].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === '') end--;
  return cells.slice(start, end);
}
function tryTable(lines) {
  if (lines.length < 2) return null;
  const align = delimiterRow(lines[1]);
  if (align === null) return null;
  const head = splitTableRow(lines[0]);
  if (head.length !== align.length) return null;
  const body = [];
  for (let k = 2; k < lines.length; k++) {
    const row = splitTableRow(lines[k]);
    while (row.length < align.length) row.push('');
    body.push(row.slice(0, align.length));
  }
  return { t: 9, align, head: head.slice(0, align.length), body };
}
// Split a paragraph's lines at the first delimiter row (index k>=1).
// Returns [blocks] where blocks is [para?, tableOrPara].
function closeParagraph(lines, refs) {
  const rest0 = extractRefDefs(lines, refs);
  if (rest0.length === 0) return [];
  lines = rest0;
  let k = -1;
  for (let j = 1; j < lines.length; j++) {
    if (delimiterRow(lines[j]) !== null) { k = j; break; }
  }
  if (k === -1) return [{ t: 1, lines }];
  const before = k > 1 ? [{ t: 1, lines: lines.slice(0, k - 1) }] : [];
  const rest = lines.slice(k - 1);
  const tb = tryTable(rest);
  if (tb) return before.concat([tb]);
  return before.concat([{ t: 1, lines: rest }]);
}

// Expand tabs to spaces in the leading whitespace run of s (which starts at
// column startCol). Tabs after the first non-whitespace character are kept.
function expandLeadingTabs(s, startCol) {
  let col = startCol, p = 0, out = '';
  while (p < s.length) {
    const ch = s.charCodeAt(p);
    if (ch === 32) { out += ' '; col++; p++; }
    else if (ch === 9) {
      const adv = 4 - (col % 4);
      out += ' '.repeat(adv);
      col += adv; p++;
    } else break;
  }
  return p === 0 ? s : out + s.slice(p);
}

// ---------- link reference definitions ----------
function parseRefDef(lines, startLn, refs) {
  const parts = [];
  for (let k = startLn; k < Math.min(lines.length, startLn + 6); k++) {
    if (k > startLn && blankStr(lines[k], 0)) break;
    parts.push(lines[k]);
  }
  const s = parts.join('\n');
  const n = s.length;
  let p = 0, sp = 0;
  while (p < n && s.charCodeAt(p) === 32 && sp < 3) { p++; sp++; }
  if (p >= n || s.charCodeAt(p) !== 91) return 0;
  let q = p + 1, label = '';
  while (q < n) {
    const c = s.charCodeAt(q);
    if (c === 92 && q + 1 < n && isAsciiPunctCh(s[q + 1])) { label += s.slice(q, q + 2); q += 2; continue; }
    // a label may not contain [ or ]: nested brackets invalidate it
    if (c === 91) return 0;
    if (c === 93) break;
    label += s[q]; q++;
  }
  if (q >= n) return 0;
  const key = normalizeLabel(label);
  if (key === '' || label.length > 999) return 0;
  q++;
  if (q >= n || s.charCodeAt(q) !== 58) return 0;
  q++;
  while (q < n && isWS(s.charCodeAt(q))) q++;
  if (q >= n) return 0;
  let dest = '';
  if (s.charCodeAt(q) === 60) {
    let r = q + 1, buf = '';
    while (r < n) {
      const c = s.charCodeAt(r);
      if (c === 10 || c === 60) return 0;
      if (c === 62) break;
      if (c === 92 && r + 1 < n && isAsciiPunctCh(s[r + 1])) { buf += s[r + 1]; r += 2; continue; }
      buf += s[r]; r++;
    }
    if (r >= n) return 0;
    dest = buf; q = r + 1;
  } else {
    let r = q, d2 = 0, buf = '';
    while (r < n) {
      const c = s.charCodeAt(r);
      if (c === 32 || c === 9 || c === 10 || c === 13) break;
      if (c < 32) return 0;
      if (c === 40) { d2++; buf += s[r]; r++; continue; }
      if (c === 41) { if (d2 === 0) break; d2--; buf += s[r]; r++; continue; }
      if (c === 92 && r + 1 < n && isAsciiPunctCh(s[r + 1])) { buf += s[r + 1]; r += 2; continue; }
      buf += s[r]; r++;
    }
    if (r === q || d2 !== 0) return 0;
    dest = buf; q = r;
  }
  // After the destination: an optional title, then only whitespace to the
  // end of that line. The title may be on the same line (after whitespace)
  // or on the next line. A title directly glued to the destination is not
  // a title (cm-201). Content on a later line is a separate definition.
  const parseTitleAt = (tq) => {
    const qc = s.charCodeAt(tq);
    if (qc !== 34 && qc !== 39 && qc !== 40) return -1;
    const close = qc === 40 ? 41 : qc;
    let r = tq + 1, tb = '';
    while (r < n) {
      const c = s.charCodeAt(r);
      if (c === close) return { end: r + 1, title: tb };
      if (qc === 40 && c === 40) return -1;
      if (c === 92 && r + 1 < n && isAsciiPunctCh(s[r + 1])) { tb += s[r + 1]; r += 2; continue; }
      tb += s[r]; r++;
    }
    return -1;
  };
  let title = null, endPos = -1;
  // skip spaces/tabs on the destination's line
  let r = q;
  while (r < n && (s.charCodeAt(r) === 32 || s.charCodeAt(r) === 9)) r++;
  if (r >= n || s.charCodeAt(r) === 10) {
    // end of the destination's line: maybe a title on the next line; if the
    // would-be title is followed by junk, the title is dropped but the
    // definition itself (without title) still stands
    if (r < n) {
      let r2 = r + 1;
      while (r2 < n && (s.charCodeAt(r2) === 32 || s.charCodeAt(r2) === 9)) r2++;
      const t = r2 < n ? parseTitleAt(r2) : -1;
      if (t !== -1) {
        let e = t.end;
        while (e < n && (s.charCodeAt(e) === 32 || s.charCodeAt(e) === 9)) e++;
        if (e >= n || s.charCodeAt(e) === 10) { title = t.title; endPos = e; }
      }
    }
    if (endPos === -1) endPos = r; // no title: the def ends at the dest line
  } else {
    // something on the same line: it must be a title preceded by whitespace
    if (r === q) return 0;
    const t = parseTitleAt(r);
    if (t === -1) return 0;
    let e = t.end;
    while (e < n && (s.charCodeAt(e) === 32 || s.charCodeAt(e) === 9)) e++;
    if (e < n && s.charCodeAt(e) !== 10) return 0;
    title = t.title; endPos = e;
  }
  let consumed = 1;
  for (let k = 0; k < endPos; k++) if (s.charCodeAt(k) === 10) consumed++;
  if (!refs.has(key)) refs.set(key, { href: dest, title });
  return consumed;
}

// Strip leading link reference definitions from a paragraph's lines.
function extractRefDefs(lines, refs) {
  let start = 0;
  while (start < lines.length) {
    const used = parseRefDef(lines, start, refs);
    if (used === 0) break;
    start += used;
  }
  return lines.slice(start);
}

// ---------- block parser ----------
function htmlEndLine(node, line) {
  const low = line.toLowerCase();
  if (node.htype === 1) {
    return low.includes('</script') || low.includes('</pre') || low.includes('</style') || low.includes('</textarea');
  }
  if (node.htype === 2) return line.includes('-->');
  if (node.htype === 3) return line.includes('?>');
  if (node.htype === 4) return line.includes('>');
  if (node.htype === 5) return line.includes(']]>');
  return false;
}
function blockquoteRest(s, baseCol) {
  const [p, col] = skipUpTo3(s, baseCol);
  if (p >= s.length || s.charCodeAt(p) !== 62) return null;
  const np = p + 1, ncol = col + 1;
  if (np < s.length && s.charCodeAt(np) === 32) return [s.slice(np + 1), ncol + 1];
  if (np < s.length && s.charCodeAt(np) === 9) {
    // only 1 column of the tab is the marker's space; the rest is content indent
    const adv = 4 - (ncol % 4);
    return [' '.repeat(adv - 1) + s.slice(np + 1), ncol + 1];
  }
  return [s.slice(np), ncol];
}

function parseBlocks(lines, refs, srcEndsNL) {
  const root = { t: 0, c: [] };
  const stack = [root];
  let tip = null, tipParent = null;
  // deferred loose-list state: a blank line is recorded, not acted on;
  // the decision is made when the next block is added, so a blank nested
  // inside a blockquote (or code) does not loosen an outer list
  let pendingBlank = false, pendingBlankQuote = null;
  const cur = () => stack[stack.length - 1];

  function closeTip(atEOF) {
    if (!tip) return;
    if (tip.t === 1) {
      const blocks = closeParagraph(tip.lines, refs);
      const arr = tipParent.c;
      arr.pop();
      for (const b of blocks) arr.push(b);
    } else if (tip.t === 5 && tip.htype >= 6 && !atEOF) {
      // a type 6/7 html block keeps its trailing newline only at EOF
      if (tip.text.endsWith('\n')) tip.text = tip.text.slice(0, -1);
    } else if (tip.t === 4) {
      // unclosed fence: keep all buffered blank lines
      const bl = tip.blankLines;
      for (let i = 0; i < bl.length; i++) {
        tip.text += bl[i] + (i === bl.length - 1 && atEOF && !srcEndsNL ? '' : '\n');
      }
      tip.blankLines = [];
    }
    tip = null; tipParent = null;
  }
  function addTo(container, node) {
    // A blank line recorded earlier separates the previous child from this
    // one, loosening the list — unless the blank was inside a blockquote
    // that is no longer open, in which case it never reached this level.
    if (pendingBlank) {
      let loosens = true;
      if (pendingBlankQuote && !stack.includes(pendingBlankQuote)) loosens = false;
      if (loosens) {
        if (container.t === 8) {
          if (container.c.length > 0) container.list.tight = false;
        } else if (container.t === 7) {
          if (container.c.length > 0) container.tight = false;
        }
      }
      pendingBlank = false;
      pendingBlankQuote = null;
    }
    container.c.push(node);
  }
  // Mark only the innermost open list item (and its list) as having seen a
  // blank line; a blank deep inside a nested structure must not loosen an
  // outer list whose own items are not separated by blank lines.
  function markBlank(forLoose) {
    for (let k = stack.length - 1; k >= 1; k--) {
      const c = stack[k];
      if (c.t === 8) {
        c.blank = true;
        if (c.list) c.list.blank = true;
        break;
      }
    }
    if (forLoose !== false) {
      pendingBlank = true;
      pendingBlankQuote = null;
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].t === 6) { pendingBlankQuote = stack[k]; break; }
      }
    }
  }
  function addLeaf(node) {
    closeTip();
    addTo(cur(), node);
    tip = node; tipParent = cur();
  }
  function pushContainer(node) {
    closeTip();
    addTo(cur(), node);
    stack.push(node);
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const lineEnd = (ln === lines.length - 1 && !srcEndsNL) ? '' : '\n';
    let curStr = lines[ln], curCol = 0;
    // Phase 1: match containers
    let ci = 1, lazy = false, lazyQuote = false;
    // A line is a lazy continuation of the open paragraph when the tip is a
    // paragraph inside the failing container and the line is plain paragraph
    // text (not a block start that interrupts a paragraph). A setext
    // underline IS lazy here (it stays paragraph text); a thematic break
    // is not (it ends the paragraph).
    const isLazyLine = () => {
      if (!tip || tip.t !== 1) return false;
      if (stack.indexOf(tipParent) < ci) return false;
      // a blank line is not a lazy continuation
      if (blankStr(curStr, 0)) return false;
      if (atxHeading(curStr, curCol) || fenceStart(curStr, curCol) || thematicBreak(curStr, curCol)) return false;
      const ht = htmlBlockType(curStr, curCol);
      if (ht >= 1 && ht <= 6) return false;
      if (listStart(curStr, curCol, false) || blockquoteRest(curStr, curCol)) return false;
      return true;
    };
    while (ci < stack.length) {
      const c = stack[ci];
      if (c.t === 6) { // quote
        const r = blockquoteRest(curStr, curCol);
        if (r) { curStr = r[0]; curCol = r[1]; ci++; }
        else {
          if (isLazyLine()) { lazy = true; lazyQuote = true; break; }
          break;
        }
      } else if (c.t === 8) { // item
        if (blankStr(curStr, 0)) { ci++; continue; }
        const [cc] = indentOfStr(curStr, curCol);
        // an empty item that already saw a blank line accepts no more content
        if (c.c.length === 0 && c.blank) break;
        if (cc - curCol >= c.indent) {
          const r = stripIndentStr(curStr, curCol, c.indent);
          curStr = r.s; curCol = r.col; ci++;
        } else {
          // a fenced code block's content lines do not need the item indent
          if (tip && tip.t === 4) { ci++; continue; }
          // a new item of the same list is not a lazy continuation
          const parentList = stack[ci - 1];
          if (parentList && parentList.t === 7) {
            const ls0 = listStart(curStr, curCol, false);
            if (ls0 && ls0.ordered === parentList.ordered && (ls0.ordered ? ls0.delim === parentList.delim : ls0.marker === parentList.bullet)) break;
          }
          if (isLazyLine()) { lazy = true; lazyQuote = false; break; }
          break;
        }
      } else ci++; // list
    }
    if (!lazy) {
      while (stack.length > ci) {
        const c = stack.pop();
        if (tip && tipParent === c) closeTip();
      }
    }
    if (lazy) {
      // a lazy line with >= 4 columns of leading indent loses 4 of them;
      // a shorter indent is kept whole
      let line = curStr, lineCol = curCol;
      const [cc] = indentOfStr(curStr, curCol);
      if (cc - curCol >= 4) {
        const r = stripIndentStr(curStr, curCol, 4);
        line = r.s; lineCol = r.col;
      }
      // a lazy setext underline stays paragraph text; inside a blockquote it
      // is indented by 4 spaces when the previous line was also lazy, so it
      // can never be read as a setext underline
      if (lazyQuote && tip.lastLazy && setextUnderline(line, lineCol)) {
        tip.lines.push('    ' + line.replace(/^[ \t]+/, ''));
      } else {
        tip.lines.push(line);
      }
      tip.lastLazy = true;
      continue;
    }
    // Phase 2: blank line. A whitespace-only remainder inside a blockquote
    // is paragraph text (cm-241), not a blank line, so it falls through.
    const isBlankLine = blankStr(curStr, 0) && !(curStr.length > 0 && cur().t === 6);
    if (isBlankLine) {
      // fenced code buffers the line; exactly one trailing blank line is
      // dropped when the fence closes, the rest are kept
      if (tip && tip.t === 4) {
        const r = stripUpTo(curStr, curCol, tip.indent);
        tip.blankLines.push(r.s);
        continue;
      }
      // html types 1-5 consume the line as content
      if (tip && tip.t === 5 && tip.htype <= 5) { tip.text += curStr + lineEnd; continue; }
      // indented code: a whitespace-only line is a blank line; its content
      // (spaces left after stripping up to 4 columns) is kept only if a
      // later content line follows, else it is discarded as trailing
      if (tip && tip.t === 3) {
        markBlank(false); // blank inside indented code: not a list separator
        const r = stripUpTo(curStr, curCol, 4);
        tip.blankLines.push(r.s);
        continue;
      } else {
        markBlank();
        if (tip) {
          if (tip.t === 5) {
            if (tip.htype >= 6) { closeTip(); }
          }
          else if (tip.t === 1) {
            // a tab-only line inside a table paragraph is a table row with
            // empty cells, not a blank line ending the table
            if (curStr.indexOf('\t') !== -1 && tip.lines.length >= 2) {
              let isTable = false;
              for (let j = 1; j < tip.lines.length; j++) {
                if (delimiterRow(tip.lines[j]) !== null) { isTable = true; break; }
              }
              if (isTable) { tip.lines.push(curStr); continue; }
            }
            closeTip();
          }
        }
        continue;
      }
    }
    // Phase 3: tip continuation
    if (tip && tip.t === 4) {
      if (fenceEnd(curStr, curCol, tip.ch, tip.len)) {
        // drop exactly one trailing blank line, but only if it is empty
        // (a blank line holding spaces is content and is kept)
        const bl = tip.blankLines;
        if (bl.length > 0 && bl[bl.length - 1] === '') bl.pop();
        for (const b of tip.blankLines) tip.text += b + '\n';
        tip.blankLines = [];
        closeTip(); continue;
      }
      for (const b of tip.blankLines) tip.text += b + '\n';
      tip.blankLines = [];
      // Tilde fences do NOT strip the fence indent from content lines;
      // backtick fences do. (Verified against marked 18.1.3.)
      const r = tip.ch === '~' ? { s: curStr, col: curCol } : stripUpTo(curStr, curCol, tip.indent);
      // A leading tab in fenced code content is kept literally when the
      // line is top-level (no container indent was stripped): the tab sits
      // exactly at the fence-indent boundary. Inside a container the tab
      // expands to spaces from its column; for nested blockquotes only the
      // outermost quote level advances the tab-stop column, so each extra
      // quote level subtracts 2 from the effective column.
      const leadTab = r.s.charCodeAt(0) === 9 && curCol === 0;
      let content = r.s;
      if (!leadTab && r.col > 0) {
        let effCol = r.col;
        let qLevels = 0;
        for (const c of stack) if (c.t === 6) qLevels++;
        if (qLevels > 1) effCol = r.col - 2 * (qLevels - 1);
        content = expandLeadingTabs(r.s, effCol);
      }
      tip.text += content + lineEnd;
      continue;
    }
    if (tip && tip.t === 5) {
      tip.text += curStr + lineEnd;
      if (htmlEndLine(tip, curStr)) {
        // a following truly-empty line absorbs the block's trailing newline;
        // a whitespace-only line (spaces/tabs) does not
        if (tip.htype <= 5 && ln + 1 < lines.length && lines[ln + 1].length === 0 && tip.text.endsWith('\n')) tip.text = tip.text.slice(0, -1);
        closeTip();
      }
      continue;
    }
    if (tip && tip.t === 3) {
      const [cc] = indentOfStr(curStr, curCol);
      if (cc - curCol >= 4) {
        const r = stripIndentStr(curStr, curCol, 4);
        if (tip.blankLines.length > 0) { for (const b of tip.blankLines) tip.text += b + '\n'; tip.blankLines = []; }
        // the stripped remainder is the content verbatim: a tab left over
        // after the 4-column strip stays a literal tab
        tip.text += r.s + lineEnd;
        continue;
      }
      closeTip();
    }
    // Phase 4: block starts (a line may open several containers)
    let s = curStr, scol = curCol;
    for (;;) {
      // the line is blank after container markers were stripped: no block
      // starts here; it only separates blocks (and may end a paragraph).
      // Whitespace-only content inside a blockquote is paragraph text, not
      // a blank line, so only an empty remainder (or a non-quote remainder)
      // counts as blank here. This is not a source blank line, so it does
      // not mark containers as blank (an empty list item is not a blank).
      if (s.length === 0 || (blankStr(s, 0) && cur().t !== 6)) {
        if (tip && tip.t === 1) closeTip();
        break;
      }
      // dangling list left by a popped item: continue it or close it
      if (stack.length > 1 && cur().t === 7) {
        // a thematic break ends the list, it is not a new item
        if (thematicBreak(s, scol)) { stack.pop(); continue; }
        const ls = listStart(s, scol, !!(tip && tip.t === 1));
        const L = cur();
        const same = ls && ls.ordered === L.ordered && (ls.ordered ? ls.delim === L.delim : ls.marker === L.bullet);
        if (same) {
          const item = { t: 8, indent: ls.indent, blank: false, list: L, c: [] };
          addTo(L, item);
          stack.push(item);
          s = ls.content; scol = ls.contentCol;
          continue;
        }
        stack.pop();
        continue;
      }
      if (tip && tip.t === 1) {
        const lv = setextUnderline(s, scol);
        if (lv) {
          // definitions at the start of the paragraph are removed first;
          // if nothing is left there is no heading and the underline line
          // itself is re-processed as a fresh block
          const rest = extractRefDefs(tip.lines, refs);
          if (rest.length === 0) {
            const arr = tipParent.c;
            arr.pop();
            tip = null; tipParent = null;
            continue;
          }
          const text = rest.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          const arr = tipParent.c;
          arr.pop();
          arr.push({ t: 2, level: lv, text });
          tip = null; tipParent = null;
          break;
        }
        if (atxHeading(s, scol) || fenceStart(s, scol) || thematicBreak(s, scol)) { closeTip(); continue; }
        const ht = htmlBlockType(s, scol);
        if (ht >= 1 && ht <= 6) { closeTip(); continue; }
        // an ordered list may interrupt a paragraph only when it starts
        // with 1, EXCEPT when the paragraph sits inside a list item: a
        // nested list there may start at any number
        const inParaStrict = !(tipParent && tipParent.t === 8);
        if (listStart(s, scol, inParaStrict) || blockquoteRest(s, scol)) { closeTip(); continue; }
        tip.lines.push(s);
        tip.lastLazy = false;
        break;
      }
      // no open paragraph: start a new block
      const h = atxHeading(s, scol);
      if (h) { addLeaf({ t: 2, level: h.level, text: h.text }); break; }
      const f = fenceStart(s, scol);
      if (f) { addLeaf({ t: 4, ch: f.ch, len: f.len, info: f.info, indent: f.indent, text: '', blankLines: [] }); break; }
      if (thematicBreak(s, scol)) { addLeaf({ t: 10 }); break; }
      const ht = htmlBlockType(s, scol);
      if (ht) {
        const node = { t: 5, htype: ht, text: s + lineEnd };
        addLeaf(node);
        if (ht <= 5 && htmlEndLine(node, s)) {
          if (ln + 1 < lines.length && lines[ln + 1].length === 0 && node.text.endsWith('\n')) node.text = node.text.slice(0, -1);
          closeTip();
        }
        break;
      }
      const br = blockquoteRest(s, scol);
      if (br) {
        pushContainer({ t: 6, c: [] });
        s = br[0]; scol = br[1];
        continue;
      }
      const ls = listStart(s, scol, false);
      if (ls) {
        const L = { t: 7, ordered: ls.ordered, start: ls.start, delim: ls.delim, bullet: ls.marker, tight: true, blank: false, c: [] };
        pushContainer(L);
        const item = { t: 8, indent: ls.indent, blank: false, list: L, c: [] };
        addTo(L, item);
        stack.push(item);
        s = ls.content; scol = ls.contentCol;
        continue;
      }
      // indented code (only when no paragraph is open)
      const [cc] = indentOfStr(s, scol);
      if (cc - scol >= 4) {
        const r = stripIndentStr(s, scol, 4);
        addLeaf({ t: 3, text: r.s + lineEnd, blankLines: [] });
        break;
      }
      // plain paragraph (leading spaces are part of the text)
      if (blankStr(s, 0)) break; // whitespace-only cannot start a paragraph
      addLeaf({ t: 1, lines: [expandLeadingTabs(s, scol)], lastLazy: false });
      break;
    }
  }
  closeTip(true);
  while (stack.length > 1) stack.pop();
  return root;
}

// ---------- rendering ----------
function renderInline(text, refs) {
  return inlineParse(text, refs);
}
function renderBlocks(node, refs, out, tightList) {
  switch (node.t) {
    case 0:
      for (const ch of node.c) renderBlocks(ch, refs, out, false);
      break;
    case 1:
      out.push('<p>' + renderInline(node.lines.join('\n'), refs) + '</p>\n');
      break;
    case 2:
      out.push('<h' + node.level + '>' + renderInline(node.text, refs) + '</h' + node.level + '>\n');
      break;
    case 3:
      out.push('<pre><code>' + escRaw(node.text) + '</code></pre>\n');
      break;
    case 4: {
      const info = node.info;
      // first word: up to the first unescaped space/tab, then unescape
      let end = 0;
      while (end < info.length) {
        const c = info.charCodeAt(end);
        if (c === 92 && end + 1 < info.length && isAsciiPunctCh(info[end + 1])) { end += 2; continue; }
        if (c === 32 || c === 9) break;
        end++;
      }
      const firstWord = unescapeAscii(info.slice(0, end));
      out.push('<pre><code' + (firstWord ? ' class="language-' + escAttr(firstWord) + '"' : '') + '>' + escRaw(node.text) + '</code></pre>\n');
      break;
    }
    case 5:
      out.push(node.text);
      break;
    case 6:
      out.push('<blockquote>\n');
      for (const ch of node.c) renderBlocks(ch, refs, out, false);
      out.push('</blockquote>\n');
      break;
    case 7: {
      const tag = node.ordered ? 'ol' : 'ul';
      out.push('<' + tag + (node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n');
      for (const ch of node.c) renderBlocks(ch, refs, out, node.tight);
      out.push('</' + tag + '>\n');
      break;
    }
    case 8: {
      out.push('<li>');
      const tight = tightList;
      let idx = 0;
      for (const ch of node.c) {
        if (idx === 0 && ch.t === 1) {
          // GFM task list item: first paragraph starting with [ ] / [x] / [X]
          const firstLine = ch.lines[0] || '';
          const m = /^\[([ xX])\]( |$)/.exec(firstLine);
          if (m) {
            const checked = m[1] === 'x' || m[1] === 'X';
            const cb = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox">';
            const lines = ch.lines.slice();
            lines[0] = firstLine.slice(m[0].length);
            const inner = renderInline(lines.join('\n'), refs);
            if (tight) out.push(cb + ' ' + inner);
            else out.push('<p>' + cb + ' ' + inner + '</p>\n');
            idx++;
            continue;
          }
        }
        if (ch.t === 1 && tight) out.push(renderInline(ch.lines.join('\n'), refs));
        else renderBlocks(ch, refs, out, false);
        idx++;
      }
      out.push('</li>\n');
      break;
    }
    case 9: {
      out.push('<table>\n<thead>\n<tr>\n');
      node.head.forEach((cell, idx) => {
        const a = node.align[idx];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell.trim(), refs) + '</th>\n');
      });
      out.push('</tr>\n</thead>\n');
      if (node.body.length > 0) {
        out.push('<tbody>');
        node.body.forEach((row, ri) => {
          out.push('<tr>\n');
          row.forEach((cell, idx) => {
            const a = node.align[idx];
            out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell.trim(), refs) + '</td>\n');
          });
          out.push('</tr>\n');
        });
        out.push('</tbody></table>\n');
      } else {
        out.push('</table>\n');
      }
      break;
    }
    case 10:
      out.push('<hr>\n');
      break;
  }
}

// ---------- entry point ----------
export function parse(src) {
  const refs = new Map();
  inLink = false;
  const norm = src.replace(/\r\n?/g, '\n');
  const srcEndsNL = norm.endsWith('\n');
  const lines = norm.split('\n');
  if (srcEndsNL) lines.pop();
  const root = parseBlocks(lines, refs, srcEndsNL);
  const out = [];
  renderBlocks(root, refs, out, false);
  return out.join('');
}
