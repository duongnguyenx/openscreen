import { describe, expect, it } from "vitest";
import { enhanceAudio, measureLoudness } from "./audioEnhancer";

const SAMPLE_RATE = 48_000;

function makeOfflineBuffer(
	channels: number,
	durationSec: number,
	fill: (channel: number, frame: number) => number,
): AudioBuffer {
	const ctx = new OfflineAudioContext(channels, Math.round(durationSec * SAMPLE_RATE), SAMPLE_RATE);
	const buf = ctx.createBuffer(channels, ctx.length, SAMPLE_RATE);
	for (let c = 0; c < channels; c++) {
		const data = buf.getChannelData(c);
		for (let i = 0; i < data.length; i++) data[i] = fill(c, i);
	}
	return buf;
}

describe("enhanceAudio (real WebAudio)", () => {
	it("normalizes a quiet signal toward the target loudness", async () => {
		const quiet = makeOfflineBuffer(1, 1, () => 0.05); // ~−26 dBFS RMS
		const before = measureLoudness(quiet);

		const out = await enhanceAudio(quiet, {
			denoise: "off",
			loudnessTargetLufs: -16,
		});

		expect(out.length).toBe(quiet.length);
		expect(out.numberOfChannels).toBe(quiet.numberOfChannels);
		expect(out.sampleRate).toBe(quiet.sampleRate);

		const after = measureLoudness(out);
		expect(after.lufs).toBeGreaterThan(before.lufs);
	}, 30_000);

	it("does not amplify essentially-silent buffers", async () => {
		const silent = makeOfflineBuffer(1, 1, () => 0);
		const before = measureLoudness(silent);

		const out = await enhanceAudio(silent, {
			denoise: "light",
			loudnessTargetLufs: -16,
		});

		const after = measureLoudness(out);
		// Silent in → silent out; should not boost noise floor
		expect(after.peakDb).toBeLessThan(-60);
		expect(after.peakDb).toBeLessThanOrEqual(before.peakDb + 1);
	}, 30_000);

	it("keeps peak below the soft limiter ceiling", async () => {
		// Loud sine wave at 1kHz, peaks ≈ 0.95 → would clip if naive gain applied
		const loud = makeOfflineBuffer(
			1,
			1,
			(_c, i) => 0.95 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE),
		);
		const out = await enhanceAudio(loud, {
			denoise: "off",
			loudnessTargetLufs: -10, // request more loudness than is reasonable
		});
		const after = measureLoudness(out);
		// Soft limiter ceiling at −1 dBFS; allow a tiny smidge for limiter
		// attack (a few samples of overshoot) but no real clipping past 0 dB
		expect(after.peakDb).toBeLessThan(0);
	}, 30_000);

	it("filter chain reduces high-frequency hiss", async () => {
		// Mix voice band sine (300Hz) + high-frequency hiss (10kHz)
		const noisy = makeOfflineBuffer(1, 1, (_c, i) => {
			const voice = 0.3 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE);
			const hiss = 0.2 * Math.sin((2 * Math.PI * 10_000 * i) / SAMPLE_RATE);
			return voice + hiss;
		});
		const out = await enhanceAudio(noisy, {
			denoise: "strong",
			loudnessTargetLufs: -16,
			skipNormalization: true,
		});

		// Spot-check by comparing high-frequency energy: take FFT-style RMS in
		// the upper band. Since we don't have FFT here, approximate by
		// differencing adjacent samples (roughly proportional to high-frequency
		// energy) — high freq in noisy >> high freq in cleaned.
		const hfBefore = highFreqEnergy(noisy.getChannelData(0));
		const hfAfter = highFreqEnergy(out.getChannelData(0));
		expect(hfAfter).toBeLessThan(hfBefore * 0.85);
	}, 30_000);
});

function highFreqEnergy(samples: Float32Array): number {
	let sumSq = 0;
	for (let i = 1; i < samples.length; i++) {
		const diff = samples[i] - samples[i - 1];
		sumSq += diff * diff;
	}
	return Math.sqrt(sumSq / samples.length);
}
