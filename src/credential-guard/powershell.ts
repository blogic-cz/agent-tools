import { MAX_SCRIPT_BYTES, literalWord } from "./ir";
import type {
  AndOr,
  Assignment,
  ParseError,
  Pipeline,
  Script,
  SimpleCommand,
  Word,
  WordPart,
} from "./ir";

type Token =
  | { readonly kind: "word"; readonly word: Word }
  | { readonly kind: "operator"; readonly text: string; readonly start: number };
export function parsePowerShell(text: string): Script | ParseError {
  const error = (start: number, code: ParseError["code"] = "syntax"): ParseError => ({
    kind: "parse-error",
    code,
    span: { start, end: text.length },
  });
  if (
    text.length > MAX_SCRIPT_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_SCRIPT_BYTES
  )
    return error(0, "size-limit");

  if (/[\u2018-\u201f]/.test(text)) return error(0);
  const tokens: Token[] = [];
  let position = 0;
  while (position < text.length) {
    const ch = text[position] ?? "";
    if (/[ \t\r,]/.test(ch)) {
      position++;
      continue;
    }
    if (ch === "#") {
      while (position < text.length && text[position] !== "\n") position++;
      continue;
    }
    if (/[;|&\n]/.test(ch)) {
      const op = text.slice(position, position + 2);
      tokens.push({
        kind: "operator",
        text: op === "&&" || op === "||" ? op : ch === "\n" ? ";" : ch,
        start: position,
      });
      position += op === "&&" || op === "||" ? 2 : 1;
      continue;
    }
    const start = position;
    const parts: WordPart[] = [];
    let quote = "";
    let buffer = "";
    const flush = () => {
      if (buffer) {
        parts.push({ kind: "literal", text: buffer, quoted: Boolean(quote) });
        buffer = "";
      }
    };
    while (position < text.length) {
      const current = text[position] ?? "";
      if (
        !quote &&
        current.charCodeAt(0) > 127 &&
        !/[\p{L}\p{M}\p{N}]/u.test(current) &&
        (/[\p{Z}\p{C}]/u.test(current) || (position === start && /[\u2013-\u2015]/u.test(current)))
      )
        return error(position);
      if (
        !quote &&
        ((current.charCodeAt(0) < 32 && !/[\t\n\r]/.test(current)) || current.charCodeAt(0) === 127)
      )
        return error(position);
      if (!quote && /[ \t\r\n,;|&]/.test(current)) break;
      if (!quote && /[{}()[\]<>@]/.test(current)) return error(position, "unsupported-keyword");
      if (current === "`" && quote !== "'") {
        const next = text[position + 1];
        if (next === undefined) return error(position);
        buffer += next === "n" ? "\n" : next === "t" ? "\t" : next;
        position += 2;
        continue;
      }
      if ((current === "'" || current === '"') && (!quote || quote === current)) {
        if (quote === "'" && text[position + 1] === "'") {
          buffer += "'";
          position += 2;
          continue;
        }
        flush();
        if (quote) quote = "";
        else {
          quote = current;
          parts.push({ kind: "literal", text: "", quoted: true });
        }
        position++;
        continue;
      }
      if (quote !== "'" && current === "$") {
        flush();
        const match = /^\$(?:(env):)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(text.slice(position));
        if (!match) return error(position, "unsupported-parameter-operator");
        parts.push({
          kind: "parameter",
          name: match[2] ?? "",
          ambient: Boolean(match[1]),
          operator: "plain",
          operand: null,
          span: { start: position, end: position + match[0].length },
        });
        position += match[0].length;
        if (text[position] === ":" || text[position] === "." || text[position] === "[")
          return error(position, "unsupported-keyword");
        continue;
      }
      if (!quote && /[*?]/.test(current)) {
        flush();
        parts.push({ kind: "glob", text: current });
        position++;
        continue;
      }
      buffer += current;
      position++;
    }
    if (position === start) return error(start);
    if (quote) return error(start, "unterminated-quote");
    flush();
    tokens.push({ kind: "word", word: { split: false, parts, span: { start, end: position } } });
  }
  let cursor = 0;
  const location = (): number => {
    const token = tokens[cursor];
    return token?.kind === "operator" ? token.start : (token?.word.span.start ?? text.length);
  };
  const isOp = (op: string): boolean => {
    const t = tokens[cursor];
    return t?.kind === "operator" && t.text === op;
  };
  const command = (): SimpleCommand | ParseError => {
    const first = tokens[cursor];
    const start =
      first?.kind === "operator" ? first.start : (first?.word.span.start ?? text.length);
    const invocation = isOp("&");
    if (invocation) cursor++;
    const argv: Word[] = [];
    while (tokens[cursor]?.kind === "word") {
      const t = tokens[cursor];
      if (t?.kind === "word") argv.push(t.word);
      cursor++;
    }
    if (!argv.length) return error(start);
    const assignments: Assignment[] = [];
    const variable = argv[0];
    const part = variable?.parts[0];
    const equals = argv[1];
    if (
      !invocation &&
      variable?.parts.length === 1 &&
      part?.kind === "parameter" &&
      equals?.parts.length === 1 &&
      equals.parts[0]?.kind === "literal" &&
      equals.parts[0].text === "="
    ) {
      if (argv.length !== 3 || part.ambient) return error(start, "unsupported-keyword");
      assignments.push({
        operation: "replace",
        name: part.name.toLowerCase(),
        value: argv[2] ?? literalWord(""),
        exported: false,
      });
      argv.splice(0);
    }
    return {
      kind: "simple",
      assignments,
      argv,
      redirects: [],
      span: {
        start,
        end: location(),
      },
    };
  };
  const pipeline = (): Pipeline | ParseError => {
    const first = command();
    if (first.kind === "parse-error") return first;
    const commands: SimpleCommand[] = [first];
    while (isOp("|")) {
      cursor++;
      const next = command();
      if (next.kind === "parse-error") return next;
      commands.push(next);
    }
    return { negated: false, stderr: false, commands };
  };
  const items: AndOr[] = [];
  while (cursor < tokens.length) {
    while (isOp(";")) cursor++;
    if (cursor === tokens.length) break;
    const first = pipeline();
    if ("kind" in first) return first;
    const rest: { op: "&&" | "||"; pipeline: Pipeline }[] = [];
    while (isOp("&&") || isOp("||")) {
      const op = isOp("&&") ? "&&" : "||";
      cursor++;
      const next = pipeline();
      if ("kind" in next) return next;
      rest.push({ op, pipeline: next });
    }
    items.push({ first, rest, background: false });
    if (cursor < tokens.length && !isOp(";")) return error(location());
  }
  return {
    kind: "script",
    dialect: "powershell",
    source: text,
    body: { items },
    span: { start: 0, end: text.length },
  };
}
