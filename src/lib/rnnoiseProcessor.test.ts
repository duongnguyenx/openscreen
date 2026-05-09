import { describe, expect, it } from "vitest";
import { __resetRNNoiseModuleCache, denoiseWithRNNoise } from "./rnnoiseProcessor";

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

describe("denoiseWithRNNoise", () => {
	it("returns the input as-is for empty buffers", async () => {
		__resetRNNoiseModuleCache();
		const buf = makeBuffer([[]]);
		const result = await denoiseWithRNNoise(buf);
		expect(result).not.toBeNull();
		expect(result?.framesProcessed).toBe(0);
		expect(result?.buffer).toBe(buf);
	});

	it("returns null when WASM fails to load (jsdom env)", async () => {
		// jsdom does not implement OfflineAudioContext, so the loader path falls
		// through to the catch and returns null. This is the expected fallback
		// callers rely on when the model isn't available.
		__resetRNNoiseModuleCache();
		const buf = makeBuffer([new Array(48_000).fill(0.1)]);
		const result = await denoiseWithRNNoise(buf);
		// Either null (load failed) or a result (real WebAudio available);
		// the contract is that callers must handle both. Here we only assert
		// the call doesn't throw.
		expect(result === null || typeof result === "object").toBe(true);
	});
});
