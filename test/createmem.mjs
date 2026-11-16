// Create's memory (src/service/createmem.js): the last setup per side, and saved templates.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CreateMemory, cleanForm } from '../src/service/createmem.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivcm-'))
const m = new CreateMemory({ dataDir: dir })
let n = 0
const ok = (name, fn) => (fn(), n++, console.log(`ok ${name}`))

ok('empty to start', () => assert.deepEqual(m.get('video'), { last: null, templates: [] }))
ok('unknown side refused', () => assert.throws(() => m.get('audio'), /Unknown side/))
ok('clean drops passing details', () => {
  const c = cleanForm({ projectId: 'p1', projectName: 'x', voiceItem: { info: 1 }, prompt: 'hi', media: [{ kind: 'picture', path: 'a.png', info: { w: 1 } }, { kind: 'video', file: 'b.mp4', softMouth: true }] })
  assert.deepEqual(c, { prompt: 'hi', media: [{ kind: 'picture', path: 'a.png' }, { kind: 'video', path: 'b.mp4', softMouth: true }] })
})
ok('a run is remembered as the last run', () => {
  const l = m.saveLast('video', { prompt: 'A', aspect: '9:16' }, { ran: true })
  assert.equal(l.isRun, true)
  assert.equal(m.get('video').last.form.aspect, '9:16')
})
ok('saving it again unchanged keeps it the last run', () => assert.equal(m.saveLast('video', { prompt: 'A', aspect: '9:16' }).isRun, true))
ok('a change makes it the setup as left', () => {
  const l = m.saveLast('video', { prompt: 'B', aspect: '9:16' })
  assert.equal(l.isRun, false)
  assert.ok(l.ranAt)
})
ok('sides are separate', () => assert.equal(m.get('image').last, null))
ok('templates save, replace by name and delete', () => {
  m.saveTemplate('video', { name: '  Tess  talking ', form: { aspect: '9:16' }, includes: { prompt: false } })
  let list = m.saveTemplate('video', { name: 'tess talking', form: { aspect: '1:1' } })
  assert.equal(list.length, 1)
  assert.equal(list[0].form.aspect, '1:1')
  list = m.saveTemplate('video', { name: 'Wide', form: { aspect: '21:9' } })
  assert.equal(list.length, 2)
  list = m.deleteTemplate('video', list[0].id)
  assert.deepEqual(list.map((t) => t.name), ['Wide'])
})
ok('a template needs a name', () => assert.throws(() => m.saveTemplate('image', { name: '  ', form: {} }), /name/))
ok('clear forgets the last setup', () => {
  m.clearLast('video')
  assert.equal(m.get('video').last, null)
  assert.equal(m.get('video').templates.length, 1)
})
fs.rmSync(dir, { recursive: true, force: true })
console.log(`createmem: ${n}/${n} passed`)
