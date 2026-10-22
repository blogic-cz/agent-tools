export function isPassiveSedProgram(text: string): boolean {
  let position = 0;
  let commands = 0;
  let groups = 0;
  const spaces = (): void => {
    while (position < text.length && /[ \t\r]/.test(text[position] ?? "")) position++;
  };
  const delimited = (delimiter: string): boolean => {
    while (position < text.length) {
      const ch = text[position++];
      if (ch === "\\") {
        if (position >= text.length || text[position] === "\n") return false;
        position++;
      } else if (ch === delimiter) return true;
      else if (ch === "\n") return false;
    }
    return false;
  };
  const address = (): boolean => {
    const number = /^[0-9]+/.exec(text.slice(position));
    if (number) {
      position += number[0].length;
      return true;
    }
    if (text[position] === "$") {
      position++;
      return true;
    }
    if (text[position] !== "/") return false;
    position++;
    return delimited("/");
  };
  while (position < text.length) {
    spaces();
    if (text[position] === ";" || text[position] === "\n") {
      position++;
      continue;
    }
    if (text[position] === "}") {
      if (groups === 0) return false;
      groups--;
      position++;
      continue;
    }
    if (position === text.length) break;
    if (/[0-9$/]/.test(text[position] ?? "")) {
      if (!address()) return false;
      spaces();
      if (text[position] === ",") {
        position++;
        spaces();
        const relative = /^\+[0-9]+/.exec(text.slice(position));
        if (relative) position += relative[0].length;
        else if (!address()) return false;
        spaces();
      }
    }
    if (text[position] === "!") {
      position++;
      spaces();
    }
    const command = text[position++];
    if (command === "{") {
      groups++;
      continue;
    }
    if (command === "s") {
      const delimiter = text[position++];
      if (!delimiter || /[\\\n\r]/.test(delimiter)) return false;
      if (!delimited(delimiter) || !delimited(delimiter)) return false;
      while (position < text.length && /[gp0-9iImM]/.test(text[position] ?? "")) position++;
    } else if (!command || !"pPdDnNgGhHx=".includes(command)) return false;
    commands++;
    spaces();
    if (position < text.length && ![";", "\n", "}"].includes(text[position] ?? "")) return false;
  }
  return commands > 0 && groups === 0;
}
