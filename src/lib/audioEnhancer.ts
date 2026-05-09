/**
 * Voice cleanup + loudness normalization for export.
 *
 * Pipeline depends on the `denoise` preset:
 *   off    → loudness norm + soft limiter only (no spectral processing)
 *   light  → RNNoise → loudness norm + soft limiter
 *   strong → RNNoise → de-esser polish → loudness norm + soft limiter
 *
 * RNNoise (xiph.org / Mozilla) is a recurrent-neural-net suppressor that
 * actually separates voice from broadband noise (fan, AC, hiss, room hum) —
 * the same engine Discord, Jitsi, and OBS use. When the WASM module fails
 * to load, callers transparently get the un-denoised audio instead.
 *
 * Loudness normalization runs through a plain gain node so callers get a
 * single code path. A pure no-op buffer copy is used only when the input is
 * essentially silent (would amplify noise floor).
 */

import { denoiseWithRNNoise } from "./rnnoiseProcessor";

const DB_FLOOR = -120;

/** dBFS-to-LUFS offset for the simplified RMS estimator. ITU-1770 K-weighted
 *  loudness on full-bandwidth voice typically reads ~3 dB above plain RMS;
 *  we bias the report by this constant so users see numbers that line up
 *  roughly with what `ffmpeg -af ebur128` reports for voiceover content. */
const RMS_TO_LUFS_OFFSET_DB = 3;

export type DenoisePreset = "off" | "light" | "strong";

export interface AudioEnhanceOptions {
	denoise: DenoisePreset;
	/** Target integrated loudness in LUFS (e.g. −16 for podcasts, −14 for YouTube). */
	loudnessTargetLufs: number;
	/** When true, skip loudness normalization (only filter). Default false. */
	skipNormalization?: boolean;
}

export interface LoudnessMeasurement {
	lufs: number;
	peakDb: number;
}

export const DEFAULT_AUDIO_ENHANCE_OPTIONS: AudioEnhanceOptions = {
	denoise: "light",
	loudnessTargetLufs: -16,
};

export const LOUDNESS_TARGETS: Record<string, number> = {
	youtube: -14,
	podcast: -16,
	soft: -19,
};

export const MIN_LOUDNESS_TARGET_LUFS = -30;
export const MAX_LOUDNESS_TARGET_LUFS = -10;
const MAX_GAIN_DB = 18;
const MIN_GAIN_DB = -18;

/**
 * Measure approximate integrated loudness and true peak of an `AudioBuffer`.
 * Uses RMS over the full buffer (averaged across channels) plus a constant
 * offset to land near ITU-1770 numbers for typical voice. Not a substitute
 * for ebur128, but consistent enough to drive a target-based gain decision.
 */
export function measureLoudness(buffer: AudioBuffer): LoudnessMeasurement {
	const channels = buffer.numberOfChannels;
	const length = buffer.length;
	if (channels === 0 || length === 0) return { lufs: DB_FLOOR, peakDb: DB_FLOOR };

	let sumSq = 0;
	let sampleCount = 0;
	let peak = 0;

	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < length; i++) {
			const s = data[i];
			sumSq += s * s;
			const abs = Math.abs(s);
			if (abs > peak) peak = abs;
		}
		sampleCount += length;
	}

	const rms = Math.sqrt(sumSq / Math.max(1, sampleCount));
	const rmsDb = amplitudeToDb(rms);
	const peakDb = amplitudeToDb(peak);
	const lufs = rmsDb + RMS_TO_LUFS_OFFSET_DB;
	return { lufs, peakDb };
}

/**
 * Apply the enhancement chain offline and return a new AudioBuffer.
 *
 * The offline render time scales linearly with buffer length but is much
 * faster than realtime in practice (~10-30× on modern CPUs). RNNoise adds a
 * separate forward pass on the audio (~30-60× realtime).
 */
