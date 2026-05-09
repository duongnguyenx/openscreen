/**
 * Snippet audio preview for the editor.
 *
 * `renderAudioSnippet` decodes a slice of the source audio, optionally pushes
 * it through `enhanceAudio`, encodes the result as a 16-bit PCM WAV blob, and
 * returns a Blob URL the caller can hand straight to an `<audio>` element.
 *
 * The render is fully offline and finishes in well under a second for the
 * default snippet length, so no progress UI is needed.
 */

import { type AudioEnhanceOptions, enhanceAudio, measureLoudness } from "./audioEnhancer";
import { decodeAudioFromUrl } from "./silenceDetector";

export const DEFAULT_PREVIEW_DURATION_MS = 10_000;

export interface RenderSnippetOptions {
	/** Source video URL (file:// or blob:). */
	audioUrl: string;
	/** Start time in milliseconds. Clamped to ≥ 0. */
	startMs: number;
	/** Snippet length in milliseconds. Clamped to the buffer's remaining length. */
	durationMs?: number;
	/**
	 * When provided, the snippet runs through `enhanceAudio` with these options.
	 * Omit (or pass `undefined`) for an unprocessed reference clip.
	 */
	enhance?: AudioEnhanceOptions;
}

export interface AudioSnippetResult {
	url: string;
	durationMs: number;
	loudnessLufs: number;
	peakDb: number;
	/** Caller MUST invoke this when done playing to free the Blob URL. */
	revoke: () => void;
}

export async function renderAudioSnippet(
	options: RenderSnippetOptions,
): Promise<AudioSnippetResult> {
	const decodeCtx = new AudioContext();
	let decoded: AudioBuffer;
	try {
		decoded = await decodeAudioFromUrl(options.audioUrl, decodeCtx);
	} finally {
		void decodeCtx.close();
	}

	const sampleRate = decoded.sampleRate;
	const channels = decoded.numberOfChannels;
	const totalLengthSamples = decoded.length;

	const startMs = Math.max(0, options.startMs);
	const requestedMs = options.durationMs ?? DEFAULT_PREVIEW_DURATION_MS;

	const startSample = Math.min(totalLengthSamples, Math.round((startMs / 1000) * sampleRate));
	const remainingSamples = Math.max(0, totalLengthSamples - startSample);
	const requestedSamples = Math.max(0, Math.round((requestedMs / 1000) * sampleRate));
	const snippetSamples = Math.min(requestedSamples, remainingSamples);

	if (snippetSamples <= 0) {
		throw new Error("Selected position is past the end of the audio track");
	}

	const sliceCtx = new OfflineAudioContext(channels, snippetSamples, sampleRate);
	const sliceBuffer = sliceCtx.createBuffer(channels, snippetSamples, sampleRate);
	for (let c = 0; c < channels; c++) {
		const src = decoded.getChannelData(c).subarray(startSample, startSample + snippetSamples);
		sliceBuffer.copyToChannel(src.slice(), c);
	}

	const finalBuffer = options.enhance
		? await enhanceAudio(sliceBuffer, options.enhance)
		: sliceBuffer;

	const wav = encodeWav(finalBuffer);
	const blob = new Blob([wav], { type: "audio/wav" });
	const url = URL.createObjectURL(blob);
	const measurement = measureLoudness(finalBuffer);

	return {
		url,
		durationMs: (snippetSamples / sampleRate) * 1000,
		loudnessLufs: measurement.lufs,
		peakDb: measurement.peakDb,
		revoke: () => URL.revokeObjectURL(url),
	};
}

/**
 * Encode an AudioBuffer to a 16-bit PCM WAV file (ArrayBuffer). Interleaves
 * channels and clips to ±1.0. Header layout matches the canonical RIFF/WAVE
 * spec — Chrome / Electron play it back natively without extra muxing.
 */
function encodeWav(buffer: AudioBuffer): ArrayBuffer {
	const channels = buffer.numberOfChannels;
	const sampleRate = buffer.sampleRate;
	const length = buffer.length;
	const bitsPerSample = 16;
	const bytesPerSample = bitsPerSample / 8;
	const blockAlign = channels * bytesPerSample;
	const byteRate = sampleRate * blockAlign;
	const dataSize = length * blockAlign;
	const headerSize = 44;
	const totalSize = headerSize + dataSize;

	const arrayBuffer = new ArrayBuffer(totalSize);
	const view = new DataView(arrayBuffer);

	// RIFF header
	writeString(view, 0, "RIFF");
	view.setUint32(4, totalSize - 8, true);
	writeString(view, 8, "WAVE");

	// fmt subchunk
	writeString(view, 12, "fmt ");
	view.setUint32(16, 16, true); // subchunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);

	// data subchunk
	writeString(view, 36, "data");
	view.setUint32(40, dataSize, true);

	const channelData: Float32Array[] = [];
	for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));

	let offset = headerSize;
	for (let i = 0; i < length; i++) {
		for (let c = 0; c < channels; c++) {
			const s = Math.max(-1, Math.min(1, channelData[c][i]));
			const intSample = s < 0 ? s * 0x8000 : s * 0x7fff;
			view.setInt16(offset, intSample, true);
			offset += bytesPerSample;
		}
	}

	return arrayBuffer;
}

function writeString(view: DataView, offset: number, str: string) {
	for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
