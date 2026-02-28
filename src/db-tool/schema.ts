/**
 * SQL queries for schema introspection.
 *
 * NOTE: The `columns` query uses string interpolation for the table name.
 * This is a known limitation — callers must validate the table name
 * via `isValidTableName()` before calling `getColumns()`.
 */
export const SCHEMA_QUERIES = {
  tables: `
    SELECT tablename as name
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `,
  columns: (tableName: string) => {
    const escapedTableName = tableName.replaceAll("'", "''");

    return `
    SELECT
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
    AND c.table_schema = 'public'
    ORDER BY c.ordinal_position
  `;
  },
  relationships: `
    SELECT
      tc.table_name as from_table,
      kcu.column_name as from_column,
      ccu.table_name as to_table,
      ccu.column_name as to_column,
      tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    ORDER BY tc.table_name, kcu.column_name
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