export async function enhanceAudio(
	input: AudioBuffer,
	options: AudioEnhanceOptions = DEFAULT_AUDIO_ENHANCE_OPTIONS,
): Promise<AudioBuffer> {
	const sanitized = clampOptions(options);

	// Empty input → return as-is.
	if (input.length === 0 || input.numberOfChannels === 0) {
		return input;
	}

	// Stage 1: denoise via RNNoise (skipped for "off"). On WASM-load failure
	// we silently fall back to the raw input — never block on missing model.
	const denoised = sanitized.denoise === "off" ? input : await applyRNNoise(input);

	const measured = measureLoudness(denoised);

	// Buffer is essentially silent — amplifying would just boost noise floor.
	if (Math.abs(measured.peakDb) === Math.abs(DB_FLOOR) || measured.peakDb < -80) {
		return cloneBuffer(denoised);
	}

	const gainDb = sanitized.skipNormalization
		? 0
		: computeGainDb(measured, sanitized.loudnessTargetLufs);

	// Stage 2: WebAudio chain — optional polish (de-esser for "strong") +
	// gain + soft limiter. Run in OfflineAudioContext at the input's native rate.
	const offline = new OfflineAudioContext(
		denoised.numberOfChannels,
		denoised.length,
		denoised.sampleRate,
	);
	const source = offline.createBufferSource();
	source.buffer = denoised;

	let node: AudioNode = source;

	if (sanitized.denoise === "strong") {
		const polish = buildStrongPolishChain(offline);
		node.connect(polish.input);
		node = polish.output;
	}

	const gainNode = offline.createGain();
	gainNode.gain.value = dbToAmplitude(gainDb);
	node.connect(gainNode);
	node = gainNode;

	const limiter = createSoftLimiter(offline);
	node.connect(limiter);
	node = limiter;

	node.connect(offline.destination);

	source.start();
	const rendered = await offline.startRendering();
	return rendered;
}

async function applyRNNoise(input: AudioBuffer): Promise<AudioBuffer> {
	try {
		const result = await denoiseWithRNNoise(input);
		return result?.buffer ?? input;
	} catch (err) {
		console.warn("[audioEnhancer] RNNoise failed, returning raw input:", err);
		return input;
	}
}

interface DenoiseChain {
	input: AudioNode;
	output: AudioNode;
}

/**
 * Polish chain that runs AFTER RNNoise to further clean the voice for the
 * "strong" preset. RNNoise already handles the heavy lifting; this adds a
 * mild high-pass safety net + a deeper de-esser for sibilant-heavy mics.
 */
function buildStrongPolishChain(ctx: BaseAudioContext): DenoiseChain {
	const highPass = ctx.createBiquadFilter();
	highPass.type = "highpass";
	highPass.frequency.value = 60;
	highPass.Q.value = 0.7;

	const deEsser = ctx.createBiquadFilter();
	deEsser.type = "peaking";
	deEsser.frequency.value = 6_500;
	deEsser.Q.value = 1.4;
	deEsser.gain.value = -6;

	highPass.connect(deEsser);
	return { input: highPass, output: deEsser };
}

/**
 * Soft limiter: aggressive compressor pinned at −1 dBFS so any post-gain
 * peaks get squashed instead of clipping the encoder.
 */
function createSoftLimiter(ctx: BaseAudioContext): DynamicsCompressorNode {
	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = -1;
	limiter.knee.value = 0;
	limiter.ratio.value = 20;
	limiter.attack.value = 0.001;
	limiter.release.value = 0.05;
	return limiter;
}

function computeGainDb(measured: LoudnessMeasurement, targetLufs: number): number {
	if (!Number.isFinite(measured.lufs) || measured.lufs <= DB_FLOOR + 1) return 0;
	const rawGain = targetLufs - measured.lufs;
	return clamp(rawGain, MIN_GAIN_DB, MAX_GAIN_DB);
}

function cloneBuffer(input: AudioBuffer): AudioBuffer {
	const ctx = new OfflineAudioContext(input.numberOfChannels, input.length, input.sampleRate);
	const out = ctx.createBuffer(input.numberOfChannels, input.length, input.sampleRate);
	for (let c = 0; c < input.numberOfChannels; c++) {
		out.copyToChannel(input.getChannelData(c).slice(), c);
	}
	return out;
}

