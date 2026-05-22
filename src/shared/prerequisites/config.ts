import type { AgentToolsConfig, VpnPrerequisite, ProfilePrerequisites } from "#config/types";
import type { PrerequisiteResolution } from "#shared/prerequisites/types";

export function normalizeProfilePrerequisites(
  profile: ProfilePrerequisites,
): readonly VpnPrerequisite[] {
  const prerequisites = [...(profile.prerequisites ?? [])];

  if (
    profile.vpn &&
    !prerequisites.some(
      (prerequisite) => prerequisite.type === "vpn" && prerequisite.key === profile.vpn,
    )
  ) {
    prerequisites.push({ type: "vpn", key: profile.vpn });
  }

  return prerequisites;
}

export function resolveProfilePrerequisites(
  config: AgentToolsConfig,
  profile: ProfilePrerequisites,
): PrerequisiteResolution {
  const prerequisites = normalizeProfilePrerequisites(profile);

  for (const prerequisite of prerequisites) {
    if (prerequisite.type === "vpn" && !config.vpns?.[prerequisite.key]) {
      return {
        success: false,
        error: `VPN prerequisite "${prerequisite.key}" is not defined.`,
        hint: `Add vpns.${prerequisite.key} to agent-tools.json5 or remove the prerequisite.`,
      };
    }
  }

  return { success: true, prerequisites };
}

const hasOwnPrerequisiteConfig = (profile: ProfilePrerequisites, key: keyof ProfilePrerequisites) =>
  Object.prototype.hasOwnProperty.call(profile, key);

export function resolveEnvironmentScopedPrerequisites(
  profile: ProfilePrerequisites,
  environment: ProfilePrerequisites,
): ProfilePrerequisites {
  const source =
    hasOwnPrerequisiteConfig(environment, "vpn") ||
    hasOwnPrerequisiteConfig(environment, "prerequisites")
      ? environment
      : profile;

  return {
    ...(source.vpn !== undefined ? { vpn: source.vpn } : {}),
    ...(source.prerequisites !== undefined ? { prerequisites: source.prerequisites } : {}),
  };
}
