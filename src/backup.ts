import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Accounts } from "./accounts.js";

const KEEP = 14;

// Daily consistent copies of the accounts database (users, ownership, clip ranges). Recordings and
// transcripts are not copied, so deleting a session is not undone by a hidden backup of its content.
export class DailyBackups {
  private timer?: NodeJS.Timeout;
  constructor(private accounts: Accounts, private directory: string) {}

  start(intervalMs = 6 * 60 * 60_000) {
    void this.run();
    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async run(now = new Date()) {
    try {
      await mkdir(this.directory, { recursive: true });
      const name = `accounts-${now.toISOString().slice(0, 10)}.sqlite`;
      const existing = await readdir(this.directory);
      if (!existing.includes(name)) {
        const temporary = path.join(this.directory, `${name}.tmp`);
        await rm(temporary, { force: true });
        this.accounts.backupTo(temporary);
        await rename(temporary, path.join(this.directory, name));
      }
      const backups = (await readdir(this.directory)).filter(file => /^accounts-\d{4}-\d{2}-\d{2}\.sqlite$/.test(file)).sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - KEEP))) {
        await rm(path.join(this.directory, old), { force: true });
      }
    } catch (error) {
      console.error("Daily accounts backup failed:", error instanceof Error ? error.message : error);
    }
  }
}
