import { describe, expect, it } from "@effect/vitest";

import type { CheckResult } from "#gh/types";

import { classifyReviewTriage } from "#gh/pr/commands";
import { latestChecksOnly } from "#gh/pr/core";

const run = (id: number, job: number) =>
  `https://github.com/acme/repo/actions/runs/${id}/job/${job}`;

const check = (name: string, bucket: string, link: string, workflow = "CI"): CheckResult => ({
  name,
  state: bucket.toUpperCase(),
  bucket,
  link,
  workflow,
});

const cleanThreads = {
  visibleOpenReviewThreadsCount: 0,
  unrepliedReviewThreadsCount: 0,
  unresolvedReviewThreadsCount: 0,
};

describe("latestChecksOnly", () => {
  it("drops a failed run that a newer run of the same check superseded", () => {
    const checks = [
      check("Compare contracts", "fail", run(43054807496, 1)),
      check("Compare contracts", "pass", run(43055117716, 2)),
    ];
    expect(latestChecksOnly(checks)).toEqual([checks[1]]);
    expect(classifyReviewTriage(cleanThreads, latestChecksOnly(checks))).toEqual({
      status: "clear",
      reasons: [],
    });
  });

  it("drops cancelled runs that a newer success superseded", () => {
    const checks = [
      check("Check PR title", "cancel", run(100, 1), "PR title"),
      check("Check PR title", "cancel", run(101, 2), "PR title"),
      check("Check PR title", "pass", run(102, 3), "PR title"),
    ];
    expect(latestChecksOnly(checks)).toEqual([checks[2]]);
  });

  it("keeps a failure when the newest run of the check failed", () => {
    const checks = [check("Build", "pass", run(10, 1)), check("Build", "fail", run(11, 2))];
    expect(latestChecksOnly(checks)).toEqual([checks[1]]);
  });

  it("orders a rerun of the same run by job id", () => {
    const checks = [check("Build", "pass", run(10, 9)), check("Build", "fail", run(10, 5))];
    expect(latestChecksOnly(checks)).toEqual([checks[0]]);
  });

  it("keeps same-named checks of different workflows apart", () => {
    const checks = [
      check("Build", "fail", run(10, 1), "A"),
      check("Build", "pass", run(20, 2), "B"),
    ];
    expect(latestChecksOnly(checks)).toEqual(checks);
  });

  it("keeps a check whose run cannot be ordered", () => {
    const checks = [
      check("Deploy", "fail", "https://example.test/status"),
      check("Deploy", "pass", run(5, 1)),
    ];
    expect(latestChecksOnly(checks)).toEqual(checks);
  });
});
