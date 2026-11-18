// Keyframes: the moves, how it renders, one-take positions, carried timing, prompts and keys; the plan's keyframes,
// continued end frame and graph patch; and the service against a stand-in studio.   node test/keyframes.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { carriedSeconds, Keyframes, KF_OVERLAP, modeOf, movePrompt, moveKey, movesOf, oneTakePlan, oneTakeProblem, oneTakePrompt, totalSeconds } from '../src/service/keyframes.js'
import { applyPatch, KEYFRAME_MAX, planFinish, planPreviews, resolveFrames } from '../src/service/plan.js'

let n = 0
let failed = 0
const ok = async (name, fn) => {
  try {
    await fn()
    n++
    console.log(`ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL ${name} -> ${err.message}`)
  }
}
const pic = (id) => ({ id, file: `/p/${id}.png`, name: id })
const kf = (count, extra = {}) => ({ pictures: Array.from({ length: count }, (_, i) => pic(`p${i + 1}`)), pace: 4, moveSet: {}, join: 'auto', ...extra })

await ok('moves go picture to picture, and a loop adds the way back', () => {
  assert.deepEqual(movesOf(kf(3)).map((m) => [m.from.id, m.to.id]), [['p1', 'p2'], ['p2', 'p3']])
  const looped = movesOf(kf(3, { loop: true }))
  assert.deepEqual(looped.map((m) => [m.from.id, m.to.id]), [['p1', 'p2'], ['p2', 'p3'], ['p3', 'p1']])
  assert.equal(looped.at(-1).loopBack, true)
  assert.deepEqual(movesOf(kf(1)), [])
})
await ok('a move keeps its own seconds and line, by its pictures, within 2 to 15 s', () => {
  const k = kf(3, { moveSet: { 'p2>p3': { seconds: 7, line: 'she turns' }, 'p1>p2': { seconds: 40 } } })
  const m = movesOf(k)
  assert.deepEqual(m.map((x) => x.seconds), [15, 7])
  assert.equal(m[1].line, 'she turns')
  assert.equal(totalSeconds(m), 22)
})
await ok('auto: one take when it fits and the node is there, else a carried chain', () => {
  assert.equal(modeOf(kf(3)), 'onetake')
  assert.equal(modeOf(kf(3), { hasKeyframes: false }), 'carried')
  assert.equal(modeOf(kf(5)), 'carried', '4 moves of 4 s is 16 s')
  assert.equal(modeOf(kf(KEYFRAME_MAX + 1, { pace: 2 })), 'carried', 'too many pictures for one take')
  assert.equal(modeOf(kf(3, { join: 'plain' })), 'plain')
  assert.equal(modeOf(kf(5, { join: 'onetake' })), null)
  assert.match(oneTakeProblem(kf(5)), /15 s at most/)
  assert.match(oneTakeProblem(kf(3), { hasKeyframes: false }), /Multishot/)
})
await ok('one take: the pictures at their frames, the last on the last frame, the first again when looped', () => {
  const p = oneTakePlan(kf(3))
  assert.equal(p.seconds, 8)
  assert.equal(p.frames, resolveFrames(8))
  assert.deepEqual(p.pictures.map((x) => x.id), ['p1', 'p2', 'p3'])
  assert.equal(p.positions[0], 0)
  assert.equal(p.positions.at(-1), p.frames - 1)
  assert.ok(Math.abs(p.positions[1] - (p.frames - 1) / 2) <= 1)
  const l = oneTakePlan(kf(2, { loop: true, pace: 3 }))
  assert.deepEqual(l.pictures.map((x) => x.id), ['p1', 'p2', 'p1'])
})
await ok('a carried move asks for its seconds plus the frames it pins', () => {
  assert.equal(carriedSeconds({ seconds: 4 }), +(4 + KF_OVERLAP / 24).toFixed(3))
  assert.equal(carriedSeconds({ seconds: 15 }), 15)
})
await ok('prompts: the idea and the move’s line; one take lists each line', () => {
  const k = kf(3, { idea: 'A slow loft photoshoot.', moveSet: { 'p2>p3': { line: 'she turns to the window' } } })
  assert.equal(movePrompt(k, movesOf(k)[1]), 'A slow loft photoshoot. she turns to the window')
  assert.match(movePrompt({ ...k, idea: '' }, movesOf(k)[0]), /comes to life/)
  assert.match(oneTakePrompt(k), /A slow loft photoshoot\.\nFrom picture 2 to 3: she turns to the window/)
})
await ok('a move’s key follows its pictures, length, words, shape and (carried) the clip before', () => {
  const k = kf(3, { aspect: '16:9', megapixels: 0.6 })
  const m = movesOf(k)[1]
  const key = moveKey(k, m, 'carried', '/a.mp4')
  assert.notEqual(moveKey(k, { ...m, seconds: 5 }, 'carried', '/a.mp4'), key)
  assert.notEqual(moveKey(k, m, 'carried', '/b.mp4'), key)
  assert.notEqual(moveKey({ ...k, aspect: '9:16' }, m, 'carried', '/a.mp4'), key)
  assert.equal(moveKey(k, m, 'carried', '/a.mp4'), key)
})

