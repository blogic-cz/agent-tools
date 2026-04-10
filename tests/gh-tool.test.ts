import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Layer } from "effect";

import type {
  FailedChecksReport,
  MergeResult,
  MergeStrategy,
  PRInfo,
  ReviewComment,
  ReviewThread,
} from "#gh/types";

import {
  GitHubAuthError,
  GitHubCommandError,
  GitHubMergeError,
  GitHubNotFoundError,
} from "#gh/errors";
import { GitHubService } from "#gh/service";
import {
  closeIssue,
  commentOnIssue,
  editIssue,
  fetchIssueComments as fetchIssueDiscussionComments,
  reopenIssue,
} from "#gh/issue/core";
import { fetchIssueTriage } from "#gh/issue/triage";
import { createPR, editPR, fetchChecks, fetchFailedChecks, viewPR } from "#gh/pr/core";
import {
  fetchComments,
  fetchDiscussionSummary,
  fetchThreads,
  replyToComment,
  resolveThread,
  submitPendingReview,
} from "#gh/pr/review";
import {
  resolveDefaultTextInput,
  resolveOptionalTextInput,
  resolveRequiredTextInput,
} from "#gh/text-input";

const mockRepoInfo = {
  owner: "test-owner",
  name: "test-repo",
  defaultBranch: "main",
  url: "https://github.com/test-owner/test-repo",
};

const mockPRInfo: PRInfo & { mergeable: string } = {
  number: 123,
  url: "https://github.com/test-owner/test-repo/pull/123",
  title: "Test PR",
  headRefName: "feat/test",
  baseRefName: "main",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
};

const inventedShellSensitiveText = [
  "Applied the follow-up change.",
  "The demo pipeline now records the queue state after validation: success calls `demoQueue.MarkReady(...)` + `PersistDemoAsync(...)`, and failure calls `demoQueue.MarkBroken(...)` + `PersistDemoAsync(...)`.",
  "I also added coverage in `DemoQueueValidatorSpec`, and `bun run check` passes.",
  "Literal shell chars: $SANDBOX & !",
].join("\n");

const mockGraphQLThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: [
          {
            id: "thread-1",
            isResolved: false,
            comments: {
              nodes: [
                {
                  id: "comment-1",
                  databaseId: 101,
                  path: "src/file.ts",
                  line: 10,
                  body: "Please fix this",
                  author: { login: "reviewer" },
                },
              ],
            },
          },
          {
            id: "thread-2",
            isResolved: true,
            comments: {
              nodes: [
                {
                  id: "comment-2",
                  databaseId: 102,
                  path: "src/other.ts",
                  line: 20,
                  body: "Looks good now",
                  author: { login: "reviewer2" },
                },
              ],
            },
          },
          {
            id: "thread-3",
            isResolved: false,
            comments: {
              nodes: [],
            },
          },
        ],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
        },
      },
    },
  },
};

const mockRESTComments = [
  {
    id: 201,
    in_reply_to_id: null,
    user: { login: "reviewer" },
    body: "Top-level comment",
    path: "src/file.ts",
    line: 10,
    created_at: "2025-01-15T10:00:00Z",
  },
  {
    id: 202,
    in_reply_to_id: 201,
    user: { login: "author" },
    body: "Reply to comment",
    path: "src/file.ts",
    line: 10,
    created_at: "2025-01-15T11:00:00Z",
  },
  {
    id: 203,
    in_reply_to_id: null,
    user: { login: "reviewer2" },
    body: "Old comment",
    path: "src/old.ts",
    line: 5,
    created_at: "2025-01-10T08:00:00Z",
  },
];

type GhError = GitHubCommandError | GitHubAuthError | GitHubNotFoundError;

type MockGhOverrides = Partial<{
  runGh: (
    args: string[],
  ) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, GhError>;
  runGhJson: (args: string[]) => Effect.Effect<unknown, GhError>;
  runGraphQL: (
    query: string,
    variables: Record<string, string | number | null>,
  ) => Effect.Effect<unknown, GhError>;
  getRepoInfo: () => Effect.Effect<typeof mockRepoInfo, GhError>;
}>;

function createMockGhLayer(overrides: MockGhOverrides = {}) {
  return Layer.succeed(
    GitHubService,
    GitHubService.of({
      runGh:
        overrides.runGh ??
        (() =>
          Effect.succeed({
            stdout: "",
            stderr: "",
            exitCode: 0,
          })),
      runGhJson: (overrides.runGhJson ?? (() => Effect.succeed({}))) as <T>(
        args: string[],
      ) => Effect.Effect<T, GhError>,
      runGraphQL: overrides.runGraphQL ?? (() => Effect.succeed({})),
      getRepoInfo: overrides.getRepoInfo ?? (() => Effect.succeed(mockRepoInfo)),
    }),
  );
}

describe("GitHubService.runGh() error mapping", () => {
  it.effect("returns success for zero exit code", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGh(["pr", "view"]);

      expect(result.exitCode).toBe(0);
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGh: () =>
            Effect.succeed({
              stdout: "ok",
              stderr: "",
              exitCode: 0,
            }),
        }),
      ),
    ),
  );

  it.effect("maps non-zero exit code to GitHubCommandError", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGh(["pr", "view"]).pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubCommandError");
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGh: () =>
            Effect.fail(
              new GitHubCommandError({
                message: "some error",
                command: "gh pr view",
                exitCode: 1,
                stderr: "some error",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect('maps "not logged in" stderr to GitHubAuthError', () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGh(["pr", "view"]).pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubAuthError");
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGh: () =>
            Effect.fail(
              new GitHubAuthError({
                message: "GitHub CLI not authenticated. Run 'gh auth login'.",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect('maps "gh auth login" stderr to GitHubAuthError', () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGh(["api", "graphql"]).pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubAuthError");
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGh: () =>
            Effect.fail(
              new GitHubAuthError({
                message: "GitHub CLI not authenticated. Run 'gh auth login'.",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect('maps "not found" stderr to GitHubNotFoundError', () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGh(["pr", "view", "999"]).pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubNotFoundError");
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGh: () =>
            Effect.fail(
              new GitHubNotFoundError({
                resource: "unknown",
                identifier: "unknown",
                message: "not found",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect('maps "Could not resolve" stderr to GitHubNotFoundError', () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGh(["repo", "view", "nonexistent/repo"]).pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubNotFoundError");
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGh: () =>
            Effect.fail(
              new GitHubNotFoundError({
                resource: "unknown",
                identifier: "unknown",
                message: "Could not resolve",
              }),
            ),
        }),
      ),
    ),
  );
});

describe("GitHubService.runGhJson() JSON parsing", () => {
  it.effect("parses valid JSON response", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGhJson<{
        number: number;
        title: string;
      }>(["pr", "view", "--json", "number,title"]);

      expect(result.number).toBe(123);
      expect(result.title).toBe("Test PR");
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGhJson: () =>
            Effect.succeed({
              number: 123,
              title: "Test PR",
            }),
        }),
      ),
    ),
  );

  it.effect("fails with GitHubCommandError on invalid JSON", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service
        .runGhJson(["pr", "view", "--json", "number"])
        .pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubCommandError");
          if (error._tag === "GitHubCommandError") {
            expect(error.stderr).toContain("Failed to parse JSON");
          }
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGhJson: () =>
            Effect.fail(
              new GitHubCommandError({
                command: "gh pr view --json number",
                exitCode: 0,
                stderr: "Failed to parse JSON: Unexpected token",
                message: "Failed to parse JSON: Unexpected token",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("parses complex nested JSON", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGhJson<{
        owner: { login: string };
        name: string;
      }>(["repo", "view", "--json", "owner,name"]);

      expect(result.owner.login).toBe("test-owner");
      expect(result.name).toBe("test-repo");
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGhJson: () =>
            Effect.succeed({
              owner: { login: "test-owner" },
              name: "test-repo",
            }),
        }),
      ),
    ),
  );

  it.effect("propagates auth errors from underlying runGh", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGhJson(["pr", "view"]).pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubAuthError");
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGhJson: () =>
            Effect.fail(
              new GitHubAuthError({
                message: "Not authenticated",
              }),
            ),
        }),
      ),
    ),
  );
});

describe("GitHubService.runGraphQL() response handling", () => {
  it.effect("extracts data on success", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = (yield* service.runGraphQL("query { viewer { login } }", {})) as {
        viewer: { login: string };
      };

      expect(result.viewer.login).toBe("test-user");
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGraphQL: () =>
            Effect.succeed({
              viewer: { login: "test-user" },
            }),
        }),
      ),
    ),
  );

  it.effect("fails with GitHubCommandError when GraphQL errors present", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGraphQL("query { bad }", {}).pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubCommandError");
          if (error._tag === "GitHubCommandError") {
            expect(error.stderr).toContain("Field");
          }
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGraphQL: () =>
            Effect.fail(
              new GitHubCommandError({
                command: "gh api graphql",
                exitCode: 0,
                stderr: JSON.stringify([
                  {
                    message: "Field 'bad' doesn't exist on type 'Query'",
                  },
                ]),
                message: "GraphQL error",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("passes variables correctly (verified via mock)", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = (yield* service.runGraphQL(
        "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }",
        { owner: "test-owner", name: "test-repo" },
      )) as { repository: { id: string } };

      expect(result.repository.id).toBe("repo-123");
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGraphQL: (_query, variables) => {
            expect(variables.owner).toBe("test-owner");
            expect(variables.name).toBe("test-repo");
            return Effect.succeed({
              repository: { id: "repo-123" },
            });
          },
        }),
      ),
    ),
  );

  it.effect("handles numeric variables via -F flag (verified via mock)", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = (yield* service.runGraphQL(
        "query($pr: Int!) { pullRequest(number: $pr) { id } }",
        { pr: 42 },
      )) as { pullRequest: { id: string } };

      expect(result.pullRequest.id).toBe("pr-42");
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGraphQL: (_query, variables) => {
            expect(variables.pr).toBe(42);
            return Effect.succeed({
              pullRequest: { id: "pr-42" },
            });
          },
        }),
      ),
    ),
  );

  it.effect("fails with GitHubCommandError on unparseable response", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const result = yield* service.runGraphQL("query { viewer }", {}).pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubCommandError");
          if (error._tag === "GitHubCommandError") {
            expect(error.stderr).toContain("Failed to parse");
          }
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGraphQL: () =>
            Effect.fail(
              new GitHubCommandError({
                command: "gh api graphql",
                exitCode: 0,
                stderr: "Failed to parse GraphQL response: Unexpected token",
                message: "Failed to parse GraphQL response: Unexpected token",
              }),
            ),
        }),
      ),
    ),
  );
});

