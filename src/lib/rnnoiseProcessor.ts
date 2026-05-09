/**
 * RNNoise voice denoiser, wrapped for `AudioBuffer` input/output.
 *
 * RNNoise is a recurrent-neural-net suppressor (Xiph.org / Mozilla) that
 * separates voice from broadband noise — fan, AC, mic floor, room hum.
 * Same engine Discord, Jitsi and OBS use for their "noise suppression" toggles.
 *
 * Constraints from the underlying C library:
 *  - 48 kHz mono input
 *  - Frames of exactly 480 samples (10 ms)
 *  - Samples scaled to int16 range ([-32768, 32767]) — NOT float [-1, 1]
 *
 * This module does the bookkeeping:
 *  - Resamples / downmixes to 48 kHz mono via OfflineAudioContext when needed
 *  - Chunks into 480-sample frames, scales, processes, scales back
 *  - Duplicates mono output back to the source channel count
 *  - Caches the WASM module so we only pay load cost once
 *  - Falls back gracefully if the WASM fails to load (caller can detect)
 *
 * The WASM binary lives in `public/wasm/rnnoise.wasm` (matches the same
 * convention as `web-demuxer.wasm`). Renderer fetches via a regular URL
 * relative to the page so Electron's file:// loading works in dev + prod.
 */

const RNNOISE_FRAME_SIZE = 480;
const PCM_SCALE = 0x7fff;
const RNNOISE_TARGET_SAMPLE_RATE = 48_000;

interface RNNoiseModule {
	HEAPF32: Float32Array;
	_rnnoise_create: () => number;
	_rnnoise_destroy: (state: number) => void;
	_rnnoise_process_frame: (state: number, output: number, input: number) => number;
	_malloc: (size: number) => number;
	_free: (ptr: number) => void;
}

interface CreateRNNWasmModuleOptions {
	locateFile?: (path: string, scriptDirectory: string) => string;
}

let modulePromise: Promise<RNNoiseModule | null> | null = null;

function loadModule(): Promise<RNNoiseModule | null> {
	if (modulePromise) return modulePromise;
	modulePromise = (async () => {
		try {
			const { createRNNWasmModule } = (await import("@jitsi/rnnoise-wasm")) as {
				createRNNWasmModule: (options?: CreateRNNWasmModuleOptions) => Promise<RNNoiseModule>;
			};
			const wasmUrl = new URL("./wasm/rnnoise.wasm", window.location.href).href;
			return await createRNNWasmModule({
				locateFile: () => wasmUrl,
			});
		} catch (err) {
			console.warn("[rnnoise] Failed to load WASM module:", err);
			return null;
		}
	})();
	return modulePromise;
}

export interface RNNoiseDenoiseResult {
	buffer: AudioBuffer;
	/** Frames the model processed. Useful for tests/diagnostics. */
	framesProcessed: number;
}

/**
 * Run an `AudioBuffer` through RNNoise and return a new buffer of the same
 * sample rate + channel count. Returns `null` when the model fails to load
 * (caller should fall back to raw audio).
 */
export async function denoiseWithRNNoise(input: AudioBuffer): Promise<RNNoiseDenoiseResult | null> {
	if (input.length === 0 || input.numberOfChannels === 0) {
		return { buffer: input, framesProcessed: 0 };
	}

	const module = await loadModule();
	if (!module) return null;

	// 1. Get a 48 kHz mono representation of the input
	const monoInput = await downmixTo48kMono(input);

	// 2. Allocate two scratch frames in WASM memory (input + output)
	const frameBytes = RNNOISE_FRAME_SIZE * Float32Array.BYTES_PER_ELEMENT;
	const inputPtr = module._malloc(frameBytes);
	const outputPtr = module._malloc(frameBytes);
	const state = module._rnnoise_create();

	const total = monoInput.length;
	const denoisedMono = new Float32Array(total);
	let framesProcessed = 0;

	try {
		// Pad final partial frame with zeros so we always feed RNNoise full frames
		const lastFrameLen = total % RNNOISE_FRAME_SIZE;
		const fullFrameCount = Math.ceil(total / RNNOISE_FRAME_SIZE);

		for (let f = 0; f < fullFrameCount; f++) {
			const start = f * RNNOISE_FRAME_SIZE;
			const end = Math.min(start + RNNOISE_FRAME_SIZE, total);
			const len = end - start;

			// Scale [-1, 1] → int16-range floats and write into WASM memory
			const inputView = module.HEAPF32.subarray(
				inputPtr / Float32Array.BYTES_PER_ELEMENT,
				inputPtr / Float32Array.BYTES_PER_ELEMENT + RNNOISE_FRAME_SIZE,
			);
			for (let i = 0; i < len; i++) inputView[i] = monoInput[start + i] * PCM_SCALE;
			for (let i = len; i < RNNOISE_FRAME_SIZE; i++) inputView[i] = 0;

			module._rnnoise_process_frame(state, outputPtr, inputPtr);

			const outputView = module.HEAPF32.subarray(
				outputPtr / Float32Array.BYTES_PER_ELEMENT,
				outputPtr / Float32Array.BYTES_PER_ELEMENT + RNNOISE_FRAME_SIZE,
			);
			const writeLen = f === fullFrameCount - 1 && lastFrameLen > 0 ? lastFrameLen : len;
			for (let i = 0; i < writeLen; i++) {
				denoisedMono[start + i] = outputView[i] / PCM_SCALE;
			}
			framesProcessed++;
		}
	} finally {
		module._rnnoise_destroy(state);
		module._free(inputPtr);
		module._free(outputPtr);
	}

	// 3. Re-assemble into the original channel layout / sample rate
	const output = await rebuildToInputFormat(denoisedMono, input);
	return { buffer: output, framesProcessed };
}

