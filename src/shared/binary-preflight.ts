import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Effect } from "effect";

export const REQUIRED_BINARIES = {
  az: {
    tools: "az-tool",
    install:
      "Install it with `brew install azure-cli` (macOS) or see https://learn.microsoft.com/cli/azure/install-azure-cli.",
  },
  gh: {
    tools: "gh-tool",
    install:
      "Install it with `brew install gh` (macOS) or see https://cli.github.com/, then run `gh auth login`.",
  },
  git: {
    tools: "gh-tool release and stack commands",
    install:
      "Install it with `xcode-select --install` (macOS) or see https://git-scm.com/downloads.",
  },
  kubectl: {
    tools: "k8s-tool and db-tool tunnels",
    install:
      "Install it with `brew install kubectl` (macOS) or see https://kubernetes.io/docs/tasks/tools/.",
  },
} as const;

export type RequiredBinary = keyof typeof REQUIRED_BINARIES;

export type MissingBinary = { binary: RequiredBinary; message: string; hint: string };

export type BinaryExists = (candidate: string) => Promise<boolean>;

const existsOnDisk: BinaryExists = async (candidate) => {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const isRequiredBinary = (binary: string): binary is RequiredBinary => binary in REQUIRED_BINARIES;

export const findOnPath = async (
  binary: string,
  pathEnv: string | undefined,
  exists: BinaryExists = existsOnDisk,
): Promise<boolean> => {
  const directories = (pathEnv ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const found = await Promise.all(directories.map((directory) => exists(join(directory, binary))));

  return found.includes(true);
};

const resolutionCache = new Map<RequiredBinary, Promise<boolean>>();

export const resetBinaryPreflightCache = () => resolutionCache.clear();

export const describeMissingBinary = (binary: RequiredBinary): MissingBinary => ({
  binary,
  message: `Required binary "${binary}" was not found on PATH.`,
  hint: `${binary} is needed by ${REQUIRED_BINARIES[binary].tools}. ${REQUIRED_BINARIES[binary].install}`,
});

export const missingBinary = (
  binary: string,
  exists?: BinaryExists,
): Effect.Effect<MissingBinary | undefined> =>
  Effect.promise(async () => {
    if (!isRequiredBinary(binary)) {
      return undefined;
    }

    if (exists) {
      return (await findOnPath(binary, process.env.PATH, exists))
        ? undefined
        : describeMissingBinary(binary);
    }

    let resolved = resolutionCache.get(binary);
    if (!resolved) {
      resolved = findOnPath(binary, process.env.PATH);
      resolutionCache.set(binary, resolved);
    }

    return (await resolved) ? undefined : describeMissingBinary(binary);
  });
