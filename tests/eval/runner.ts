import { readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { evalTasks } from "./tasks";
import type { EvalReport, EvalScore, EvalTask } from "./types";

type EvalFixture = {
  taskId?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
};

type FixtureMap = Record<string, EvalFixture>;

const fixturesDirectory = fileURLToPath(new URL("./fixtures", import.meta.url));

export function runEval(): EvalReport {
  const fixtures = loadFixtures(fixturesDirectory);
  const scores = evalTasks.map((task) => scoreTask(task, fixtures[task.id]));
  const totalScore = scores.reduce((sum, score) => sum + score.score, 0);
  const passed = scores.filter((score) => score.passed).length;

  return {
    tasks: evalTasks,
    scores,
    summary: {
      total: evalTasks.length,
      passed,
      failed: evalTasks.length - passed,
      averageScore: evalTasks.length === 0 ? 0 : Number((totalScore / evalTasks.length).toFixed(3)),
    },
  };
}

function loadFixtures(directory: string): FixtureMap {
  const fixtures: FixtureMap = {};

  for (const entry of readdirSync(directory)) {
    if (extname(entry) !== ".json") {
      continue;
    }

    const fixturePath = fileURLToPath(new URL(`./fixtures/${entry}`, import.meta.url));

    try {
      const raw = readFileSync(fixturePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      mergeFixtureData(fixtures, parsed);
    } catch {
      continue;
    }
  }

  return fixtures;
}

function mergeFixtureData(fixtures: FixtureMap, parsed: unknown): void {
  if (!isRecord(parsed)) {
    return;
  }

  const asSingleFixture = normalizeFixture(parsed);
  if (asSingleFixture?.taskId !== undefined) {
    fixtures[asSingleFixture.taskId] = asSingleFixture;
    return;
  }

  for (const [taskId, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }

    const fixture = normalizeFixture(value);
    if (fixture !== undefined) {
      fixtures[taskId] = fixture;
    }
  }
}

function normalizeFixture(value: Record<string, unknown>): EvalFixture | undefined {
  const taskId = typeof value.taskId === "string" ? value.taskId : undefined;
  const tool = typeof value.tool === "string" ? value.tool : undefined;
  const output = typeof value.output === "string" ? value.output : undefined;
  const input = isRecord(value.input) ? value.input : undefined;

  if (taskId === undefined && tool === undefined && input === undefined && output === undefined) {
    return undefined;
  }

  return {
    taskId,
    tool,
    input,
    output,
  };
}

function scoreTask(task: EvalTask, fixture: EvalFixture | undefined): EvalScore {
  if (fixture === undefined) {
    return {
      taskId: task.id,
      passed: false,
      score: 0,
      details: "fixture: missing",
    };
  }

  const expectedCommand = task.input.command;
  const actualInput = fixture.input ?? {};
  const actualCommand = actualInput.command;

  const toolMatches = fixture.tool === task.tool;
  const commandMatches = expectedCommand === actualCommand;

  const expectedFlags = Object.entries(task.input).filter(([key]) => key !== "command");
  const mismatchedFlags = expectedFlags
    .filter(([key, value]) => !deepEqual(actualInput[key], value))
    .map(([key]) => key);
  const flagsMatch = mismatchedFlags.length === 0;

  const output = fixture.output ?? "";
  const patternMatches = new RegExp(task.expectedPattern, "i").test(output);

  let score = 0;
  if (!toolMatches || !commandMatches) {
    score = 0;
  } else if (flagsMatch && patternMatches) {
    score = 1;
  } else {
    score = 0.5;
  }

  const details = [
    `tool=${toolMatches ? "match" : `mismatch(expected=${task.tool},actual=${fixture.tool ?? "missing"})`}`,
    `command=${commandMatches ? "match" : `mismatch(expected=${String(expectedCommand)},actual=${String(actualCommand)})`}`,
    `flags=${flagsMatch ? "match" : `mismatch(${mismatchedFlags.join(",")})`}`,
    `pattern=${patternMatches ? "match" : `miss(${task.expectedPattern})`}`,
  ].join("; ");

  return {
    taskId: task.id,
    passed: score === 1,
    score,
    details,
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => deepEqual(value, right[index]));
  }

  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
