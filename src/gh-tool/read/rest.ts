import { Effect, Schema } from "effect";
import { GitHubService } from "#gh/service";
import { GitHubCommandError } from "#gh/errors";
import { cachedRead } from "./cache";
import { OPS } from "./classes";
import { digest } from "./keys";
import type { ReadKey } from "./keys";
import { parsePreserving } from "./porcelain";

const Page = Schema.Struct({
  path: Schema.String,
  etag: Schema.NullOr(Schema.String),
  body: Schema.Unknown,
});
const Snapshot = Schema.Struct({ pages: Schema.Array(Page) });
export type RestSnapshot = typeof Snapshot.Type;
export type RestSource =
  | { readonly path: string; readonly kind: "single" }
  | {
      readonly path: string;
      readonly kind: "pages";
      readonly items: (body: unknown) => readonly unknown[];
    };

export const restSnapshot = Effect.fn("reads.restSnapshot")(function* (
  key: ReadKey & { op: "prHead" | "checkSignal" | "issueComments" | "prComments" | "prReviews" },
  sources: readonly RestSource[],
  consistency: "cached" | "origin" = "cached",
) {
  const gh = yield* GitHubService;
  return yield* cachedRead({
    key,
    policy: OPS[key.op],
    consistency,
    decode: parsePreserving(Snapshot),
    fetch: (previous: { value: RestSnapshot } | null) =>
      Effect.gen(function* () {
        const pages: Array<typeof Page.Type> = [];
        let unchanged = previous !== null;
        for (const source of sources) {
          let page = 1;
          while (true) {
            const path =
              source.kind === "single"
                ? source.path
                : `${source.path}${source.path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
            const prior = previous?.value.pages.find((item) => item.path === path);
            const response = yield* gh.apiRequest<unknown>({
              path,
              ...(prior?.etag === null || prior?.etag === undefined
                ? {}
                : { ifNoneMatch: prior.etag }),
            });
            if (response.status === 304 && prior === undefined)
              return yield* new GitHubCommandError({
                command: `GET ${path}`,
                exitCode: 304,
                message: "304 without a cached page",
                stderr: "304 without a cached page",
              });
            const body =
              response.status === 304 && prior !== undefined ? prior.body : response.body;
            const etag = response.etag ?? (response.status === 304 ? (prior?.etag ?? null) : null);
            unchanged = unchanged && response.status === 304;
            pages.push({ path, etag, body });
            if (source.kind === "single") break;
            const count = yield* Effect.try({
              try: () => source.items(body).length,
              catch: (error) =>
                new GitHubCommandError({
                  command: `GET ${path}`,
                  exitCode: 0,
                  message: `Invalid paginated response: ${String(error)}`,
                  stderr: `Invalid paginated response: ${String(error)}`,
                }),
            });
            if (count < 100) break;
            page += 1;
          }
        }
        return unchanged
          ? { kind: "unchanged" as const }
          : { kind: "fresh" as const, value: { pages } };
      }),
  });
});

export const snapshotDigest = (snapshot: RestSnapshot): string =>
  digest(JSON.stringify(snapshot.pages.map((page) => page.body)));
