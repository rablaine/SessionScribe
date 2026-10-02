import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import express, { type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

export interface AccountUser {
  id: string;
  email: string;
  role: "admin" | "user";
  status: "pending" | "active" | "rejected" | "suspended";
  createdAt: string;
  verificationMethod: "invitation" | "manual" | null;
}

export interface AccountsOptions {
  databasePath: string;
  publicOrigin?: string;
  adminEmail?: string;
  journalMode?: "WAL" | "DELETE" | "TRUNCATE";
  // When false, only invitation links can create accounts; self-service access requests are refused.
  openSignup?: boolean;
  maxPendingAccounts?: number;
}

export type UsageKind = "upload" | "audio-ms" | "recap" | "laughter";

export interface AudioClip {
  id: string;
  jobId: string;
  name: string;
  startMs: number;
  endMs: number;
  createdAt: string;
}

type UserRow = AccountUser & { password: string };
type Session = { hash: string; csrf: string; user: AccountUser };
type LinkRow = { hash: string; email: string; userId: string | null; expiresAt: number; usedAt: number | null };
const LEGACY_COOKIE = "scribe_session";
// The __Host- prefix forbids Domain/insecure cookies, so a sibling subdomain cannot plant a session.
const SECURE_COOKIE = "__Host-scribe_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const DEVICE_MS = 180 * 24 * 60 * 60 * 1000;
const INVITE_MS = 72 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;
const GENERIC_SIGNUP = "If registration is available for this address, your request will be processed.";
const GENERIC_LOGIN = "Invalid email or password.";
const emailSchema = z.string().trim().toLowerCase().max(254).email();
const passwordSchema = z.string().min(8).max(128);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const credentialsSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();
const signupSchema = credentialsSchema.extend({ invitationToken: tokenSchema.optional() });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const safe = (row: UserRow | AccountUser): AccountUser => ({
  id: row.id, email: row.email, role: row.role, status: row.status,
  createdAt: row.createdAt, verificationMethod: row.verificationMethod,
});

class PublicError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export { PublicError as AccountError };

// Group IPv6 clients by /64 so one host cannot rotate through its whole allocation to evade limits.
export function clientKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const address = ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map(group => (group || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// This bound applies across Accounts instances, not just across requests on one router.
let kdfActive = 0;
const kdfQueue: Array<() => void> = [];
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (kdfActive >= 2) {
    if (kdfQueue.length >= 16) throw new PublicError(429, "Too many requests. Try again later.");
    await new Promise<void>(resolve => kdfQueue.push(resolve));
  } else {
    kdfActive++;
  }
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
        (error, key) => error ? reject(error) : resolve(key));
    });
  } finally {
    const next = kdfQueue.shift();
    if (next) next();
    else kdfActive--;
  }
}

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt-v1$32768$8$3$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function passwordMatches(password: string, encoded?: string): Promise<boolean> {
  const parts = encoded?.split("$");
  const valid = parts?.length === 6 && parts[0] === "scrypt-v1" &&
    parts[1] === "32768" && parts[2] === "8" && parts[3] === "3" &&
    /^[0-9a-f]{32}$/.test(parts[4]!) && /^[0-9a-f]{64}$/.test(parts[5]!);
  // A nonexistent or malformed account still performs the same expensive derivation.
  const salt = valid ? Buffer.from(parts![4]!, "hex") : Buffer.alloc(16);
  const expected = valid ? Buffer.from(parts![5]!, "hex") : Buffer.alloc(32);
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && !!valid;
}

