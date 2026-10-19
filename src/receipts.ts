import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** The audit spine: every tick, claim, attempt, merge, and block lands here. */
export function receipt(stateDir: string, msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  appendFileSync(join(stateDir, "laps.log"), line + "\n");
  console.log(line);
}
