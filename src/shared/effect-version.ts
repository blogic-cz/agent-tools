import { fileURLToPath } from "node:url";

// eslint-disable-next-line import/no-relative-parent-imports -- package.json lives at project root, outside src/
import pkg from "../../package.json" with { type: "json" };

export const EFFECT_VERSION_RANGE = pkg.peerDependencies.effect;

export const effectVersionError = (version: string | undefined): string | undefined => {
  if (version === undefined) {
    return `agent-tools requires effect ${EFFECT_VERSION_RANGE} but could not resolve the installed effect package; install a matching effect version`;
  }
  return Bun.semver.satisfies(version, EFFECT_VERSION_RANGE)
    ? undefined
    : `agent-tools requires effect ${EFFECT_VERSION_RANGE} but found ${version}; install a matching effect version`;
};

export const checkEffectVersion = async (): Promise<boolean> => {
  let version: string | undefined;
  try {
    const manifest = await Bun.file(
      fileURLToPath(import.meta.resolve("effect/package.json")),
    ).json();
    if (typeof manifest.version === "string") version = manifest.version;
  } catch {
    // An unresolved package is incompatible too; wrappers must fail before loading Effect imports.
  }

  const error = effectVersionError(version);
  if (error === undefined) return true;
  console.error(error);
  return false;
};
