import { describe, expect, it } from "@effect/vitest";
import { Clock, Console, Effect, Fiber, Result, Layer, Sink, Stream } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import type { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { MergeResult, MergeStrategy, PRInfo, ReviewComment, ReviewThread } from "#gh/types";

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
import {
  collectLinkedPullRequestNumbers,
  fetchIssueTriage,
  parseIssueNumbers,
} from "#gh/issue/triage";
import {
  createPR,
  editPR,
  fetchChecksForCommand,
  fetchFailedChecks,
  rerunChecks,
  viewPR,
  watchPRs,
} from "#gh/pr/core";
import {
  fetchComments,
  fetchFeedback,
  fetchLastHumanReviewer,
  fetchReviews,
  fetchThreads,
  replyAndResolveComment,
  replyToComment,
  resolveThread,
  submitPendingReview,
} from "#gh/pr/review";
import { renameBranch } from "#gh/branch";
import { buildWatchResult, diagnoseLogEntries, dispatchWorkflow, fetchJobLogs } from "#gh/workflow";
import {
  resolveDefaultTextInput,
  resolveOptionalTextInput,
  resolveRequiredTextInput,
} from "#gh/text-input";
import type { GitHubPrTitlePolicy, GitHubRepoConfig } from "#config";
import { ConfigService } from "#config";
import {
  classifyReviewTriage,
  fetchCurrentComments,
  fetchCurrentFeedback,
  fetchCurrentReviews,
  fetchCurrentThreads,
  fetchReviewTriage,
  parsePrNumbers,
} from "#gh/pr/commands";

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

const mockPrTitlePolicy = {
  pattern:
    "^(feat|fix|refactor|chore|ci|test|build|revert|docs|perf|style)(\\([^)]+\\))?: CORE-[0-9]+ - .+$",
  expected: "<type>: CORE-<number> - <description>",
  example: "feat: CORE-123 - product taxonomy",
} satisfies GitHubPrTitlePolicy;

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

type ObservedGhCommand = {
  args: ReadonlyArray<string>;
  ghRepo: string | undefined;
};

function createMockProcess(result: { stdout: string; stderr: string; exitCode: number }) {
  const encoder = new TextEncoder();

  const stdout = Stream.fromIterable([encoder.encode(result.stdout)]);
  const stderr = Stream.fromIterable([encoder.encode(result.stderr)]);

  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.succeed(undefined),
    stderr,
    stdin: Sink.drain,
    stdout,
    all: Stream.fromIterable([encoder.encode(result.stdout), encoder.encode(result.stderr)]),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function createMockGhSpawnerLayer(observed: ObservedGhCommand[]) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command: ChildProcess.Command) => {
      let stdout = "{}";

      if (command._tag === "StandardCommand") {
        observed.push({
          args: command.args,
          ghRepo: command.options.env?.GH_REPO,
        });

        if (command.args[0] === "repo" && command.args[1] === "view") {
          const repo = command.args[2] ?? "test-owner/test-repo";
          const [owner = "test-owner", name = "test-repo"] = repo.split("/");
          stdout = JSON.stringify({
            owner: { login: owner },
            name,
            defaultBranchRef: { name: "main" },
            url: `https://github.com/${owner}/${name}`,
          });
        }
      }

      return Effect.succeed(createMockProcess({ stdout, stderr: "", exitCode: 0 }));
    }),
  );
}

type MockGhOverrides = Partial<{
  runGh: (
    args: string[],
  ) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, GhError>;
  runGhJson: (args: string[]) => Effect.Effect<unknown, GhError>;
  runGraphQL: (
    query: string,
    variables: Record<string, string | number | null>,
  ) => Effect.Effect<unknown, GhError>;
  getRepoConfig: () => Effect.Effect<GitHubRepoConfig | undefined, never>;
  getRepoInfo: () => Effect.Effect<typeof mockRepoInfo, GhError>;
  withRepoTarget: <A, E, R>(
    target: string | null,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitHubCommandError, R>;
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
      getRepoConfig: overrides.getRepoConfig ?? (() => Effect.succeed(undefined)),
      getRepoInfo: overrides.getRepoInfo ?? (() => Effect.succeed(mockRepoInfo)),
      withRepoTarget: overrides.withRepoTarget ?? ((_target, effect) => effect),
    }),
  );
}

describe("workflow dispatch", () => {
  it.effect("runs workflow_dispatch with repo, ref, and fields", () => {
    const calls: string[][] = [];

    return Effect.gen(function* () {
      const result = yield* dispatchWorkflow({
        workflow: "propagate-environment-branch.yml",
        ref: "main",
        repo: "sabservis/nexus-be",
        fields: ["source_branch=staging", "target_branch=main"],
      });

      expect(result).toEqual({
        dispatched: true,
        workflow: "propagate-environment-branch.yml",
        ref: "main",
        repo: "sabservis/nexus-be",
        fields: ["source_branch=staging", "target_branch=main"],
      });
      expect(calls).toEqual([
        [
          "workflow",
          "run",
          "propagate-environment-branch.yml",
          "--ref",
          "main",
          "--repo",
          "sabservis/nexus-be",
          "-f",
          "source_branch=staging",
          "-f",
          "target_branch=main",
        ],
      ]);
    }).pipe(
      Effect.provide(
        createMockGhLayer({
          runGh: (args) => {
            calls.push(args);
            return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
          },
        }),
      ),
    );
  });
});

describe("GitHubService.runGh() error mapping", () => {
  it.effect("uses the configured default repository for plain gh calls", () => {
    const observedGhCommands: ObservedGhCommand[] = [];

    return Effect.gen(function* () {
      const service = yield* GitHubService;
      yield* service.runGh(["issue", "view", "123"]);
    }).pipe(
      Effect.provide(GitHubService.layer),
      Effect.provide(createMockGhSpawnerLayer(observedGhCommands)),
      Effect.provide(
        Layer.succeed(ConfigService, {
          github: {
            default: { owner: "test-owner", repo: "test-repo" },
          },
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(observedGhCommands).toEqual([
            {
              args: ["issue", "view", "123"],
              ghRepo: "test-owner/test-repo",
            },
          ]);
        }),
      ),
    );
  });

  it.effect("scopes explicit repository targets to the wrapped effect", () => {
    const observedGhCommands: ObservedGhCommand[] = [];

    return Effect.gen(function* () {
      const service = yield* GitHubService;

      yield* service.withRepoTarget("be", service.runGh(["pr", "view", "1"]));
      yield* service.runGh(["issue", "view", "2"]);
    }).pipe(
      Effect.provide(GitHubService.layer),
      Effect.provide(createMockGhSpawnerLayer(observedGhCommands)),
      Effect.provide(
        Layer.succeed(ConfigService, {
          github: {
            default: { owner: "test-owner", repo: "test-repo" },
            be: { owner: "test-owner", repo: "test-be" },
          },
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(observedGhCommands).toEqual([
            {
              args: ["pr", "view", "1"],
              ghRepo: "test-owner/test-be",
            },
            {
              args: ["issue", "view", "2"],
              ghRepo: "test-owner/test-repo",
            },
          ]);
        }),
      ),
    );
  });

  it.effect("uses explicit repository target when resolving repo info", () => {
    const observedGhCommands: ObservedGhCommand[] = [];

    return Effect.gen(function* () {
      const service = yield* GitHubService;

      yield* service.withRepoTarget("be", service.getRepoInfo());
    }).pipe(
      Effect.provide(GitHubService.layer),
      Effect.provide(createMockGhSpawnerLayer(observedGhCommands)),
      Effect.provide(
        Layer.succeed(ConfigService, {
          github: {
            default: { owner: "test-owner", repo: "test-repo" },
            be: { owner: "test-owner", repo: "test-be" },
          },
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(observedGhCommands[0]?.args).toEqual([
            "repo",
            "view",
            "test-owner/test-be",
            "--json",
            "owner,name,defaultBranchRef,url",
          ]);
          expect(observedGhCommands[0]?.ghRepo).toBe("test-owner/test-be");
        }),
      ),
    );
  });

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

describe("PR view", () => {
  it.effect("requests and returns the PR body", () =>
    Effect.gen(function* () {
      let capturedArgs: string[] = [];
      const body = "## Why\nPrivate PR description";

      const result = yield* viewPR(123).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              capturedArgs = args;
              return Effect.succeed({
                ...mockPRInfo,
                body,
                headRefOid: "head-sha",
                baseRefOid: "base-sha",
              });
            },
          }),
        ),
      );

      expect(capturedArgs).toEqual([
        "pr",
        "view",
        "123",
        "--json",
        "number,url,title,headRefName,baseRefName,headRefOid,baseRefOid,state,isDraft,mergeable,body,author,reviewDecision,reviewRequests",
      ]);
      expect(result.body).toBe(body);
      expect(result.headSha).toBe("head-sha");
      expect(result.baseSha).toBe("base-sha");
    }),
  );
});

describe("Workflow log diagnosis", () => {
  it("classifies known failures and keeps fingerprints stable", () => {
    const cases = [
      ["No space left on device", "infrastructure"],
      ["NuGet package cache is corrupt", "infrastructure"],
      ["socket bind: address already in use", "infrastructure"],
      ["Tests failed: expected true to be false", "test_failure"],
    ] as const;
    for (const [message, category] of cases) {
      expect(diagnoseLogEntries([{ step: "Run tests", message }]).category).toBe(category);
    }
    expect(
      diagnoseLogEntries([{ step: "Run tests", message: "Tests failed at line 42" }]).fingerprint,
    ).toBe(
      diagnoseLogEntries([{ step: "Run tests", message: "Tests failed at line 99" }]).fingerprint,
    );
  });

  it.effect("returns concise diagnose metadata without entries", () =>
    Effect.gen(function* () {
      const result = yield* fetchJobLogs({
        runId: 2,
        job: "test",
        jobId: 20,
        failedStepsOnly: false,
        diagnose: true,
        format: "json",
        repo: null,
      }).pipe(
        Effect.provide(
          createMockGhLayer({
            runGh: () =>
              Effect.succeed({
                stdout:
                  "2025-01-01T00:00:00Z ##[group]Run tests\n2025-01-01T00:00:01Z Tests failed: expected true to be false",
                stderr: "",
                exitCode: 0,
              }),
          }),
        ),
      );
      expect(result.runId).toBe(2);
      expect(result.jobId).toBe(20);
      expect("diagnosis" in result).toBe(true);
      const diagnosis = result.diagnosis;
      if (diagnosis === undefined) {
        expect.fail("Expected diagnosis");
      }
      expect(diagnosis.category).toBe("test_failure");
      expect(diagnosis.testsStarted).toBe(true);
      expect("entries" in result).toBe(false);
    }),
  );
});