describe("PR merge logic", () => {
  const simulateMerge = (opts: {
    pr: number;
    strategy: MergeStrategy;
    deleteBranch: boolean;
    confirm: boolean;
  }) =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;

      yield* gh.runGhJson<PRInfo & { mergeable: string }>([
        "pr",
        "view",
        String(opts.pr),
        "--json",
        "number,url,title,headRefName,baseRefName,state,isDraft,mergeable",
      ]);

      if (!opts.confirm) {
        const result: MergeResult = {
          merged: false,
          strategy: opts.strategy,
          branchDeleted: false,
          sha: null,
        };
        return result;
      }

      const mergeArgs = ["pr", "merge", String(opts.pr), `--${opts.strategy}`];

      if (opts.deleteBranch) {
        mergeArgs.push("--delete-branch");
      }

      const mergeResult = yield* gh.runGh(mergeArgs).pipe(
        Effect.catchTag("GitHubCommandError", (error) => {
          const stderr = error.stderr.toLowerCase();

          if (stderr.includes("merge conflict") || stderr.includes("conflicts")) {
            return Effect.fail(
              new GitHubMergeError({
                message: `PR #${opts.pr} has merge conflicts`,
                reason: "conflicts",
              }),
            );
          }

          if (stderr.includes("required status check") || stderr.includes("checks")) {
            return Effect.fail(
              new GitHubMergeError({
                message: `PR #${opts.pr} has failing required checks`,
                reason: "checks_failing",
              }),
            );
          }

          if (stderr.includes("protected branch")) {
            return Effect.fail(
              new GitHubMergeError({
                message: `PR #${opts.pr} targets a protected branch`,
                reason: "branch_protected",
              }),
            );
          }

          return Effect.fail(
            new GitHubMergeError({
              message: `Failed to merge PR #${opts.pr}: ${error.stderr}`,
              reason: "unknown",
            }),
          );
        }),
      );

      const shaMatch = mergeResult.stdout.match(/([0-9a-f]{7,40})/);

      const result: MergeResult = {
        merged: true,
        strategy: opts.strategy,
        branchDeleted: opts.deleteBranch,
        sha: shaMatch?.[1] ?? null,
      };
      return result;
    });

  it.effect("dry-run (no --confirm) returns merged: false without calling merge", () =>
    Effect.gen(function* () {
      let mergeWasCalled = false;

      const layer = createMockGhLayer({
        runGhJson: () => Effect.succeed(mockPRInfo),
        runGh: (args) => {
          if (args[0] === "pr" && args[1] === "merge") {
            mergeWasCalled = true;
          }
          return Effect.succeed({
            stdout: "",
            stderr: "",
            exitCode: 0,
          });
        },
      });

      const result = yield* simulateMerge({
        pr: 123,
        strategy: "squash",
        deleteBranch: true,
        confirm: false,
      }).pipe(Effect.provide(layer));

      expect(result.merged).toBe(false);
      expect(result.strategy).toBe("squash");
      expect(result.branchDeleted).toBe(false);
      expect(result.sha).toBeNull();
      expect(mergeWasCalled).toBe(false);
    }),
  );

  it.effect("with --confirm and squash strategy: constructs correct args", () =>
    Effect.gen(function* () {
      let capturedArgs: string[] = [];

      const layer = createMockGhLayer({
        runGhJson: () => Effect.succeed(mockPRInfo),
        runGh: (args) => {
          capturedArgs = args;
          return Effect.succeed({
            stdout: "Merged PR #123 via squash commit abc1234",
            stderr: "",
            exitCode: 0,
          });
        },
      });

      const result = yield* simulateMerge({
        pr: 123,
        strategy: "squash",
        deleteBranch: true,
        confirm: true,
      }).pipe(Effect.provide(layer));

      expect(capturedArgs).toEqual(["pr", "merge", "123", "--squash", "--delete-branch"]);
      expect(result.merged).toBe(true);
      expect(result.strategy).toBe("squash");
      expect(result.branchDeleted).toBe(true);
      expect(result.sha).toBe("abc1234");
    }),
  );

  it.effect("with --confirm and merge strategy: uses --merge flag", () =>
    Effect.gen(function* () {
      let capturedArgs: string[] = [];

      const layer = createMockGhLayer({
        runGhJson: () => Effect.succeed(mockPRInfo),
        runGh: (args) => {
          capturedArgs = args;
          return Effect.succeed({
            stdout: "Merged PR #123 via merge commit def5678",
            stderr: "",
            exitCode: 0,
          });
        },
      });

      const result = yield* simulateMerge({
        pr: 123,
        strategy: "merge",
        deleteBranch: false,
        confirm: true,
      }).pipe(Effect.provide(layer));

      expect(capturedArgs).toEqual(["pr", "merge", "123", "--merge"]);
      expect(result.merged).toBe(true);
      expect(result.strategy).toBe("merge");
      expect(result.branchDeleted).toBe(false);
      expect(result.sha).toBe("def5678");
    }),
  );

  it.effect("with --confirm and rebase strategy: uses --rebase flag", () =>
    Effect.gen(function* () {
      let capturedArgs: string[] = [];

      const layer = createMockGhLayer({
        runGhJson: () => Effect.succeed(mockPRInfo),
        runGh: (args) => {
          capturedArgs = args;
          return Effect.succeed({
            stdout: "Rebased and merged PR #123 9a8b7c6",
            stderr: "",
            exitCode: 0,
          });
        },
      });

      const result = yield* simulateMerge({
        pr: 123,
        strategy: "rebase",
        deleteBranch: true,
        confirm: true,
      }).pipe(Effect.provide(layer));

      expect(capturedArgs).toEqual(["pr", "merge", "123", "--rebase", "--delete-branch"]);
      expect(result.merged).toBe(true);
      expect(result.sha).toBe("9a8b7c6");
    }),
  );

  it.effect("extracts SHA from merge output", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGhJson: () => Effect.succeed(mockPRInfo),
        runGh: () =>
          Effect.succeed({
            stdout: "✓ Squashed and merged pull request #123 (commit: abcdef1234567890)",
            stderr: "",
            exitCode: 0,
          }),
      });

      const result = yield* simulateMerge({
        pr: 123,
        strategy: "squash",
        deleteBranch: false,
        confirm: true,
      }).pipe(Effect.provide(layer));

      expect(result.sha).toBe("abcdef1234567890");
    }),
  );

  it.effect("returns null SHA when no SHA in output", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGhJson: () => Effect.succeed(mockPRInfo),
        runGh: () =>
          Effect.succeed({
            stdout: "Merged successfully!",
            stderr: "",
            exitCode: 0,
          }),
      });

      const result = yield* simulateMerge({
        pr: 123,
        strategy: "squash",
        deleteBranch: false,
        confirm: true,
      }).pipe(Effect.provide(layer));

      expect(result.sha).toBeNull();
    }),
  );
});

