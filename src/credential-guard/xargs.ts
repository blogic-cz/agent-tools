export type XargsInput = {
  readonly replacement: string | null;
  readonly maxArgs: number | null;
  readonly maxLines: number | null;
};

export function splitXargsInput(text: string, mode: XargsInput): readonly string[][] | null {
  if (/[^\t\n\x20-\x7e]/.test(text)) return null;
  if (mode.replacement !== null && /['"\t]| {2}|^ |\n |\\/.test(text)) return null;
  const lines: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  const finishWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let index = 0; index < text.length; index++) {
    const ch = text[index] ?? "";
    if (ch === "\n") {
      if (
        quote ||
        ((mode.maxLines !== null || mode.replacement !== null) &&
          /[ \t]/.test(text[index - 1] ?? ""))
      )
        return null;
      finishWord();
      if (words.length) lines.push(words);
      words = [];
    } else if (ch === "\\" && !quote) {
      const next = text[++index];
      if (next === undefined || next === "\n") return null;
      word += next;
      started = true;
    } else if ((ch === "'" || ch === '"') && (!quote || ch === quote)) {
      quote = quote ? "" : ch;
      started = true;
    } else if (!quote && /[ \t]/.test(ch) && mode.replacement === null) {
      finishWord();
    } else if (mode.replacement !== null && !started && /[ \t]/.test(ch)) {
      continue;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) return null;
  finishWord();
  if (words.length) lines.push(words);
  const result: string[][] = [];
  if (mode.replacement !== null) result.push(...lines);
  else if (mode.maxLines !== null) {
    for (let index = 0; index < lines.length; index += mode.maxLines)
      result.push(lines.slice(index, index + mode.maxLines).flat());
  } else {
    const all = lines.flat();
    const size = mode.maxArgs ?? Math.max(all.length, 1);
    for (let index = 0; index < all.length; index += size)
      result.push(all.slice(index, index + size));
  }
  if (result.length > 64 || result.some((args) => args.length > 64)) return null;
  return result.length ? result : null;
}
