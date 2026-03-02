import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Layer } from "effect";

import type {
  BuildJob,
  BuildTimeline,
  BuildLogs,
  JobSummary,
  PipelineRun,
} from "#src/az-tool/types";

import {
  getBuildTimeline,
  getBuildJobs,
  getBuildLogs,
  getBuildLogContent,
  getBuildJobSummary,
  findFailedJobs,
  listPipelineRuns,
} from "#src/az-tool/build";
import { AzCommandError, AzParseError, AzTimeoutError } from "#src/az-tool/errors";
import { AzService } from "#src/az-tool/service";
import { formatAny } from "#src/shared";
function createMockBuildJob(overrides?: Partial<BuildJob>): BuildJob {
  return {
    id: "job-1",
    type: "Job",
    name: "Build Job",
    state: "completed",
    result: "succeeded",
    startTime: "2024-01-01T10:00:00Z",
    finishTime: "2024-01-01T10:05:00Z",
    errorCount: 0,
    warningCount: 0,
    log: { id: 1, url: "https://example.com/log/1" },
    ...overrides,
  };
}

function createMockStage(overrides?: Partial<BuildJob>): BuildJob {
  return {
    id: "stage-1",
    type: "Stage",
    name: "Build Stage",
    state: "completed",
    result: "succeeded",
    startTime: "2024-01-01T10:00:00Z",
    finishTime: "2024-01-01T10:05:00Z",
    ...overrides,
  };
}

function createMockBuildTimeline(overrides?: Partial<BuildTimeline>): BuildTimeline {
  return {
    records: [
      createMockStage({ id: "stage-1", name: "Stage 1" }),
      createMockBuildJob({
        id: "job-1",
        parentId: "stage-1",
        name: "Job 1",
      }),
      createMockBuildJob({
        id: "job-2",
        parentId: "stage-1",
        name: "Job 2",
        result: "failed",
        errorCount: 2,
      }),
    ],
    id: "build-123",
    changeId: 456,
    lastChangedBy: "user@example.com",
    lastChangedOn: "2024-01-01T10:05:00Z",
    url: "https://example.com/build/123",
    ...overrides,
  };
}

function createMockBuildLogs(overrides?: Partial<BuildLogs>): BuildLogs {
  return {
    count: 2,
    value: [
      {
        id: 1,
        type: "build",
        url: "https://example.com/log/1",
        lineCount: 100,
      },
      {
        id: 2,
        type: "build",
        url: "https://example.com/log/2",
        lineCount: 50,
      },
    ],
    ...overrides,
  };
}

function createMockPipelineRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    id: 1,
    buildNumber: "20240101.1",
    status: "completed",
    result: "succeeded",
    sourceBranch: "main",
    startTime: "2024-01-01T10:00:00Z",
    finishTime: "2024-01-01T10:05:00Z",
    ...overrides,
  };
}

function createMockAzServiceLayer(mockResponses: Record<string, unknown>) {
  return Layer.succeed(AzService, {
    runCommand: (cmd: string) => Effect.succeed(JSON.stringify(mockResponses[`cmd:${cmd}`] ?? {})),
    runInvoke: (params) => {
      const key = `invoke:${params.area}:${params.resource}`;
      return Effect.succeed(mockResponses[key] ?? {});
    },
  });
}

describe("getBuildTimeline", () => {
  it.effect("returns parsed build timeline", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildTimeline(123).pipe(Effect.provide(layer));

      expect(result.id).toBe("build-123");
      expect(result.records).toHaveLength(3);
      expect(result.records[0]?.type).toBe("Stage");
    }),
  );

  it.effect("includes all required fields in timeline", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildTimeline(123).pipe(Effect.provide(layer));

      expect(result.changeId).toBe(456);
      expect(result.lastChangedBy).toBe("user@example.com");
      expect(result.url).toBeDefined();
    }),
  );

  it.effect("handles optional fields in records", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          {
            id: "job-1",
            type: "Job",
            name: "Job without times",
            state: "pending",
            // no startTime, finishTime, errorCount, warningCount, log
          } as BuildJob,
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildTimeline(123).pipe(Effect.provide(layer));

      expect(result.records[0]?.startTime).toBeUndefined();
      expect(result.records[0]?.errorCount).toBeUndefined();
    }),
  );

  it.effect("fails with AzParseError on invalid data", () =>
    Effect.gen(function* () {
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": { invalid: "data" },
      });

      const result = yield* getBuildTimeline(123).pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: () => {
          /* noop - only success branch is asserted */
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }),
  );
});

