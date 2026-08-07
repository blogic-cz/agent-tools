import { Schema } from "effect";

export class ObservabilityToolError extends Schema.TaggedError<ObservabilityToolError>()(
  "ObservabilityToolError",
  {
    cause: Schema.Unknown,
  },
) {}
