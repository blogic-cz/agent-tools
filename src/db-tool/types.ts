import type {
  DbAllowedMutationTargets,
  DbMutationOperation,
  ProfilePrerequisites,
} from "#config/types";
import type { Environment, OutputFormat } from "#shared";

export type { DbMutationOperation };
export type { Environment, OutputFormat };

export type SchemaMode = "tables" | "columns" | "full" | "relationships";

export type DbConfig = ProfilePrerequisites & {
  host: string;
  user: string;
  database: string;
  password?: string;
  passwordEnvVar?: string;
  port: number;
  needsTunnel: boolean;
  allowMutations: boolean;
  allowedMutations: readonly DbMutationOperation[];
  allowedMutationTargets: DbAllowedMutationTargets;
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
  truncated?: boolean;
  total?: number;
};

export type SchemaErrorInfo = {
  type: "table_not_found" | "column_not_found" | null;
  missingName: string | null;
  tableName: string | null;
};