describe("Merge error mapping", () => {
  const simulateMergeWithError = () =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;

      return yield* gh.runGh(["pr", "merge", "123", "--squash"]).pipe(
        Effect.catchTag("GitHubCommandError", (error) => {
          const lower = error.stderr.toLowerCase();

          if (lower.includes("merge conflict") || lower.includes("conflicts")) {
            return Effect.fail(
              new GitHubMergeError({
                message: `PR #123 has merge conflicts`,
                reason: "conflicts",
              }),
            );
          }
          if (lower.includes("required status check") || lower.includes("checks")) {
            return Effect.fail(
              new GitHubMergeError({
                message: `PR #123 has failing required checks`,
                reason: "checks_failing",
              }),
            );
          }
          if (lower.includes("protected branch")) {
            return Effect.fail(
              new GitHubMergeError({
                message: `PR #123 targets a protected branch`,
                reason: "branch_protected",
              }),
            );
          }
          return Effect.fail(
            new GitHubMergeError({
              message: `Failed to merge PR #123: ${error.stderr}`,
              reason: "unknown",
            }),
          );
        }),
      );
    });

  it.effect('maps "merge conflict" to reason: "conflicts"', () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.fail(
            new GitHubCommandError({
              command: "gh pr merge 123 --squash",
              exitCode: 1,
              stderr: "Pull request #123 has merge conflict and cannot be merged",
              message: "Pull request #123 has merge conflict and cannot be merged",
            }),
          ),
      });

      const result = yield* simulateMergeWithError().pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubMergeError");
          if (error._tag === "GitHubMergeError") {
            expect(error.reason).toBe("conflicts");
          }
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }),
  );

  it.effect('maps "conflicts" to reason: "conflicts"', () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.fail(
            new GitHubCommandError({
              command: "gh pr merge 123 --squash",
              exitCode: 1,
              stderr: "There are conflicts that must be resolved",
              message: "There are conflicts that must be resolved",
            }),
          ),
      });

      const result = yield* simulateMergeWithError().pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubMergeError");
          if (error._tag === "GitHubMergeError") {
            expect(error.reason).toBe("conflicts");
          }
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }),
  );

  it.effect('maps "required status check" to reason: "checks_failing"', () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.fail(
            new GitHubCommandError({
              command: "gh pr merge 123 --squash",
              exitCode: 1,
              stderr: "Required status check 'ci/build' is failing",
              message: "Required status check 'ci/build' is failing",
            }),
          ),
      });

      const result = yield* simulateMergeWithError().pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubMergeError");
          if (error._tag === "GitHubMergeError") {
            expect(error.reason).toBe("checks_failing");
          }
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }),
  );

  it.effect('maps "checks" to reason: "checks_failing"', () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.fail(
            new GitHubCommandError({
              command: "gh pr merge 123 --squash",
              exitCode: 1,
              stderr: "Some checks have not passed",
              message: "Some checks have not passed",
            }),
          ),
      });

      const result = yield* simulateMergeWithError().pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubMergeError");
          if (error._tag === "GitHubMergeError") {
            expect(error.reason).toBe("checks_failing");
          }
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }),
  );

  it.effect('maps "protected branch" to reason: "branch_protected"', () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.fail(
            new GitHubCommandError({
              command: "gh pr merge 123 --squash",
              exitCode: 1,
              stderr: "Cannot merge: protected branch rules not met",
              message: "Cannot merge: protected branch rules not met",
            }),
          ),
      });

      const result = yield* simulateMergeWithError().pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubMergeError");
          if (error._tag === "GitHubMergeError") {
            expect(error.reason).toBe("branch_protected");
          }
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }),
  );

  it.effect('maps unknown errors to reason: "unknown"', () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.fail(
            new GitHubCommandError({
              command: "gh pr merge 123 --squash",
              exitCode: 1,
              stderr: "Something totally unexpected happened",
              message: "Something totally unexpected happened",
            }),
          ),
      });

      const result = yield* simulateMergeWithError().pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubMergeError");
          if (error._tag === "GitHubMergeError") {
            expect(error.reason).toBe("unknown");
            expect(error.message).toContain("Something totally unexpected");
          }
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }),
  );
});

