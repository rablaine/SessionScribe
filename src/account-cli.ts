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

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--email" || !args[1]) {
    throw new Error("Usage: npm run users:bootstrap -- --email administrator@example.com");
  }
  const accounts = new Accounts({
    databasePath: path.join(config.dataDir, "accounts.sqlite"),
    adminEmail: config.adminEmail || undefined,
    publicOrigin: config.publicOrigin || undefined,
  });
  try {
    const password = await hiddenPassword("Administrator password (8–128 characters): ");
    const confirmation = await hiddenPassword("Confirm password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    await accounts.bootstrapAdministrator(args[1], password);
    process.stdout.write("Administrator created. Sign in through the application.\n");
  } finally { accounts.close(); }
}

// Never echo input, database errors, or credentials in bootstrap failure output.
void main().catch(error => {
  const message = error instanceof Error && (
    error.message.startsWith("Usage:") || error.message.startsWith("Run bootstrap") ||
    error.message.startsWith("An administrator") || error.message.startsWith("This email") ||
    error.message.startsWith("Email does not") || error.message === "Passwords do not match." ||
    error.message === "Bootstrap cancelled."
  ) ? error.message : "Bootstrap failed. Check the email, password requirements, and account database permissions.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
