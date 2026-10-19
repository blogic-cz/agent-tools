import { Schema } from "effect";

const Step = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  number: Schema.Number,
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export const WorkflowJob = Schema.Struct({
  databaseId: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
  steps: Schema.Array(Step),
});
export const WorkflowRun = Schema.Struct({
  databaseId: Schema.Number,
  displayTitle: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  headBranch: Schema.String,
  headSha: Schema.String,
  createdAt: Schema.String,
  event: Schema.String,
  url: Schema.String,
  workflowName: Schema.String,
});
export const WorkflowRunDetail = Schema.Struct({
  ...WorkflowRun.fields,
  jobs: Schema.Array(WorkflowJob),
  attempt: Schema.Number,
});
export type WorkflowJob = typeof WorkflowJob.Type;
export type WorkflowRun = typeof WorkflowRun.Type;
export type WorkflowRunDetail = typeof WorkflowRunDetail.Type;
export const RUN_LIST_FIELDS =
  "databaseId,displayTitle,status,conclusion,headBranch,headSha,createdAt,event,url,workflowName";
export const RUN_VIEW_FIELDS = `${RUN_LIST_FIELDS},jobs,attempt`;

export const parsePreserving =
  <A>(schema: Schema.Codec<A>) =>
  (value: unknown): A => {
    if (Schema.is(schema)(value)) return value;
    return Schema.decodeUnknownSync(schema)(value);
  };
