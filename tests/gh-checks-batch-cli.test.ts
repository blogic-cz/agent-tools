import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { captureOutput } from "./helpers/capture-output";
import { ghCommand } from "./helpers/gh-command";
import { restPullFixture } from "./fixtures/gh-rest-pull";
const MERGED_HEAD = "3e49e95c3dae6bba9236d2c43d2cb30c40478d30";
const OPEN_HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
afterEach(() => vi.unstubAllEnvs());
it("pr checks --prs marks a PR whose checks gh did not report instead of returning an empty list", async () => {
  vi.stubEnv("GH_TOKEN", "offline-replay");
  const result = await captureOutput(async () => {
    await Effect.runPromise(
      ghCommand(
        ["pr", "checks", "--prs", "1396,949", "--format", "json", "--repo", "test-owner/test-repo"],
        (args) => {
          const path = args[3] ?? "";
          if (args[0] === "api") {
            const data = path.includes("/pulls/")
              ? restPullFixture(Number(path.split("/").at(-1)), {
                  owner: "test-owner",
                  name: "test-repo",
                  head: path.endsWith("1396") ? MERGED_HEAD : OPEN_HEAD,
                  state: path.endsWith("1396") ? "MERGED" : "OPEN",
                })
              : path.includes("/check-runs")
                ? [
                    {
                      check_runs: path.includes(MERGED_HEAD)
                        ? []
                        : [
                            {
                              name: "Build and Test",
                              status: "completed",
                              conclusion: "success",
                              html_url: "external",
                            },
                          ],
                    },
                  ]
                : [{ statuses: [] }];
            return { stdout: JSON.stringify(data), stderr: "", exitCode: 0 };
          }
          if (args[0] === "pr" && args[1] === "view")
            return {
              stdout: JSON.stringify(
                args[2] === "1396"
                  ? { state: "MERGED", headRefOid: MERGED_HEAD }
                  : { state: "OPEN", headRefOid: OPEN_HEAD },
              ),
              stderr: "",
              exitCode: 0,
            };
          if (args[0] === "pr" && args[1] === "checks")
            return args[2] === "1396"
              ? {
                  stdout: "",
                  stderr: "no checks reported on the 'feat/merged' branch",
                  exitCode: 1,
                }
              : {
                  stdout: JSON.stringify([
                    { name: "Build and Test", state: "SUCCESS", bucket: "pass", link: "external" },
                  ]),
                  stderr: "",
                  exitCode: 0,
                };
          throw new Error("Unexpected command: " + args.join(" "));
        },
      ),
    );
  });
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    count: 2,
    prs: [
      {
        pr: 1396,
        state: "MERGED",
        headSha: MERGED_HEAD,
        checksStatus: "none_reported",
        reason:
          "gh reported no checks for this head. Checks may not be registered yet, the PR may have no CI, or GitHub returned an empty rollup. This is not a CI verdict.",
        checks: null,
      },
      {
        pr: 949,
        state: "OPEN",
        headSha: OPEN_HEAD,
        checksStatus: "reported",
        checks: [{ name: "Build and Test", state: "SUCCESS", bucket: "pass", link: "external" }],
      },
    ],
  });
});