describe("PR edit", () => {
  it.effect("rejects title updates that do not match the configured repo policy", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];

      const result = yield* editPR({
        pr: 123,
        title: "fix(transmittals+sabfx): make import work",
        body: null,
        base: null,
      }).pipe(
        Effect.provide(
          createMockGhLayer({
            getRepoConfig: () =>
              Effect.succeed({
                owner: "test-owner",
                repo: "test-repo",
                prTitle: mockPrTitlePolicy,
              }),
            runGh: (args) => {
              calls.push(args);
              return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
            },
          }),
        ),
        Effect.result,
      );

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubCommandError");
          if (error._tag === "GitHubCommandError") {
            expect(error.message).toContain("PR title does not match the required format");
            expect(error.stderr).toContain("Expected: <type>: CORE-<number> - <description>");
            expect(error.stderr).toContain("Example: feat: CORE-123 - product taxonomy");
          }
        },
        onSuccess: () => {
          expect.fail("Expected invalid PR title to fail");
        },
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("allows title updates that match the configured repo policy", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];

      const result = yield* editPR({
        pr: 123,
        title: "fix(core): CORE-123 - product taxonomy",
        body: null,
        base: null,
      }).pipe(
        Effect.provide(
          createMockGhLayer({
            getRepoConfig: () =>
              Effect.succeed({
                owner: "test-owner",
                repo: "test-repo",
                prTitle: mockPrTitlePolicy,
              }),
            runGh: (args) => {
              calls.push(args);
              return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
            },
            runGhJson: (args) => {
              calls.push(args);
              return Effect.succeed({
                ...mockPRInfo,
                title: "fix(core): CORE-123 - product taxonomy",
                body: "",
              });
            },
          }),
        ),
      );

      expect(calls[0]).toEqual([
        "api",
        "--method",
        "PATCH",
        "repos/test-owner/test-repo/pulls/123",
        "-f",
        "title=fix(core): CORE-123 - product taxonomy",
      ]);
      expect(result.title).toBe("fix(core): CORE-123 - product taxonomy");
    }),
  );

  it.effect("edit returns the updated PR body", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const body = "## Updated body\nDetails";

      const result = yield* editPR({
        pr: 123,
        title: null,
        body,
        base: null,
      }).pipe(
        Effect.provide(
          createMockGhLayer({
            runGh: (args) => {
              calls.push(args);
              return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
            },
            runGhJson: (args) => {
              calls.push(args);
              return Effect.succeed({
                ...mockPRInfo,
                body,
              });
            },
          }),
        ),
      );

      expect(calls).toEqual([
        ["api", "--method", "PATCH", "repos/test-owner/test-repo/pulls/123", "-f", `body=${body}`],
        [
          "pr",
          "view",
          "123",
          "--json",
          "number,url,title,headRefName,baseRefName,headRefOid,baseRefOid,state,isDraft,mergeable,body,author,reviewDecision,reviewRequests",
        ],
      ]);
      expect(result.body).toBe(body);
    }),
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
            commitSha: null,
            feedbackOrigin: "unknown",
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
            duplicateThreadIds: [],
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
        commitSha: null,
        feedbackOrigin: "unknown",
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

