import { MAX_ANALYSIS_UNITS, MAX_PARSE_DEPTH, MAX_SCRIPT_BYTES, literalWord, wordText } from "./ir";
import type {
  AndOr,
  Assignment,
  Command,
  List,
  ParseError,
  ParseErrorCode,
  Pipeline,
  Redirect,
  Script,
  Span,
  Word,
  WordPart,
} from "./ir";

type Token =
  | { readonly kind: "word"; readonly word: Word }
  | { readonly kind: "op"; readonly text: string; readonly span: Span }
  | {
      readonly kind: "heredoc";
      readonly body: Word;
      readonly literal: boolean;
      readonly span: Span;
    };
class ParseFailure extends Error {
  constructor(readonly problem: ParseError) {
    super(problem.code);
  }
}
function fail(code: ParseErrorCode, start: number, end = start + 1): never {
  throw new ParseFailure({ kind: "parse-error", code, span: { start, end } });
}
const operators = [
  "((",
  "[[",
  "]]",
  ";;&",
  "<<<",
  "&>>",
  ";;",
  "&&",
  "||",
  "|&",
  ">>",
  "<<",
  "<&",
  ">&",
  "<>",
  ">|",
  "&>",
  ";",
  "&",
  "|",
  "(",
  ")",
  "<",
  ">",
];

