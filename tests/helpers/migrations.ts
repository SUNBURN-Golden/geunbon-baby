// D1 prepare takes a complete statement, including the semicolons inside a trigger.
export function migrationStatements(sql: string) {
  const statements: string[] = [];
  const triggers = /^CREATE TRIGGER\b[\s\S]*?^END;/gm;
  let cursor = 0;
  const append = (body: string) => statements.push(...body.split(';').filter(value => value.replace(/--[^\n]*/g, '').trim()));
  for (const match of sql.matchAll(triggers)) {
    append(sql.slice(cursor, match.index));
    statements.push(match[0]);
    cursor = match.index! + match[0].length;
  }
  append(sql.slice(cursor));
  return statements;
}
