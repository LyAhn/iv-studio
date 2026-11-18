// Music video: a song cut into scenes on its bar lines, each scene an H3 shot that sings or plays along to its own
// stretch of the song, then the finished scenes laid over the untouched song as an ordinary edit.
//   the song map   beats (reel.js's findBeats), bars, and parts found from where the loudness changes
//   the scenes     cover the whole song with no gaps, 2 to 15 s each (H3's longest shot), cut on bars
//   a scene        a prompt, who is in it and who sings; hunted and finished like any shot, with the song's
//                  stretch as its voice line (the lip-sync path), so mouths and playing follow the music
//   assemble       a new edit: V1 the finished scenes at their start (their own sound muted), A1 the song
// The pure parts (bars, parts, the scene plan and its edits, the scene key and brief) are tested without ffmpeg or
// ComfyUI (test/music-video.mjs).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { findBeats } from './reel.js'
import { applyOps } from './timeline.js'
import { resolveFrames } from './plan.js'
import { handleOf } from './cast.js'

export const MV_MAX = 15 // H3's longest shot, s
export const MV_MIN = 2 // a shorter scene is merged into its neighbour
export const MV_CAST = 4
export const MV_ASPECTS = ['16:9', '9:16']
// References: pictures of people, products, places or things that scenes can show, attached to H3 as references
export const MV_REF_KINDS = ['person', 'product', 'place', 'thing']
export const MV_REFS = 8 // on a music video
export const MV_SCENE_REFS = 4 // in one scene (with the cast's faces, H3 takes them all as reference pictures)
const PICTURE = /\.(png|jpe?g|webp|bmp)$/i
const RATE = 11025 // the song is read as mono at this rate, as Reel reads it
const CLEAR_BEAT = 0.3 // findBeats strength from which the bars are trusted
const PHRASE = 4 // bars in a phrase: parts change on phrase lines
const PART_DB = 2.5 // a phrase this much louder or quieter than the one before starts a new part

const round3 = (n) => +n.toFixed(3)
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const now = () => new Date().toISOString()
const newId = () => randomUUID().slice(0, 6)
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2))
  fs.renameSync(`${file}.tmp`, file)
}

// Bar lines (s) from the beats: every perBar beats from the first, with 0 always the first line (a pickup before
// the first beat joins the first bar). No clear beat (or too few beats): an even 2 s grid, so cuts still have lines.
export function barsOf({ beats = [], period = 0, strength = 0, duration, perBar = 4 }) {
  const lines = [0]
  if (strength >= CLEAR_BEAT && period > 0.2 && beats.length >= perBar * 2) {
    for (let k = 0; k < beats.length; k += perBar) if (beats[k] > lines.at(-1) + period) lines.push(round3(beats[k]))
    // past the last beat, the bars run on at the same length to the end
    const bar = period * perBar
    while (lines.at(-1) + bar < duration - 0.05) lines.push(round3(lines.at(-1) + bar))
  } else {
    for (let t = 2; t < duration - 0.05; t += 2) lines.push(round3(t))
  }
  return lines.filter((t) => t < duration - 0.05)
}

// Loudness of each bar in dB (RMS of the mono samples), for finding the song's parts.
export function barEnergy(samples, rate, bars, duration) {
  return bars.map((start, i) => {
    const end = i + 1 < bars.length ? bars[i + 1] : duration
    const a = Math.max(0, Math.floor(start * rate))
    const b = Math.min(samples.length, Math.floor(end * rate))
    let sum = 0
    for (let k = a; k < b; k++) sum += samples[k] * samples[k]
    const rms = b > a ? Math.sqrt(sum / (b - a)) : 0
    return round3(20 * Math.log10(rms + 1e-9))
  })
}

// The song's parts: phrases of PHRASE bars, a new part wherever a phrase's loudness moves by PART_DB or more from
// the one before. Returns [{ start, end, label, bars: [first, last) }], labelled Part 1, Part 2, ...
export function sectionsOf({ bars, energy, duration, phrase = PHRASE, threshold = PART_DB }) {
  if (!bars.length) return [{ start: 0, end: round3(duration), label: 'Part 1', bars: [0, 0] }]
  const phrases = []
  for (let i = 0; i < bars.length; i += phrase) {
    const e = energy.slice(i, i + phrase)
    phrases.push({ first: i, last: Math.min(bars.length, i + phrase), db: e.reduce((s, x) => s + x, 0) / Math.max(1, e.length) })
  }
  const parts = [{ first: 0, last: phrases[0].last, db: phrases[0].db }]
  for (const p of phrases.slice(1)) {
    const cur = parts.at(-1)
    if (Math.abs(p.db - cur.db) >= threshold) parts.push({ ...p })
    else Object.assign(cur, { last: p.last, db: (cur.db + p.db) / 2 })
  }
  return parts.map((p, i) => ({ start: bars[p.first], end: p.last < bars.length ? bars[p.last] : round3(duration), label: `Part ${i + 1}`, bars: [p.first, p.last] }))
}