// ---------- the plan ----------
const media = (files, kind = 'picture') => files.map((f) => ({ kind, file: f }))
await ok('plan: one take swaps node 204 for H3Keyframes with the pictures at their frames, kept in the finish', () => {
  const p = planPreviews({ prompt: 'x', character: 'none', mode: 'frames', seconds: 8, media: media(['a.png', 'b.png', 'c.png']), keyframes: { positions: [0, 95, 191] } }, [])
  assert.equal(p.patch['204'].class_type, 'H3Keyframes')
  assert.equal(p.patch['204'].inputs.positions, '0, 95, 191')
  assert.deepEqual(p.patch['204'].inputs.image_3, ['203', 2])
  const g = applyPatch({ 204: { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], first_frame: ['203', 0], last_frame: ['203', 1], length: ['502', 1] } } }, p.patch)
  assert.equal(g['204'].class_type, 'H3Keyframes')
  assert.equal(g['204'].inputs.first_frame, undefined)
  assert.deepEqual(g['204'].inputs.clip, ['2', 0], 'the rest of its inputs stay')
  assert.deepEqual(planFinish(p, { candidate: 1 }).patch, p.patch)
  assert.throws(() => planPreviews({ prompt: 'x', character: 'none', mode: 'frames', media: media(['a.png']), keyframes: { positions: [0] } }, []), /2 to 6 pictures/)
  assert.throws(() => planPreviews({ prompt: 'x', character: 'none', mode: 'frames', media: media(['a.png', 'b.png']), keyframes: { positions: [0] } }, []), /one keyframe position per picture/)
  assert.throws(() => planPreviews({ prompt: 'x', character: 'none', mode: 'frames', media: media(['a.png', 'b.png', 'c.png']) }, []), /1 picture .* or 2/)
})
await ok('plan: a continued shot with a picture ends on it; without one it is as before', () => {
  const p = planPreviews({ prompt: 'x', character: 'none', mode: 'continue', media: [...media(['v.mp4'], 'video'), ...media(['end.png'])] }, [])
  assert.deepEqual(p.values['611.last_frame'], ['603', 0])
  assert.equal(p.patch, undefined)
  const q = planPreviews({ prompt: 'x', character: 'none', mode: 'continue', media: media(['v.mp4'], 'video') }, [])
  assert.equal(q.values['611.last_frame'], undefined)
  assert.throws(() => planPreviews({ prompt: 'x', character: 'none', mode: 'continue', media: [...media(['v.mp4'], 'video'), ...media(['a.png', 'b.png'])] }, []), /one picture at most/)
})