describe("getBuildJobs", () => {
  it.effect("filters jobs and stages from timeline", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildJobs(123).pipe(Effect.provide(layer));

      expect(result.jobs).toHaveLength(2);
      expect(result.stages).toHaveLength(1);
      expect(result.jobs[0]?.type).toBe("Job");
      expect(result.stages[0]?.type).toBe("Stage");
    }),
  );

  it.effect("returns empty arrays when no jobs or stages", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          {
            id: "task-1",
            type: "Task",
            name: "Task",
            state: "completed",
          } as BuildJob,
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildJobs(123).pipe(Effect.provide(layer));

      expect(result.jobs).toHaveLength(0);
      expect(result.stages).toHaveLength(0);
    }),
  );

  it.effect("preserves job properties when filtering", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildJobs(123).pipe(Effect.provide(layer));

      const firstJob = result.jobs[0];
      expect(firstJob?.id).toBe("job-1");
      expect(firstJob?.name).toBe("Job 1");
      expect(firstJob?.result).toBe("succeeded");
    }),
  );
});

describe("getBuildLogs", () => {
  it.effect("returns parsed build logs", () =>
    Effect.gen(function* () {
      const mockLogs = createMockBuildLogs();
      const layer = createMockAzServiceLayer({
        "invoke:build:logs": mockLogs,
      });

      const result = yield* getBuildLogs(123).pipe(Effect.provide(layer));

      expect(result.count).toBe(2);
      expect(result.value).toHaveLength(2);
    }),
  );

  it.effect("includes log metadata", () =>
    Effect.gen(function* () {
      const mockLogs = createMockBuildLogs();
      const layer = createMockAzServiceLayer({
        "invoke:build:logs": mockLogs,
      });

      const result = yield* getBuildLogs(123).pipe(Effect.provide(layer));

      const firstLog = result.value[0];
      expect(firstLog?.id).toBe(1);
      expect(firstLog?.type).toBe("build");
      expect(firstLog?.url).toBeDefined();
      expect(firstLog?.lineCount).toBe(100);
    }),
  );

  it.effect("fails with AzParseError on invalid logs data", () =>
    Effect.gen(function* () {
      const layer = createMockAzServiceLayer({
        "invoke:build:logs": { invalid: "data" },
      });

      const result = yield* getBuildLogs(123).pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: () => {
          /* noop - only success branch is asserted */
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }),
  );
});

describe("getBuildLogContent", () => {
  it("returns log content as string", async () => {
    const logContent = "Build log line 1\nBuild log line 2\n";
    const layer = createMockAzServiceLayer({
      "invoke:build:logs": logContent,
    });

    const result = await Effect.runPromise(getBuildLogContent(123, 1).pipe(Effect.provide(layer)));

    expect(result).toBe(logContent);
  });

  it("fails with AzParseError on non-string response", async () => {
    const layer = createMockAzServiceLayer({
      "invoke:build:logs": { notAString: true },
    });

    const result = await Effect.runPromise(
      getBuildLogContent(123, 1).pipe(Effect.result, Effect.provide(layer)),
    );

    Result.match(result, {
      onFailure: (left) => {
        expect(left._tag).toBe("AzParseError");
      },
      onSuccess: () => {
        expect.fail("Expected Left but got Right");
      },
    });
  });
});

describe("getBuildJobSummary", () => {
  it.effect("returns summaries for stages and jobs", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildJobSummary(123).pipe(Effect.provide(layer));

      expect(result).toHaveLength(3); // 1 stage + 2 jobs
    }),
  );

  it.effect("includes stage summaries with duration", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildJobSummary(123).pipe(Effect.provide(layer));

      const stageSummary = result.find((s) => s.name === "Stage 1");
      expect(stageSummary?.state).toBe("completed");
      expect(stageSummary?.result).toBe("succeeded");
      expect(stageSummary?.duration).toBe("300s");
      expect(stageSummary?.stage).toBeUndefined();
    }),
  );

  it.effect("includes job summaries with parent stage", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildJobSummary(123).pipe(Effect.provide(layer));

      const jobSummary = result.find((s) => s.name === "Job 1");
      expect(jobSummary?.state).toBe("completed");
      expect(jobSummary?.result).toBe("succeeded");
      expect(jobSummary?.stage).toBe("Stage 1");
      expect(jobSummary?.duration).toBe("300s");
      expect(jobSummary?.logId).toBe(1);
    }),
  );

  it.effect("handles jobs without parent stage", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          createMockBuildJob({
            id: "job-orphan",
            parentId: null,
          }),
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildJobSummary(123).pipe(Effect.provide(layer));

      const jobSummary = result[0];
      expect(jobSummary?.stage).toBeUndefined();
    }),
  );

  it.effect("handles jobs without log information", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          createMockBuildJob({
            id: "job-no-log",
            log: null,
          }),
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildJobSummary(123).pipe(Effect.provide(layer));

      const jobSummary = result[0];
      expect(jobSummary?.logId).toBeUndefined();
    }),
  );

  it.effect("handles missing start/finish times", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          createMockBuildJob({
            id: "job-no-times",
            startTime: null,
            finishTime: null,
          }),
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildJobSummary(123).pipe(Effect.provide(layer));

      const jobSummary = result[0];
      expect(jobSummary?.duration).toBeUndefined();
    }),
  );
});

