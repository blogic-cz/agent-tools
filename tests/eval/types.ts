export type EvalTask = {
  id: string;
  tool: string;
  description: string;
  input: Record<string, unknown>;
  expectedPattern: string;
};

export type EvalScore = {
  taskId: string;
  passed: boolean;
  score: number;
  details: string;
};

export type EvalReport = {
  tasks: EvalTask[];
  scores: EvalScore[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    averageScore: number;
  };
};
