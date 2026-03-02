import { Effect, Layer, ServiceMap } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "#src/config/loader";

/**
 * Resolves the OpenCode storage base path from config or default.
 * Session storage is global (not per-profile).
 */
export const resolveStoragePath = Effect.gen(function* () {
  const config = yield* Effect.tryPromise({
    try: () => loadConfig(),
    catch: () => undefined,
  });
  const storagePath =
    config?.session?.storagePath ?? join(homedir(), ".local/share/opencode/storage");
  return storagePath;
});

/**
 * Resolves the OpenCode messages directory path.
 */
export const resolveMessagesPath = Effect.gen(function* () {
  const basePath = yield* resolveStoragePath;
  return join(basePath, "message");
});

/**
 * Resolves the OpenCode sessions directory path.
 */
export const resolveSessionsPath = Effect.gen(function* () {
  const basePath = yield* resolveStoragePath;
  return join(basePath, "session");
});

/**
 * Context tag for resolved paths (cached during effect execution).
 */
export class ResolvedPaths extends ServiceMap.Service<
  ResolvedPaths,
  {
    readonly messagesPath: string;
    readonly sessionsPath: string;
  }
>()("@agent-tools/ResolvedPaths") {}

export const ResolvedPathsLayer = Layer.effect(
  ResolvedPaths,
  Effect.gen(function* () {
    const messagesPath = yield* resolveMessagesPath;
    const sessionsPath = yield* resolveSessionsPath;
    return { messagesPath, sessionsPath };
  }),
);
