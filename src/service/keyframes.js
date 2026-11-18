// Keyframes: pictures in order become one video that moves from each picture to the next (and, looped, back to the
// first). Three ways to render it, picked by `join`:
//   onetake   up to KEYFRAME_MAX pictures in one H3 shot of up to 15 s: H3 Multishot's H3Keyframes anchors every
//             picture at its frame (plan.js keyframes), so there are no joins at all
//   carried   a chain: move 1 is H3 first/last frame (picture 1 -> 2); each later move continues the one before
//             (its last 22 frames pinned, so the motion carries across) and ends on its picture (plan.js: continue
//             with a picture). The last move's file is the whole video, as with Sequences' shot by shot
//   plain     every move its own first/last-frame shot, joined back to back in Edit
//   auto      onetake when it fits and this ComfyUI has H3Keyframes, else carried
// The pure parts (the moves, the choice, timing, positions, keys) are tested without ComfyUI (test/keyframes.mjs).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { applyOps } from './timeline.js'
import { KEYFRAME_MAX, resolveFrames } from './plan.js'

export const KF_JOINS = ['auto', 'onetake', 'carried', 'plain']
export const KF_SOUNDS = ['song', 'h3', 'silent']
export const KF_ASPECTS = ['16:9', '9:16', '1:1']
export const KF_PICTURES = 24
export const KF_MIN = 2 // seconds a move takes, at least
export const KF_MAX = 15 // H3's longest shot
export const KF_ONETAKE_MAX = 15
export const KF_OVERLAP = 22 // frames a carried move pins from the one before (Sequences' shot-by-shot number)
export const KF_DEFAULTS = { join: 'auto', loop: false, pace: 4, sound: 'silent', aspect: '16:9', megapixels: 0.6 }
const PICTURE = /\.(png|jpe?g|webp|bmp)$/i
const round3 = (n) => +n.toFixed(3)
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

// The moves: picture n -> n+1, and with loop the last back to the first. Each keeps its own seconds and line
// (kf.moveSet, by "fromId>toId", so they follow the pictures through a reorder).
export function movesOf(kf) {
  const pics = kf.pictures || []
  const pairs = pics.slice(0, -1).map((p, i) => [p, pics[i + 1]])
  if (kf.loop && pics.length >= 2) pairs.push([pics.at(-1), pics[0]])
  return pairs.map(([from, to], i) => {
    const key = `${from.id}>${to.id}`
    const set = kf.moveSet?.[key] || {}
    const seconds = Math.min(KF_MAX, Math.max(KF_MIN, Number(set.seconds) || Number(kf.pace) || KF_DEFAULTS.pace))
    return { index: i, key, from, to, seconds: round3(seconds), line: set.line || '', loopBack: kf.loop && i === pairs.length - 1 }
  })
}

export const totalSeconds = (moves) => round3(moves.reduce((s, m) => s + m.seconds, 0))

// How it renders: the join asked for, or (auto) one take when the pictures fit in one shot and this ComfyUI can.
export function modeOf(kf, { hasKeyframes = true } = {}) {
  const moves = movesOf(kf)
  const anchors = moves.length + 1
  const fits = hasKeyframes && moves.length >= 1 && anchors <= KEYFRAME_MAX && totalSeconds(moves) <= KF_ONETAKE_MAX
  if (kf.join === 'onetake') return fits ? 'onetake' : null
  if (kf.join === 'plain' || kf.join === 'carried') return kf.join
  return fits ? 'onetake' : 'carried'
}
// Why one take can't be used, in words, or null.
export function oneTakeProblem(kf, { hasKeyframes = true } = {}) {
  const moves = movesOf(kf)
  if (!hasKeyframes) return 'This ComfyUI has no H3 Multishot keyframes node. Install the node packs in Settings → Setup.'
  if (moves.length + 1 > KEYFRAME_MAX) return `One take holds ${KEYFRAME_MAX} pictures at most${kf.loop ? ' (the loop back counts as one)' : ''}.`
  if (totalSeconds(moves) > KF_ONETAKE_MAX) return `One take is ${KF_ONETAKE_MAX} s at most; these moves add up to ${totalSeconds(moves).toFixed(1)} s.`
  return null
}

