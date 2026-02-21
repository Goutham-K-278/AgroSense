import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { useTranslation } from 'react-i18next'
import { auth } from '../firebase'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const cropOptions = [
  'Rice',
  'Wheat',
  'Maize',
  'Sugarcane',
  'Cotton',
  'Groundnut',
  'Tomato',
  'Onion',
  'Potato',
  'Banana',
  'Millets',
  'Pulses',
  'Soybean',
  'Chili',
  'Brinjal',
]

const soilTypeOptions = ['Sandy', 'Clay', 'Loamy', 'Black Soil', 'Red Soil']
const fertilizerTypeOptions = ['Urea', 'DAP', 'MOP', 'NPK 19-19-19', 'Organic Manure']

const round = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number.toFixed(2) : '0.00'
}

function Fertilizer() {
  const [form, setForm] = useState({
    crop: 'Rice',
    soilType: 'Loamy',
    fertilizerStatus: 'notApplied',
    appliedFertilizer: 'Urea',
    quantity: 20,
  })
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const [authUser, setAuthUser] = useState(null)
  const [error, setError] = useState('')
  const { t, i18n } = useTranslation()

  const fertilizerApplied = form.fertilizerStatus === 'applied'
  const translateOption = (group, value) => t(`fertilizer.options.${group}.${value}`, value)

  const updateField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user)
      setAuthReady(true)
    })

    return () => unsubscribe()
  }, [])

  const fetchJson = async (url, options = {}) => {
    const controller = new AbortController()
    const timeoutMs = Number(options.timeoutMs || 10000)
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      })

      const rawText = await response.text()
      let data = null
      try {
        data = rawText ? JSON.parse(rawText) : null
      } catch {
        data = null
      }

      if (!response.ok) {
        throw new Error(data?.error || data?.message || t('fertilizer.errors.requestFailed', { code: response.status }))
      }

      return data || {}
    } catch (requestError) {
      if (requestError?.name === 'AbortError') {
        throw new Error(t('fertilizer.errors.timeout'))
      }
      throw requestError
    } finally {
      clearTimeout(timer)
    }
  }

  const generatePlan = async () => {
    try {
      setLoading(true)
      setError('')

      const currentUser = authUser || auth.currentUser
      if (!currentUser) {
        throw new Error(t('fertilizer.errors.loginRequired'))
      }

      const token = await currentUser.getIdToken(true)
      const payload = {
        crop: form.crop,
        soilType: form.soilType,
        fertilizerApplied,
      }

      if (fertilizerApplied) {
        payload.appliedFertilizer = form.appliedFertilizer
        payload.quantity = Number(form.quantity)
      }

      const data = await fetchJson(`${API_BASE_URL}/api/fertilizer/plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        timeoutMs: 10000,
      })

      setResult(data)
    } catch (requestError) {
      setResult(null)
      setError(requestError?.message || t('fertilizer.errors.generateFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return

    if (!result) {
      window.__uzhavarPageSummary = {
        page: 'fertilizer',
        summary: i18n.language === 'ta' ? 'உரம் திட்டம் இன்னும் உருவாக்கப்படவில்லை.' : 'Fertilizer plan not generated yet.',
        timestamp: Date.now(),
      }
      return
    }

    const summary =
      i18n.language === 'ta'
        ? `பயிர்: ${translateOption('crops', form.crop)}, மண்: ${translateOption('soilTypes', form.soilType)}. மீதமுள்ள குறைவு N:${round(result.remainingDeficit?.N)} P:${round(result.remainingDeficit?.P)} K:${round(result.remainingDeficit?.K)}. ஆலோசனை: ${result.applicationAdvice || '-'}`
        : `Crop: ${translateOption('crops', form.crop)}, soil: ${translateOption('soilTypes', form.soilType)}. Remaining deficit N:${round(result.remainingDeficit?.N)} P:${round(result.remainingDeficit?.P)} K:${round(result.remainingDeficit?.K)}. Advice: ${result.applicationAdvice || '-'}`

    window.__uzhavarPageSummary = {
      page: 'fertilizer',
      summary,
      timestamp: Date.now(),
    }
  }, [form.crop, form.soilType, i18n.language, result, t])

  return (
    <section>
      <h1 className="text-3xl font-bold text-emerald-700">{t('fertilizer.title')}</h1>
      <p className="mt-2 text-sm text-slate-600">{t('fertilizer.subtitle')}</p>

      <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-emerald-100">
        <h2 className="text-lg font-semibold text-slate-800">{t('fertilizer.sections.fieldInfo')}</h2>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            {t('fertilizer.labels.crop')}
            <select
              value={form.crop}
              onChange={(event) => updateField('crop', event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            >
              {cropOptions.map((item) => (
                <option key={item} value={item}>{translateOption('crops', item)}</option>
              ))}
            </select>
          </label>

          <label className="text-sm font-medium text-slate-700">
            {t('fertilizer.labels.soilType')}
            <select
              value={form.soilType}
              onChange={(event) => updateField('soilType', event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            >
              {soilTypeOptions.map((item) => (
                <option key={item} value={item}>{translateOption('soilTypes', item)}</option>
              ))}
            </select>
          </label>
        </div>

        <h2 className="mt-6 text-lg font-semibold text-slate-800">{t('fertilizer.sections.status')}</h2>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-700">
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              name="fertStatus"
              value="notApplied"
              checked={form.fertilizerStatus === 'notApplied'}
              onChange={(event) => updateField('fertilizerStatus', event.target.value)}
            />
            {t('fertilizer.status.notApplied')}
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              name="fertStatus"
              value="applied"
              checked={form.fertilizerStatus === 'applied'}
              onChange={(event) => updateField('fertilizerStatus', event.target.value)}
            />
            {t('fertilizer.status.applied')}
          </label>
        </div>

        {fertilizerApplied ? (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium text-slate-700">
              {t('fertilizer.labels.fertilizerType')}
              <select
                value={form.appliedFertilizer}
                onChange={(event) => updateField('appliedFertilizer', event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                {fertilizerTypeOptions.map((item) => (
                  <option key={item} value={item}>{translateOption('fertilizerTypes', item)}</option>
                ))}
              </select>
            </label>

            <label className="text-sm font-medium text-slate-700">
              {t('fertilizer.labels.quantity')}
              <input
                type="number"
                min="0"
                step="0.1"
                value={form.quantity}
                onChange={(event) => updateField('quantity', event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
          </div>
        ) : null}

        <button
          type="button"
          onClick={generatePlan}
          disabled={loading || !authReady}
          className="mt-6 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? t('fertilizer.buttons.calculating') : !authReady ? t('fertilizer.buttons.checkingLogin') : t('fertilizer.buttons.generate')}
        </button>

        {!loading && authReady && !authUser ? (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{t('fertilizer.messages.loginPrompt')}</p>
        ) : null}

        {error ? <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      </div>

      {result ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <article className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
            <h3 className="text-lg font-semibold text-slate-800">{t('fertilizer.results.cropRequirement')}</h3>
            <p className="mt-2 text-sm text-slate-700">N: {round(result.cropRequirement?.N)} · P: {round(result.cropRequirement?.P)} · K: {round(result.cropRequirement?.K)}</p>
          </article>

          <article className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
            <h3 className="text-lg font-semibold text-slate-800">{t('fertilizer.results.supplied')}</h3>
            <p className="mt-2 text-sm text-slate-700">N: {round(result.suppliedNPK?.N)} · P: {round(result.suppliedNPK?.P)} · K: {round(result.suppliedNPK?.K)}</p>
          </article>

          <article className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
            <h3 className="text-lg font-semibold text-slate-800">{t('fertilizer.results.deficit')}</h3>
            <p className="mt-2 text-sm text-slate-700">N: {round(result.remainingDeficit?.N)} · P: {round(result.remainingDeficit?.P)} · K: {round(result.remainingDeficit?.K)}</p>
          </article>

          <article className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
            <h3 className="text-lg font-semibold text-slate-800">{t('fertilizer.results.cost')}</h3>
            <p className="mt-2 text-sm text-slate-700">{t('fertilizer.results.costApplied', { value: round(result.costEstimate?.suppliedCost) })} · {t('fertilizer.results.costRecommended', { value: round(result.costEstimate?.recommendedCost) })}</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{t('fertilizer.results.costTotal', { value: round(result.costEstimate?.totalEstimatedCost) })}</p>
          </article>

          <article className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100 md:col-span-2">
            <h3 className="text-lg font-semibold text-slate-800">{t('fertilizer.results.recommended')}</h3>
            <ul className="mt-3 grid gap-2 sm:grid-cols-3">
              {(result.recommendedFertilizer || []).map((item) => (
                <li key={item.type} className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-slate-700">
                  {item.type}: {round(item.quantityKgPerAcre)}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-slate-700">{result.applicationAdvice}</p>
          </article>
        </div>
      ) : null}
    </section>
  )
}

export default Fertilizer
