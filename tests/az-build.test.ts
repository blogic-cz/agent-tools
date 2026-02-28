import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Layer } from "effect";

import type { BuildJob, BuildTimeline, BuildLogs, PipelineRun } from "../src/az-tool/types";

import {
  getBuildTimeline,
  getBuildJobs,
  getBuildLogs,
  getBuildLogContent,
  getBuildJobSummary,
  findFailedJobs,
  listPipelineRuns,
} from "../src/az-tool/build";
import { AzService } from "../src/az-tool/service";

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
        onFailure: () => {},
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
        onFailure: () => {},
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
