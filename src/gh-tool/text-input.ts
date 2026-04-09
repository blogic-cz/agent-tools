import { Effect } from "effect";

import { GitHubCommandError } from "#gh/errors";

const STDIN_SENTINEL = "-";

const readTextFromStdin = () => Bun.stdin.text();

const readTextFile = (filePath: string) => Bun.file(filePath).text();

type ResolveTextInputOptions = {
  command: string;
  value: string | null;
  fileValue: string | null;
  valueFlag: string;
  fileFlag: string;
  missingMode: "error" | "null" | "default";
  missingValue?: string;
  label: string;
};

const resolveTextInputInternal = Effect.fn("gh.resolveTextInputInternal")(function* (
  options: ResolveTextInputOptions,
) {
  const { command, fileFlag, fileValue, label, missingMode, missingValue, value, valueFlag } =
    options;

  if (value !== null && fileValue !== null) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command,
        exitCode: 1,
        stderr: `Provide exactly one of ${valueFlag} or ${fileFlag}`,
        message: `Provide exactly one of ${valueFlag} or ${fileFlag}`,
      }),
    );
  }

  if (value !== null) {
    return value;
  }

  if (fileValue !== null) {
    const source = fileValue === STDIN_SENTINEL ? "stdin" : fileValue;

    return yield* Effect.tryPromise({
      try: () => (fileValue === STDIN_SENTINEL ? readTextFromStdin() : readTextFile(fileValue)),
      catch: (error) =>
        new GitHubCommandError({
          command,
          exitCode: 1,
          stderr: `Failed to read ${label} from ${source}: ${error instanceof Error ? error.message : String(error)}`,
          message: `Failed to read ${label} from ${source}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
  }

  if (missingMode === "null") {
    return null;
  }

  if (missingMode === "default") {
    return missingValue ?? "";
  }

  return yield* Effect.fail(
    new GitHubCommandError({
      command,
      exitCode: 1,
      stderr: `Missing ${label}. Provide ${valueFlag} or ${fileFlag}`,
      message: `Missing ${label}. Provide ${valueFlag} or ${fileFlag}`,
    }),
  );
});

export const resolveRequiredTextInput = (
  command: string,
  value: string | null,
  fileValue: string | null,
  valueFlag: string,
  fileFlag: string,
  label: string,
): Effect.Effect<string, GitHubCommandError> =>
  resolveTextInputInternal({
    command,
    value,
    fileValue,
    valueFlag,
    fileFlag,
    missingMode: "error",
    label,
  }).pipe(Effect.map((resolvedValue) => resolvedValue ?? ""));

export const resolveOptionalTextInput = (
  command: string,
  value: string | null,
  fileValue: string | null,
  valueFlag: string,
  fileFlag: string,
  label: string,
): Effect.Effect<string | null, GitHubCommandError> =>
  resolveTextInputInternal({
    command,
    value,
    fileValue,
    valueFlag,
    fileFlag,
    missingMode: "null",
    label,
  });

export const resolveDefaultTextInput = (
  command: string,
  value: string | null,
  fileValue: string | null,
  valueFlag: string,
  fileFlag: string,
  label: string,
  defaultValue: string,
): Effect.Effect<string, GitHubCommandError> =>
  resolveTextInputInternal({
    command,
    value,
    fileValue,
    valueFlag,
    fileFlag,
    missingMode: "default",
    missingValue: defaultValue,
    label,
  }).pipe(Effect.map((resolvedValue) => resolvedValue ?? defaultValue));
