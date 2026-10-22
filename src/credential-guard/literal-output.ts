export function formatLiteralPrintf(argv: readonly string[]): string | null {
  const start = argv[0] === "--" ? 1 : 0;
  const format = argv[start];
  if (format !== "%s" && format !== "%s\\n" && format !== "%s ") return null;
  const suffix = format === "%s\\n" ? "\n" : format === "%s " ? " " : "";
  const args = argv.slice(start + 1);
  return (args.length ? args : [""]).map((word) => word + suffix).join("");
}
