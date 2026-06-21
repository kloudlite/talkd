import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { voiceLatencyLog } from "./debug";

export interface RecordingHandle {
  readonly sampleRate: number;
  readonly command: string;
  readonly device: string;
  readonly done: Promise<Buffer>;
  stop(): void;
}

export interface PlaybackHandle {
  readonly done: Promise<void>;
  stop(): void;
}

export function startRecording(sampleRate = 16000): RecordingHandle {
  const source = recordingSource(sampleRate);
  voiceLatencyLog("recording.start", { device: source.device, command: source.command });
  const child = spawn(source.command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  const errs: Buffer[] = [];
  let stopped = false;

  child.stdout.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    errs.push(data);
    const text = data.toString("utf8").trim();
    if (text) voiceLatencyLog("recording.stderr", { text });
  });

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
    command: source.command,
    device: source.device,
    done,
    stop() {
      stopped = true;
      if (child.exitCode === null) child.kill("SIGINT");
    },
  };
}

export function analyzePCM16LE(pcm: Buffer, sampleRate: number): { seconds: number; max: number; rms: number; lowPct: number } {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return { seconds: 0, max: 0, rms: 0, lowPct: 100 };
  let peak = 0;
  let sumSquares = 0;
  const win = Math.max(1, Math.floor(sampleRate / 10));
  let low = 0;
  let windows = 0;
  for (let i = 0; i < samples; i += win) {
    let localSquares = 0;
    let n = 0;
    for (let j = i; j < Math.min(samples, i + win); j++) {
      const v = pcm.readInt16LE(j * 2) / 32768;
      peak = Math.max(peak, Math.abs(v));
      sumSquares += v * v;
      localSquares += v * v;
      n++;
    }
    if (n > 0) {
      windows++;
      if (Math.sqrt(localSquares / n) < 0.005) low++;
    }
  }
  return { seconds: samples / sampleRate, max: peak, rms: Math.sqrt(sumSquares / samples), lowPct: windows ? low * 100 / windows : 100 };
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

function recordingSource(sampleRate: number): { command: string; device: string } {
  if (process.env.TALKD_RECORD_CMD) return { command: process.env.TALKD_RECORD_CMD, device: "TALKD_RECORD_CMD" };

  if (process.platform === "darwin" && commandExists("sox")) {
    const requested = process.env.TALKD_RECORD_DEVICE || process.env.TALKD_INPUT_DEVICE;
    const gain = recordGainEffect();
    if (requested) {
      return {
        device: requested,
        command: `sox -q -t coreaudio ${shellQuote(requested)} -t raw -b 16 -e signed-integer -c 1 -r ${sampleRate} -${gain}`,
      };
    }
    const defaultName = coreAudioDefaultInputName();
    return {
      device: defaultName ? `coreaudio default (${defaultName})` : "coreaudio default",
      command: `sox -q -t coreaudio default -t raw -b 16 -e signed-integer -c 1 -r ${sampleRate} -${gain}`,
    };
  }

  return { device: "rec default", command: `rec -q -t raw -b 16 -e signed-integer -c 1 -r ${sampleRate} -` };
}

function recordGainEffect(): string {
  const gain = Number(process.env.TALKD_RECORD_GAIN ?? "");
  return Number.isFinite(gain) && gain !== 0 ? ` gain ${gain}` : "";
}

function coreAudioDefaultInputName(): string | undefined {
  const out = spawnSync("system_profiler", ["SPAudioDataType"], { encoding: "utf8" }).stdout || "";
  const blocks = out.split(/\n(?= {8}\S)/);
  for (const block of blocks) {
    if (!block.includes("Default Input Device: Yes")) continue;
    return block.match(/^ {8}(.+?):\n/m)?.[1];
  }
  return undefined;
}

function commandExists(command: string): boolean {
  return spawnSync("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]).status === 0;
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