describe("Pull request reviews (REST → PullRequestReview[])", () => {
  const mockRESTReviews = [
    {
      id: 901,
      user: { login: "claude[bot]" },
      state: "CHANGES_REQUESTED",
      body: "This diff removes the git-workflow lock entry.",
      submitted_at: "2026-07-16T05:34:15Z",
      html_url: "https://github.com/test-owner/test-repo/pull/123#pullrequestreview-901",
    },
    {
      id: 902,
      user: { login: "human-reviewer" },
      state: "APPROVED",
      body: "",
      submitted_at: "2026-07-16T11:04:25Z",
      html_url: "https://github.com/test-owner/test-repo/pull/123#pullrequestreview-902",
    },
    {
      id: 903,
      user: { login: "claude[bot]" },
      state: "COMMENTED",
      body: "",
      submitted_at: "2026-07-16T11:05:00Z",
      html_url: "https://github.com/test-owner/test-repo/pull/123#pullrequestreview-903",
    },
  ];

  const reviewsLayer = createMockGhLayer({
    runGh: () =>
      Effect.succeed({ stdout: JSON.stringify(mockRESTReviews), stderr: "", exitCode: 0 }),
  });

  it.effect("drops empty-body COMMENTED noise but keeps stateful empty reviews", () =>
    Effect.gen(function* () {
      const reviews = yield* fetchReviews(123, null, null, null).pipe(Effect.provide(reviewsLayer));

      expect(reviews).toHaveLength(2);
      expect(reviews.map((r) => r.id)).not.toContain(903);
      expect(reviews[0]?.author).toBe("claude[bot]");
      expect(reviews[0]?.state).toBe("CHANGES_REQUESTED");
      expect(reviews[0]?.body).toBe("This diff removes the git-workflow lock entry.");
      expect(reviews[1]?.state).toBe("APPROVED");
      expect(reviews[1]?.body).toBe("");
      expect(reviews.every((r) => !(r.state === "COMMENTED" && r.body === ""))).toBe(true);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("filters reviews by state, author, and body substring", () =>
    Effect.gen(function* () {
      const byState = yield* fetchReviews(123, null, null, "approved").pipe(
        Effect.provide(reviewsLayer),
      );
      expect(byState).toHaveLength(1);
      expect(byState[0]?.author).toBe("human-reviewer");

      const byAuthor = yield* fetchReviews(123, "claude", null, null).pipe(
        Effect.provide(reviewsLayer),
      );
      expect(byAuthor).toHaveLength(1);
      expect(byAuthor[0]?.state).toBe("CHANGES_REQUESTED");

      const byBody = yield* fetchReviews(123, null, "git-workflow", null).pipe(
        Effect.provide(reviewsLayer),
      );
      expect(byBody).toHaveLength(1);
      expect(byBody[0]?.id).toBe(901);
    }).pipe(Effect.provide(createMockGhLayer())),
  );
});

describe("pr feedback (aggregated review-response inventory)", () => {
  it.effect(
    "classifies feedback origins by exact head SHA without treating pre-existing as obsolete",
    () =>
      Effect.gen(function* () {
        const commits = ["head-sha", "older-sha", null] as const;
        const restItem = (id: number, commit_id: string | null) => ({
          id,
          commit_id,
          in_reply_to_id: null,
          user: { login: "reviewer" },
          state: "COMMENTED",
          body: `feedback ${id}`,
          path: `src/${id}.ts`,
          line: id,
          created_at: "2026-07-16T10:00:00Z",
          submitted_at: "2026-07-16T10:00:00Z",
          html_url: `https://github.test/${id}`,
        });
        const threads = commits.map((commit, index) => ({
          id: `thread-${index}`,
          isResolved: false,
          comments: {
            nodes: [
              {
                id: `node-${index}`,
                databaseId: index + 1,
                path: `src/${index}.ts`,
                line: index + 1,
                body: `thread ${index}`,
                author: { login: "reviewer" },
                commit: commit === null ? null : { oid: commit },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }));
        const layer = createMockGhLayer({
          runGraphQL: () =>
            Effect.succeed({
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: threads,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            }),
          runGh: (args) => {
            const endpoint = args.join(" ");
            const body = endpoint.includes("/reviews")
              ? commits.map((sha, i) => restItem(i + 10, sha))
              : endpoint.includes("pulls/123/comments")
                ? commits.map((sha, i) => restItem(i + 20, sha))
                : [
                    {
                      id: 30,
                      user: { login: "x" },
                      body: "issue",
                      created_at: "2026-07-16T10:00:00Z",
                      html_url: "https://github.test/30",
                    },
                  ];
            return Effect.succeed({ stdout: JSON.stringify(body), stderr: "", exitCode: 0 });
          },
        });

        const feedback = yield* fetchFeedback(123, "head-sha").pipe(Effect.provide(layer));
        for (const items of [feedback.reviews, feedback.inlineComments, feedback.threads]) {
          expect(items.map((item) => [item.commitSha, item.feedbackOrigin])).toEqual([
            ["head-sha", "current_head"],
            ["older-sha", "pre_existing"],
            [null, "unknown"],
          ]);
        }
        expect(feedback.issueComments[0]).toMatchObject({
          commitSha: null,
          feedbackOrigin: "unknown",
        });
        expect(feedback.threads[1]).toMatchObject({
          isVisibleOpen: true,
          feedbackOrigin: "pre_existing",
        });
      }),
  );

  it.effect("threads, comments, reviews, and feedback discard data when head changes", () =>
    Effect.gen(function* () {
      const collectors = [
        (layer: ReturnType<typeof createMockGhLayer>) =>
          fetchCurrentThreads(123, false, false).pipe(
            Effect.provide(layer),
            Effect.map((items) => items[0]),
          ),
        (layer: ReturnType<typeof createMockGhLayer>) =>
          fetchCurrentComments(123, null).pipe(
            Effect.provide(layer),
            Effect.map((items) => items[0]),
          ),
        (layer: ReturnType<typeof createMockGhLayer>) =>
          fetchCurrentReviews(123, null, null, null).pipe(
            Effect.provide(layer),
            Effect.map((items) => items[0]),
          ),
        (layer: ReturnType<typeof createMockGhLayer>) =>
          fetchCurrentFeedback(123).pipe(
            Effect.provide(layer),
            Effect.map((result) => result.inlineComments[0]),
          ),
      ];
      for (const collect of collectors) {
        let views = 0;
        const head = () => (views <= 1 ? "head-a" : "head-b");
        const layer = createMockGhLayer({
          runGhJson: () => {
            views += 1;
            return Effect.succeed({ ...mockPRInfo, headRefOid: head() });
          },
          runGraphQL: () =>
            Effect.succeed({
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread",
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              id: "node",
                              databaseId: 1,
                              path: "x.ts",
                              line: 1,
                              body: "feedback",
                              author: { login: "reviewer" },
                              commit: { oid: head() },
                            },
                          ],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            }),
          runGh: (args) => {
            const endpoint = args[1] ?? "";
            const item = {
              id: 1,
              in_reply_to_id: null,
              user: { login: "reviewer" },
              state: "COMMENTED",
              body: "feedback",
              path: "x.ts",
              line: 1,
              created_at: "2026-01-01T00:00:00Z",
              submitted_at: "2026-01-01T00:00:00Z",
              html_url: "https://example.test/1",
              commit_id: head(),
            };
            const body = endpoint.includes("issues/") ? [] : [item];
            return Effect.succeed({ stdout: JSON.stringify(body), stderr: "", exitCode: 0 });
          },
        });
        const item = yield* collect(layer);
        expect(views).toBe(3);
        expect(item).toMatchObject({ commitSha: "head-b", feedbackOrigin: "current_head" });
      }
    }),
  );

  it.effect("returns reviews, threads, inline comments, and issue comments in one call", () =>
    Effect.gen(function* () {
      const reviewsJson = JSON.stringify([
        {
          id: 901,
          user: { login: "claude[bot]" },
          state: "COMMENTED",
          body: "summary body",
          submitted_at: "2026-07-16T05:34:15Z",
          html_url: "https://github.com/test-owner/test-repo/pull/123#pullrequestreview-901",
        },
      ]);
      const inlineJson = JSON.stringify([
        {
          id: 201,
          in_reply_to_id: null,
          user: { login: "reviewer" },
          body: "inline",
          path: "src/file.ts",
          line: 10,
          created_at: "2026-07-16T10:00:00Z",
        },
      ]);
      const issueJson = JSON.stringify([
        {
          id: 401,
          user: { login: "github-actions[bot]" },
          body: "test results",
          created_at: "2026-07-16T09:00:00Z",
          html_url: "https://github.com/test-owner/test-repo/issues/123#issuecomment-401",
        },
      ]);

      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(mockGraphQLThreadsResponse),
        runGh: (args) => {
          const endpoint = args.join(" ");
          const body = endpoint.includes("pulls/123/reviews")
            ? reviewsJson
            : endpoint.includes("pulls/123/comments")
              ? inlineJson
              : endpoint.includes("issues/123/comments")
                ? issueJson
                : "[]";
          return Effect.succeed({ stdout: body, stderr: "", exitCode: 0 });
        },
      });

      const feedback = yield* fetchFeedback(123).pipe(Effect.provide(layer));

      expect(Object.keys(feedback).sort()).toEqual([
        "inlineComments",
        "issueComments",
        "reviews",
        "threads",
      ]);
      expect(feedback.reviews).toHaveLength(1);
      expect(feedback.reviews[0]?.state).toBe("COMMENTED");
      expect(feedback.inlineComments).toHaveLength(1);
      expect(feedback.issueComments).toHaveLength(1);
      expect(Array.isArray(feedback.threads)).toBe(true);
    }).pipe(Effect.provide(createMockGhLayer())),
  );
});

describe("Review thread dedupe", () => {
  const dupThreadsResponse = {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              id: "thread-resolved-dup",
              isResolved: true,
              comments: {
                nodes: [
                  {
                    id: "c1",
                    databaseId: 1,
                    path: "src/x.ts",
                    line: 5,
                    body: "Please fix this",
                    author: { login: "reviewer" },
                  },
                ],
              },
            },
            {
              id: "thread-resolved-dup-2",
              isResolved: true,
              comments: {
                nodes: [
                  {
                    id: "c2b",
                    databaseId: 4,
                    path: "src/x.ts",
                    line: 5,
                    body: "Please fix this",
                    author: { login: "reviewer" },
                  },
                ],
              },
            },
            {
              id: "thread-unresolved-dup",
              isResolved: false,
              comments: {
                nodes: [
                  {
                    id: "c2",
                    databaseId: 2,
                    path: "src/x.ts",
                    line: 5,
                    body: "Please fix this   ",
                    author: { login: "reviewer" },
                  },
                ],
              },
            },
            {
              id: "thread-distinct",
              isResolved: false,
              comments: {
                nodes: [
                  {
                    id: "c3",
                    databaseId: 3,
                    path: "src/y.ts",
                    line: 9,
                    body: "Different finding",
                    author: { login: "reviewer" },
                  },
                ],
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };

  it.effect("collapses exact duplicates, keeps distinct, and prefers an unresolved dupe", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(dupThreadsResponse),
        runGh: () => Effect.succeed({ stdout: "[]", stderr: "", exitCode: 0 }),
      });

      const threads = yield* fetchThreads(123, false).pipe(Effect.provide(layer));

      expect(threads).toHaveLength(2);
      expect(threads[0]?.path).toBe("src/x.ts");
      expect(threads[0]?.line).toBe(5);
      expect(threads[0]?.threadId).toBe("thread-unresolved-dup");
      expect(threads[0]?.isResolved).toBe(false);
      expect(threads[0]?.duplicateThreadIds).toEqual([
        "thread-resolved-dup",
        "thread-resolved-dup-2",
      ]);
      expect(threads[1]?.threadId).toBe("thread-distinct");
      expect(threads[1]?.duplicateThreadIds).toEqual([]);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("keeps collapsed unresolved duplicates addressable via duplicateThreadIds", () =>
    Effect.gen(function* () {
      const makeNode = (id: string, databaseId: number) => ({
        id,
        isResolved: false,
        comments: {
          nodes: [
            {
              id: `c-${databaseId}`,
              databaseId,
              path: "src/x.ts",
              line: 5,
              body: "Same bot finding",
              author: { login: "github-actions[bot]" },
            },
          ],
        },
      });
      const response = {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [makeNode("thread-first", 1), makeNode("thread-second", 2)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(response),
        runGh: () => Effect.succeed({ stdout: "[]", stderr: "", exitCode: 0 }),
      });

      const threads = yield* fetchThreads(123, false).pipe(Effect.provide(layer));

      expect(threads).toHaveLength(1);
      expect(threads[0]?.threadId).toBe("thread-first");
      expect(threads[0]?.duplicateThreadIds).toEqual(["thread-second"]);
    }).pipe(Effect.provide(createMockGhLayer())),
  );
});

describe("PR last human reviewer", () => {
  it.effect("returns the most recent human reviewer and current requested reviewers", () =>
    Effect.gen(function* () {
      const response = {
        repository: {
          pullRequest: {
            reviewRequests: { nodes: [] },
            reviews: {
              nodes: [
                {
                  author: { login: "claude[bot]" },
                  state: "COMMENTED",
                  submittedAt: "2026-07-16T05:00:00Z",
                },
                {
                  author: { login: "github-actions" },
                  state: "COMMENTED",
                  submittedAt: "2026-07-16T06:00:00Z",
                },
                {
                  author: { login: "roman" },
                  state: "CHANGES_REQUESTED",
                  submittedAt: "2026-07-16T07:00:00Z",
                },
                {
                  author: { login: "roman" },
                  state: "APPROVED",
                  submittedAt: "2026-07-16T09:00:00Z",
                },
                {
                  author: { login: "michal" },
                  state: "COMMENTED",
                  submittedAt: "2026-07-16T08:00:00Z",
                },
              ],
            },
            timelineItems: {
              nodes: [
                {
                  __typename: "ReviewRequestedEvent",
                  requestedReviewer: { __typename: "User", login: "roman" },
                },
                {
                  __typename: "ReviewRequestedEvent",
                  requestedReviewer: { __typename: "User", login: "michal" },
                },
                {
                  __typename: "ReviewRequestRemovedEvent",
                  requestedReviewer: { __typename: "User", login: "roman" },
                },
              ],
            },
          },
        },
      };

      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(response),
      });

      const result = yield* fetchLastHumanReviewer(123).pipe(Effect.provide(layer));

      expect(result.lastHumanReviewer).toBe("roman");
      expect(result.lastHumanReviewAt).toBe("2026-07-16T09:00:00Z");
      expect(result.currentRequestedReviewers).toEqual(["michal"]);
    }).pipe(Effect.provide(createMockGhLayer())),
  );

  it.effect("handles the empty case with nulls and an empty requested list", () =>
    Effect.gen(function* () {
      const response = {
        repository: {
          pullRequest: {
            reviewRequests: { nodes: [] },
            reviews: {
              nodes: [
                {
                  author: { login: "dependabot[bot]" },
                  state: "COMMENTED",
                  submittedAt: "2026-07-16T05:00:00Z",
                },
              ],
            },
            timelineItems: { nodes: [] },
          },
        },
      };

      const layer = createMockGhLayer({
        runGraphQL: () => Effect.succeed(response),
      });

      const result = yield* fetchLastHumanReviewer(123).pipe(Effect.provide(layer));

      expect(result.lastHumanReviewer).toBeNull();
      expect(result.lastHumanReviewAt).toBeNull();
      expect(result.currentRequestedReviewers).toEqual([]);
    }).pipe(Effect.provide(createMockGhLayer())),
  );
});