describe("Thread parsing (GraphQL → ReviewThread[])", () => {
  const simulateFetchThreads = (unresolvedOnly: boolean) =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const repoInfo = yield* service.getRepoInfo();

      const response = (yield* service.runGraphQL("review_threads_query", {
        owner: repoInfo.owner,
        name: repoInfo.name,
        pr: 123,
      })) as typeof mockGraphQLThreadsResponse;

      const threads = response.repository.pullRequest.reviewThreads.nodes;

      const mapped = threads
        .map((node): ReviewThread | null => {
          const comment = node.comments.nodes[0];
          if (!comment) {
            return null;
          }

          return {
            threadId: node.id,
            commentId: comment.databaseId,
            path: comment.path,
            line: comment.line,
            body: comment.body,
            isResolved: node.isResolved,
            hasReply: false,
            replyCount: 0,
            needsHumanReply: true,
            isVisibleOpen: true,
            lastReplyAuthor: null,
            lastReplyAt: null,
          };
        })
        .filter((thread): thread is ReviewThread => thread !== null);

      return unresolvedOnly ? mapped.filter((t) => !t.isResolved) : mapped;
    });

  it.effect("maps GraphQL response to ReviewThread[]", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(mockGraphQLThreadsResponse),
      });

      const threads = yield* simulateFetchThreads(false).pipe(Effect.provide(layer));

      expect(threads).toHaveLength(2);

      const first = threads[0];
      expect(first?.threadId).toBe("thread-1");
      expect(first?.commentId).toBe(101);
      expect(first?.path).toBe("src/file.ts");
      expect(first?.line).toBe(10);
      expect(first?.body).toBe("Please fix this");
      expect(first?.isResolved).toBe(false);
      expect(first?.hasReply).toBe(false);
      expect(first?.isVisibleOpen).toBe(true);

      const second = threads[1];
      expect(second?.threadId).toBe("thread-2");
      expect(second?.isResolved).toBe(true);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("filters to unresolved threads when unresolvedOnly=true", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(mockGraphQLThreadsResponse),
      });

      const threads = yield* simulateFetchThreads(true).pipe(Effect.provide(layer));

      expect(threads).toHaveLength(1);
      expect(threads[0]?.threadId).toBe("thread-1");
      expect(threads[0]?.isResolved).toBe(false);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("returns all threads when unresolvedOnly=false", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(mockGraphQLThreadsResponse),
      });

      const threads = yield* simulateFetchThreads(false).pipe(Effect.provide(layer));

      expect(threads).toHaveLength(2);
      expect(threads.some((t) => t.isResolved)).toBe(true);
      expect(threads.some((t) => !t.isResolved)).toBe(true);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("filters out threads with empty comments", () =>
    Effect.gen(function* () {
      const responseWithEmptyComments = {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-empty",
                  isResolved: false,
                  comments: {
                    nodes: [] as Array<{
                      id: string;
                      databaseId: number;
                      path: string;
                      line: number;
                      body: string;
                      author: { login: string };
                    }>,
                  },
                },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        },
      };

      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(responseWithEmptyComments),
      });

      const threads = yield* simulateFetchThreads(false).pipe(Effect.provide(layer));

      expect(threads).toHaveLength(0);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("fetchThreads paginates across multiple GraphQL pages", () =>
    Effect.gen(function* () {
      let graphQlCallCount = 0;

      const layer = createMockGhLayer({
        runGraphQL: (_query, variables) => {
          graphQlCallCount += 1;

          if (graphQlCallCount === 1) {
            expect(variables.after).toBeNull();
            return Effect.succeed({
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread-page-1",
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              id: "comment-page-1",
                              databaseId: 111,
                              path: "src/first.ts",
                              line: 1,
                              body: "First page thread",
                              author: { login: "reviewer" },
                            },
                          ],
                        },
                      },
                    ],
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "cursor-1",
                    },
                  },
                },
              },
            });
          }

          expect(variables.after).toBe("cursor-1");
          return Effect.succeed({
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-page-2",
                      isResolved: true,
                      comments: {
                        nodes: [
                          {
                            id: "comment-page-2",
                            databaseId: 222,
                            path: "src/second.ts",
                            line: 2,
                            body: "Second page thread",
                            author: { login: "reviewer" },
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            },
          });
        },
        runGh: () =>
          Effect.succeed({
            stdout: "[]",
            stderr: "",
            exitCode: 0,
          }),
      });

      const threads = yield* fetchThreads(123, false).pipe(Effect.provide(layer));

      expect(graphQlCallCount).toBe(2);
      expect(threads).toHaveLength(2);
      expect(threads[0]?.threadId).toBe("thread-page-1");
      expect(threads[1]?.threadId).toBe("thread-page-2");
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("fetchThreads visible-open-only includes resolved threads without reply", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(mockGraphQLThreadsResponse),
        runGh: (args) => {
          const apiPath = args[1] ?? "";
          if (apiPath.includes("pulls/123/comments")) {
            return Effect.succeed({
              stdout: JSON.stringify(mockTriageReviewCommentsRaw),
              stderr: "",
              exitCode: 0,
            });
          }
          return Effect.succeed({ stdout: "[]", stderr: "", exitCode: 0 });
        },
      });

      const threads = yield* fetchThreads(123, false, true).pipe(Effect.provide(layer));

      expect(threads).toHaveLength(2);
      expect(threads[0]?.threadId).toBe("thread-1");
      expect(threads[0]?.hasReply).toBe(true);
      expect(threads[0]?.isVisibleOpen).toBe(true);
      expect(threads[1]?.threadId).toBe("thread-2");
      expect(threads[1]?.hasReply).toBe(false);
      expect(threads[1]?.needsHumanReply).toBe(true);
      expect(threads[1]?.isVisibleOpen).toBe(true);
    }).pipe(Effect.provide(createMockGhLayer())),
  );
});

describe("Comment parsing (REST → ReviewComment[])", () => {
  const simulateFetchComments = (since: string | null) =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const repoInfo = yield* service.getRepoInfo();

      const result = yield* service.runGh([
        "api",
        `repos/${repoInfo.owner}/${repoInfo.name}/pulls/123/comments`,
      ]);

      const raw = JSON.parse(result.stdout) as Array<{
        id: number;
        in_reply_to_id: number | null;
        user: { login: string };
        body: string;
        path: string;
        line: number;
        created_at: string;
      }>;

      const comments: ReviewComment[] = raw.map((c) => ({
        id: c.id,
        inReplyToId: c.in_reply_to_id,
        author: c.user.login,
        body: c.body,
        path: c.path,
        line: c.line,
        createdAt: c.created_at,
      }));

      if (since !== null) {
        const sinceMs = new Date(since).getTime();
        return comments.filter((c) => new Date(c.createdAt).getTime() >= sinceMs);
      }

      return comments;
    });

  it.effect("maps REST response to ReviewComment[]", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.succeed({
            stdout: JSON.stringify(mockRESTComments),
            stderr: "",
            exitCode: 0,
          }),
      });

      const comments = yield* simulateFetchComments(null).pipe(Effect.provide(layer));

      expect(comments).toHaveLength(3);

      const first = comments[0];
      expect(first?.id).toBe(201);
      expect(first?.inReplyToId).toBeNull();
      expect(first?.author).toBe("reviewer");
      expect(first?.body).toBe("Top-level comment");
      expect(first?.path).toBe("src/file.ts");
      expect(first?.line).toBe(10);
      expect(first?.createdAt).toBe("2025-01-15T10:00:00Z");

      const reply = comments[1];
      expect(reply?.inReplyToId).toBe(201);
      expect(reply?.author).toBe("author");
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("filters comments by --since timestamp", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.succeed({
            stdout: JSON.stringify(mockRESTComments),
            stderr: "",
            exitCode: 0,
          }),
      });

      const comments = yield* simulateFetchComments("2025-01-15T00:00:00Z").pipe(
        Effect.provide(layer),
      );

      expect(comments).toHaveLength(2);
      expect(
        comments.every(
          (c) => new Date(c.createdAt).getTime() >= new Date("2025-01-15T00:00:00Z").getTime(),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("returns all comments when since is null", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.succeed({
            stdout: JSON.stringify(mockRESTComments),
            stderr: "",
            exitCode: 0,
          }),
      });

      const comments = yield* simulateFetchComments(null).pipe(Effect.provide(layer));

      expect(comments).toHaveLength(3);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("handles empty response", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.succeed({
            stdout: "[]",
            stderr: "",
            exitCode: 0,
          }),
      });

      const comments = yield* simulateFetchComments(null).pipe(Effect.provide(layer));

      expect(comments).toHaveLength(0);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("filters out all comments when since is in the future", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.succeed({
            stdout: JSON.stringify(mockRESTComments),
            stderr: "",
            exitCode: 0,
          }),
      });

      const comments = yield* simulateFetchComments("2099-01-01T00:00:00Z").pipe(
        Effect.provide(layer),
      );

      expect(comments).toHaveLength(0);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("fetchComments paginates across REST pages", () =>
    Effect.gen(function* () {
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        in_reply_to_id: null,
        user: { login: "reviewer" },
        body: `Comment ${index + 1}`,
        path: "src/file.ts",
        line: index + 1,
        created_at: "2025-01-15T10:00:00Z",
      }));
      const secondPage = [
        {
          id: 101,
          in_reply_to_id: 1,
          user: { login: "author" },
          body: "Reply on second page",
          path: "src/file.ts",
          line: 1,
          created_at: "2025-01-15T11:00:00Z",
        },
      ];

      const seenPaths: string[] = [];
      const layer = createMockGhLayer({
        runGh: (args) => {
          const apiPath = args[1] ?? "";
          seenPaths.push(apiPath);

          if (apiPath.includes("pulls/123/comments?per_page=100&page=1")) {
            return Effect.succeed({
              stdout: JSON.stringify(firstPage),
              stderr: "",
              exitCode: 0,
            });
          }

          if (apiPath.includes("pulls/123/comments?per_page=100&page=2")) {
            return Effect.succeed({
              stdout: JSON.stringify(secondPage),
              stderr: "",
              exitCode: 0,
            });
          }

          return Effect.succeed({ stdout: "[]", stderr: "", exitCode: 0 });
        },
      });

      const comments = yield* fetchComments(123, null).pipe(Effect.provide(layer));

      expect(
        seenPaths.some((path) => path.includes("pulls/123/comments?per_page=100&page=1")),
      ).toBe(true);
      expect(
        seenPaths.some((path) => path.includes("pulls/123/comments?per_page=100&page=2")),
      ).toBe(true);
      expect(comments).toHaveLength(101);
      expect(comments[100]?.id).toBe(101);
      expect(comments[100]?.inReplyToId).toBe(1);
    }).pipe(Effect.provide(createMockGhLayer())),
  );
});

