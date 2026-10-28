import { withReadCache } from "#gh/read/cache";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { captureOutput } from "./helpers/capture-output";
import { ghCommand } from "./helpers/gh-command";
import { createReplayGh } from "./fixtures/gh-read-replay";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { prReplyAndResolveCommand, prRerunChecksCommand, prWatchCommand } from "#gh/pr/index";
import { dumpCommandSchema } from "#shared/schema-dump";

// Guards the parser against effect/cli internal-shape changes: if the Command/Param/
// primitive internals shift on an effect bump, these assertions fail loudly instead of the dump
// silently degrading to empty flags/subcommands.
const greet = Command.make(
  "greet",
  {
    name: Flag.String("name").pipe(Flag.withDescription("who to greet")),
    mode: Flag.Literals("mode", ["loud", "soft"]).pipe(Flag.optional),
  },
  () => Effect.void,
).pipe(Command.withDescription("Greet someone"));

const root = Command.make("root", {}).pipe(Command.withSubcommands([greet]));

describe("dumpCommandSchema", () => {
  it("runs workflow watch without the optional --frames flag", async () => {
    vi.stubEnv("GH_TOKEN", "offline-replay");
    const result = await captureOutput(async () => {
      await Effect.runPromise(
        ghCommand(
          ["workflow", "watch", "--run", "102", "--repo", "owner/repo", "--format", "json"],
          createReplayGh(),
        ),
      );
    });
    expect(result.stdout).toContain('"runId": 102');
    expect(result.stderr).toBe("");
  });

  it("gh-tool aliases expose watch/rerun/reply command schemas", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bin: Record<string, string>;
    };
    expect(packageJson.bin["gh-tool"]).toBe("./src/gh-tool/index.ts");
    expect(packageJson.bin["agent-tools-gh"]).toBe("./src/gh-tool/index.ts");

    const watch = dumpCommandSchema(prWatchCommand);
    expect(watch.name).toBe("watch");
    expect(watch.flags.map((flag) => flag.name)).toEqual(
      expect.arrayContaining(["prs", "format", "timeout"]),
    );

    const rerun = dumpCommandSchema(prRerunChecksCommand);
    expect(rerun.name).toBe("rerun-checks");
    expect(rerun.flags.map((flag) => flag.name)).toEqual(
      expect.arrayContaining(["watch", "timeout"]),
    );

    const reply = dumpCommandSchema(prReplyAndResolveCommand);
    expect(reply.name).toBe("reply-and-resolve");
    expect(reply.flags.find((flag) => flag.name === "thread-id")?.description).toContain(
      "inferred",
    );
  });

  it("keeps cache-enabled JSONL watcher output pure", async () => {
    const cache = await mkdtemp(join(tmpdir(), "watcher-cache-"));
    vi.stubEnv("GH_TOOL_CACHE_DIR", cache);
    vi.stubEnv("GH_TOOL_CACHE", "on");
    try {
      vi.stubEnv("GH_TOKEN", "offline-replay");
      const fetch = vi.fn<() => Promise<Response>>(
        async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      );
      vi.stubGlobal("fetch", fetch);
      const replay = createReplayGh();
      const result = await captureOutput(async () => {
        await Effect.runPromise(
          withReadCache(
            ghCommand(
              [
                "pr",
                "watch",
                "--prs",
                "42",
                "--interval",
                "1",
                "--timeout",
                "1",
                "--format",
                "jsonl",
              ],
              (args) => {
                const reply = replay(args);
                if (args[0] === "pr" && args[1] === "checks")
                  return {
                    ...reply,
                    stdout: JSON.stringify([
                      { name: "CI", state: "completed", bucket: "pass", link: "external" },
                    ]),
                  };
                return reply;
              },
            ),
          ),
        );
      });
      expect(fetch).toHaveBeenCalled();
      expect(result.stderr).toBe("");
      const lines = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.at(-1)).toMatchObject({ type: "watcher_terminal", status: "terminal" });
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("walks the command tree and extracts flag name/type/choices/description", () => {
    const schema = dumpCommandSchema(root);
    expect(schema.name).toBe("root");

    const child = schema.subcommands.find((c) => c.name === "greet");
    expect(child?.description).toBe("Greet someone");
    expect(child?.flags.map((f) => f.name).sort()).toEqual(["mode", "name"]);

    const name = child?.flags.find((f) => f.name === "name");
    expect(name?.type).toBe("String");
    expect(name?.description).toBe("who to greet");

    const mode = child?.flags.find((f) => f.name === "mode");
    expect(mode?.type).toBe("Choice");
    expect(mode?.choices).toEqual(["loud", "soft"]);
  });
});