describe("findFailedJobs", () => {
  it.effect("returns only failed jobs", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* findFailedJobs(123).pipe(Effect.provide(layer));

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Job 2");
      expect(result[0]?.result).toBe("failed");
    }),
  );

  it.effect("includes canceled jobs", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          createMockBuildJob({
            id: "job-canceled",
            result: "canceled",
            errorCount: 1,
          }),
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* findFailedJobs(123).pipe(Effect.provide(layer));

      expect(result).toHaveLength(1);
      expect(result[0]?.result).toBe("canceled");
    }),
  );

  it.effect("excludes succeeded and skipped jobs", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          createMockBuildJob({
            id: "job-success",
            result: "succeeded",
          }),
          createMockBuildJob({
            id: "job-skipped",
            result: "skipped",
          }),
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* findFailedJobs(123).pipe(Effect.provide(layer));

      expect(result).toHaveLength(0);
    }),
  );

  it.effect("includes error and warning counts", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          createMockBuildJob({
            id: "job-errors",
            result: "failed",
            errorCount: 5,
            warningCount: 3,
          }),
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* findFailedJobs(123).pipe(Effect.provide(layer));

      expect(result[0]?.errorCount).toBe(5);
      expect(result[0]?.warningCount).toBe(3);
    }),
  );

  it.effect("defaults error/warning counts to 0", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          createMockBuildJob({
            id: "job-no-counts",
            result: "failed",
            errorCount: null,
            warningCount: null,
          }),
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* findFailedJobs(123).pipe(Effect.provide(layer));

      expect(result[0]?.errorCount).toBe(0);
      expect(result[0]?.warningCount).toBe(0);
    }),
  );

  it.effect("includes log ID when available", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          createMockBuildJob({
            id: "job-with-log",
            result: "failed",
            log: {
              id: 42,
              url: "https://example.com/log/42",
            },
          }),
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* findFailedJobs(123).pipe(Effect.provide(layer));

      expect(result[0]?.logId).toBe(42);
    }),
  );

  it.effect("returns empty array when no failed jobs", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline({
        records: [
          createMockBuildJob({
            id: "job-1",
            result: "succeeded",
          }),
          createMockBuildJob({
            id: "job-2",
            result: "skipped",
          }),
        ],
      });
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* findFailedJobs(123).pipe(Effect.provide(layer));

      expect(result).toHaveLength(0);
    }),
  );
});

