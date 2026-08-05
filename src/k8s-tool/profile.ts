// --profile wins if given; else a kubernetes.<env> section (different cluster per env) wins; else undefined (getToolConfig default).
export function selectK8sProfile(
  kubernetesSection: Record<string, unknown> | undefined,
  explicitProfile: string | undefined,
  resolvedEnv: string,
): string | undefined {
  if (explicitProfile) {
    return explicitProfile;
  }

  if (kubernetesSection && Object.hasOwn(kubernetesSection, resolvedEnv)) {
    return resolvedEnv;
  }

  return undefined;
}

export function hasKubernetesConfig(
  kubernetesSection: Record<string, unknown> | undefined,
): boolean {
  return !!kubernetesSection && Object.keys(kubernetesSection).length > 0;
}
