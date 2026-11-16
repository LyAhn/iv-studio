import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// What Create remembers (create-memory.json in the data folder, so Incognito keeps its own):
//   last:      per side (video, image), the form as it was last left or run, so Create opens set up the same way
//   templates: per side, named setups the person saved (settings, and optionally the prompt and the media)
// Forms are stored as the window sends them, minus what only makes sense right now (the shot a run joins,
// probed file details). Nothing here is read by renders; it only fills the form.
export const KINDS = ['video', 'image']
const DROP = ['projectId', 'projectName', 'voiceItem']
const MAX_TEMPLATES = 100
const MAX_BYTES = 256 * 1024

function check(kind) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown side "${kind}": use video or image.`)
}

// A plain copy of a form without the passing details; media keep only their kind and file (and soft mouth).
export function cleanForm(form) {
  const f = JSON.parse(JSON.stringify(form || {}))
  for (const k of DROP) delete f[k]
  if (Array.isArray(f.media)) f.media = f.media.filter((m) => m?.path || m?.file).map((m) => ({ kind: m.kind, path: m.path || m.file, ...(m.softMouth ? { softMouth: true } : {}) }))
  if (Array.isArray(f.refs)) f.refs = f.refs.filter(Boolean).map((r) => (typeof r === 'string' ? r : { ...r, info: undefined }))
  if (JSON.stringify(f).length > MAX_BYTES) throw new Error('That setup is too large to keep.')
  return f
}

export class CreateMemory {
  constructor({ dataDir }) {
    this.dir = dataDir
    this.file = path.join(dataDir, 'create-memory.json')
  }
  read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return { last: d.last || {}, templates: d.templates || {} }
    } catch {
      return { last: {}, templates: {} }
    }
  }
  write(d) {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2))
    fs.renameSync(tmp, this.file)
  }

  get(kind) {
    check(kind)
    const d = this.read()
    return { last: d.last[kind] || null, templates: d.templates[kind] || [] }
  }

  // ran: the form was just rendered (a hunt), so it's the last run as well as the last setup
  saveLast(kind, form, { ran = false } = {}) {
    check(kind)
    const d = this.read()
    const prev = d.last[kind] || {}
    const clean = cleanForm(form)
    const key = JSON.stringify(clean)
    const at = new Date().toISOString()
    // isRun: this setup is exactly what was last rendered (saving it again unchanged keeps that true)
    d.last[kind] = { form: clean, at, ranAt: ran ? at : prev.ranAt || null, runKey: ran ? key : prev.runKey || null, isRun: ran || (!!prev.runKey && prev.runKey === key) }
    this.write(d)
    return d.last[kind]
  }

  clearLast(kind) {
    check(kind)
    const d = this.read()
    delete d.last[kind]
    this.write(d)
    return null
  }

  // A template with the same name (any case) is replaced, keeping its place in the list.
  saveTemplate(kind, { name, form, includes = {} }) {
    check(kind)
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!clean) throw new Error('Give the template a name.')
    const d = this.read()
    const list = d.templates[kind] || []
    const same = list.findIndex((t) => t.name.toLowerCase() === clean.toLowerCase())
    const t = { id: same >= 0 ? list[same].id : randomUUID().slice(0, 8), name: clean, form: cleanForm(form), includes, savedAt: new Date().toISOString() }
    if (same >= 0) list[same] = t
    else {
      if (list.length >= MAX_TEMPLATES) throw new Error(`You have ${MAX_TEMPLATES} templates already. Delete one first.`)
      list.push(t)
    }
    d.templates[kind] = list
    this.write(d)
    return list
  }

  deleteTemplate(kind, id) {
    check(kind)
    const d = this.read()
    d.templates[kind] = (d.templates[kind] || []).filter((t) => t.id !== id)
    this.write(d)
    return d.templates[kind]
  }
}
