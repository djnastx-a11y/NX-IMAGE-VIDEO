import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl, 1);
const applied = await migrate(pool, console.log);
console.log(applied.length ? `${applied.length} migration(s) applied` : "database is up to date");
await pool.end();
