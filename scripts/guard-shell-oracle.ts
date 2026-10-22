const child = Bun.spawn(["bun", "src/credential-guard/shell-oracle.ts"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
