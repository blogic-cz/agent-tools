import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

// Homebrew keeps libpq keg-only, so psql is routinely installed yet absent from PATH.
const KEG_ONLY_PSQL_DIRECTORIES = ["/opt/homebrew/opt/libpq/bin", "/usr/local/opt/libpq/bin"];

export const PSQL_MISSING_HINT =
  "psql was not found on PATH. On macOS install it with `brew install libpq`; libpq is keg-only, so also add /opt/homebrew/opt/libpq/bin (Apple silicon) or /usr/local/opt/libpq/bin (Intel) to PATH.";

export const PSQL_SILENT_FAILURE_HINT =
  "psql exited with a non-zero code without writing any error output, so it is probably not a working client. Check `which psql`; on macOS prefer the keg-only libpq build in /opt/homebrew/opt/libpq/bin (Apple silicon) or /usr/local/opt/libpq/bin (Intel).";

// Mere existence let a directory, a dangling symlink or a stub suppress the keg-only fallback.
export const isExecutableFile = (candidate: string): boolean => {
  if (statSync(candidate, { throwIfNoEntry: false })?.isFile() !== true) {
    return false;
  }
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolvePsqlSearchPath = (
  pathEnv: string | undefined,
  fileExists: (candidate: string) => boolean = isExecutableFile,
): string | undefined => {
  const directories = (pathEnv ?? "").split(":").filter((directory) => directory.length > 0);
  if (directories.some((directory) => fileExists(join(directory, "psql")))) {
    return pathEnv;
  }

  const kegOnly = KEG_ONLY_PSQL_DIRECTORIES.find((directory) =>
    fileExists(join(directory, "psql")),
  );
  if (kegOnly === undefined) {
    return pathEnv;
  }

  return directories.length > 0 ? [...directories, kegOnly].join(":") : kegOnly;
};