// ---------- the service, with a stand-in studio ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ivkf-'))
const files = ['one', 'two', 'three', 'four', 'five'].map((x) => {
  const f = path.join(tmp, `${x}.png`)
  fs.writeFileSync(f, x)
  return f
})
const song = path.join(tmp, 'song.wav')
fs.writeFileSync(song, 'wav')
const clipFile = (name) => {
  const f = path.join(tmp, `${name}.mp4`)
  fs.writeFileSync(f, '')
  return f
}
let hasKf = true
const studio = {
  jobs: {},
  projects: [],
  comfy: { objectInfo: async () => (hasKf ? { H3Keyframes: {} } : {}) },
  createProject(name) {
    const p = { id: `p${this.projects.length + 1}`, name }
    this.projects.push(p)
    return p
  },
  deleteProject() {},
  async generatePreviews(r) {
    const j = { id: `j${Object.keys(this.jobs).length + 1}`, kind: 'previews', status: 'success', request: r, outputs: [] }
    this.jobs[j.id] = j
    return j
  },
  async finishCandidate(r) {
    const prev = this.jobs[r.jobId].request
    const kind = prev.mode === 'continue' ? 'continued_before_dlss' : r.upscale2x === false ? 'before_dlss' : 'final'
    const j = { id: `f${Object.keys(this.jobs).length + 1}`, kind: 'finish', status: 'success', request: r, outputs: [{ kind, path: clipFile(`clip${Object.keys(this.jobs).length}`) }] }
    this.jobs[j.id] = j
    return j
  },
  getJob(id) {
    return this.jobs[id]
  },
  publicJob: (j) => j,
  async refreshJob() {}
}
const edits = { created: [], create(name) { const e = { id: `e${this.created.length + 1}`, name, settings: {}, media: {}, clips: [], tracks: [], markers: [] }; this.created.push(e); return e }, async addMedia(file) { return { id: `${path.basename(file)}${Math.random()}`, file, duration: 4, kind: /\.wav$/.test(file) ? 'audio' : 'video' } }, write() {} }
const kfs = new Keyframes({ dataDir: tmp, studio, edits })

