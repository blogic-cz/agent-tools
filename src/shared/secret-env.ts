import { spawn, type SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { relative, resolve as resolvePath } from "node:path";
import { Context, Layer } from "effect";

import { registerResolvedSecret } from "./content-security";

const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const CONFIG_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const STARTUP_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "ZDOTDIR",
] as const;

export type LookupResult =
  | { readonly _tag: "found"; readonly value: string }
  | { readonly _tag: "absent" }
  | { readonly _tag: "failed"; readonly reason: string };

export type ZshRunner = (name: string, timeoutMs: number) => Promise<LookupResult>;

const failed = (name: string): LookupResult => ({ _tag: "failed", reason: name });

type FrameInspection =
  | { readonly _tag: "incomplete" }
  | { readonly _tag: "malformed" }
  | { readonly _tag: "complete"; readonly result: LookupResult };

const inspectFrame = (frame: Buffer): FrameInspection => {
  const firstNewline = frame.indexOf(10);
  if (firstNewline < 0) {
    const prefix = frame.toString("ascii");
    return "set".startsWith(prefix) || "unset".startsWith(prefix)
      ? { _tag: "incomplete" }
      : { _tag: "malformed" };
  }

  const state = frame.subarray(0, firstNewline).toString("ascii");
  if (state === "unset") {
    return firstNewline === frame.length - 1
      ? { _tag: "complete", result: { _tag: "absent" } }
      : { _tag: "malformed" };
  }
  if (state !== "set") return { _tag: "malformed" };

  const lengthEnd = frame.indexOf(10, firstNewline + 1);
  if (lengthEnd < 0) {
    const lengthPrefix = frame.subarray(firstNewline + 1).toString("ascii");
    if (/^(0|[1-9][0-9]*)$/.test(lengthPrefix) || lengthPrefix === "") {
      return { _tag: "incomplete" };
    }
    return { _tag: "malformed" };
  }
  const lengthText = frame.subarray(firstNewline + 1, lengthEnd).toString("ascii");
  if (!/^(0|[1-9][0-9]*)$/.test(lengthText)) return { _tag: "malformed" };

  const length = Number(lengthText);
  const start = lengthEnd + 1;
  if (!Number.isSafeInteger(length)) return { _tag: "malformed" };
  if (start + length < frame.length) return { _tag: "malformed" };
  if (start + length > frame.length) return { _tag: "incomplete" };
  return {
    _tag: "complete",
    result: { _tag: "found", value: frame.subarray(start).toString("utf8") },
  };
};

