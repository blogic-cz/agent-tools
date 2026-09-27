import { describe, expect, it } from "vitest";
import { decode as decodeToon } from "@toon-format/toon";
import { Console, Effect, Terminal } from "effect";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { formatAny } from "#shared/format";
import { withRedactedOutput } from "#shared/output-boundary";
import {
  redactSensitiveText,
  redactSensitiveValue,
  unsafeOutboundTextReason,
} from "#shared/content-security";

const githubToken = `ghp_${"A".repeat(36)}`;
const awsKey = `AKIA${"B".repeat(16)}`;

describe("shared content security", () => {
  it("blocks and redacts every recognized credential occurrence", () => {
    const text = `first ${githubToken}; second ${githubToken}; AWS ${awsKey}`;

    expect(unsafeOutboundTextReason(text, {})).toBe("a credential pattern");
    const redacted = redactSensitiveText(text, {});
    expect(redacted).not.toContain(githubToken);
    expect(redacted).not.toContain(awsKey);
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("redacts known environment secrets but preserves runtime metadata", () => {
    const environment = {
      API_SESSION_TOKEN: "synthetic-session-secret-value",
      CODEX_SESSION_ID: "synthetic-session-id-value",
    };

    expect(unsafeOutboundTextReason("sent synthetic-session-secret-value", environment)).toBe(
      "a credential from the process environment",
    );
    expect(
      redactSensitiveText("synthetic-session-secret-value synthetic-session-id-value", environment),
    ).toBe("[REDACTED] synthetic-session-id-value");
  });

  it("preserves safe output, AWK snippets, and apostrophes", () => {
    const safe = "O'Reilly's status: ready; docker ps | awk '{print $1}'";
    expect(unsafeOutboundTextReason(safe, {})).toBeNull();
    expect(redactSensitiveText(safe, {})).toBe(safe);
  });

  it("redacts complete PEM blocks, including truncated output", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nsynthetic-private-key-material\n-----END PRIVATE KEY-----";
    expect(redactSensitiveText(`before ${pem} after`, {})).toBe("before [REDACTED] after");
    expect(redactSensitiveText("-----BEGIN PRIVATE KEY-----\nsynthetic-truncated-key", {})).toBe(
      "[REDACTED]",
    );
  });

  it("preserves nested structured output and redacts contextual values", () => {
    const value = {
      data: {
        api_key: "synthetic-api-key-value-12345678901234567890",
        safe: "ordinary text",
        count: 2,
      },
      session: "CODEX_SESSION_ID is not secret metadata",
    };

    const json = formatAny(value, "json");
    const parsed = JSON.parse(json) as typeof value;
    expect(parsed.data.api_key).toBe("[REDACTED]");
    expect(parsed.data.safe).toBe("ordinary text");
    expect(parsed.data.count).toBe(2);
    expect(parsed.session).toBe("CODEX_SESSION_ID is not secret metadata");
    const decoded = decodeToon(formatAny(value, "toon")) as typeof value;
    expect(decoded.data.api_key).toBe("[REDACTED]");
    expect(decoded.data.safe).toBe("ordinary text");
    expect(decoded.data.count).toBe(2);
    expect(redactSensitiveValue({ name: "ordinary", count: 4 }, {})).toEqual({
      name: "ordinary",
      count: 4,
    });
  });

  it("keeps logText JSON parseable after output sanitization", () => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `import { Effect } from "effect"; import { formatAny, logText } from "./src/shared/format.ts"; const result = { api_key: "synthetic-api-key-value-12345678901234567890", nested: { safe: "ok" } }; await Effect.runPromise(logText(formatAny(result, "json")));`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const output = result.stdout.trim();
    const parsed = JSON.parse(output) as { api_key: string; nested: { safe: string } };
    expect(parsed.api_key).toBe("[REDACTED]");
    expect(parsed.nested.safe).toBe("ok");
  });

  it("keeps nested TOON fields intact through logText redaction", () => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `import { Effect } from "effect"; import { formatAny, logText } from "./src/shared/format.ts"; const value = { api_key: { averylongsafefieldname: "hello" }, status: "ready", token: "${githubToken}" }; await Effect.runPromise(logText(formatAny(value, "toon")));`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const decoded = decodeToon(result.stdout.trim()) as {
      api_key: { averylongsafefieldname: string };
      status: string;
      token: string;
    };
    expect(decoded).toEqual({
      api_key: { averylongsafefieldname: "hello" },
      status: "ready",
      token: "[REDACTED]",
    });
  });

  it("redacts credentials from rendered errors", () => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `import { Cause, Effect } from "effect"; import { renderCauseToStderr } from "./src/shared/error-renderer.ts"; await Effect.runPromise(renderCauseToStderr(Cause.fail(new Error("Rejected ${githubToken}"))));`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(githubToken);
  });

  it("renders invalid CLI arguments through the shared redacted diagnostic", () => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `import { BunServices } from "@effect/platform-bun"; import { Effect } from "effect"; import { Command, Flag } from "effect/unstable/cli"; import { renderCauseToStderr } from "./src/shared/error-renderer.ts"; const command = Command.make("test-tool", { count: Flag.Int("count") }, () => Effect.void); const program = Command.runWith(command, { version: "1", renderErrors: false })(["--count", "${githubToken}"]).pipe(Effect.provide(BunServices.layer), Effect.tapCause(renderCauseToStderr)); await Effect.runPromiseExit(program);`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).toMatch(/Invalid|invalid|expected/i);
    expect(result.stderr).not.toContain(githubToken);
    expect(result.stdout).toContain("test-tool");
  });

  it("redacts framework console and terminal output", async () => {
    const consoleOutput: Array<ReadonlyArray<unknown>> = [];
    const terminalOutput: string[] = [];
    const testConsole = Object.assign(Object.create(console), {
      log: (...args: ReadonlyArray<unknown>) => consoleOutput.push(args),
    });
    const testTerminal = Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: (text) => Effect.sync(() => void terminalOutput.push(text)),
    });
    const program = withRedactedOutput(
      Effect.gen(function* () {
        yield* Console.log(`Current command: gh ${githubToken}`);
        const terminal = yield* Terminal.Terminal;
        yield* terminal.display(`Run this command? ${githubToken}`);
      }),
    ).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provideService(Terminal.Terminal, testTerminal),
    );

    await Effect.runPromise(program);
    const output = `${consoleOutput.flat().join(" ")}\n${terminalOutput.join("\n")}`;
    expect(output).not.toContain(githubToken);
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("checks canonical targets before reading outbound text files", () => {
    const directory = mkdtempSync(join(tmpdir(), "content-security-files-"));
    const sensitiveFile = join(directory, ".env.synthetic");
    const sensitiveLink = join(directory, "ordinary.txt");
    const safeFile = join(directory, "safe.txt");
    const safeLink = join(directory, "safe-link.txt");
    writeFileSync(sensitiveFile, "synthetic fixture only");
    symlinkSync(sensitiveFile, sensitiveLink);
    writeFileSync(safeFile, "ordinary body");
    symlinkSync(safeFile, safeLink);

    try {
      const result = spawnSync(
        "bun",
        [
          "-e",
          `import { Effect } from "effect"; import { readValidatedOutboundFile, resolveRequiredTextInput } from "./src/gh-tool/text-input.ts"; let blocked = false; try { await Effect.runPromise(readValidatedOutboundFile(process.env.SENSITIVE_LINK, "gh-test")); } catch { blocked = true; } let inputBlocked = false; try { await Effect.runPromise(resolveRequiredTextInput({ command: "gh-test", value: null, fileValue: process.env.SENSITIVE_LINK, valueFlag: "--body", fileFlag: "--body-file", label: "body" })); } catch { inputBlocked = true; } const safe = await Effect.runPromise(readValidatedOutboundFile(process.env.SAFE_LINK, "gh-test")); console.log(JSON.stringify({ blocked, inputBlocked, safeText: safe.text, exactBytes: new TextDecoder().decode(safe.bytes) }));`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            SENSITIVE_LINK: sensitiveLink,
            SAFE_LINK: safeLink,
          },
        },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        blocked: true,
        inputBlocked: true,
        safeText: "ordinary body",
        exactBytes: "ordinary body",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