// One part split into scenes of at most max seconds, as near equal as its bar lines allow.
function splitPart(part, bars, max) {
  const inside = bars.filter((t) => t > part.start + 0.01 && t < part.end - 0.01)
  const n = Math.ceil((part.end - part.start - 0.001) / max)
  if (n <= 1) return [[part.start, part.end]]
  const cuts = []
  let from = part.start
  for (let k = 1; k < n; k++) {
    const ideal = part.start + ((part.end - part.start) * k) / n
    // the bar line nearest the ideal that keeps this scene within max and leaves room after it
    const ok = inside.filter((t) => t > from + MV_MIN - 0.001 && t - from <= max + 0.001 && part.end - t >= MV_MIN - 0.001)
    const at = ok.length ? ok.reduce((a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a)) : Math.min(from + max, ideal)
    cuts.push(round3(at))
    from = at
  }
  const edges = [part.start, ...cuts, part.end]
  // a scene still over max (bars too far apart): cut it evenly
  const out = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const [a, b] = [edges[i], edges[i + 1]]
    const m = Math.ceil((b - a - 0.001) / max)
    for (let j = 0; j < m; j++) out.push([round3(a + ((b - a) * j) / m), round3(a + ((b - a) * (j + 1)) / m)])
  }
  return out
}

// The automatic scene plan: every part split into scenes of at most max seconds on its bar lines; a scene shorter
// than MV_MIN joins its neighbour when the two fit in max. Scenes cover 0..duration exactly.
export function planScenes({ bars, sections, duration, max = MV_MAX }) {
  let scenes = []
  for (const part of sections) for (const [start, end] of splitPart(part, bars, max)) scenes.push({ id: newId(), start, end, part: part.label })
  scenes = mergeShort(scenes, max)
  if (scenes.length) scenes.at(-1).end = round3(duration)
  return scenes.map(blankScene)
}

function mergeShort(scenes, max) {
  const out = []
  for (const s of scenes) {
    const prev = out.at(-1)
    if (prev && (s.end - s.start < MV_MIN || prev.end - prev.start < MV_MIN) && s.end - prev.start <= max + 0.001) prev.end = s.end
    else out.push({ ...s })
  }
  return out
}

// refs: ids of the music video's references (people, products, places, things) that appear in the scene
export const blankScene = (s) => ({ id: s.id || newId(), start: s.start, end: s.end, part: s.part || '', prompt: s.prompt || '', cast: s.cast || null, sings: s.sings ?? true, media: s.media || [], refs: (s.refs || []).slice(0, MV_SCENE_REFS) })

// Problems with a scene list, or [] when it's sound: covers 0..duration, no gaps, each MV_MIN..max seconds.
export function scenesProblems(scenes, duration, max = MV_MAX) {
  const p = []
  if (!scenes.length) return ['There are no scenes.']
  if (Math.abs(scenes[0].start) > 0.01) p.push('The first scene must start at 0.')
  if (Math.abs(scenes.at(-1).end - duration) > 0.05) p.push('The last scene must end with the song.')
  scenes.forEach((s, i) => {
    const len = s.end - s.start
    if (len > max + 0.001) p.push(`Scene ${i + 1} is ${len.toFixed(1)} s; a scene can be ${max} s at most.`)
    if (len < MV_MIN - 0.001) p.push(`Scene ${i + 1} is ${len.toFixed(1)} s; a scene needs ${MV_MIN} s at least.`)
    if (i && Math.abs(s.start - scenes[i - 1].end) > 0.01) p.push(`Scene ${i + 1} doesn't start where scene ${i} ends.`)
  })
  return p
}