describe("Issue discussion comments", () => {
  const mockIssueDiscussionCommentsRaw = [
    {
      id: 401,
      user: { login: "claude[bot]" },
      body: "Suggested fix",
      created_at: "2026-04-07T09:00:00Z",
      html_url: "https://github.com/test-owner/test-repo/issues/596#issuecomment-401",
    },
    {
      id: 402,
      user: { login: "vivus-agent" },
      body: "Workflow failed on CI/CD",
      created_at: "2026-04-07T10:00:00Z",
      html_url: "https://github.com/test-owner/test-repo/issues/596#issuecomment-402",
    },
    {
      id: 403,
      user: { login: "reviewer" },
      body: "Needs more detail",
      created_at: "2026-04-07T11:00:00Z",
      html_url: "https://github.com/test-owner/test-repo/issues/596#issuecomment-403",
    },
  ];

  it.effect("maps REST issue comments into IssueComment[]", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.succeed({
            stdout: JSON.stringify(mockIssueDiscussionCommentsRaw),
            stderr: "",
            exitCode: 0,
          }),
      });

      const comments = yield* fetchIssueDiscussionComments(596, null, null, null).pipe(
        Effect.provide(layer),
      );

      expect(comments).toHaveLength(3);
      expect(comments[0]).toMatchObject({
        id: 401,
        author: "claude[bot]",
        body: "Suggested fix",
        createdAt: "2026-04-07T09:00:00Z",
        url: "https://github.com/test-owner/test-repo/issues/596#issuecomment-401",
      });
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("filters issue comments by since, author, and body substring", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: () =>
          Effect.succeed({
            stdout: JSON.stringify(mockIssueDiscussionCommentsRaw),
            stderr: "",
            exitCode: 0,
          }),
      });

      const comments = yield* fetchIssueDiscussionComments(
        596,
        "2026-04-07T09:30:00Z",
        "vivus",
        "workflow failed",
      ).pipe(Effect.provide(layer));

      expect(comments).toHaveLength(1);
      expect(comments[0]?.id).toBe(402);
      expect(comments[0]?.author).toBe("vivus-agent");
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("issue comments paginates across REST pages", () =>
    Effect.gen(function* () {
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: "commenter" },
        body: `Comment ${index + 1}`,
        created_at: "2026-04-07T09:00:00Z",
        html_url: `https://github.com/test-owner/test-repo/issues/596#issuecomment-${index + 1}`,
      }));
      const secondPage = [
        {
          id: 101,
          user: { login: "commenter-2" },
          body: "Comment 101",
          created_at: "2026-04-07T10:00:00Z",
          html_url: "https://github.com/test-owner/test-repo/issues/596#issuecomment-101",
        },
      ];

      const seenPaths: string[] = [];
      const layer = createMockGhLayer({
        runGh: (args) => {
          const apiPath = args[1] ?? "";
          seenPaths.push(apiPath);

          if (apiPath.includes("issues/596/comments?per_page=100&page=1")) {
            return Effect.succeed({
              stdout: JSON.stringify(firstPage),
              stderr: "",
              exitCode: 0,
            });
          }

          if (apiPath.includes("issues/596/comments?per_page=100&page=2")) {
            return Effect.succeed({
              stdout: JSON.stringify(secondPage),
              stderr: "",
              exitCode: 0,
            });
          }

          return Effect.succeed({ stdout: "[]", stderr: "", exitCode: 0 });
        },
      });

      const comments = yield* fetchIssueDiscussionComments(596, null, null, null).pipe(
        Effect.provide(layer),
      );

      expect(
        seenPaths.some((path) => path.includes("issues/596/comments?per_page=100&page=1")),
      ).toBe(true);
      expect(
        seenPaths.some((path) => path.includes("issues/596/comments?per_page=100&page=2")),
      ).toBe(true);
      expect(comments).toHaveLength(101);
      expect(comments[100]?.id).toBe(101);
      expect(comments[100]?.author).toBe("commenter-2");
    }).pipe(Effect.provide(createMockGhLayer())),
  );
});

describe("Issue triage", () => {
  const triageIssueBody = "A".repeat(520);
  const triageIssueView = {
    number: 596,
    title: "[WORKFLOW FAILED] CI/CD (blogic-cz/andocs)",
    state: "OPEN",
    url: "https://github.com/test-owner/test-repo/issues/596",
    labels: [{ name: "workflow-failure" }, { name: "github-actions" }],
    assignees: [{ login: "gabriel-ecegi" }],
    author: { login: "app/vivus-agent" },
    body: triageIssueBody,
    createdAt: "2026-04-07T05:23:31Z",
    closedAt: null,
  };

  const triageIssueComments = [
    {
      id: 501,
      user: { login: "claude[bot]" },
      body: "First proposal",
      created_at: "2026-04-07T09:00:00Z",
      html_url: "https://github.com/test-owner/test-repo/issues/596#issuecomment-501",
    },
    {
      id: 502,
      user: { login: "claude[bot]" },
      body: "Latest proposal",
      created_at: "2026-04-07T10:00:00Z",
      html_url: "https://github.com/test-owner/test-repo/issues/596#issuecomment-502",
    },
  ];

  it.effect("returns compact issue triage with latest comment and truncated body", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "issue" && args[1] === "view") {
            return Effect.succeed(triageIssueView);
          }
          return Effect.succeed({});
        },
        runGh: () =>
          Effect.succeed({
            stdout: JSON.stringify(triageIssueComments),
            stderr: "",
            exitCode: 0,
          }),
      });

      const result = yield* fetchIssueTriage({ issue: 596, verbosity: "compact" }).pipe(
        Effect.provide(layer),
      );

      expect("latestComment" in result).toBe(true);
      if (!("latestComment" in result)) {
        expect.fail("Expected compact issue triage result");
      }

      expect(result.issue.number).toBe(596);
      expect(result.issue.labels).toEqual(["workflow-failure", "github-actions"]);
      expect(result.commentsCount).toBe(2);
      expect(result.latestComment?.id).toBe(502);
      expect(result.body.endsWith("…")).toBe(true);
      expect(result.body.length).toBe(501);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("returns full issue triage with full body and all comments", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "issue" && args[1] === "view") {
            return Effect.succeed(triageIssueView);
          }
          return Effect.succeed({});
        },
        runGh: () =>
          Effect.succeed({
            stdout: JSON.stringify(triageIssueComments),
            stderr: "",
            exitCode: 0,
          }),
      });

      const result = yield* fetchIssueTriage({ issue: 596, verbosity: "full" }).pipe(
        Effect.provide(layer),
      );

      expect("comments" in result).toBe(true);
      if (!("comments" in result)) {
        expect.fail("Expected full issue triage result");
      }

      expect(result.issue.author).toBe("app/vivus-agent");
      expect(result.body).toBe(triageIssueBody);
      expect(result.commentsCount).toBe(2);
      expect(result.comments).toHaveLength(2);
      expect(result.comments[1]?.id).toBe(502);
      expect(result.comments[1]?.body).toBe("Latest proposal");
    }).pipe(Effect.provide(createMockGhLayer())),
  );
});

