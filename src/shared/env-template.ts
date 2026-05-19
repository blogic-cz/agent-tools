import { Effect } from "effect";

const envTemplateRegex = /^\$\{([A-Za-z0-9_]+)\}$/;

const loadEnvFromZshrc = Effect.fn("loadEnvFromZshrc")(function* () {
  const home = process.env.HOME;
  if (!home || home.trim() === "") {
    return {};
  }

  const zshrcPath = `${home}/.zshrc`;
  const content = yield* Effect.tryPromise(async () => {
    const file = Bun.file(zshrcPath);
    if (!(await file.exists())) {
      return "";
    }
    return await file.text();
  }).pipe(Effect.orElseSucceed(() => ""));

  const envVars: Record<string, string> = {};
  const regex = /^export\s+([A-Z_][A-Z0-9_]*)=["']?([^"'\n]+)["']?/gm;
  let match = regex.exec(content);

  while (match !== null) {
    envVars[match[1]] = match[2];
    match = regex.exec(content);
  }

  return envVars;
});

export const resolveEnvTemplate = Effect.fn("resolveEnvTemplate")(function* (value: string) {
  const match = value.match(envTemplateRegex);
  if (!match) {
    return value;
  }

  const envVar = match[1];
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    return fromEnv;
  }

  const zshrcEnv = yield* loadEnvFromZshrc();
  const fromZsh = zshrcEnv[envVar];
  if (fromZsh) {
    return fromZsh;
  }

  return yield* Effect.fail({ envVar });
});
