/** Closed admission grammar, not an evaluator. Unknown syntax never acquires a proof. */
export function isPassiveJqFilter(filter: string): boolean {
  if (filter.length > 65_536) return false;
  if (new TextEncoder().encode(filter).byteLength > 65_536) return false;
  const tokens: string[] = [];
  const lexer =
    /\s+|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_]*|\/\/|==|!=|<=|>=|[.{}[\]():,?|+*/%<>-]/y; // eslint-disable-line eslint/no-control-regex -- JSON strings exclude literal control bytes.
  let offset = 0;
  while (offset < filter.length) {
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
  const string = (token: string | undefined): boolean => token?.startsWith('"') === true;
  const number = (token: string | undefined): boolean => /^[0-9]/.test(token ?? "");
  const noArgs = new Set([
    "length",
    "keys",
    "keys_unsorted",
    "type",
    "values",
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
  ]);
  const operators = new Set([
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
    const nextOperator = () =>
      operators.has(tokens[position] ?? "") || (commas && tokens[position] === ",");
    while (nextOperator()) {
      position++;
      if (!term(depth)) return false;
    }
    return true;
  };
  const term = (depth: number): boolean => {
    if (take("-")) return number(tokens[position]) && (position++, true);
    if (take(".")) {
      if (identifier(tokens[position]) || string(tokens[position])) position++;
    } else if (take("(")) {
      if (!expression(depth + 1, true) || !take(")")) return false;
    } else if (take("[")) {
      if (!take("]") && (!expression(depth + 1, true) || !take("]"))) return false;
    } else if (take("{")) {
      if (!take("}")) {
        do {
          const key = tokens[position];
          if (!identifier(key) && !string(key)) return false;
          position++;
          if (take(":")) {
            if (!expression(depth + 1)) return false;
          } else if (!identifier(key)) return false;
        } while (take(","));
        if (!take("}")) return false;
      }
    } else {
      const token = tokens[position];
      if (string(token) || number(token) || ["true", "false", "null"].includes(token ?? ""))
        position++;
      else if (noArgs.has(token ?? "")) position++;
      else if (oneArg.has(token ?? "")) {
        position++;
        if (!take("(") || !expression(depth + 1) || !take(")")) return false;
      } else return false;
    }
    while (true) {
      if (take("?")) continue;
      if (take(".")) {
        if (!identifier(tokens[position]) && !string(tokens[position])) return false;
        position++;
      } else if (take("[")) {
        if (!take("]")) {
          if (take("-")) {
            if (!number(tokens[position])) return false;
            position++;
          } else if (string(tokens[position]) || number(tokens[position])) position++;
          else return false;
          if (!take("]")) return false;
        }
      } else break;
    }
    return true;
  };
  return expression(0, true) && position === tokens.length;
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
