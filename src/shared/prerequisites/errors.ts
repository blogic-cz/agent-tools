import { Schema } from "effect";

export class PrerequisiteRunError extends Schema.TaggedError<PrerequisiteRunError>()(
  "PrerequisiteRunError",
  {
    message: Schema.String,
    hint: Schema.optionalKey(Schema.String),
  },
) {}

export const isPrerequisiteRunError = (error: unknown): error is PrerequisiteRunError =>
  error instanceof PrerequisiteRunError;
