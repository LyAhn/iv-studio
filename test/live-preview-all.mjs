// Live previews for every kind of render, not only shot hunts and finishes (offline, no ComfyUI):
// withLivePreviewAll wraps the model of each node that samples, one preview node per distinct model, with the
// tiny VAE that matches the model (taeh3 for H3 video, taesdxl for SDXL, else ComfyUI's own colour preview).
//   node test/live-preview-all.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { checkPrompt } from '../src/service/graph.js'
import { imageGraph } from '../src/service/images.js'
import { LIVE_NODE, withLivePreview, withLivePreviewAll } from '../src/service/remote.js'
import { retakeGraph, SEQUENCE_DEFAULTS, takeGraph } from '../src/service/sequence.js'

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`ok - ${name}`)
}
const template = JSON.parse(fs.readFileSync('resources/workflows/iv_studio_api.json', 'utf8'))
const tess = { id: 'tess', name: 'Tess Marlow', lora: 'MiniMax H3\\tess\\tess.safetensors', strength: 0.8, trigger: 't3ss4' }
const seq = { ...SEQUENCE_DEFAULTS, shots: [{ prompt: 'a' }, { prompt: 'b' }] }
const tiny = ['none', 'taeh3.safetensors', 'taesdxl_decoder.safetensors', 'taef1_decoder.safetensors']
const lives = (g) => Object.entries(g).filter(([k]) => k.startsWith(LIVE_NODE))

test('a one take: H3 Multishot samples through the preview node, with taeh3', () => {
  const { graph } = takeGraph({ template, seq, character: tess, name: 't' })
  const g = withLivePreviewAll(graph, { tinyVaes: tiny })
  assert.deepEqual(g.take.inputs.model, [LIVE_NODE, 0])
  assert.deepEqual(g[LIVE_NODE].inputs.model, ['char', 0])
  assert.equal(g[LIVE_NODE].inputs.tiny_vae, 'taeh3.safetensors')
  assert.deepEqual(checkPrompt(g), [])
})

test('a retake: H3 Retake samples through it; its scheduler keeps the plain model', () => {
  const { graph } = retakeGraph({ template, seq, character: tess, name: 't', sourcePath: 'C:/v.mp4', prompt: 'p', start: 1, end: 2, mode: 'both', seed: 1 })
  const g = withLivePreviewAll(graph, { tinyVaes: tiny })
  assert.deepEqual(g.retake.inputs.model, [LIVE_NODE, 0])
  assert.deepEqual(g.sigmas.inputs.model, ['char', 0])
  assert.deepEqual(checkPrompt(g), [])
})

test('without taeh3 on this PC, H3 falls back to ComfyUI’s colour preview', () => {
  const { graph } = takeGraph({ template, seq, character: tess, name: 't' })
  assert.equal(withLivePreviewAll(graph, { tinyVaes: ['none'] })[LIVE_NODE].inputs.tiny_vae, 'none')
})

test('pictures: every sampler of a set shares one preview node; SDXL gets taesdxl, H3 Image and Flux the colour preview', () => {
  const h3img = withLivePreviewAll(imageGraph({ family: 'h3image', unet: 'minimax_h3_image_pruned_int8_convrot.safetensors', te: 't', vae: 'v', prompt: 'p', width: 1024, height: 1024, count: 3, seed: 1, steps: 6, cfg: 1, prefix: 'x' }), { tinyVaes: tiny, size: 640 })
  assert.equal(lives(h3img).length, 1)
  assert.ok(Object.values(h3img).filter((n) => n.class_type === 'KSampler').every((n) => n.inputs.model[0] === LIVE_NODE))
  assert.equal(h3img[LIVE_NODE].inputs.tiny_vae, 'none', 'H3 Image has its own VAE, not H3 video’s')
  assert.equal(h3img[LIVE_NODE].inputs.max_resolution, 640)
  const sdxl = withLivePreviewAll(imageGraph({ family: 'sdxl', unet: 'sd_xl_base_1.0.safetensors', te: null, vae: null, prompt: 'p', width: 1024, height: 1024, count: 1, seed: 1, steps: 20, cfg: 6, prefix: 'x' }), { tinyVaes: tiny })
  assert.equal(sdxl[LIVE_NODE].inputs.tiny_vae, 'taesdxl_decoder.safetensors')
  assert.deepEqual(checkPrompt(h3img), [])
  assert.deepEqual(checkPrompt(sdxl), [])
})

test('two different models get one preview node each', () => {
  const g = {
    a: { class_type: 'UNETLoader', inputs: { unet_name: 'one.safetensors', weight_dtype: 'default' } },
    b: { class_type: 'UNETLoader', inputs: { unet_name: 'two.safetensors', weight_dtype: 'default' } },
    g1: { class_type: 'BasicGuider', inputs: { model: ['a', 0], conditioning: ['x', 0] } },
    g2: { class_type: 'CFGGuider', inputs: { model: ['b', 0], positive: ['x', 0], negative: ['x', 0], cfg: 1 } },
    g3: { class_type: 'BasicGuider', inputs: { model: ['a', 0], conditioning: ['x', 0] } }
  }
  const out = withLivePreviewAll(g)
  assert.equal(lives(out).length, 2)
  assert.deepEqual(out.g1.inputs.model, out.g3.inputs.model)
  assert.notDeepEqual(out.g1.inputs.model, out.g2.inputs.model)
})

test('a shot already wrapped is left alone; a graph with nothing to sample is unchanged', () => {
  const shot = withLivePreview(template, {})
  assert.deepEqual(withLivePreviewAll(shot, { tinyVaes: tiny }), shot)
  const plain = { s: { class_type: 'SaveImage', inputs: { images: ['x', 0], filename_prefix: 'p' } } }
  assert.deepEqual(withLivePreviewAll(plain), plain)
})

console.log(`\n${passed} passed`)
