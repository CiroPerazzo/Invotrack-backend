import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function setup() {
  let handler
  const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: 'TOTAL: 121.00' } }] }))
  const source = readFileSync('supabase/functions/ocr-gpt4v/index.ts', 'utf8').replace(/^import .*$/m, '')
  new vm.Script(stripTypeScriptTypes(source)).runInNewContext({
    serve: (fn) => { handler = fn }, Deno: { env: { get: () => 'test-key' } },
    fetch, Response, console: { log: vi.fn(), error: vi.fn() },
  })
  return { fetch, send: (body) => handler(new Request('https://example.com', { method: 'POST', body: JSON.stringify(body) })) }
}

describe('OCR Edge Function', () => {
  it.each(['application/pdf', 'image/png'])('envía %s en el formato correcto a OpenAI', async (mimeType) => {
    const ctx = setup()
    const response = await ctx.send({ fileBase64: 'YWJj', mimeType, fileName: 'factura.pdf' })
    expect(response.status).toBe(200)
    const request = JSON.parse(ctx.fetch.mock.calls[0][1].body)
    const content = request.messages[0].content[1]
    expect(content).toEqual(mimeType === 'application/pdf'
      ? { type: 'file', file: { filename: 'factura.pdf', file_data: 'data:application/pdf;base64,YWJj' } }
      : { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'high' } })
    expect(await response.json()).toMatchObject({ rawText: 'TOTAL: 121.00' })
  })

  it.each([
    [{ mimeType: 'text/plain', fileBase64: 'YWJj' }, 400],
    [{ mimeType: 'application/pdf', fileBase64: '' }, 400],
    [{ mimeType: 'application/pdf', fileBase64: 'A'.repeat(14 * 1024 * 1024) }, 413],
  ])('rechaza archivos inválidos sin llamar al proveedor', async (body, status) => {
    const ctx = setup()
    expect((await ctx.send(body)).status).toBe(status)
    expect(ctx.fetch).not.toHaveBeenCalled()
  })
})
