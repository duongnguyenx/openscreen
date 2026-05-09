import { describe, expect, it } from "vitest";
import { measureLoudness } from "./audioEnhancer";

const SAMPLE_RATE = 48_000;

function makeBuffer(samples: number[][], sampleRate = SAMPLE_RATE): AudioBuffer {
	const length = samples[0]?.length ?? 0;
	const data = samples.map((arr) => Float32Array.from(arr));
	return {
		numberOfChannels: data.length,
		length,
		sampleRate,
		duration: length / sampleRate,
		getChannelData(channel: number) {
			return data[channel];
		},
	} as unknown as AudioBuffer;
}

function tone(seconds: number, amplitude: number, sampleRate = SAMPLE_RATE): number[] {
	return new Array(Math.round(seconds * sampleRate)).fill(amplitude);
}

describe("measureLoudness", () => {
	it("reports floor for fully silent audio", () => {
		const buf = makeBuffer([tone(0.5, 0)]);
		const result = measureLoudness(buf);
		expect(result.peakDb).toBeLessThanOrEqual(-100);
		expect(result.lufs).toBeLessThanOrEqual(-100);
	});

	it("reports loudness near 0 dB for full-scale signal", () => {
		const buf = makeBuffer([tone(0.5, 1.0)]);
		const result = measureLoudness(buf);
		expect(result.peakDb).toBeCloseTo(0, 0);
		// RMS of constant 1.0 == 1.0 == 0 dBFS, plus +3 dB LUFS bias
		expect(result.lufs).toBeGreaterThan(0);
		expect(result.lufs).toBeLessThan(10);
	});

	it("reports lower loudness for quieter audio", () => {
		const loud = measureLoudness(makeBuffer([tone(0.5, 0.5)]));
		const quiet = measureLoudness(makeBuffer([tone(0.5, 0.05)]));
		expect(quiet.lufs).toBeLessThan(loud.lufs);
		expect(quiet.peakDb).toBeLessThan(loud.peakDb);
	});

	it("uses peak across all channels", () => {
		// Left channel quiet, right channel loud → peak should reflect the loud one
		const buf = makeBuffer([tone(0.5, 0.05), tone(0.5, 0.8)]);
		const result = measureLoudness(buf);
		expect(result.peakDb).toBeGreaterThan(-3);
	});

	it("handles empty buffers gracefully", () => {
		const buf = makeBuffer([[]]);
		const result = measureLoudness(buf);
		expect(result.peakDb).toBeLessThan(-100);
		expect(result.lufs).toBeLessThan(-100);
	});

	it("scales LUFS reading consistently with amplitude", () => {
		// −6 dB amplitude change should yield ~−6 dB LUFS change
		const a = measureLoudness(makeBuffer([tone(0.5, 0.5)]));
		const b = measureLoudness(makeBuffer([tone(0.5, 0.25)]));
		expect(a.lufs - b.lufs).toBeGreaterThan(5);
		expect(a.lufs - b.lufs).toBeLessThan(7);
	});
});
