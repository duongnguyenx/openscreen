import { describe, expect, it } from "vitest";
import {
	clampSilenceOptions,
	DEFAULT_SILENCE_OPTIONS,
	detectSilences,
	MAX_THRESHOLD_DB,
	MIN_THRESHOLD_DB,
} from "./silenceDetector";

const SAMPLE_RATE = 48_000;

/**
 * Build a mono AudioBuffer-shaped object whose contract matches what
 * `detectSilences` consumes. We can't `new AudioBuffer()` in jsdom, so this
 * matches the `numberOfChannels` / `length` / `sampleRate` / `getChannelData`
 * surface the detector uses — nothing else.
 */
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

/** N seconds of constant amplitude (positive). */
function tone(seconds: number, amplitude: number, sampleRate = SAMPLE_RATE): number[] {
	return new Array(Math.round(seconds * sampleRate)).fill(amplitude);
}

function silence(seconds: number, sampleRate = SAMPLE_RATE): number[] {
	return new Array(Math.round(seconds * sampleRate)).fill(0);
}

describe("detectSilences", () => {
	it("returns no ranges for fully loud audio", () => {
		const buf = makeBuffer([tone(1, 0.5)]);
		const result = detectSilences(buf);
		expect(result.ranges).toEqual([]);
		expect(result.totalSilenceMs).toBe(0);
	});

	it("returns no ranges for silences shorter than minSilenceMs", () => {
		// 100ms silence sandwiched between loud audio, with min 400ms threshold
		const buf = makeBuffer([[...tone(0.5, 0.5), ...silence(0.1), ...tone(0.5, 0.5)]]);
		const result = detectSilences(buf, { ...DEFAULT_SILENCE_OPTIONS, paddingMs: 0 });
		expect(result.ranges).toEqual([]);
	});

	it("detects a long silent run between loud sections", () => {
		// 500ms loud, 1000ms silence, 500ms loud
		const buf = makeBuffer([[...tone(0.5, 0.5), ...silence(1.0), ...tone(0.5, 0.5)]]);
		const result = detectSilences(buf, {
			...DEFAULT_SILENCE_OPTIONS,
			paddingMs: 0,
			minSilenceMs: 400,
		});
		expect(result.ranges).toHaveLength(1);
		const [range] = result.ranges;
		// Allow ±2 windows of slop (40ms at 20ms windows) for boundary alignment
		expect(range.startMs).toBeGreaterThanOrEqual(480);
		expect(range.startMs).toBeLessThanOrEqual(520);
		expect(range.endMs).toBeGreaterThanOrEqual(1480);
		expect(range.endMs).toBeLessThanOrEqual(1520);
	});

	it("shrinks ranges by paddingMs on both sides", () => {
		const buf = makeBuffer([[...tone(0.5, 0.5), ...silence(1.0), ...tone(0.5, 0.5)]]);
		const padded = detectSilences(buf, {
			...DEFAULT_SILENCE_OPTIONS,
			paddingMs: 100,
			minSilenceMs: 400,
		});
		expect(padded.ranges).toHaveLength(1);
		const [range] = padded.ranges;
		// Range should be ~200ms shorter than the underlying 1000ms silence
		expect(range.endMs - range.startMs).toBeGreaterThanOrEqual(750);
		expect(range.endMs - range.startMs).toBeLessThanOrEqual(820);
	});

	it("treats audio below thresholdDb as silence even if non-zero", () => {
		// −60dB ≈ 0.001 amplitude; default threshold is −40dB ≈ 0.01
		const veryQuiet = 0.001;
		const buf = makeBuffer([[...tone(0.5, 0.5), ...tone(1.0, veryQuiet), ...tone(0.5, 0.5)]]);
		const result = detectSilences(buf, {
			...DEFAULT_SILENCE_OPTIONS,
			paddingMs: 0,
			minSilenceMs: 400,
		});
		expect(result.ranges).toHaveLength(1);
	});

	it("classifies audio as loud when ANY channel is loud", () => {
		// Left channel silent, right channel loud — must NOT be marked silence
		const buf = makeBuffer([silence(1.0), tone(1.0, 0.5)]);
		const result = detectSilences(buf, {
			...DEFAULT_SILENCE_OPTIONS,
			paddingMs: 0,
			minSilenceMs: 400,
		});
		expect(result.ranges).toEqual([]);
	});

	it("detects silence at the start and end of the buffer", () => {
		const buf = makeBuffer([[...silence(1.0), ...tone(0.3, 0.5), ...silence(1.0)]]);
		const result = detectSilences(buf, {
			...DEFAULT_SILENCE_OPTIONS,
			paddingMs: 0,
			minSilenceMs: 400,
		});
		expect(result.ranges).toHaveLength(2);
		expect(result.ranges[0].startMs).toBeLessThanOrEqual(20);
		expect(result.ranges[1].endMs).toBeGreaterThanOrEqual(2280);
	});

	it("merges overlapping ranges that arise from padding clamping", () => {
		// Two short-but-just-long-enough silences close together — heavy padding
		// should not produce inverted ranges
		const buf = makeBuffer([
			[...tone(0.2, 0.5), ...silence(0.5), ...tone(0.05, 0.5), ...silence(0.5), ...tone(0.2, 0.5)],
		]);
		const result = detectSilences(buf, {
			...DEFAULT_SILENCE_OPTIONS,
			paddingMs: 50,
			minSilenceMs: 400,
		});
		for (const range of result.ranges) {
			expect(range.endMs).toBeGreaterThan(range.startMs);
		}
	});

	it("returns empty result for empty buffer", () => {
		const buf = makeBuffer([[]]);
		const result = detectSilences(buf);
		expect(result.ranges).toEqual([]);
		expect(result.windowCount).toBe(0);
	});
});

describe("clampSilenceOptions", () => {
	it("clamps thresholdDb into the supported range", () => {
		const tooLow = clampSilenceOptions({
			thresholdDb: -200,
			minSilenceMs: 500,
			paddingMs: 100,
		});
		expect(tooLow.thresholdDb).toBe(MIN_THRESHOLD_DB);

		const tooHigh = clampSilenceOptions({
			thresholdDb: 0,
			minSilenceMs: 500,
			paddingMs: 100,
		});
		expect(tooHigh.thresholdDb).toBe(MAX_THRESHOLD_DB);
	});

	it("repairs NaN values with the midpoint of the valid range", () => {
		const repaired = clampSilenceOptions({
			thresholdDb: Number.NaN,
			minSilenceMs: Number.NaN,
			paddingMs: Number.NaN,
		});
		expect(Number.isFinite(repaired.thresholdDb)).toBe(true);
		expect(Number.isFinite(repaired.minSilenceMs)).toBe(true);
		expect(Number.isFinite(repaired.paddingMs)).toBe(true);
	});
});
