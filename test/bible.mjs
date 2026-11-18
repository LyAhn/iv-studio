// The character bible (src/service/bible.js): old presets move over losing nothing, pictures keep their roles, and
// each model gets what it can use (H3: its LoRA or RefMod, else the face picture as a reference, else words;
// Seedance: up to 3 pictures with role lines and the look in words). Also Seedance 2.5 Flash's qualities.
//   node test/bible.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { faceOf, h3Request, needsMove, normalize, readiness, seedancePictures, showFor, wordsFor } from '../src/service/bible.js'
import { modelsIn, planSeedance, SEEDANCE_TIERS, seedanceGraph, tiersIn, NODES } from '../src/service/seedance.js'
import { planPreviews } from '../src/service/plan.js'
import { resolveMentions } from '../src/service/cast.js'
import { Studio } from '../src/service/studio.js'

let n = 0
let failed = 0
const ok = async (name, fn) => {
  n++
  try {
    await fn()
    console.log('ok  ', name)
  } catch (err) {
    failed++
    console.log('FAIL', name, '-', err.message)
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ivs-bible-'))
const png = (dir, name) => {
  // a 1x1 PNG
  const f = path.join(dir, name)
  fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  return f
}

const tess = { id: 'tess', name: 'Tess Marlow', lora: 'MiniMax H3\\tess\\tess.safetensors', strength: 0.8, trigger: 't3ss4', voiceId: 'v1', voiceRefmod: 'characters/tess_audio' }
const maya = { id: 'maya', name: 'Maya Ortiz', refmod: 'characters/maya_ab12', strength: 1, trigger: '', picture: 'C:\\x\\maya.png' }

await ok('an old preset moves over losing nothing; its picture becomes the face picture', () => {
  assert.equal(needsMove([tess]), true)
  const t = normalize(tess)
  assert.equal(t.version, 2)
  for (const k of ['id', 'name', 'lora', 'strength', 'trigger', 'voiceId', 'voiceRefmod']) assert.deepEqual(t[k], tess[k], k)
  assert.deepEqual(t.pictures, [])
  assert.deepEqual(t.models.h3.loras, [])
  const m = normalize(maya)
  assert.equal(m.refmod, 'characters/maya_ab12')
  assert.equal(m.pictures.length, 1)
  assert.equal(m.pictures[0].role, 'face')
  assert.equal(m.picture, 'C:\\x\\maya.png')
  assert.equal(needsMove([t, m]), false)
  // normalizing twice changes nothing (picture ids are kept)
  assert.deepEqual(normalize(m), m)
})

await ok('the face picture: the first face, else three-quarter, else the first picture', () => {
  assert.equal(faceOf([{ file: 'a', role: 'full body' }, { file: 'b', role: 'face' }]), 'b')
  assert.equal(faceOf([{ file: 'a', role: 'full body' }, { file: 'b', role: 'three-quarter' }]), 'b')
  assert.equal(faceOf([{ file: 'a', role: 'outfit' }]), 'a')
  assert.equal(faceOf([]), null)
  // an unknown role becomes other; the same file twice is kept once
  const c = normalize({ id: 'x', name: 'X', pictures: [{ file: 'a.png', role: 'weird' }, { file: 'A.PNG', role: 'face' }] })
  assert.equal(c.pictures.length, 1)
  assert.equal(c.pictures[0].role, 'other')
})

const bible = normalize({
  id: 'june',
  name: 'June Park',
  about: 'a jazz singer in her thirties',
  look: 'shoulder-length black hair, a small scar over the left eyebrow.',
  pictures: [
    { id: 'p1', file: 'C:\\c\\outfit.png', role: 'outfit' },
    { id: 'p2', file: 'C:\\c\\body.png', role: 'full body' },
    { id: 'p3', file: 'C:\\c\\face.png', role: 'face' },
    { id: 'p4', file: 'C:\\c\\three.png', role: 'three-quarter' },
    { id: 'p5', file: 'C:\\c\\smile.png', role: 'expression' }
  ]
})

await ok('their look in words, for prompts', () => {
  assert.equal(wordsFor(bible), 'June: a jazz singer in her thirties; shoulder-length black hair, a small scar over the left eyebrow.')
  assert.equal(wordsFor(normalize(tess)), '')
})

await ok('Seedance gets face, three-quarter and full body first, up to 3', () => {
  assert.deepEqual(seedancePictures(bible).map((p) => p.role), ['face', 'three-quarter', 'full body'])
  assert.deepEqual(seedancePictures(bible, 5).map((p) => p.role), ['face', 'three-quarter', 'full body', 'outfit', 'expression'])
  // an old preset with only a face picture
  assert.deepEqual(seedancePictures(normalize(maya)).map((p) => p.file), ['C:\\x\\maya.png'])
})

await ok('H3: LoRA, else RefMod, else the face picture, else words; a LoRA ComfyUI lacks falls to the picture', () => {
  assert.equal(showFor('h3', normalize(tess)).way, 'lora')
  assert.equal(showFor('h3', normalize(maya)).way, 'refmod')
  const pic = showFor('h3', bible)
  assert.equal(pic.way, 'pictures')
  assert.equal(pic.pictures[0].file, 'C:\\c\\face.png')
  assert.equal(showFor('h3', normalize({ id: 'w', name: 'Wes', look: 'tall' })).way, 'words')
  const gone = showFor('h3', normalize({ ...tess, picture: 'C:\\t.png' }), { exists: () => false })
  assert.equal(gone.way, 'pictures')
  assert.match(gone.note, /isn't in ComfyUI/)
})

await ok('readiness per model, for the cards', () => {
  const r = readiness(bible)
  assert.deepEqual(Object.keys(r), ['h3', 'seedance'])
  assert.equal(r.h3.label, 'Ready with pictures')
  assert.equal(r.seedance.label, 'Ready with pictures')
  assert.equal(readiness(normalize(tess)).h3.label, 'Ready with LoRA')
  assert.equal(readiness(normalize(tess)).seedance.label, 'Words only')
})

await ok('more H3 LoRAs load with the main one', () => {
  const t = normalize({ ...tess, models: { h3: { loras: [{ name: 'style.safetensors', strength: 0.5 }, { name: tess.lora, strength: 1 }] } } })
  assert.deepEqual(t.models.h3.loras, [{ name: 'style.safetensors', strength: 0.5 }])
  const plan = planPreviews({ prompt: '{char} waves.', character: 'tess' }, [t])
  const state = JSON.parse(plan.values['1001.LoraLoaderState'])
  assert.deepEqual(state.loras.map((l) => [l.name, l.sm]), [[tess.lora, 0.8], ['style.safetensors', 0.5]])
})

await ok('H3 with a pictures-only character: {char} becomes their @ mention, attached as a referenced subject', () => {
  const { request, notes } = h3Request({ prompt: '[Shot 1] {char} sings at the microphone.', character: 'june', mode: 'text' }, [bible], { handle: 'June' })
  assert.equal(request.character, 'none')
  assert.equal(request.prompt, '[Shot 1] @June sings at the microphone.')
  assert.deepEqual(notes, [])
  const members = [{ handle: 'June', kind: 'character', id: 'june', name: 'June Park', picture: 'C:\\c\\face.png' }]
  const done = resolveMentions(request, members).request
  assert.equal(done.mode, 'reference')
  assert.match(done.prompt, /<Subject 1> is June Park/)
  assert.deepEqual(done.media, [{ kind: 'picture', file: 'C:\\c\\face.png' }])
  // a LoRA character passes through untouched
  const same = { prompt: '{char} waves.', character: 'tess' }
  assert.equal(h3Request(same, [normalize(tess)], { handle: 'Tess' }).request, same)
  // words only: the name
  const w = h3Request({ prompt: '{char} waves.', character: 'w' }, [normalize({ id: 'w', name: 'Wes Hale', look: 'tall' })], { handle: 'Wes' })
  assert.equal(w.request.prompt, 'Wes waves.')
  assert.equal(w.notes[0].level, 'warning')
})

await ok('Seedance: the bible pictures come in with their role lines and the look in words', () => {
  const plan = planSeedance({ prompt: '{char} sings.', character: 'june', mode: 'text' }, [bible], { pictures: seedancePictures(bible) })
  assert.deepEqual(plan.refs.pictures, ['C:\\c\\face.png', 'C:\\c\\three.png', 'C:\\c\\body.png'])
  assert.deepEqual(plan.refs.characterTags, ['@image1', '@image2', '@image3'])
  assert.equal(plan.node.cls, NODES.reference)
  assert.match(plan.request.prompt, /@image1 defines June's face/)
  assert.match(plan.request.prompt, /@image3 shows June's full body/)
  assert.match(plan.request.prompt, /June: a jazz singer in her thirties/)
  assert.match(plan.request.prompt, /June sings\.$/)
  // the person's own pictures come first
  const mine = planSeedance({ prompt: '@image1 is the room. {char} sings.', character: 'june', mode: 'reference', media: [{ kind: 'picture', file: 'C:\\room.png' }] }, [bible], { pictures: seedancePictures(bible) })
  assert.deepEqual(mine.refs.characterTags, ['@image2', '@image3', '@image4'])
  // an old preset with only a face still works as before
  const old = planSeedance({ prompt: '{char} sings.', character: 'maya' }, [normalize(maya)], { face: 'C:\\x\\maya.png' })
  assert.deepEqual(old.refs.pictures, ['C:\\x\\maya.png'])
  assert.match(old.request.prompt, /@image1 defines Maya's face/)
})

await ok('Seedance 2.5 Flash: two qualities, finals, on the same nodes', () => {
  assert.equal(SEEDANCE_TIERS.flash480.model, 'Seedance 2.5 Flash')
  assert.equal(SEEDANCE_TIERS.flash720.resolution, '720p')
  const plan = planSeedance({ prompt: 'A boat on a lake.', tier: 'flash720', seconds: 6 }, [])
  assert.equal(plan.resolved.draft, false)
  assert.equal(plan.resolved.model, 'Seedance 2.5 Flash')
  assert.equal(plan.resolved.width, 1280)
  const g = seedanceGraph(plan, { pictures: [], videos: [], audios: [] }, {}, 'x')
  assert.equal(g.take1.inputs.model, 'Seedance 2.5 Flash')
  assert.equal(g.take1.inputs['model.resolution'], '720p')
})

await ok('Flash is offered only when the ComfyUI has it', () => {
  const info = (keys) => ({ [NODES.text]: { input: { required: { model: ['COMFY_DYNAMICCOMBO_V3', { options: keys.map((key) => ({ key, inputs: {} })) }] } } } })
  const old = info(['Seedance 2.5', 'Seedance 2.5 Draft', 'Seedance 2.0'])
  assert.deepEqual(modelsIn(old), ['Seedance 2.5', 'Seedance 2.5 Draft', 'Seedance 2.0'])
  assert.deepEqual(tiersIn(old), ['draft', '720p', '1080p'])
  assert.deepEqual(tiersIn(info(['Seedance 2.5', 'Seedance 2.5 Draft', 'Seedance 2.5 Flash'])), ['draft', '720p', '1080p', 'flash480', 'flash720'])
  // unreadable: everything
  assert.equal(tiersIn({}).length, 5)
})

await ok('Studio: reading never writes; the first save moves an old file over with a backup; pictures copy into the data folder', () => {
  const dataDir = tmp()
  const src = tmp()
  const file = path.join(dataDir, 'characters.json')
  const before = JSON.stringify([tess, maya])
  fs.writeFileSync(file, before)
  fs.writeFileSync(path.join(dataDir, 'characters.v1.json'), '["an older backup"]')
  const studio = new Studio({ dataDir, resourcesDir: path.resolve('resources'), comfyUrl: 'http://127.0.0.1:9' })
  const list = studio.characters()
  assert.equal(list.length, 2)
  assert.ok(list.every((c) => c.version === 2))
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'reading left the file alone')
  // the same ids every read, before it's ever saved
  assert.deepEqual(studio.characters(), list)
  studio.saveCharacters(list)
  const backups = fs.readdirSync(dataDir).filter((f) => /^characters\.v1-.+\.json$/.test(f))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8'), before)
  assert.equal(fs.readFileSync(path.join(dataDir, 'characters.v1.json'), 'utf8'), '["an older backup"]', 'an older backup is never overwritten')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].version, 2)
  studio.saveCharacters(studio.characters())
  assert.equal(fs.readdirSync(dataDir).filter((f) => /^characters\.v1-/.test(f)).length, 1, 'moved once')

  const made = studio.saveCharacter({ name: 'June Park', about: 'a jazz singer' })
  assert.match(made.id, /^char/)
  const a = png(src, 'front.png')
  const b = png(src, 'body.png')
  let june = studio.addCharacterPictures(made.id, [a])
  assert.equal(june.pictures[0].role, 'face')
  june = studio.addCharacterPictures(made.id, [b], 'full body')
  assert.equal(june.pictures.length, 2)
  assert.ok(june.pictures.every((p) => p.file.startsWith(path.join(dataDir, 'characters', made.id))))
  assert.equal(june.picture, june.pictures[0].file)
  fs.rmSync(a)
  assert.ok(fs.existsSync(june.pictures[0].file), 'the copy stays when the original goes')
  const first = june.pictures[0]
  june = studio.removeCharacterPicture(made.id, first.id)
  assert.equal(june.pictures.length, 1)
  assert.equal(june.picture, june.pictures[0].file, 'the full body becomes the face picture when the face goes')
  assert.equal(fs.existsSync(first.file), false)
  assert.throws(() => studio.addCharacterPictures(made.id, [path.join(src, 'nope.png')]), /isn't there/)
  assert.throws(() => studio.saveCharacter({ name: ' ' }), /name/)
})

await ok('Studio: an H3 plan with a pictures-only character renders in References mode with their face', () => {
  const dataDir = tmp()
  const src = tmp()
  const studio = new Studio({ dataDir, resourcesDir: path.resolve('resources'), comfyUrl: 'http://127.0.0.1:9' })
  studio.saveCharacters([tess])
  const c = studio.saveCharacter({ name: 'June Park', about: 'a jazz singer' })
  const june = studio.addCharacterPictures(c.id, [png(src, 'f.png')])
  const plan = studio.planRender({ prompt: '[Shot 1] {char} sings at the microphone.', character: c.id, mode: 'text', seconds: 5 }, false)
  assert.equal(plan.mode, 'reference')
  // the LoRA character still renders with its LoRA
  const lora = studio.planRender({ prompt: '[Shot 1] {char} waves.', character: 'tess', mode: 'text', seconds: 5 }, false)
  assert.equal(lora.mode, 'text')
  assert.ok(june.picture)
})

console.log(`\n${n - failed} of ${n} passed`)
if (failed) process.exit(1)
