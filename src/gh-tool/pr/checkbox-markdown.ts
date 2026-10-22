export type CheckboxOutlineEntry =
  | { readonly type: "task"; readonly text: string; readonly checked: boolean }
  | { readonly type: "heading"; readonly text: string; readonly level: number };

export type CheckboxOutlineParser = (body: string) => readonly CheckboxOutlineEntry[] | null;

type CheckboxLine = {
  readonly before: string;
  readonly offset: number;
  readonly boxIndex: number;
  readonly checked: boolean;
};

type ScannedEntry = CheckboxOutlineEntry & {
  readonly offset?: number;
  readonly boxIndex?: number;
  readonly before?: string;
};

type Fence = {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly listIndent: number | null;
};
type ListItemIndent = { readonly indent: number; readonly contentIndent: number };

const taskSuffix = /^[ \t]*\[([ xX])\][ \t]*(.*)$/;
const listMarker = /^( {0,3})(?:[-*+]|[0-9]+[.)])([ \t]+)/;
const quoteMarker = /^ {0,3}>[ \t]?/;
const plainSourceText = (text: string) =>
  text
    .replace(/(\*\*|__|~~|\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

const removeContainers = (line: string) => {
  let cursor = 0;
  for (;;) {
    const rest = line.slice(cursor);
    const quote = quoteMarker.exec(rest);
    if (quote !== null) {
      cursor += quote[0].length;
      continue;
    }
    const list = listMarker.exec(rest);
    if (list !== null) {
      cursor += list[0].length;
      continue;
    }
    return { text: line.slice(cursor), cursor };
  }
};

const openingFence = (line: string, listIndent: number | null): Fence | null => {
  const content = removeContainers(line).text;
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(content);
  if (match === null) return null;
  const marker = match[1]?.[0];
  const info = match[2] ?? "";
  if ((marker !== "`" && marker !== "~") || (marker === "`" && info.includes("`"))) return null;
  return { marker, length: match[1]?.length ?? 0, listIndent };
};

const closesFence = (line: string, fence: Fence) => {
  const content = removeContainers(line).text;
  const match = /^ {0,3}(`+|~+)[ \t]*\r?$/.exec(content);
  const markers = match?.[1] ?? "";
  return markers.length >= fence.length && markers[0] === fence.marker;
};

const headingFromLine = (line: string) => {
  const { text } = removeContainers(line);
  const match = /^ {0,3}(#{1,6})[ \t]+(.*?)\r?$/.exec(text);
  if (match === null) return null;
  return {
    level: match[1]?.length ?? 0,
    text: plainSourceText((match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "")),
  };
};

const scanOutline = (body: string): ScannedEntry[] => {
  const entries: ScannedEntry[] = [];
  const lines = body.match(/[^\n]*(?:\n|$)/g) ?? [];
  let offset = 0;
  let fence: Fence | null = null;
  const listItems: ListItemIndent[] = [];

  for (const raw of lines) {
    if (raw.length === 0) continue;
    const line = (raw.endsWith("\n") ? raw.slice(0, -1) : raw).replace(/\r$/, "");
    const lineStart = offset;
    offset += raw.length;

    const marker = listMarker.exec(line);
    if (marker !== null) {
      const indent = marker[1]?.length ?? 0;
      while ((listItems.at(-1)?.indent ?? -1) >= indent) {
        listItems.pop();
      }
      listItems.push({ indent, contentIndent: indent + marker[0].length });
    } else if (line.trim() !== "") {
      const leading = /^ */.exec(line)?.[0].length ?? 0;
      while (listItems.length > 0 && leading < (listItems.at(-1)?.contentIndent ?? 0)) {
        listItems.pop();
      }
    }

    if (fence !== null) {
      if (fence.listIndent !== null && line.trim() !== "") {
        const leading = /^ */.exec(line)?.[0].length ?? 0;
        if (leading < fence.listIndent) fence = null;
      }
      if (fence !== null) {
        if (closesFence(line, fence)) fence = null;
        continue;
      }
    }

    const context = listItems.at(-1);
    const opening = openingFence(line, context?.contentIndent ?? null);
    if (opening !== null) {
      fence = opening;
      continue;
    }

    const heading = headingFromLine(line);
    if (heading !== null) {
      entries.push({ type: "heading", ...heading });
      continue;
    }

    const { text, cursor } = removeContainers(line);
    const task = taskSuffix.exec(text);
    if (task === null) continue;
    const checked = task[1] !== " ";
    const boxIndex = cursor + (text.indexOf("[") + 1);
    const content = plainSourceText(task[2] ?? "");
    entries.push({
      type: "task",
      text: content,
      checked,
      offset: lineStart + boxIndex,
      boxIndex,
      before: line.replace(/\r$/, ""),
    });
  }
  return entries;
};

const tokenPrefix = "\uE000checkbox:";
const tokenSuffix = ":\uE001";
const makeToken = (id: number) => `${tokenPrefix}${id}${tokenSuffix}`;
const tokenPattern = /\uE000checkbox:(\d+):\uE001/g;

export const bunMarkdownOutline: CheckboxOutlineParser = (body) => {
  const markdown = (globalThis as typeof globalThis & { Bun?: typeof Bun }).Bun?.markdown;
  if (markdown?.render === undefined) return null;

  const nodes: Array<{ readonly entry: CheckboxOutlineEntry | null; readonly children: string }> =
    [];
  const token = (entry: CheckboxOutlineEntry | null, children: string) => {
    const id = nodes.push({ entry, children }) - 1;
    return makeToken(id);
  };
  const plain = (value: string) => value.replace(tokenPattern, "").trim();

  const rendered = markdown.render(body, {
    text: (children) => children,
    strong: (children) => children,
    emphasis: (children) => children,
    strikethrough: (children) => children,
    link: (children) => children,
    image: (children) => children,
    codespan: (children) => children,
    heading: (children, meta) =>
      token({ type: "heading", level: meta.level, text: plain(children) }, children),
    listItem: (children, meta) =>
      token(
        typeof meta.checked === "boolean"
          ? { type: "task", checked: meta.checked, text: plain(children) }
          : null,
        children,
      ),
  });

  const outline: CheckboxOutlineEntry[] = [];
  const expand = (value: string) => {
    for (const match of value.matchAll(tokenPattern)) {
      const idText = match[1];
      const id = idText === undefined ? -1 : Number(idText);
      const node = nodes[id];
      if (node === undefined || match.index === undefined)
        throw new Error("Invalid Bun Markdown callback outline");
      if (node.entry !== null) outline.push(node.entry);
      expand(node.children);
    }
  };
  expand(rendered);
  return outline;
};

const sameOutline = (scanned: readonly ScannedEntry[], parsed: readonly CheckboxOutlineEntry[]) => {
  return (
    scanned.length === parsed.length &&
    scanned.every((entry, index) => {
      const actual = parsed[index];
      return (
        actual !== undefined &&
        entry.type === actual.type &&
        entry.text === actual.text &&
        (entry.type !== "heading" || (actual.type === "heading" && entry.level === actual.level)) &&
        (entry.type !== "task" || (actual.type === "task" && entry.checked === actual.checked))
      );
    })
  );
};

const sameEntry = (left: CheckboxOutlineEntry, right: CheckboxOutlineEntry) =>
  left.type === right.type &&
  left.text === right.text &&
  (left.type !== "heading" || (right.type === "heading" && left.level === right.level)) &&
  (left.type !== "task" || (right.type === "task" && left.checked === right.checked));

export const validateCheckboxEdit = (
  body: string,
  offset: number,
  replacement: " " | "x",
  parseOutline: CheckboxOutlineParser = bunMarkdownOutline,
) => {
  const scanned = scanOutline(body);
  const original = parseOutline(body);
  const selectedIndex = scanned.findIndex(
    (entry) => entry.type === "task" && entry.offset === offset,
  );
  if (
    original === null ||
    !sameOutline(scanned, original) ||
    selectedIndex < 0 ||
    original[selectedIndex]?.type !== "task" ||
    body[offset] === undefined ||
    (replacement !== " " && replacement !== "x")
  ) {
    throw new Error("PR body structure is ambiguous; tick this item in the GitHub UI");
  }

  const editedBody = `${body.slice(0, offset)}${replacement}${body.slice(offset + 1)}`;
  const edited = parseOutline(editedBody);
  if (edited === null || edited.length !== original.length) {
    throw new Error("PR body structure is ambiguous; tick this item in the GitHub UI");
  }

  const expected = [...original];
  const selected = expected[selectedIndex];
  if (selected?.type === "task") {
    expected[selectedIndex] = { ...selected, checked: replacement !== " " };
  }
  if (
    !edited.every((entry, index) => {
      const expectedEntry = expected[index];
      return expectedEntry !== undefined && sameEntry(expectedEntry, entry);
    })
  ) {
    throw new Error("PR body structure is ambiguous; tick this item in the GitHub UI");
  }
};

export const findCheckboxLines = (
  body: string,
  match: string,
  section: string | null,
  parseOutline: CheckboxOutlineParser = bunMarkdownOutline,
) => {
  const scanned = scanOutline(body);
  const parsed = parseOutline(body);
  if (parsed === null || !sameOutline(scanned, parsed)) {
    throw new Error("PR body structure is ambiguous; tick this item in the GitHub UI");
  }

  const matches: CheckboxLine[] = [];
  let sectionLevel: number | null = null;
  let inSection = section === null;

  for (const entry of scanned) {
    if (entry.type === "heading") {
      if (sectionLevel !== null && entry.level <= sectionLevel) {
        inSection = false;
        sectionLevel = null;
      }
      if (section !== null && entry.text === section) {
        inSection = true;
        sectionLevel = entry.level;
      }
      continue;
    }
    if (!inSection || !entry.text.includes(match)) continue;
    if (entry.offset === undefined || entry.boxIndex === undefined || entry.before === undefined)
      continue;
    matches.push({
      before: entry.before,
      offset: entry.offset,
      boxIndex: entry.boxIndex,
      checked: entry.checked,
    });
  }
  return matches;
};

export const scanCheckboxOutline = (body: string): readonly CheckboxOutlineEntry[] =>
  scanOutline(body).map((entry) =>
    entry.type === "task"
      ? { type: entry.type, text: entry.text, checked: entry.checked }
      : { type: entry.type, text: entry.text, level: entry.level },
  );
