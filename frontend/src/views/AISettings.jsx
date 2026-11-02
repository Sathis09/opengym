import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { useAI, getAIKey } from '../store/useAI.js'
import { PROVIDERS, listModels, testConnection } from '../lib/ai-providers.js'
import { emptyCoach } from '../lib/coach.js'
import { t } from '../lib/i18n.js'
import { MOBILE } from '../lib/mobile.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Section, Row, Button, TextArea, SearchField } from '../components/ui.jsx'

/* Gym Plus (mobile build only): bring-your-own-key AI settings. The key goes straight into
   the phone's secure storage through useAI — it is never put in S, never synced, never shown
   again once saved. The free-text instructions DO live in S (S.coach.instructions) so they
   follow the user to another phone; writing them creates the coach namespace with
   emptyCoach(), whose consent stays null — typing instructions is not opting in. */

const MAX_INSTR = 1000
const modelId = m => (typeof m === 'string' ? m : m?.id || m?.name || '')
const uniq = a => [...new Set(a.filter(Boolean))]

export default function AISettings() {
  const nav = useNavigate()
  const loc = useLocation()
  const ai = useAI()
  const toast = useUI(s => s.toast)
  const providers = PROVIDERS || []
  const prov = providers.find(p => p.id === ai.provider) || null

  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [test, setTest] = useState({ state: 'idle', error: null })   // idle | busy | ok | err
  const [models, setModels] = useState(null)                         // null = not loaded → fallback list
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsErr, setModelsErr] = useState(null)

  // reset per-provider state when the provider changes
  useEffect(() => { setKey(''); setShow(false); setTest({ state: 'idle', error: null }); setModels(null); setModelsErr(null) }, [ai.provider])

  // A freshly typed key wins; otherwise read the saved one back from secure storage, only for
  // the duration of the request (never kept in component state).
  const currentKey = async () => {
    if (key.trim()) return key.trim()
    try { return (await getAIKey(ai.provider)) || '' } catch (e) { return '' }
  }

  const refreshModels = async (k) => {
    if (!prov) return
    const useKey = k || await currentKey()
    if (!useKey) { setModelsErr(t('Save a key first to load the model list.')); return }
    setLoadingModels(true); setModelsErr(null)
    try {
      const list = uniq(((await listModels(prov.id, useKey)) || []).map(modelId))
      setModels(list.length ? list : null)
      if (!list.length) setModelsErr(t('No models returned — showing suggestions.'))
    } catch (e) {
      setModels(null)
      setModelsErr(t('Could not load models — showing suggestions.') + (e?.message ? ' (' + e.message + ')' : ''))
    }
    setLoadingModels(false)
  }

  // once a key is saved for this provider, load the real model list
  useEffect(() => { if (ai.hasKey && prov) refreshModels() }, [ai.provider, ai.hasKey])

  const fallback = uniq((prov?.fallbackModels || []).map(modelId))
  const modelList = models || fallback

  // a provider switch with no model chosen yet: preselect the first suggestion
  useEffect(() => {
    if (prov && !ai.model && fallback.length) ai.setModel?.(fallback[0])
  }, [ai.provider])

  const saveKey = async () => {
    const k = key.trim()
    if (!k) return
    try {
      const replacing = ai.hasKey
      await ai.saveKey(k)
      toast(t('Key saved on this phone'))
      setShow(false)
      setKey('')
      // a first key flips hasKey, and the effect above loads the list; a replaced key doesn't
      if (replacing) refreshModels(k)
    } catch (e) { toast(e?.message || t('Could not save the key')) }
  }

  const runTest = async () => {
    const k = await currentKey()
    if (!k) { setTest({ state: 'err', error: t('Enter a key first.') }); return }
    setTest({ state: 'busy', error: null })
    try {
      const r = await testConnection(prov.id, k, ai.model || undefined)
      if (r?.ok) {
        setTest({ state: 'ok', error: null })
        // a typed key that just worked is worth keeping
        if (key.trim() && !ai.hasKey) { await ai.saveKey(key.trim()); setKey('') }
      } else setTest({ state: 'err', error: r?.error || t('Connection failed') })
    } catch (e) { setTest({ state: 'err', error: e?.message || t('Connection failed') }) }
  }

  const paste = async () => {
    try {
      const txt = (await navigator.clipboard.readText())?.trim()
      if (txt) { setKey(txt); setTest({ state: 'idle', error: null }) }
      else toast(t('Clipboard is empty'))
    } catch (e) { toast(t('Couldn’t read the clipboard — long-press the field to paste')) }
  }
  const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText

  const removeKey = () => confirmSheet({
    title: t('Remove the API key?'),
    message: t('The key is deleted from this phone’s secure storage. The Coach stops working until you add a key again.'),
    confirmText: t('Remove key'), danger: true,
    onConfirm: async () => {
      try { await ai.removeKey(); setTest({ state: 'idle', error: null }); setModels(null); toast(t('Key removed')) }
      catch (e) { toast(e?.message || t('Could not remove the key')) }
    },
  })

  const pickModel = () => useUI.getState().openSheet(close => (
    <ModelSheet close={close} models={modelList} value={ai.model} onPick={m => { ai.setModel(m); setTest({ state: 'idle', error: null }) }} />
  ))

  // Switching provider: a model id from the old provider means nothing to the new one, so
  // start from the new provider's first suggestion unless the store remembered one for it.
  const pickProvider = async id => {
    if (id === ai.provider) return
    await ai.setProvider(id)
    const st = useAI.getState()
    const first = modelId(providers.find(p => p.id === id)?.fallbackModels?.[0])
    if (first && !st.model) st.setModel?.(first)
  }

  if (!MOBILE) return null
  const back = () => (loc.key !== 'default' ? nav(-1) : nav('/profile'))
  const ready = !!(ai.hasKey && ai.model)
  const provLabel = prov?.label || t('the provider')

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={back} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 10 }}>
        <h1>{t('AI Coach')}</h1>
        <div className="sub">{t('Use your own AI provider account')}</div>
      </div>
    </div>

    <Section title={t('Provider')}>
      {providers.map(p => (
        <Row key={p.id} title={p.label} accessory={p.id === ai.provider ? 'check' : 'none'} onClick={() => pickProvider(p.id)} />
      ))}
    </Section>

    {prov && <>
      <Section title={t('API key')}
        footer={t('Your key stays on this phone, in its secure storage. The Coach sends a summary of your training straight to {0}; you pay them directly.', provLabel)}>
        <div className="lrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10, paddingTop: 12, paddingBottom: 12 }}>
          {ai.hasKey && !key && (
            <div className="row" style={{ gap: 8 }}>
              <Icon name="lock" style={{ color: 'var(--green)' }} />
              <span className="small">{t('A key is saved on this phone.')}</span>
            </div>
          )}
          <div className="gp-keyf">
            <input
              className="field"
              type={show ? 'text' : 'password'}
              autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              placeholder={ai.hasKey ? t('Paste a new key to replace it') : (prov.keyHint || t('Paste your API key'))}
              value={key}
              onChange={e => { setKey(e.target.value); setTest({ state: 'idle', error: null }) }}
            />
            <button className="btn xs plain" onClick={() => setShow(v => !v)} disabled={!key}>{show ? t('Hide') : t('Show')}</button>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {canPaste && <Button size="sm" icon="clipboard" onClick={paste}>{t('Paste')}</Button>}
            {prov.keyUrl && <Button size="sm" variant="plain" icon="link" onClick={() => window.open(prov.keyUrl, '_blank', 'noopener')}>{t('Get a key')}</Button>}
            <div style={{ flex: 1 }} />
            {!!key.trim() && <Button size="sm" variant="primary" icon="check" onClick={saveKey}>{t('Save key')}</Button>}
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Button size="sm" variant="tinted" disabled={test.state === 'busy' || (!key.trim() && !ai.hasKey)} onClick={runTest}>
              {test.state === 'busy' ? <span className="gp-inline"><span className="gp-spin sm" />{t('Testing…')}</span> : t('Test connection')}
            </Button>
            {test.state === 'ok' && <span className="small gp-ok"><Icon name="checkCircle" /> {t('Connected')}</span>}
            {test.state === 'err' && <span className="small gp-err">{test.error}</span>}
          </div>
        </div>
      </Section>

      <Section title={t('Model')}
        footer={modelsErr || (models ? t('{0} models available from {1}', models.length, provLabel) : t('Suggested models — save a key to load the full list.'))}>
        <Row icon="bolt" iconTint="var(--purple)" title={t('Model')} value={ai.model || t('Choose')} accessory="chevron" onClick={pickModel} />
        <Row icon="reset" iconTint="var(--blue)" title={loadingModels ? t('Loading models…') : t('Refresh model list')}
          onClick={loadingModels ? undefined : () => refreshModels()}>
          {loadingModels && <span className="gp-spin sm" />}
        </Row>
      </Section>
    </>}

    <InstructionsCard />

    {prov && ai.hasKey && (
      <Section>
        <Row icon="trash" iconTint="var(--red)" title={t('Remove key')} danger onClick={removeKey} />
      </Section>
    )}

    {ready && <>
      <Button variant="primary" icon="sparkles" onClick={() => nav('/coach')}>{t('Open the Coach')}</Button>
      <div style={{ height: 16 }} />
    </>}
  </div>
}