// One take: the pictures (the first again at the end when looped) at their frames on H3's grid. The last lands on
// the shot's last frame. Returns { pictures, positions, seconds, frames }.
export function oneTakePlan(kf) {
  const moves = movesOf(kf)
  const seconds = totalSeconds(moves)
  const frames = resolveFrames(seconds)
  const pictures = [moves[0].from, ...moves.map((m) => m.to)]
  let t = 0
  const positions = [0]
  for (const m of moves) positions.push(Math.round(((t += m.seconds) / seconds) * (frames - 1)))
  positions[positions.length - 1] = frames - 1
  return { pictures, positions, seconds, frames }
}

// A carried move after the first is asked for its seconds plus the pinned frames it carries over, which come off
// again: so it adds what was asked.
export const carriedSeconds = (move) => round3(Math.min(KF_MAX, move.seconds + KF_OVERLAP / 24))

// The prompt of a move (or of the one take): the whole video's idea and the move's own line.
export function movePrompt(kf, move) {
  const parts = [kf.idea?.trim(), move?.line?.trim()].filter(Boolean)
  return parts.join(' ') || 'The picture comes to life with gentle, natural motion and a slow camera move, flowing smoothly into the next picture.'
}
export function oneTakePrompt(kf) {
  const moves = movesOf(kf)
  const lines = moves.filter((m) => m.line?.trim()).map((m) => `From picture ${m.index + 1} to ${m.index + 2}${m.loopBack ? ' (back to the first)' : ''}: ${m.line.trim()}`)
  return [kf.idea?.trim() || 'Gentle, natural motion and a slow camera move flow through each picture in turn.', ...lines].join('\n')
}

// What a render depends on: change any of it and the move (or the take) is changed since it was rendered.
export function moveKey(kf, move, mode, prev = null) {
  return JSON.stringify([mode, move.from.file, move.to.file, move.seconds, movePrompt(kf, move), kf.aspect, mode === 'carried' ? kf.megapixels : null, prev])
}
export function takeKey(kf) {
  const p = oneTakePlan(kf)
  return JSON.stringify(['onetake', p.pictures.map((x) => x.file), p.positions, p.seconds, oneTakePrompt(kf), kf.aspect])
}

const clean = (kf) => ({
  ...kf,
  join: KF_JOINS.includes(kf.join) ? kf.join : KF_DEFAULTS.join,
  sound: KF_SOUNDS.includes(kf.sound) ? kf.sound : KF_DEFAULTS.sound,
  aspect: KF_ASPECTS.includes(kf.aspect) ? kf.aspect : KF_DEFAULTS.aspect,
  pace: Math.min(KF_MAX, Math.max(KF_MIN, Number(kf.pace) || KF_DEFAULTS.pace)),
  megapixels: [0.6, 0.9, 1.2].includes(Number(kf.megapixels)) ? Number(kf.megapixels) : KF_DEFAULTS.megapixels,
  loop: !!kf.loop
})

export class Keyframes {
  // studio: Studio, or a function returning the current one; edits: Edits (create, addMedia, write)
  constructor({ dataDir, studio, edits }) {
    this.dir = path.join(dataDir, 'keyframes')
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
      .map((k) => ({ id: k.id, name: k.name, pictures: k.pictures.length, cover: k.pictures[0]?.file || null, loop: k.loop, updatedAt: k.updatedAt }))
  }
  get(id) {
    const k = readJson(this.file(id), null)
    if (!k) throw new Error(`No keyframes video ${id}`)
    return k
  }
  write(k) {
    k.updatedAt = now()
    writeJson(this.file(k.id), clean(k))
    return k
  }

