import { Context } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CheckResult } from "#gh/types";

const CACHE_TTL_MS = 30_000;
const WATCH_PENDING_TTL_MS = 5_000;
const CACHE_DIR = join(homedir(), ".cache", "agent-tools", "gh-check-status-v1");

export const CheckStatusCacheDirectory = Context.Reference<string | undefined>(
  "@agent-tools/CheckStatusCacheDirectory",
  { defaultValue: () => CACHE_DIR },
);

type CacheEntry = { fetchedAt: number; checks: CheckResult[] };

const keyFor = (identity: string, repo: string, pr: number, headSha: string) =>
  createHash("sha256")
    .update(`${identity}\n${repo.toLowerCase()}\n${pr}\n${headSha}`)
    .digest("hex");

const validChecks = (value: unknown): value is CheckResult[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      typeof item.name === "string" &&
      typeof item.state === "string" &&
      typeof item.bucket === "string" &&
      typeof item.link === "string",
  );

export const readCheckStatusCache = async (
  identity: string,
  repo: string,
  pr: number,
  headSha: string,
  now: number,
  watchPending = false,
  directory = CACHE_DIR,
): Promise<CheckResult[] | null> => {
  try {
    const prefix = keyFor(identity, repo, pr, headSha);
    const files = (await readdir(directory)).filter((name) => name.startsWith(`${prefix}.`));
    let latest: CacheEntry | null = null;
    const entries = await Promise.all(
      files.map(async (name) => {
        try {
          return {
            name,
            value: JSON.parse(await readFile(join(directory, name), "utf8")) as unknown,
          };
        } catch {
          return { name, value: null };
        }
      }),
    );
    const staleFiles: string[] = [];
    for (const { name, value: entry } of entries) {
      if (!name.endsWith(".json")) continue;
      if (entry === null || typeof entry !== "object") continue;
      const candidate = entry as Partial<CacheEntry>;
      const fetchedAt = candidate.fetchedAt;
      if (
        typeof fetchedAt !== "number" ||
        !Number.isFinite(fetchedAt) ||
        !validChecks(candidate.checks) ||
        candidate.checks.length === 0
      ) {
        staleFiles.push(join(directory, name));
        continue;
      }
      if (fetchedAt > now || now - fetchedAt > CACHE_TTL_MS) {
        staleFiles.push(join(directory, name));
        continue;
      }
      if (watchPending && !candidate.checks.some((check) => check.bucket === "pending")) continue;
      if (latest === null || fetchedAt > latest.fetchedAt)
        latest = { fetchedAt, checks: candidate.checks };
    }
    await Promise.all(staleFiles.map((path) => rm(path, { force: true }).catch(() => undefined)));
    if (latest === null || (watchPending && now - latest.fetchedAt > WATCH_PENDING_TTL_MS))
      return null;
    return latest.checks;
  } catch {
    return null;
  }
};

export const writeCheckStatusCache = async (
  identity: string,
  repo: string,
  pr: number,
  headSha: string,
  checks: CheckResult[],
  fetchedAt: number,
  directory = CACHE_DIR,
): Promise<void> => {
  if (checks.length === 0) return;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const path = join(directory, name);
          try {
            const entry: unknown = JSON.parse(await readFile(path, "utf8"));
            if (
              entry !== null &&
              typeof entry === "object" &&
              "fetchedAt" in entry &&
              typeof entry.fetchedAt === "number" &&
              Number.isFinite(entry.fetchedAt) &&
              fetchedAt - entry.fetchedAt <= CACHE_TTL_MS
            )
              return;
            await rm(path, { force: true });
          } catch {
            /* Another writer can remove a stale snapshot first. */
          }
        }),
    );
    const prefix = keyFor(identity, repo, pr, headSha);
    const temporary = join(directory, `${prefix}.${process.pid}.${randomUUID()}.tmp`);
    const destination = join(
      directory,
      `${prefix}.${fetchedAt}.${process.pid}.${randomUUID()}.json`,
    );
    await writeFile(temporary, JSON.stringify({ fetchedAt, checks } satisfies CacheEntry), {
      mode: 0o600,
    });
    await rename(temporary, destination);
  } catch {
    // A cache write must never replace a successful GitHub response with an error.
  }
};
