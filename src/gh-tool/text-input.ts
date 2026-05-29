import { Effect, Schema } from "effect";

import { GitHubCommandError } from "#gh/errors";

const STDIN_SENTINEL = "-";
const SENSITIVE_PATH_PATTERNS = [/\.env(\..+)?$/, /\.envrc$/, /\.(pem|key|p12|pfx|cer|crt)$/i];
const MissingMode = Schema.Literals(["error", "null", "default"]);

const readTextFromStdin = () => Bun.stdin.text();

const readTextFile = (filePath: string) => {
  if (SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(filePath))) {
    return Promise.reject(new Error(`Refusing to read sensitive file: ${filePath}`));
  }

  return Bun.file(filePath).text();
};

const ensureResolvedText = (resolvedValue: string | null, context: string) => {
  if (resolvedValue === null) {
    throw new Error(`Invariant violation: ${context} resolved to null`);
  }

  return resolvedValue;
};

type ResolveTextInputOptions = {
  command: string;
  value: string | null;
  fileValue: string | null;
  stdin: boolean;
  valueFlag: string;
  fileFlag: string;
  stdinFlag: string;
  missingMode: Schema.Schema.Type<typeof MissingMode>;
  missingValue?: string;
  label: string;
};

const resolveTextInputInternal = Effect.fn("gh.resolveTextInputInternal")(function* (
  options: ResolveTextInputOptions,
) {
  const {
    command,
    fileFlag,
    fileValue,
    label,
    missingMode,
    missingValue,
    stdin,
    stdinFlag,
    value,
    valueFlag,
  } = options;

  const providedCount = [value !== null, fileValue !== null, stdin].filter(Boolean).length;
  if (providedCount > 1) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command,
        exitCode: 1,
        stderr: `Provide exactly one of ${valueFlag}, ${fileFlag}, or ${stdinFlag}`,
        message: `Provide exactly one of ${valueFlag}, ${fileFlag}, or ${stdinFlag}`,
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

  if (stdin) {
    return yield* Effect.tryPromise({
      try: () => readTextFromStdin(),
      catch: (error) =>
        new GitHubCommandError({
          command,
          exitCode: 1,
          stderr: `Failed to read ${label} from stdin: ${error instanceof Error ? error.message : String(error)}`,
          message: `Failed to read ${label} from stdin: ${error instanceof Error ? error.message : String(error)}`,
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
      stderr: `Missing ${label}. Provide ${valueFlag}, ${fileFlag}, or ${stdinFlag}`,
      message: `Missing ${label}. Provide ${valueFlag}, ${fileFlag}, or ${stdinFlag}`,
    }),
  );
});

export const resolveRequiredTextInput = (
  command: string,
  value: string | null,
  fileValue: string | null,
  stdin: boolean,
  valueFlag: string,
  fileFlag: string,
  stdinFlag: string,
  label: string,
): Effect.Effect<string, GitHubCommandError> =>
  resolveTextInputInternal({
    command,
    value,
    fileValue,
    stdin,
    valueFlag,
    fileFlag,
    stdinFlag,
    missingMode: "error",
    label,
  }).pipe(Effect.map((resolvedValue) => ensureResolvedText(resolvedValue, "required text input")));

export const resolveOptionalTextInput = (
  command: string,
  value: string | null,
  fileValue: string | null,
  stdin: boolean,
  valueFlag: string,
  fileFlag: string,
  stdinFlag: string,
  label: string,
): Effect.Effect<string | null, GitHubCommandError> =>
  resolveTextInputInternal({
    command,
    value,
    fileValue,
    stdin,
    valueFlag,
    fileFlag,
    stdinFlag,
    missingMode: "null",
    label,
  });

export const resolveDefaultTextInput = (
  command: string,
  value: string | null,
  fileValue: string | null,
  stdin: boolean,
  valueFlag: string,
  fileFlag: string,
  stdinFlag: string,
  label: string,
  defaultValue: string,
): Effect.Effect<string, GitHubCommandError> =>
  resolveTextInputInternal({
    command,
    value,
    fileValue,
    stdin,
    valueFlag,
    fileFlag,
    stdinFlag,
    missingMode: "default",
    missingValue: defaultValue,
    label,
  }).pipe(Effect.map((resolvedValue) => ensureResolvedText(resolvedValue, "default text input")));