// Split scene i in two on the bar line nearest its middle (or exactly at `at`). The second half is a new, blank scene
// in the same part with the same cast.
export function splitScene(scenes, i, bars, at = null) {
  const s = scenes[i]
  if (!s) throw new Error(`No scene ${i + 1}.`)
  const mid = at ?? (s.start + s.end) / 2
  const ok = bars.filter((t) => t >= s.start + MV_MIN - 0.001 && t <= s.end - MV_MIN + 0.001)
  if (at == null && !ok.length && s.end - s.start < MV_MIN * 2) throw new Error(`Scene ${i + 1} is too short to split.`)
  const cut = round3(at ?? (ok.length ? ok.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a)) : mid))
  if (cut - s.start < MV_MIN - 0.001 || s.end - cut < MV_MIN - 0.001) throw new Error(`Each half needs ${MV_MIN} s at least.`)
  const second = blankScene({ start: cut, end: s.end, part: s.part, cast: s.cast, sings: s.sings })
  return [...scenes.slice(0, i), { ...s, end: cut }, second, ...scenes.slice(i + 1)]
}

// Join scene i with the one after it (the first scene's prompt, cast and pictures stay).
export function mergeScenes(scenes, i, max = MV_MAX) {
  const [a, b] = [scenes[i], scenes[i + 1]]
  if (!a || !b) throw new Error('There is no scene after it to join.')
  if (b.end - a.start > max + 0.001) throw new Error(`Together they'd be ${(b.end - a.start).toFixed(1)} s; a scene can be ${max} s at most.`)
  return [...scenes.slice(0, i), { ...a, end: b.end }, ...scenes.slice(i + 2)]
}

// Move the cut after scene i by `bars` bar lines (negative: earlier), keeping both scenes MV_MIN..max.
export function moveCut(scenes, i, steps, bars, max = MV_MAX) {
  const [a, b] = [scenes[i], scenes[i + 1]]
  if (!a || !b) throw new Error('The last scene ends with the song; its end can’t move.')
  const lines = bars.filter((t) => t > a.start + 0.01 && t < b.end - 0.01)
  let k = lines.findIndex((t) => Math.abs(t - a.end) < 0.02)
  // a cut off the bar lines (an even split) moves to the nearest line in that direction first
  if (k < 0) k = steps > 0 ? lines.findIndex((t) => t > a.end) - 1 : lines.findIndex((t) => t > a.end)
  const at = lines[k + steps]
  if (at == null) throw new Error('There is no bar line there.')
  if (at - a.start < MV_MIN - 0.001 || b.end - at < MV_MIN - 0.001) throw new Error(`Each scene needs ${MV_MIN} s at least.`)
  if (at - a.start > max + 0.001 || b.end - at > max + 0.001) throw new Error(`A scene can be ${max} s at most.`)
  return scenes.map((s, j) => (j === i ? { ...s, end: at } : j === i + 1 ? { ...s, start: at } : s))
}

// Put the cut after scene i at time `at` (a dragged cut), on the nearest bar line when snap, keeping both scenes
// MV_MIN..max seconds.
export function setCut(scenes, i, at, bars, { snap = true, max = MV_MAX } = {}) {
  const [a, b] = [scenes[i], scenes[i + 1]]
  if (!a || !b) throw new Error('The last scene ends with the song; its end can’t move.')
  const lo = Math.max(a.start + MV_MIN, b.end - max)
  const hi = Math.min(b.end - MV_MIN, a.start + max)
  if (lo > hi + 0.001) throw new Error('This cut can’t move.')
  let t = Math.min(hi, Math.max(lo, Number(at)))
  if (snap) {
    const ok = bars.filter((x) => x >= lo - 0.001 && x <= hi + 0.001)
    if (ok.length) t = ok.reduce((p, q) => (Math.abs(q - t) < Math.abs(p - t) ? q : p))
  }
  t = round3(t)
  return scenes.map((s, j) => (j === i ? { ...s, end: t } : j === i + 1 ? { ...s, start: t } : s))
}

// How long H3 renders a scene of `len` seconds: its 17n+5 frame grid at 24 fps rounds up, so the song's stretch is
// cut this long and the finished clip is trimmed back to the scene on the timeline.
export const renderSeconds = (len) => round3(resolveFrames(len) / 24)

// Who is in a scene (cast indexes) and who leads it: the singer when they're in it and it sings, else the first.
export function sceneWho(mv, scene) {
  const cast = (mv.cast || []).map((c, i) => ({ ...c, i })).filter((c) => c.character && c.character !== 'none')
  const inIt = scene.cast ? cast.filter((c) => scene.cast.includes(c.i)) : cast
  const singer = scene.sings ? inIt.find((c) => c.singer) || null : null
  const lead = singer || inIt[0] || null
  return { inIt, singer, lead, others: inIt.filter((c) => c !== lead) }
}

