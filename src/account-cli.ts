import path from "node:path";
import { config } from "./config.js";
import { Accounts } from "./accounts.js";

function hiddenPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run bootstrap from an interactive terminal.");
  process.stdout.write(label);
  return new Promise((resolve, reject) => {
    const previousRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (data: Buffer) => {
      for (const character of data.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") {
          cleanup(); reject(new Error("Bootstrap cancelled.")); return;
        }
        if (character === "\r" || character === "\n") { cleanup(); resolve(value); return; }
        if (character === "\u007f" || character === "\b") value = [...value].slice(0, -1).join("");
        else if (character >= " " && value.length < 129) value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

const usage = `Usage:
  node dist/account-cli.js bootstrap --email you@example.com    create the first administrator (prompts for a password)
  node dist/account-cli.js invite --email friend@example.com    whitelist an email and print a one-use invitation link
  node dist/account-cli.js reset-link --email user@example.com  print a one-use password-reset link (works for the admin too)
  node dist/account-cli.js delete-user --email user@example.com remove a non-admin account that owns no sessions`;

async function main() {
  const args = process.argv.slice(2);
  // The original form "--email X" still means bootstrap.
  const [command, flag, email] = args[0] === "--email" ? ["bootstrap", ...args] : args;
  if (args.length !== (args[0] === "--email" ? 2 : 3) || flag !== "--email" || !email ||
    !["bootstrap", "invite", "reset-link", "delete-user"].includes(command ?? "")) {
    throw new Error(`Usage:\n${usage}`);
  }
  const accounts = new Accounts({
    databasePath: path.join(config.dataDir, "accounts.sqlite"),
    adminEmail: config.adminEmail || undefined,
    publicOrigin: config.publicOrigin || undefined,
    journalMode: config.sqliteJournalMode,
  });
  try {
    if (command === "bootstrap") {
      const password = await hiddenPassword("Administrator password (8–128 characters): ");
      const confirmation = await hiddenPassword("Confirm password: ");
      if (password !== confirmation) throw new Error("Passwords do not match.");
      await accounts.bootstrapAdministrator(email, password);
      process.stdout.write("Administrator created. Sign in through the application.\n");
    } else if (command === "invite" || command === "reset-link") {
      const link = command === "invite" ? accounts.operatorInvite(email) : accounts.operatorResetLink(email);
      process.stdout.write(`One-use link (expires ${link.expiresAt}). Share it privately:\n${link.url}\n`);
    } else {
      accounts.operatorDeleteUser(email);
      process.stdout.write("Account deleted.\n");
    }
  } finally { accounts.close(); }
}
// Never echo input, database errors, or credentials in bootstrap failure output.
void main().catch(error => {
  const message = error instanceof Error && (
    error.message.startsWith("Usage:") || error.message.startsWith("Run bootstrap") ||
    error.message.startsWith("An administrator") || error.message.startsWith("This email") ||
    error.message.startsWith("Email does not") || error.message === "Passwords do not match." ||
    error.message === "Bootstrap cancelled." || error.message.startsWith("Invitation is not") ||
    error.message.startsWith("No ") || error.message.startsWith("Administrator accounts") ||
    error.message.startsWith("This account") || error.message.startsWith("Set APP_PUBLIC_ORIGIN")
  ) ? error.message : "Account command failed. Check the email, password requirements, and account database permissions.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
