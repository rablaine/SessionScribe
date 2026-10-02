import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { createGatewayServer, createUploadLimiter, GatewayError, type GatewayOptions, type GatewayStorage } from "../src/gateway.js";
import { maxGatewayBytes } from "../src/storage-contract.js";

const options: GatewayOptions = {
  tenantId: "tenant", audience: "audience", callerClientId: "caller", callerObjectId: "object",
  storageAccountUrl: "https://fixture.blob.core.windows.net", storageContainer: "dnd-audio",
};
const blobName = "12345678-1234-4234-8234-123456789abc/mono.mp3";
const validClaims = {
  iss: "https://login.microsoftonline.com/tenant/v2.0", aud: "audience",
  roles: ["Audio.Manage"], azp: "caller", oid: "object",
};

async function fixture(storage: GatewayStorage, claims = validClaims) {
  const server = createGatewayServer(options, storage, async token => {
    if (token !== "fixture") throw new Error("Invalid signature");
    return claims;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

function fakeStorage() {
  const calls: string[] = [];
  const storage: GatewayStorage = {
    async upload(name, body) {
      calls.push(`upload:${name}`);
      let bytes = 0;
      for await (const chunk of body) bytes += chunk.length;
      assert.equal(bytes, 3);
    },
    async delete(name) { calls.push(`delete:${name}`); },
    async probe() { calls.push("probe"); },
  };
  return { calls, storage };
}
const authorization = { Authorization: "Bearer fixture" };

test("gateway authenticates all endpoints before body/storage and rejects claims", async () => {
  for (const [claims, expected] of [
    [{ ...validClaims, roles: [] }, 403],
    [{ ...validClaims, azp: "wrong" }, 403],
    [{ ...validClaims, oid: "wrong" }, 403],
    [{ ...validClaims, aud: "wrong" }, 401],
    [{ ...validClaims, iss: "wrong" }, 401],
  ] as const) {
    const fake = fakeStorage();
    const gateway = await fixture(fake.storage, claims as typeof validClaims);
    try {
      assert.equal((await fetch(`${gateway.url}/audio/${blobName}`, {
        method: "PUT", headers: { ...authorization, "Content-Type": "audio/mpeg" }, body: "abc",
      })).status, expected);
      assert.deepEqual(fake.calls, []);
    } finally { await gateway.close(); }
  }
  const fake = fakeStorage();
  const gateway = await fixture(fake.storage);
  try {
    for (const path of ["/health", `/audio/${blobName}`]) {
      assert.equal((await fetch(gateway.url + path)).status, 401);
    }
    assert.equal((await fetch(`${gateway.url}/health`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${gateway.url}/health`, { headers: {
      "X-MS-CLIENT-PRINCIPAL-ID": "object", "X-MS-CLIENT-PRINCIPAL-NAME": "caller",
    } })).status, 401);
    assert.deepEqual(fake.calls, []);
  } finally { await gateway.close(); }
});

test("Expect 100-continue is only sent after successful authentication", async () => {
  const fake = fakeStorage();
  const gateway = await fixture(fake.storage);
  try {
    const outcome = await new Promise<{ status: number; continued: boolean }>((resolve, reject) => {
      let continued = false;
      const req = request(`${gateway.url}/audio/${blobName}`, {
        method: "PUT", headers: { Expect: "100-continue", "Content-Type": "audio/mpeg", "Content-Length": "3" },
      }, res => { res.resume(); resolve({ status: res.statusCode!, continued }); });
      req.on("continue", () => { continued = true; req.end("abc"); });
      req.on("error", reject);
      req.flushHeaders();
    });
    assert.deepEqual(outcome, { status: 401, continued: false });
    assert.deepEqual(fake.calls, []);
  } finally { await gateway.close(); }
});

test("disconnect aborts an active storage stream and cleans partial audio", async () => {
  let started!: () => void;
  let cleaned!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const cleanup = new Promise<void>(resolve => { cleaned = resolve; });
  let signal: AbortSignal | undefined;
  const storage: GatewayStorage = {
    async upload(_name, body, abortSignal) {
      signal = abortSignal;
      started();
      for await (const _chunk of body) { /* wait for disconnect */ }
    },
    async delete(name) { assert.equal(name, blobName); cleaned(); },
    async probe() {},
  };
  const gateway = await fixture(storage);
  try {
    const req = request(`${gateway.url}/audio/${blobName}`, {
      method: "PUT", headers: { ...authorization, "Content-Type": "audio/mpeg", "Content-Length": "100" },
    });
    req.on("error", () => { /* expected connection reset in this fixture */ });
    req.write("abc");
    await start;
    req.destroy();
    await cleanup;
    assert.equal(signal?.aborted, true);
  } finally { await gateway.close(); }
});

test("gateway upload, idempotent delete, and real authenticated container probe", async () => {
  const fake = fakeStorage();
  const gateway = await fixture(fake.storage);
  try {
    const response = await fetch(`${gateway.url}/audio/${blobName}`, {
      method: "PUT", headers: { ...authorization, "Content-Type": "audio/mpeg" }, body: "abc",
    });
    const expected = `${options.storageAccountUrl}/${options.storageContainer}/${blobName}`;
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Location"), expected);
    assert.deepEqual(await response.json(), { audioUrl: expected });
    for (let i = 0; i < 2; i++) {
      assert.equal((await fetch(`${gateway.url}/audio/${blobName}`, { method: "DELETE", headers: authorization })).status, 204);
    }
    assert.equal((await fetch(`${gateway.url}/health`, { headers: authorization })).status, 204);
    assert.deepEqual(fake.calls, [`upload:${blobName}`, `delete:${blobName}`, `delete:${blobName}`, "probe"]);
  } finally { await gateway.close(); }
});

test("gateway rejects invalid paths, content types, missing length and oversized declarations", async () => {
  const fake = fakeStorage();
  const gateway = await fixture(fake.storage);
  try {
    for (const name of ["../mono.mp3", "%2e%2e/mono.mp3", blobName + "?url=elsewhere", blobName.replace("/", "%2F"), "not-a-uuid/mono.mp3", blobName.replace("mono", "other")]) {
      assert.equal((await fetch(`${gateway.url}/audio/${name}`, { method: "DELETE", headers: authorization })).status, 400);
    }
    assert.equal((await fetch(`${gateway.url}/audio/${blobName}`, {
      method: "PUT", headers: authorization, body: "abc",
    })).status, 400);
    const rawStatus = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const req = request(`${gateway.url}/audio/${blobName}`, { method: "PUT", headers: { ...authorization, "Content-Type": "audio/mpeg", ...headers } },
        res => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.flushHeaders();
    });
    assert.equal(await rawStatus({ "Transfer-Encoding": "chunked" }), 400);
    assert.equal(await rawStatus({ "Content-Length": String(maxGatewayBytes + 1) }), 413);
    assert.deepEqual(fake.calls, []);
  } finally { await gateway.close(); }
});

test("stream limiter counts actual bytes, bounds 128 MiB, and detects length mismatch", async () => {
  const sink = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const chunk = Buffer.alloc(1024 * 1024);
  await assert.rejects(pipeline(
    Readable.from((function* () { for (let i = 0; i < 129; i++) yield chunk; })()),
    createUploadLimiter(maxGatewayBytes), sink(),
  ), (error: unknown) => error instanceof GatewayError && error.status === 413);
  await assert.rejects(pipeline(Readable.from(["abcd"]), createUploadLimiter(3), sink()), /Content-Length/);
  await assert.rejects(pipeline(Readable.from(["ab"]), createUploadLimiter(3), sink()), /Content-Length/);
});

test("gateway cleans failed uploads, hides storage errors, and probes actual health failures", async () => {
  const fake = fakeStorage();
  fake.storage.upload = async (_name, body) => {
    for await (const _chunk of body) { /* consume stream before failing */ }
    throw new Error("secret internal storage detail");
  };
  fake.storage.probe = async () => { throw new Error("container unavailable"); };
  const gateway = await fixture(fake.storage);
  try {
    const response = await fetch(`${gateway.url}/audio/${blobName}`, {
      method: "PUT", headers: { ...authorization, "Content-Type": "audio/mpeg" }, body: "abc",
    });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /secret/);
    assert.deepEqual(fake.calls, [`delete:${blobName}`]);
    assert.equal((await fetch(`${gateway.url}/health`, { headers: authorization })).status, 502);
  } finally { await gateway.close(); }
});

test("gateway limits concurrent transfers to two", async () => {
  let entered = 0;
  let release!: () => void;
  let ready!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const bothEntered = new Promise<void>(resolve => { ready = resolve; });
  const fake = fakeStorage();
  fake.storage.upload = async (_name, body) => {
    for await (const _chunk of body) { /* consume before holding transfer */ }
    if (++entered === 2) ready();
    await wait;
  };
  const gateway = await fixture(fake.storage);
  const put = () => fetch(`${gateway.url}/audio/${blobName}`, {
    method: "PUT", headers: { ...authorization, "Content-Type": "audio/mpeg" }, body: "abc",
  });
  try {
    const first = put();
    const second = put();
    await bothEntered;
    assert.equal((await put()).status, 429);
    release();
    assert.equal((await first).status, 201);
    assert.equal((await second).status, 201);
  } finally { release(); await gateway.close(); }
});