// What a scene's finish depends on: change any of it and the scene is changed since it was rendered.
export function sceneKey(mv, scene) {
  const who = sceneWho(mv, scene)
  const refs = sceneRefs(mv, scene).map((r) => [r.name, r.kind, r.picture, r.description])
  return JSON.stringify([scene.start, scene.end, scene.prompt, who.inIt.map((c) => c.character), who.singer?.character || null, scene.sings, mv.aspect, scene.media, mv.song?.file, ...(refs.length ? [refs] : [])])
}

// The references in a scene, in the music video's order.
export const sceneRefs = (mv, scene) => (mv.refs || []).filter((r) => (scene.refs || []).includes(r.id))

// The handle a reference is mentioned by (@BlueCola): its name without spaces, never one the cast or another
// reference already uses (a number is added).
export function refHandle(name, taken = []) {
  const h0 = handleOf(name, 'place') || 'Ref'
  const base = h0[0].toUpperCase() + h0.slice(1)
  const used = new Set(taken.map((h) => h.toLowerCase()))
  let h = base
  for (let k = 2; used.has(h.toLowerCase()); k++) h = `${base}${k}`
  return h
}

// A scene's prompt with each of its references mentioned once: a reference whose name is in the prompt becomes the
// mention there; the others get a sentence at the start of [Shot 1] (or the end). cast.js then attaches the pictures.
export function withRefMentions(prompt, refs) {
  let text = String(prompt || '')
  const add = []
  for (const r of refs) {
    if (new RegExp(`(^|[^\\w@<])@${r.handle}\\b`, 'i').test(text)) continue
    const re = new RegExp(`(^|[^\\w@<{])(?:the\\s+)?${escapeRe(r.name)}\\b`, 'i')
    if (re.test(text)) text = text.replace(re, `$1@${r.handle}`)
    else add.push(`@${r.handle}`)
  }
  if (!add.length) return text
  const line = `${add.length > 1 ? `${add.slice(0, -1).join(', ')} and ${add.at(-1)} are` : `${add[0]} is`} in the shot.`
  const at = text.indexOf('[Shot 1]')
  return at >= 0 ? `${text.slice(0, at + 8)} ${line}${text.slice(at + 8)}` : `${text.trim()}${text.trim() ? ' ' : ''}${line}`
}

// The writer's brief for one scene: the video's idea, where the scene sits in the song, who is in it and the
// singing rule (only the singer's mouth moves with the words; an instrumental keeps every mouth closed).
export function sceneBrief(mv, scene, index, characters = []) {
  const who = sceneWho(mv, scene)
  const name = (c) => characters.find((x) => x.id === c.character)?.name?.split(/\s+/)[0] || c.character
  const len = scene.end - scene.start
  const lines = [
    `A ${len.toFixed(1)}-second scene of a music video${mv.idea?.trim() ? ` about: ${mv.idea.trim()}` : ''}.`,
    `It is scene ${index + 1} of ${mv.scenes.length}, ${scene.start.toFixed(1)} to ${scene.end.toFixed(1)} s into the song${scene.part ? `, in ${scene.part}` : ''}${mv.song?.bpm ? ` (${Math.round(mv.song.bpm)} BPM)` : ''}.`
  ]
  if (scene.prompt?.trim()) lines.push(`What happens: ${scene.prompt.trim()}`)
  if (who.inIt.length) lines.push(`In it: ${who.inIt.map((c) => `${name(c)}${c.part ? ` (${c.part})` : ''}`).join(', ')}.`)
  const refs = sceneRefs(mv, scene)
  const what = { person: 'the person', product: 'the product', place: 'the place', thing: 'the' }
  if (refs.length) lines.push(`Also in it, each kept exactly as in its picture: ${refs.map((r) => `${what[r.kind] || 'the'} ${r.name}${r.description ? ` (${r.description})` : ''}`).join('; ')}. Show ${refs.length > 1 ? 'each of them' : 'it'} clearly${refs.some((r) => r.kind === 'product') ? ', a product with its label to the camera at least once' : ''}.`)
  if (who.singer) lines.push(`${name(who.singer)} sings the song's words in time with the music, mouth moving with the singing.${who.others.length ? ' Everyone else keeps their mouth closed and plays or moves to the music.' : ''}`)
  else lines.push('No one sings in this scene: every mouth stays closed. People play, dance or move to the music.')
  lines.push('No spoken lines and no subtitles or text on screen. Movement and cuts follow the music.')
  return lines.join('\n')
}

