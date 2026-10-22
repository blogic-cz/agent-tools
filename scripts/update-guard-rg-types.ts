const child = Bun.spawn(["rg", "--type-list"], { stdout: "pipe", stderr: "inherit" });
const output = await new Response(child.stdout).text();
if ((await child.exited) !== 0) throw new Error("rg --type-list failed");
const entries = output
  .trim()
  .split("\n")
  .map((line) => {
    const separator = line.indexOf(": ");
    if (separator < 1) throw new Error("invalid rg type row");
    return [line.slice(0, separator), line.slice(separator + 2).split(", ")];
  });
await Bun.write(
  new URL("../src/credential-guard/rg-types.json", import.meta.url),
  JSON.stringify(Object.fromEntries(entries), null, 2) + "\n",
);
