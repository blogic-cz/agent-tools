import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// Homebrew keeps libpq keg-only, so psql is routinely installed yet absent from PATH.
const KEG_ONLY_PSQL_DIRECTORIES = ["/opt/homebrew/opt/libpq/bin", "/usr/local/opt/libpq/bin"];

const PSQL_EXECUTABLES = ["psql", "psql.exe"];

export const PSQL_MISSING_HINT =
  "psql was not found on PATH. On macOS install it with `brew install libpq`; libpq is keg-only, so also add /opt/homebrew/opt/libpq/bin (Apple silicon) or /usr/local/opt/libpq/bin (Intel) to PATH.";

export const resolvePsqlSearchPath = (
  pathEnv: string | undefined,
  fileExists: (candidate: string) => boolean = existsSync,
): string | undefined => {
  const directories = (pathEnv ?? "").split(delimiter).filter((directory) => directory.length > 0);
  const containsPsql = (directory: string) =>
    PSQL_EXECUTABLES.some((executable) => fileExists(join(directory, executable)));

  if (directories.some(containsPsql)) {
    return pathEnv;
  }

  const kegOnly = KEG_ONLY_PSQL_DIRECTORIES.find(containsPsql);
  if (kegOnly === undefined) {
    return pathEnv;
  }

  return directories.length > 0 ? [...directories, kegOnly].join(delimiter) : kegOnly;
};
