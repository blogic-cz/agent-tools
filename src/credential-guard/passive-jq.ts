/** Closed admission grammar, not an evaluator. Unknown syntax never acquires a proof. */
export function isPassiveJqFilter(filter: string): boolean {
  return admitFilter(filter, 0, new Set());
}

function admitFilter(
  filter: string,
  interpolationDepth: number,
  inherited: ReadonlySet<string>,
): boolean {
  const bindings = new Set(inherited);
  if (interpolationDepth > 32) return false;
  if (filter.length > 65_536) return false;
  if (new TextEncoder().encode(filter).byteLength > 65_536) return false;
  const tokens: string[] = [];
  const lexer =
    /\s+|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[$@]?[A-Za-z_][A-Za-z0-9_]*|\.[A-Za-z_][A-Za-z0-9_]*|\.\.|\/\/=|[|+*/%-]=|\/\/|==|!=|<=|>=|=|[.{}[\]():,;?|+*/%<>-]/y; // eslint-disable-line eslint/no-control-regex -- JSON strings exclude literal control bytes.
  let offset = 0;
  while (offset < filter.length) {
    if (filter[offset] === '"') {
      const quoted = readString(filter, offset, 0);
      if (!quoted) return false;
      tokens.push(filter.slice(offset, quoted.end));
      if (tokens.length > 4096) return false;
      offset = quoted.end;
      continue;
    }
    lexer.lastIndex = offset;
    const match = lexer.exec(filter);
    if (!match) return false;
    offset = lexer.lastIndex;
    if (!/^\s/.test(match[0])) tokens.push(match[0]);
    if (tokens.length > 4096) return false;
  }
  let position = 0;
  const take = (token: string): boolean => {
    if (tokens[position] !== token) return false;
    position++;
    return true;
  };
  const identifier = (token: string | undefined): boolean =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(token ?? "");
  const string = (token: string | undefined): boolean => {
    if (!token?.startsWith('"')) return false;
    const quoted = readString(token, 0, 0);
    return (
      quoted !== undefined &&
      quoted.interpolations.every(([start, end]) =>
        admitFilter(token.slice(start, end), interpolationDepth + 1, bindings),
      )
    );
  };
  const variable = (token: string | undefined): token is string =>
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(token ?? "") && token !== "$ENV";
  const number = (token: string | undefined): boolean => /^[0-9]/.test(token ?? "");
  const noArgs = new Set([
    "length",
    "keys",
    "keys_unsorted",
    "type",
    "values",
    "objects",
    "arrays",
    "strings",
    "numbers",
    "booleans",
    "nulls",
    "scalars",
    "iterables",
    "first",
    "last",
    "empty",
    "add",
    "min",
    "max",
    "sort",
    "unique",
    "flatten",
    "not",
    "reverse",
    "to_entries",
    "from_entries",
    "tostring",
    "tonumber",
    "tojson",
    "fromjson",
    "ascii_downcase",
    "ascii_upcase",
    "floor",
    "ceil",
    "round",
    "abs",
    "utf8bytelength",
    "@text",
    "@json",
    "@html",
    "@uri",
    "@csv",
    "@tsv",
    "@sh",
    "@base64",
    "@base64d",
  ]);
  const oneArg = new Set([
    "map",
    "map_values",
    "select",
    "contains",
    "has",
    "sort_by",
    "group_by",
    "unique_by",
    "any",
    "all",
    "join",
    "split",
    "startswith",
    "endswith",
    "ltrimstr",
    "rtrimstr",
    "test",
    "index",
    "rindex",
    "indices",
    "min_by",
    "max_by",
    "del",
    "with_entries",
    "getpath",
  ]);
  const multipleArgs = new Map<string, readonly number[]>([
    ["test", [1, 2]],
    ["match", [1, 2]],
    ["capture", [1, 2]],
    ["sub", [2, 3]],
    ["gsub", [2, 3]],
  ]);
  const operators = new Set([
    "=",
    "|=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "//=",
    "|",
    "//",
    "==",
    "!=",
    "<",
    ">",
    "<=",
    ">=",
    "+",
    "-",
    "*",
    "/",
    "%",
    "and",
    "or",
  ]);
  const expression = (depth: number, commas = false): boolean => {
    if (depth > 64 || !term(depth)) return false;
    while (true) {
      if (take("as")) {
        const name = tokens[position++];
        if (!variable(name) || !take("|")) return false;
        bindings.add(name);
      } else if (operators.has(tokens[position] ?? "") || (commas && tokens[position] === ",")) {
        position++;
      } else break;
      if (!term(depth)) return false;
    }
    return true;
  };
  const field = (): boolean => /^\.[A-Za-z_]/.test(tokens[position] ?? "");
  const term = (depth: number): boolean => {
    if (take("-")) return number(tokens[position]) && (position++, true);
    if (take("if")) {
      do {
        if (!expression(depth + 1) || !take("then") || !expression(depth + 1)) return false;
      } while (take("elif"));
      if (!take("else") || !expression(depth + 1) || !take("end")) return false;
    } else if (field()) {
      position++;
    } else if (take("..")) {
      // Recursive descent only selects values from the current input.
    } else if (take(".")) {
      if (string(tokens[position])) position++;
    } else if (take("(")) {
      if (!expression(depth + 1, true) || !take(")")) return false;
    } else if (take("[")) {
      if (!take("]") && (!expression(depth + 1, true) || !take("]"))) return false;
    } else if (take("{")) {
      if (!take("}")) {
        do {
          if (take("(")) {
            if (!expression(depth + 1) || !take(")") || !take(":") || !expression(depth + 1))
              return false;
          } else {
            const key = tokens[position];
            if (!identifier(key) && !string(key)) return false;
            position++;
            if (take(":")) {
              if (!expression(depth + 1)) return false;
            } else if (!identifier(key)) return false;
          }
        } while (take(","));
        if (!take("}")) return false;
      }
    } else {
      const token = tokens[position];
      if (
        (variable(token) && bindings.has(token)) ||
        string(token) ||
        number(token) ||
        ["true", "false", "null"].includes(token ?? "")
      )
        position++;
      else if (noArgs.has(token ?? "")) {
        position++;
        if (token?.startsWith("@") && string(tokens[position])) position++;
      } else if (oneArg.has(token ?? "") || multipleArgs.has(token ?? "")) {
        position++;
        if (!take("(") || !expression(depth + 1)) return false;
        let count = 1;
        while (take(";")) {
          count++;
          if (!expression(depth + 1)) return false;
        }
        if (!(multipleArgs.get(token ?? "") ?? [1]).includes(count) || !take(")")) return false;
      } else return false;
    }
    while (true) {
      if (take("?")) continue;
      if (field()) {
        position++;
        continue;
      }
      if (take(".")) {
        if (!string(tokens[position])) return false;
        position++;
      } else if (take("[")) {
        if (!take("]")) {
          if (tokens[position] !== ":" && !expression(depth + 1, true)) return false;
          if (take(":") && tokens[position] !== "]" && !expression(depth + 1)) return false;
          if (!take("]")) return false;
        }
      } else break;
    }
    return true;
  };
  return expression(0, true) && position === tokens.length;
}

