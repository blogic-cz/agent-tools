import { Effect, Schema } from "effect";

import { GitHubCommandError } from "#gh/errors";
import { detectSecrets } from "#guard";

const STDIN_SENTINEL = "-";
const SENSITIVE_PATH_PATTERNS = [
  /\.env(\..+)?$/,
  /\.envrc$/,
  /\.(pem|key|p12|pfx|cer|crt)$/i,
  /(?:^|[\\/])(credentials?|passwd|shadow)$/i,
];
const MissingMode = Schema.Literals(["error", "null", "default"]);

const readTextFromStdin = () => Bun.stdin.text();

export const isSensitivePath = (filePath: string) =>
  SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(filePath));

/** Inspect the final text, after shell expansion and after reading files or stdin. */
export function unsafeOutboundTextReason(
  text: string,
  environment: Record<string, string | undefined> = process.env,
): string | null {
  if (detectSecrets(text)) return "a credential pattern";

  const sensitiveName =
    /(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PSK)/i;
  const isSensitiveName = (name: string) =>
    name !== "PWD" && name !== "OLDPWD" && sensitiveName.test(name);
  for (const [name, value] of Object.entries(environment)) {
    if (isSensitiveName(name) && value && value.length >= 8 && text.includes(value)) {
      return "a credential from the process environment";
    }
  }

  const assignments = text.match(/^[A-Za-z_][A-Za-z0-9_]*=.*$/gm) ?? [];
  if (
    assignments.length >= 5 &&
    assignments.some((line) => isSensitiveName(line.split("=", 1)[0] ?? ""))
  ) {
    return "an environment dump";
  }
  return null;
}

export const validateOutboundText = (text: string, command: string) => {
  const reason = unsafeOutboundTextReason(text);
  return reason === null
    ? Effect.succeed(text)
    : Effect.fail(
        new GitHubCommandError({
          command,
          exitCode: 1,
          stderr: `Refusing to publish text containing ${reason}`,
          message: `Refusing to publish text containing ${reason}`,
        }),
      );
};

export const validateOutboundFile = (filePath: string, command: string) =>
  Effect.tryPromise({
    try: () => readTextFile(filePath),
    catch: () =>
      new GitHubCommandError({
        command,
        exitCode: 1,
        stderr: `Refusing to publish unreadable or sensitive file: ${filePath}`,
        message: `Refusing to publish unreadable or sensitive file: ${filePath}`,
      }),
  }).pipe(
    Effect.flatMap((text) => validateOutboundText(text, command)),
    Effect.asVoid,
  );

const readTextFile = (filePath: string) => {
  if (isSensitivePath(filePath)) {
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
  stdin?: boolean;
  valueFlag: string;
  fileFlag: string;
  stdinFlag?: string;
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
    stdin = false,
    stdinFlag,
    value,
    valueFlag,
  } = options;

  const sourceFlags = [valueFlag, fileFlag, ...(stdinFlag ? [stdinFlag] : [])];
  const sourceFlagList =
    sourceFlags.length === 2
      ? `${sourceFlags[0]} or ${sourceFlags[1]}`
      : `${sourceFlags.slice(0, -1).join(", ")}, or ${sourceFlags.at(-1)}`;

  const providedCount = [value !== null, fileValue !== null, stdin].filter(Boolean).length;
  if (providedCount > 1) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command,
        exitCode: 1,
        stderr: `Provide exactly one of ${sourceFlagList}`,
        message: `Provide exactly one of ${sourceFlagList}`,
      }),
    );
  }

  if (value !== null) {
    return yield* validateOutboundText(value, command);
  }

  if (fileValue !== null) {
    const source = fileValue === STDIN_SENTINEL ? "stdin" : fileValue;

    const text = yield* Effect.tryPromise({
      try: () => (fileValue === STDIN_SENTINEL ? readTextFromStdin() : readTextFile(fileValue)),
      catch: (error) =>
        new GitHubCommandError({
          command,
          exitCode: 1,
          stderr: `Failed to read ${label} from ${source}: ${error instanceof Error ? error.message : String(error)}`,
          message: `Failed to read ${label} from ${source}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
    return yield* validateOutboundText(text, command);
  }

  if (stdin) {
    const text = yield* Effect.tryPromise({
      try: () => readTextFromStdin(),
      catch: (error) =>
        new GitHubCommandError({
          command,
          exitCode: 1,
          stderr: `Failed to read ${label} from stdin: ${error instanceof Error ? error.message : String(error)}`,
          message: `Failed to read ${label} from stdin: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
    return yield* validateOutboundText(text, command);
  }

  if (missingMode === "null") {
    return null;
  }

  if (missingMode === "default") {
    return yield* validateOutboundText(missingValue ?? "", command);
  }

  return yield* Effect.fail(
    new GitHubCommandError({
      command,
      exitCode: 1,
      stderr: `Missing ${label}. Provide ${sourceFlagList}`,
      message: `Missing ${label}. Provide ${sourceFlagList}`,
    }),
  );
});

export const resolveRequiredTextInput = (
  options: Omit<ResolveTextInputOptions, "missingMode" | "missingValue">,
): Effect.Effect<string, GitHubCommandError> =>
  resolveTextInputInternal({
    ...options,
    missingMode: "error",
  }).pipe(Effect.map((resolvedValue) => ensureResolvedText(resolvedValue, "required text input")));

export const resolveOptionalTextInput = (
  options: Omit<ResolveTextInputOptions, "missingMode" | "missingValue">,
): Effect.Effect<string | null, GitHubCommandError> =>
  resolveTextInputInternal({
    ...options,
    missingMode: "null",
  });

export const resolveDefaultTextInput = (
  options: Omit<ResolveTextInputOptions, "missingMode" | "missingValue"> & {
    defaultValue: string;
  },
): Effect.Effect<string, GitHubCommandError> =>
  resolveTextInputInternal({
    ...options,
    missingMode: "default",
    missingValue: options.defaultValue,
  }).pipe(Effect.map((resolvedValue) => ensureResolvedText(resolvedValue, "default text input")));
