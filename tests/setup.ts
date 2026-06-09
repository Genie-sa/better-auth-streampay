import { existsSync } from "node:fs";
import { afterAll, beforeAll } from "vitest";

if (existsSync(".env.test.local") && typeof process.loadEnvFile === "function") {
	process.loadEnvFile(".env.test.local");
}

beforeAll(() => {});
afterAll(() => {});
