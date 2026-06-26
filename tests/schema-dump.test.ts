import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { dumpCommandSchema } from "#shared/schema-dump";

// Guards the parser against effect/unstable/cli internal-shape changes: if the Command/Param/
// primitive internals shift on an effect bump, these assertions fail loudly instead of the dump
// silently degrading to empty flags/subcommands.
const greet = Command.make(
  "greet",
  {
    name: Flag.string("name").pipe(Flag.withDescription("who to greet")),
    mode: Flag.choice("mode", ["loud", "soft"]).pipe(Flag.optional),
  },
  () => Effect.void,
).pipe(Command.withDescription("Greet someone"));

const root = Command.make("root", {}).pipe(Command.withSubcommands([greet]));

describe("dumpCommandSchema", () => {
  it("walks the command tree and extracts flag name/type/choices/description", () => {
    const schema = dumpCommandSchema(root);
    expect(schema.name).toBe("root");

    const child = schema.subcommands.find((c) => c.name === "greet");
    expect(child?.description).toBe("Greet someone");
    expect(child?.flags.map((f) => f.name).sort()).toEqual(["mode", "name"]);

    const name = child?.flags.find((f) => f.name === "name");
    expect(name?.type).toBe("String");
    expect(name?.description).toBe("who to greet");

    const mode = child?.flags.find((f) => f.name === "mode");
    expect(mode?.type).toBe("Choice");
    expect(mode?.choices).toEqual(["loud", "soft"]);
  });
});