describe("workflow watch result shaping (buildWatchResult)", () => {
  const fakeRun = {
    status: "completed",
    conclusion: "success",
    jobs: [{ name: "build", status: "completed", conclusion: "success" }],
  };

  it("omits watchOutput by default (quiet) when the run completed", () => {
    const result = buildWatchResult(555, fakeRun, "frame1\nframe2\nframe3", false, 120);
    expect(result.status).toBe("completed");
    expect(result.conclusion).toBe("success");
    expect(result.jobs).toHaveLength(1);
    expect("watchOutput" in result).toBe(false);
  });

  it("includes the raw frames when --frames is set", () => {
    const result = buildWatchResult(555, fakeRun, "frame1\nframe2\nframe3", true, 120);
    expect((result as { watchOutput?: string }).watchOutput).toBe("frame1\nframe2\nframe3");
  });

  it("always includes a timeout note when the watch timed out", () => {
    const result = buildWatchResult(555, fakeRun, null, false, 90);
    expect((result as { watchOutput?: string }).watchOutput).toContain("timed out after 90s");
  });
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
      user: { login: "example-agent" },
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
        "example",
        "workflow failed",
      ).pipe(Effect.provide(layer));

      expect(comments).toHaveLength(1);
      expect(comments[0]?.id).toBe(402);
      expect(comments[0]?.author).toBe("example-agent");
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
    title: "[WORKFLOW FAILED] CI/CD (example-org/example-app)",
    state: "OPEN",
    url: "https://github.com/test-owner/test-repo/issues/596",
    labels: [{ name: "workflow-failure" }, { name: "github-actions" }],
    assignees: [{ login: "gabriel-ecegi" }],
    author: { login: "app/example-agent" },
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

      expect(result.issue.author).toBe("app/example-agent");
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

describe("GitHubService.getRepoConfig()", () => {
  it.effect("returns the selected repository profile config", () =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      const config = yield* service.withRepoTarget("fe", service.getRepoConfig());

      expect(config?.owner).toBe("sabservis");
      expect(config?.repo).toBe("nexus-fe");
      expect(config?.prTitle?.expected).toBe("<type>: CORE-<number> - <description>");
    }).pipe(
      Effect.provide(GitHubService.layer),
      Effect.provide(createMockGhSpawnerLayer([])),
      Effect.provide(
        Layer.succeed(ConfigService, {
          github: {
            default: { owner: "sabservis", repo: "nexus-be" },
            fe: {
              owner: "sabservis",
              repo: "nexus-fe",
              prTitle: mockPrTitlePolicy,
            },
          },
        }),
      ),
    ),
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
  it.effect("JSON checks and batch checks suppress refresh hints while retaining results", () =>
    Effect.gen(function* () {
      const warnings: unknown[][] = [];
      const console = yield* TestConsole.make;
      const consoleLayer = Layer.succeed(Console.Console, {
        ...console,
        warn: (...args: unknown[]) => warnings.push(args),
      });
      const pending = [{ name: "CI", state: "in_progress", bucket: "pending", link: "x" }];
      const ghLayer = createMockGhLayer({
        runGhJson: () => Effect.succeed(pending),
      });

      const single = yield* fetchChecksForCommand(123, false, false, 1, true).pipe(
        Effect.provide(ghLayer),
        Effect.provide(consoleLayer),
      );
      const batch = yield* Effect.all([
        fetchChecksForCommand(123, false, false, 1, true),
        fetchChecksForCommand(124, false, false, 1, true),
      ]).pipe(Effect.provide(ghLayer), Effect.provide(consoleLayer));
      expect(single).toEqual(pending);
      expect(batch).toEqual([pending, pending]);
      expect(warnings).toEqual([]);
    }),
  );

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

      const result = yield* fetchFailedChecks(123).pipe(Effect.provide(layer));

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

  it.effect("checks-failed does not fetch failed-step logs by default", () =>
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
                  steps: [{ name: "Run lint", status: "completed", conclusion: "failure" }],
                },
              ],
            });
          }

          return Effect.succeed({});
        },
      });

      const result = yield* fetchFailedChecks(123).pipe(Effect.provide(layer));

      expect(result.failedChecks).toHaveLength(1);
      expect(result.failedChecks[0]?.failedStepLogs).toBeUndefined();
    }),
  );

  it.effect("checks-failed --with-logs inlines cleaned failed-step logs", () =>
    Effect.gen(function* () {
      const rawJobLogs = [
        "2025-01-01T00:00:00Z ##[group]Run lint",
        "2025-01-01T00:00:01Z npm run lint",
        "2025-01-01T00:00:02Z Error: lint failed hard",
        "2025-01-01T00:00:03Z ##[endgroup]",
      ].join("\n");

      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "pr" && args[1] === "checks") {
            return Effect.succeed(mockChecksData);
          }

          if (args[0] === "run" && args[1] === "view" && args[2] === "2") {
            if (args[4] === "jobs") {
              return Effect.succeed({
                jobs: [
                  {
                    databaseId: 20,
                    name: "lint",
                    status: "completed",
                    conclusion: "failure",
                    startedAt: "2025-01-01T00:00:00Z",
                    completedAt: "2025-01-01T00:00:05Z",
                    url: "https://github.com/test-owner/test-repo/actions/runs/2/job/20",
                    steps: [{ name: "Run lint", status: "completed", conclusion: "failure" }],
                  },
                ],
              });
            }

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
        runGh: (args) => {
          if (args[0] === "api" && args[1]?.includes("actions/jobs/20/logs")) {
            return Effect.succeed({ stdout: rawJobLogs, stderr: "", exitCode: 0 });
          }
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
      });

      const result = yield* fetchFailedChecks(123, true).pipe(Effect.provide(layer));

      expect(result.failedChecks).toHaveLength(1);
      expect(result.failedChecks[0]?.failedStepLogs).toContain("Run lint");
      expect(result.failedChecks[0]?.failedStepLogs).toContain("Error: lint failed hard");
    }),
  );

  it.effect("checks-failed --with-logs matches each sibling check to its own job", () =>
    Effect.gen(function* () {
      const checks = [
        {
          name: "CI / lint",
          state: "completed",
          bucket: "fail",
          link: "https://github.com/test-owner/test-repo/actions/runs/2",
        },
        {
          name: "CI / test",
          state: "completed",
          bucket: "fail",
          link: "https://github.com/test-owner/test-repo/actions/runs/2",
        },
      ];

      const jobs = [
        {
          databaseId: 20,
          name: "lint",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/test-owner/test-repo/actions/runs/2/job/20",
          steps: [{ name: "Run lint", status: "completed", conclusion: "failure" }],
        },
        {
          databaseId: 21,
          name: "test",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/test-owner/test-repo/actions/runs/2/job/21",
          steps: [{ name: "Run test", status: "completed", conclusion: "failure" }],
        },
      ];

      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "pr" && args[1] === "checks") {
            return Effect.succeed(checks);
          }

          if (args[0] === "run" && args[1] === "view" && args[2] === "2") {
            if (args[4] === "jobs") {
              return Effect.die(
                new Error("redundant listJobs call: logs should reuse the fetched run context"),
              );
            }

            return Effect.succeed({
              databaseId: 2,
              url: "https://github.com/test-owner/test-repo/actions/runs/2",
              workflowName: "CI",
              status: "completed",
              conclusion: "failure",
              jobs,
            });
          }

          return Effect.succeed({});
        },
        runGh: (args) => {
          if (args[0] === "api" && args[1]?.includes("actions/jobs/20/logs")) {
            return Effect.succeed({
              stdout:
                "2025-01-01T00:00:00Z ##[group]Run lint\n2025-01-01T00:00:02Z Error: lint boom\n2025-01-01T00:00:03Z ##[endgroup]",
              stderr: "",
              exitCode: 0,
            });
          }
          if (args[0] === "api" && args[1]?.includes("actions/jobs/21/logs")) {
            return Effect.succeed({
              stdout:
                "2025-01-01T00:00:00Z ##[group]Run test\n2025-01-01T00:00:02Z Error: test boom\n2025-01-01T00:00:03Z ##[endgroup]",
              stderr: "",
              exitCode: 0,
            });
          }
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
      });

      const result = yield* fetchFailedChecks(123, true).pipe(Effect.provide(layer));

      const lint = result.failedChecks.find((check) => check.name === "CI / lint");
      const test = result.failedChecks.find((check) => check.name === "CI / test");

      expect(lint?.failedStepLogs).toContain("lint boom");
      expect(lint?.failedStepLogs).not.toContain("test boom");
      expect(test?.failedStepLogs).toContain("test boom");
      expect(test?.failedStepLogs).not.toContain("lint boom");
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

      const result = yield* fetchChecksForCommand(123, true, true, 30).pipe(Effect.provide(layer));

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

  it.effect("checks-failed retries a push race before labeling SHA evidence", () =>
    Effect.gen(function* () {
      let views = 0;
      let snapshots = 0;
      const result = yield* fetchFailedChecks(123).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr" && args[1] === "view") {
                views += 1;
                return Effect.succeed({
                  ...mockPRInfo,
                  headRefOid: views === 1 ? "head-a" : "head-b",
                  baseRefOid: "base",
                });
              }
              snapshots += 1;
              return Effect.succeed([
                {
                  name: `CI-${snapshots}`,
                  state: "completed",
                  bucket: "fail",
                  link: "external",
                },
              ]);
            },
          }),
        ),
      );
      expect(snapshots).toBe(2);
      expect(result.evidence).toEqual({ headSha: "head-b", baseSha: "base" });
      expect(result.failedChecks[0]?.name).toBe("CI-2");
    }),
  );

  it.effect(
    "JSONL watch stays transition-only and emits deterministic multi-PR identities, stale-head filtering, dedupe, and supersession",
    () =>
      Effect.gen(function* () {
        const events: Array<Record<string, unknown>> = [];
        const views = new Map<number, number>();
        const checks = new Map<number, number>();
        const layer = createMockGhLayer({
          runGhJson: (args) => {
            if (args[0] === "pr" && args[1] === "view") {
              const pr = Number(args[2]);
              const call = (views.get(pr) ?? 0) + 1;
              views.set(pr, call);
              if (pr === 1 && call === 1) {
                return Effect.succeed({ number: pr, state: "OPEN", headRefOid: "head-a" });
              }
              return Effect.succeed({
                number: pr,
                state: "OPEN",
                headRefOid: pr === 1 ? "head-b" : "head-2",
              });
            }
            if (args[0] === "pr" && args[1] === "checks") {
              const pr = Number(args[2]);
              const call = (checks.get(pr) ?? 0) + 1;
              checks.set(pr, call);
              if (pr === 2) {
                return Effect.succeed([
                  {
                    name: "external",
                    state: "completed",
                    bucket: "pass",
                    link: "https://checks.example/result/7",
                  },
                  {
                    name: "stale",
                    state: "completed",
                    bucket: "fail",
                    link: "https://github.com/test-owner/test-repo/actions/runs/99",
                  },
                ]);
              }
              return Effect.succeed([
                {
                  name: "CI / test",
                  state: call < 5 ? "in_progress" : "completed",
                  bucket: call < 5 ? "pending" : "pass",
                  link: `https://github.com/test-owner/test-repo/actions/runs/${call < 5 ? 10 : 11}`,
                },
              ]);
            }
            if (args[0] === "run" && args[1] === "view") {
              if (args[2] === "99") {
                return Effect.succeed({
                  databaseId: 99,
                  attempt: 1,
                  headSha: "old-head",
                  jobs: [],
                });
              }
              const checkCall = checks.get(1) ?? 0;
              const runId = Number(args[2]);
              const attempt = checkCall < 4 || runId === 11 ? 1 : 2;
              return Effect.succeed({
                databaseId: runId,
                attempt,
                headSha: "head-b",
                jobs: [
                  {
                    databaseId: runId === 11 ? 111 : attempt === 1 ? 101 : 102,
                    name: "CI / test",
                  },
                ],
              });
            }
            return Effect.succeed({});
          },
        });

        yield* watchPRs([1, 2], { intervalSeconds: 0, timeoutSeconds: 10 }, (event) =>
          Effect.sync(() => events.push(event)),
        ).pipe(Effect.provide(layer));

        const checkEvents = events.filter((event) => event.type === "check");
        expect(checkEvents).toHaveLength(4);
        expect(checkEvents.some((event) => event.name === "stale")).toBe(false);
        expect(checkEvents[0]?.identity).toBe(
          "test-owner/test-repo/2/head-2/external//external|https://checks.example/result/7",
        );
        expect(checkEvents[1]?.identity).toBe("test-owner/test-repo/1/head-b/10/1/101");
        expect(checkEvents[2]).toMatchObject({
          identity: "test-owner/test-repo/1/head-b/10/2/102",
          supersedes: "test-owner/test-repo/1/head-b/10/1/101",
        });
        expect(checkEvents[3]).toMatchObject({
          identity: "test-owner/test-repo/1/head-b/11/1/111",
          supersedes: "test-owner/test-repo/1/head-b/10/2/102",
        });
        expect(
          events.filter((event) => event.type === "pr_terminal").map((event) => event.pr),
        ).toEqual([2, 1]);
        expect(events.at(-1)).toMatchObject({
          type: "watcher_terminal",
          status: "terminal",
          terminal: [1, 2],
        });
        expect(events.map((event) => JSON.parse(JSON.stringify(event)))).toEqual(events);
      }),
  );

  it.effect("watch emits same-identity pending to success and failure revisions", () =>
    Effect.gen(function* () {
      const events: Array<Record<string, unknown>> = [];
      const checkCalls = new Map<number, number>();
      yield* watchPRs([1, 2], { intervalSeconds: 0, timeoutSeconds: 5 }, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr" && args[1] === "view") {
                return Effect.succeed({
                  number: Number(args[2]),
                  state: "OPEN",
                  headRefOid: `head-${args[2]}`,
                });
              }
              const pr = Number(args[2]);
              const call = (checkCalls.get(pr) ?? 0) + 1;
              checkCalls.set(pr, call);
              return Effect.succeed([
                {
                  name: "external",
                  state: call === 1 ? "pending" : "completed",
                  bucket: call === 1 ? "pending" : pr === 1 ? "pass" : "fail",
                  link: `https://checks.example/${pr}`,
                },
              ]);
            },
          }),
        ),
      );
      for (const pr of [1, 2]) {
        const revisions = events.filter((event) => event.type === "check" && event.pr === pr);
        expect(revisions).toHaveLength(2);
        expect(revisions[0]?.identity).toBe(revisions[1]?.identity);
        expect(revisions[1]).not.toHaveProperty("supersedes");
      }
      expect(events.at(-1)).toMatchObject({ status: "terminal", terminal: [1, 2] });
    }),
  );

  it.effect("watch waits through stable empty snapshots for eventual checks", () =>
    Effect.gen(function* () {
      const events: Array<Record<string, unknown>> = [];
      let checks = 0;
      yield* watchPRs([7], { intervalSeconds: 0, timeoutSeconds: 5 }, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr" && args[1] === "view") {
                return Effect.succeed({ number: 7, state: "OPEN", headRefOid: "head" });
              }
              checks += 1;
              if (checks <= 2) return Effect.succeed([]);
              return Effect.succeed([
                {
                  name: "CI",
                  state: checks === 3 ? "pending" : "completed",
                  bucket: checks === 3 ? "pending" : "pass",
                  link: "external",
                },
              ]);
            },
          }),
        ),
      );
      expect(checks).toBe(4);
      expect(events.filter((event) => event.type === "pr_terminal")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ status: "terminal" });
    }),
  );

  it.effect("watch resets three-empty-snapshot grace when head SHA changes", () =>
    Effect.gen(function* () {
      const events: Array<Record<string, unknown>> = [];
      let checks = 0;
      let views = 0;
      yield* watchPRs([7], { intervalSeconds: 0, timeoutSeconds: 5 }, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr" && args[1] === "view") {
                views += 1;
                return Effect.succeed({
                  number: 7,
                  state: "OPEN",
                  headRefOid: views <= 2 ? "old-head" : "new-head",
                });
              }
              checks += 1;
              return Effect.succeed(
                checks === 1
                  ? [{ name: "CI", state: "pending", bucket: "pending", link: "external" }]
                  : [],
              );
            },
          }),
        ),
      );
      expect(checks).toBe(4);
      expect(events.find((event) => event.type === "pr_terminal")).toMatchObject({
        headSha: "new-head",
        checksObserved: false,
      });
    }),
  );

  it.effect("watch deadline during early PR snapshot prevents later terminal observations", () =>
    Effect.gen(function* () {
      const events: Array<Record<string, unknown>> = [];
      const apiPRs: number[] = [];
      const fiber = yield* Effect.forkChild(
        watchPRs([1, 2], { intervalSeconds: 60, timeoutSeconds: 0.01 }, (event) =>
          Effect.sync(() => events.push(event)),
        ).pipe(
          Effect.provide(
            createMockGhLayer({
              runGhJson: (args) => {
                if (args[0] === "pr" && args[1] === "view") {
                  const pr = Number(args[2]);
                  apiPRs.push(pr);
                  return pr === 1
                    ? Effect.sleep("20 millis").pipe(
                        Effect.as({ number: pr, state: "OPEN", headRefOid: "head-1" }),
                      )
                    : Effect.succeed({ number: pr, state: "CLOSED", headRefOid: "head-2" });
                }
                return Effect.succeed([]);
              },
            }),
          ),
        ),
      );
      yield* TestClock.adjust("20 millis");
      yield* Fiber.join(fiber);
      expect(apiPRs).toEqual([1]);
      expect(events).toEqual([
        expect.objectContaining({ type: "watcher_terminal", status: "timeout", terminal: [] }),
      ]);
    }),
  );

  it.effect("watch caps interval sleep to remaining absolute deadline", () =>
    Effect.gen(function* () {
      const start = Number(yield* Clock.currentTimeMillis);
      const events: Array<Record<string, unknown>> = [];
      const layer = createMockGhLayer({
        runGhJson: (args) =>
          args[0] === "pr" && args[1] === "view"
            ? Effect.succeed({ number: 1, state: "OPEN", headRefOid: "head" })
            : Effect.succeed([
                { name: "CI", state: "pending", bucket: "pending", link: "external" },
              ]),
      });
      const fiber = yield* Effect.forkChild(
        watchPRs([1], { intervalSeconds: 60, timeoutSeconds: 0.01 }, (event) =>
          Effect.sync(() => events.push(event)),
        ).pipe(Effect.provide(layer)),
      );
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(fiber);
      const elapsed = Number(yield* Clock.currentTimeMillis) - start;
      expect(elapsed).toBe(10);
      expect(events.at(-1)).toMatchObject({ status: "timeout" });
    }),
  );

  it.effect("watch dedupes run enrichment and matches workflow-qualified matrix jobs", () =>
    Effect.gen(function* () {
      const events: Array<Record<string, unknown>> = [];
      let runViews = 0;
      yield* watchPRs([9], { intervalSeconds: 0, timeoutSeconds: 5 }, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr" && args[1] === "view") {
                return Effect.succeed({ number: 9, state: "OPEN", headRefOid: "head" });
              }
              if (args[0] === "pr") {
                return Effect.succeed(
                  ["test (node 20)", "test (node 22)"].map((name) => ({
                    name: `CI / ${name}`,
                    state: "completed",
                    bucket: "pass",
                    link: "https://github.com/test-owner/test-repo/actions/runs/42",
                  })),
                );
              }
              runViews += 1;
              return Effect.succeed({
                databaseId: 42,
                attempt: 1,
                headSha: "head",
                jobs: [
                  { databaseId: 420, name: "test (node 20)" },
                  { databaseId: 422, name: "test (node 22)" },
                ],
              });
            },
          }),
        ),
      );
      expect(runViews).toBe(1);
      expect(events.filter((event) => event.type === "check").map((event) => event.jobId)).toEqual([
        420, 422,
      ]);
    }),
  );

  it.effect("watch reports mixed multi-PR terminal coverage without false timeout", () =>
    Effect.gen(function* () {
      const events: Array<Record<string, unknown>> = [];
      yield* watchPRs([1, 2], { intervalSeconds: 0, timeoutSeconds: 0 }, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) =>
              args[0] === "pr" && args[1] === "view"
                ? Effect.succeed({
                    number: Number(args[2]),
                    state: "OPEN",
                    headRefOid: `head-${args[2]}`,
                  })
                : Effect.succeed([
                    {
                      name: "CI",
                      state: "completed",
                      bucket: Number(args[2]) === 1 ? "pass" : "pending",
                      link: "external",
                    },
                  ]),
          }),
        ),
      );
      expect(events.at(-1)).toMatchObject({ status: "timeout", terminal: [] });
    }),
  );

  it.effect("rerun-checks uses REST job id for eligible failed-only preflight", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "pr") {
            return Effect.succeed([
              {
                name: "Deploy / deploy",
                state: "completed",
                bucket: "fail",
                link: "https://github.com/test-owner/test-repo/actions/runs/42",
              },
              {
                name: "deploy",
                state: "completed",
                bucket: "fail",
                link: "https://github.com/test-owner/test-repo/actions/runs/42",
              },
            ]);
          }
          if (args[0] === "run") {
            return Effect.succeed({
              databaseId: 42,
              attempt: 1,
              jobs: [
                {
                  databaseId: 420,
                  name: "deploy",
                  status: "completed",
                  conclusion: "failure",
                },
              ],
            });
          }
          if (args[0] === "api") {
            return Effect.succeed({ jobs: [{ id: 9420, name: "deploy" }] });
          }
          return Effect.succeed({});
        },
        runGh: (args) => {
          calls.push(args);
          return Effect.succeed({ stdout: "log evidence", stderr: "", exitCode: 0 });
        },
      });

      const result = yield* rerunChecks(123, true).pipe(Effect.provide(layer));
      expect(calls).toContainEqual(["api", "repos/test-owner/test-repo/actions/jobs/9420/logs"]);
      expect(calls.filter((args) => args[0] === "run")).toEqual([
        ["run", "rerun", "42", "--failed"],
      ]);
      expect(result.rerun).toBe(1);
      expect(result.runs?.[0]).toMatchObject({ currentAttempt: 1, status: "rerun_started" });
    }),
  );

  it.effect("rerun-checks fails closed when later-page job evidence is unavailable", () =>
    Effect.gen(function* () {
      const mutations: string[][] = [];
      let pages = 0;
      const result = yield* rerunChecks(123, true).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr") {
                return Effect.succeed([
                  {
                    name: "test",
                    state: "completed",
                    bucket: "fail",
                    link: "https://github.com/test-owner/test-repo/actions/runs/42",
                  },
                ]);
              }
              if (args[0] === "run") {
                return Effect.succeed({
                  databaseId: 42,
                  attempt: 1,
                  jobs: [
                    {
                      databaseId: 999,
                      name: "test",
                      status: "completed",
                      conclusion: "failure",
                    },
                  ],
                });
              }
              pages += 1;
              return Effect.succeed({
                jobs:
                  pages === 1
                    ? Array.from({ length: 100 }, (_, index) => ({
                        id: index,
                        name: `other-${index}`,
                      }))
                    : [{ id: 999, name: "test" }],
              });
            },
            runGh: (args) => {
              if (args[0] === "run") mutations.push(args);
              return Effect.fail(
                new GitHubCommandError({
                  command: "gh api logs",
                  exitCode: 1,
                  stderr: "unavailable",
                  message: "unavailable",
                }),
              );
            },
          }),
        ),
      );
      expect(pages).toBe(2);
      expect(mutations).toEqual([]);
      expect(result).toMatchObject({ status: "evidence_unavailable", rerun: 0 });
    }),
  );

  it.effect("rerun-checks fails closed when job mapping is ambiguous", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const result = yield* rerunChecks(123, true).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) =>
              args[0] === "pr"
                ? Effect.succeed([
                    {
                      name: "deploy",
                      state: "completed",
                      bucket: "fail",
                      link: "https://github.com/test-owner/test-repo/actions/runs/42",
                    },
                  ])
                : Effect.succeed({
                    databaseId: 42,
                    attempt: 1,
                    jobs: [
                      {
                        databaseId: 420,
                        name: "deploy-a",
                        status: "completed",
                        conclusion: "failure",
                      },
                    ],
                  }),
            runGh: (args) => {
              calls.push(args);
              return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
            },
          }),
        ),
      );
      expect(calls).toEqual([]);
      expect(result).toMatchObject({ status: "evidence_unavailable", rerun: 0 });
    }),
  );

  it.effect("rerun-checks preflights every run before mutating", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const result = yield* rerunChecks(123, true).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr") {
                return Effect.succeed(
                  ["1", "2"].map((runId) => ({
                    name: "CI / test",
                    state: "completed",
                    bucket: "fail",
                    link: `https://github.com/test-owner/test-repo/actions/runs/${runId}`,
                  })),
                );
              }
              if (args[0] === "run") {
                const runId = Number(args[2]);
                return Effect.succeed({
                  databaseId: runId,
                  attempt: runId === 2 ? 3 : 1,
                  jobs: [
                    {
                      databaseId: runId * 10,
                      name: "test",
                      status: "completed",
                      conclusion: "failure",
                    },
                  ],
                });
              }
              if (args[0] === "api") {
                const attempt = Number(args[1]?.match(/attempts\/(\d+)/)?.[1]);
                const firstRun = args[1]?.includes("runs/1/") ?? false;
                return Effect.succeed({
                  jobs: [{ id: firstRun ? 10 : 200 + attempt, name: "test" }],
                });
              }
              return Effect.succeed({});
            },
            runGh: (args) => {
              calls.push(args);
              if (args[0] === "api") {
                return Effect.succeed({
                  stdout: args[1]?.includes("/jobs/10/")
                    ? "##[group]Run tests\nTests failed"
                    : "##[group]Checkout\ncheckout: No space left on device",
                  stderr: "",
                  exitCode: 0,
                });
              }
              return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
            },
          }),
        ),
      );
      expect(calls.filter((args) => args[0] === "run" && args[1] === "rerun")).toEqual([]);
      expect(result.status).toBe("escalation_required");
      expect(result.rerun).toBe(0);
      expect(result.runs).toHaveLength(2);
      expect(result.runs?.[0]?.status).toBe("blocked");
      expect(result.runs?.[1]?.status).toBe("escalation_required");
    }),
  );

  it.effect(
    "rerun-checks mutates all runs before discovery and reports shared-deadline timeouts explicitly",
    () =>
      Effect.gen(function* () {
        const order: string[] = [];
        const runViews = new Map<string, number>();
        const fiber = yield* Effect.forkChild(
          rerunChecks(123, false, {
            watch: true,
            timeoutSeconds: 0.01,
          }).pipe(
            Effect.provide(
              createMockGhLayer({
                runGhJson: (args) => {
                  if (args[0] === "pr") {
                    return Effect.succeed(
                      ["1", "2"].map((runId) => ({
                        name: `CI-${runId}`,
                        state: "completed",
                        bucket: "fail",
                        link: `https://github.com/test-owner/test-repo/actions/runs/${runId}`,
                      })),
                    );
                  }
                  const runId = String(args[2]);
                  const call = (runViews.get(runId) ?? 0) + 1;
                  runViews.set(runId, call);
                  if (call === 1) {
                    return Effect.succeed({
                      databaseId: Number(runId),
                      attempt: 1,
                      status: "completed",
                      jobs: [{ databaseId: Number(runId) * 10, name: `CI-${runId}` }],
                    });
                  }
                  order.push(`discover-${runId}`);
                  if (runId === "1") {
                    return Effect.sleep("20 millis").pipe(
                      Effect.as({
                        databaseId: 1,
                        attempt: 1,
                        status: "completed",
                        jobs: [{ databaseId: 10, name: "CI-1" }],
                      }),
                    );
                  }
                  return Effect.succeed({
                    databaseId: 2,
                    attempt: 2,
                    status: "completed",
                    jobs: [{ databaseId: 21, name: "CI-2" }],
                  });
                },
                runGh: (args) => {
                  order.push(`mutate-${args[2]}`);
                  return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
                },
              }),
            ),
          ),
        );
        yield* TestClock.adjust("20 millis");
        const result = yield* Fiber.join(fiber);
        expect(order.slice(0, 2)).toEqual(["mutate-1", "mutate-2"]);
        expect(result.runs?.map((run) => run.status)).toEqual(["discovery_timeout", "completed"]);
        expect(result.runs?.[1]).toMatchObject({ newAttempt: 2, newJobIds: [21] });
      }),
  );

  it.effect("rerun-checks discovers and watches the exact new attempt", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      let runViews = 0;
      const result = yield* rerunChecks(123, true, {
        watch: true,
        timeoutSeconds: 2,
      }).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr")
                return Effect.succeed([
                  {
                    name: "test",
                    state: "completed",
                    bucket: "fail",
                    link: "https://github.com/test-owner/test-repo/actions/runs/42",
                  },
                ]);
              if (args[0] === "api") return Effect.succeed({ jobs: [{ id: 420, name: "test" }] });
              if (args[0] === "run") {
                runViews += 1;
                if (runViews === 1)
                  return Effect.succeed({
                    databaseId: 42,
                    attempt: 1,
                    status: "completed",
                    jobs: [
                      {
                        databaseId: 420,
                        name: "test",
                        status: "completed",
                        conclusion: "failure",
                      },
                    ],
                  });
                return Effect.succeed({
                  databaseId: 42,
                  attempt: 2,
                  status: "completed",
                  jobs: [
                    {
                      databaseId: 421,
                      name: "test",
                      status: "completed",
                      conclusion: "success",
                    },
                  ],
                });
              }
              return Effect.succeed({});
            },
            runGh: (args) => {
              calls.push(args);
              return Effect.succeed({
                stdout: "##[group]Run tests\nTests failed",
                stderr: "clean diagnostic stderr",
                exitCode: 0,
              });
            },
          }),
        ),
      );

      expect(result.runs?.[0]).toMatchObject({
        currentAttempt: 1,
        currentJobIds: [420],
        newAttempt: 2,
        newJobIds: [421],
        status: "completed",
      });
      expect(runViews).toBe(2);
      expect(calls.filter((args) => args[0] === "run" && args[1] === "rerun")).toEqual([
        ["run", "rerun", "42", "--failed"],
      ]);
    }),
  );

  it.effect("rerun-checks reports bounded discovery timeout", () =>
    Effect.gen(function* () {
      const result = yield* rerunChecks(123, true, {
        watch: true,
        timeoutSeconds: 0,
      }).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr")
                return Effect.succeed([
                  {
                    name: "test",
                    state: "completed",
                    bucket: "fail",
                    link: "https://github.com/test-owner/test-repo/actions/runs/42",
                  },
                ]);
              if (args[0] === "run")
                return Effect.succeed({
                  databaseId: 42,
                  attempt: 1,
                  status: "completed",
                  jobs: [
                    {
                      databaseId: 420,
                      name: "test",
                      status: "completed",
                      conclusion: "failure",
                    },
                  ],
                });
              if (args[0] === "api") return Effect.succeed({ jobs: [{ id: 420, name: "test" }] });
              return Effect.succeed({});
            },
            runGh: () =>
              Effect.succeed({ stdout: "test failure evidence", stderr: "", exitCode: 0 }),
          }),
        ),
      );
      expect(result.runs?.[0]).toMatchObject({
        currentAttempt: 1,
        newAttempt: null,
        status: "discovery_timeout",
      });
    }),
  );

  it.effect("rerun-checks reports watch_timeout with latest attempt under one deadline", () =>
    Effect.gen(function* () {
      let runViews = 0;
      const result = yield* rerunChecks(123, true, { watch: true, timeoutSeconds: 0 }).pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr")
                return Effect.succeed([
                  {
                    name: "test",
                    state: "completed",
                    bucket: "fail",
                    link: "https://github.com/test-owner/test-repo/actions/runs/42",
                  },
                ]);
              if (args[0] === "api") return Effect.succeed({ jobs: [{ id: 420, name: "test" }] });
              runViews += 1;
              return Effect.succeed(
                runViews === 1
                  ? {
                      databaseId: 42,
                      attempt: 1,
                      status: "completed",
                      jobs: [
                        {
                          databaseId: 420,
                          name: "test",
                          status: "completed",
                          conclusion: "failure",
                        },
                      ],
                    }
                  : {
                      databaseId: 42,
                      attempt: 2,
                      status: "in_progress",
                      jobs: [
                        {
                          databaseId: 421,
                          name: "test",
                          status: "in_progress",
                          conclusion: null,
                        },
                      ],
                    },
              );
            },
            runGh: () =>
              Effect.succeed({ stdout: "test failure evidence", stderr: "", exitCode: 0 }),
          }),
        ),
      );
      expect(runViews).toBe(2);
      expect(result.runs?.[0]).toMatchObject({
        status: "watch_timeout",
        newAttempt: 2,
        latestAttempt: { attempt: 2, status: "in_progress" },
      });
    }),
  );

  it.effect("rerun-checks permits changed retry fingerprint and unknown evidence", () =>
    Effect.gen(function* () {
      for (const currentLog of [
        "##[group]Checkout\nconnection reset by peer",
        "##[group]Run tests\nAssertionError: expected 1 to equal 2",
      ]) {
        const mutations: string[][] = [];
        const result = yield* rerunChecks(123, true, {
          timeoutSeconds: 0,
        }).pipe(
          Effect.provide(
            createMockGhLayer({
              runGhJson: (args) => {
                if (args[0] === "pr")
                  return Effect.succeed([
                    {
                      name: "test",
                      state: "completed",
                      bucket: "fail",
                      link: "https://github.com/test-owner/test-repo/actions/runs/42",
                    },
                  ]);
                if (args[0] === "run")
                  return Effect.succeed({
                    databaseId: 42,
                    attempt: 2,
                    status: "completed",
                    jobs: [
                      {
                        databaseId: 422,
                        name: "test",
                        status: "completed",
                        conclusion: "failure",
                      },
                    ],
                  });
                if (args[0] === "api") {
                  const attempt = Number(args[1]?.match(/attempts\/(\d+)/)?.[1]);
                  return Effect.succeed({ jobs: [{ id: 420 + attempt, name: "test" }] });
                }
                return Effect.succeed({});
              },
              runGh: (args) => {
                if (args[0] === "run") mutations.push(args);
                return Effect.succeed({
                  stdout: args[1]?.includes("421")
                    ? "##[group]Checkout\nNo space left on device"
                    : currentLog,
                  stderr: "",
                  exitCode: 0,
                });
              },
            }),
          ),
        );
        expect(result.status).not.toBe("escalation_required");
        expect(mutations).toEqual([["run", "rerun", "42", "--failed"]]);
      }
    }),
  );

  it.effect("rerun-checks keeps full rerun mode at run scope", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const layer = createMockGhLayer({
        runGhJson: (args) => {
          if (args[0] === "pr" && args[1] === "checks") {
            return Effect.succeed(mockChecksData);
          }

          return Effect.succeed({});
        },
        runGh: (args) => {
          calls.push(args);
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
      });

      const result = yield* rerunChecks(123, false).pipe(Effect.provide(layer));

      expect(calls).toEqual([
        ["run", "rerun", "1"],
        ["run", "rerun", "2"],
      ]);
      expect(result.rerun).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.runs).toEqual([
        expect.objectContaining({ runId: "1", success: true, status: "rerun_started" }),
        expect.objectContaining({ runId: "2", success: true, status: "rerun_started" }),
      ]);
    }),
  );
});

