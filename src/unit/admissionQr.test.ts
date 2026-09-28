import { describe, expect, it } from 'vitest'
import { admissionCodeFromQrPayload, admissionQrDataUrl, admissionQrPayload } from './admissionQr'

describe('admission QR transfer', () => {
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

  it('rejects an unrelated QR payload', async () => {
    await expect(admissionCodeFromQrPayload('https://example.test/')).rejects.toThrow('not an A.R.G.U.S. admission')
  })
})
