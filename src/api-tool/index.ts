#!/usr/bin/env bun
import { checkEffectVersion } from "#shared/effect-version";
if (await checkEffectVersion()) (await import("./main")).runMain();
else process.exitCode = 1;