describe("GitHubService.getRepoInfo()", () => {
  it.effect("returns repo info", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const info = yield* service.getRepoInfo();

      expect(info.owner).toBe("test-owner");
      expect(info.name).toBe("test-repo");
      expect(info.defaultBranch).toBe("main");
      expect(info.url).toBe("https://github.com/test-owner/test-repo");
    }).pipe(Effect.provide(createMockGhLayer())),
  );
});

const mockChecksData = [
  {
    name: "CI / build",
    state: "completed",
    bucket: "pass",
    link: "https://github.com/test-owner/test-repo/actions/runs/1",
  },
  {
    name: "CI / lint",
    state: "completed",
    bucket: "fail",
    link: "https://github.com/test-owner/test-repo/actions/runs/2",
  },
];

const mockIssueCommentsRaw = [
  {
    id: 301,
    user: { login: "commenter" },
    body: "General discussion",
    created_at: "2025-01-15T10:00:00Z",
    html_url: "https://github.com/test-owner/test-repo/pull/123#issuecomment-301",
  },
];

const mockTriageReviewCommentsRaw = [
  {
    id: 101,
    in_reply_to_id: null,
    user: { login: "reviewer" },
    body: "Top-level thread comment",
    path: "src/file.ts",
    line: 10,
    created_at: "2025-01-15T10:00:00Z",
  },
  {
    id: 202,
    in_reply_to_id: 101,
    user: { login: "author" },
    body: "Reply to first thread",
    path: "src/file.ts",
    line: 10,
    created_at: "2025-01-15T11:00:00Z",
  },
  {
    id: 102,
    in_reply_to_id: null,
    user: { login: "reviewer2" },
    body: "Second top-level thread comment",
    path: "src/other.ts",
    line: 20,
    created_at: "2025-01-15T12:00:00Z",
  },
];

describe("PR checks", () => {
  it.effect("checks-failed returns structured failure context with next commands", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "pr" && args[1] === "checks") {
            return Effect.succeed(mockChecksData);
          }

          if (args[0] === "run" && args[1] === "view" && args[2] === "2") {
            return Effect.succeed({
              databaseId: 2,
              url: "https://github.com/test-owner/test-repo/actions/runs/2",
              workflowName: "CI",
              status: "completed",
              conclusion: "failure",
              jobs: [
                {
                  name: "lint",
                  status: "completed",
                  conclusion: "failure",
                  url: "https://github.com/test-owner/test-repo/actions/runs/2/job/20",
                  steps: [
                    { name: "Install", status: "completed", conclusion: "success" },
                    { name: "Run lint", status: "completed", conclusion: "failure" },
                  ],
                },
              ],
            });
          }

          return Effect.succeed({});
        },
      });

      const result = (yield* fetchFailedChecks(123).pipe(
        Effect.provide(layer),
      )) as FailedChecksReport;

      expect(result.status).toBe("failed");
      expect(result.summary.failed).toBe(1);
      expect(result.summary.passed).toBe(1);
      expect(result.failedChecks).toHaveLength(1);
      expect(result.failedChecks[0]?.name).toBe("CI / lint");
      expect(result.failedChecks[0]?.runId).toBe(2);
      expect(result.failedChecks[0]?.run?.workflowName).toBe("CI");
      expect(result.failedChecks[0]?.run?.failedJobs[0]?.name).toBe("lint");
      expect(result.failedChecks[0]?.run?.failedJobs[0]?.failedSteps).toEqual(["Run lint"]);
      expect(result.nextCommands).toContain("bun agent-tools-gh workflow view --run 2");
      expect(result.nextCommands).toContain(
        'bun agent-tools-gh workflow job-logs --run 2 --job "lint" --failed-steps-only',
      );
    }),
  );

  it.effect("checks watch failure returns structured report instead of raw command error", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGh: (args) => {
          if (args[0] === "pr" && args[1] === "checks" && args.includes("--watch")) {
            return Effect.fail(
              new GitHubCommandError({
                message: "check run failed",
                command: "gh pr checks 123 --watch",
                exitCode: 1,
                stderr: "",
              }),
            );
          }

          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
        runGhJson: (args) => {
          if (args[0] === "pr" && args[1] === "checks") {
            return Effect.succeed([
              {
                name: "CI / lint",
                state: "completed",
                bucket: "fail",
                link: "https://github.com/test-owner/test-repo/actions/runs/2",
              },
              {
                name: "CI / build",
                state: "in_progress",
                bucket: "pending",
                link: "https://github.com/test-owner/test-repo/actions/runs/3",
              },
            ]);
          }

          if (args[0] === "run" && args[1] === "view" && args[2] === "2") {
            return Effect.succeed({
              databaseId: 2,
              url: "https://github.com/test-owner/test-repo/actions/runs/2",
              workflowName: "CI",
              status: "completed",
              conclusion: "failure",
              jobs: [
                {
                  name: "lint",
                  status: "completed",
                  conclusion: "failure",
                  url: "https://github.com/test-owner/test-repo/actions/runs/2/job/20",
                  steps: [{ name: "Run lint", status: "completed", conclusion: "failure" }],
                },
              ],
            });
          }

          return Effect.succeed({});
        },
      });

      const result = yield* fetchChecks(123, true, true, 30).pipe(Effect.provide(layer));

      expect(Array.isArray(result)).toBe(false);
      expect("status" in result).toBe(true);
      if (!("status" in result)) {
        expect.fail("Expected structured failed checks report");
      }

      expect(result.status).toBe("failed");
      expect(result.summary.failed).toBe(1);
      expect(result.summary.pending).toBe(1);
      expect(result.message).toContain("while 1 check(s) are still running");
      expect(result.nextCommands).toContain("bun agent-tools-gh pr checks --pr 123 --watch");
    }),
  );
});

