/**
 * SQL queries for schema introspection.
 *
 * NOTE: The `columns` query uses string interpolation for the table name.
 * This is a known limitation — callers must validate the table name
 * via `isValidTableName()` before calling `getColumns()`.
 */
const SYSTEM_SCHEMAS_SQL = "'pg_catalog', 'information_schema'";

function parseTableReference(tableName: string): { schemaName?: string; tableName: string } {
  const [schemaName, name, ...extra] = tableName.split(".");

  if (name && extra.length === 0) {
    return { schemaName, tableName: name };
  }

  return { tableName };
}

export const SCHEMA_QUERIES = {
  tables: `
    SELECT
      schemaname as schema,
      tablename as name,
      schemaname || '.' || tablename as qualified_name
    FROM pg_tables
    WHERE schemaname NOT IN (${SYSTEM_SCHEMAS_SQL})
    ORDER BY schemaname, tablename
  `,
  columns: (tableName: string) => {
    const tableReference = parseTableReference(tableName);
    const escapedTableName = tableReference.tableName.replaceAll("'", "''");
    const schemaFilter = tableReference.schemaName
      ? `AND c.table_schema = '${tableReference.schemaName.replaceAll("'", "''")}'`
      : `AND c.table_schema NOT IN (${SYSTEM_SCHEMAS_SQL})`;

    return `
    SELECT
      c.table_schema as schema,
      c.table_name as table,
      c.column_name as name,
      c.data_type as type,
      c.is_nullable = 'YES' as nullable,
      c.column_default as default_value,
      COALESCE(
        (SELECT true FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         WHERE tc.table_name = c.table_name
         AND tc.table_schema = c.table_schema
         AND kcu.column_name = c.column_name
         AND tc.constraint_type = 'PRIMARY KEY'),
        false
      ) as is_primary_key
    FROM information_schema.columns c
    WHERE c.table_name = '${escapedTableName}'
    ${schemaFilter}
    ORDER BY c.table_schema, c.ordinal_position
  `;
  },
  relationships: `
    SELECT
      tc.table_schema as from_schema,
      tc.table_name as from_table,
      kcu.column_name as from_column,
      ccu.table_schema as to_schema,
      ccu.table_name as to_table,
      ccu.column_name as to_column,
      tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema NOT IN (${SYSTEM_SCHEMAS_SQL})
    ORDER BY tc.table_schema, tc.table_name, kcu.column_name
  `,
};

export function getTableNames(): string {
  return SCHEMA_QUERIES.tables;
}

export function getColumns(tableName: string): string {
  return SCHEMA_QUERIES.columns(tableName);
}

export function getRelationships(): string {
  return SCHEMA_QUERIES.relationships;
}
