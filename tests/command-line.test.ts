import { describe, expect, it } from "@effect/vitest";

import { renderCommandLine, tokenizeCommandLine } from "#shared/exec";

describe("tokenizeCommandLine", () => {
  it("splits on whitespace", () => {
    expect(tokenizeCommandLine("pipelines list --top 5")).toEqual([
      "pipelines",
      "list",
      "--top",
      "5",
    ]);
  });

  it("keeps a double-quoted value as one argument and drops the quotes", () => {
    expect(tokenizeCommandLine('repos show --query "a b c"')).toEqual([
      "repos",
      "show",
      "--query",
      "a b c",
    ]);
  });

  it("keeps a single-quoted value as one argument", () => {
    expect(tokenizeCommandLine("build list --query '[0].id'")).toEqual([
      "build",
      "list",
      "--query",
      "[0].id",
    ]);
  });

  it("treats shell metacharacters as literal text", () => {
    expect(tokenizeCommandLine("pipelines list; whoami")).toEqual(["pipelines", "list;", "whoami"]);
    expect(tokenizeCommandLine("pipelines list | tee /tmp/out")).toEqual([
      "pipelines",
      "list",
      "|",
      "tee",
      "/tmp/out",
    ]);
    expect(tokenizeCommandLine("repos show --id $(whoami)")).toEqual([
      "repos",
      "show",
      "--id",
      "$(whoami)",
    ]);
  });

  it("preserves an empty quoted argument", () => {
    expect(tokenizeCommandLine('repos show --id ""')).toEqual(["repos", "show", "--id", ""]);
  });

  it("collapses repeated and surrounding whitespace", () => {
    expect(tokenizeCommandLine("  pipelines   list  ")).toEqual(["pipelines", "list"]);
  });

  it("returns nothing for an empty command line", () => {
    expect(tokenizeCommandLine("")).toEqual([]);
    expect(tokenizeCommandLine("   ")).toEqual([]);
  });
});

describe("renderCommandLine", () => {
  it("leaves plain arguments unquoted", () => {
    expect(renderCommandLine(["az", "pipelines", "list", "--top=5"])).toBe(
      "az pipelines list --top=5",
    );
  });

  it("quotes arguments that need it", () => {
    expect(renderCommandLine(["az", "repos", "show", "--query", "a b c"])).toBe(
      "az repos show --query 'a b c'",
    );
  });

  it("round-trips a quoted argument back to one token", () => {
    const argv = ["repos", "show", "--query", "a b c"];
    expect(tokenizeCommandLine(renderCommandLine(argv))).toEqual(argv);
  });
});
