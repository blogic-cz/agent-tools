import { expect, it } from "vitest";
import { createCredentialGuard } from "./index";

it("checks code flags throughout short-option clusters in unknown operands", () => {
  const guard = createCredentialGuard();
  for (const prefix of ["unknown-cli", "pnpm exec", "cargo unknown-sub"]) {
    for (const invocation of [
      "bash -lc 'env | head'",
      "bash -ec 'env | head'",
      "sh -xc 'env | head'",
      "python3 -Ic 'import os;print(os.environ)'",
      "python3 -uc 'import os;print(os.environ)'",
      "python -Ec 'import os;print(os.environ)'",
      "python3 -Iuc'import os;print(os.environ)'",
      "perl -we 'print %ENV'",
      "ruby -we 'p ENV'",
      "node -pe 'process.env'",
    ]) {
      const command = `${prefix} ${invocation}`;
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).toThrow();
    }
    for (const invocation of [
      "python3 -Wc script.py",
      "ruby -Icode script.rb",
      "perl -Iexample script.pl",
    ]) {
      const command = `${prefix} ${invocation}`;
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).not.toThrow();
    }
  }
});

it("analyzes awk program operands under unknown commands", () => {
  const guard = createCredentialGuard();
  for (const prefix of ["unknown-cli", "pnpm exec", "git unknown-sub"]) {
    for (const flags of ["", "-F:", "-F :", "-v key=1", "-vkey=1", "--", "-e", "--source="]) {
      const command = `${prefix} awk ${flags}${flags.endsWith("=") ? "" : " "}'BEGIN{print ENVIRON["FAKE_TOKEN"]}'`;
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).toThrow();
    }
    const command = `${prefix} awk -F: -v key=1 '{print $1}' input.txt`;
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  }
});
