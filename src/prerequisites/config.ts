import type { AgentToolsConfig, Prerequisite, ProfilePrerequisites } from "#config/types";

export type PrerequisiteResolution =
  | { success: true; prerequisites: readonly Prerequisite[] }
  | { success: false; error: string; hint: string };

export function normalizeProfilePrerequisites(
  profile: ProfilePrerequisites,
): readonly Prerequisite[] {
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
