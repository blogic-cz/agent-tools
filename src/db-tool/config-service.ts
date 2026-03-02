import { Effect, Layer, ServiceMap } from "effect";

import { ConfigService, getToolConfig } from "#config";
import type { DatabaseConfig } from "#config";

/**
 * DbConfigService wraps the resolved DatabaseConfig for the selected profile.
 * Returns undefined when no database config is available — the service layer
 * returns a no-op implementation that produces clear error messages.
 *
 * Usage:
 *   const dbConfig = yield* DbConfigService;
 *   if (!dbConfig) { // no config }
 */
export class DbConfigService extends ServiceMap.Service<
  DbConfigService,
  DatabaseConfig | undefined
>()("@agent-tools/DbConfigService") {}

/**
 * Creates a DbConfigService layer that resolves the database config
 * from agent-tools.json5 using the given profile.
 * Succeeds with undefined when no config is found (allows --help to work).
 */
export function makeDbConfigLayer(profile?: string) {
  return Layer.effect(
    DbConfigService,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const dbConfig = getToolConfig<DatabaseConfig>(config, "database", profile);
      return dbConfig;
    }),
  );
}

export const DbConfigServiceLayer = makeDbConfigLayer();

export const TUNNEL_CHECK_INTERVAL_MS = 100;
