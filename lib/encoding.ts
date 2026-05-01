import Encoding from 'encoding-japanese'

export async function readTextFlexible(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!utf8Text.includes('\uFFFD')) {
    return utf8Text.replace(/^\uFEFF/, '')
  }

  const unicodeArray = Encoding.convert(Array.from(bytes), {
    to: 'UNICODE',
    from: 'SJIS',
    type: 'array',
  }) as number[]

  return Encoding.codeToString(unicodeArray).replace(/^\uFEFF/, '')
}

export function makeCp932Blob(text: string, mime = 'text/csv'): Blob {
  const sjisArray = Encoding.convert(Encoding.stringToCode(text), {
    to: 'SJIS',
    from: 'UNICODE',
    type: 'array',
  }) as number[]

  return new Blob([new Uint8Array(sjisArray)], { type: `${mime};charset=Shift_JIS` })
}
