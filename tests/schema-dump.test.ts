import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { prReplyAndResolveCommand, prRerunChecksCommand, prWatchCommand } from "#gh/pr/index";
import { dumpCommandSchema } from "#shared/schema-dump";

// Guards the parser against effect/unstable/cli internal-shape changes: if the Command/Param/
// primitive internals shift on an effect bump, these assertions fail loudly instead of the dump
// silently degrading to empty flags/subcommands.
const greet = Command.make(
  "greet",
  {
    name: Flag.string("name").pipe(Flag.withDescription("who to greet")),
    mode: Flag.choice("mode", ["loud", "soft"]).pipe(Flag.optional),
  },
  () => Effect.void,
).pipe(Command.withDescription("Greet someone"));

const root = Command.make("root", {}).pipe(Command.withSubcommands([greet]));

describe("dumpCommandSchema", () => {
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

  it("both binaries keep real JSONL watcher stdout pure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gh-tool-jsonl-"));
    const gh = join(directory, "gh");
    await writeFile(
      gh,
      `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"owner":{"login":"o"},"name":"r","defaultBranchRef":{"name":"main"},"url":"https://github.com/o/r"}' ;;
  "pr view") echo '{"number":1,"state":"OPEN","headRefOid":"sha"}' ;;
  "pr checks") echo '[{"name":"CI","state":"completed","bucket":"pass","link":"external"}]' ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(gh, 0o755);
    try {
      const result = spawnSync(
        "bun",
        [
          `./src/gh-tool/index.ts`,
          "pr",
          "watch",
          "--prs",
          "1",
          "--interval",
          "1",
          "--timeout",
          "1",
          "--format",
          "jsonl",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          timeout: 15000,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const lines = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.at(-1)).toMatchObject({ type: "watcher_terminal", status: "terminal" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);

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
