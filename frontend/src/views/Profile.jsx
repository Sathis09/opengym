import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { useAI } from '../store/useAI.js'
import { PROVIDERS } from '../lib/ai-providers.js'
import { googleConfigured } from '../lib/google-config.js'
import { t, dateLocale } from '../lib/i18n.js'
import { MOBILE } from '../lib/mobile.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Section, Row, Button } from '../components/ui.jsx'

/* Gym Plus (mobile build only): the Google account that backs the data up to the user's own
   Drive, and the way into the AI Coach settings. Nothing here exists on web/self-hosted —
   the route is only registered when MOBILE. */

/* ---------------------------------------------------------------- helpers -- */

export function initials(account) {
  const src = (account?.name || account?.email || '').trim()
  if (!src) return '?'
  const parts = src.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[1][0] : '')).toUpperCase() || '?'
}

// Round photo with an initials fallback (no photo, or it fails to load offline).
export function Avatar({ account, size = 29, className = '' }) {
  const [broken, setBroken] = useState(false)
  const photo = account?.photo
  useEffect(() => { setBroken(false) }, [photo])
  return (
    <span className={'gp-av ' + className} style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} aria-hidden="true">
      {account
        ? (photo && !broken
          ? <img src={photo} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
          : <span>{initials(account)}</span>)
        : <Icon name="person" />}
    </span>
  )
}

export function relTime(ts) {
  if (!ts) return ''
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return t('just now')
  let rtf
  try { rtf = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' }) } catch (e) { rtf = null }
  const fmt = (v, u) => rtf ? rtf.format(-v, u) : `${v} ${u}`
  const m = Math.round(s / 60)
  if (m < 60) return fmt(m, 'minute')
  const h = Math.round(m / 60)
  if (h < 24) return fmt(h, 'hour')
  return fmt(Math.round(h / 24), 'day')
}

// One-line sync status, shared by Profile, the Settings account row and the Home avatar.
export function syncStatusText(account, sync) {
  if (!account) return t('Sign in to back up to Google Drive')
  switch (sync?.state) {
    case 'syncing': return t('Syncing…')
    case 'offline': return t('Offline — will sync when you’re back online')
    case 'auth': return t('Sign-in expired — tap to sign in again')
    case 'error': return t('Sync failed')
    case 'synced': return sync.lastAt ? t('Synced · {0}', relTime(sync.lastAt)) : t('Synced')
    default: return sync?.lastAt ? t('Synced · {0}', relTime(sync.lastAt)) : t('Not synced yet')
  }
}

export function aiSummary(ai) {
  if (!ai?.hasKey || !ai?.model) return t('Not set up')
  const p = (PROVIDERS || []).find(x => x.id === ai.provider)
  return (p?.label || ai.provider) + ' · ' + ai.model
}

// Sign-in errors → toast. A cancelled Google dialog is the user changing their mind: silent.
export async function signInWithGoogle(toast) {
  try {
    await useStore.getState().googleSignIn?.()
    return true
  } catch (e) {
    const code = e?.code
    if (code === 'cancelled') return false
    toast(code === 'config' ? t('Google sign-in isn’t set up in this build.')
      : code === 'network' || code === 'offline' ? t('No connection — try again when you’re online.')
      : (e?.message || t('Sign-in failed')))
    return false
  }
}

/* ------------------------------------------------------------------ view -- */

export default function Profile() {
  const nav = useNavigate()
  const loc = useLocation()
  const account = useStore(s => s.account)
  const sync = useStore(s => s.sync)
  const toast = useUI(s => s.toast)
  const ai = useAI()
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)

  // keeps "Synced · 2 minutes ago" honest while the screen is open
  useEffect(() => { const i = setInterval(() => tick(x => x + 1), 30000); return () => clearInterval(i) }, [])

  if (!MOBILE) return null
  const back = () => (loc.key !== 'default' ? nav(-1) : nav('/home'))
  const configured = (() => { try { return !!googleConfigured() } catch (e) { return false } })()

  const signIn = async () => {
    if (busy) return
    setBusy(true)
    await signInWithGoogle(toast)
    setBusy(false)
  }

  const syncNow = async () => {
    if (sync?.state === 'auth') { signIn(); return }
    try { await useStore.getState().syncNow?.() } catch (e) { toast(e?.message || t('Sync failed')) }
  }

  const signOut = () => useUI.getState().openSheet(close => <SignOutSheet close={close} toast={toast} />)

  const deleteCloud = () => confirmSheet({
    title: t('Delete your Google Drive copy?'),
    message: t('Removes only the backup file from your Google Drive. Your data stays on this phone.'),
    confirmText: t('Delete Drive copy'), danger: true,
    onConfirm: async () => {
      try { await useStore.getState().deleteCloudCopy?.(); toast(t('Google Drive copy deleted')) }
      catch (e) { toast(e?.code === 'offline' ? t('No connection — try again when you’re online.') : (e?.message || t('Could not delete the Drive copy'))) }
    },
  })

  const syncing = sync?.state === 'syncing'
  const syncTint = sync?.state === 'error' || sync?.state === 'auth' ? 'var(--red)'
    : sync?.state === 'offline' ? 'var(--orange)' : 'var(--green)'

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={back} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 10 }}><h1>{t('Profile')}</h1></div>
    </div>

    {!account ? (
      <div className="card gp-hero">
        <span className="gp-hero-i"><Icon name="personCircle" /></span>
        <h2 className="gp-hero-t">{t('Back up & sync with Google')}</h2>
        <p className="muted small gp-hero-p">
          {t('Your data is saved in a “Gym Plus” folder in YOUR Google Drive. Nothing is stored on our servers. You can keep using the app without signing in.')}
        </p>
        <Button variant="primary" disabled={!configured || busy} onClick={signIn}>
          {busy ? <span className="gp-inline"><span className="gp-spin" />{t('Signing in…')}</span> : t('Sign in with Google')}
        </Button>
        {!configured && <p className="dim small gp-hero-p" style={{ marginTop: 10, marginBottom: 0 }}>
          {t('Google sign-in isn’t set up in this build yet (no Google client ID). Everything else works without it.')}
        </p>}
      </div>
    ) : <>
      <div className="card gp-who">
        <Avatar account={account} size={64} />
        <div style={{ minWidth: 0 }}>
          <div className="gp-who-n">{account.name || account.email}</div>
          {account.name && account.email && <div className="muted small gp-who-e">{account.email}</div>}
        </div>
      </div>

      <Section title={t('Backup & sync')}>
        <Row icon={sync?.state === 'error' || sync?.state === 'auth' ? 'info' : 'checkCircle'} iconTint={syncTint}
          title={t('Google Drive sync')} subtitle={syncStatusText(account, sync)}
          onClick={sync?.state === 'auth' ? signIn : undefined}>
          {sync?.state !== 'auth' && (
            <Button size="xs" variant="tinted" disabled={syncing} onClick={e => { e.stopPropagation(); syncNow() }}>
              {syncing ? <span className="gp-inline"><span className="gp-spin sm" />{t('Syncing…')}</span> : t('Sync now')}
            </Button>
          )}
        </Row>
        <Row icon="folder" iconTint="var(--blue)" title={t('Stored in Google Drive')} subtitle="Gym Plus/gymplus-data.json" />
      </Section>
      {sync?.state === 'error' && sync?.error && <p className="sect-f" style={{ marginTop: -18, marginBottom: 22 }}>{sync.error}</p>}
    </>}

    <Section title={t('AI Coach')}>
      <Row icon="sparkles" iconTint="var(--acc)" title={t('AI Coach')} subtitle={aiSummary(ai)} accessory="chevron" onClick={() => nav('/profile/ai')} />
    </Section>

    {account && (
      <Section title={t('Account')}>
        <Row icon="signOut" iconTint="var(--red)" title={t('Sign out')} danger onClick={signOut} />
        <Row icon="trash" iconTint="var(--red)" title={t('Delete my Google Drive copy')}
          subtitle={t('Removes only the cloud file — data stays on this phone.')} danger onClick={deleteCloud} />
      </Section>
    )}
  </div>
}

