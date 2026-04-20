import { Schema } from "effect";

export class GrafanaToolError extends Schema.TaggedErrorClass<GrafanaToolError>()(
  "GrafanaToolError",
  {
    cause: Schema.Unknown,
  },
) {}