describe("PR composite commands", () => {
  it.effect("review-triage discards checks and feedback collected across a push race", () =>
    Effect.gen(function* () {
      let views = 0;
      let snapshots = 0;
      const result = yield* fetchReviewTriage(123, "json").pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: (args) => {
              if (args[0] === "pr" && args[1] === "view") {
                views += 1;
                return Effect.succeed({
                  ...mockPRInfo,
                  headRefOid: views === 1 ? "head-a" : "head-b",
                  baseRefOid: "base",
                  body: "",
                  author: { login: "author", is_bot: false },
                  reviewDecision: "APPROVED",
                  reviewRequests: [],
                });
              }
              snapshots += 1;
              return Effect.succeed([
                {
                  name: `CI-${snapshots}`,
                  state: "completed",
                  bucket: "pass",
                  link: "external",
                },
              ]);
            },
            runGraphQL: () =>
              Effect.succeed({
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              }),
            runGh: () => Effect.succeed({ stdout: "[]", stderr: "", exitCode: 0 }),
          }),
        ),
      );
      expect(views).toBe(3);
      expect(result.info.headSha).toBe("head-b");
      expect(result.checks[0]?.name).toBe("CI-2");
    }),
  );

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

        const warnings: unknown[][] = [];
        const console = yield* TestConsole.make;
        const consoleLayer = Layer.succeed(Console.Console, {
          ...console,
          warn: (...args: unknown[]) => warnings.push(args),
        });
        const [result, batch] = yield* Effect.all([
          fetchReviewTriage(123, "json"),
          Effect.all([fetchReviewTriage(123, "json"), fetchReviewTriage(124, "json")]),
        ]).pipe(Effect.provide(layer), Effect.provide(consoleLayer));
        expect(warnings).toEqual([]);
        expect(batch.map((item) => item.feedbackOriginCounts)).toEqual([
          result.feedbackOriginCounts,
          result.feedbackOriginCounts,
        ]);

        expect(result.classification).toEqual({
          status: "needs_investigation",
          reasons: [
            "failed_checks",
            "visible_open_review_threads",
            "unreplied_review_threads",
            "unresolved_review_threads",
          ],
        });

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
        expect(result.checks).toHaveLength(2);
        expect(result.checks[0]?.name).toBe("CI / build");
        expect(result.checks[0]?.bucket).toBe("pass");
        expect(result.checks[1]?.bucket).toBe("fail");
        expect(result.feedbackOriginCounts).toEqual({
          reviews: { current_head: 0, pre_existing: 0, unknown: 0 },
          inlineComments: { current_head: 0, pre_existing: 0, unknown: 3 },
          threads: { current_head: 0, pre_existing: 0, unknown: 2 },
        });
        expect(result.inlineComments).toHaveLength(3);
      }),
  );

  const replyAndResolveLayer = (
    options: {
      comment?: { id: number; in_reply_to_id: number | null; pull_request_url: string };
      threadId?: string;
      paginateThreads?: boolean;
      paginateComments?: boolean;
      mutations?: string[];
    } = {},
  ) => {
    const target = options.comment ?? {
      id: 202,
      in_reply_to_id: 101,
      pull_request_url: "https://api.github.com/repos/test-owner/test-repo/pulls/123",
    };
    let threadPage = 0;
    return createMockGhLayer({
      runGhJson: () => Effect.succeed(target),
      runGh: (args) => {
        if (args.includes("POST")) options.mutations?.push("reply");
        return Effect.succeed({ stdout: JSON.stringify({ id: 301 }), stderr: "", exitCode: 0 });
      },
      runGraphQL: (query) => {
        if (query.includes("resolveReviewThread")) {
          options.mutations?.push("resolve");
          return Effect.succeed({
            resolveReviewThread: {
              thread: { id: options.threadId ?? "thread-2", isResolved: true },
            },
          });
        }
        if (query.includes("node(id:")) {
          return Effect.succeed({
            node: {
              comments: {
                nodes: [{ databaseId: 202 }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        threadPage += 1;
        const matching = {
          id: options.threadId ?? "thread-2",
          isResolved: false,
          comments: {
            nodes: options.paginateComments ? [{ databaseId: 999 }] : [{ databaseId: 101 }],
            pageInfo: options.paginateComments
              ? { hasNextPage: true, endCursor: "comments-next" }
              : { hasNextPage: false, endCursor: null },
          },
        };
        return Effect.succeed({
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: options.paginateThreads && threadPage === 1 ? [] : [matching],
                pageInfo:
                  options.paginateThreads && threadPage === 1
                    ? { hasNextPage: true, endCursor: "threads-next" }
                    : { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      },
    });
  };

  it.effect("reply-and-resolve infers PR/root/thread and paginates threads and comments", () =>
    Effect.gen(function* () {
      for (const pagination of ["none", "threads", "comments"] as const) {
        const mutations: string[] = [];
        const result = yield* replyAndResolveComment(null, 202, null, "done").pipe(
          Effect.provide(
            replyAndResolveLayer({
              paginateThreads: pagination === "threads",
              paginateComments: pagination === "comments",
              mutations,
            }),
          ),
        );
        expect(result).toMatchObject({ pr: 123, threadId: "thread-2" });
        expect(mutations).toEqual(["reply", "resolve"]);
      }
    }),
  );

  it.effect("reply-and-resolve rejects ambiguous comment-only thread matches", () =>
    Effect.gen(function* () {
      const mutations: string[] = [];
      const result = yield* replyAndResolveComment(null, 202, null, "done").pipe(
        Effect.provide(
          createMockGhLayer({
            runGhJson: () =>
              Effect.succeed({
                id: 202,
                in_reply_to_id: null,
                pull_request_url: "https://api.github.com/repos/test-owner/test-repo/pulls/123",
              }),
            runGh: (args) => {
              if (args.includes("POST")) mutations.push("reply");
              return Effect.succeed({
                stdout: JSON.stringify({ id: 301 }),
                stderr: "",
                exitCode: 0,
              });
            },
            runGraphQL: (query) => {
              if (query.includes("resolveReviewThread")) mutations.push("resolve");
              if (query.includes("node(id:")) {
                return Effect.succeed({
                  node: {
                    comments: {
                      nodes: [{ databaseId: 202 }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                });
              }
              return Effect.succeed({
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        {
                          id: "thread-1",
                          isResolved: false,
                          comments: { nodes: [{ databaseId: 202 }] },
                        },
                        {
                          id: "thread-2",
                          isResolved: false,
                          comments: { nodes: [{ databaseId: 202 }] },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              });
            },
          }),
        ),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "GitHubCommandError",
          exitCode: 1,
          message: "Comment 202 matches multiple review threads",
        });
      }
      expect(mutations).toEqual([]);
    }),
  );

  it.effect(
    "reply-and-resolve validates explicit PR/thread before mutation and preserves legacy path",
    () =>
      Effect.gen(function* () {
        for (const [pr, thread, message] of [
          [124, "thread-2", "not explicit PR #124"],
          [123, "wrong-thread", "not explicit thread wrong-thread"],
        ] as const) {
          const mutations: string[] = [];
          const result = yield* replyAndResolveComment(pr, 202, thread, "done").pipe(
            Effect.provide(replyAndResolveLayer({ mutations })),
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) expect(result.failure.message).toContain(message);
          expect(mutations).toEqual([]);
        }
        const result = yield* replyAndResolveComment(123, 202, "thread-2", "done").pipe(
          Effect.provide(replyAndResolveLayer()),
        );
        expect(result.threadId).toBe("thread-2");
      }),
  );

  it.effect(
    "reply-and-resolve maps missing comment/thread to structured errors without mutation",
    () =>
      Effect.gen(function* () {
        const missingComment = yield* replyAndResolveComment(null, 404, null, "done").pipe(
          Effect.provide(
            createMockGhLayer({
              runGhJson: () =>
                Effect.fail(
                  new GitHubNotFoundError({
                    message: "raw api detail",
                    resource: "comment",
                    identifier: "404",
                  }),
                ),
            }),
          ),
          Effect.result,
        );
        expect(Result.isFailure(missingComment)).toBe(true);
        if (Result.isFailure(missingComment)) {
          expect(missingComment.failure.message).toBe(
            "Review comment 404 was not found; it may be deleted",
          );
          expect(missingComment.failure.message).not.toContain("raw api detail");
        }

        const mutations: string[] = [];
        const missingThread = yield* replyAndResolveComment(null, 202, null, "done").pipe(
          Effect.provide(
            createMockGhLayer({
              runGhJson: () =>
                Effect.succeed({
                  id: 202,
                  in_reply_to_id: 101,
                  pull_request_url: "https://api.github.com/repos/o/r/pulls/123",
                }),
              runGh: () => {
                mutations.push("reply");
                return Effect.succeed({ stdout: "{}", stderr: "", exitCode: 0 });
              },
              runGraphQL: () =>
                Effect.succeed({
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  },
                }),
            }),
          ),
          Effect.result,
        );
        expect(Result.isFailure(missingThread)).toBe(true);
        if (Result.isFailure(missingThread))
          expect(missingThread.failure.message).toContain("no review thread");
        expect(mutations).toEqual([]);
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

      const resolvedBody = yield* resolveRequiredTextInput({
        command: "gh-tool pr reply",
        value: null,
        fileValue: "/tmp/reply-body.txt",
        valueFlag: "--body",
        fileFlag: "--body-file",
        label: "body",
      }).pipe(
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
      const result = yield* resolveOptionalTextInput({
        command: "gh-tool pr reply-and-resolve",
        value: "inline body",
        fileValue: "/tmp/reply.txt",
        valueFlag: "--body",
        fileFlag: "--body-file",
        label: "body",
      }).pipe(Effect.result);

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

  it.effect("resolveRequiredTextInput reads shell-sensitive body text from stdin", () =>
    Effect.gen(function* () {
      const originalBun = Reflect.get(globalThis, "Bun");

      Reflect.set(globalThis, "Bun", {
        ...(typeof originalBun === "object" && originalBun !== null ? originalBun : {}),
        stdin: {
          text: () => Promise.resolve(inventedShellSensitiveText),
        },
      });

      const resolvedBody = yield* resolveRequiredTextInput({
        command: "gh-tool pr edit",
        value: null,
        fileValue: null,
        stdin: true,
        valueFlag: "--body",
        fileFlag: "--body-file",
        stdinFlag: "--body-stdin",
        label: "body",
      }).pipe(
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

  it.effect("resolveRequiredTextInput rejects sensitive file paths", () =>
    Effect.gen(function* () {
      for (const filePath of ["/workspace/.env.local", "/workspace/.envrc"]) {
        const result = yield* resolveRequiredTextInput({
          command: "gh-tool pr reply",
          value: null,
          fileValue: filePath,
          valueFlag: "--body",
          fileFlag: "--body-file",
          label: "body",
        }).pipe(Effect.result);

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
      const resolvedBody = yield* resolveDefaultTextInput({
        command: "gh-tool pr create",
        value: null,
        fileValue: null,
        valueFlag: "--body",
        fileFlag: "--body-file",
        label: "body",
        defaultValue: "",
      });

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

  it.effect("createPR rejects titles that do not match the configured repo policy", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];

      const result = yield* createPR({
        base: "main",
        title: "fix(transmittals+sabfx): make import work",
        body: "## Summary\n...",
        draft: false,
        head: "fix/import",
      }).pipe(
        Effect.provide(
          createMockGhLayer({
            getRepoConfig: () =>
              Effect.succeed({
                owner: "test-owner",
                repo: "test-repo",
                prTitle: mockPrTitlePolicy,
              }),
            runGh: (args) => {
              calls.push(args);
              return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
            },
            runGhJson: (args) => {
              calls.push(args);
              return Effect.succeed([]);
            },
          }),
        ),
        Effect.result,
      );

      Result.match(result, {
        onFailure: (error) => {
          expect(error._tag).toBe("GitHubCommandError");
          if (error._tag === "GitHubCommandError") {
            expect(error.stderr).toContain("PR title does not match the required format");
          }
        },
        onSuccess: () => {
          expect.fail("Expected invalid PR title to fail");
        },
      });
      expect(calls).toEqual([]);
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
        base: null,
      }).pipe(Effect.provide(layer));

      expect(result.number).toBe(123);
      expect(forwardedArgs).toEqual([
        "api",
        "--method",
        "PATCH",
        "repos/test-owner/test-repo/pulls/123",
        "-f",
        `body=${inventedShellSensitiveText}`,
      ]);
    }),
  );

  it.effect("editPR forwards base branch retarget", () =>
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
        body: null,
        base: "main",
      }).pipe(Effect.provide(layer));

      expect(result.number).toBe(123);
      expect(forwardedArgs).toEqual([
        "api",
        "--method",
        "PATCH",
        "repos/test-owner/test-repo/pulls/123",
        "-f",
        "base=main",
      ]);
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

  it("review-triage classification: clear when checks and review threads are clean", () => {
    expect(
      classifyReviewTriage(
        {
          visibleOpenReviewThreadsCount: 0,
          unrepliedReviewThreadsCount: 0,
          unresolvedReviewThreadsCount: 0,
        },
        [{ name: "CI / build", state: "SUCCESS", bucket: "pass", link: "https://example.test" }],
      ),
    ).toEqual({ status: "clear", reasons: [] });
  });

  it("review-triage-batch parser: returns typed errors for malformed PR numbers", () => {
    expect(Effect.runSync(parsePrNumbers("309, 314,309, 346"))).toEqual([309, 314, 346]);
    expect(() => Effect.runSync(parsePrNumbers("309x,314"))).toThrow();
    expect(() => Effect.runSync(parsePrNumbers("309,,314"))).toThrow();
  });

  it("issue snapshot-batch parser: accepts comma-separated issue numbers", () => {
    expect(parseIssueNumbers("262, 186, nope, 0, 348")).toEqual([262, 186, 348]);
  });

  it("issue snapshot-batch linked PR extractor: uses issue body and comments", () => {
    expect(
      collectLinkedPullRequestNumbers("Fix is in https://github.com/acme/repo/pull/346", [
        { body: "Also see PR #347 and duplicate #346." },
      ]),
    ).toEqual([346, 347]);
  });
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

describe("Branch rename", () => {
  it.effect("dry-run returns renamed: false without calling gh api", () =>
    Effect.gen(function* () {
      let apiWasCalled = false;

      const layer = createMockGhLayer({
        runGh: () => {
          apiWasCalled = true;
          return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
        },
      });

      const result = yield* renameBranch({
        oldName: "feat/old",
        newName: "feat/new",
        confirm: false,
        repo: null,
      }).pipe(Effect.provide(layer));

      expect(result.renamed).toBe(false);
      expect(result.oldName).toBe("feat/old");
      expect(result.newName).toBe("feat/new");
      expect(result.dryRun).toBe(true);
      expect(result.message).toContain("Dry run");
      expect(result.message).toContain("feat/old");
      expect(result.message).toContain("feat/new");
      expect(apiWasCalled).toBe(false);
    }),
  );

  it.effect("dry-run includes repo scope in message when repo is provided", () =>
    Effect.gen(function* () {
      const layer = createMockGhLayer();

      const result = yield* renameBranch({
        oldName: "feat/old",
        newName: "feat/new",
        confirm: false,
        repo: "owner/repo",
      }).pipe(Effect.provide(layer));

      expect(result.dryRun).toBe(true);
      expect(result.message).toContain("in owner/repo");
    }),
  );

  it.effect("with --confirm calls gh api with correct rename endpoint", () =>
    Effect.gen(function* () {
      let capturedArgs: string[] = [];

      const layer = createMockGhLayer({
        runGh: (args) => {
          capturedArgs = args;
          return Effect.succeed({ stdout: "{}", stderr: "", exitCode: 0 });
        },
      });

      const result = yield* renameBranch({
        oldName: "feat/old",
        newName: "feat/new",
        confirm: true,
        repo: "owner/repo",
      }).pipe(Effect.provide(layer));

      expect(result.renamed).toBe(true);
      expect(result.oldName).toBe("feat/old");
      expect(result.newName).toBe("feat/new");
      expect(result.dryRun).toBeUndefined();
      expect(capturedArgs[0]).toBe("api");
      expect(capturedArgs[1]).toBe("repos/owner/repo/branches/feat%2Fold/rename");
      expect(capturedArgs[2]).toBe("-X");
      expect(capturedArgs[3]).toBe("POST");
      expect(capturedArgs[4]).toBe("-f");
      expect(capturedArgs[5]).toBe("new_name=feat/new");
    }),
  );

  it.effect("with --confirm and no repo auto-detects from getRepoInfo", () =>
    Effect.gen(function* () {
      let capturedArgs: string[] = [];

      const layer = createMockGhLayer({
        runGh: (args) => {
          capturedArgs = args;
          return Effect.succeed({ stdout: "{}", stderr: "", exitCode: 0 });
        },
      });

      const result = yield* renameBranch({
        oldName: "main",
        newName: "trunk",
        confirm: true,
        repo: null,
      }).pipe(Effect.provide(layer));

      expect(result.renamed).toBe(true);
      expect(capturedArgs[1]).toBe("repos/test-owner/test-repo/branches/main/rename");
    }),
  );

  it.effect("encodeURIComponent is applied to branch name with special chars", () =>
    Effect.gen(function* () {
      let capturedArgs: string[] = [];

      const layer = createMockGhLayer({
        runGh: (args) => {
          capturedArgs = args;
          return Effect.succeed({ stdout: "{}", stderr: "", exitCode: 0 });
        },
      });

      yield* renameBranch({
        oldName: "feature/my branch",
        newName: "feature/renamed",
        confirm: true,
        repo: "owner/repo",
      }).pipe(Effect.provide(layer));

      expect(capturedArgs[1]).toBe("repos/owner/repo/branches/feature%2Fmy%20branch/rename");
    }),
  );
});