function SignOutSheet({ close, toast }) {
  const [busy, setBusy] = useState(false)
  const go = async keepLocal => {
    if (busy) return
    setBusy(true)
    try {
      await useStore.getState().googleSignOut?.({ keepLocal })
      close()
      toast(keepLocal ? t('Signed out — your data stays on this phone') : t('Signed out — data removed from this phone'))
    } catch (e) {
      setBusy(false)
      toast(e?.message || t('Could not sign out'))
    }
  }
  return <>
    <h3>{t('Sign out of Google?')}</h3>
    <div className="muted small" style={{ marginBottom: 14, lineHeight: 1.45 }}>
      {t('Your latest changes are backed up to Google Drive first. Then choose what happens to the copy on this phone.')}
    </div>
    <div className="sect-b">
      <Row icon="lock" iconTint="var(--acc)" title={t('Keep my data on this phone')}
        subtitle={t('Keep training offline; sign in again anytime.')} onClick={busy ? undefined : () => go(true)} />
      <Row icon="trash" iconTint="var(--red)" title={t('Remove data from this phone')} danger
        subtitle={t('Your Google Drive copy is kept.')} onClick={busy ? undefined : () => go(false)} />
    </div>
    <div style={{ height: 10 }} />
    <Button variant="ghost" className="dim" disabled={busy} onClick={close}>
      {busy ? <span className="gp-inline"><span className="gp-spin sm" />{t('Signing out…')}</span> : t('Cancel')}
    </Button>
  </>
}
