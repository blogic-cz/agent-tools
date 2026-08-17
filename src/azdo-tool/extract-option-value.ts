export function extractOptionValue(
  args: readonly string[],
  optionName: string,
): string | undefined {
  const optionIndex = args.findIndex((arg) => arg.toLowerCase() === optionName.toLowerCase());

  if (optionIndex === -1) {
    return undefined;
  }

  return args[optionIndex + 1];
}
