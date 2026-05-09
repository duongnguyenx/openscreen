/**
 * Auto-captions via Whisper (transformers.js / ONNX Runtime Web).
 *
 * One-shot pipeline:
 *   1. Decode the source video's audio track to a Float32 PCM @ 16 kHz mono
 *   2. Run Whisper through `@huggingface/transformers` (`pipeline()`)
 *   3. Convert each timestamped chunk into an `AnnotationRegion` text overlay
 *
 * Model + ORT runtime are downloaded lazily on first call, cached in
 * IndexedDB by transformers.js. Subsequent calls hit cache (~instant load).
 *
 * Why transformers.js: it bundles ORT-Web, handles tokenization, beam search,
 * and post-processing. Same engine that powers many production speech apps.
 * Trade-off: ~40 MB initial model download for tiny.en.
 */

import { v4 as uuidv4 } from "uuid";
import {
	type AnnotationRegion,
	type AnnotationTextStyle,
	DEFAULT_ANNOTATION_SIZE,
} from "@/components/video-editor/types";
import { decodeAudioFromUrl } from "./silenceDetector";

const TARGET_SAMPLE_RATE = 16_000;

export type CaptionLanguage = "en" | "multilingual";
export type CaptionStyle = "tiktok" | "youtube" | "subtle";
export type CaptionPosition = "top" | "center" | "bottom";

export interface GenerateCaptionsOptions {
	language: CaptionLanguage;
	style: CaptionStyle;
	position: CaptionPosition;
}

export interface GenerateCaptionsProgress {
	phase: "loadingModel" | "decoding" | "resampling" | "transcribing" | "building";
	/** 0..1 within the phase, or -1 if indeterminate. */
	percent: number;
}

export interface GenerateCaptionsResult {
	captions: AnnotationRegion[];
	totalSegments: number;
	transcribedSeconds: number;
}

export interface GenerateCaptionsHandle {
	/** AbortSignal-style cancel: marks state as aborted; the pipeline checks before each segment. */
	cancel: () => void;
}

export const DEFAULT_CAPTION_OPTIONS: GenerateCaptionsOptions = {
	language: "en",
	style: "tiktok",
	position: "bottom",
};

const MODEL_BY_LANGUAGE: Record<CaptionLanguage, string> = {
	en: "Xenova/whisper-tiny.en",
	multilingual: "Xenova/whisper-tiny",
};

interface WhisperChunk {
	text: string;
	timestamp: [number, number | null];
}

interface WhisperPipelineOutput {
	text: string;
	chunks?: WhisperChunk[];
}

type WhisperPipeline = (
	audio: Float32Array,
	options: Record<string, unknown>,
) => Promise<WhisperPipelineOutput | WhisperPipelineOutput[]>;

const pipelineCache = new Map<string, Promise<WhisperPipeline>>();

async function getPipeline(
	language: CaptionLanguage,
	onProgress?: (p: GenerateCaptionsProgress) => void,
): Promise<WhisperPipeline> {
	const key = MODEL_BY_LANGUAGE[language];
	const existing = pipelineCache.get(key);
	if (existing) return existing;

	const promise = (async () => {
		const { pipeline, env } = await import("@huggingface/transformers");
		// Disable local model lookups — we load straight from the Hugging Face CDN
		// and let transformers.js cache via IndexedDB.
		env.allowLocalModels = false;
		env.useBrowserCache = true;
		// Electron renderers (especially under file://) can't auto-resolve
		// onnxruntime-web's bundled WASM/JSEP files via `import.meta.url`.
		// Point transformers.js at the locally-vendored copies in public/wasm/ort/
		// (matched to the version transformers.js depends on, so no version skew).
		const ortBackend = env.backends?.onnx?.wasm;
		if (ortBackend) {
			ortBackend.wasmPaths = new URL("./wasm/ort/", window.location.href).href;
		}

		onProgress?.({ phase: "loadingModel", percent: -1 });

		console.log("[captions] Loading Whisper pipeline:", key);
		const transcriber = await pipeline("automatic-speech-recognition", key, {
			progress_callback: (data: unknown) => {
				const status = (data as { status?: string; progress?: number } | undefined)?.status;
				const progress = (data as { progress?: number } | undefined)?.progress;
				if (status === "progress" && typeof progress === "number") {
					onProgress?.({ phase: "loadingModel", percent: progress / 100 });
				}
			},
		});
		console.log("[captions] Pipeline ready");
		return transcriber as unknown as WhisperPipeline;
	})();

	pipelineCache.set(key, promise);
	return promise;
}

/**
 * Resample an `AudioBuffer` to 16 kHz mono Float32 PCM (Whisper's required format).
 */
async function resampleTo16kMono(buffer: AudioBuffer): Promise<Float32Array> {
	if (buffer.sampleRate === TARGET_SAMPLE_RATE && buffer.numberOfChannels === 1) {
		return buffer.getChannelData(0).slice();
	}

	const targetLength = Math.round((buffer.length / buffer.sampleRate) * TARGET_SAMPLE_RATE);
	const ctx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
	const source = ctx.createBufferSource();
	source.buffer = buffer;
	source.connect(ctx.destination);
	source.start();
	const rendered = await ctx.startRendering();
	return rendered.getChannelData(0).slice();
}