function clampOptions(opts: AudioEnhanceOptions): AudioEnhanceOptions {
	return {
		denoise: ["off", "light", "strong"].includes(opts.denoise) ? opts.denoise : "light",
		loudnessTargetLufs: clamp(
			opts.loudnessTargetLufs,
			MIN_LOUDNESS_TARGET_LUFS,
			MAX_LOUDNESS_TARGET_LUFS,
		),
		skipNormalization: opts.skipNormalization,
	};
}

function amplitudeToDb(value: number): number {
	if (value <= 0) return DB_FLOOR;
	const db = 20 * Math.log10(value);
	return db < DB_FLOOR ? DB_FLOOR : db;
}

function dbToAmplitude(db: number): number {
	if (db <= DB_FLOOR) return 0;
	return 10 ** (db / 20);
}

function clamp(value: number, min: number, max: number) {
	if (Number.isNaN(value)) return (min + max) / 2;
	return Math.min(max, Math.max(min, value));
}

/**
 * Convert a sequence of `AudioData` frames (output of `AudioDecoder`) into a
 * single `AudioBuffer`. Frames must be sequential and share format/sampleRate.
 *
 * `AudioData.copyTo()` works on planar destinations when `format` is `f32-planar`,
 * so we copy per channel into a Float32Array, then assemble an AudioBuffer.
 */
export function audioDataFramesToBuffer(frames: AudioData[]): AudioBuffer | null {
	if (frames.length === 0) return null;
	const first = frames[0];
	const sampleRate = first.sampleRate;
	const channels = first.numberOfChannels;
	if (sampleRate <= 0 || channels <= 0) return null;

	let totalFrames = 0;
	for (const f of frames) totalFrames += f.numberOfFrames;
	if (totalFrames === 0) return null;

	const buffer = new OfflineAudioContext(channels, totalFrames, sampleRate).createBuffer(
		channels,
		totalFrames,
		sampleRate,
	);

	const channelData: Float32Array[] = [];
	for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));

	let offset = 0;
	for (const frame of frames) {
		const frameLen = frame.numberOfFrames;
		for (let c = 0; c < channels; c++) {
			const dest = new Float32Array(frameLen);
			frame.copyTo(dest, { planeIndex: c, format: "f32-planar" });
			channelData[c].set(dest, offset);
		}
		offset += frameLen;
	}

	return buffer;
}

/**
 * Inverse of `audioDataFramesToBuffer`: chunk an AudioBuffer back into AudioData
 * objects that match the original frames' shape (so the encoder doesn't see a
 * sudden change in chunk size).
 *
 * `templateFrames` provides the per-frame `numberOfFrames` and `timestamp`
 * values to preserve. Caller is responsible for closing the returned frames.
 */
export function audioBufferToDataFrames(
	buffer: AudioBuffer,
	templateFrames: AudioData[],
): AudioData[] {
	const channels = buffer.numberOfChannels;
	const sampleRate = buffer.sampleRate;
	const out: AudioData[] = [];

	const allChannels: Float32Array[] = [];
	for (let c = 0; c < channels; c++) allChannels.push(buffer.getChannelData(c));

	let offset = 0;
	for (const template of templateFrames) {
		const frameLen = template.numberOfFrames;
		const data = new Float32Array(channels * frameLen);
		// Pack as planar f32 (all of channel 0, then channel 1, …).
		for (let c = 0; c < channels; c++) {
			const src = allChannels[c].subarray(offset, offset + frameLen);
			data.set(src, c * frameLen);
		}
		out.push(
			new AudioData({
				format: "f32-planar",
				sampleRate,
				numberOfFrames: frameLen,
				numberOfChannels: channels,
				timestamp: template.timestamp,
				data,
			}),
		);
		offset += frameLen;
	}

	return out;
}