await ok('create copies the pictures in; reorder, remove and settings save', () => {
  const k = kfs.create({ name: 'Loft', pictures: files.slice(0, 3), idea: 'A loft photoshoot.' })
  assert.equal(k.pictures.length, 3)
  assert.ok(k.pictures.every((p) => p.file.startsWith(path.join(tmp, 'keyframes', k.id)) && fs.existsSync(p.file)))
  const order = [k.pictures[2].id, k.pictures[0].id, k.pictures[1].id]
  assert.deepEqual(kfs.reorder(k.id, order).pictures.map((p) => p.id), order)
  assert.throws(() => kfs.reorder(k.id, order.slice(1)), /every picture/)
  kfs.reorder(k.id, [order[1], order[2], order[0]])
  const s = kfs.save(k.id, { join: 'plain', pace: 3, move: { key: `${k.pictures[0].id}>${k.pictures[1].id}`, seconds: 5, line: 'she smiles' } })
  assert.equal(movesOf(kfs.get(k.id))[0].seconds, 5)
  assert.equal(movesOf(kfs.get(k.id))[1].seconds, 3)
  assert.equal(s.join, 'plain')
  kfs.save(k.id, { join: 'auto' })
  globalThis.loft = k.id
})
await ok('one take: one hunt with every picture at its frame, then the usual finish, then an edit', async () => {
  const id = globalThis.loft
  const j = await kfs.hunt(id)
  const r = studio.jobs[j.id].request
  assert.equal(r.mode, 'frames')
  assert.equal(r.media.length, 3)
  assert.deepEqual(r.keyframes.positions[0], 0)
  assert.equal(r.seconds, 8)
  await kfs.finish(id)
  const v = await kfs.refresh(id)
  assert.equal(v.mode, 'onetake')
  assert.equal(v.take.state.fresh, true)
  assert.equal(v.finished, 1)
  const a = await kfs.assemble(id)
  const e = edits.created.at(-1)
  assert.equal(e.clips.filter((c) => c.track === 'V1').length, 1)
  assert.equal(a.seconds, 4)
})
await ok('carried: move 1 is first/last frame, finished without DLSS; move 2 continues it and ends on its picture', async () => {
  const k = kfs.create({ pictures: files.slice(0, 4), join: 'carried', megapixels: 0.9 })
  await assert.rejects(() => kfs.hunt(k.id, 1), /Finish move 1 first/)
  const j1 = await kfs.hunt(k.id, 0)
  assert.equal(studio.jobs[j1.id].request.mode, 'frames')
  const f1 = await kfs.finish(k.id, 0)
  assert.equal(studio.jobs[f1.id].request.upscale2x, false)
  assert.equal(studio.jobs[f1.id].request.megapixels, 0.9)
  const j2 = await kfs.hunt(k.id, 1)
  const r2 = studio.jobs[j2.id].request
  assert.equal(r2.mode, 'continue')
  assert.equal(r2.overlapFrames, KF_OVERLAP)
  assert.equal(r2.media[0].kind, 'video')
  assert.equal(r2.media[0].file, studio.jobs[f1.id].outputs[0].path, 'continues move 1’s finished clip')
  assert.equal(r2.media[1].file, kfs.get(k.id).pictures[2].file, 'ends on picture 3')
  assert.equal(r2.seconds, carriedSeconds(movesOf(kfs.get(k.id))[1]))
  await kfs.finish(k.id, 1)
  let v = await kfs.refresh(k.id)
  assert.deepEqual(v.moves.map((m) => m.state.fresh), [true, true, false])
  assert.deepEqual(v.moves.map((m) => m.state.ready), [true, true, true])
  await assert.rejects(() => kfs.assemble(k.id), /Finish every move first/)
  // changing move 1 makes move 2 changed too: it carries on from move 1's clip
  kfs.save(k.id, { move: { key: v.moves[0].key, line: 'new' } })
  v = await kfs.refresh(k.id)
  assert.deepEqual(v.moves.map((m) => m.state.fresh), [false, false, false])
  assert.equal(v.moves[1].state.ready, false)
})
await ok('Hunt all: a carried chain starts only its next move; plain starts every move', async () => {
  const c = kfs.create({ pictures: files.slice(0, 3), join: 'carried' })
  assert.deepEqual((await kfs.huntAll(c.id)).started.map((s) => s.index), [0])
  const p = kfs.create({ pictures: files.slice(0, 4), join: 'plain' })
  assert.deepEqual((await kfs.huntAll(p.id)).started.map((s) => s.index), [0, 1, 2])
})
await ok('plain: moves back to back on V1, the song on A1 with their sound muted', async () => {
  const k = kfs.create({ pictures: files.slice(0, 3), join: 'plain', song: { file: song, name: 'Song' } })
  assert.equal(kfs.get(k.id).sound, 'song')
  for (const i of [0, 1]) {
    await kfs.hunt(k.id, i)
    await kfs.finish(k.id, i)
  }
  await kfs.assemble(k.id)
  const e = edits.created.at(-1)
  const v1 = e.clips.filter((c) => c.track === 'V1')
  assert.deepEqual(v1.map((c) => c.start), [0, 4])
  assert.ok(v1.every((c) => c.muted))
  assert.equal(e.clips.filter((c) => c.track === 'A1').length, 1)
})
await ok('one take is refused with a reason when this ComfyUI lacks the node; auto then chains', async () => {
  hasKf = false
  const k = kfs.create({ pictures: files.slice(0, 3), join: 'onetake' })
  await assert.rejects(() => kfs.hunt(k.id), /Multishot/)
  kfs.save(k.id, { join: 'auto' })
  assert.equal((await kfs.refresh(k.id)).mode, 'carried')
  hasKf = true
})
await ok('delete removes it and its pictures', () => {
  const id = globalThis.loft
  kfs.delete(id)
  assert.ok(!fs.existsSync(path.join(tmp, 'keyframes', id)))
  assert.ok(!kfs.list().some((x) => x.id === id))
})
fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `${failed} failed, ${n} passed` : `all ${n} passed`)
process.exit(failed ? 1 : 0)
