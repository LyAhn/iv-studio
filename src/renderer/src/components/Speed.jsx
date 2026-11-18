// The speed presets (service/speed.js): cards in Settings → Your PC, a compact row in Create's Shape and size.
// FirstRenders: the app-wide first-render size, the same control on every page that hunts takes.
import { useEffect, useState } from 'react'
import { PREVIEW_SIZES, roughTime, savedPreviewMp, SPEED_IDS, SPEEDS } from '../../../service/speed'

// Settings: one card per preset with what it trades and its time on a 4090
export function SpeedCards({ value, onPick, recommended }) {
  return (
    <div className="set-engines speed-cards" role="radiogroup" aria-label="Speed">
      {SPEED_IDS.map((id) => {
        const s = SPEEDS[id]
        return (
          <button key={id} role="radio" aria-checked={value === id} className={`set-engine ${value === id ? 'on' : ''}`} onClick={() => onPick(id)}>
            <span className="set-engine-name">{s.label}</span>
            <span className="small">{s.say}</span>
            <span className="small dim">{s.trade}</span>
            <span className="speed-time mono">
              Hunt {roughTime(s.estimate.hunt)} · finish {roughTime(s.estimate.finish)}
            </span>
            {recommended === id && <span className="speed-rec mono">Suits this PC</span>}
          </button>
        )
      })}
    </div>
  )
}

// Create: the presets as a segmented row; "Custom" when the size, steps or takes were changed by hand
export function SpeedRow({ value, onPick }) {
  const s = SPEEDS[value]
  return (
    <div className="create-field speed-row">
      <span className="create-label mono">
        Speed <span className="create-value">{s ? s.label : 'Custom'}</span>
      </span>
      <div className="segmented" role="radiogroup" aria-label="Speed">
        {SPEED_IDS.map((id) => (
          <button key={id} role="radio" aria-checked={value === id} className={value === id ? 'on' : ''} onClick={() => onPick(id)} title={SPEEDS[id].say}>
            {SPEEDS[id].label}
          </button>
        ))}
      </div>
      <span className="dim small">{s ? `${s.say} Hunt ${roughTime(s.estimate.hunt)}, finish ${roughTime(s.estimate.finish)} on an RTX 4090.` : 'Your own preview size, steps or takes. Pick a preset to go back to one.'}</span>
    </div>
  )
}

// How big the first renders (the takes a hunt makes before you finish one) are, for the whole app: Auto leaves it to
// each page (the speed preset where it has one, else 0.4 MP). Bigger shows more detail and takes longer; the finish
// is its own size either way. Saved in Settings → Your PC, so changing it on any page changes it everywhere.
const MP_TIME = { 0.3: '¾ the time', 0.4: 'the usual time', 0.6: 'about 1¾× the time', 0.8: 'about 2½× the time' }
// The saved first-render size (null: Auto), undefined until read; follows changes made on any page
export function useFirstRenders() {
  const [value, setValue] = useState(undefined)
  useEffect(() => {
    let on = true
    const load = () => window.ivstudio.settings.get().then((s) => on && setValue(savedPreviewMp(s)), () => {})
    load()
    window.addEventListener('iv:settings', load)
    return () => {
      on = false
      window.removeEventListener('iv:settings', load)
    }
  }, [])
  return [value, setValue]
}
export function FirstRenders({ compact = false, label = 'First renders' }) {
  const [value, setValue] = useFirstRenders()
  async function pick(mp) {
    setValue(mp)
    try {
      await window.ivstudio.settings.set({ previewMp: mp })
    } finally {
      window.dispatchEvent(new CustomEvent('iv:settings'))
    }
  }
  if (value === undefined) return null
  return (
    <div className={`create-field first-renders ${compact ? 'compact' : ''}`}>
      <span className="create-label mono">
        {label} <span className="create-value">{value ? `${value} MP` : 'Auto'}</span>
      </span>
      <div className="segmented wrap" role="radiogroup" aria-label={label}>
        {[null, ...PREVIEW_SIZES].map((mp) => (
          <button key={mp ?? 'auto'} role="radio" aria-checked={value === mp} className={value === mp ? 'on' : ''} onClick={() => pick(mp)} title={mp ? `${mp} MP takes, ${MP_TIME[mp]} of 0.4 MP` : 'Each page’s own size: the speed preset where it has one, else 0.4 MP'}>
            {mp ? `${mp} MP` : 'Auto'}
          </button>
        ))}
      </div>
      {!compact && <span className="dim small">The takes every hunt makes before you finish one, on every page. Bigger shows more detail and takes longer; the finish keeps its own size. A shot that sets its own size keeps it.</span>}
    </div>
  )
}
