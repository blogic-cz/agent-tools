import { runEval } from "./runner";

const report = runEval();

console.log(
  `Eval report: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed, average=${report.summary.averageScore.toFixed(2)}`,
);
for (const score of report.scores) {
  console.log(`[${score.score.toFixed(1)}] ${score.taskId} -> ${score.details}`);
}
