import type { AzurePlatformConfig } from "#config/types";

/** Profile keys treated as production unless the profile says otherwise. */
export const PRODUCTION_PROFILE_NAMES = ["prod", "production"] as const;

/**
 * The profile key getToolConfig will resolve to, so callers can reason about
 * which subscription they are about to touch. Mirrors getToolConfig's rules:
 * explicit name wins, then a lone profile, then the "default" key.
 */
export function selectAzProfileName(
  section: Record<string, unknown> | undefined,
  explicitProfile: string | undefined,
): string | undefined {
  if (explicitProfile) {
    return explicitProfile;
  }

  if (!section) {
    return undefined;
  }

  const keys = Object.keys(section);
  if (keys.length === 1) {
    return keys[0];
  }

  return Object.hasOwn(section, "default") ? "default" : undefined;
}

/**
 * Production profiles require --profile to be named explicitly. An explicit
 * `production` flag wins; otherwise the profile key carries the convention, so
 * a profile keyed "prod" is guarded without extra configuration.
 */
export function isProductionProfile(
  profileName: string | undefined,
  config: AzurePlatformConfig,
): boolean {
  if (config.production !== undefined) {
    return config.production;
  }

  return (
    profileName !== undefined &&
    (PRODUCTION_PROFILE_NAMES as readonly string[]).includes(profileName.toLowerCase())
  );
}
