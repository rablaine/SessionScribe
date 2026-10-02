import { test } from "node:test";
import assert from "node:assert/strict";
import { config, readiness } from "../src/config.js";
import { azureCredential } from "../src/auth.js";

test("certificate mode requires explicit SP configuration and never falls back to admin CLI", () => {
  const original = { ...config };
  try {
    Object.assign(config, { authMode: "certificate", tenantId: "", clientId: "", certificatePath: "" });
    const state = readiness();
    for (const name of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_CERTIFICATE_PATH"]) {
      assert(state.transcriptionMissing.includes(name));
      assert(state.recapMissing.includes(name));
    }
    assert.throws(() => azureCredential(), /Certificate authentication requires/);
    Object.assign(config, { authMode: "managed-identity" });
    assert.equal(readiness().transcriptionMissing.some(name => String(name).includes("KEY")), false);
    assert.equal(readiness().recapMissing.includes("AZURE_CLIENT_CERTIFICATE_PATH"), false);
  } finally {
    Object.assign(config, original);
  }
});
