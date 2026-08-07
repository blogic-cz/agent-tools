import { Effect, Schema } from "effect";

const envTemplateRegex = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class EnvTemplateError extends Schema.TaggedError<EnvTemplateError>()(
  "@agent-tools/EnvTemplateError",
  { envVar: Schema.String },
) {}

export const resolveEnvTemplate = Effect.fn("resolveEnvTemplate")(function* (value: string) {
  let resolved = "";
  let lastIndex = 0;
  const env = globalThis.Bun?.env ?? process.env;

  for (const match of value.matchAll(envTemplateRegex)) {
    const fullMatch = match[0];
    const envVar = match[1];
    const index = match.index;
    if (index === undefined) {
      continue;
    }

    resolved += value.slice(lastIndex, index);
    const fromEnv = env[envVar];
    if (fromEnv === undefined) {
      return yield* new EnvTemplateError({ envVar });
    }

    resolved += fromEnv;
    lastIndex = index + fullMatch.length;
  }

  if (lastIndex === 0) {
    return value;
  }

  return resolved + value.slice(lastIndex);
});
