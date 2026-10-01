import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "./db";
import { seed } from "./seed";

const file = process.env.DB_FILE ?? "data/003.sqlite";
mkdirSync(dirname(file), { recursive: true });
seed(openDb(file), process.env.ADMIN_PASSWORD);
console.log("Seed aplicado en", file);
