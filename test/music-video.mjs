// Music video: bars, parts, the scene plan and its edits, the scene key and brief, and a real ffmpeg run of the
// song map and a scene's stretch on a made-up song.   node test/music-video.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-ffprobe-static'
import { barEnergy, barsOf, cleanCast, mergeScenes, moveCut, setCut, MusicVideos, MV_MAX, MV_MIN, planScenes, renderSeconds, sceneBrief, sceneKey, scenesProblems, sceneWho, sectionsOf, splitScene, withRefMentions } from '../src/service/musicvideo.js'
import { resolveMentions } from '../src/service/cast.js'
import { findBeats } from '../src/service/reel.js'

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
const RATE = 11025
// a made-up song: clicks every beat at bpm, quiet for the first `quiet` seconds and loud after (two parts)
function song(bpm, seconds, quiet = 0) {
  const s = new Float32Array(Math.round(seconds * RATE))
  let seed = 7
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  for (let k = 0; k < s.length; k++) s[k] = (k / RATE < quiet ? 0.02 : 0.12) * Math.sin((2 * Math.PI * 110 * k) / RATE)
  for (let t = 0.2; t < seconds; t += 60 / bpm)
    for (let k = 0; k < 400; k++) {
      const i = Math.round(t * RATE) + k
      if (i < s.length) s[i] += (t < quiet ? 0.25 : 0.9) * noise() * Math.exp(-k / 120)
    }
  return s
}
const plan = (samples) => {
  const duration = samples.length / RATE
  const beat = findBeats(samples, RATE)
  const bars = barsOf({ ...beat, duration })
  const sections = sectionsOf({ bars, energy: barEnergy(samples, RATE, bars, duration), duration })
  return { duration, beat, bars, sections, scenes: planScenes({ bars, sections, duration }) }
}

