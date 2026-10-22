import { formatLiteralPrintf } from "./literal-output";
import { parseBash } from "./bash";
import { judge } from "./policy";
import { splitXargsInput, type XargsInput } from "./xargs";

const quote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";
const receipt: Record<string, { checked: number; refused: number; mismatches: unknown[] }> = {};
async function compare(
  family: string,
  shell: string,
  source: string,
  modeled: readonly string[] | null,
) {
  const count = (receipt[family] ??= { checked: 0, refused: 0, mismatches: [] });
  const child = Bun.spawn([shell, "-c", source], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
  });
  const actual = await new Response(child.stdout).text();
  await new Response(child.stderr).text();
  await child.exited;
  count.checked++;
  if (modeled === null) count.refused++;
  else if (family === "termination") {
    const reached = actual.split("\n").includes("[reached]");
    if (reached && !modeled.some((output) => output.includes("[reached]")))
      count.mismatches.push({ shell, source, actual, modeled });
  } else if (!modeled.includes(actual)) count.mismatches.push({ shell, source, actual, modeled });
}
function modeledOutput(source: string): readonly string[] | null {
  const outputs: string[] = [];
  let unresolved = false;
  const decision = judge(parseBash(source), {
    home: "/home/dev",
    cwd: "/tmp",
    onInvocation(executable, argv) {
      if (executable === "/usr/bin/printf" && argv[1] === "[%s]\\n") {
        if (argv.some((word) => word === undefined)) unresolved = true;
        outputs.push(
          (argv.length > 2 ? argv.slice(2) : [""]).map((word) => `[${word}]\n`).join(""),
        );
      }
    },
  });
  return decision.kind === "pass" && !unresolved
    ? outputs.length
      ? [...outputs, outputs.join("")]
      : [""]
    : null;
}
const jobs: Array<() => Promise<void>> = [];
const shells = ["/bin/bash", "/bin/sh", "/bin/zsh", "/bin/dash"];
const available = await Promise.all(
  shells.map(async (shell) => ({ shell, exists: await Bun.file(shell).exists() })),
);
for (const { shell, exists } of available) {
  if (!exists) {
    console.log(`SKIP missing shell ${shell}`);
    continue;
  }
  const braces = [
    "{a,}",
    "{,}",
    "{,b}",
    "x{,b}",
    "{a,b}{,c}",
    "'{a,b}'",
    '"{a,b}"',
    "{a,{b,c}}",
    "{a,}''",
    "''{,b}",
  ];
  for (const left of ["a", "", "b"])
    for (const right of ["", "c", "d"]) braces.push(`{${left},${right}}`, `p{${left},${right}}q`);
  for (const words of braces) {
    const source = `/usr/bin/printf '[%s]\\n' seed ${words}`;
    const model =
      shell.endsWith("/sh") || shell.endsWith("/dash")
        ? `sh -c ${quote(source)}`
        : shell.endsWith("/bash")
          ? `bash -c ${quote(source)}`
          : source;
    jobs.push(() => compare("brace", shell, source, modeledOutput(model)));
  }
  for (const format of ["%s\\n", "%s ", "%s", "%s:%s\\n"])
    for (const words of [[], ["alpha"], ["alpha", "beta"], ["", "beta"], ["a b", "c"]]) {
      const source = `printf ${quote(format)} ${words.map(quote).join(" ")}`;
      const modeled = formatLiteralPrintf([format, ...words]);
      jobs.push(() => compare("printf", shell, source, modeled === null ? null : [modeled]));
    }
  for (const compound of [
    "{ exit 0; }",
    "(exit 0)",
    "if true; then exit 0; fi",
    "case x in x) exit 0;; esac",
    "for x in a; do exit 0; done",
    "while true; do exit 0; done",
    "exit 0 && true",
    "exit 0 || true",
    "exit 0 && false || true",
    "exit 0 || false && true",
    "{ exit 0; } && true",
    "! { exit 0; } || true",
  ])
    for (const redirect of ["&>/dev/null", "&>>/dev/null"]) {
      const source = `${compound} ${redirect}; /usr/bin/printf '[%s]\\n' reached`;
      jobs.push(() =>
        compare(
          "termination",
          shell,
          source,
          modeledOutput(
            `${shell.endsWith("/bash") || shell.endsWith("/zsh") ? "bash" : "sh"} -c ${quote(source)}`,
          ),
        ),
      );
    }
  for (const command of ["exit", "return"])
    for (const redirect of [
      "",
      " 2>/dev/null",
      " &>/dev/null",
      " &>>/dev/null",
      " </tmp/guard-oracle-missing/input",
      " >/dev/null/x",
      " 2>&1",
      " 2>&99",
      " 1>&- 2>&1",
    ])
      for (const op of [";", "||"]) {
        const source = `${command} 0${redirect} ${op} /usr/bin/printf '[%s]\\n' reached`;
        jobs.push(() =>
          compare(
            "termination",
            shell,
            source,
            modeledOutput(
              `${shell.endsWith("/bash") || shell.endsWith("/zsh") ? "bash" : "sh"} -c ${quote(source)}`,
            ),
          ),
        );
      }
}
const modes: XargsInput[] = [
  { replacement: null, maxArgs: null, maxLines: null },
  { replacement: "{}", maxArgs: null, maxLines: null },
  { replacement: null, maxArgs: 1, maxLines: null },
  { replacement: null, maxArgs: null, maxLines: 1 },
];
const inputs = [
  "a\nb\n",
  "a b\n",
  "'' word\n",
  '"" word\n',
  "a  b\n",
  "a\tb\n",
  "  a\n",
  "a\n\nb\n",
  "'a b'\n",
  "a\\ b\n",
];
for (const a of ["a", "''", '""', " "])
  for (const b of [" ", "  ", "\t", "\n"]) inputs.push(a + b + "b\n");
for (const mode of modes)
  for (const input of inputs) {
    const groups = splitXargsInput(input, mode);
    const output =
      groups === null
        ? null
        : groups
            .flatMap((words) => (words.length ? words : [""]).map((word) => `[${word}]\n`))
            .join("");
    const flags = mode.replacement ? "-I{}" : mode.maxArgs ? "-n1" : mode.maxLines ? "-L1" : "";
    const source = `printf '%s' ${quote(input)} | /usr/bin/xargs ${flags} /usr/bin/printf '[%s]\\n' ${mode.replacement ? "'{}'" : ""}`;
    jobs.push(() =>
      compare(
        `xargs-${flags || "default"}`,
        "/bin/bash",
        source,
        output === null ? null : [output],
      ),
    );
  }
await jobs.reduce((previous, run) => previous.then(run), Promise.resolve());
console.log(JSON.stringify(receipt, null, 2));
if (Object.values(receipt).some((family) => family.mismatches.length)) process.exitCode = 1;
