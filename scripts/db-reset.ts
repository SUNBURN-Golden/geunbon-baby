import { resetDatabase } from "../src/server/sql";

await resetDatabase();
console.log("database reset and reseeded");
process.exit(0);
