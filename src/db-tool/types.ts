import type { Environment, OutputFormat } from "#shared";
export type { Environment, OutputFormat };

export type SchemaMode = "tables" | "columns" | "full" | "relationships";

export type DbConfig = {
  user: string;
  database: string;
  password?: string;
  passwordEnvVar?: string;
  port: number;
  needsTunnel: boolean;
  allowMutations: boolean;
};

export type QueryResult = {
  success: boolean;
  data?: Record<string, unknown>[];
  message?: string;
  error?: string;
  rowCount?: number;
  executionTimeMs: number;
  availableTables?: string[];
  availableColumns?: string[];
  hint?: string;
  schemaFile?: string;
};

export type SchemaErrorInfo = {
  type: "table_not_found" | "column_not_found" | null;
  missingName: string | null;
  tableName: string | null;
};