await ok('bars every 4 beats from 0, at the song’s tempo', () => {
  const { bars, beat } = plan(song(120, 40))
  assert.equal(bars[0], 0)
  const gaps = bars.slice(2).map((t, i) => t - bars[i + 1])
  assert.ok(gaps.every((g) => Math.abs(g - 2) < 0.06), `120 BPM bars are 2 s (${gaps.slice(0, 4).join(', ')}), heard ${beat.bpm}`)
})
await ok('no clear beat: an even 2 s grid', () => {
  const bars = barsOf({ beats: [], period: 0, strength: 0, duration: 9 })
  assert.deepEqual(bars, [0, 2, 4, 6, 8])
})
await ok('a quiet start and a loud rest are two parts, split on a bar', () => {
  const { sections, bars } = plan(song(120, 48, 16))
  assert.ok(sections.length >= 2, `${sections.length} parts`)
  assert.ok(bars.some((b) => Math.abs(b - sections[1].start) < 0.01), 'the second part starts on a bar line')
  assert.ok(Math.abs(sections[1].start - 16) <= 2.1, `the loud part starts near 16 s (${sections[1].start})`)
})
await ok('the scene plan covers the song, 2 to 15 s a scene, cut on bars', () => {
  for (const [bpm, secs, quiet] of [[120, 48, 16], [92, 75, 0], [140, 33, 8], [100, 7, 0]]) {
    const { scenes, duration, bars } = plan(song(bpm, secs, quiet))
    assert.deepEqual(scenesProblems(scenes, duration), [], `${bpm} BPM ${secs} s`)
    for (const s of scenes.slice(0, -1)) assert.ok(bars.some((b) => Math.abs(b - s.end) < 0.01) || s.end - s.start <= MV_MAX, 'cuts on bar lines')
  }
})
await ok('a 3-minute song comes out about 12 to 20 scenes', () => {
  const { scenes } = plan(song(120, 180, 30))
  assert.ok(scenes.length >= 12 && scenes.length <= 20, `${scenes.length} scenes`)
})
await ok('problems: gaps, too long, too short, not covering', () => {
  const s = (start, end) => ({ start, end })
  assert.deepEqual(scenesProblems([s(0, 10), s(10, 20)], 20), [])
  assert.ok(scenesProblems([s(0, 16), s(16, 20)], 20).some((p) => /15 s at most/.test(p)))
  assert.ok(scenesProblems([s(0, 1), s(1, 20)], 20).some((p) => /at least/.test(p)))
  assert.ok(scenesProblems([s(0, 10), s(11, 20)], 20).some((p) => /doesn't start/.test(p)))
  assert.ok(scenesProblems([s(0, 10)], 20).some((p) => /end with the song/.test(p)))
})
const bars8 = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]
const base = [{ id: 'a', start: 0, end: 12, prompt: 'first', cast: null, sings: true, media: [] }, { id: 'b', start: 12, end: 20, prompt: 'second', cast: null, sings: false, media: [] }]
await ok('split on the bar nearest the middle; the second half is blank', () => {
  const s = splitScene(base, 0, bars8)
  assert.deepEqual(s.map((x) => [x.start, x.end]), [[0, 6], [6, 12], [12, 20]])
  assert.equal(s[1].prompt, '')
  assert.throws(() => splitScene([{ start: 0, end: 3 }], 0, [0, 2]), /too short|at least/)
})
await ok('merge two scenes, but not past 15 s', () => {
  const s = mergeScenes(splitScene(base, 0, bars8), 0)
  assert.deepEqual(s.map((x) => [x.start, x.end]), [[0, 12], [12, 20]])
  assert.throws(() => mergeScenes(base, 0), /15 s at most/)
  assert.throws(() => mergeScenes(base, 1), /no scene after/)
})
await ok('move a cut by bars, keeping both scenes 2 to 15 s', () => {
  assert.deepEqual(moveCut(base, 0, -1, bars8).map((x) => [x.start, x.end]), [[0, 10], [10, 20]])
  assert.deepEqual(moveCut(base, 0, 1, bars8).map((x) => [x.start, x.end]), [[0, 14], [14, 20]])
  assert.throws(() => moveCut(base, 0, 2, bars8), /15 s at most/)
  assert.throws(() => moveCut(base, 0, 3, bars8), /at least|at most|no bar/)
  assert.throws(() => moveCut(base, 1, 1, bars8), /ends with the song/)
})
await ok('a dragged cut snaps to the nearest bar and stays within 2 to 15 s', () => {
  assert.deepEqual(setCut(base, 0, 9.3, bars8).map((x) => [x.start, x.end]), [[0, 10], [10, 20]])
  assert.deepEqual(setCut(base, 0, 9.3, bars8, { snap: false }).map((x) => [x.start, x.end]), [[0, 9.3], [9.3, 20]])
  assert.deepEqual(setCut(base, 0, 30, bars8).map((x) => [x.start, x.end]), [[0, 14], [14, 20]], 'held where scene 1 would pass 15 s... and scene 2 keeps 2 s')
  assert.deepEqual(setCut(base, 0, 1, bars8).map((x) => [x.start, x.end]), [[0, 6], [6, 20]], 'held where scene 2 would pass 15 s')
  assert.throws(() => setCut(base, 1, 18, bars8), /ends with the song/)
})
await ok('render seconds follow H3’s 17n+5 frame grid, never shorter than the scene', () => {
  for (const len of [2, 3.5, 7.25, 10, 14.9, 15]) assert.ok(renderSeconds(len) >= len - 0.001 && renderSeconds(len) - len < 0.75, `${len} -> ${renderSeconds(len)}`)
})
const mv = { name: 'Neon', idea: 'a band on a rooftop at night', aspect: '16:9', song: { file: 'x.wav', bpm: 120 }, cast: cleanCast([{ character: 'tess', part: 'lead singer', singer: true }, { character: 'ken', part: 'drums' }, { character: 'ann', part: 'guitar', singer: true }]), scenes: base }
const chars = [{ id: 'tess', name: 'Tess Brown' }, { id: 'ken', name: 'Ken' }, { id: 'ann', name: 'Ann' }]
await ok('one singer only; the singer leads a sung scene, the first cast member leads otherwise', () => {
  assert.deepEqual(mv.cast.map((c) => c.singer), [true, false, false])
  const sung = sceneWho(mv, base[0])
  assert.equal(sung.lead.character, 'tess')
  assert.deepEqual(sung.others.map((c) => c.character), ['ken', 'ann'])
  const inst = sceneWho(mv, { ...base[1], cast: [1, 2] })
  assert.equal(inst.singer, null)
  assert.equal(inst.lead.character, 'ken')
})
await ok('the brief names the cast, the singer and the closed-mouth rule', () => {
  const b = sceneBrief(mv, base[0], 0, chars)
  assert.match(b, /rooftop/)
  assert.match(b, /Tess \(lead singer\), Ken \(drums\), Ann \(guitar\)/)
  assert.match(b, /Tess sings the song's words/)
  assert.match(b, /Everyone else keeps their mouth closed/)
  assert.match(sceneBrief(mv, base[1], 1, chars), /No one sings in this scene: every mouth stays closed/)
})
await ok('the scene key changes with the prompt, the cut, the cast and the shape', () => {
  const k = sceneKey(mv, base[0])
  assert.notEqual(sceneKey(mv, { ...base[0], prompt: 'other' }), k)
  assert.notEqual(sceneKey(mv, { ...base[0], end: 10 }), k)
  assert.notEqual(sceneKey(mv, { ...base[0], cast: [0] }), k)
  assert.notEqual(sceneKey({ ...mv, aspect: '9:16' }, base[0]), k)
  assert.equal(sceneKey(mv, { ...base[0] }), k)
})

// ---------- with the bundled ffmpeg: map a real file, edit the plan, cut a scene's stretch ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ivmv-'))
const ff = ffmpegStatic.ffmpegPath
const run = (args) => {
  const r = spawnSync(ff, args, { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(String(r.stderr))
  return r.stdout
}
// the made-up song as a 44.1 kHz WAV, written raw and converted
const raw = path.join(tmp, 'song.f32')
fs.writeFileSync(raw, Buffer.from(song(120, 48, 16).buffer))
const wav = path.join(tmp, 'song.wav')
run(['-y', '-v', 'error', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', raw, '-ar', '44100', wav])
// a stand-in for a finished scene's video (assemble only checks it is there)
const clipFile = path.join(tmp, 'scene_final.mp4')
fs.writeFileSync(clipFile, '')
const edits = { run: async (a) => run(a), created: [], create(name) { const e = { id: `e${this.created.length + 1}`, name, settings: {}, media: {}, clips: [], tracks: [], markers: [] }; this.created.push(e); return e }, async addMedia(file) { return { id: path.basename(file) + Math.random(), file, duration: 48, kind: /\.wav$/.test(file) ? 'audio' : 'video' } }, write() {} }
const studio = { characters: () => chars, cast: { members: () => chars.map((c) => ({ handle: c.name.split(' ')[0] })) }, projects: [], createProject(name) { const p = { id: `p${this.projects.length + 1}`, name }; this.projects.push(p); return p }, deleteProject() {}, jobs: {}, async generatePreviews(r) { const j = { id: `j${Object.keys(this.jobs).length + 1}`, kind: 'previews', status: 'queued', request: r }; this.jobs[j.id] = j; return j }, async finishCandidate(r) { const j = { id: `f${Object.keys(this.jobs).length + 1}`, kind: 'finish', status: 'success', outputs: [{ kind: 'final', path: clipFile }], request: r }; this.jobs[j.id] = j; return j }, getJob(id) { return this.jobs[id] }, publicJob: (j) => j, async refreshJob() {} }
const mvs = new MusicVideos({ dataDir: tmp, studio, edits })
let made
await ok('create maps a real song and plans its scenes', async () => {
  made = await mvs.create({ song: wav, songName: 'Test song', cast: [{ character: 'tess', part: 'singer', singer: true }] })
  assert.ok(Math.abs(made.song.duration - 48) < 0.1, `${made.song.duration} s`)
  assert.ok(Math.abs(made.song.bpm - 120) < 2, `${made.song.bpm} BPM`)
  assert.deepEqual(scenesProblems(made.scenes, made.song.duration), [])
  assert.equal(mvs.list().length, 1)
})
await ok('scene edits go through and keep the plan sound; a bad plan is refused', async () => {
  const before = made.scenes.length
  let m = mvs.edit(made.id, { op: 'split', index: 0 })
  assert.equal(m.scenes.length, before + 1)
  m = mvs.edit(made.id, { op: 'merge', index: 0 })
  assert.equal(m.scenes.length, before)
  m = mvs.edit(made.id, { op: 'set', index: 0, prompt: '{char} sings on a rooftop at night.' })
  assert.equal(m.scenes[0].prompt, '{char} sings on a rooftop at night.')
  assert.throws(() => mvs.save(made.id, { scenes: [{ start: 0, end: 20 }] }), /15 s at most|end with the song/)
})
await ok('hunt cuts the scene’s stretch of the song and sends it as the voice line', async () => {
  const j = await mvs.hunt(made.id, 0)
  const r = studio.jobs[j.id].request
  const s = mvs.get(made.id).scenes[0]
  assert.equal(r.character, 'tess')
  assert.ok(fs.existsSync(r.voiceLine), 'the stretch is on disk')
  const secs = Number(/Duration: 00:00:(\d+\.\d+)/.exec(String(spawnSync(ff, ['-i', r.voiceLine]).stderr))?.[1])
  assert.ok(Math.abs(secs - renderSeconds(s.end - s.start)) < 0.05, `stretch ${secs} s for a ${renderSeconds(s.end - s.start)} s render`)
  assert.equal(r.seconds, +(s.end - s.start).toFixed(3))
  await assert.rejects(() => mvs.hunt(made.id, 1), /no prompt/)
})
await ok('finish keeps the stretch as the sound; the scene is then finished, and changed after an edit', async () => {
  await mvs.finish(made.id, 0, { candidate: 2 })
  const f = Object.values(studio.jobs).find((j) => j.kind === 'finish')
  assert.equal(f.request.audio, 'voice')
  assert.equal(f.request.candidate, 2)
  let v = mvs.view(made.id)
  assert.equal(v.scenes[0].state.fresh, true)
  assert.equal(v.finished, 1)
  mvs.edit(made.id, { op: 'set', index: 0, prompt: 'something else' })
  v = mvs.view(made.id)
  assert.equal(v.scenes[0].state.fresh, false)
  assert.equal(v.scenes[0].state.changed, true)
  mvs.edit(made.id, { op: 'set', index: 0, prompt: '{char} sings on a rooftop at night.' })
})
await ok('assemble: finished scenes on V1 (muted, trimmed to the scene), the song on A1, the rest listed as missing', async () => {
  const r = await mvs.assemble(made.id)
  const e = edits.created.at(-1)
  const v1 = e.clips.filter((c) => c.track === 'V1')
  const a1 = e.clips.filter((c) => c.track === 'A1')
  const s = mvs.get(made.id).scenes[0]
  assert.equal(v1.length, 1)
  assert.equal(v1[0].muted, true)
  assert.ok(Math.abs(v1[0].out - (s.end - s.start)) < 0.01)
  assert.equal(a1.length, 1)
  assert.equal(r.placed, 1)
  assert.equal(r.missing.length, mvs.get(made.id).scenes.length - 1)
})
await ok('write fills the scenes without a prompt from their briefs', async () => {
  const asked = []
  const r = await mvs.writePrompts(made.id, {}, async (req) => (asked.push(req), `{char} scene for ${req.seconds} s`))
  assert.equal(r.written.length, mvs.get(made.id).scenes.length - 1, 'every scene but the one with a prompt')
  assert.ok(asked.every((q) => /music video/.test(q.idea)))
})
await ok('references: add with a copied picture and a handle, rename, change kind, and a clash gets a number', async () => {
  const pic = path.join(tmp, 'blue cola.png')
  fs.writeFileSync(pic, 'png')
  let m = mvs.addRef(made.id, { picture: pic, kind: 'product', description: 'a red can with a white wave' })
  const r = m.refs[0]
  assert.equal(r.name, 'blue cola')
  assert.equal(r.handle, 'BlueCola')
  assert.ok(r.picture.startsWith(path.join(tmp, 'musicvideos', made.id)) && fs.existsSync(r.picture), 'copied into the music video')
  m = mvs.addRef(made.id, { picture: pic, name: 'Blue Cola', kind: 'thing' })
  assert.equal(m.refs[1].handle, 'BlueCola2')
  m = mvs.updateRef(made.id, m.refs[1].id, { name: 'Ken', kind: 'person' })
  assert.equal(m.refs[1].handle, 'Ken2', 'Ken is a character already')
  assert.equal(m.refs[1].kind, 'person')
  assert.throws(() => mvs.addRef(made.id, { picture: path.join(tmp, 'nope.png') }), /Pick a picture/)
})
await ok('a scene picks references; its key, brief and hunt follow them', async () => {
  let m = mvs.get(made.id)
  const [cola, ken] = m.refs
  const key0 = sceneKey(m, m.scenes[0])
  m = mvs.edit(made.id, { op: 'set', index: 0, refs: [cola.id, 'not-a-ref'] })
  assert.deepEqual(m.scenes[0].refs, [cola.id], 'unknown ids are dropped')
  assert.notEqual(sceneKey(m, m.scenes[0]), key0, 'adding a reference changes the scene')
  assert.match(sceneBrief(m, m.scenes[0], 0, chars), /the product blue cola \(a red can with a white wave\).*label to the camera/)
  const j = await mvs.hunt(made.id, 0)
  const req = studio.jobs[j.id].request
  assert.equal(req.members.length, 1)
  assert.equal(req.members[0].handle, 'BlueCola')
  assert.equal(req.members[0].kind, 'product')
  assert.match(req.prompt, /@BlueCola is in the shot\./, 'mentioned, so cast.js attaches it')
  m = mvs.removeRef(made.id, ken.id)
  assert.equal(m.refs.length, 1)
  m = mvs.removeRef(made.id, cola.id)
  assert.deepEqual(m.scenes[0].refs, [], 'removed from the scenes too')
  assert.ok(!fs.existsSync(cola.picture), 'its copied picture is deleted')
})
await ok('a reference named in the prompt becomes the mention there', () => {
  const refs = [{ name: 'Blue Cola', handle: 'BlueCola' }, { name: 'Neon Diner', handle: 'NeonDiner' }]
  assert.equal(withRefMentions('[Shot 1] {char} sips the Blue Cola.', refs), '[Shot 1] @NeonDiner is in the shot. {char} sips @BlueCola.')
  assert.equal(withRefMentions('{char} sips @BlueCola in @NeonDiner.', refs), '{char} sips @BlueCola in @NeonDiner.')
})
await ok('through the real mention resolver: a product and a person become referenced subjects with their pictures', () => {
  const members = [{ handle: 'Tess', kind: 'character', id: 'tess', name: 'Tess Brown', picture: 'tess.png' }, { handle: 'BlueCola', kind: 'product', id: 'mv:a', name: 'Blue Cola', picture: 'cola.png', description: 'a red can' }, { handle: 'Mia', kind: 'person', id: 'mv:b', name: 'Mia Lee', picture: 'mia.png' }]
  const { request } = resolveMentions({ prompt: '[Shot 1] {char} sings and lifts @BlueCola while @Mia dances.', mode: 'text', character: 'tess', media: [] }, members)
  assert.equal(request.mode, 'reference')
  assert.deepEqual(request.media.map((x) => x.file), ['cola.png', 'mia.png'])
  assert.match(request.prompt, /<Subject 1> is the product in <Picture 1>: Blue Cola, a red can\./)
  assert.match(request.prompt, /<Subject 1> \(appears in \[Shot 1\]\): fully_preserved - the product exactly as pictured: its shape, colours, logo and label/)
  assert.match(request.prompt, /<Subject 2> is Mia Lee, the person in <Picture 2>\./)
  assert.match(request.prompt, /with the product Blue Cola and Mia kept from their pictures/)
})
await ok('delete removes the music video and its folder', async () => {
  mvs.delete(made.id)
  assert.equal(mvs.list().length, 0)
  assert.ok(!fs.existsSync(path.join(tmp, 'musicvideos', made.id)))
})
fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `${failed} failed, ${n} passed` : `all ${n} passed`)
process.exit(failed ? 1 : 0)
