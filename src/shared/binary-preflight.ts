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

const isRequiredBinary = (binary: string): binary is RequiredBinary => binary in REQUIRED_BINARIES;

export const describeMissingBinary = (binary: RequiredBinary): MissingBinary => ({
  binary,
  message: `Required binary "${binary}" was not found on PATH.`,
  hint: `${binary} is needed by ${REQUIRED_BINARIES[binary].tools}. ${REQUIRED_BINARIES[binary].install}`,
});

export const missingBinaryFromSpawnFailure = (
  binary: string,
  failure: string,
): MissingBinary | undefined =>
  isRequiredBinary(binary) && failure.includes("NotFound")
    ? describeMissingBinary(binary)
    : undefined;