// ---------- storage, rendering and the edit ----------
export class MusicVideos {
  // studio: Studio (projects, jobs, generatePreviews, finishCandidate, characters); edits: Edits (ffmpeg, media,
  // create, write)
  // (studio may be a function returning the current Studio: the app makes a new one when it switches to the cloud)
  constructor({ dataDir, studio, edits }) {
    this.dir = path.join(dataDir, 'musicvideos')
    this.studioOf = typeof studio === 'function' ? studio : () => studio
    this.edits = edits
  }
  get studio() {
    return this.studioOf()
  }

  file = (id) => path.join(this.dir, `${id}.json`)
  work = (id) => path.join(this.dir, id)

  list() {
    if (!fs.existsSync(this.dir)) return []
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(this.dir, f), null))
      .filter(Boolean)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((m) => ({ id: m.id, name: m.name, song: m.song?.name || null, seconds: m.song?.duration || 0, scenes: m.scenes.length, updatedAt: m.updatedAt }))
  }
  get(id) {
    const m = readJson(this.file(id), null)
    if (!m) throw new Error(`No music video ${id}`)
    return m
  }
  write(m) {
    m.updatedAt = now()
    writeJson(this.file(m.id), m)
    return m
  }

  // song: a sound file on this PC (a Music song's file, or the person's own); name: the song's name.
  async create({ name, song, songName = null, idea = '', aspect = '16:9', cast = [] } = {}) {
    if (!song || !fs.existsSync(song)) throw new Error('Pick a song.')
    const m = { id: randomUUID().slice(0, 8), name: name?.trim() || songName || path.basename(song).replace(/\.[^.]+$/, '') || 'Music video', idea, aspect: MV_ASPECTS.includes(aspect) ? aspect : '16:9', cast: cleanCast(cast), song: { file: song, name: songName || path.basename(song) }, refs: [], scenes: [], sceneJobs: {}, jobs: [], edits: [], projectId: null, createdAt: now() }
    this.write(m)
    return this.map(m.id)
  }

  // The song map, and a fresh automatic scene plan (replan, or when there are no scenes yet).
  async map(id, { replan = false } = {}) {
    const m = this.get(id)
    if (!fs.existsSync(m.song.file)) throw new Error(`The song isn't there any more: ${m.song.file}`)
    const pcm = await this.edits.run(['-v', 'error', '-i', m.song.file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'])
    const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength - (pcm.byteLength % 4))))
    const duration = round3(samples.length / RATE)
    if (duration < MV_MIN) throw new Error('The song is too short.')
    const beat = findBeats(samples, RATE)
    const bars = barsOf({ ...beat, duration, perBar: m.song.perBar || 4 })
    const energy = barEnergy(samples, RATE, bars, duration)
    const sections = sectionsOf({ bars, energy, duration })
    m.song = { ...m.song, duration, bpm: beat.bpm, strength: beat.strength, clearBeat: beat.strength >= CLEAR_BEAT, bars, sections: sections.map(({ start, end, label }) => ({ start, end, label })) }
    if (replan || !m.scenes.length) m.scenes = planScenes({ bars, sections, duration })
    return this.write(m)
  }

  // Edits name, idea, aspect, cast and scenes. The scenes must still cover the song (scenesProblems).
  save(id, patch = {}) {
    const m = this.get(id)
    if ('name' in patch) m.name = String(patch.name || '').trim() || m.name
    if ('idea' in patch) m.idea = String(patch.idea || '')
    if ('aspect' in patch && MV_ASPECTS.includes(patch.aspect)) m.aspect = patch.aspect
    if ('cast' in patch) m.cast = cleanCast(patch.cast)
    if ('scenes' in patch) {
      const scenes = (patch.scenes || []).map((s) => blankScene({ ...s, start: round3(Number(s.start)), end: round3(Number(s.end)) }))
      const problems = scenesProblems(scenes, m.song.duration)
      if (problems.length) throw new Error(problems.join(' '))
      m.scenes = scenes
    }
    return this.write(m)
  }

  // A scene edit by name: split (at a time, or the bar nearest the middle), merge, move (the cut after scene i by
  // steps bars), cut (the cut after scene i to time at, snapped to a bar), or set (prompt, cast, sings, media).
  edit(id, { op, index, steps = 1, at = null, ...fields }) {
    const m = this.get(id)
    const i = Number(index)
    if (op === 'split') m.scenes = splitScene(m.scenes, i, m.song.bars, at)
    else if (op === 'merge') m.scenes = mergeScenes(m.scenes, i)
    else if (op === 'move') m.scenes = moveCut(m.scenes, i, Number(steps), m.song.bars)
    else if (op === 'cut') m.scenes = setCut(m.scenes, i, at, m.song.bars, { snap: fields.snap !== false })
    else if (op === 'set') {
      if (!m.scenes[i]) throw new Error(`No scene ${i + 1}.`)
      if ('refs' in fields) fields.refs = [...new Set(fields.refs || [])].filter((r) => (m.refs || []).some((x) => x.id === r))
      const allowed = ['prompt', 'cast', 'sings', 'media', 'refs']
      m.scenes[i] = blankScene({ ...m.scenes[i], ...Object.fromEntries(allowed.filter((k) => k in fields).map((k) => [k, fields[k]])) })
    } else throw new Error('op must be split, merge, move, cut or set.')
    return this.write(m)
  }

  // ---------- references: pictures of people, products, places or things the scenes can show ----------
  // The picture is copied into the music video's folder, so it stays when the original moves.
  addRef(id, { name, kind = 'thing', picture, description = '' } = {}) {
    const m = this.get(id)
    m.refs = m.refs || []
    if (m.refs.length >= MV_REFS) throw new Error(`A music video can have ${MV_REFS} references.`)
    if (!picture || !fs.existsSync(picture)) throw new Error('Pick a picture for the reference.')
    if (!PICTURE.test(picture)) throw new Error('A reference is a picture: PNG, JPEG, WebP or BMP.')
    const ref = { id: newId(), name: String(name || '').trim() || path.basename(picture).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Reference', kind: MV_REF_KINDS.includes(kind) ? kind : 'thing', description: String(description || '').slice(0, 160) }
    const dir = path.join(this.work(id), 'refs')
    fs.mkdirSync(dir, { recursive: true })
    ref.picture = path.join(dir, `${ref.id}${path.extname(picture).toLowerCase()}`)
    fs.copyFileSync(picture, ref.picture)
    ref.handle = refHandle(ref.name, this.takenHandles(m))
    m.refs.push(ref)
    return this.write(m)
  }
  // name, kind, description; a new name gets a new handle
  updateRef(id, refId, patch = {}) {
    const m = this.get(id)
    const ref = (m.refs || []).find((r) => r.id === refId)
    if (!ref) throw new Error('That reference isn’t there.')
    if ('name' in patch && String(patch.name || '').trim() && patch.name.trim() !== ref.name) {
      ref.name = patch.name.trim()
      ref.handle = refHandle(ref.name, this.takenHandles(m, ref.id))
    }
    if ('kind' in patch && MV_REF_KINDS.includes(patch.kind)) ref.kind = patch.kind
    if ('description' in patch) ref.description = String(patch.description || '').slice(0, 160)
    return this.write(m)
  }
  // Takes it out of every scene too, and deletes its copied picture.
  removeRef(id, refId) {
    const m = this.get(id)
    const ref = (m.refs || []).find((r) => r.id === refId)
    if (!ref) return m
    m.refs = m.refs.filter((r) => r.id !== refId)
    m.scenes = m.scenes.map((s) => ({ ...s, refs: (s.refs || []).filter((r) => r !== refId) }))
    if (ref.picture?.startsWith(this.work(id))) fs.rmSync(ref.picture, { force: true })
    return this.write(m)
  }
  // Handles a reference can't take: the cast's (characters and places) and the other references'.
  takenHandles(m, except = null) {
    let cast = []
    try {
      cast = this.studio.cast?.members?.().map((x) => x.handle) || []
    } catch {}
    return [...cast, ...(m.refs || []).filter((r) => r.id !== except).map((r) => r.handle)]
  }

  delete(id) {
    const m = readJson(this.file(id), null)
    if (m?.projectId) {
      try {
        this.studio.deleteProject(m.projectId)
      } catch {}
    }
    fs.rmSync(this.file(id), { force: true })
    fs.rmSync(this.work(id), { recursive: true, force: true })
    return true
  }

  // The song's stretch for a scene, cut as long as H3 renders it (renderSeconds), into the music video's folder.
  async sceneAudio(m, scene) {
    const len = renderSeconds(scene.end - scene.start)
    const out = path.join(this.work(m.id), `scene_${scene.start.toFixed(3)}_${len.toFixed(3)}.wav`)
    if (!fs.existsSync(out)) {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      // past the song's end the stretch is padded with silence, so the voice line is as long as the shot
      await this.edits.run(['-y', '-v', 'error', '-ss', String(scene.start), '-i', m.song.file, '-t', String(len), '-af', `apad=whole_dur=${len}`, '-ac', '2', '-ar', '48000', out])
    }
    return out
  }

  // Hunt previews for scene i: its prompt, its lead character (with the others in it as references), and its
  // stretch of the song as the voice line. opts: { seed, speed, previews } as for any shot.
  async hunt(id, i, opts = {}) {
    const m = this.get(id)
    const scene = m.scenes[i]
    if (!scene) throw new Error(`No scene ${i + 1}.`)
    if (!scene.prompt.trim()) throw new Error(`Scene ${i + 1} has no prompt yet. Write one, or press Write.`)
    if (!m.projectId) m.projectId = this.studio.createProject(`${m.name} (music video)`, null, null, 'musicvideo').id
    const who = sceneWho(m, scene)
    const voiceLine = await this.sceneAudio(m, scene)
    const pictures = (scene.media || []).filter((x) => x.kind === 'picture')
    // the scene's references go along as members only this shot can mention, so cast.js attaches their pictures
    const refs = sceneRefs(m, scene).filter((r) => r.picture && fs.existsSync(r.picture))
    const request = {
      projectId: m.projectId,
      prompt: withRefMentions(scene.prompt, refs),
      ...(refs.length ? { members: refs.map((r) => ({ handle: r.handle, kind: r.kind, id: `mv:${r.id}`, name: r.name, picture: r.picture, description: r.description || '' })) } : {}),
      character: who.lead?.character || 'none',
      ...(who.others.length ? { with: who.others.map((c) => c.character) } : {}),
      aspect: m.aspect,
      seconds: Math.min(MV_MAX, round3(scene.end - scene.start)),
      voiceLine,
      mode: pictures.length ? 'frames' : 'text',
      media: pictures.slice(0, 1).map((p) => ({ kind: 'picture', file: p.file })),
      ...(opts.seed != null ? { seed: opts.seed } : {}),
      ...(opts.speed ? { speed: opts.speed } : {}),
      ...(opts.previews ? { previews: opts.previews } : {})
    }
    const j = await this.studio.generatePreviews(request)
    m.sceneJobs[scene.id] = { previews: j.id, finish: null, key: sceneKey(m, scene) }
    m.jobs.push(j.id)
    this.write(m)
    return j
  }

  // Hunt every scene that has a prompt and isn't finished from its current inputs (or `only`: scene indexes).
  async huntAll(id, { only = null, ...opts } = {}) {
    const v = this.view(id)
    const started = []
    const skipped = []
    for (const [i, s] of v.scenes.entries()) {
      if (only && !only.includes(i)) continue
      if (!s.prompt.trim()) skipped.push({ index: i, why: 'no prompt' })
      else if (s.state.fresh) skipped.push({ index: i, why: 'already finished' })
      else if (s.state.busy) skipped.push({ index: i, why: 'rendering' })
      else started.push({ index: i, jobId: (await this.hunt(id, i, opts)).id })
    }
    return { started, skipped }
  }

  // Finish scene i's picked take (candidate), keeping its stretch of the song as the sound.
  async finish(id, i, { candidate = 1, speed } = {}) {
    const m = this.get(id)
    const scene = m.scenes[i]
    const rec = scene && m.sceneJobs[scene.id]
    if (!rec?.previews) throw new Error(`Hunt scene ${i + 1} first.`)
    const j = await this.studio.finishCandidate({ jobId: rec.previews, candidate: Number(candidate), audio: 'voice', ...(speed ? { speed } : {}) })
    rec.finish = j.id
    rec.key = sceneKey(m, scene)
    m.jobs.push(j.id)
    this.write(m)
    return j
  }

  // Writes the prompt of scene i (or every scene without one: `only` indexes) with write(request) -> prompt text,
  // the writer chosen in Settings. The brief: sceneBrief; what's already in the scene's prompt is kept as the idea.
  async writePrompts(id, { only = null, overwrite = false } = {}, write) {
    const m = this.get(id)
    const chars = this.studio.characters()
    const written = []
    for (const [i, scene] of m.scenes.entries()) {
      if (only ? !only.includes(i) : scene.prompt.trim() && !overwrite) continue
      const who = sceneWho(m, scene)
      const prompt = await write({ idea: sceneBrief(m, scene, i, chars), mode: 'text', seconds: Math.min(MV_MAX, round3(scene.end - scene.start)), aspect: m.aspect, character: who.lead?.character || 'none', ...(who.others.length ? { with: who.others.map((c) => c.character) } : {}) })
      const fresh = this.get(id)
      const at = fresh.scenes.findIndex((s) => s.id === scene.id)
      if (at < 0) continue
      fresh.scenes[at].prompt = String(prompt || '').trim()
      this.write(fresh)
      written.push(i)
    }
    return { written, video: this.view(id) }
  }

  // The music video plus each scene's state from its jobs: previews, finish, the finished clip, fresh / changed.
  view(id) {
    const m = this.get(id)
    const job = (jid) => {
      if (!jid) return null
      try {
        return this.studio.publicJob(this.studio.getJob(jid, { refresh: false }))
      } catch {
        return null
      }
    }
    const done = (j) => ['success', 'error', 'cancelled'].includes(j?.status)
    const scenes = m.scenes.map((s) => {
      const rec = m.sceneJobs[s.id] || {}
      const previews = job(rec.previews)
      const finish = job(rec.finish)
      const clip = finish?.status === 'success' ? finish.outputs?.find((o) => o.kind === 'final') || null : null
      const keyNow = sceneKey(m, s)
      const fresh = !!(clip && rec.key === keyNow)
      const busy = (previews && !done(previews)) || (finish && !done(finish))
      return { ...s, seconds: round3(s.end - s.start), state: { previews, finish, clip, fresh, changed: !!rec.key && rec.key !== keyNow, busy: !!busy } }
    })
    return { ...m, scenes, finished: scenes.filter((s) => s.state.fresh).length }
  }

  // view after asking ComfyUI about any of the music video's jobs that haven't finished.
  async refresh(id) {
    for (const jid of this.get(id).jobs) {
      try {
        const j = this.studio.getJob(jid, { refresh: false })
        if (!['success', 'error', 'cancelled'].includes(j.status)) await this.studio.refreshJob(jid)
      } catch {}
    }
    return this.view(id)
  }

  // A new edit: the finished scenes on V1 at their start, trimmed to the scene and muted; the song on A1 from 0.
  // Returns { editId, placed, missing: [scene numbers not finished] }.
  async assemble(id, { name = null, format = null } = {}) {
    const v = this.view(id)
    const e = this.edits.create(name || `${v.name} (music video)`)
    e.settings = { ...e.settings, format: format || (v.aspect === '9:16' ? 'vertical' : '1080p'), loudness: 'web' }
    const media = {}
    const ops = []
    const missing = []
    for (const [i, s] of v.scenes.entries()) {
      const clip = s.state.clip
      if (!clip?.path || !fs.existsSync(clip.path)) {
        missing.push(i + 1)
        continue
      }
      const md = await this.edits.addMedia(clip.path, { type: 'musicvideo', from: v.id, scene: s.id })
      media[md.id] = md
      ops.push({ op: 'add_clip', media: md.id, track: 'V1', start: s.start, in: 0, out: Math.min(s.seconds, md.duration || s.seconds), muted: true })
    }
    const song = await this.edits.addMedia(v.song.file, { type: 'file' })
    media[song.id] = song
    ops.push({ op: 'add_clip', media: song.id, track: 'A1', start: 0, in: 0, out: Math.min(v.song.duration, song.duration || v.song.duration) })
    const r = applyOps({ ...e, media }, ops)
    Object.assign(e, { clips: r.clips, media: r.media, tracks: r.tracks, markers: r.markers })
    this.edits.write(e)
    const m = this.get(id)
    m.edits = [...(m.edits || []), { id: e.id, createdAt: now(), missing }]
    this.write(m)
    return { editId: e.id, placed: v.scenes.length - missing.length, missing }
  }
}

// Up to MV_CAST cast members: { character, part, singer }; one singer at most (the first marked).
export function cleanCast(cast) {
  let sung = false
  return (Array.isArray(cast) ? cast : [])
    .slice(0, MV_CAST)
    .map((c) => ({ character: String(c?.character || 'none'), part: String(c?.part || '').slice(0, 60), singer: !!c?.singer }))
    .map((c) => {
      const singer = c.singer && !sung && c.character !== 'none'
      if (singer) sung = true
      return { ...c, singer }
    })
}
