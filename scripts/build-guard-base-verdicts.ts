import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createHash } from "node:crypto";
import { corpusConfig, parseCorpus, verdict } from "./guard-corpus-support";
import type { createCredentialGuard } from "#guard";

const revision = "d93e77a";
const corpusPath = Bun.argv[2] ?? "tests/fixtures/credential-guard-corpus-v2.jsonl";
const outputPath = Bun.argv[3] ?? "tests/fixtures/credential-guard-corpus-v2.base.json";
const temporary = await mkdtemp(join(tmpdir(), "guard-base-"));
try {
  const result = await Bun.build({
    entrypoints: ["src/credential-guard/index.ts"],
    target: "bun",
    plugins: [
      {
        name: "pinned-base",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.path.startsWith("node:")) return { path: args.path, external: true };
            const path = args.path.startsWith("#shared/")
              ? "src/shared/" + args.path.slice(8) + ".ts"
              : args.path.startsWith(".")
                ? posix.join(posix.dirname(args.importer), args.path) + ".ts"
                : args.path;
            return { path, namespace: "pinned-base" };
          });
          build.onLoad({ filter: /.*/, namespace: "pinned-base" }, async (args) => {
            const child = Bun.spawn(["git", "show", `${revision}:${args.path}`], {
              stdout: "pipe",
              stderr: "pipe",
            });
            const contents = await new Response(child.stdout).text();
            if ((await child.exited) !== 0) throw new Error(`Cannot read base module ${args.path}`);
            return { contents, loader: "ts" };
          });
        },
      },
    ],
  });
  if (!result.success || !result.outputs[0]) throw new Error(result.logs.join("\n"));
  const compiled = join(temporary, "base.mjs");
  await Bun.write(compiled, result.outputs[0]);
  const module: { createCredentialGuard: typeof createCredentialGuard } = await import(compiled);
  const guard = module.createCredentialGuard(corpusConfig);
  const rows = Object.fromEntries(
    parseCorpus(await Bun.file(corpusPath).text()).map((row) => [
      row.id,
      {
        commandHash: createHash("sha256")
          .update(row.tool + "\0" + row.command)
          .digest("hex"),
        refused: verdict(guard, row),
      },
    ]),
  );
  await Bun.write(outputPath, JSON.stringify({ revision, rows }, null, 2) + "\n");
  console.log(JSON.stringify({ revision, rows: Object.keys(rows).length, outputPath }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
