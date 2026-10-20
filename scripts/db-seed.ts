import { getSql } from "../src/server/sql";

const sql = await getSql();
await sql.query("SELECT COUNT(*)::text AS count FROM brands");
console.log("database ready");
process.exit(0);
