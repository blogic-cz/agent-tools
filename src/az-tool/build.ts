import { Effect, Schema } from "effect";

import type { BuildJob, BuildLogs, BuildTimeline, JobSummary, PipelineRun } from "./types";

import { AzParseError } from "./errors";
import { AzService } from "./service";

/**
 * Get build timeline with all records (jobs, stages, tasks, etc.)
 */
export const getBuildTimeline = Effect.fn("Build.getBuildTimeline")(function* (buildId: number) {
  const az = yield* AzService;

  const result = yield* az.runInvoke({
    area: "build",
    resource: "timeline",
    routeParameters: { buildId },
    queryParameters: { "api-version": "7.0" },
  });

  const parsed = yield* Schema.decodeUnknown(
    Schema.Struct({
      records: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          parentId: Schema.optional(Schema.NullOr(Schema.String)),
          type: Schema.String,
          name: Schema.String,
          state: Schema.String,
          result: Schema.optional(Schema.NullOr(Schema.String)),
          startTime: Schema.optional(Schema.NullOr(Schema.String)),
          finishTime: Schema.optional(Schema.NullOr(Schema.String)),
          errorCount: Schema.optional(Schema.NullOr(Schema.Number)),
          warningCount: Schema.optional(Schema.NullOr(Schema.Number)),
          log: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                id: Schema.Number,
                url: Schema.String,
              }),
            ),
          ),
        }),
      ),
      id: Schema.String,
      changeId: Schema.Number,
      lastChangedBy: Schema.String,
      lastChangedOn: Schema.String,
      url: Schema.String,
    }),
  )(result).pipe(
    Effect.mapError(
      (e) =>
        new AzParseError({
          message: `Failed to parse build timeline: ${String(e)}`,
          rawOutput: JSON.stringify(result).slice(0, 500),
        }),
    ),
  );

  return parsed as BuildTimeline;
});

/**
 * Get jobs and stages from build timeline
 */
export const getBuildJobs = Effect.fn("Build.getBuildJobs")(function* (buildId: number) {
  const timeline = yield* getBuildTimeline(buildId);

  const jobs = timeline.records.filter((r) => r.type === "Job");
  const stages = timeline.records.filter((r) => r.type === "Stage");

  return {
    jobs: jobs as BuildJob[],
    stages: stages as BuildJob[],
  };
});

/**
 * Get list of build logs
 */
export const getBuildLogs = Effect.fn("Build.getBuildLogs")(function* (buildId: number) {
  const az = yield* AzService;

  const result = yield* az.runInvoke({
    area: "build",
    resource: "logs",
    routeParameters: { buildId },
    queryParameters: { "api-version": "7.0" },
  });

  const parsed = yield* Schema.decodeUnknown(
    Schema.Struct({
      value: Schema.Array(
        Schema.Struct({
          id: Schema.Number,
          type: Schema.String,
          url: Schema.String,
          lineCount: Schema.Number,
        }),
      ),
      count: Schema.Number,
    }),
  )(result).pipe(
    Effect.mapError(
      (e) =>
        new AzParseError({
          message: `Failed to parse build logs: ${String(e)}`,
          rawOutput: JSON.stringify(result).slice(0, 500),
        }),
    ),
  );

  return parsed as BuildLogs;
});

/**
 * Get specific log content by log ID
 */
export const getBuildLogContent = Effect.fn("Build.getBuildLogContent")(function* (
  buildId: number,
  logId: number,
) {
  const az = yield* AzService;

  const result = yield* az.runInvoke({
    area: "build",
    resource: "logs",
    routeParameters: { buildId, logId },
    queryParameters: { "api-version": "7.0" },
  });

  const parsed = yield* Schema.decodeUnknown(
    Schema.Union(
      Schema.String,
      Schema.Struct({
        value: Schema.Array(Schema.String),
      }),
    ),
  )(result).pipe(
    Effect.mapError(
      (e) =>
        new AzParseError({
          message: `Failed to parse log content: ${String(e)}`,
          rawOutput: String(result).slice(0, 500),
        }),
    ),
  );

  if (typeof parsed === "string") {
    return parsed;
  }

  if (!Array.isArray(parsed.value)) {
    return "";
  }

  return parsed.value.join("\n");
});

/**
 * Get job summaries with duration and status information
 */
export const getBuildJobSummary = Effect.fn("Build.getBuildJobSummary")(function* (
  buildId: number,
) {
  const { jobs, stages } = yield* getBuildJobs(buildId);

  const summaries: JobSummary[] = [];

  for (const stage of stages) {
    const duration = calculateDuration(stage.startTime, stage.finishTime);
    summaries.push({
      name: stage.name,
      state: stage.state,
      result: stage.result ?? undefined,
      duration,
    });
  }

  for (const job of jobs) {
    const duration = calculateDuration(job.startTime, job.finishTime);
    const parentStage = stages.find((s) => s.id === job.parentId);

    summaries.push({
      name: job.name,
      state: job.state,
      result: job.result ?? undefined,
      stage: parentStage?.name,
      duration,
      logId: job.log?.id,
    });
  }

  return summaries;
});

/**
 * Find failed or canceled jobs in a build
 */
export const findFailedJobs = Effect.fn("Build.findFailedJobs")(function* (buildId: number) {
  const { jobs } = yield* getBuildJobs(buildId);

  const failed = jobs.filter((j) => j.result === "failed" || j.result === "canceled");

  return failed.map((job) => ({
    id: job.id,
    name: job.name,
    result: job.result,
    errorCount: job.errorCount ?? 0,
    warningCount: job.warningCount ?? 0,
    logId: job.log?.id,
  }));
});

/**
 * List pipeline runs with optional filters
 */
export const listPipelineRuns = Effect.fn("Build.listPipelineRuns")(function* (options?: {
  branch?: string;
  pipelineId?: number;
  top?: number;
}) {
  const az = yield* AzService;

  const parts = ["pipelines", "runs", "list", "--output", "json"];

  if (options?.branch) {
    parts.push("--branch", options.branch);
  }

  if (options?.pipelineId) {
    parts.push("--pipeline-id", String(options.pipelineId));
  }

  if (options?.top) {
    parts.push("--top", String(options.top));
  }

  const rawResult = yield* az.runCommand(parts.join(" "));

  const jsonData = yield* Effect.try({
    try: () => JSON.parse(rawResult) as unknown,
    catch: () =>
      new AzParseError({
        message: "Failed to parse JSON from pipeline runs output",
        rawOutput: rawResult.slice(0, 500),
      }),
  });

  const parsed = yield* Schema.decodeUnknown(
    Schema.Struct({
      value: Schema.Array(
        Schema.Struct({
          id: Schema.Number,
          buildNumber: Schema.String,
          status: Schema.String,
          result: Schema.optional(Schema.String),
          sourceBranch: Schema.String,
          startTime: Schema.optional(Schema.String),
          finishTime: Schema.optional(Schema.String),
        }),
      ),
    }),
  )(jsonData).pipe(
    Effect.mapError(
      (e) =>
        new AzParseError({
          message: `Failed to parse pipeline runs: ${String(e)}`,
          rawOutput: rawResult.slice(0, 500),
        }),
    ),
  );

  return parsed.value as PipelineRun[];
});

/**
 * Helper: Calculate duration between start and finish times
 */
function calculateDuration(
  startTime?: string | null,
  finishTime?: string | null,
): string | undefined {
  if (!startTime || !finishTime) {
    return undefined;
  }

  try {
    const ms = new Date(finishTime).getTime() - new Date(startTime).getTime();
    return `${Math.round(ms / 1000)}s`;
  } catch {
    return undefined;
  }
}
