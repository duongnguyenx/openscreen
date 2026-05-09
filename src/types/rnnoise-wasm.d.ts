declare module "@jitsi/rnnoise-wasm" {
	interface RNNoiseWasmModule {
		HEAPF32: Float32Array;
		_rnnoise_create: () => number;
		_rnnoise_destroy: (state: number) => void;
		_rnnoise_process_frame: (state: number, output: number, input: number) => number;
		_malloc: (size: number) => number;
		_free: (ptr: number) => void;
	}

	interface CreateRNNWasmOptions {
		locateFile?: (path: string, scriptDirectory: string) => string;
	}

	export function createRNNWasmModule(options?: CreateRNNWasmOptions): Promise<RNNoiseWasmModule>;
	export function createRNNWasmModuleSync(options?: CreateRNNWasmOptions): RNNoiseWasmModule;
}
