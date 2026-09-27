import { Console, Effect, Terminal } from "effect";

import { redactSensitiveText, redactSensitiveValue } from "./content-security";

const redactArgument = (value: unknown) =>
  typeof value === "string" ? redactSensitiveText(value) : redactSensitiveValue(value);

export const withRedactedOutput = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const currentConsole = yield* Console.Console;
    const currentTerminal = yield* Terminal.Terminal;
    const redactedConsole = new Proxy(currentConsole, {
      get(target, key) {
        const member = Reflect.get(target, key);
        return typeof member === "function"
          ? (...args: ReadonlyArray<unknown>) => member.apply(target, args.map(redactArgument))
          : member;
      },
    });
    const redactedTerminal = Object.assign(Object.create(currentTerminal), {
      display: (text: string) => currentTerminal.display(redactSensitiveText(text)),
    });

    return yield* Effect.provideService(
      Effect.provideService(program, Console.Console, redactedConsole),
      Terminal.Terminal,
      redactedTerminal,
    );
  });
