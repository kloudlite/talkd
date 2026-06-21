import { expect, test } from "bun:test";
import { analyzePCM16LE } from "./audio";

test("analyzePCM16LE reports silence/dropouts", () => {
  const pcm = Buffer.alloc(1600 * 2); // 100ms at 16kHz
  const stats = analyzePCM16LE(pcm, 16000);
  expect(stats.seconds).toBe(0.1);
  expect(stats.max).toBe(0);
  expect(stats.rms).toBe(0);
  expect(stats.lowPct).toBe(100);
});

test("analyzePCM16LE reports signal", () => {
  const pcm = Buffer.alloc(1600 * 2);
  for (let i = 0; i < 1600; i++) pcm.writeInt16LE(i % 2 === 0 ? 10000 : -10000, i * 2);
  const stats = analyzePCM16LE(pcm, 16000);
  expect(stats.max).toBeGreaterThan(0.3);
  expect(stats.rms).toBeGreaterThan(0.3);
  expect(stats.lowPct).toBe(0);
});