/**
 * Average all channels and resample to 48 kHz.
 *
 * Uses OfflineAudioContext for both the sample-rate conversion and the
 * average — feed all channels through a ChannelMergerNode → mixer → render.
 * Returns the mono Float32Array directly to keep callers simple.
 */
async function downmixTo48kMono(input: AudioBuffer): Promise<Float32Array> {
	const targetLength = Math.round((input.length / input.sampleRate) * RNNOISE_TARGET_SAMPLE_RATE);
	const ctx = new OfflineAudioContext(1, targetLength, RNNOISE_TARGET_SAMPLE_RATE);
	const source = ctx.createBufferSource();
	source.buffer = input;

	// Browser's ChannelInterpretation "speakers" mix L+R → mono with the right
	// gain laws, exactly what we want for voice content.
	source.connect(ctx.destination);
	source.start();

	const rendered = await ctx.startRendering();
	return rendered.getChannelData(0).slice();
}

/**
 * Take a 48 kHz mono Float32Array and return an AudioBuffer with the original
 * sample rate + channel count (mono duplicated to each channel).
 */
async function rebuildToInputFormat(
	mono: Float32Array,
	original: AudioBuffer,
): Promise<AudioBuffer> {
	const sampleRate = original.sampleRate;
	const channels = original.numberOfChannels;
	const targetLength = Math.round((mono.length / RNNOISE_TARGET_SAMPLE_RATE) * sampleRate);

	const sourceCtx = new OfflineAudioContext(1, mono.length, RNNOISE_TARGET_SAMPLE_RATE);
	const monoBuffer = sourceCtx.createBuffer(1, mono.length, RNNOISE_TARGET_SAMPLE_RATE);
	// `copyToChannel` types want a Float32Array<ArrayBuffer>; rebuild a plain
	// view to keep TS happy across both DOM and Vite typings.
	const monoForCopy = new Float32Array(mono);
	monoBuffer.copyToChannel(monoForCopy, 0);

	if (sampleRate === RNNOISE_TARGET_SAMPLE_RATE && channels === 1) {
		return monoBuffer;
	}

	// Resample to original sample rate + duplicate to each channel
	const outCtx = new OfflineAudioContext(channels, targetLength, sampleRate);
	const src = outCtx.createBufferSource();
	src.buffer = monoBuffer;

	if (channels > 1) {
		// Duplicate mono into every output channel via channel splitter pattern
		const splitter = outCtx.createChannelSplitter(channels);
		const merger = outCtx.createChannelMerger(channels);
		src.connect(splitter);
		for (let c = 0; c < channels; c++) {
			// Splitter only outputs on channel 0 because input is mono — wire that
			// single output to every merger channel.
			splitter.connect(merger, 0, c);
		}
		merger.connect(outCtx.destination);
	} else {
		src.connect(outCtx.destination);
	}

	src.start();
	return await outCtx.startRendering();
}

/** Eagerly load the WASM module; useful for warming up before the user clicks Apply. */
export function preloadRNNoiseModule(): Promise<unknown> {
	return loadModule();
}

/** For tests: clear the cached module so subsequent loads re-hit the loader. */
export function __resetRNNoiseModuleCache() {
	modulePromise = null;
}
