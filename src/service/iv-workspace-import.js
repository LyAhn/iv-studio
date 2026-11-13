import { briefText } from './iv-workspace.js'

export function receiveStudio(h, workspace, productions) {
  const id = `iv-${h.id}`
  // A deterministic native ID makes a retry safe even if the app stopped before its receipt was saved.
  try {
    const old = productions.get(id)
    if (old.ivWorkspace?.handoffId !== h.id) throw Error('This project ID is already in use.')
    return { kind: 'production', id, brandId: h.brandId }
  } catch (e) { if (!String(e.message).startsWith('No project ')) throw e }
  const brand = workspace.brand(h.brandId), now = new Date().toISOString()
  productions.write({ id, kind: 'short', name: h.brief.title, logline: h.brief.goal || h.brief.title,
    aspect: /instagram|tiktok|youtube/i.test(h.brief.channel) ? '9:16' : '16:9', targetSeconds: 30,
    step: 'idea', createdAt: now, cast: [], locations: [], props: [], look: { notes: briefText(h, brand), loras: [] },
    script: { text: '' }, scenes: [], breakdown: null, editId: null,
    ivWorkspace: { handoffId: h.id, brandId: h.brandId, brandRevision: brand.revision, brief: h.brief, assets: h.assets } })
  return { kind: 'production', id, brandId: h.brandId }
}
