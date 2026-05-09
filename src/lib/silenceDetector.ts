/**
 * RMS-based silence detection.
 *
 * Slides a window across each channel of an AudioBuffer, marks windows whose
 * peak RMS falls below `thresholdDb`, and emits the runs that are at least
 * `minSilenceMs` long. Each emitted range is shrunk by `paddingMs` on both
 * sides so cuts leave breathing room (avoids clipping the start/end of words).
 *
 * Designed to feed straight into the editor's `TrimRegion[]` — runs of
 * silence become trim regions that hide that span on playback/export.
 */

const DB_FLOOR = -120;

export interface SilenceDetectionOptions {
	/** Silence threshold in dBFS. Window RMS at or below this counts as silence. */
	thresholdDb: number;
	/** Minimum run length, in milliseconds, before a silence is reported. */
	minSilenceMs: number;
	/**
	 * Keep `paddingMs` of audio at the start AND end of each detected silence,
	 * so cuts don't clip the tail of words. Set to 0 to cut tight.
	 */
	paddingMs: number;
	/** Analysis window length, in milliseconds. Smaller = more precise, slower. */
	windowMs?: number;
}

export interface SilenceRange {
	startMs: number;
	endMs: number;
}

export interface SilenceDetectionResult {
	ranges: SilenceRange[];
	/** Total duration of detected silences in ms (post-padding). */
	totalSilenceMs: number;
	/** Number of windows analysed — exposed for tests / debugging. */
	windowCount: number;
}

const DEFAULT_WINDOW_MS = 20;

export const DEFAULT_SILENCE_OPTIONS: SilenceDetectionOptions = {
	thresholdDb: -40,
	minSilenceMs: 400,
	paddingMs: 150,
	windowMs: DEFAULT_WINDOW_MS,
};

export const MIN_THRESHOLD_DB = -80;
export const MAX_THRESHOLD_DB = -10;
export const MIN_SILENCE_DURATION_MS = 100;
export const MAX_SILENCE_DURATION_MS = 5000;
export const MIN_PADDING_MS = 0;
export const MAX_PADDING_MS = 500;

/**
 * Detect silent ranges in an `AudioBuffer`.
 *
 * Multi-channel audio is collapsed by taking the loudest channel per window —
 * a quiet voiceover on the right channel is still treated as speech. RMS is
 * computed on Float32 samples already in [-1, 1], so no scaling needed.
 */
export function detectSilences(
	buffer: AudioBuffer,
	options: SilenceDetectionOptions = DEFAULT_SILENCE_OPTIONS,
): SilenceDetectionResult {
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
	const sampleRate = buffer.sampleRate;
	const totalSamples = buffer.length;
	const totalDurationMs = (totalSamples / sampleRate) * 1000;
	const samplesPerWindow = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
	const windowCount = Math.ceil(totalSamples / samplesPerWindow);

	if (windowCount === 0 || totalDurationMs <= 0) {
		return { ranges: [], totalSilenceMs: 0, windowCount: 0 };
	}

	const channels: Float32Array[] = [];
	for (let i = 0; i < buffer.numberOfChannels; i++) {
		channels.push(buffer.getChannelData(i));
	}

	const thresholdAmp = dbToAmplitude(options.thresholdDb);
	const minSilenceWindows = Math.max(1, Math.ceil(options.minSilenceMs / windowMs));

	const ranges: SilenceRange[] = [];
	let runStart = -1;

	for (let w = 0; w < windowCount; w++) {
		const start = w * samplesPerWindow;
		const end = Math.min(start + samplesPerWindow, totalSamples);

		let maxRms = 0;
		for (const channelData of channels) {
			let sumSq = 0;
			for (let i = start; i < end; i++) {
				const s = channelData[i];
				sumSq += s * s;
			}
			const rms = Math.sqrt(sumSq / (end - start));
			if (rms > maxRms) maxRms = rms;
		}

		const isSilent = maxRms <= thresholdAmp;
		if (isSilent) {
			if (runStart === -1) runStart = w;
		} else if (runStart !== -1) {
			emitRunIfLongEnough(ranges, runStart, w - 1, minSilenceWindows, windowMs, options);
			runStart = -1;
		}
	}
	if (runStart !== -1) {
		emitRunIfLongEnough(ranges, runStart, windowCount - 1, minSilenceWindows, windowMs, options);
	}

	const clamped = clampAndMergeRanges(ranges, totalDurationMs);
	const totalSilenceMs = clamped.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
	return { ranges: clamped, totalSilenceMs, windowCount };
}

