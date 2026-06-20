import { createConnection, type Socket } from "node:net";

export interface Frame {
  type: string;
  text?: string;
  bytes?: number;
  sample_rate?: number;
  format?: string;
  channels?: number;
  speed?: number;
  sid?: number;
  error?: string;
  progress?: number;
}

class SocketReader {
  private buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private ended = false;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = Buffer.concat([this.buffer, data]);
      this.wake();
    });
    socket.on("end", () => { this.ended = true; this.wake(); });
    socket.on("close", () => { this.ended = true; this.wake(); });
  }

  async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf(0x0a);
      if (idx >= 0) {
        const line = this.buffer.subarray(0, idx).toString("utf8");
        this.buffer = this.buffer.subarray(idx + 1);
        return line;
      }
      if (this.ended) throw new Error("socket closed while reading line");
      await this.wait();
    }
  }

  async readBytes(n: number): Promise<Buffer> {
    while (this.buffer.length < n) {
      if (this.ended) throw new Error("socket closed while reading bytes");
      await this.wait();
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return Buffer.from(out);
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

export class TalkdClient {
  constructor(private readonly socketPath: string) {}

  async ping(): Promise<boolean> {
    const { socket, reader } = await this.connect();
    try {
      this.writeFrame(socket, { type: "ping" });
      const frame = await this.readFrame(reader);
      return frame.type === "pong";
    } finally {
      socket.end();
    }
  }

  async sttPCM(input: Buffer, sampleRate = 16000): Promise<string> {
    const { socket, reader } = await this.connect();
    try {
      this.writeFrame(socket, { type: "stt_start", sample_rate: sampleRate, channels: 1, format: "pcm_s16le" });
      this.writeFrame(socket, { type: "audio", bytes: input.length });
      socket.write(input);
      this.writeFrame(socket, { type: "stt_end" });

      for (;;) {
        const frame = await this.readFrame(reader);
        if (frame.type === "error") throw new Error(frame.error ?? "talkd error");
        if (frame.type === "stt_final") return frame.text ?? "";
      }
    } finally {
      socket.end();
    }
  }

  async ttsPCM(text: string, onChunk?: (chunk: Buffer, info: Frame) => void): Promise<{ sampleRate: number; pcm: Buffer }> {
    const { socket, reader } = await this.connect();
    const chunks: Buffer[] = [];
    let sampleRate = 24000;
    try {
      this.writeFrame(socket, { type: "tts", text, speed: 1 });
      for (;;) {
        const frame = await this.readFrame(reader);
        if (frame.type === "error") throw new Error(frame.error ?? "talkd error");
        if (frame.type === "tts_start") {
          sampleRate = frame.sample_rate ?? sampleRate;
          continue;
        }
        if (frame.type === "audio") {
          const chunk = await reader.readBytes(frame.bytes ?? 0);
          chunks.push(chunk);
          onChunk?.(chunk, frame);
          continue;
        }
        if (frame.type === "tts_end") break;
      }
      return { sampleRate, pcm: Buffer.concat(chunks) };
    } finally {
      socket.end();
    }
  }

  private connect(): Promise<{ socket: Socket; reader: SocketReader }> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.once("connect", () => resolve({ socket, reader: new SocketReader(socket) }));
      socket.once("error", reject);
    });
  }

  private writeFrame(socket: Socket, frame: Frame) {
    socket.write(`${JSON.stringify(frame)}\n`);
  }

  private async readFrame(reader: SocketReader): Promise<Frame> {
    return JSON.parse(await reader.readLine()) as Frame;
  }
}
