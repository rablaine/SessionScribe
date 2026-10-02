import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";
import { StorageGatewayClient } from "../src/storage-gateway-client.js";
import { storageGatewayHeaders } from "../src/auth.js";

test("local gateway streams audio with separate auth, checks exact plain URL, and never retries", async () => {
  const original = { ...config };
  const originalFetch = globalThis.fetch;
  const dir = path.resolve("data", "gateway-client-test");
  const file = path.join(dir, "mono.mp3");
  const name = "12345678-1234-4234-8234-123456789abc/mono.mp3";
  await mkdir(dir, { recursive: true });
  await writeFile(file, "abc");
  Object.assign(config, {
    storageGatewayUrl: "https://fixture.azurewebsites.net", storageGatewayScope: "api://fixture/.default",
    storageAccountUrl: "https://fixture.blob.core.windows.net", storageContainer: "dnd-audio",
  });
  const expected = `${config.storageAccountUrl}/${config.storageContainer}/${name}`;
  const client = new StorageGatewayClient(async () => ({ Authorization: "Bearer gateway-only" }));
  let calls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), `https://fixture.azurewebsites.net/audio/${name}`);
      const headers = new Headers(init!.headers);
      assert.equal(headers.get("Authorization"), "Bearer gateway-only");
      if (init!.method === "DELETE") return new Response(null, { status: 204 });
      assert.equal(init!.redirect, "error");
      assert.equal(headers.get("Content-Type"), "audio/mpeg");
      assert.equal(headers.get("Content-Length"), "3");
      assert.equal(await new Response(init!.body).text(), "abc");
      return Response.json({ audioUrl: expected }, { status: 201, headers: { Location: expected } });
    };
    assert.equal(await client.upload(file, name), expected);
    await client.delete(name);
    assert.equal(calls, 2);
    for (const bad of [expected + "?sig=x", expected.replace("fixture.blob", "evil.blob"), expected.replace("mono", "other")]) {
      globalThis.fetch = async () => Response.json({ audioUrl: bad }, { status: 201, headers: { Location: bad } });
      await assert.rejects(client.upload(file, name), /unexpected audio URL/);
    }
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 502 }); };
    await assert.rejects(client.upload(file, name), /HTTP 502/);
    assert.equal(calls, 1);
    config.authMode = "azure-cli";
    await assert.rejects(storageGatewayHeaders(), /explicit certificate/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, original);
    await rm(dir, { recursive: true, force: true });
  }
});