  create({ name = '', pictures = [], idea = '', ...settings } = {}) {
    const k = clean({ ...KF_DEFAULTS, ...settings, id: randomUUID().slice(0, 8), name: name.trim() || 'Keyframes', idea, pictures: [], moveSet: {}, jobs: {}, take: null, song: null, projectId: null, edits: [], createdAt: now() })
    this.write(k)
    if (pictures.length) this.addPictures(k.id, pictures)
    if (settings.song) this.setSong(k.id, settings.song)
    return this.get(k.id)
  }
  // Pictures are copied into the keyframes folder, so they stay when the originals move.
  addPictures(id, files) {
    const k = this.get(id)
    for (const f of files) {
      if (k.pictures.length >= KF_PICTURES) throw new Error(`${KF_PICTURES} pictures at most.`)
      if (!f || !fs.existsSync(f)) throw new Error(`Not found: ${f}`)
      if (!PICTURE.test(f)) throw new Error(`Not a picture: ${path.basename(f)}`)
      const pid = newId()
      const dir = path.join(this.work(id), 'pictures')
      fs.mkdirSync(dir, { recursive: true })
      const copy = path.join(dir, `${pid}${path.extname(f).toLowerCase()}`)
      fs.copyFileSync(f, copy)
      k.pictures.push({ id: pid, file: copy, name: path.basename(f).replace(/\.[^.]+$/, '') })
    }
    return this.write(k)
  }
  removePicture(id, pid) {
    const k = this.get(id)
    const p = k.pictures.find((x) => x.id === pid)
    if (!p) return k
    k.pictures = k.pictures.filter((x) => x.id !== pid)
    if (p.file.startsWith(this.work(id))) fs.rmSync(p.file, { force: true })
    return this.write(k)
  }
  // order: picture ids in their new order (all of them)
  reorder(id, order) {
    const k = this.get(id)
    const byId = new Map(k.pictures.map((p) => [p.id, p]))
    if (order.length !== k.pictures.length || !order.every((x) => byId.has(x))) throw new Error('Give every picture once, in the new order.')
    k.pictures = order.map((x) => byId.get(x))
    return this.write(k)
  }
  setSong(id, song) {
    const k = this.get(id)
    if (song && (!song.file || !fs.existsSync(song.file))) throw new Error('Pick a song.')
    k.song = song ? { file: song.file, name: song.name || path.basename(song.file) } : null
    if (song && k.sound === 'silent') k.sound = 'song'
    if (!song && k.sound === 'song') k.sound = 'silent'
    return this.write(k)
  }
  // name, idea, join, loop, pace, sound, aspect, megapixels; move: { key, seconds, line }
  save(id, { move, ...patch } = {}) {
    const k = this.get(id)
    for (const f of ['name', 'idea', 'join', 'loop', 'pace', 'sound', 'aspect', 'megapixels']) if (f in patch) k[f] = patch[f]
    if (move?.key) {
      const cur = k.moveSet[move.key] || {}
      k.moveSet[move.key] = { ...cur, ...('seconds' in move ? { seconds: move.seconds == null ? undefined : Math.min(KF_MAX, Math.max(KF_MIN, Number(move.seconds))) } : {}), ...('line' in move ? { line: String(move.line || '') } : {}) }
    }
    return this.write(k)
  }
  delete(id) {
    const k = readJson(this.file(id), null)
    if (k?.projectId) {
      try {
        this.studio.deleteProject(k.projectId)
      } catch {}
    }
    fs.rmSync(this.file(id), { force: true })
    fs.rmSync(this.work(id), { recursive: true, force: true })
    return true
  }

  async hasKeyframes() {
    try {
      return !!(await this.studio.comfy.objectInfo()).H3Keyframes
    } catch {
      return false
    }
  }
  project(k) {
    if (!k.projectId) k.projectId = this.studio.createProject(`${k.name} (keyframes)`, null, null, 'keyframes').id
    return k.projectId
  }

