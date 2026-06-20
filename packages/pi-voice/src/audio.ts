import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface RecordingHandle {
  readonly sampleRate: number;
  readonly done: Promise<Buffer>;
  stop(): void;
}

export interface PlaybackHandle {
  readonly done: Promise<void>;
  stop(): void;
}

export function startRecording(sampleRate = 16000): RecordingHandle {
  const command = process.env.TALKD_RECORD_CMD ?? `rec -q -t raw -b 16 -e signed-integer -c 1 -r ${sampleRate} -`;
  const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  const errs: Buffer[] = [];
  let stopped = false;

  child.stdout.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer | string) => errs.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

  const done = new Promise<Buffer>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      const data = Buffer.concat(chunks);
      if (data.length > 0) return resolve(data);
      if (stopped) return resolve(Buffer.alloc(0));
      reject(new Error(`recording failed (${code ?? "unknown"}): ${Buffer.concat(errs).toString("utf8").trim()}`));
    });
  });

  return {
    sampleRate,
    done,
    stop() {
      stopped = true;
      if (child.exitCode === null) child.kill("SIGINT");
    },
  };
}

export async function playPCMAsWav(pcm: Buffer, sampleRate: number): Promise<PlaybackHandle> {
  const configuredPath = process.env.TALKD_PI_VOICE_WAV;
  const wavPath = configuredPath ?? join(tmpdir(), `talkd-pi-voice-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  await mkdir(dirname(wavPath), { recursive: true });
  await writeFile(wavPath, pcm16ToWav(pcm, sampleRate));
  const playback = startWavPlayback(wavPath);
  if (!configuredPath) {
    void playback.done.then(
      () => unlink(wavPath).catch(() => undefined),
      () => unlink(wavPath).catch(() => undefined),
    );
  }
  return playback;
}

export function startWavPlayback(path: string): PlaybackHandle {
  const custom = process.env.TALKD_PLAY_CMD;
  const command = custom ? custom.replaceAll("{file}", shellQuote(path)) : `afplay ${shellQuote(path)}`;
  return startShell(command);
}

function startShell(command: string): PlaybackHandle {
  let stopped = false;
  const child: ChildProcess = spawn(command, { shell: true, stdio: "ignore", detached: true });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (stopped || code === 0) resolve();
      else reject(new Error(`command failed (${code}): ${command}`));
    });
  });
  return {
    done,
    stop() {
      stopped = true;
      if (child.exitCode !== null) return;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // Fall through to killing just the shell if process-group kill is unavailable.
        }
      }
      child.kill("SIGTERM");
    },
  };
}

function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const channels = 1;
  const bits = 16;
  const byteRate = sampleRate * channels * bits / 8;
  const blockAlign = channels * bits / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