class Lexer {
  position = 0;
  constructor(
    readonly text: string,
    readonly depth: number,
    readonly offset: number,
  ) {}
  span(start: number): Span {
    return { start: start + this.offset, end: this.position + this.offset };
  }
  script(text: string, start: number): Script {
    const parsed = parse(text, this.depth + 1, this.offset + start);
    if (parsed.kind === "parse-error") throw new ParseFailure(parsed);
    return parsed;
  }
  substitution(close: ")" | "`", start: number): Script {
    const bodyStart = this.position;
    let nesting = 1;
    let quote = "";
    for (; this.position < this.text.length; this.position++) {
      const ch = this.text[this.position];
      if (ch === "\\") {
        this.position++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (close === ")" && ch === "(") nesting++;
      if (ch === close && nesting === 1) {
        const body = this.script(this.text.slice(bodyStart, this.position), bodyStart);
        this.position++;
        return body;
      }
      if (ch === close) nesting--;
    }
    return fail("unterminated-substitution", this.offset + start, this.offset + this.position);
  }
  ansiQuote(): WordPart {
    const start = this.position;
    this.position += 2;
    let text = "";
    const escapes: Readonly<Record<string, string>> = {
      a: "\x07",
      b: "\b",
      e: "\x1b",
      E: "\x1b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "?": "?",
    };
    while (this.position < this.text.length) {
      const ch = this.text[this.position++];
      if (ch === "'") return { kind: "literal", text, quoted: true };
      if (ch !== "\\") {
        text += ch;
        continue;
      }
      const next = this.text[this.position] ?? "";
      const escaped = escapes[next];
      if (escaped !== undefined) {
        text += escaped;
        this.position++;
        continue;
      }
      const hex = ["x", "u", "U"].includes(next);
      const digits = hex
        ? new RegExp(`^[0-9a-fA-F]{1,${next === "x" ? 2 : next === "u" ? 4 : 8}}`).exec(
            this.text.slice(this.position + 1),
          )?.[0]
        : /^[0-7]{1,3}/.exec(this.text.slice(this.position))?.[0];
      if (!digits) fail("unsupported-parameter-operator", this.offset + start);
      const value = Number.parseInt(digits, hex ? 16 : 8);
      if (value === 0 || value > 127) fail("unsupported-parameter-operator", this.offset + start);
      text += String.fromCodePoint(value);
      this.position += digits.length + (hex ? 1 : 0);
    }
    return fail("unterminated-quote", this.offset + start, this.offset + this.position);
  }
  parameter(quoted: boolean): WordPart {
    const start = this.position++;
    const ch = this.text[this.position];
    if (!quoted && (ch === "'" || ch === '"'))
      fail("unsupported-parameter-operator", this.offset + start);
    if (ch === "(") {
      this.position++;
      if (this.text[this.position] === "(") fail("unsupported-keyword", this.offset + start);
      return { kind: "command-substitution", body: this.substitution(")", start) };
    }
    if (ch === "{") {
      this.position++;
      const end = this.text.indexOf("}", this.position);
      if (end < 0) fail("unterminated-substitution", this.offset + start);
      const content = this.text.slice(this.position, end);
      if (content.startsWith("!")) fail("indirect-expansion", this.offset + start);
      if (/^#?(?:PIPESTATUS|pipestatus|BASH_REMATCH)\[(?:[0-9]+|[@*])\]$/.test(content)) {
        this.position = end + 1;
        return { kind: "special", name: content };
      }
      const match =
        /^(#?)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?$!#-])(?:(:-|-|:\+|\+)([\s\S]*))?$/.exec(content);
      if (!match)
        fail("unsupported-parameter-operator", this.offset + start, this.offset + end + 1);
      const name = match[2] ?? "";
      const operandText = match[4];
      let operand: Word | null = null;
      if (operandText !== undefined) {
        const lexer = new Lexer(
          operandText,
          this.depth + 1,
          this.offset + this.position + content.indexOf(operandText),
        );
        if (lexer.depth > MAX_PARSE_DEPTH) fail("depth-limit", this.offset + start);
        operand = lexer.word(true);
      }
      this.position = end + 1;
      if (/^[0-9@*?$!#-]+$/.test(name)) return { kind: "special", name };
      return {
        kind: "parameter",
        name,
        ambient: false,
        operator: match[1]
          ? "length"
          : match[3]?.includes("+")
            ? "alternate"
            : match[3]
              ? "default"
              : "plain",
        operand,
        span: this.span(start),
      };
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.position))?.[0];
    if (name) {
      this.position += name.length;
      return {
        kind: "parameter",
        name,
        ambient: false,
        operator: "plain",
        operand: null,
        span: this.span(start),
      };
    }
    if (ch && /[0-9@*?$!#-]/.test(ch)) {
      this.position++;
      return { kind: "special", name: ch };
    }
    return { kind: "literal", text: "$", quoted: true };
  }
  word(whole = false, heredoc = false): Word {
    const start = this.position;
    const parts: WordPart[] = [];
    let quote = heredoc ? '"' : "";
    let split = false;
    let buffer = "";
    if (!whole) {
      const assignment = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\n]*\])?\+?=/.exec(
        this.text.slice(this.position),
      );
      if (assignment) {
        if (
          /\[/.test(assignment[0]) &&
          !/^[A-Za-z_][A-Za-z0-9_]*\[[A-Za-z0-9_]+\]\+?=$/.test(assignment[0])
        )
          fail("unsupported-keyword", this.offset + start);
        buffer = assignment[0];
        this.position += buffer.length;
      }
    }
    const flush = () => {
      if (buffer) {
        parts.push({ kind: "literal", text: buffer, quoted: Boolean(quote) });
        buffer = "";
      }
    };
    while (this.position < this.text.length) {
      const ch = this.text[this.position] ?? "";
      if (
        !whole &&
        !quote &&
        (/\s/.test(ch) ||
          (operators.some((op) => this.text.startsWith(op, this.position)) &&
            !((ch === "<" || ch === ">") && this.text[this.position + 1] === "(")))
      )
        break;
      if (ch === "\\" && quote !== "'") {
        const next = this.text[this.position + 1];
        if (next === undefined) fail("syntax", this.offset + this.position);
        this.position += 2;
        if (next !== "\n") {
          flush();
          parts.push({
            kind: "literal",
            text:
              quote === '"' && !(heredoc ? /[\\$`]/ : /[\\$`"]/).test(next) ? `\\${next}` : next,
            quoted: true,
          });
        }
        continue;
      }
      if (!heredoc && ((ch === "'" && quote !== '"') || (ch === '"' && quote !== "'"))) {
        flush();
        if (quote === ch) quote = "";
        else {
          quote = ch;
          parts.push({ kind: "literal", text: "", quoted: true });
        }
        this.position++;
        continue;
      }
      if (!quote && ch === "$" && this.text[this.position + 1] === "'") {
        flush();
        parts.push(this.ansiQuote());
        continue;
      }
      if (quote !== "'" && ch === "$") {
        if (!quote) split = true;
        flush();
        parts.push(this.parameter(Boolean(quote)));
        continue;
      }
      if (quote !== "'" && ch === "`") {
        if (!quote) split = true;
        flush();
        this.position++;
        parts.push({
          kind: "command-substitution",
          body: this.substitution("`", this.position - 1),
        });
        continue;
      }
      if (!quote && (ch === "<" || ch === ">") && this.text[this.position + 1] === "(") {
        flush();
        this.position += 2;
        parts.push({
          kind: "process-substitution",
          body: this.substitution(")", this.position - 2),
        });
        continue;
      }
      if (
        !quote &&
        /[*?[]/.test(ch) &&
        !(
          ch === "[" &&
          this.position === start &&
          /[ \t\n]/.test(this.text[this.position + 1] ?? "")
        )
      ) {
        flush();
        parts.push({ kind: "glob", text: ch });
        this.position++;
        continue;
      }
      if (
        !heredoc &&
        !quote &&
        ch === "{" &&
        !/\s/.test(this.text[this.position + 1] ?? "") &&
        /[,]|\.\./.test(this.text.slice(this.position, this.text.indexOf("}", this.position) + 1))
      ) {
        const end = this.text.indexOf("}", this.position);
        const body = this.text.slice(this.position + 1, end);
        if (
          end < 0 ||
          !body.includes(",") ||
          !/^[A-Za-z0-9_.,/:-]*$/.test(body) ||
          body.includes("..")
        )
          fail("unsupported-keyword", this.offset + this.position);
        flush();
        parts.push({ kind: "brace", alternatives: body.split(",") });
        this.position = end + 1;
        continue;
      }
      buffer += ch;
      this.position++;
    }
    if (quote && !heredoc)
      fail("unterminated-quote", this.offset + start, this.offset + this.position);
    flush();
    return { split, parts, span: this.span(start) };
  }
  tokens(): Token[] {
    const result: Token[] = [];
    const pending: {
      index: number;
      delimiter: string;
      literal: boolean;
      tabs: boolean;
      start: number;
    }[] = [];
    while (this.position < this.text.length) {
      const ch = this.text[this.position] ?? "";
      if (ch === " " || ch === "\t" || ch === "\r") {
        this.position++;
        continue;
      }
      if (ch === "#") {
        while (this.position < this.text.length && this.text[this.position] !== "\n")
          this.position++;
        continue;
      }
      const start = this.position;
      if (ch === "\n") {
        this.position++;
        result.push({ kind: "op", text: ";", span: this.span(start) });
        for (const doc of pending.splice(0)) {
          let body = "";
          const bodyStart = this.position;
          let found = false;
          while (this.position < this.text.length) {
            const end = this.text.indexOf("\n", this.position);
            const lineEnd = end < 0 ? this.text.length : end;
            let line = this.text.slice(this.position, lineEnd);
            this.position = end < 0 ? this.text.length : end + 1;
            while (
              !doc.literal &&
              (line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1 &&
              this.position < this.text.length
            ) {
              const continuationEnd = this.text.indexOf("\n", this.position);
              line =
                line.slice(0, -1) +
                this.text.slice(
                  this.position,
                  continuationEnd < 0 ? this.text.length : continuationEnd,
                );
              this.position = continuationEnd < 0 ? this.text.length : continuationEnd + 1;
            }
            if (doc.tabs) line = line.replace(/^\t+/, "");
            if (line === doc.delimiter) {
              found = true;
              break;
            }
            body += `${line}${end < 0 ? "" : "\n"}`;
          }
          if (!found)
            fail("unterminated-heredoc", this.offset + doc.start, this.offset + this.position);
          const value = doc.literal
            ? literalWord(body, this.span(doc.start))
            : new Lexer(body, this.depth, this.offset + bodyStart).word(true, true);
          result[doc.index] = {
            kind: "heredoc",
            body: value,
            literal: doc.literal,
            span: this.span(doc.start),
          };
        }
        continue;
      }
      if (this.text.startsWith("<<", start) && !this.text.startsWith("<<<", start)) {
        this.position += 2;
        const tabs = this.text[this.position] === "-";
        if (tabs) this.position++;
        while (/[ \t]/.test(this.text[this.position] ?? "")) this.position++;
        const delimiterStart = this.position;
        const delimiter = this.word();
        const name = wordText(delimiter);
        if (name === undefined || !name) fail("syntax", this.offset + delimiterStart);
        pending.push({
          index: result.length,
          delimiter: name,
          literal: /['"\\]/.test(this.text.slice(delimiterStart, this.position)),
          tabs,
          start,
        });
        result.push({
          kind: "heredoc",
          body: literalWord(""),
          literal: false,
          span: this.span(start),
        });
        continue;
      }
      const op = operators.find((candidate) => this.text.startsWith(candidate, start));
      if (op && !((ch === "<" || ch === ">") && this.text[start + 1] === "(")) {
        this.position += op.length;
        result.push({ kind: "op", text: op, span: this.span(start) });
      } else {
        const word = this.word();
        if (this.position === start) fail("syntax", this.offset + start);
        result.push({ kind: "word", word });
      }
    }
    if (pending.length) fail("unterminated-heredoc", this.offset + (pending[0]?.start ?? 0));
    return result;
  }
}
class Parser {
  position = 0;
  constructor(
    readonly tokens: readonly Token[],
    readonly depth: number,
    readonly end: number,
  ) {}
  current(): Token | undefined {
    return this.tokens[this.position];
  }
  text(): string | undefined {
    const t = this.current();
    return t?.kind === "op"
      ? t.text
      : t?.kind === "word" && t.word.parts.every((part) => part.kind === "literal" && !part.quoted)
        ? wordText(t.word)
        : undefined;
  }
  take(text: string): boolean {
    if (this.text() !== text) return false;
    this.position++;
    return true;
  }
  require(text: string): void {
    if (!this.take(text)) fail("syntax", this.location());
  }
  location(): number {
    const t = this.current();
    return t?.kind === "word" ? t.word.span.start : (t?.span.start ?? this.end);
  }
  separators(): void {
    while (this.take(";") || this.take("&")) {
      /* separators */
    }
  }
  list(stops: readonly string[] = [], depth = this.depth): List {
    if (depth > MAX_PARSE_DEPTH) fail("depth-limit", this.location());
    const items: AndOr[] = [];
    this.separators();
    while (this.current() && !stops.includes(this.text() ?? "")) {
      const first = this.pipeline(depth);
      const rest: { op: "&&" | "||"; pipeline: Pipeline }[] = [];
      while (this.text() === "&&" || this.text() === "||") {
        const op = this.take("&&") ? "&&" : "||";
        if (op === "||") this.require("||");
        while (this.take(";")) {
          /* line continuation */
        }
        rest.push({ op, pipeline: this.pipeline(depth) });
      }
      items.push({ first, rest, background: this.text() === "&" });
      if (!this.current() || stops.includes(this.text() ?? "")) break;
      if (this.text() !== ";" && this.text() !== "&") fail("syntax", this.location());
      this.separators();
    }
    return { items };
  }
  pipeline(depth: number): Pipeline {
    const negated = this.take("!");
    const commands = [this.command(depth)];
    let stderr = false;
    while (true) {
      const stdoutOnly = this.take("|");
      const combined = !stdoutOnly && this.take("|&");
      if (!stdoutOnly && !combined) break;
      stderr ||= combined;
      while (this.take(";")) {
        /* newline */
      }
      commands.push(this.command(depth));
    }
    return { negated, stderr, commands };
  }
  word(): Word {
    const t = this.current();
    if (t?.kind !== "word") fail("syntax", this.location());
    this.position++;
    return t.word;
  }
  redirects(): Redirect[] {
    const result: Redirect[] = [];
    while (true) {
      const token = this.current();
      let fd: number | null = null;
      if (token?.kind === "heredoc") {
        this.position++;
        result.push({ kind: "heredoc", body: token.body, literal: token.literal, fd });
        continue;
      }
      let op = this.text();
      const next = this.tokens[this.position + 1];
      if (
        /^[0-9]+$/.test(op ?? "") &&
        token?.kind === "word" &&
        next?.kind === "heredoc" &&
        token.word.span.end === next.span.start
      ) {
        this.position += 2;
        result.push({ kind: "heredoc", body: next.body, literal: next.literal, fd: Number(op) });
        continue;
      }
      if (
        /^[0-9]+$/.test(op ?? "") &&
        next?.kind === "op" &&
        /^[<>]/.test(next.text) &&
        token?.kind === "word" &&
        token.word.span.end === next.span.start
      ) {
        fd = Number(op);
        this.position++;
        op = this.text();
      }
      if (!op || !["<", ">", ">>", "<>", ">|", "&>", "&>>", "<&", ">&", "<<<"].includes(op)) break;
      this.position++;
      const target = this.word();
      if (op === "<&" || op === ">&") {
        const text = wordText(target);
        if (!text || !/^(?:[0-9]+|-)$/.test(text)) fail("syntax", target.span.start);
        result.push({ kind: "duplicate", target: text, input: op === "<&", fd });
      } else if (op === "<<<") result.push({ kind: "herestring", body: target, fd });
      else
        result.push({
          kind: "file",
          fd,
          op:
            op === "&>" || op === "&>>" || op === "<" || op === "<>" || op === ">|"
              ? op
              : op.includes(">>")
                ? ">>"
                : ">",
          target,
        });
    }
    return result;
  }
  command(depth: number): Command {
    const start = this.location();
    const span = (): Span => ({ start, end: this.location() });
    if (["function", "coproc", "select", "(("].includes(this.text() ?? ""))
      fail("unsupported-keyword", start);
    if (
      this.tokens[this.position + 1]?.kind === "op" &&
      this.tokens[this.position + 1] &&
      this.textAt(this.position + 1) === "(" &&
      this.textAt(this.position + 2) === ")"
    )
      fail("function-definition", start);
    if (this.take("(") || this.take("{")) {
      const subshell = this.textAt(this.position - 1) === "(";
      const body = this.list([subshell ? ")" : "}"], depth + 1);
      this.require(subshell ? ")" : "}");
      return { kind: "group", subshell, body, redirects: this.redirects(), span: span() };
    }
    if (this.take("for")) {
      const name = wordText(this.word());
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail("syntax", start);
      this.require("in");
      const items: Word[] = [];
      while (this.current() && this.text() !== ";") items.push(this.word());
      this.separators();
      this.require("do");
      const body = this.list(["done"], depth + 1);
      this.require("done");
      return { kind: "for", name, items, body, redirects: this.redirects(), span: span() };
    }
    if (this.text() === "while" || this.text() === "until") {
      const kind = this.take("while") ? "while" : "until";
      if (kind === "until") this.require("until");
      const condition = this.list(["do"], depth + 1);
      this.require("do");
      const body = this.list(["done"], depth + 1);
      this.require("done");
      return { kind, condition, body, redirects: this.redirects(), span: span() };
    }
    if (this.take("if")) {
      const branches: { condition: List; body: List }[] = [];
      do {
        const condition = this.list(["then"], depth + 1);
        this.require("then");
        const body = this.list(["elif", "else", "fi"], depth + 1);
        branches.push({ condition, body });
      } while (this.take("elif"));
      const otherwise = this.take("else") ? this.list(["fi"], depth + 1) : null;
      this.require("fi");
      return { kind: "if", branches, otherwise, redirects: this.redirects(), span: span() };
    }
    if (this.take("case")) {
      const subject = this.word();
      this.require("in");
      this.separators();
      const arms: { patterns: Word[]; body: List }[] = [];
      while (this.current() && this.text() !== "esac") {
        this.take("(");
        const patterns = [this.word()];
        while (this.take("|")) patterns.push(this.word());
        this.require(")");
        const body = this.list([";;", "esac"], depth + 1);
        arms.push({ patterns, body });
        if (!this.take(";;") && this.text() !== "esac") fail("syntax", this.location());
        this.separators();
      }
      this.require("esac");
      return { kind: "case", subject, arms, redirects: this.redirects(), span: span() };
    }
    if (this.take("[[")) {
      const words: Word[] = [];
      while (this.current() && this.text() !== "]]") {
        const t = this.current();
        this.position++;
        if (t?.kind === "word") words.push(t.word);
        else if (t?.kind === "op") words.push(literalWord(t.text, t.span));
        else fail("syntax", this.location());
      }
      this.require("]]");
      return { kind: "test", words, span: span() };
    }
    if (["then", "do", "done", "fi", "else", "elif", "esac", "}", ")"].includes(this.text() ?? ""))
      fail("syntax", start);
    const assignments: Assignment[] = [];
    const argv: Word[] = [];
    const redirects: Redirect[] = [];
    while (this.current()) {
      const redirs = this.redirects();
      if (redirs.length) {
        redirects.push(...redirs);
        continue;
      }
      const token = this.current();
      if (token?.kind !== "word") break;
      this.position++;
      const first = token.word.parts[0];
      const binding =
        argv.length === 0 && first?.kind === "literal" && !first.quoted
          ? /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+)?=/.exec(first.text)
          : null;
      if (binding && first?.kind === "literal")
        assignments.push({
          name: binding[1] ?? "",
          operation: binding[2] || binding[3] ? "opaque" : "replace",
          exported: false,
          value: {
            ...token.word,
            parts: [
              { ...first, text: first.text.slice(binding[0].length) },
              ...token.word.parts.slice(1),
            ],
          },
        });
      else argv.push(token.word);
    }
    if (!assignments.length && !argv.length && !redirects.length) fail("syntax", start);
    return { kind: "simple", assignments, argv, redirects, span: span() };
  }
  textAt(index: number): string | undefined {
    const t = this.tokens[index];
    return t?.kind === "op"
      ? t.text
      : t?.kind === "word" && t.word.parts.every((part) => part.kind === "literal" && !part.quoted)
        ? wordText(t.word)
        : undefined;
  }
}
function parse(text: string, depth: number, offset: number): Script | ParseError {
  if (text.includes(String.fromCharCode(0)) || text.includes("\r"))
    return {
      kind: "parse-error",
      code: "syntax",
      span: { start: offset, end: offset + text.length },
    };
  if (depth > MAX_PARSE_DEPTH)
    return {
      kind: "parse-error",
      code: "depth-limit",
      span: { start: offset, end: offset + text.length },
    };
  if (
    text.length > MAX_SCRIPT_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_SCRIPT_BYTES
  )
    return {
      kind: "parse-error",
      code: "size-limit",
      span: { start: offset, end: offset + text.length },
    };
  try {
    const tokens = new Lexer(text, depth, offset).tokens();
    let units = tokens.length;
    for (const token of tokens) {
      units += token.kind === "word" ? token.word.parts.length : 1;
      if (units > MAX_ANALYSIS_UNITS) fail("work-limit", offset, offset + text.length);
    }
    const parser = new Parser(tokens, depth, offset + text.length);
    const body = parser.list();
    return {
      kind: "script",
      dialect: "bash",
      source: text,
      body,
      span: { start: offset, end: offset + text.length },
    };
  } catch (error) {
    if (error instanceof ParseFailure) return error.problem;
    throw error;
  }
}
export function parseBash(text: string): Script | ParseError {
  return parse(text, 0, 0);
}
