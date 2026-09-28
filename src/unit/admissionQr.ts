import jsQR from 'jsqr'
import QRCode from 'qrcode'

const QR_PREFIX = 'ARGUS-ADMISSION-QR-1:'

function base64url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64url(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function transform(bytes: Uint8Array, format: 'gzip', decompress = false) {
  const stream = decompress ? new DecompressionStream(format) : new CompressionStream(format)
  const writer = stream.writable.getWriter()
  await writer.write(bytes as Uint8Array<ArrayBuffer>)
  await writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

/** Compresses the large, signed admission package so it fits into one scannable QR image. */
export async function admissionQrPayload(admissionCode: string) {
  const compressed = await transform(new TextEncoder().encode(admissionCode), 'gzip')
  return `${QR_PREFIX}${base64url(compressed)}`
}

export async function admissionQrDataUrl(admissionCode: string) {
  return QRCode.toDataURL(await admissionQrPayload(admissionCode), { errorCorrectionLevel: 'L', margin: 2, width: 720 })
}

export async function admissionCodeFromQrPayload(payload: string) {
  if (!payload.startsWith(QR_PREFIX)) throw new Error('That image is not an A.R.G.U.S. admission QR code.')
  try {
    return new TextDecoder().decode(await transform(fromBase64url(payload.slice(QR_PREFIX.length)), 'gzip', true))
  } catch (cause) {
    throw new Error('That admission QR code is damaged.', { cause })
  }
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(), url = URL.createObjectURL(file)
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be opened.')) }
    image.src = url
  })
}

/** Reads a QR from a camera photo or saved/shared image without uploading it anywhere. */
export async function admissionCodeFromQrImage(file: File) {
  const image = await loadImage(file)
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser cannot read QR images.')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const decoded = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
  if (!decoded) throw new Error('No QR code was found in that image. Try a clearer, closer picture.')
  return admissionCodeFromQrPayload(decoded.data)
}

export async function qrFile(dataUrl: string, name = 'argus-admission.png') {
  const blob = await (await fetch(dataUrl)).blob()
  return new File([blob], name, { type: 'image/png' })
}