function constantMatches(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length > 256) return false;
  return timingSafeEqual(Buffer.from(hash(actual), "hex"), Buffer.from(hash(expected), "hex"));
}

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export class Accounts {
  readonly router = express.Router();
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private readonly contexts = new WeakMap<Request, Session>();
  private readonly origin?: string;
  private readonly secure: boolean;
  private readonly cookie: string;
  private readonly deviceCookie: string;
  private readonly reservedEmail?: string;
  private readonly openSignup: boolean;
  private readonly maxPending: number;

  constructor(options: AccountsOptions) {
    if (options.publicOrigin) {
      const url = new URL(options.publicOrigin);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("APP_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only for loopback).");
      }
      this.origin = url.origin;
    }
    this.secure = this.origin?.startsWith("https:") ?? false;
    this.cookie = this.secure ? SECURE_COOKIE : LEGACY_COOKIE;
    this.deviceCookie = this.secure ? "__Host-scribe_device" : "scribe_device";
    this.openSignup = options.openSignup ?? true;
    this.maxPending = options.maxPendingAccounts ?? 25;
    this.reservedEmail = options.adminEmail ? emailSchema.parse(options.adminEmail) : undefined;
    mkdirSync(path.dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA journal_mode=${options.journalMode ?? "WAL"}; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;`);
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 5) { this.db.close(); throw new Error("Unsupported accounts database version."); }
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')),
        status TEXT NOT NULL CHECK(status IN ('pending','active','rejected','suspended')),
        createdAt TEXT NOT NULL,
        verificationMethod TEXT CHECK(verificationMethod IN ('invitation','manual'))
      );
      CREATE TABLE sessions (
        hash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf TEXT NOT NULL, expiresAt INTEGER NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(userId);
      CREATE TABLE whitelist (email TEXT PRIMARY KEY, createdAt TEXT NOT NULL);
      CREATE TABLE links (
        hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('invitation','reset')),
        email TEXT NOT NULL, userId TEXT REFERENCES users(id) ON DELETE CASCADE,
        expiresAt INTEGER NOT NULL, usedAt INTEGER
      );
      CREATE INDEX links_identity ON links(kind,email);
      CREATE TABLE job_owners (
        jobId TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY, createdAt INTEGER NOT NULL, actorId TEXT,
        event TEXT NOT NULL, subjectId TEXT
      );
      PRAGMA user_version=1;
      COMMIT;
    `);
    if (version < 2) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE audio_clips (
        id TEXT PRIMARY KEY,
        jobId TEXT NOT NULL REFERENCES job_owners(jobId) ON DELETE CASCADE,
        startMs INTEGER NOT NULL CHECK(startMs >= 0),
        endMs INTEGER NOT NULL CHECK(endMs > startMs),
        createdAt TEXT NOT NULL
      );
      CREATE INDEX audio_clips_job ON audio_clips(jobId,createdAt);
      PRAGMA user_version=2;
      COMMIT;
    `);
    if (version < 3) this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE audio_clips ADD COLUMN name TEXT NOT NULL DEFAULT '';
      PRAGMA user_version=3;
      COMMIT;
    `);
    if (version < 4) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, amount INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_user ON usage(userId,kind,createdAt);
      PRAGMA user_version=4;
      COMMIT;
    `);
    if (version < 5) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS devices (
        hash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expiresAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS devices_user ON devices(userId,expiresAt);
      PRAGMA user_version=5;
      COMMIT;
    `);
    this.routes();
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private get<T>(sql: string, ...values: SQLInputValue[]): T | undefined {
    return this.statement(sql).get(...values) as T | undefined;
  }
  private run(sql: string, ...values: SQLInputValue[]) { return this.statement(sql).run(...values); }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private audit(event: string, actorId: string | null, subjectId: string | null = null) {
    this.run("INSERT INTO audit(createdAt,actorId,event,subjectId) VALUES (?,?,?,?)",
      Date.now(), actorId, event, subjectId);
    this.run("DELETE FROM audit WHERE createdAt < ?", Date.now() - 90 * 24 * 60 * 60 * 1000);
  }
  private user(id: string) { return this.get<UserRow>("SELECT * FROM users WHERE id=?", id); }
  private emailUser(email: string) { return this.get<UserRow>("SELECT * FROM users WHERE email=?", email); }
  private setupRequired() { return !this.get("SELECT id FROM users WHERE role='admin' LIMIT 1"); }

  private rate(req: Request, scope: string, email?: string) {
    const limits = scope === "login" ? [40, 15 * 60 * 1000] :
      scope === "register" ? [20, 60 * 60 * 1000] :
      scope === "reset" ? [30, 60 * 60 * 1000] : [120, 60 * 1000];
    this.transaction(() => {
      this.run("DELETE FROM rate_limits WHERE expiresAt<=?", Date.now());
      this.hit(`${scope}:ip:${hash(clientKey(req.ip ?? req.socket.remoteAddress))}`, limits[0]!, limits[1]!);
      // Registration without an invitation is also limited per address; invitation tokens are unguessable.
      if (email) this.hit(`${scope}:email:${hash(email)}`, 8, limits[1]!);
    });
  }
  private hit(key: string, limit: number, windowMs: number) {
    const row = this.get<{ count: number }>("SELECT count FROM rate_limits WHERE key=? AND expiresAt>?", key, Date.now());
    if (row && row.count >= limit) throw new PublicError(429, "Too many requests. Try again later.");
    this.run(`INSERT INTO rate_limits(key,count,expiresAt) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1`, key, Date.now() + windowMs);
  }
  // Only failed sign-ins count against an address. Keying on address+client means an attacker
  // elsewhere cannot lock the real user out; the looser address-only bucket still caps distributed guessing.
  private loginFailureKeys(req: Request, email: string) {
    return [
      [`login-fail:${hash(`${email}|${clientKey(req.ip ?? req.socket.remoteAddress)}`)}`, 10, 15 * 60 * 1000],
      [`login-fail:${hash(email)}`, 50, 60 * 60 * 1000],
    ] as const;
  }
  // A browser that previously signed in to this account carries a device token. It is exempt from the
  // account-wide failure ceiling, so strangers hammering an email address cannot lock its owner out.
  private knownDevice(req: Request, userId: string | undefined): boolean {
    if (!userId) return false;
    const raw = (req.get("cookie") ?? "").split(";").map(value => value.trim())
      .find(value => value.startsWith(`${this.deviceCookie}=`))?.slice(this.deviceCookie.length + 1);
    if (!raw || !tokenSchema.safeParse(raw).success) return false;
    return !!this.get("SELECT hash FROM devices WHERE hash=? AND userId=? AND expiresAt>?", hash(raw), userId, Date.now());
  }
  private rememberDevice(res: Response, userId: string) {
    const raw = token();
    this.transaction(() => {
      this.run("DELETE FROM devices WHERE expiresAt<=?", Date.now());
      this.run("INSERT INTO devices(hash,userId,expiresAt) VALUES (?,?,?)", hash(raw), userId, Date.now() + DEVICE_MS);
      this.run(`DELETE FROM devices WHERE userId=? AND hash NOT IN
        (SELECT hash FROM devices WHERE userId=? ORDER BY expiresAt DESC LIMIT 20)`, userId, userId);
    });
    res.cookie(this.deviceCookie, raw, { httpOnly: true, sameSite: "strict", secure: this.secure, path: "/", maxAge: DEVICE_MS });
  }
  private checkLoginFailures(req: Request, email: string, knownDevice = false) {
    for (const [key, limit] of this.loginFailureKeys(req, email).slice(0, knownDevice ? 1 : 2)) {
      const row = this.get<{ count: number }>("SELECT count FROM rate_limits WHERE key=? AND expiresAt>?", key, Date.now());
      if (row && row.count >= limit) throw new PublicError(429, "Too many requests. Try again later.");
    }
  }
  private recordLoginFailure(req: Request, email: string) {
    this.transaction(() => {
      for (const [key, , windowMs] of this.loginFailureKeys(req, email)) {
        this.run(`INSERT INTO rate_limits(key,count,expiresAt) VALUES (?,1,?)
          ON CONFLICT(key) DO UPDATE SET count=count+1`, key, Date.now() + windowMs);
      }
    });
  }

  private requestOrigin(req: Request): string {
    if (this.origin) return this.origin;
    let url: URL;
    try { url = new URL(`http://${req.get("host")}`); }
    catch { throw new PublicError(403, "Request not allowed."); }
    if (!loopback(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new PublicError(403, "Request not allowed.");
    }
    return url.origin;
  }

  private csrf(req: Request) {
    const context = this.contexts.get(req);
    if (context && !constantMatches(req.get("X-CSRF-Token"), context.csrf)) {
      throw new PublicError(403, "Request not allowed.");
    }
  }

  sessionMiddleware: RequestHandler = (req, res, next) => {
    try {
      const cookies = (req.get("cookie") ?? "").split(";").map(value => value.trim());
      const raw = cookies.find(value => value.startsWith(`${this.cookie}=`))?.slice(this.cookie.length + 1);
      if (raw && tokenSchema.safeParse(raw).success) {
        const session = this.get<{ hash: string; csrf: string; userId: string }>(
          "SELECT hash,csrf,userId FROM sessions WHERE hash=? AND expiresAt>?", hash(raw), Date.now());
        const user = session ? this.user(session.userId) : undefined;
        if (session && user && (user.status === "active" || user.status === "pending")) {
          this.contexts.set(req, { hash: session.hash, csrf: session.csrf, user: safe(user) });
        } else {
          this.clearCookie(res);
        }
      }
      next();
    } catch (error) { next(error); }
  };

  requireActive: RequestHandler = (req, res, next) => {
    const context = this.contexts.get(req);
    if (!context) { res.status(401).json({ error: "Authentication required." }); return; }
    if (context.user.status !== "active") { res.status(403).json({ error: "Account approval required." }); return; }
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) this.csrf(req);
      next();
    } catch { res.status(403).json({ error: "Request not allowed." }); }
  };

  userId(req: Request): string {
    const context = this.contexts.get(req);
    if (!context) throw new PublicError(401, "Authentication required.");
    return context.user.id;
  }
  ownsJob(userId: string, jobId: string): boolean {
    return !!this.get("SELECT jobId FROM job_owners WHERE jobId=? AND userId=?", jobId, userId);
  }
  jobOwner(jobId: string): string | undefined {
    return this.get<{ userId: string }>("SELECT userId FROM job_owners WHERE jobId=?", jobId)?.userId;
  }
  isActiveUser(userId: string): boolean {
    return this.user(userId)?.status === "active";
  }
  assignJob(jobId: string, userId: string): void {
    this.transaction(() => {
      const user = this.user(userId);
      if (!user || user.status !== "active") throw new PublicError(403, "Account approval required.");
      const owner = this.get<{ userId: string }>("SELECT userId FROM job_owners WHERE jobId=?", jobId);
      if (owner && owner.userId !== userId) throw new Error("Job already has an owner.");
      this.run("INSERT OR IGNORE INTO job_owners(jobId,userId) VALUES (?,?)", jobId, userId);
      if (!owner) this.audit("job.assigned", userId, jobId);
    });
  }
  releaseJob(jobId: string): void {
    this.transaction(() => {
      const owner = this.get<{ userId: string }>("SELECT userId FROM job_owners WHERE jobId=?", jobId);
      this.run("DELETE FROM job_owners WHERE jobId=?", jobId);
      if (owner) this.audit("job.released", owner.userId, jobId);
    });
  }

  listClips(jobId: string): AudioClip[] {
    return this.statement("SELECT * FROM audio_clips WHERE jobId=? ORDER BY createdAt,id").all(jobId).map(row => ({
      id: String(row.id), jobId: String(row.jobId), name: String(row.name), startMs: Number(row.startMs),
      endMs: Number(row.endMs), createdAt: String(row.createdAt),
    }));
  }
  clip(jobId: string, id: string): AudioClip | undefined {
    return this.get<AudioClip>("SELECT * FROM audio_clips WHERE jobId=? AND id=?", jobId, id);
  }
  saveClip(jobId: string, startMs: number, endMs: number, id?: string, name?: string): AudioClip {
    if (id) {
      this.run("UPDATE audio_clips SET startMs=?,endMs=?,name=COALESCE(?,name) WHERE jobId=? AND id=?",
        startMs, endMs, name ?? null, jobId, id);
      const updated = this.clip(jobId, id);
      if (!updated) throw new Error("Clip not found.");
      return updated;
    }
    const clip: AudioClip = { id: randomUUID(), jobId, name: name ?? "", startMs, endMs, createdAt: new Date().toISOString() };
    this.run("INSERT INTO audio_clips(id,jobId,name,startMs,endMs,createdAt) VALUES (?,?,?,?,?,?)",
      clip.id, jobId, clip.name, startMs, endMs, clip.createdAt);
    return clip;
  }
  close(): void { this.db.close(); }

  // Consistent online copy for backups; works in WAL and rollback-journal modes.
  backupTo(file: string): void {
    this.db.prepare("VACUUM INTO ?").run(file);
  }

  // Operator commands (run inside the server environment via the account CLI, never over HTTP).
  private operatorOrigin(): string {
    if (!this.origin) throw new Error("Set APP_PUBLIC_ORIGIN so the link points at the right host.");
    return this.origin;
  }
  // Creates the first administrator with an unguessable random password and returns a one-use link
  // for them to choose their own, so no password is ever typed into a remote shell.
  async operatorBootstrapLink(rawEmail: string): Promise<{ url: string; expiresAt: string }> {
    const email = emailSchema.parse(rawEmail);
    this.operatorOrigin();
    await this.bootstrapAdministrator(email, token());
    return this.operatorResetLink(email, 24 * 60 * 60 * 1000);
  }
  operatorInvite(rawEmail: string): { url: string; expiresAt: string } {
    const email = emailSchema.parse(rawEmail);
    const origin = this.operatorOrigin(), raw = token(), expiresAt = Date.now() + INVITE_MS;
    this.transaction(() => {
      const user = this.emailUser(email);
      if (email === this.reservedEmail || (user && (user.role === "admin" || user.status !== "pending"))) {
        throw new Error("Invitation is not available for this address (it is reserved or already active).");
      }
      this.run("INSERT OR IGNORE INTO whitelist(email,createdAt) VALUES (?,?)", email, new Date().toISOString());
      this.run("UPDATE links SET usedAt=? WHERE kind='invitation' AND email=? AND usedAt IS NULL", Date.now(), email);
      this.run("INSERT INTO links(hash,kind,email,expiresAt) VALUES (?,'invitation',?,?)", hash(raw), email, expiresAt);
      this.audit("invitation.issued-by-operator", null, user?.id ?? null);
    });
    return { url: `${origin}/#invite=${raw}&email=${encodeURIComponent(email)}`, expiresAt: new Date(expiresAt).toISOString() };
  }
  operatorResetLink(rawEmail: string, lifetimeMs = RESET_MS): { url: string; expiresAt: string } {
    const email = emailSchema.parse(rawEmail);
    const origin = this.operatorOrigin(), raw = token(), expiresAt = Date.now() + lifetimeMs;
    this.transaction(() => {
      const user = this.emailUser(email);
      if (!user || !["active", "pending"].includes(user.status)) throw new Error("No active or pending account uses this email.");
      this.run("UPDATE links SET usedAt=? WHERE kind='reset' AND userId=? AND usedAt IS NULL", Date.now(), user.id);
      this.run("INSERT INTO links(hash,kind,email,userId,expiresAt) VALUES (?,'reset',?,?,?)", hash(raw), user.email, user.id, expiresAt);
      this.audit("reset.issued-by-operator", null, user.id);
    });
    return { url: `${origin}/#reset=${raw}`, expiresAt: new Date(expiresAt).toISOString() };
  }
  operatorDeleteUser(rawEmail: string): void {
    const email = emailSchema.parse(rawEmail);
    this.transaction(() => {
      const user = this.emailUser(email);
      if (!user) throw new Error("No account uses this email.");
      if (user.role === "admin") throw new Error("Administrator accounts cannot be deleted with this command.");
      if (this.get("SELECT jobId FROM job_owners WHERE userId=? LIMIT 1", user.id)) {
        throw new Error("This account still owns sessions. Delete them in the app first.");
      }
      this.run("DELETE FROM users WHERE id=?", user.id);
      this.run("DELETE FROM whitelist WHERE email=?", email);
      this.run("DELETE FROM links WHERE email=?", email);
      this.audit("user.deleted-by-operator", null, user.id);
    });
  }

  usageSince(userId: string, kind: UsageKind, sinceMs: number): number {
    return Number(this.get<{ total: number | null }>(
      "SELECT SUM(amount) AS total FROM usage WHERE userId=? AND kind=? AND createdAt>?", userId, kind, sinceMs)?.total ?? 0);
  }
  // Atomically checks a rolling 24-hour allowance and records the new usage when it fits.
  consumeQuota(userId: string, kind: UsageKind, amount: number, limit: number, message: string): void {
    this.transaction(() => {
      const now = Date.now();
      this.run("DELETE FROM usage WHERE createdAt < ?", now - 2 * 24 * 60 * 60 * 1000);
      if (this.usageSince(userId, kind, now - 24 * 60 * 60 * 1000) + amount > limit) throw new PublicError(429, message);
      this.run("INSERT INTO usage(userId,kind,amount,createdAt) VALUES (?,?,?,?)", userId, kind, Math.round(amount), now);
    });
  }

  async bootstrapAdministrator(email: string, password: string): Promise<AccountUser> {
    email = emailSchema.parse(email);
    passwordSchema.parse(password);
    if (this.reservedEmail && email !== this.reservedEmail) throw new Error("Email does not match APP_ADMIN_EMAIL reservation.");
    if (!this.setupRequired()) throw new Error("An administrator already exists. Bootstrap is disabled.");
    const encoded = await passwordHash(password);
    return this.transaction(() => {
      if (!this.setupRequired()) throw new Error("An administrator already exists. Bootstrap is disabled.");
      if (this.emailUser(email)) throw new Error("This email is already registered. Choose an unused administrator email.");
      const user: AccountUser = {
        id: randomUUID(), email, role: "admin", status: "active",
        createdAt: new Date().toISOString(), verificationMethod: "manual",
      };
      this.insertUser(user, encoded);
      this.audit("admin.bootstrap", user.id, user.id);
      return user;
    });
  }

  private insertUser(user: AccountUser, password: string) {
    this.run("INSERT INTO users(id,email,password,role,status,createdAt,verificationMethod) VALUES (?,?,?,?,?,?,?)",
      user.id, user.email, password, user.role, user.status, user.createdAt, user.verificationMethod);
  }
  private clearCookie(res: Response) {
    res.clearCookie(this.cookie, { httpOnly: true, sameSite: "strict", secure: this.secure, path: "/" });
  }
  private issueSession(req: Request, res: Response, user: AccountUser) {
    const raw = token(), csrfToken = token();
    this.transaction(() => {
      const old = this.contexts.get(req);
      if (old) this.run("DELETE FROM sessions WHERE hash=?", old.hash);
      this.run("DELETE FROM sessions WHERE expiresAt<=?", Date.now());
      this.run("INSERT INTO sessions(hash,userId,csrf,expiresAt) VALUES (?,?,?,?)",
        hash(raw), user.id, csrfToken, Date.now() + SESSION_MS);
      this.audit("auth.session-issued", user.id);
    });
    res.cookie(this.cookie, raw, { httpOnly: true, sameSite: "strict", secure: this.secure, path: "/", maxAge: SESSION_MS });
    return { user: safe(user), csrfToken };
  }

  private routes() {
    this.router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
    this.router.use(this.sessionMiddleware);
    this.router.use((req, _res, next) => {
      try {
        if (!/^\/(?:auth|admin)(?:\/|$)/i.test(req.path)) { next(); return; }
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
          const origin = req.get("origin");
          if ((origin && origin !== this.requestOrigin(req)) || req.get("sec-fetch-site") === "cross-site") {
            throw new PublicError(403, "Request not allowed.");
          }
          this.csrf(req);
          if (req.method !== "DELETE" && !req.is("application/json")) {
            throw new PublicError(415, "Content-Type must be application/json.");
          }
        }
        next();
      } catch (error) { next(error); }
    });
    this.router.use(["/auth", "/admin"], express.json({ limit: "16kb" }));
    this.router.get("/auth/session", (req, res) => {
      const session = this.contexts.get(req);
      res.set("Cache-Control", "no-store").json({
        user: session?.user ?? null, csrfToken: session?.csrf ?? null, setupRequired: this.setupRequired(),
        openSignup: this.openSignup,
      });
    });
    this.router.post("/auth/login", async (req, res) => {
      const parsed = credentialsSchema.safeParse(req.body);
      this.rate(req, "login");
      if (!parsed.success) throw new PublicError(401, GENERIC_LOGIN);
      const { email, password } = parsed.data;
      const user = this.emailUser(email);
      this.checkLoginFailures(req, email, this.knownDevice(req, user?.id));
      const matches = await passwordMatches(password, user?.password);
      // Re-read after the asynchronous KDF: reset/suspension may have happened in flight.
      const current = user ? this.user(user.id) : undefined;
      if (!matches || !current || current.password !== user!.password ||
        !["active", "pending"].includes(current.status)) {
        this.recordLoginFailure(req, email);
        throw new PublicError(401, GENERIC_LOGIN);
      }
      const session = this.issueSession(req, res, current);
      if (!this.knownDevice(req, current.id)) this.rememberDevice(res, current.id);
      res.json(session);
    });
    this.router.post("/auth/register", async (req, res) => {
      const parsed = signupSchema.safeParse(req.body);
      const invited = parsed.success && !!parsed.data.invitationToken;
      if (parsed.success && !invited && !this.openSignup) {
        throw new PublicError(403, "Access is by invitation only. Ask the administrator for an invitation link.");
      }
      this.rate(req, "register", parsed.success && !invited ? parsed.data.email : undefined);
      if (!parsed.success) throw new PublicError(400, "Invalid registration details.");
      const { email, password, invitationToken } = parsed.data;
      const encoded = await passwordHash(password);
      const user = this.transaction(() => {
        const existing = this.emailUser(email);
        if (email === this.reservedEmail || existing?.role === "admin") {
          if (invitationToken) throw new PublicError(400, "Invalid or expired invitation.");
          return null;
        }
        if (invitationToken) {
          const invitation = this.get<LinkRow>("SELECT * FROM links WHERE hash=? AND kind='invitation'", hash(invitationToken));
          if (!invitation || invitation.email !== email || invitation.usedAt !== null ||
            invitation.expiresAt <= Date.now() || (existing && existing.status !== "pending")) {
            throw new PublicError(400, "Invalid or expired invitation.");
          }
          this.run("UPDATE links SET usedAt=? WHERE hash=? AND usedAt IS NULL", Date.now(), invitation.hash);
          if (existing) {
            this.run("UPDATE users SET password=?,status='active',verificationMethod='invitation' WHERE id=?", encoded, existing.id);
            this.run("DELETE FROM sessions WHERE userId=?", existing.id);
            this.audit("user.invitation-accepted", existing.id, existing.id);
            return safe(this.user(existing.id)!);
          }
        } else if (existing) {
          return null;
        }
        if (!invitationToken &&
          (this.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE status='pending'")?.n ?? 0) >= this.maxPending) {
          // Bounded queue of self-service requests: excess requests get the same generic response.
          return null;
        }
        const created: AccountUser = {
          id: randomUUID(), email, role: "user", status: invitationToken ? "active" : "pending",
          createdAt: new Date().toISOString(), verificationMethod: invitationToken ? "invitation" : null,
        };
        this.insertUser(created, encoded);
        this.audit(invitationToken ? "user.invitation-accepted" : "user.registered", created.id, created.id);
        return created;
      });
      if (!user) { res.status(202).json({ message: GENERIC_SIGNUP }); return; }
      res.status(202).json({ ...this.issueSession(req, res, user), message: GENERIC_SIGNUP });
    });
    this.router.post("/auth/logout", (req, res) => {
      const session = this.contexts.get(req);
      if (!session) throw new PublicError(401, "Authentication required.");
      this.transaction(() => {
        this.run("DELETE FROM sessions WHERE hash=?", session.hash);
        this.audit("auth.logout", session.user.id);
      });
      this.clearCookie(res);
      res.sendStatus(204);
    });
    this.router.post("/auth/reset", async (req, res) => {
      const parsed = z.object({ token: tokenSchema, password: passwordSchema }).strict().safeParse(req.body);
      this.rate(req, "reset");
      if (!parsed.success) throw new PublicError(400, "Invalid or expired reset link.");
      const encoded = await passwordHash(parsed.data.password);
      this.transaction(() => {
        const link = this.get<LinkRow>("SELECT * FROM links WHERE hash=? AND kind='reset'", hash(parsed.data.token));
        const user = link?.userId ? this.user(link.userId) : undefined;
        if (!link || link.usedAt !== null || link.expiresAt <= Date.now() || !user ||
          !["active", "pending"].includes(user.status)) throw new PublicError(400, "Invalid or expired reset link.");
        this.run("UPDATE links SET usedAt=? WHERE hash=? AND usedAt IS NULL", Date.now(), link.hash);
        this.run("UPDATE users SET password=? WHERE id=?", encoded, user.id);
        this.run("DELETE FROM sessions WHERE userId=?", user.id);
        this.run("UPDATE links SET usedAt=? WHERE kind='reset' AND userId=? AND usedAt IS NULL", Date.now(), user.id);
        this.audit("auth.password-reset", user.id);
      });
      this.clearCookie(res);
      res.json({ message: "Password updated. Sign in with your new password." });
    });
    this.router.use("/admin", this.requireActive, (req, _res, next) => {
      if (this.contexts.get(req)?.user.role !== "admin") { next(new PublicError(403, "Administrator access required.")); return; }
      try { this.rate(req, "admin"); next(); } catch (error) { next(error); }
    });
    this.router.get("/admin/users", (_req, res) => {
      const rows = this.statement("SELECT id,email,role,status,createdAt,verificationMethod FROM users ORDER BY createdAt,id").all();
      res.json({ users: rows });
    });
    this.router.patch("/admin/users/:id", (req, res) => {
      const input = z.object({
        status: z.enum(["active", "rejected", "suspended"]), confirmedIdentity: z.literal(true).optional(),
      }).strict().safeParse(req.body);
      if (!input.success) throw new PublicError(400, "Invalid account update.");
      const user = this.transaction(() => {
        const user = this.user(String(req.params.id));
        if (!user) throw new PublicError(404, "Account not found.");
        if (user.role === "admin") throw new PublicError(403, "Administrator accounts cannot be modified here.");
        if (input.data.status === "active" && user.status !== "active" && !input.data.confirmedIdentity) {
          throw new PublicError(400, "Identity confirmation is required.");
        }
        this.run("UPDATE users SET status=?,verificationMethod=CASE WHEN ?='active' AND verificationMethod IS NULL THEN 'manual' ELSE verificationMethod END WHERE id=?",
          input.data.status, input.data.status, user.id);
        if (input.data.status !== "active") {
          this.run("DELETE FROM sessions WHERE userId=?", user.id);
          this.run("UPDATE links SET usedAt=? WHERE (userId=? OR email=?) AND usedAt IS NULL", Date.now(), user.id, user.email);
        }
        this.audit(`user.${input.data.status}`, this.userId(req), user.id);
        return safe(this.user(user.id)!);
      });
      res.json({ user });
    });
    this.router.get("/admin/whitelist", (_req, res) => {
      res.json({ entries: this.statement("SELECT email,createdAt FROM whitelist ORDER BY email").all() });
    });
    this.router.post("/admin/whitelist", (req, res) => {
      const input = z.object({ email: emailSchema }).strict().safeParse(req.body);
      if (!input.success) throw new PublicError(400, "Invalid email.");
      const entry = this.transaction(() => {
        this.run("INSERT OR IGNORE INTO whitelist(email,createdAt) VALUES (?,?)", input.data.email, new Date().toISOString());
        this.audit("whitelist.added", this.userId(req));
        return this.get<{ email: string; createdAt: string }>("SELECT * FROM whitelist WHERE email=?", input.data.email)!;
      });
      res.json({ entry });
    });
    this.router.delete("/admin/whitelist/:email", (req, res) => {
      const email = emailSchema.safeParse(req.params.email);
      if (!email.success) throw new PublicError(400, "Invalid email.");
      this.transaction(() => {
        this.run("DELETE FROM whitelist WHERE email=?", email.data);
        this.run("UPDATE links SET usedAt=? WHERE kind='invitation' AND email=? AND usedAt IS NULL", Date.now(), email.data);
        this.audit("whitelist.removed", this.userId(req));
      });
      res.sendStatus(204);
    });
    this.router.post("/admin/invitations", (req, res) => {
      const input = z.object({ email: emailSchema }).strict().safeParse(req.body);
      if (!input.success) throw new PublicError(400, "Invalid invitation details.");
      const origin = this.requestOrigin(req);
      const raw = token(), expiresAt = Date.now() + INVITE_MS;
      this.transaction(() => {
        const user = this.emailUser(input.data.email);
        if (!this.get("SELECT email FROM whitelist WHERE email=?", input.data.email) ||
          input.data.email === this.reservedEmail || (user && (user.role === "admin" || user.status !== "pending"))) {
          throw new PublicError(400, "Invitation is not available for this address.");
        }
        this.run("UPDATE links SET usedAt=? WHERE kind='invitation' AND email=? AND usedAt IS NULL", Date.now(), input.data.email);
        this.run("INSERT INTO links(hash,kind,email,expiresAt) VALUES (?,'invitation',?,?)", hash(raw), input.data.email, expiresAt);
        this.audit("invitation.issued", this.userId(req), user?.id ?? null);
      });
      res.json({ url: `${origin}/#invite=${raw}&email=${encodeURIComponent(input.data.email)}`, expiresAt: new Date(expiresAt).toISOString() });
    });
    this.router.post("/admin/users/:id/reset-link", (req, res) => {
      if (!z.object({}).strict().safeParse(req.body).success) throw new PublicError(400, "Invalid reset request.");
      const origin = this.requestOrigin(req), raw = token(), expiresAt = Date.now() + RESET_MS;
      this.transaction(() => {
        const user = this.user(String(req.params.id));
        if (!user) throw new PublicError(404, "Account not found.");
        if (!["active", "pending"].includes(user.status)) throw new PublicError(400, "Reset is unavailable for this account.");
        this.run("UPDATE links SET usedAt=? WHERE kind='reset' AND userId=? AND usedAt IS NULL", Date.now(), user.id);
        this.run("INSERT INTO links(hash,kind,email,userId,expiresAt) VALUES (?,'reset',?,?,?)", hash(raw), user.email, user.id, expiresAt);
        this.audit("reset.issued", this.userId(req), user.id);
      });
      res.json({ url: `${origin}/#reset=${raw}`, expiresAt: new Date(expiresAt).toISOString() });
    });
    this.router.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
      const status = error instanceof PublicError ? error.status :
        error instanceof SyntaxError ? 400 : (error as { type?: string })?.type === "entity.too.large" ? 413 : 500;
      res.status(status).json({ error: error instanceof PublicError ? error.message :
        status === 400 ? "Invalid JSON." : status === 413 ? "Request too large." : "Account operation failed." });
    });
  }
}