// Free-text instructions, synced with the rest of S. Saved on a short debounce and on leave.
function InstructionsCard() {
  const saved = useStore(s => s.S.coach?.instructions || '')
  const [draft, setDraft] = useState(saved)
  const latest = useRef(draft)
  const tm = useRef(null)

  const commit = v => {
    clearTimeout(tm.current); tm.current = null
    const val = String(v || '').slice(0, MAX_INSTR)
    if ((useStore.getState().S.coach?.instructions || '') === val) return
    useStore.getState().update(s => {
      if (!s.coach) s.coach = emptyCoach()   // consent stays null — this is not opting in
      s.coach.instructions = val
    })
  }
  const change = v => {
    v = v.slice(0, MAX_INSTR)
    setDraft(v); latest.current = v
    clearTimeout(tm.current)
    tm.current = setTimeout(() => commit(latest.current), 800)
  }
  // flush on unmount (leaving the screen mid-debounce)
  useEffect(() => () => { if (tm.current) commit(latest.current) }, [])

  return (
    <Section title={t('Your instructions')}
      footer={t('Included every time the Coach plans or reviews your training. Synced with your data.')}>
      <div className="lrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, paddingTop: 12, paddingBottom: 10 }}>
        <TextArea rows={4} value={draft} maxLength={MAX_INSTR}
          onChange={e => change(e.target.value)} onBlur={() => commit(latest.current)}
          placeholder={t('Bad left knee, 45-minute sessions, dumbbells only at home…')} />
        <div className="dim small" style={{ textAlign: 'right' }}>{draft.length}/{MAX_INSTR}</div>
      </div>
    </Section>
  )
}