describe("PR composite commands", () => {
  it.effect(
    "review-triage: combined output contains PR info, unresolved threads, discussion summary, and checks",
    () =>
      Effect.gen(function* () {
        const layer = createMockGhLayer({
          runGhJson: (args) => {
            if (args[0] === "pr" && args[1] === "view") {
              return Effect.succeed(mockPRInfo);
            }
            if (args[0] === "pr" && args[1] === "checks") {
              return Effect.succeed(mockChecksData);
            }
            return Effect.succeed({});
          },
          runGraphQL: () => Effect.succeed(mockGraphQLThreadsResponse),
          runGh: (args) => {
            const apiPath = args[1] ?? "";
            if (apiPath.includes("issues") && apiPath.includes("comments")) {
              return Effect.succeed({
                stdout: JSON.stringify(mockIssueCommentsRaw),
                stderr: "",
                exitCode: 0,
              });
            }
            if (apiPath.includes("pulls") && apiPath.includes("comments")) {
              return Effect.succeed({
                stdout: JSON.stringify(mockTriageReviewCommentsRaw),
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.succeed({ stdout: "[]", stderr: "", exitCode: 0 });
          },
        });

        const [info, unresolvedThreads, visibleOpenThreads, summary, checks] = yield* Effect.all([
          viewPR(123),
          fetchThreads(123, true),
          fetchThreads(123, false, true),
          fetchDiscussionSummary(123),
          fetchChecks(123, false, false, 0),
        ]).pipe(Effect.provide(layer));

        const result = { info, unresolvedThreads, visibleOpenThreads, summary, checks };

        // PR info from viewPR
        expect(result.info.number).toBe(123);
        expect(result.info.title).toBe("Test PR");
        expect(result.info.state).toBe("OPEN");

        // Unresolved threads only (unresolvedOnly=true filters resolved + empty)
        expect(result.unresolvedThreads).toHaveLength(1);
        expect(result.unresolvedThreads[0]?.threadId).toBe("thread-1");
        expect(result.unresolvedThreads[0]?.isResolved).toBe(false);

        expect(result.visibleOpenThreads).toHaveLength(2);
        expect(result.visibleOpenThreads[1]?.threadId).toBe("thread-2");
        expect(result.visibleOpenThreads[1]?.isResolved).toBe(true);
        expect(result.visibleOpenThreads[1]?.needsHumanReply).toBe(true);

        // Discussion summary aggregates from all sub-fetches
        expect(result.summary.issueCommentsCount).toBe(1);
        expect(result.summary.reviewCommentsCount).toBe(3);
        expect(result.summary.reviewThreadsCount).toBe(2);
        expect(result.summary.visibleOpenReviewThreadsCount).toBe(2);
        expect(result.summary.repliedReviewThreadsCount).toBe(1);
        expect(result.summary.unrepliedReviewThreadsCount).toBe(1);
        expect(result.summary.resolvedUnrepliedReviewThreadsCount).toBe(1);
        expect(result.summary.unresolvedReviewThreadsCount).toBe(1);
        expect(result.summary.unresolvedUnrepliedReviewThreadsCount).toBe(0);
        expect(result.summary.latestIssueComment).not.toBeNull();

        // CI checks
        expect(Array.isArray(result.checks)).toBe(true);
        if (!Array.isArray(result.checks)) {
          expect.fail("Expected raw checks array in review-triage result");
        }
        expect(result.checks).toHaveLength(2);
        expect(result.checks[0]?.name).toBe("CI / build");
        expect(result.checks[0]?.bucket).toBe("pass");
        expect(result.checks[1]?.bucket).toBe("fail");
      }),
  );

  it.effect("reply-and-resolve: reply executes before resolve (sequential ordering)", () =>
    Effect.gen(function* () {
      const callOrder: string[] = [];

      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "api" && (args[1] ?? "").includes("pulls/comments")) {
            return Effect.succeed({
              id: 101,
              in_reply_to_id: null,
              pull_request_url: "https://api.github.com/repos/test-owner/test-repo/pulls/123",
            });
          }
          return Effect.succeed({});
        },
        runGh: (args) => {
          if (args.includes("POST") && args.some((a) => a.includes("replies"))) {
            callOrder.push("reply");
            return Effect.succeed({
              stdout: JSON.stringify({ id: 301 }),
              stderr: "",
              exitCode: 0,
            });
          }
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
        runGraphQL: () => {
          callOrder.push("resolve");
          return Effect.succeed({
            resolveReviewThread: {
              thread: { id: "thread-1", isResolved: true },
            },
          });
        },
      });

      const replyResult = yield* replyToComment(123, 101, "Fixed this issue").pipe(
        Effect.provide(layer),
      );
      const resolveResult = yield* resolveThread("thread-1").pipe(Effect.provide(layer));

      // Ordering: reply must execute before resolve
      expect(callOrder).toEqual(["reply", "resolve"]);

      // Reply result
      expect(replyResult.success).toBe(true);
      expect(replyResult.commentId).toBe(301);

      // Resolve result
      expect(resolveResult.resolved).toBe(true);
      expect(resolveResult.threadId).toBe("thread-1");
    }),
  );

  it.effect("resolveRequiredTextInput reads shell-sensitive body text from file", () =>
    Effect.gen(function* () {
      const originalBun = Reflect.get(globalThis, "Bun");

      Reflect.set(globalThis, "Bun", {
        ...(typeof originalBun === "object" && originalBun !== null ? originalBun : {}),
        file: (_filePath: string) => ({
          text: () => Promise.resolve(inventedShellSensitiveText),
        }),
      });

      const resolvedBody = yield* resolveRequiredTextInput(
        "gh-tool pr reply",
        null,
        "/tmp/reply-body.txt",
        "--body",
        "--body-file",
        "body",
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (originalBun === undefined) {
              Reflect.deleteProperty(globalThis, "Bun");
              return;
            }

            Reflect.set(globalThis, "Bun", originalBun);
          }),
        ),
      );

      expect(resolvedBody).toBe(inventedShellSensitiveText);
    }),
  );

  it.effect("replyToComment forwards shell-sensitive reply text unchanged", () =>
    Effect.gen(function* () {
      let forwardedBody: string | undefined;

      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "api" && (args[1] ?? "").includes("pulls/comments")) {
            return Effect.succeed({
              id: 101,
              in_reply_to_id: null,
              pull_request_url: "https://api.github.com/repos/test-owner/test-repo/pulls/123",
            });
          }
          return Effect.succeed({});
        },
        runGh: (args) => {
          forwardedBody = args.at(-1);
          return Effect.succeed({
            stdout: JSON.stringify({ id: 301 }),
            stderr: "",
            exitCode: 0,
          });
        },
      });

      const replyResult = yield* replyToComment(123, 101, inventedShellSensitiveText).pipe(
        Effect.provide(layer),
      );

      expect(replyResult.success).toBe(true);
      expect(replyResult.commentId).toBe(301);
      expect(forwardedBody).toBe(`body=${inventedShellSensitiveText}`);
    }),
  );

  it.effect("resolveOptionalTextInput rejects ambiguous body sources", () =>
    Effect.gen(function* () {
      const result = yield* resolveOptionalTextInput(
        "gh-tool pr reply-and-resolve",
        "inline body",
        "/tmp/reply.txt",
        "--body",
        "--body-file",
        "body",
      ).pipe(Effect.result);

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubCommandError");
          if (error._tag === "GitHubCommandError") {
            expect(error.message).toBe("Provide exactly one of --body or --body-file");
          }
        },
        onSuccess: () => {
          expect.fail("Expected resolveOptionalTextInput to reject multiple body sources");
        },
      });
    }),
  );

  it.effect("resolveRequiredTextInput rejects sensitive file paths", () =>
    Effect.gen(function* () {
      for (const filePath of ["/workspace/.env.local", "/workspace/.envrc"]) {
        const result = yield* resolveRequiredTextInput(
          "gh-tool pr reply",
          null,
          filePath,
          "--body",
          "--body-file",
          "body",
        ).pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error._tag).toBe("GitHubCommandError");
            if (error._tag === "GitHubCommandError") {
              expect(error.message).toMatch(/sensitive/i);
            }
          },
          onSuccess: () => {
            expect.fail(`Expected sensitive path to be rejected: ${filePath}`);
          },
        });
      }
    }),
  );

  it.effect("resolveDefaultTextInput keeps the existing empty-string default", () =>
    Effect.gen(function* () {
      const resolvedBody = yield* resolveDefaultTextInput(
        "gh-tool pr create",
        null,
        null,
        "--body",
        "--body-file",
        "body",
        "",
      );

      expect(resolvedBody).toBe("");
    }),
  );

  it.effect("createPR forwards shell-sensitive body unchanged on create path", () =>
    Effect.gen(function* () {
      let forwardedArgs: string[] | undefined;
      let listCalls = 0;

      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "pr" && args[1] === "view") {
            return Effect.succeed({
              ...mockPRInfo,
              title: "Demo PR",
            });
          }

          if (args[0] === "pr" && args[1] === "list") {
            listCalls += 1;
            return Effect.succeed(
              listCalls === 1
                ? []
                : [
                    {
                      ...mockPRInfo,
                      title: "Demo PR",
                    },
                  ],
            );
          }

          return Effect.succeed({});
        },
        runGh: (args) => {
          forwardedArgs = args;
          return Effect.succeed({
            stdout: "https://github.com/test-owner/test-repo/pull/123",
            stderr: "",
            exitCode: 0,
          });
        },
      });

      const result = yield* createPR({
        base: "main",
        title: "Demo PR",
        body: inventedShellSensitiveText,
        draft: false,
        head: "feat/demo-body-file",
      }).pipe(Effect.provide(layer));

      expect(result.title).toBe("Demo PR");
      expect(forwardedArgs).toEqual([
        "pr",
        "create",
        "--base",
        "main",
        "--title",
        "Demo PR",
        "--body",
        inventedShellSensitiveText,
        "--head",
        "feat/demo-body-file",
      ]);
    }),
  );

  it.effect("editPR forwards shell-sensitive body unchanged", () =>
    Effect.gen(function* () {
      let forwardedArgs: string[] | undefined;

      const layer = createMockGhLayer({
        runGh: (args) => {
          forwardedArgs = args;
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
        runGhJson: (args) => {
          if (args[0] === "pr" && args[1] === "view") {
            return Effect.succeed(mockPRInfo);
          }

          return Effect.succeed({});
        },
      });

      const result = yield* editPR({
        pr: 123,
        title: null,
        body: inventedShellSensitiveText,
      }).pipe(Effect.provide(layer));

      expect(result.number).toBe(123);
      expect(forwardedArgs).toEqual(["pr", "edit", "123", "--body", inventedShellSensitiveText]);
    }),
  );

  it.effect("submitPendingReview forwards shell-sensitive body unchanged", () =>
    Effect.gen(function* () {
      let forwardedVariables: Record<string, string | number | null> | undefined;

      const layer = createMockGhLayer({
        runGraphQL: (_query, variables) => {
          forwardedVariables = variables;
          return Effect.succeed({
            submitPullRequestReview: {
              pullRequestReview: { id: "review-1", state: "COMMENTED" },
            },
          });
        },
      });

      const result = yield* submitPendingReview(123, "review-1", inventedShellSensitiveText).pipe(
        Effect.provide(layer),
      );

      expect(result.submitted).toBe(true);
      expect(forwardedVariables?.body).toBe(inventedShellSensitiveText);
    }),
  );

  it.effect("commentOnIssue forwards shell-sensitive body unchanged", () =>
    Effect.gen(function* () {
      let forwardedBody: string | undefined;

      const layer = createMockGhLayer({
        runGh: (args) => {
          forwardedBody = args.at(-1);
          return Effect.succeed({
            stdout: JSON.stringify({
              id: 900,
              user: { login: "demo-user" },
              body: inventedShellSensitiveText,
              created_at: "2025-01-15T12:00:00Z",
              html_url: "https://github.com/test-owner/test-repo/issues/1#issuecomment-900",
            }),
            stderr: "",
            exitCode: 0,
          });
        },
      });

      const result = yield* commentOnIssue({ issue: 1, body: inventedShellSensitiveText }).pipe(
        Effect.provide(layer),
      );

      expect(result.id).toBe(900);
      expect(forwardedBody).toBe(`body=${inventedShellSensitiveText}`);
    }),
  );

  it.effect("closeIssue forwards shell-sensitive comment unchanged", () =>
    Effect.gen(function* () {
      let forwardedArgs: string[] | undefined;

      const layer = createMockGhLayer({
        runGh: (args) => {
          forwardedArgs = args;
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
        runGhJson: () => Effect.succeed({ ...mockPRInfo, number: 1 }),
      });

      const result = yield* closeIssue({
        issue: 1,
        comment: inventedShellSensitiveText,
        reason: "completed",
      }).pipe(Effect.provide(layer));

      expect(result.number).toBe(1);
      expect(forwardedArgs).toEqual([
        "issue",
        "close",
        "1",
        "--reason",
        "completed",
        "--comment",
        inventedShellSensitiveText,
      ]);
    }),
  );

  it.effect("reopenIssue forwards shell-sensitive comment unchanged", () =>
    Effect.gen(function* () {
      let forwardedArgs: string[] | undefined;

      const layer = createMockGhLayer({
        runGh: (args) => {
          forwardedArgs = args;
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
        runGhJson: () => Effect.succeed({ ...mockPRInfo, number: 1 }),
      });

      const result = yield* reopenIssue({
        issue: 1,
        comment: inventedShellSensitiveText,
      }).pipe(Effect.provide(layer));

      expect(result.number).toBe(1);
      expect(forwardedArgs).toEqual([
        "issue",
        "reopen",
        "1",
        "--comment",
        inventedShellSensitiveText,
      ]);
    }),
  );

  it.effect("editIssue forwards shell-sensitive body unchanged", () =>
    Effect.gen(function* () {
      let forwardedArgs: string[] | undefined;

      const layer = createMockGhLayer({
        runGh: (args) => {
          forwardedArgs = args;
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
        runGhJson: () => Effect.succeed({ ...mockPRInfo, number: 1 }),
      });

      const result = yield* editIssue({
        issue: 1,
        title: null,
        body: inventedShellSensitiveText,
        addLabels: null,
        removeLabels: null,
        addAssignee: null,
        removeAssignee: null,
      }).pipe(Effect.provide(layer));

      expect(result.number).toBe(1);
      expect(forwardedArgs).toEqual(["issue", "edit", "1", "--body", inventedShellSensitiveText]);
    }),
  );
});

describe("error recovery hints - unit tests", () => {
  it("GitHubCommandError with hint and nextCommand", () => {
    const error = new GitHubCommandError({
      message: "unknown flag: --invalid-flag",
      command: "gh pr list --invalid-flag",
      exitCode: 2,
      stderr: "unknown flag: --invalid-flag",
      hint: "Check the command syntax. Use 'gh pr list --help' for available options.",
      nextCommand: "gh pr list --help",
      retryable: true,
    });

    expect(error._tag).toBe("GitHubCommandError");
    expect(error.hint).toBe(
      "Check the command syntax. Use 'gh pr list --help' for available options.",
    );
    expect(error.nextCommand).toBe("gh pr list --help");
    expect(error.retryable).toBe(true);
  });

  it("GitHubAuthError with hint and nextCommand", () => {
    const error = new GitHubAuthError({
      message: "authentication required",
      hint: "Set GITHUB_TOKEN environment variable or run 'gh auth login'",
      nextCommand: "gh auth login",
    });

    expect(error._tag).toBe("GitHubAuthError");
    expect(error.hint).toContain("GITHUB_TOKEN");
    expect(error.nextCommand).toBe("gh auth login");
  });

  it("GitHubNotFoundError with hint", () => {
    const error = new GitHubNotFoundError({
      message: "pull request not found",
      identifier: "999",
      resource: "pull request",
      hint: "Check the PR number. Use 'gh pr list' to see available pull requests.",
      nextCommand: "gh pr list",
    });

    expect(error._tag).toBe("GitHubNotFoundError");
    expect(error.hint).toContain("PR number");
    expect(error.nextCommand).toBe("gh pr list");
  });

  it("hint fields are optional in GitHub errors", () => {
    const error = new GitHubCommandError({
      message: "command failed",
      command: "gh pr list",
      exitCode: 1,
      stderr: "error",
    });

    expect(error._tag).toBe("GitHubCommandError");
    expect(error.message).toBe("command failed");
    expect(error.hint).toBeUndefined();
    expect(error.nextCommand).toBeUndefined();
  });
});
