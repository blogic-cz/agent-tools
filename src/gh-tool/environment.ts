// Exact names only: GH children need their own auth/config, not unrelated credentials
// or executable-loader, editor, and pager settings from the parent process.
const GH_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "AppData",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "XDG_CONFIG_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_REPO",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export const ghEnvironment = (
  environment: Record<string, string | undefined> = process.env,
): Record<string, string> =>
  Object.fromEntries(
    GH_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
