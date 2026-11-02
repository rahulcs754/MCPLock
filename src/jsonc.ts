/**
 * Parse JSON with comments and trailing commas (JSONC), as used by
 * VS Code and Cursor config files.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text.replace(/^﻿/, '')));
}

export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else if (c === ',') {
      let j = i + 1;
      while (j < n) {
        if (/\s/.test(text[j]!)) j++;
        else if (text[j] === '/' && text[j + 1] === '/') while (j < n && text[j] !== '\n') j++;
        else if (text[j] === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
          j += 2;
        } else break;
      }
      if (text[j] !== '}' && text[j] !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
