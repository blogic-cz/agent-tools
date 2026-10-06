import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Schema } from "effect";
import { apiError } from "./errors";
import { decode } from "./types";
import type { OperatorConfig } from "./types";

async function privateDirectory(path: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(path)) throw apiError("CONFIG_INVALID");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
    throw apiError("CONFIG_INVALID");
}
export async function readPrivateFile(path: string): Promise<string> {
  try {
    await privateDirectory(dirname(path));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 1_000_000
      )
        throw apiError("CONFIG_INVALID");
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch {
    throw apiError("CONFIG_INVALID");
  }
}
export async function readSecretStore(path: string): Promise<Readonly<Record<string, string>>> {
  try {
    const secrets = decode(
      Schema.Record(Schema.String, Schema.String),
      JSON.parse(await readPrivateFile(path)),
    );
    if (
      Object.values(secrets).some(
        (value) =>
          !value ||
          value.length > 16384 ||
          value.includes("\r") ||
          value.includes("\n") ||
          value.includes(String.fromCharCode(0)),
      )
    )
      throw apiError("CREDENTIAL_UNAVAILABLE");
    return secrets;
  } catch {
    throw apiError("CREDENTIAL_UNAVAILABLE");
  }
}
export async function claimGrants(config: OperatorConfig): Promise<void> {
  try {
    await privateDirectory(config.grantUseDirectory);
    await Promise.all(
      config.grants.map(async (grant) => {
        const file = await open(
          join(config.grantUseDirectory, grant.digest),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile("used\n");
          await file.sync();
        } finally {
          await file.close();
        }
      }),
    );
    const directory = await open(
      config.grantUseDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    throw apiError(
      typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
        ? "GRANT_ALREADY_USED"
        : "GRANT_STORE_UNAVAILABLE",
    );
  }
}
