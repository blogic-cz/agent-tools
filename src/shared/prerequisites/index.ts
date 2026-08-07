// Public surface: what an out-of-package tool needs to declare a VPN prerequisite and run behind it.
export { resolveEnvironmentScopedPrerequisites } from "./config";

export { isPrerequisiteRunError, PrerequisiteRunError } from "./errors";

export { runWithProfilePrerequisites } from "./runtime";

export type { PrerequisiteCommandResult, PrerequisiteCommandRunner } from "./types";

export type { ProfilePrerequisites, VpnPrerequisite } from "#config/types";