function ModelSheet({ close, models, value, onPick }) {
  const [q, setQ] = useState('')
  const [custom, setCustom] = useState(null)   // null = list mode, string = typing a custom id
  const list = q ? models.filter(m => m.toLowerCase().includes(q.toLowerCase())) : models
  const pick = m => { const v = (m || '').trim(); if (!v) return; close(); onPick(v) }

  if (custom !== null) return <>
    <h3>{t('Custom model')}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{t('Type the exact model ID your provider uses.')}</div>
    <input className="field" autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false}
      value={custom} onChange={e => setCustom(e.target.value)} placeholder="e.g. gpt-4o-mini"
      onKeyDown={e => { if (e.key === 'Enter') pick(custom) }} />
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={!custom.trim()} onClick={() => pick(custom)}>{t('Use this model')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={() => setCustom(null)}>{t('Back to the list')}</Button>
  </>

  return <>
    <h3>{t('Model')}</h3>
    {models.length > 10 && <>
      <SearchField value={q} onChange={e => setQ(e.target.value)} onClear={() => setQ('')} placeholder={t('Search models')} />
      <div style={{ height: 10 }} />
    </>}
    <div className="sect-b">
      {list.map(m => (
        <button key={m} className="lrow tap" onClick={() => pick(m)}>
          <span className="lrow-m"><span className="lrow-t gp-mono">{m}</span></span>
          {m === value && <Icon name="check" className="lrow-k" />}
        </button>
      ))}
      <button className="lrow tap" onClick={() => setCustom(value && !models.includes(value) ? value : q)}>
        <span className="lrow-m"><span className="lrow-t" style={{ color: 'var(--acc)' }}>{t('Custom model…')}</span></span>
        {value && !models.includes(value) && <span className="lrow-v gp-mono">{value}</span>}
      </button>
    </div>
    <div style={{ height: 8 }} />
  </>
}