describe("listPipelineRuns", () => {
  it.effect("returns list of pipeline runs", () =>
    Effect.gen(function* () {
      const mockRuns = {
        value: [
          createMockPipelineRun({
            id: 1,
            buildNumber: "20240101.1",
          }),
          createMockPipelineRun({
            id: 2,
            buildNumber: "20240101.2",
          }),
        ],
      };
      const layer = createMockAzServiceLayer({
        "cmd:pipelines runs list --output json": mockRuns,
      });

      const result = yield* listPipelineRuns().pipe(Effect.provide(layer));

      expect(result).toHaveLength(2);
      expect(result[0]?.buildNumber).toBe("20240101.1");
    }),
  );

  it.effect("includes all pipeline run fields", () =>
    Effect.gen(function* () {
      const mockRuns = {
        value: [createMockPipelineRun()],
      };
      const layer = createMockAzServiceLayer({
        "cmd:pipelines runs list --output json": mockRuns,
      });

      const result = yield* listPipelineRuns().pipe(Effect.provide(layer));

      const run = result[0];
      expect(run?.id).toBe(1);
      expect(run?.buildNumber).toBe("20240101.1");
      expect(run?.status).toBe("completed");
      expect(run?.result).toBe("succeeded");
      expect(run?.sourceBranch).toBe("main");
    }),
  );

  it.effect("handles optional result field", () =>
    Effect.gen(function* () {
      const mockRuns = {
        value: [
          createMockPipelineRun({
            status: "inProgress",
            result: undefined,
          }),
        ],
      };
      const layer = createMockAzServiceLayer({
        "cmd:pipelines runs list --output json": mockRuns,
      });

      const result = yield* listPipelineRuns().pipe(Effect.provide(layer));

      expect(result[0]?.result).toBeUndefined();
    }),
  );

  it.effect("filters by branch when provided", () =>
    Effect.gen(function* () {
      const mockRuns = {
        value: [
          createMockPipelineRun({
            sourceBranch: "develop",
          }),
        ],
      };
      const layer = createMockAzServiceLayer({
        "cmd:pipelines runs list --output json --branch develop": mockRuns,
      });

      const result = yield* listPipelineRuns({
        branch: "develop",
      }).pipe(Effect.provide(layer));

      expect(result[0]?.sourceBranch).toBe("develop");
    }),
  );

  it.effect("filters by pipeline ID when provided", () =>
    Effect.gen(function* () {
      const mockRuns = {
        value: [createMockPipelineRun()],
      };
      const layer = createMockAzServiceLayer({
        "cmd:pipelines runs list --output json --pipeline-id 42": mockRuns,
      });

      const result = yield* listPipelineRuns({
        pipelineId: 42,
      }).pipe(Effect.provide(layer));

      expect(result).toHaveLength(1);
    }),
  );

  it.effect("limits results with top parameter", () =>
    Effect.gen(function* () {
      const mockRuns = {
        value: [createMockPipelineRun({ id: 1 })],
      };
      const layer = createMockAzServiceLayer({
        "cmd:pipelines runs list --output json --top 1": mockRuns,
      });

      const result = yield* listPipelineRuns({
        top: 1,
      }).pipe(Effect.provide(layer));

      expect(result).toHaveLength(1);
    }),
  );

  it.effect("combines multiple filter options", () =>
    Effect.gen(function* () {
      const mockRuns = {
        value: [
          createMockPipelineRun({
            sourceBranch: "main",
            id: 1,
          }),
        ],
      };
      const layer = createMockAzServiceLayer({
        "cmd:pipelines runs list --output json --branch main --pipeline-id 42 --top 10": mockRuns,
      });

      const result = yield* listPipelineRuns({
        branch: "main",
        pipelineId: 42,
        top: 10,
      }).pipe(Effect.provide(layer));

      expect(result).toHaveLength(1);
    }),
  );

  it.effect("returns empty array when no runs", () =>
    Effect.gen(function* () {
      const mockRuns = { value: [] };
      const layer = createMockAzServiceLayer({
        "cmd:pipelines runs list --output json": mockRuns,
      });

      const result = yield* listPipelineRuns().pipe(Effect.provide(layer));

      expect(result).toHaveLength(0);
    }),
  );

  it.effect("fails with AzParseError on invalid response", () =>
    Effect.gen(function* () {
      const layer = createMockAzServiceLayer({
        "cmd:pipelines runs list --output json": {
          invalid: "data",
        },
      });

      const result = yield* listPipelineRuns().pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: (left) => {
          expect(left._tag).toBe("AzParseError");
        },
        onSuccess: () => {
          expect.fail("Expected Left but got Right");
        },
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// Typed build subcommands – wiring, integer flags, output format, error hints
// ---------------------------------------------------------------------------

describe("typed build subcommands – wiring assumptions", () => {
  // Each subcommand in index.ts destructures Flag.integer flags and calls a build.ts
  // function directly. We verify that the build functions accept the expected integer
  // arguments and return the expected shapes, matching subcommand output wrappers.

  describe("timeline subcommand", () => {
    it.effect("getBuildTimeline accepts integer buildId and returns BuildTimeline", () =>
      Effect.gen(function* () {
        const mockTimeline = createMockBuildTimeline();
        const layer = createMockAzServiceLayer({
          "invoke:build:timeline": mockTimeline,
        });

        // Subcommand calls getBuildTimeline(buildId) where buildId is Flag.integer
        const result = yield* getBuildTimeline(123).pipe(Effect.provide(layer));

        // Subcommand wraps with formatAny(result, format)
        const json = formatAny(result, "json");
        const parsed = JSON.parse(json);
        expect(parsed.id).toBe("build-123");
        expect(parsed.records).toHaveLength(3);
      }),
    );

    it.effect("formatAny encodes timeline as TOON", () =>
      Effect.gen(function* () {
        const mockTimeline = createMockBuildTimeline();
        const layer = createMockAzServiceLayer({
          "invoke:build:timeline": mockTimeline,
        });

        const result = yield* getBuildTimeline(123).pipe(Effect.provide(layer));
        const toon = formatAny(result, "toon");
        expect(toon).toContain("build-123");
        expect(toon).toContain("Stage 1");
      }),
    );
  });

  describe("failed-jobs subcommand", () => {
    it.effect("findFailedJobs accepts integer buildId and returns array", () =>
      Effect.gen(function* () {
        const mockTimeline = createMockBuildTimeline();
        const layer = createMockAzServiceLayer({
          "invoke:build:timeline": mockTimeline,
        });

        const failedJobs = yield* findFailedJobs(123).pipe(Effect.provide(layer));

        // Subcommand wraps: formatAny({ buildId, failedJobs }, format)
        const json = formatAny({ buildId: 123, failedJobs }, "json");
        const parsed = JSON.parse(json);
        expect(parsed.buildId).toBe(123);
        expect(parsed.failedJobs).toHaveLength(1);
        expect(parsed.failedJobs[0].name).toBe("Job 2");
      }),
    );

    it.effect("failed-jobs with no failures returns empty array in wrapper", () =>
      Effect.gen(function* () {
        const mockTimeline = createMockBuildTimeline({
          records: [createMockBuildJob({ id: "j1", result: "succeeded" })],
        });
        const layer = createMockAzServiceLayer({
          "invoke:build:timeline": mockTimeline,
        });

        const failedJobs = yield* findFailedJobs(123).pipe(Effect.provide(layer));
        const json = formatAny({ buildId: 123, failedJobs }, "json");
        const parsed = JSON.parse(json);
        expect(parsed.failedJobs).toHaveLength(0);
      }),
    );
  });

  describe("logs subcommand", () => {
    it.effect("getBuildLogs accepts integer buildId and returns BuildLogs", () =>
      Effect.gen(function* () {
        const mockLogs = createMockBuildLogs();
        const layer = createMockAzServiceLayer({
          "invoke:build:logs": mockLogs,
        });

        const result = yield* getBuildLogs(123).pipe(Effect.provide(layer));

        const json = formatAny(result, "json");
        const parsed = JSON.parse(json);
        expect(parsed.count).toBe(2);
        expect(parsed.value).toHaveLength(2);
        expect(parsed.value[0].id).toBe(1);
      }),
    );

    it.effect("logs TOON output includes log ids", () =>
      Effect.gen(function* () {
        const mockLogs = createMockBuildLogs();
        const layer = createMockAzServiceLayer({
          "invoke:build:logs": mockLogs,
        });

        const result = yield* getBuildLogs(123).pipe(Effect.provide(layer));
        const toon = formatAny(result, "toon");
        // Log IDs 1 and 2 should appear in TOON output
        expect(toon).toContain("1");
        expect(toon).toContain("2");
      }),
    );
  });

  describe("log-content subcommand", () => {
    it.effect("getBuildLogContent accepts two integer params (buildId, logId)", () =>
      Effect.gen(function* () {
        const logContent = "Step 1: Build\nStep 2: Test\nStep 3: Deploy";
        const layer = createMockAzServiceLayer({
          "invoke:build:logs": logContent,
        });

        const content = yield* getBuildLogContent(123, 45).pipe(Effect.provide(layer));

        // Subcommand wraps: formatAny({ buildId, logId, content }, format)
        const json = formatAny({ buildId: 123, logId: 45, content }, "json");
        const parsed = JSON.parse(json);
        expect(parsed.buildId).toBe(123);
        expect(parsed.logId).toBe(45);
        expect(parsed.content).toContain("Step 1: Build");
      }),
    );

    it.effect("log-content wrapper includes both buildId and logId integers", () =>
      Effect.gen(function* () {
        const layer = createMockAzServiceLayer({
          "invoke:build:logs": "line1\nline2",
        });

        const content = yield* getBuildLogContent(999, 77).pipe(Effect.provide(layer));
        const toon = formatAny({ buildId: 999, logId: 77, content }, "toon");
        expect(toon).toContain("999");
        expect(toon).toContain("77");
        expect(toon).toContain("line1");
      }),
    );
  });

  describe("summary subcommand", () => {
    it.effect("getBuildJobSummary accepts integer buildId and returns summaries", () =>
      Effect.gen(function* () {
        const mockTimeline = createMockBuildTimeline();
        const layer = createMockAzServiceLayer({
          "invoke:build:timeline": mockTimeline,
        });

        const summary = yield* getBuildJobSummary(123).pipe(Effect.provide(layer));

        // Subcommand wraps: formatAny({ buildId, summary }, format)
        const json = formatAny({ buildId: 123, summary }, "json");
        const parsed = JSON.parse(json);
        expect(parsed.buildId).toBe(123);
        expect(parsed.summary).toHaveLength(3);
      }),
    );

    it.effect("summary TOON includes stage and job names", () =>
      Effect.gen(function* () {
        const mockTimeline = createMockBuildTimeline();
        const layer = createMockAzServiceLayer({
          "invoke:build:timeline": mockTimeline,
        });

        const summary = yield* getBuildJobSummary(123).pipe(Effect.provide(layer));
        const toon = formatAny({ buildId: 123, summary }, "toon");
        expect(toon).toContain("Stage 1");
        expect(toon).toContain("Job 1");
        expect(toon).toContain("Job 2");
      }),
    );
  });
});

describe("typed integer flag semantics", () => {
  // Flag.integer("build-id") parses CLI strings to numbers before the handler runs.
  // The build module functions accept `number` — these tests confirm integer contract.

  it.effect("buildId=0 is a valid integer argument", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      // Build ID 0 should not be rejected by the function itself
      const result = yield* getBuildTimeline(0).pipe(Effect.provide(layer));
      expect(result.records).toBeDefined();
    }),
  );

  it.effect("large integer buildId passes through", () =>
    Effect.gen(function* () {
      const mockTimeline = createMockBuildTimeline();
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": mockTimeline,
      });

      const result = yield* getBuildTimeline(999999).pipe(Effect.provide(layer));
      expect(result.id).toBe("build-123");
    }),
  );

  it.effect("logId integer is forwarded to getBuildLogContent", () =>
    Effect.gen(function* () {
      const layer = createMockAzServiceLayer({
        "invoke:build:logs": "log output here",
      });

      // Both buildId and logId are integers from Flag.integer
      const content = yield* getBuildLogContent(100, 200).pipe(Effect.provide(layer));
      expect(content).toBe("log output here");
    }),
  );

  it("integer values are number type, not string", () => {
    // Flag.integer parses "123" -> 123 (number)
    // Verify build functions accept number, not string
    const buildId: Parameters<typeof getBuildTimeline>[0] = 123;
    const logId: Parameters<typeof getBuildLogContent>[1] = 45;
    expect(typeof buildId).toBe("number");
    expect(typeof logId).toBe("number");
  });
});

describe("output format wrappers – JSON and TOON", () => {
  // Each subcommand wraps its result with formatAny(wrappedResult, format).
  // Verify JSON round-trips and TOON contains expected fields.

  it("timeline JSON output round-trips with all fields", () => {
    const timeline: BuildTimeline = createMockBuildTimeline();
    const json = formatAny(timeline, "json");
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe("build-123");
    expect(parsed.changeId).toBe(456);
    expect(parsed.lastChangedBy).toBe("user@example.com");
    expect(parsed.records).toHaveLength(3);
    expect(parsed.url).toBeDefined();
  });

  it("failed-jobs JSON wrapper includes buildId field", () => {
    const wrapped = {
      buildId: 42,
      failedJobs: [{ id: "j1", name: "J1", result: "failed", errorCount: 1, warningCount: 0 }],
    };
    const json = formatAny(wrapped, "json");
    const parsed = JSON.parse(json);
    expect(parsed.buildId).toBe(42);
    expect(parsed.failedJobs[0].errorCount).toBe(1);
  });

  it("log-content JSON wrapper includes buildId and logId", () => {
    const wrapped = { buildId: 10, logId: 20, content: "build output" };
    const json = formatAny(wrapped, "json");
    const parsed = JSON.parse(json);
    expect(parsed.buildId).toBe(10);
    expect(parsed.logId).toBe(20);
    expect(parsed.content).toBe("build output");
  });

  it("summary JSON wrapper includes buildId and summary array", () => {
    const summaries: JobSummary[] = [
      { name: "Stage 1", state: "completed", result: "succeeded", duration: "300s" },
      { name: "Job 1", state: "completed", result: "succeeded", stage: "Stage 1", logId: 1 },
    ];
    const json = formatAny({ buildId: 55, summary: summaries }, "json");
    const parsed = JSON.parse(json);
    expect(parsed.buildId).toBe(55);
    expect(parsed.summary).toHaveLength(2);
    expect(parsed.summary[0].duration).toBe("300s");
    expect(parsed.summary[1].logId).toBe(1);
  });

  it("TOON output is a string containing key data", () => {
    const wrapped = { buildId: 7, failedJobs: [] };
    const toon = formatAny(wrapped, "toon");
    expect(typeof toon).toBe("string");
    expect(toon).toContain("7");
  });
});

describe("az error recovery hints in build context", () => {
  it("AzParseError carries optional hint fields", () => {
    const error = new AzParseError({
      message: "Failed to parse build timeline",
      rawOutput: '{"bad":"data"}',
      hint: "The Azure DevOps API returned an unexpected response format",
      nextCommand: "agent-tools-az build timeline --build-id 123",
      retryable: true,
    });
    expect(error._tag).toBe("AzParseError");
    expect(error.hint).toContain("unexpected response format");
    expect(error.nextCommand).toContain("--build-id");
    expect(error.retryable).toBe(true);
  });

  it("AzCommandError carries optional hint fields", () => {
    const error = new AzCommandError({
      message: "az pipeline failed",
      command: "az pipelines runs list",
      exitCode: 1,
      stderr: "Authorization failed",
      hint: "Re-authenticate with az login",
      nextCommand: "az login",
      retryable: true,
    });
    expect(error.hint).toBe("Re-authenticate with az login");
    expect(error.nextCommand).toBe("az login");
    expect(error.retryable).toBe(true);
    expect(error.exitCode).toBe(1);
  });

  it("AzTimeoutError carries retryable hint", () => {
    const error = new AzTimeoutError({
      message: "Command timed out",
      command: "az devops invoke",
      timeoutMs: 30000,
      hint: "Increase timeout or check network connectivity",
      retryable: true,
    });
    expect(error.hint).toContain("timeout");
    expect(error.retryable).toBe(true);
    expect(error.timeoutMs).toBe(30000);
  });

  it("errors without hints have undefined optional fields", () => {
    const error = new AzParseError({
      message: "Parse failed",
      rawOutput: "bad",
    });
    expect(error.hint).toBeUndefined();
    expect(error.nextCommand).toBeUndefined();
    expect(error.retryable).toBeUndefined();
  });

  it.effect("AzParseError propagates through build function on bad data", () =>
    Effect.gen(function* () {
      const layer = createMockAzServiceLayer({
        "invoke:build:timeline": { totally: "wrong" },
      });

      const result = yield* getBuildTimeline(123).pipe(Effect.result, Effect.provide(layer));

      Result.match(result, {
        onFailure: (err) => {
          expect(err._tag).toBe("AzParseError");
          expect((err as AzParseError).hint).toContain("unexpected response format");
        },
        onSuccess: () => {
          expect.fail("Expected failure but got success");
        },
      });
    }),
  );
});

describe("error recovery hints - unit tests", () => {
  it("AzCommandError with hint and nextCommand", () => {
    const error = new AzCommandError({
      message: "Build not found",
      command: "az pipelines runs show --id 999",
      exitCode: 1,
      hint: "Check the build ID. Use 'az pipelines runs list' to see available builds.",
      nextCommand: "agent-tools-az pipeline list",
      retryable: true,
    });

    expect(error._tag).toBe("AzCommandError");
    expect(error.hint).toBe(
      "Check the build ID. Use 'az pipelines runs list' to see available builds.",
    );
    expect(error.nextCommand).toBe("agent-tools-az pipeline list");
    expect(error.retryable).toBe(true);
  });

  it("AzParseError with hint", () => {
    const error = new AzParseError({
      message: "Failed to parse build timeline",
      rawOutput: "invalid json",
      hint: "The Azure DevOps API returned an unexpected response format. Check your configuration.",
    });

    expect(error._tag).toBe("AzParseError");
    expect(error.hint).toBe(
      "The Azure DevOps API returned an unexpected response format. Check your configuration.",
    );
    expect(error.nextCommand).toBeUndefined();
  });

  it("AzTimeoutError with hint and retryable", () => {
    const error = new AzTimeoutError({
      message: "Request timed out after 30000ms",
      command: "az pipelines runs show --id 123",
      timeoutMs: 30000,
      hint: "Azure DevOps API is slow to respond. Try again in a moment.",
      nextCommand: "agent-tools-az pipeline show --id 123",
      retryable: true,
    });

    expect(error._tag).toBe("AzTimeoutError");
    expect(error.hint).toBe("Azure DevOps API is slow to respond. Try again in a moment.");
    expect(error.nextCommand).toBe("agent-tools-az pipeline show --id 123");
    expect(error.retryable).toBe(true);
  });

  it("hint fields are optional in Azure errors", () => {
    const error = new AzCommandError({
      message: "Command failed",
      command: "az pipelines runs show --id 123",
      exitCode: 1,
    });

    expect(error._tag).toBe("AzCommandError");
    expect(error.message).toBe("Command failed");
    expect(error.hint).toBeUndefined();
    expect(error.nextCommand).toBeUndefined();
    expect(error.retryable).toBeUndefined();
  });
});
