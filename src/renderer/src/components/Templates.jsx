import { useEffect, useRef, useState } from 'react'
import { ask } from './Confirm'

// Create's own setups (src/service/createmem.js), for both sides (kind 'video' or 'image'):
//   Templates ▾   saved setups; click one to fill the form with it, × to delete it
//   Save as template   names the form as it is now; the prompt and the media are optional
//   New   back to an empty form (the last setup is what Create opens on otherwise)
// summary(form) is the one line shown under each template's name.
const M = () => window.ivstudio.createMemory

export function useCreateTemplates(kind) {
  const [templates, setTemplates] = useState([])
  useEffect(() => {
    M().get(kind).then((m) => setTemplates(m.templates || []), () => {})
  }, [kind])
  return [templates, setTemplates]
}

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86400)
  return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString()
}

function SaveDialog({ kind, hasPrompt, hasMedia, mediaWord, suggest, onSave, onClose }) {
  const [name, setName] = useState(suggest || '')
  const [prompt, setPrompt] = useState(true)
  const [media, setMedia] = useState(true)
  const input = useRef(null)
  useEffect(() => {
    setTimeout(() => input.current?.select(), 0)
    const key = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const save = () => name.trim() && onSave({ name: name.trim(), prompt: hasPrompt && prompt, media: hasMedia && media })
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal template-save" role="dialog" aria-modal="true" aria-labelledby="template-save-title">
        <p className="mono label">{kind === 'image' ? 'Picture template' : 'Shot template'}</p>
        <h2 id="template-save-title">Save as template</h2>
        <p className="small dim" data-plain="Keep these choices under a name, to start from them again any time.">
          Keeps the model, mode, characters, LoRAs, size and every setting under a name, to start from again any time.
        </p>
        <input ref={input} className="confirm-input" value={name} placeholder="A name, like “Tess talking head, 9:16”" maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <div className="template-save-opts">
          <label className={`check ${hasPrompt ? '' : 'off'}`}>
            <input type="checkbox" checked={hasPrompt && prompt} disabled={!hasPrompt} onChange={(e) => setPrompt(e.target.checked)} />
            <span>Include the prompt</span>
          </label>
          <label className={`check ${hasMedia ? '' : 'off'}`}>
            <input type="checkbox" checked={hasMedia && media} disabled={!hasMedia} onChange={(e) => setMedia(e.target.checked)} />
            <span>Include {mediaWord}</span>
          </label>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn btn-small" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-small" disabled={!name.trim()} onClick={save}>
            Save template
          </button>
        </div>
      </div>
    </div>
  )
}

// form: the form as it is; pick(form, includes): what goes into a template; apply(template): fill the form;
// onNew(): an empty form; fresh: the form is already empty (New does nothing); last: the remembered setup's
// note ({ at, ranAt }) while the form is still the one Create opened on.
export default function TemplateBar({ kind, form, pick, apply, onNew, fresh, last, summary, hasPrompt, hasMedia, mediaWord = 'the pictures and clips', notify }) {
  const [templates, setTemplates] = useCreateTemplates(kind)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return
    const away = (e) => !box.current?.contains(e.target) && setOpen(false)
    const key = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    return () => (window.removeEventListener('pointerdown', away), window.removeEventListener('keydown', key))
  }, [open])

  async function save({ name, prompt, media }) {
    try {
      const exists = templates.some((t) => t.name.toLowerCase() === name.toLowerCase())
      if (exists && !(await ask({ title: `Replace "${name}"?`, message: 'A template with that name exists. Saving replaces it with what’s set up now.', confirm: 'Replace' }))) return
      setTemplates(await M().saveTemplate(kind, { name, form: pick(form, { prompt, media }), includes: { prompt, media } }))
      setSaving(false)
      notify?.(`Saved "${name}". Open Templates to start from it again.`, 'info')
    } catch (err) {
      notify?.(err.message)
    }
  }
  async function remove(t) {
    if (!(await ask({ title: `Delete "${t.name}"?`, message: 'Only the template goes. Nothing you’ve made changes.', confirm: 'Delete', danger: true }))) return
    try {
      setTemplates(await M().deleteTemplate(kind, t.id))
    } catch (err) {
      notify?.(err.message)
    }
  }

  return (
    <div className="template-bar">
      <div className="template-menu" ref={box}>
        <button className={`btn btn-small template-open ${open ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          Templates{templates.length ? <span className="template-count mono">{templates.length}</span> : null} <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div className="template-pop" role="menu">
            {templates.length ? (
              templates.map((t) => (
                <div key={t.id} className="template-row">
                  <button role="menuitem" className="template-use" onClick={() => (apply(t), setOpen(false), notify?.(`Set up from "${t.name}".${t.includes?.prompt ? '' : ' Your prompt stays as it was.'}`, 'info'))}>
                    <b>{t.name}</b>
                    <span className="small dim">{[summary?.(t.form), t.includes?.prompt && 'with prompt', t.includes?.media && t.form.media?.length && `${t.form.media.length} file${t.form.media.length > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}</span>
                  </button>
                  <button className="template-del" title={`Delete "${t.name}"`} aria-label={`Delete ${t.name}`} onClick={() => remove(t)}>
                    ×
                  </button>
                </div>
              ))
            ) : (
              <p className="small dim template-empty">No templates yet. Set a shot up the way you like it, then Save as template.</p>
            )}
          </div>
        )}
      </div>
      <button className="btn btn-small template-save-btn" onClick={() => setSaving(true)}>
        Save as template
      </button>
      <button className="btn btn-small template-new" disabled={fresh} title="Start over with an empty form. Your templates stay." onClick={onNew}>
        + New
      </button>
      {last && <span className="small dim template-last">{last.isRun && last.ranAt ? `Set up like your last run, ${ago(last.ranAt)}` : `Set up as you left it, ${ago(last.at)}`}</span>}
      {saving && <SaveDialog kind={kind} hasPrompt={hasPrompt} hasMedia={hasMedia} mediaWord={mediaWord} suggest={summary?.(form)} onSave={save} onClose={() => setSaving(false)} />}
    </div>
  )
}
