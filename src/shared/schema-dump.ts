import { Command } from "effect/unstable/cli";
import { Option } from "effect";

import { formatOption, logFormatted } from "./format";

/**
 * Machine-readable command-tree dump so an agent can discover the whole CLI surface in ONE call
 * instead of repeated `--help` round-trips (the top remaining discovery friction in the usage audit).
 */
export type FlagSchema = {
  readonly name: string;
  readonly type?: string;
  readonly choices?: readonly string[];
  readonly description?: string;
  readonly aliases?: readonly string[];
};

export type CommandSchema = {
  readonly name: string;
  readonly description?: string;
  readonly flags: readonly FlagSchema[];
  readonly subcommands: readonly CommandSchema[];
};

// Leaf parameter from effect/unstable/cli; carries the user-facing flag name/description/type.
type SingleParam = {
  readonly _tag: "Single";
  readonly name: string;
  readonly description: Option.Option<string>;
  readonly aliases?: readonly string[];
  readonly primitiveType?: { readonly _tag?: string; readonly choiceKeys?: readonly string[] };
};

// Minimal view of the (partly internal) Command runtime shape we walk. Public fields: name,
// description, subcommands; `config.flags` is internal but stable, read defensively.
type CommandNode = {
  readonly name: string;
  readonly description?: string;
  readonly subcommands?: ReadonlyArray<{ readonly commands?: ReadonlyArray<unknown> }>;
  readonly config?: { readonly flags?: ReadonlyArray<unknown> };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Flags wrap as Optional/Map/Transform/Variadic around a leaf Single; descend via `.param`.
const unwrapToSingle = (param: unknown): SingleParam | undefined => {
  let current: unknown = param;
  for (let depth = 0; depth < 16 && isObject(current); depth++) {
    if (current._tag === "Single" && typeof current.name === "string") {
      return current as unknown as SingleParam;
    }
    current = current.param;
  }
  return undefined;
};

const flagToSchema = (param: unknown): FlagSchema | undefined => {
  const single = unwrapToSingle(param);
  if (!single) return undefined;
  const primitive = single.primitiveType;
  const choices = primitive?.choiceKeys;
  return {
    name: single.name,
    type: primitive?._tag,
    choices: choices && choices.length > 0 ? choices : undefined,
    description: Option.getOrUndefined(single.description),
    aliases: single.aliases && single.aliases.length > 0 ? single.aliases : undefined,
  };
};

export const dumpCommandSchema = (command: unknown): CommandSchema => {
  const node = command as CommandNode;
  const flags = (node.config?.flags ?? [])
    .map(flagToSchema)
    .filter((flag): flag is FlagSchema => flag !== undefined);
  const subcommands = (node.subcommands ?? [])
    .flatMap((group) => group.commands ?? [])
    .map(dumpCommandSchema);
  return { name: node.name, description: node.description, flags, subcommands };
};

/**
 * Builds the `schema` subcommand for a tool. Pass a thunk returning the tool's root command so the
 * dump reflects the fully-assembled tree (the root is defined after its subcommands, incl. this one).
 */
export const makeSchemaCommand = (getRoot: () => unknown) =>
  Command.make("commands", { format: formatOption }, ({ format }) =>
    logFormatted(dumpCommandSchema(getRoot()), format),
  ).pipe(
    Command.withDescription(
      "Dump the full command tree (names, descriptions, flags, types) as structured output — fetch once instead of repeated --help.",
    ),
  );
