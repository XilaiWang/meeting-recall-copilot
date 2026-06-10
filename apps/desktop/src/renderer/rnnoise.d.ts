// Ambient declarations for @timephy/rnnoise-wasm internal paths not in package exports.
// Why: moduleResolution "Bundler" respects exports map; these subpaths are internal-only,
// so we declare them here rather than patching the package.

declare module '@timephy/rnnoise-wasm/dist/generated/rnnoise-sync.js' {
  function createRNNWasmModuleSync(moduleArg?: object): object;
  export default createRNNWasmModuleSync;
}

declare module '@timephy/rnnoise-wasm/dist/RnnoiseProcessor.js' {
  interface IRnnoiseModule {
    _rnnoise_create: () => number;
    _rnnoise_destroy: (context: number) => void;
    _rnnoise_process_frame: (context: number, input: number, output: number) => number;
  }
  class RnnoiseProcessor {
    constructor(wasmInterface: IRnnoiseModule);
    getSampleLength(): number;
    getRequiredPCMFrequency(): number;
    destroy(): void;
    calculateAudioFrameVAD(pcmFrame: Float32Array): number;
    processAudioFrame(pcmFrame: Float32Array, shouldDenoise?: boolean): number;
  }
  export { IRnnoiseModule };
  export default RnnoiseProcessor;
}