function readString(
  text: string,
  start: number,
  depth: number,
): { end: number; interpolations: [number, number][] } | undefined {
  if (depth > 32) return undefined;
  const interpolations: [number, number][] = [];
  let offset = start + 1;
  while (offset < text.length) {
    const character = text[offset++];
    if (character === '"') return { end: offset, interpolations };
    if (!character || character.charCodeAt(0) < 32) return undefined;
    if (character !== "\\") continue;
    const escape = text[offset++];
    if (escape === "(") {
      const expressionStart = offset;
      let parentheses = 1;
      while (offset < text.length && parentheses > 0) {
        if (text[offset] === '"') {
          const nested = readString(text, offset, depth + 1);
          if (!nested) return undefined;
          offset = nested.end;
        } else {
          const token = text[offset++];
          if (token === "(") parentheses++;
          if (token === ")") parentheses--;
        }
      }
      if (parentheses !== 0) return undefined;
      interpolations.push([expressionStart, offset - 1]);
    } else if (escape === "u") {
      if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset, offset + 4))) return undefined;
      offset += 4;
    } else if (!escape || !'"\\/bfnrt'.includes(escape)) return undefined;
  }
  return undefined;
}

/** Only known formatting/input flags and one literal program, followed by file operands. */
export function passiveJqProgramIndex(argv: string[]): number | undefined {
  if (argv[0]?.split("/").at(-1) !== "jq") return undefined;
  const longOptions = new Set([
    "--raw-output",
    "--raw-input",
    "--compact-output",
    "--slurp",
    "--monochrome-output",
    "--color-output",
    "--null-input",
    "--exit-status",
    "--ascii-output",
    "--join-output",
    "--sort-keys",
    "--unbuffered",
    "--tab",
  ]);
  let index = 1;
  while (/^-[rRcMsScneaj]+$/.test(argv[index] ?? "") || longOptions.has(argv[index] ?? "")) index++;
  if (argv[index] === "--") index++;
  if (argv.slice(index + 1).some((arg) => arg.startsWith("-") && arg !== "-")) return undefined;
  return isPassiveJqFilter(argv[index] ?? "") ? index : undefined;
}
