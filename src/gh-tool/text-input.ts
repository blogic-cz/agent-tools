import { Effect, Schema } from "effect";
import { realpath } from "node:fs/promises";

import { GitHubCommandError } from "#gh/errors";
import { unsafeOutboundTextReason } from "#shared/content-security";

export { unsafeOutboundTextReason } from "#shared/content-security";

const STDIN_SENTINEL = "-";
const SENSITIVE_PATH_PATTERNS = [
  /\.env(\..+)?$/,
  /\.envrc$/,
  /\.(pem|key|p12|pfx|cer|crt)$/i,
  /(?:^|[\\/])(credentials?|passwd|shadow)$/i,
  /(?:^|\/)(?:\.ssh|\.aws|\.kube|\.azure|secrets?|credentials?)(?:\/|$)/i,
  /(?:^|\/)(?:\.npmrc|\.netrc|\.git-credentials|\.sentryclirc|\.pypirc|\.pgpass)$/i,
  /(?:^|\/)\.docker\/config\.json$/i,
  /(?:^|\/)\.config\/gh\/hosts\.yml$/i,
  /(?:^|\/)GitHub CLI\/hosts\.yml$/i,
  /(?:^|\/)(?:kubeconfig(?:[.-].+)?|[^/]+\.kubeconfig)$/i,
];
const MissingMode = Schema.Literals(["error", "null", "default"]);

const readTextFromStdin = () => Bun.stdin.text();

export const isSensitivePath = (filePath: string) =>
  SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(filePath.replaceAll("\\", "/")));

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

export const readValidatedOutboundFile = (filePath: string, command: string) =>
  Effect.tryPromise({
    try: () => readAllowedFile(filePath),
    catch: () =>
      new GitHubCommandError({
        command,
        exitCode: 1,
        stderr: `Refusing to publish unreadable or sensitive file: ${filePath}`,
        message: `Refusing to publish unreadable or sensitive file: ${filePath}`,
      }),
  }).pipe(Effect.tap(({ text }) => validateOutboundText(text, command)));

export const validateOutboundFile = (filePath: string, command: string) =>
  readValidatedOutboundFile(filePath, command).pipe(Effect.asVoid);

const readTextFile = (filePath: string) => {
  return readAllowedFile(filePath).then(({ text }) => text);
};

const readAllowedFile = async (filePath: string) => {
  if (isSensitivePath(filePath)) throw new Error(`Refusing to read sensitive file: ${filePath}`);
  const resolvedPath = await realpath(filePath);
  if (isSensitivePath(resolvedPath))
    throw new Error(`Refusing to read sensitive file: ${resolvedPath}`);
  const bytes = await Bun.file(resolvedPath).bytes();
  return { bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
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
