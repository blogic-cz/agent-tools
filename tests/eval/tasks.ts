import type { EvalTask } from "./types";

export const evalTasks: EvalTask[] = [
  {
    id: "gh-pr-checks-failed",
    tool: "gh-tool",
    description:
      "Inspect PR #184 CI failures and return only failed checks with actionable rerun guidance.",
    input: {
      command: "pr checks-failed",
      pr: 184,
      format: "toon",
    },
    expectedPattern: "failed|failing|rerun",
  },
  {
    id: "gh-pr-threads-unresolved",
    tool: "gh-tool",
    description:
      "List unresolved review threads on PR #233 and identify top 3 blockers before merge.",
    input: {
      command: "pr threads",
      pr: 233,
      unresolvedOnly: true,
      format: "toon",
    },
    expectedPattern: "unresolved|thread|blocker",
  },
  {
    id: "gh-pr-merge-readiness",
    tool: "gh-tool",
    description:
      "Summarize merge readiness for PR #219 using checks, review status, and unresolved discussions.",
    input: {
      command: "pr discussion-summary",
      pr: 219,
      includeChecks: true,
      includeThreads: true,
    },
    expectedPattern: "ready|not ready|checks|reviews",
  },
  {
    id: "gh-workflow-job-logs",
    tool: "gh-tool",
    description:
      "Fetch parsed logs for job 'test-api' in workflow run 984213 and extract first error signature.",
    input: {
      command: "workflow job-logs",
      run: 984213,
      job: "test-api",
      format: "json",
    },
    expectedPattern: "error|failed|exception",
  },
  {
    id: "gh-workflow-runs-latest",
    tool: "gh-tool",
    description:
      "List the 5 most recent workflow runs and highlight any currently in-progress deployments.",
    input: {
      command: "workflow list",
      limit: 5,
      format: "toon",
    },
    expectedPattern: "in_progress|queued|running|completed",
  },
  {
    id: "gh-issue-backlog-triage",
    tool: "gh-tool",
    description:
      "Triage open bug issues labeled 'customer-impact' and propose close/comment/escalate actions.",
    input: {
      command: "issue list",
      state: "open",
      labels: ["bug", "customer-impact"],
      limit: 20,
    },
    expectedPattern: "close|comment|escalate|priority",
  },
  {
    id: "gh-repo-code-search",
    tool: "gh-tool",
    description:
      "Search repository code for direct 'kubectl' shell usage and flag places that should use k8s-tool.",
    input: {
      command: "repo search-code",
      query: "kubectl config get-contexts",
      path: "src",
      limit: 50,
    },
    expectedPattern: "kubectl|k8s-tool|migration",
  },
  {
    id: "db-orders-latency-sample",
    tool: "db-tool",
    description:
      "Sample the 20 slowest order queries in the last hour and return query, duration, and endpoint context.",
    input: {
      command: "sql",
      env: "test",
      sql: "SELECT endpoint, query_hash, avg_ms FROM query_stats ORDER BY avg_ms DESC LIMIT 20",
      format: "json",
    },
    expectedPattern: "endpoint|avg_ms|query",
  },
  {
    id: "db-schema-payments-columns",
    tool: "db-tool",
    description:
      "Inspect payments table schema to verify nullable fields before adding stricter API validation.",
    input: {
      command: "schema",
      env: "local",
      mode: "columns",
      table: "payments",
      format: "toon",
    },
    expectedPattern: "column|nullable|type",
  },
  {
    id: "db-relationship-audit",
    tool: "db-tool",
    description:
      "List foreign key relationships for invoice-related tables to map cascade delete blast radius.",
    input: {
      command: "schema",
      env: "test",
      mode: "relationships",
      tableLike: "%invoice%",
    },
    expectedPattern: "foreign|reference|cascade",
  },
  {
    id: "db-recent-failed-jobs",
    tool: "db-tool",
    description:
      "Query last 50 failed background jobs and group by worker queue for incident triage.",
    input: {
      command: "sql",
      env: "test",
      sql: "SELECT queue, count(*) AS failures FROM jobs WHERE status = 'failed' GROUP BY queue ORDER BY failures DESC LIMIT 50",
      format: "toon",
    },
    expectedPattern: "queue|failed|count",
  },
  {
    id: "k8s-pods-crashloop",
    tool: "k8s-tool",
    description:
      "List pods in namespace web-test and identify CrashLoopBackOff candidates needing restart analysis.",
    input: {
      command: "pods",
      env: "test",
      namespace: "web-test",
      wide: true,
      format: "toon",
    },
    expectedPattern: "CrashLoopBackOff|Error|restart",
  },
  {
    id: "k8s-describe-api-pod",
    tool: "k8s-tool",
    description:
      "Describe pod api-6d8f9b7c47-abcde and extract recent warning events and image pull status.",
    input: {
      command: "describe",
      env: "test",
      namespace: "api-test",
      resource: "pod",
      name: "api-6d8f9b7c47-abcde",
    },
    expectedPattern: "Events|Warning|Pull",
  },
  {
    id: "k8s-tail-worker-logs",
    tool: "k8s-tool",
    description:
      "Read last 200 lines from worker pod to confirm retry backoff behavior after queue outage.",
    input: {
      command: "logs",
      env: "test",
      namespace: "jobs-test",
      pod: "worker-85fc9c97c4-kz2mv",
      tail: 200,
    },
    expectedPattern: "retry|backoff|queue",
  },
  {
    id: "k8s-top-memory-hotspots",
    tool: "k8s-tool",
    description: "Get top memory consumers in namespace web-test to prioritize OOM remediation.",
    input: {
      command: "top",
      env: "test",
      namespace: "web-test",
      sortBy: "memory",
      format: "json",
    },
    expectedPattern: "memory|Mi|pod",
  },
  {
    id: "k8s-exec-config-check",
    tool: "k8s-tool",
    description:
      "Run config checksum command inside api pod and compare with expected release checksum.",
    input: {
      command: "exec",
      env: "test",
      namespace: "api-test",
      pod: "api-6d8f9b7c47-abcde",
      execCmd: "sha256sum /app/config/runtime.json",
    },
    expectedPattern: "sha256|checksum|runtime.json",
  },
  {
    id: "az-build-failed-jobs",
    tool: "az-tool",
    description:
      "Find failed jobs for build 44192 and report which stage blocked release promotion.",
    input: {
      command: "build failed-jobs",
      buildId: 44192,
      format: "toon",
    },
    expectedPattern: "failed|canceled|stage",
  },
  {
    id: "az-build-summary-duration",
    tool: "az-tool",
    description: "Summarize build 44192 job durations and call out the top 2 longest jobs.",
    input: {
      command: "build summary",
      buildId: 44192,
      format: "json",
    },
    expectedPattern: "duration|longest|job",
  },
  {
    id: "az-build-log-content",
    tool: "az-tool",
    description:
      "Read build log content for build 44192 log 12 and extract the first test failure.",
    input: {
      command: "build log-content",
      buildId: 44192,
      logId: 12,
      format: "toon",
    },
    expectedPattern: "test|failure|assert",
  },
  {
    id: "az-pipeline-list-cmd",
    tool: "az-tool",
    description: "Run raw az pipelines list command and identify pipelines matching 'deploy-api'.",
    input: {
      command: "cmd",
      cmd: "pipelines list",
      project: "platform",
      format: "json",
    },
    expectedPattern: "pipeline|deploy-api|id",
  },
  {
    id: "logs-local-auth-errors",
    tool: "logs-tool",
    description:
      "Read local app.log and filter auth failures from the last 150 lines during login incident.",
    input: {
      command: "read",
      env: "local",
      file: "app.log",
      tail: 150,
      grep: "auth failed",
      pretty: true,
    },
    expectedPattern: "auth failed|401|user",
  },
  {
    id: "logs-test-queue-timeouts",
    tool: "logs-tool",
    description: "Scan test environment logs for queue timeout bursts after deployment 2026.02.17.",
    input: {
      command: "read",
      env: "test",
      file: "worker.log",
      tail: 300,
      grep: "timeout",
      pretty: false,
    },
    expectedPattern: "timeout|queue|retry",
  },
  {
    id: "session-release-regression-search",
    tool: "session-tool",
    description:
      "Search recent OpenCode sessions for messages mentioning 'release regression' and return relevant session IDs.",
    input: {
      command: "search",
      query: "release regression",
      limit: 10,
      all: false,
      format: "toon",
    },
    expectedPattern: "session|release regression|message",
  },
];
