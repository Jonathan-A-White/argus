import { afterEach, describe, expect, it, vi } from 'vitest'
import { admissionCodeFromQrPayload, admissionQrDataUrl, admissionQrPayload } from './admissionQr'

describe('admission QR transfer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('compresses and restores the complete device-bound admission package', async () => {
    const code = `ARGUS-ADMIT-1:${'signed-and-encrypted-device-data'.repeat(120)}:deadbeef`
    const payload = await admissionQrPayload(code)

    expect(payload).toMatch(/^ARGUS-ADMISSION-QR-1:/)
    expect(payload.length).toBeLessThan(code.length)
    await expect(admissionCodeFromQrPayload(payload)).resolves.toBe(code)
  })

  it('renders a self-contained PNG QR image', async () => {
    const image = await admissionQrDataUrl('ARGUS-ADMIT-1:payload:deadbeef')
    expect(image).toMatch(/^data:image\/png;base64,/)
  })

  it('reads the compression stream concurrently so browser backpressure cannot leave the QR pending', async () => {
    class BackpressuredCompressionStream {
      readable: ReadableStream<Uint8Array>
      writable: WritableStream<Uint8Array>

      constructor() {
        const stream = new TransformStream<Uint8Array, Uint8Array>()
        this.readable = stream.readable
        this.writable = stream.writable
      }
    }
    vi.stubGlobal('CompressionStream', BackpressuredCompressionStream)
    vi.stubGlobal('DecompressionStream', BackpressuredCompressionStream)

    const code = `ARGUS-ADMIT-1:${'device-bound-admission'.repeat(300)}:deadbeef`
    const payload = await admissionQrPayload(code)
    await expect(admissionCodeFromQrPayload(payload)).resolves.toBe(code)
  })

  it('rejects an unrelated QR payload', async () => {
    await expect(admissionCodeFromQrPayload('https://example.test/')).rejects.toThrow('not an A.R.G.U.S. admission')
  })
})
