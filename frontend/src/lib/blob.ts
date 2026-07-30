/**
 * TypeScript 5.7 made typed arrays generic over their backing buffer, so a
 * `Uint8Array<ArrayBufferLike>` coming out of a library no longer satisfies
 * `BlobPart` (which insists on `ArrayBuffer`, not `SharedArrayBuffer`). The
 * values here are always plain array buffers; this keeps the assertion in one
 * place instead of scattering casts through the components.
 */
export function toBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type })
}

/** Same reasoning, for handing PCM to Web Audio. */
export function asAudioSamples(samples: Float32Array): Float32Array<ArrayBuffer> {
  return samples as Float32Array<ArrayBuffer>
}
