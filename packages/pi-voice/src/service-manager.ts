import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TalkdClient } from "./talkd-client";

export interface ServiceHandle {
  started: boolean;
  reused: boolean;
  logPath: string;
}

let ensurePromise: Promise<ServiceHandle> | undefined;

export function defaultTalkdHome(): string {
  return process.env.TALKD_HOME ?? join(homedir(), ".talkd");
}

export function defaultSocketPath(): string {
  return process.env.TALKD_SOCK ?? join(defaultTalkdHome(), "talkd.sock");
}

export function ensureTalkdServiceInBackground(socketPath = defaultSocketPath()): Promise<ServiceHandle> {
  ensurePromise ??= ensureTalkdService(socketPath).finally(() => {
    // Coalesce concurrent startup attempts, then allow later calls to re-check
    // or retry after service shutdown/failure.
    ensurePromise = undefined;
  });
  return ensurePromise;
}

export async function ensureTalkdService(socketPath = defaultSocketPath()): Promise<ServiceHandle> {
  const logPath = process.env.TALKD_SERVICE_LOG ?? "/tmp/talkd-pi-voice-service.log";
  const client = new TalkdClient(socketPath);
  if (await canPing(client)) return { started: false, reused: true, logPath };

  const command = await resolveServiceCommand(socketPath, logPath);
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env: serviceEnv(),
  });
  child.unref();
  closeSync(logFd);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (await canPing(client)) return { started: true, reused: false, logPath };
    if (child.exitCode !== null) throw new Error(`talkd-service exited during startup. See ${logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for talkd-service. See ${logPath}`);
}

async function resolveServiceCommand(socketPath: string, logPath: string): Promise<{ command: string; args: string[]; cwd: string }> {
  const custom = process.env.TALKD_SERVICE_CMD;
  if (custom) return { command: "sh", args: ["-lc", custom], cwd: process.cwd() };

  const installed = join(defaultTalkdHome(), "bin", "talkd-service");
  if (existsSync(installed)) return { command: installed, args: ["--sock", socketPath], cwd: process.cwd() };

  await runPackageSetup(logPath);
  if (existsSync(installed)) return { command: installed, args: ["--sock", socketPath], cwd: process.cwd() };

  const repoRoot = findRepoRoot();
  if (repoRoot) {
    const local = join(repoRoot, "talkd-service", "bin", "talkd-service");
    if (existsSync(local)) return { command: local, args: ["--sock", socketPath], cwd: join(repoRoot, "talkd-service") };

    // Useful for local development if the binary has not been built yet. This is
    // only reached from the background ensure path, so Go compilation will not
    // block Pi's active UI.
    const serviceDir = join(repoRoot, "talkd-service");
    if (existsSync(join(serviceDir, "go.mod"))) return { command: "go", args: ["run", "./cmd/talkd-service", "--sock", socketPath], cwd: serviceDir };
  }

  throw new Error(
    "talkd-service not found. Run `bun --cwd packages/pi-voice run setup:runtime`, install ~/.talkd/bin/talkd-service, or set TALKD_SERVICE_CMD.",
  );
}

async function runPackageSetup(logPath: string): Promise<void> {
  if (process.env.TALKD_PI_VOICE_SKIP_SETUP === "1" || process.env.TALKD_SKIP_INSTALL === "1") return;
  const script = join(packageRoot(), "scripts", "setup-talkd-runtime.sh");
  if (!existsSync(script)) return;

  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  try {
    await new Promise<void>((resolve) => {
      const child = spawn("bash", [script], {
        cwd: packageRoot(),
        stdio: ["ignore", logFd, logFd],
        env: serviceEnv(),
      });
      child.on("error", () => resolve());
      child.on("close", () => resolve());
    });
  } finally {
    closeSync(logFd);
  }
}

function serviceEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TALKD_HOME: defaultTalkdHome() };
  const libDir = join(defaultTalkdHome(), "lib");
  env.DYLD_LIBRARY_PATH = prependPath(libDir, env.DYLD_LIBRARY_PATH);
  env.LD_LIBRARY_PATH = prependPath(libDir, env.LD_LIBRARY_PATH);
  return env;
}

function prependPath(path: string, existing: string | undefined): string {
  return existing ? `${path}:${existing}` : path;
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function findRepoRoot(): string | undefined {
  const candidate = resolve(packageRoot(), "../..");
  return existsSync(join(candidate, "talkd-service", "go.mod")) ? candidate : undefined;
}

async function canPing(client: TalkdClient): Promise<boolean> {
  try {
    return await client.ping();
  } catch {
    return false;
  }
}