/** Caption-style preset → AnnotationTextStyle. Matches the existing annotation system. */
export function getCaptionStyle(preset: CaptionStyle): AnnotationTextStyle {
	switch (preset) {
		case "tiktok":
			return {
				color: "#ffffff",
				backgroundColor: "rgba(0, 0, 0, 0.7)",
				fontSize: 36,
				fontFamily: "Inter",
				fontWeight: "bold",
				fontStyle: "normal",
				textDecoration: "none",
				textAlign: "center",
			};
		case "youtube":
			return {
				color: "#ffffff",
				backgroundColor: "rgba(0, 0, 0, 0.85)",
				fontSize: 28,
				fontFamily: "Inter",
				fontWeight: "normal",
				fontStyle: "normal",
				textDecoration: "none",
				textAlign: "center",
			};
		case "subtle":
			return {
				color: "#ffffff",
				backgroundColor: "transparent",
				fontSize: 24,
				fontFamily: "Inter",
				fontWeight: "normal",
				fontStyle: "italic",
				textDecoration: "none",
				textAlign: "center",
			};
	}
}

// Caption layout: 70% wide, centered horizontally with 15% margin per side.
// The annotation `position` field is the TOP-LEFT corner in 0-100 coords, NOT
// the element center, so we have to bake the margin into x ourselves.
const CAPTION_WIDTH_PCT = 70;
const CAPTION_HEIGHT_PCT = 12;
const CAPTION_X_PCT = (100 - CAPTION_WIDTH_PCT) / 2;

/** Vertical TOP-LEFT y (in % of canvas) for the caption row. */
function getCaptionY(position: CaptionPosition): number {
	switch (position) {
		case "top":
			return 5;
		case "center":
			return (100 - CAPTION_HEIGHT_PCT) / 2;
		case "bottom":
			return 100 - CAPTION_HEIGHT_PCT - 5;
	}
}

/**
 * Generate captions from a video/audio URL. Returns AnnotationRegion[] ready
 * to be appended to `editorState.annotationRegions`.
 *
 * Cancellation: pass an `AbortSignal`. Once aborted, the pipeline rejects with
 * an "aborted" error and any partial work is discarded.
 */
export async function generateCaptions(
	audioUrl: string,
	options: GenerateCaptionsOptions,
	onProgress?: (p: GenerateCaptionsProgress) => void,
	signal?: AbortSignal,
): Promise<GenerateCaptionsResult> {
	if (signal?.aborted) throw new Error("aborted");

	// 1. Load the model (lazy, cached after first call)
	const transcriber = await getPipeline(options.language, onProgress);
	if (signal?.aborted) throw new Error("aborted");

	// 2. Decode audio
	onProgress?.({ phase: "decoding", percent: -1 });
	console.log("[captions] Decoding audio from", audioUrl);
	const decodeCtx = new AudioContext();
	let decoded: AudioBuffer;
	try {
		decoded = await decodeAudioFromUrl(audioUrl, decodeCtx);
	} finally {
		void decodeCtx.close();
	}
	console.log(
		`[captions] Decoded: ${decoded.duration.toFixed(2)}s @ ${decoded.sampleRate}Hz, ${decoded.numberOfChannels}ch`,
	);
	if (signal?.aborted) throw new Error("aborted");

	// 3. Resample to 16 kHz mono Float32
	onProgress?.({ phase: "resampling", percent: -1 });
	const pcm = await resampleTo16kMono(decoded);
	console.log(`[captions] Resampled to ${pcm.length} samples @ 16kHz mono`);
	if (signal?.aborted) throw new Error("aborted");

	// 4. Run Whisper with timestamps
	onProgress?.({ phase: "transcribing", percent: -1 });
	console.log("[captions] Running Whisper transcription…");
	const raw = await transcriber(pcm, {
		return_timestamps: true,
		chunk_length_s: 30,
		stride_length_s: 5,
		language: options.language === "multilingual" ? undefined : "english",
		task: "transcribe",
	});
	console.log("[captions] Whisper output:", raw);

	if (signal?.aborted) throw new Error("aborted");

	// transformers.js may return a single object or array — normalize
	const output: WhisperPipelineOutput = Array.isArray(raw) ? raw[0] : raw;
	const chunks = output.chunks ?? [];

	// 5. Build AnnotationRegion[]
	onProgress?.({ phase: "building", percent: 0 });
	const style = getCaptionStyle(options.style);
	const positionY = getCaptionY(options.position);
	const captions: AnnotationRegion[] = [];

	let currentZIndex = 1000; // start high so captions render above other annotations

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const text = chunk.text.trim();
		if (!text) continue;

		const startSec = chunk.timestamp[0];
		const endSecRaw = chunk.timestamp[1];
		// Whisper sometimes leaves the final chunk's end as null — extend to next
		// chunk's start, or fall back to startSec + 2s.
		const nextStart = i + 1 < chunks.length ? chunks[i + 1].timestamp[0] : null;
		const endSec = endSecRaw ?? (nextStart != null ? nextStart : startSec + 2);

		captions.push({
			id: `caption-${uuidv4()}`,
			startMs: Math.max(0, Math.round(startSec * 1000)),
			endMs: Math.max(Math.round(startSec * 1000) + 100, Math.round(endSec * 1000)),
			type: "text",
			content: text,
			textContent: text,
			position: { x: CAPTION_X_PCT, y: positionY },
			size: {
				...DEFAULT_ANNOTATION_SIZE,
				width: CAPTION_WIDTH_PCT,
				height: CAPTION_HEIGHT_PCT,
			},
			style,
			zIndex: currentZIndex++,
		});

		onProgress?.({
			phase: "building",
			percent: (i + 1) / Math.max(1, chunks.length),
		});
	}

	return {
		captions,
		totalSegments: captions.length,
		transcribedSeconds: decoded.duration,
	};
}
