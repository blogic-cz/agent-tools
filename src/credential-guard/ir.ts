export type Span = { readonly start: number; readonly end: number };
export type Script = {
  readonly kind: "script";
  readonly dialect: "bash" | "powershell";
  readonly source: string;
  readonly body: List;
  readonly span: Span;
};
export type List = { readonly items: readonly AndOr[] };
export type AndOr = {
  readonly first: Pipeline;
  readonly background: boolean;
  readonly rest: readonly { readonly op: "&&" | "||"; readonly pipeline: Pipeline }[];
};
export type Pipeline = {
  readonly negated: boolean;
  readonly stderr: boolean;
  readonly commands: readonly Command[];
};
export type Command =
  | SimpleCommand
  | {
      readonly kind: "group";
      readonly subshell: boolean;
      readonly body: List;
      readonly redirects: readonly Redirect[];
      readonly span: Span;
    }
  | {
      readonly kind: "for";
      readonly name: string;
      readonly items: readonly Word[];
      readonly body: List;
      readonly redirects: readonly Redirect[];
      readonly span: Span;
    }
  | {
      readonly kind: "while";
      readonly condition: List;
      readonly body: List;
      readonly redirects: readonly Redirect[];
      readonly span: Span;
    }
  | {
      readonly kind: "until";
      readonly condition: List;
      readonly body: List;
      readonly redirects: readonly Redirect[];
      readonly span: Span;
    }
  | {
      readonly kind: "if";
      readonly branches: readonly { readonly condition: List; readonly body: List }[];
      readonly otherwise: List | null;
      readonly redirects: readonly Redirect[];
      readonly span: Span;
    }
  | {
      readonly kind: "case";
      readonly subject: Word;
      readonly arms: readonly { readonly patterns: readonly Word[]; readonly body: List }[];
      readonly redirects: readonly Redirect[];
      readonly span: Span;
    }
  | { readonly kind: "test"; readonly words: readonly Word[]; readonly span: Span };
export type SimpleCommand = {
  readonly kind: "simple";
  readonly assignments: readonly Assignment[];
  readonly argv: readonly Word[];
  readonly redirects: readonly Redirect[];
  readonly span: Span;
};
export type Assignment = {
  readonly operation: "replace" | "opaque";
  readonly name: string;
  readonly value: Word;
  readonly exported: boolean;
};
export type Word = {
  readonly split: boolean;
  readonly parts: readonly WordPart[];
  readonly span: Span;
};
export type WordPart =
  | { readonly kind: "literal"; readonly text: string; readonly quoted: boolean }
  | { readonly kind: "glob"; readonly text: string }
  | { readonly kind: "brace"; readonly alternatives: readonly string[] }
  | {
      readonly kind: "parameter";
      readonly name: string;
      readonly ambient: boolean;
      readonly operator: "plain" | "default" | "alternate" | "length";
      readonly operand: Word | null;
      readonly span: Span;
    }
  | { readonly kind: "special"; readonly name: string }
  | { readonly kind: "command-substitution"; readonly body: Script }
  | { readonly kind: "process-substitution"; readonly body: Script };
export type Redirect = (
  | {
      readonly kind: "file";
      readonly op: "<" | ">" | ">>" | "<>" | ">|" | "&>" | "&>>";
      readonly target: Word;
    }
  | { readonly kind: "duplicate"; readonly input: boolean; readonly target: string }
  | { readonly kind: "heredoc"; readonly body: Word; readonly literal: boolean }
  | { readonly kind: "herestring"; readonly body: Word }
) & { readonly fd: number | null };
export type ParseErrorCode =
  | "syntax"
  | "unterminated-quote"
  | "unterminated-heredoc"
  | "unterminated-substitution"
  | "function-definition"
  | "unsupported-keyword"
  | "indirect-expansion"
  | "unsupported-parameter-operator"
  | "depth-limit"
  | "size-limit"
  | "work-limit";
export type ParseError = {
  readonly kind: "parse-error";
  readonly code: ParseErrorCode;
  readonly span: Span;
};
export const MAX_ANALYSIS_UNITS = 4096;
export const MAX_PARSE_DEPTH = 8;
export const MAX_SCRIPT_BYTES = 262144;
export function literalWord(text: string, span: Span = { start: 0, end: 0 }): Word {
  return { split: false, parts: [{ kind: "literal", text, quoted: true }], span };
}
export function wordText(word: Word): string | undefined {
  let text = "";
  for (const part of word.parts) {
    if (part.kind !== "literal") return undefined;
    text += part.text;
  }
  return text;
}
