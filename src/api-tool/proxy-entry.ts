#!/usr/bin/env bun
import { startProxy } from "./server";
import { readPrivateFile } from "./store";
import { safeError } from "./errors";

if (Bun.argv.length !== 4 || Bun.argv[2] !== "--config") {
  process.stderr.write("Usage: api-proxy --config /operator/private/operator.json\n");
  process.exitCode = 1;
} else {
  try {
    await startProxy(JSON.parse(await readPrivateFile(Bun.argv[3])));
    process.stderr.write(
      "Credential proxy listening. Verify operator identity separation before production use.\n",
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
    process.exitCode = 1;
  }
}