type ZshProcess = Pick<ReturnType<typeof spawn>, "pid" | "stdio" | "kill"> & {
  on: {
    (event: "error", listener: () => void): unknown;
    (event: "exit", listener: (code: number | null) => void): unknown;
  };
};
export type ZshLauncher = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ZshProcess;
export const makeZshRunner =
  (
    launch: ZshLauncher = spawn,
    terminate: (pid: number) => void = (pid) => {
      process.kill(pid, "SIGKILL");
    },
  ): ZshRunner =>
  (name, timeoutMs) =>
    new Promise((resolve) => {
      if (process.env.VITEST !== undefined) {
        const home = process.env.HOME;
        const zdotdir = process.env.ZDOTDIR;
        const relativeZdotdir = zdotdir ? relative(tmpdir(), resolvePath(zdotdir)) : "..";
        if (
          !home ||
          !zdotdir ||
          resolvePath(home) !== resolvePath(zdotdir) ||
          relativeZdotdir === ".." ||
          relativeZdotdir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        ) {
          resolve(failed(name));
          return;
        }
      }

      const childEnv = Object.fromEntries(
        STARTUP_ENV_NAMES.flatMap((key) => {
          const value = process.env[key];
          return value === undefined ? [] : [[key, value]];
        }),
      );
      const script = `export LC_ALL=C; if (( \${+parameters[$1]} )); then value=\${(P)1}; print -ru3 -- "set"; print -ru3 -- "\${#value}"; print -rn -- "$value" >&3; else print -ru3 -- "unset"; fi`;

      let child: ZshProcess;
      try {
        child = launch("zsh", ["-i", "-c", script, "agent-tools-secret-env", name], {
          detached: true,
          env: childEnv,
          stdio: ["ignore", "ignore", "ignore", "pipe"],
        });
      } catch {
        resolve(failed(name));
        return;
      }

      const stream = child.stdio[3];
      if (!stream || typeof stream === "number") {
        child.kill("SIGKILL");
        resolve(failed(name));
        return;
      }

      const chunks: Buffer[] = [];
      let exited = false;
      let ended = false;
      let exitCode: number | null = null;
      let settled = false;
      const killProcessGroup = () => {
        if (child.pid === undefined) return;
        try {
          terminate(-child.pid);
        } catch {
          // The process group may already have exited.
        }
      };
      const finish = (result: LookupResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.destroy();
        killProcessGroup();
        resolve(result);
      };
      const checkFrame = () => {
        if (settled) return;
        const inspection = inspectFrame(Buffer.concat(chunks));
        if (inspection._tag === "malformed") return finish(failed(name));
        if (!exited) return;
        if (exitCode !== 0) return finish(failed(name));
        if (inspection._tag === "complete") finish(inspection.result);
        else if (ended) finish(failed(name));
      };
      const timer = setTimeout(() => {
        finish(failed(name));
      }, timeoutMs);

      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        checkFrame();
      });
      stream.on("end", () => {
        ended = true;
        checkFrame();
      });
      stream.on("error", () => finish(failed(name)));
      child.on("error", () => finish(failed(name)));
      child.on("exit", (code) => {
        exited = true;
        exitCode = code;
        checkFrame();
      });
    });

const runInteractiveZsh = makeZshRunner();

export class SecretEnvResolver extends Context.Service<
  SecretEnvResolver,
  {
    readonly resolveSecretEnv: (name: string) => Promise<string>;
    readonly lookupConfigEnv: (name: string) => Promise<LookupResult>;
  }
>()("@agent-tools/SecretEnvResolver") {
  static get liveLayer() {
    return makeSecretEnvResolverLayer();
  }
  static readonly testLayer = (runner: ZshRunner = () => Promise.resolve({ _tag: "absent" })) =>
    makeSecretEnvResolverLayer(runner);
}

export function makeSecretEnvResolverLayer(
  runner: ZshRunner = runInteractiveZsh,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  return Layer.sync(SecretEnvResolver, () => {
    const cache = new Map<string, Promise<LookupResult>>();
    const lookup = (name: string, emptyProcessValueWins: boolean): Promise<LookupResult> => {
      const fromProcess = process.env[name];
      if (fromProcess !== undefined && (emptyProcessValueWins || fromProcess !== "")) {
        return Promise.resolve({ _tag: "found", value: fromProcess });
      }

      let result = cache.get(name);
      if (!result) {
        result = Promise.resolve()
          .then(() => runner(name, timeoutMs))
          .catch(() => failed(name));
        cache.set(name, result);
      }
      return result;
    };
    const lookupConfigEnv = (name: string): Promise<LookupResult> => {
      if (!CONFIG_NAME_PATTERN.test(name)) return Promise.resolve(failed(name));
      return lookup(name, true);
    };
    const resolveSecretEnv = async (name: string): Promise<string> => {
      if (!SECRET_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid environment variable name: ${name}`);
      }
      const result = await lookup(name, false);
      if (result._tag !== "found") {
        throw new Error(`${name} is not in the environment or in the interactive zsh`);
      }
      if (result.value.length < 4) {
        throw new Error(`${name} is too short to redact safely`);
      }
      registerResolvedSecret(result.value, { allowShort: true });
      return result.value;
    };

    return SecretEnvResolver.of({ resolveSecretEnv, lookupConfigEnv });
  });
}
