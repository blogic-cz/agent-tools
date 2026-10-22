export function isPassiveAwkProgram(text: string): boolean {
  if (text.length > 65_536) return false;
  const tokens: string[] = [];
  const reserved = new Set([
    "BEGIN",
    "END",
    "if",
    "else",
    "for",
    "while",
    "do",
    "in",
    "print",
    "printf",
    "next",
    "nextfile",
    "exit",
    "break",
    "continue",
    "delete",
    "function",
    "getline",
    "system",
    "close",
    "fflush",
  ]);
  const variables = new Set([
    "NR",
    "FNR",
    "NF",
    "FILENAME",
    "RSTART",
    "RLENGTH",
    "SUBSEP",
    "FS",
    "RS",
    "OFS",
    "ORS",
    "OFMT",
    "CONVFMT",
  ]);
  const functions = new Set([
    "length",
    "substr",
    "index",
    "int",
    "tolower",
    "toupper",
    "split",
    "match",
    "sub",
    "gsub",
    "sprintf",
    "sqrt",
    "log",
    "exp",
  ]);
  const local = (token: string): boolean =>
    /^[a-z_][A-Za-z0-9_]*$/.test(token) && !reserved.has(token) && !functions.has(token);
  const constant = (token: string): boolean =>
    /^["0-9]/.test(token) || (token.startsWith("/") && token.length > 1);
  const lexer =
    /[ \t\r]+|\n|"(?:[^"\\\n]|\\[^\n])*"|[0-9]+(?:\.[0-9]+)?|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||==|!=|<=|>=|!~|\+\+|--|[+*%/-]=|[${}[\](),;!~+*%<>?:=-]/y;
  let offset = 0;
  let parentheses = 0;
  while (offset < text.length) {
    if (text[offset] === "/") {
      const previous = tokens.at(-1) ?? "";
      const division =
        constant(previous) ||
        variables.has(previous) ||
        functions.has(previous) ||
        local(previous) ||
        [")", "]", "++", "--"].includes(previous);
      if (division) {
        tokens.push(text[offset + 1] === "=" ? "/=" : "/");
        offset += text[offset + 1] === "=" ? 2 : 1;
      } else {
        const start = offset++;
        let closed = false;
        while (offset < text.length) {
          const ch = text[offset++];
          if (ch === "\\") {
            if (offset === text.length || text[offset] === "\n") return false;
            offset++;
          } else if (ch === "\n") return false;
          else if (ch === "/") {
            closed = true;
            break;
          }
        }
        if (!closed) return false;
        tokens.push(text.slice(start, offset));
      }
    } else {
      lexer.lastIndex = offset;
      const match = lexer.exec(text);
      if (!match) return false;
      offset = lexer.lastIndex;
      const token = match[0];
      if (token === "(") parentheses++;
      if (token === ")") parentheses--;
      if (token === "\n") {
        if (parentheses === 0) tokens.push(";");
      } else if (!/^\s/.test(token)) tokens.push(token);
    }
    if (tokens.length > 4096) return false;
  }
  let position = 0;
  const take = (token: string): boolean => {
    if (tokens[position] !== token) return false;
    position++;
    return true;
  };
  const operators = new Set([
    "&&",
    "||",
    "==",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "~",
    "!~",
    "+",
    "-",
    "*",
    "/",
    "%",
    "in",
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
  ]);
  const startsAtom = (): boolean => {
    const token = tokens[position] ?? "";
    return (
      constant(token) ||
      ["$", "("].includes(token) ||
      variables.has(token) ||
      local(token) ||
      functions.has(token)
    );
  };
  const atom = (depth: number): boolean => {
    if (depth > 64) return false;
    if (take("!") || take("-") || take("+") || take("++") || take("--")) return atom(depth + 1);
    if (take("$")) return atom(depth + 1);
    if (take("(")) return expression(depth + 1) && take(")");
    const token = tokens[position] ?? "";
    if (constant(token)) {
      position++;
      return true;
    }
    if (variables.has(token) || local(token)) {
      position++;
      if (tokens[position] === "(") return false;
      if (take("[")) {
        if (!expression(depth + 1)) return false;
        while (take(",")) if (!expression(depth + 1)) return false;
        if (!take("]")) return false;
      }
      if (!take("++")) take("--");
      return true;
    }
    if (!functions.has(token)) return false;
    position++;
    if (!take("(")) return token === "length";
    if (take(")")) return token === "length";
    if (!expression(depth + 1)) return false;
    while (take(",")) if (!expression(depth + 1)) return false;
    return take(")");
  };
  const expression = (depth: number, printing = false): boolean => {
    if (!atom(depth)) return false;
    while (true) {
      const operator = tokens[position] ?? "";
      if (operators.has(operator)) {
        if (printing && operator === ">") return false;
        position++;
        if (!atom(depth)) return false;
      } else if (take("?")) {
        return expression(depth + 1, printing) && take(":") && expression(depth + 1, printing);
      } else if (startsAtom()) {
        if (!atom(depth)) return false;
      } else return true;
    }
  };
  const block = (depth: number): boolean => {
    if (depth > 64 || !take("{")) return false;
    while (!take("}")) {
      if (take(";")) continue;
      if (!statement(depth + 1)) return false;
    }
    return true;
  };
  const statement = (depth: number): boolean => {
    if (depth > 64) return false;
    if (tokens[position] === "{") return block(depth + 1);
    if (take("if")) {
      if (!take("(") || !expression(depth + 1) || !take(")") || !statement(depth + 1)) return false;
      return !take("else") || statement(depth + 1);
    }
    if (take("for")) {
      if (!take("(") || !expression(depth + 1)) return false;
      if (take(";")) {
        if (!expression(depth + 1) || !take(";") || !expression(depth + 1)) return false;
      }
      return take(")") && statement(depth + 1);
    }
    if (take("print") || take("printf")) {
      if (![";", "}"].includes(tokens[position] ?? "")) {
        if (!expression(depth + 1, true)) return false;
        while (take(",")) if (!expression(depth + 1, true)) return false;
      }
    } else if (take("exit")) {
      if (![";", "}"].includes(tokens[position] ?? "") && !expression(depth + 1)) return false;
    } else if (!take("next") && !take("break") && !take("continue") && !expression(depth + 1))
      return false;
    return take(";") || tokens[position] === "}" || tokens[position] === "else";
  };
  let rules = 0;
  while (position < tokens.length) {
    if (take(";")) continue;
    if (tokens[position] !== "{") {
      if (!take("BEGIN") && !take("END") && !expression(0)) return false;
      if (take(",") && !expression(0)) return false;
    }
    rules++;
    if (tokens[position] === "{") {
      if (!block(0)) return false;
    } else if (position < tokens.length && !take(";")) return false;
  }
  return rules > 0;
}
