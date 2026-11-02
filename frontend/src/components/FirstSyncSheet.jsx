import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

/* Gym Plus (mobile build only): the first sign-in found data both on this phone and in the
   user's Google Drive. The store parks both sides in `firstSync` and waits; this sheet shows
   what each side holds and hands the choice to resolveFirstSync. It is locked — swiping it
   away would leave sync undecided. */

const count = (S, k) => (Array.isArray(S?.[k]) ? S[k].length : 0)
const lastWorkout = S => {
  const ds = (S?.workouts || []).map(w => w?.d).filter(Boolean).sort()
  return ds.length ? ds[ds.length - 1] : null
}

function Side({ icon, title, S }) {
  const last = lastWorkout(S)
  return (
    <div className="gp-fs-side">
      <div className="gp-fs-h"><Icon name={icon} /><span>{title}</span></div>
      <div className="gp-fs-n"><b>{count(S, 'workouts')}</b> {t('workouts')}</div>
      <div className="gp-fs-n"><b>{count(S, 'routines')}</b> {t('routines')}</div>
      <div className="gp-fs-n"><b>{count(S, 'bodyweight')}</b> {t('weigh-ins')}</div>
      <div className="dim small" style={{ marginTop: 4 }}>{last ? t('Last workout {0}', fmtDate(last)) : t('No workouts yet')}</div>
    </div>
  )
}

function Choice({ fs, close }) {
  const [busy, setBusy] = useState(null)
  const go = async choice => {
    if (busy) return
    setBusy(choice)
    try {
      await useStore.getState().resolveFirstSync?.(choice)
      close()
      useUI.getState().toast(choice === 'merge' ? t('Merged — your data is backed up')
        : choice === 'cloud' ? t('Using your Google Drive copy') : t('Using this phone’s copy'))
    } catch (e) {
      setBusy(null)
      useUI.getState().toast(e?.code === 'offline' ? t('No connection — try again when you’re online.') : (e?.message || t('Sync failed')))
    }
  }
  const label = (choice, text) => busy === choice ? <span className="gp-inline"><span className="gp-spin sm" />{text}</span> : text
  return <>
    <h3>{t('You have data in two places')}</h3>
    <div className="muted small" style={{ marginBottom: 14, lineHeight: 1.45 }}>
      {t('This phone and your Google Drive both have training data. Choose what to keep.')}
    </div>
    <div className="gp-fs">
      <Side icon="dumbbell" title={t('This phone')} S={fs.local} />
      <Side icon="folder" title={t('Google Drive')} S={fs.remote} />
    </div>
    <Button variant="primary" disabled={!!busy} onClick={() => go('merge')}>{label('merge', t('Merge both (recommended)'))}</Button>
    <div className="dim small" style={{ textAlign: 'center', margin: '6px 0 12px' }}>{t('Keeps everything from both sides; duplicates are combined.')}</div>
    <Button disabled={!!busy} onClick={() => go('cloud')}>{label('cloud', t('Use Google Drive copy'))}</Button>
    <div style={{ height: 8 }} />
    <Button disabled={!!busy} onClick={() => go('local')}>{label('local', t('Use this phone’s copy'))}</Button>
    <div className="dim small" style={{ textAlign: 'center', marginTop: 8 }}>{t('The copy you don’t pick is replaced.')}</div>
  </>
}

export default function FirstSyncSheet() {
  const fs = useStore(s => s.firstSync)
  const handle = useRef(null)

  useEffect(() => {
    if (fs && !handle.current) {
      handle.current = useUI.getState().openSheet(close => <Choice fs={fs} close={close} />, { locked: true })
    } else if (!fs && handle.current) {
      handle.current.close()
      handle.current = null
    }
  }, [fs])

  return null
}