  // Hunt one move (plain or carried), or the one take (index ignored). opts: { seed, speed, previews }.
  async hunt(id, index = 0, opts = {}) {
    const k = this.get(id)
    const caps = { hasKeyframes: await this.hasKeyframes() }
    const mode = modeOf(k, caps)
    if (!mode) throw new Error(oneTakeProblem(k, caps))
    if (k.pictures.length < 2) throw new Error('Add at least two pictures.')
    const projectId = this.project(k)
    const base = { projectId, aspect: k.aspect, character: 'none', ...(opts.seed != null ? { seed: opts.seed } : {}), ...(opts.speed ? { speed: opts.speed } : {}) }
    if (mode === 'onetake') {
      const p = oneTakePlan(k)
      const j = await this.studio.generatePreviews({ ...base, mode: 'frames', prompt: oneTakePrompt(k), seconds: p.seconds, media: p.pictures.map((x) => ({ kind: 'picture', file: x.file })), keyframes: { positions: p.positions }, ...(opts.previews ? { previews: opts.previews } : {}) })
      k.take = { previews: j.id, finish: null, key: takeKey(k) }
      return this.record(k, j)
    }
    const moves = movesOf(k)
    const move = moves[index]
    if (!move) throw new Error(`No move ${Number(index) + 1}.`)
    if (mode === 'plain' || index === 0) {
      const j = await this.studio.generatePreviews({ ...base, mode: 'frames', prompt: movePrompt(k, move), seconds: move.seconds, media: [{ kind: 'picture', file: move.from.file }, { kind: 'picture', file: move.to.file }], ...(opts.previews ? { previews: opts.previews } : {}) })
      k.jobs[move.key] = { previews: j.id, finish: null, key: moveKey(k, move, mode) }
      return this.record(k, j)
    }
    // carried: continue from the move before's finished clip (its whole chain so far), ending on this picture
    const v = this.view(id, caps)
    const prev = v.moves[index - 1]
    if (!prev.state.fresh || !prev.state.clip?.path) throw new Error(`Finish move ${index} first; move ${index + 1} carries on from it.`)
    const j = await this.studio.generatePreviews({ ...base, mode: 'continue', prompt: movePrompt(k, move), seconds: carriedSeconds(move), megapixels: k.megapixels, overlapFrames: KF_OVERLAP, media: [{ kind: 'video', file: prev.state.clip.path }, { kind: 'picture', file: move.to.file }] })
    k.jobs[move.key] = { previews: j.id, finish: null, key: moveKey(k, move, mode, prev.state.clip.path) }
    return this.record(k, j)
  }
  record(k, j) {
    k.jobLog = [...(k.jobLog || []), j.id]
    this.write(k)
    return j
  }

  // Finish a move's (or the take's) picked take. A carried chain finishes at its own size without DLSS, so the next
  // move continues from it, as Sequences' shot by shot does; plain moves and the one take get the usual finish.
  async finish(id, index = 0, { candidate = 1, speed } = {}) {
    const k = this.get(id)
    const mode = modeOf(k, { hasKeyframes: await this.hasKeyframes() })
    const rec = mode === 'onetake' ? k.take : k.jobs[movesOf(k)[index]?.key]
    if (!rec?.previews) throw new Error(mode === 'onetake' ? 'Hunt the take first.' : `Hunt move ${Number(index) + 1} first.`)
    const opts = mode === 'carried' ? { megapixels: Math.max(0.5, k.megapixels), audio: 'pass', fps: 0, upscale2x: false } : { audio: 'pass' }
    const j = await this.studio.finishCandidate({ jobId: rec.previews, candidate: Number(candidate), ...opts, ...(speed ? { speed } : {}) })
    rec.finish = j.id
    return this.record(k, j)
  }

  // Hunt everything that isn't finished and can start now (a carried chain only its next move).
  async huntAll(id, opts = {}) {
    const caps = { hasKeyframes: await this.hasKeyframes() }
    const v = this.view(id, caps)
    if (!v.mode) throw new Error(oneTakeProblem(this.get(id), caps))
    if (v.mode === 'onetake') return { started: v.take?.state.busy || v.take?.state.fresh ? [] : [{ index: 0, jobId: (await this.hunt(id, 0, opts)).id }] }
    const started = []
    for (const m of v.moves) {
      if (m.state.fresh || m.state.busy) continue
      if (v.mode === 'carried' && !m.state.ready) break
      started.push({ index: m.index, jobId: (await this.hunt(id, m.index, opts)).id })
      if (v.mode === 'carried') break
    }
    return { started }
  }

