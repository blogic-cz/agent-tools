import { Schema } from "effect";

export class ObservabilityToolError extends Schema.TaggedErrorClass<ObservabilityToolError>()(
  "ObservabilityToolError",
  {
    cause: Schema.Unknown,
  },
) {}
