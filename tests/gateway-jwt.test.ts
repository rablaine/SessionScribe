import { test } from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier, type GatewayOptions } from "../src/gateway.js";

test("gateway verifies real RS256 signatures, expiry, audience and issuer against tenant JWKS", async () => {
  const options: GatewayOptions = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    audience: "11111111-1111-4111-8111-111111111111",
    callerClientId: "22222222-2222-4222-8222-222222222222",
    callerObjectId: "33333333-3333-4333-8333-333333333333",
    storageAccountUrl: "https://fixture.blob.core.windows.net", storageContainer: "dnd-audio",
  };
  const trusted = await generateKeyPair("RS256");
  const untrusted = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(trusted.publicKey), kid: "fixture-key", alg: "RS256", use: "sig" };
  const originalFetch = globalThis.fetch;
  let jwksRequests = 0;
  const issuer = `https://login.microsoftonline.com/${options.tenantId}/v2.0`;
  const now = Math.floor(Date.now() / 1000);
  const sign = (key = trusted.privateKey, audience = options.audience, expiration = now + 300, tokenIssuer = issuer) =>
    new SignJWT({ roles: ["Audio.Manage"], azp: options.callerClientId, oid: options.callerObjectId })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .setIssuedAt(now).setIssuer(tokenIssuer).setAudience(audience).setExpirationTime(expiration).sign(key);
  try {
    // Only the JWKS transport is injected: jose's actual cryptographic and claims checks run.
    globalThis.fetch = async input => {
      assert.equal(String(input), `https://login.microsoftonline.com/${options.tenantId}/discovery/v2.0/keys`);
      jwksRequests++;
      return Response.json({ keys: [jwk] });
    };
    const verify = createTokenVerifier(options);
    const claims = await verify(await sign());
    assert.equal(claims.aud, options.audience);
    assert.deepEqual(claims.roles, ["Audio.Manage"]);
    await assert.rejects(verify(await sign(untrusted.privateKey)), { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" });
    await assert.rejects(verify(await sign(trusted.privateKey, options.audience, now - 60)), { code: "ERR_JWT_EXPIRED" });
    await assert.rejects(verify(await sign(trusted.privateKey, "wrong-audience")), { code: "ERR_JWT_CLAIM_VALIDATION_FAILED" });
    await assert.rejects(verify(await sign(trusted.privateKey, options.audience, now + 300, "https://wrong.example/v2.0")), {
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    });
    assert.equal(jwksRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