  // The keyframes video plus how it renders and each move's (or the take's) state.
  view(id, caps = { hasKeyframes: true }) {
    const k = this.get(id)
    const mode = modeOf(k, caps)
    const job = (jid) => {
      if (!jid) return null
      try {
        return this.studio.publicJob(this.studio.getJob(jid, { refresh: false }))
      } catch {
        return null
      }
    }
    const done = (j) => ['success', 'error', 'cancelled'].includes(j?.status)
    const clipOf = (fj, kinds) => (fj?.status === 'success' ? kinds.map((kind) => fj.outputs?.find((o) => o.kind === kind)).find(Boolean) || null : null)
    const stateOf = (rec, keyNow, kinds) => {
      const previews = job(rec?.previews)
      const finish = job(rec?.finish)
      const clip = clipOf(finish, kinds)
      return { previews, finish, clip, fresh: !!(clip && rec.key === keyNow), changed: !!rec?.key && rec.key !== keyNow, busy: !!((previews && !done(previews)) || (finish && !done(finish))) }
    }
    const moves = []
    let prevClip = null
    for (const m of movesOf(k)) {
      if (mode === 'onetake') {
        moves.push({ ...m, state: null })
        continue
      }
      const carried = mode === 'carried'
      const kinds = carried ? (m.index === 0 ? ['before_dlss', 'final'] : ['continued_before_dlss', 'continued', 'final']) : ['final']
      const keyNow = moveKey(k, m, mode, carried && m.index > 0 ? prevClip : null)
      const state = stateOf(k.jobs[m.key], keyNow, kinds)
      state.ready = !carried || m.index === 0 || !!prevClip
      moves.push({ ...m, state })
      prevClip = carried ? (state.fresh ? state.clip?.path || null : null) : null
    }
    const take = mode === 'onetake' ? { ...oneTakePlan(k), state: stateOf(k.take, takeKey(k), ['final']) } : null
    const finished = mode === 'onetake' ? (take.state.fresh ? 1 : 0) : moves.filter((m) => m.state?.fresh).length
    const parts = mode === 'onetake' ? 1 : moves.length
    return { ...k, mode, moves, take, seconds: totalSeconds(moves), finished, parts, oneTakeProblem: oneTakeProblem(k, caps) }
  }
  async refresh(id) {
    const k = this.get(id)
    for (const jid of k.jobLog || []) {
      try {
        const j = this.studio.getJob(jid, { refresh: false })
        if (!['success', 'error', 'cancelled'].includes(j.status)) await this.studio.refreshJob(jid)
      } catch {}
    }
    return this.view(id, { hasKeyframes: await this.hasKeyframes() })
  }

  // A new edit: the one take, the carried chain's last move (the whole chain), or the plain moves back to back on
  // V1; the song on A1 from 0 (their own sound muted), or their own sound, or silence.
  async assemble(id, { name = null } = {}) {
    const v = await this.refresh(id)
    const files = []
    if (v.mode === 'onetake') {
      if (!v.take?.state.fresh) throw new Error('Finish the take first.')
      files.push(v.take.state.clip.path)
    } else if (v.mode === 'carried') {
      const last = v.moves.at(-1)
      if (!last?.state.fresh) throw new Error('Finish every move first: the last one carries the whole video.')
      files.push(last.state.clip.path)
    } else {
      const missing = v.moves.filter((m) => !m.state.fresh).map((m) => m.index + 1)
      if (missing.length) throw new Error(`Finish move${missing.length === 1 ? '' : 's'} ${missing.join(', ')} first.`)
      files.push(...v.moves.map((m) => m.state.clip.path))
    }
    const e = this.edits.create(name || `${v.name} (keyframes)`)
    e.settings = { ...e.settings, format: v.aspect === '9:16' ? 'vertical' : v.aspect === '1:1' ? 'square' : '1080p', loudness: 'web' }
    const media = {}
    const ops = []
    let at = 0
    const mute = v.sound !== 'h3'
    for (const f of files) {
      const md = await this.edits.addMedia(f, { type: 'keyframes', from: v.id })
      media[md.id] = md
      ops.push({ op: 'add_clip', media: md.id, track: 'V1', start: round3(at), in: 0, out: md.duration, muted: mute })
      at += md.duration || 0
    }
    if (v.sound === 'song' && v.song?.file && fs.existsSync(v.song.file)) {
      const s = await this.edits.addMedia(v.song.file, { type: 'file' })
      media[s.id] = s
      ops.push({ op: 'add_clip', media: s.id, track: 'A1', start: 0, in: 0, out: Math.min(at, s.duration || at), fadeOut: Math.min(1.5, at / 4) })
    }
    const r = applyOps({ ...e, media }, ops)
    Object.assign(e, { clips: r.clips, media: r.media, tracks: r.tracks, markers: r.markers })
    this.edits.write(e)
    const k = this.get(id)
    k.edits = [...(k.edits || []), { id: e.id, createdAt: now() }]
    this.write(k)
    return { editId: e.id, seconds: round3(at) }
  }
}
