import { existsSync } from "node:fs";
import { afterAll, beforeAll } from "vitest";

// Load .env.test.local for live-integration tests. Mocked tests don't need
// any env, so this is best-effort — the file is gitignored and optional.
// `process.loadEnvFile` is a Node 20.6+ builtin; falls back silently if it
// isn't available or the file is missing.
if (existsSync(".env.test.local") && typeof process.loadEnvFile === "function") {
	process.loadEnvFile(".env.test.local");
}

beforeAll(() => {});
afterAll(() => {});
