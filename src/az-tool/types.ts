export type SecurityCheckResult = {
  allowed: boolean;
  command?: string;
  reason?: string;
};

export type InvokeParams = {
  area: string;
  resource: string;
  project?: string;
  routeParameters?: Record<string, string | number>;
  queryParameters?: Record<string, string | number>;
};

export type BuildJob = {
  id: string;
  parentId?: string | null;
  type: "Job" | "Stage" | "Task" | "Phase" | "Checkpoint";
  name: string;
  state: "pending" | "inProgress" | "completed";
  result?: "succeeded" | "failed" | "canceled" | "skipped" | null;
  startTime?: string | null;
  finishTime?: string | null;
  errorCount?: number | null;
  warningCount?: number | null;
  log?: { id: number; url: string } | null;
};

export type BuildTimeline = {
  records: BuildJob[];
  id: string;
  changeId: number;
  lastChangedBy: string;
  lastChangedOn: string;
  url: string;
};

export type BuildLog = {
  id: number;
  type: string;
  url: string;
  lineCount?: number;
};

export type BuildLogs = {
  count: number;
  value: BuildLog[];
};

export type JobSummary = {
  name: string;
  state: string;
  result?: string;
  stage?: string;
  duration?: string;
  logId?: number;
};

export type PipelineRun = {
  id: number;
  buildNumber: string;
  status: string;
  result?: string;
  sourceBranch: string;
  startTime?: string;
  finishTime?: string;
};
