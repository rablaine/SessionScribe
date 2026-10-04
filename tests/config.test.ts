import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

function recapQuota(value?: string) {
  const configUrl = new URL("../src/config.ts", import.meta.url).href;
  return spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { config } from ${JSON.stringify(configUrl)}; console.log(config.quotas.recaps);`,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DOTENV_CONFIG_PATH: path.join(os.tmpdir(), `scribe-no-env-${randomUUID()}`),
      ...(value === undefined ? {} : { DAILY_RECAPS_PER_USER: value }),
    },
  });
}

test("daily recap quota defaults to 100 without a local environment file", () => {
  const result = recapQuota();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "100");
});

test("daily recap quota preserves explicit environment overrides", () => {
  const result = recapQuota("30");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "30");
});

test("daily recap quota still rejects values outside the supported range", () => {
  const result = recapQuota("1001");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAILY_RECAPS_PER_USER/);
});