function emitRunIfLongEnough(
	out: SilenceRange[],
	firstWindow: number,
	lastWindow: number,
	minSilenceWindows: number,
	windowMs: number,
	options: SilenceDetectionOptions,
) {
	const runWindowCount = lastWindow - firstWindow + 1;
	if (runWindowCount < minSilenceWindows) return;

	const startMs = firstWindow * windowMs + options.paddingMs;
	const endMs = (lastWindow + 1) * windowMs - options.paddingMs;
	if (endMs - startMs < windowMs) return;
	out.push({ startMs, endMs });
}

function clampAndMergeRanges(ranges: SilenceRange[], totalMs: number): SilenceRange[] {
	if (ranges.length === 0) return ranges;
	const out: SilenceRange[] = [];
	for (const r of ranges) {
		const startMs = Math.max(0, Math.round(r.startMs));
		const endMs = Math.min(Math.round(totalMs), Math.round(r.endMs));
		if (endMs <= startMs) continue;
		const last = out[out.length - 1];
		if (last && startMs <= last.endMs) {
			last.endMs = Math.max(last.endMs, endMs);
		} else {
			out.push({ startMs, endMs });
		}
	}
	return out;
}

function dbToAmplitude(db: number): number {
	if (db <= DB_FLOOR) return 0;
	return 10 ** (db / 20);
}

export function clampSilenceOptions(opts: SilenceDetectionOptions): SilenceDetectionOptions {
	return {
		thresholdDb: clamp(opts.thresholdDb, MIN_THRESHOLD_DB, MAX_THRESHOLD_DB),
		minSilenceMs: clamp(opts.minSilenceMs, MIN_SILENCE_DURATION_MS, MAX_SILENCE_DURATION_MS),
		paddingMs: clamp(opts.paddingMs, MIN_PADDING_MS, MAX_PADDING_MS),
		windowMs: opts.windowMs,
	};
}

function clamp(value: number, min: number, max: number) {
	if (Number.isNaN(value)) return (min + max) / 2;
	return Math.min(max, Math.max(min, value));
}

/**
 * Decode an audio file URL into an `AudioBuffer`.
 *
 * In Electron, `file://` URLs are not directly fetchable from the renderer,
 * so we route them through the IPC bridge (same path StreamingVideoDecoder
 * uses for source loads). Remote / blob / data URLs fall through to `fetch`.
 *
 * Caller owns the AudioContext lifecycle when one is passed in; otherwise
 * we close the temporary context after decoding.
 */
export async function decodeAudioFromUrl(
	url: string,
	audioContext?: AudioContext,
): Promise<AudioBuffer> {
	const ctx = audioContext ?? new AudioContext();
	try {
		const arrayBuffer = await fetchAudioBytes(url);
		return await ctx.decodeAudioData(arrayBuffer);
	} finally {
		if (!audioContext) {
			void ctx.close();
		}
	}
}

async function fetchAudioBytes(url: string): Promise<ArrayBuffer> {
	const isRemoteUrl = /^(https?:|blob:|data:)/i.test(url);
	const electronApi = (globalThis as { electronAPI?: ElectronReadBinaryAPI }).electronAPI;

	if (!isRemoteUrl && electronApi?.readBinaryFile) {
		const result = await electronApi.readBinaryFile(url);
		if (!result.success || !result.data) {
			throw new Error(result.message ?? result.error ?? "Failed to read audio source");
		}
		return result.data;
	}

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch audio source: ${response.status} ${response.statusText}`);
	}
	return await response.arrayBuffer();
}

interface ElectronReadBinaryAPI {
	readBinaryFile?: (filePath: string) => Promise<{
		success: boolean;
		data?: ArrayBuffer;
		message?: string;
		error?: string;
	}>;
}
