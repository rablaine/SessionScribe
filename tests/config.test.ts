import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

function quotaConfig(kind: "recaps" | "audioMs", overrides: Record<string, string> = {}) {
  const configUrl = new URL("../src/config.ts", import.meta.url).href;
  return spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { config } from ${JSON.stringify(configUrl)}; console.log(config.quotas.${kind});`,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DOTENV_CONFIG_PATH: path.join(os.tmpdir(), `scribe-no-env-${randomUUID()}`),
      ...overrides,
    },
  });
}

test("daily recap quota defaults to 100 without a local environment file", () => {
  const result = quotaConfig("recaps");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "100");
});

test("daily recap quota preserves explicit environment overrides", () => {
  const result = quotaConfig("recaps", { DAILY_RECAPS_PER_USER: "30" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "30");
});

test("daily recap quota still rejects values outside the supported range", () => {
  const result = quotaConfig("recaps", { DAILY_RECAPS_PER_USER: "1001" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAILY_RECAPS_PER_USER/);
});

test("daily audio quota defaults to 100 hours expressed in milliseconds", () => {
  const result = quotaConfig("audioMs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(result.stdout.trim()), 100 * 3_600_000);
});

test("daily audio quota preserves explicit and fractional-hour overrides", () => {
  for (const hours of [24, 1.5]) {
    const result = quotaConfig("audioMs", { DAILY_AUDIO_HOURS_PER_USER: String(hours) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout.trim()), hours * 3_600_000);
  }
});

test("daily audio quota still rejects values outside the supported range", () => {
  for (const hours of ["0", "1001"]) {
    const result = quotaConfig("audioMs", { DAILY_AUDIO_HOURS_PER_USER: hours });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DAILY_AUDIO_HOURS_PER_USER/);
  }
});
