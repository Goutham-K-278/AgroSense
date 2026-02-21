import { useEffect, useMemo, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { onValue, ref } from 'firebase/database'
import { useTranslation } from 'react-i18next'
import { auth, database } from '../firebase'
import { localizeCropName, localizeFarmText } from '../utils/localizeFarmText'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const statusStyles = {
  Deficient: 'bg-red-100 text-red-700',
  Moderate: 'bg-yellow-100 text-yellow-700',
  Optimal: 'bg-green-100 text-green-700',
  Excess: 'bg-blue-100 text-blue-700',
  Baseline: 'bg-slate-100 text-slate-700',
}

const riskStyles = {
  low: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
  high: 'bg-red-100 text-red-700',
}

const weatherAlertStyles = {
  rain: 'bg-blue-100 text-blue-700',
  clear: 'bg-sky-100 text-sky-700',
  humid: 'bg-amber-100 text-amber-700',
  normal: 'bg-slate-100 text-slate-700',
}

const cropOptions = ['Rice', 'Wheat', 'Maize', 'Cotton', 'Groundnut', 'Banana', 'Sugarcane', 'Vegetables']

const soilTypeProfiles = {
  Clay: { N: 72, P: 34, K: 58, ph: '6.5 - 7.5' },
  Black: { N: 68, P: 30, K: 62, ph: '7.0 - 8.0' },
  Red: { N: 54, P: 24, K: 45, ph: '6.0 - 7.0' },
  Sandy: { N: 42, P: 18, K: 34, ph: '5.8 - 7.0' },
  Loamy: { N: 64, P: 30, K: 52, ph: '6.2 - 7.4' },
}

const soilTypeOptions = Object.keys(soilTypeProfiles)
const HISTORY_CACHE_KEY = 'npkTrendHistory'

const round = (value, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : fallback
}

const clamp = (value, min, max) => {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return min
  }
  return Math.max(min, Math.min(max, number))
}

const toMoisturePercent = (rawValue) => {
  const raw = Number(rawValue)
  if (!Number.isFinite(raw)) {
    return null
  }
  const percent = (1 - raw / 4095) * 100
  return Math.round(clamp(percent, 0, 100))
}

const pickNumber = (...values) => {
  for (const value of values) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return numeric
    }
  }
  return null
}

const cacheHistory = (records) => {
  try {
    if (typeof window === 'undefined') return
    if (Array.isArray(records) && records.length > 0) {
      window.localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(records.slice(0, 12)))
    }
  } catch {
    // ignore storage issues silently
  }
}

const readCachedHistory = () => {
  try {
    if (typeof window === 'undefined') return []
    const raw = window.localStorage.getItem(HISTORY_CACHE_KEY)
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const normalizeLatestResponse = (payload) => {
  if (!payload || Array.isArray(payload)) {
    return Array.isArray(payload) ? payload[0] || null : null
  }
  if (payload.latest) return payload.latest
  if (payload.data && !Array.isArray(payload.data)) return payload.data
  if (payload.result && !Array.isArray(payload.result)) return payload.result
  return payload
}

const normalizeHistoryResponse = (payload) => {
  if (Array.isArray(payload?.history)) return payload.history
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload)) return payload
  if (payload?.history && typeof payload.history === 'object') return Object.values(payload.history)
  return []
}

const buildSparklinePath = (values = []) => {
  const points = values.map((value) => Number(value)).filter((value) => Number.isFinite(value))
  if (points.length === 0) {
    return ''
  }

  const width = 150
  const height = 44
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1

  return points
    .map((value, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width
      const y = height - ((value - min) / range) * height
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

function ForecastSparkline({ label, values, colorClass, emptyLabel }) {
  const points = Array.isArray(values) ? values.map((value) => round(value)) : []
  const path = buildSparklinePath(points)

  return (
    <div className="rounded-lg bg-white/70 p-2 ring-1 ring-white/80">
      <p className="text-xs font-semibold text-slate-700">{label}</p>
      {path ? (
        <svg viewBox="0 0 150 44" className="mt-1 h-12 w-full">
          <path d={path} fill="none" strokeWidth="3" className={colorClass} />
        </svg>
      ) : (
        <p className="mt-2 text-xs text-slate-500">{emptyLabel}</p>
      )}
      <p className="mt-1 text-xs text-slate-600">{points.join(' → ') || '-'}</p>
    </div>
  )
}

function NpkTrend() {
  const { t, i18n } = useTranslation()
  const [latest, setLatest] = useState(null)
  const [history, setHistory] = useState([])
  const [liveSensor, setLiveSensor] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPredicting, setIsPredicting] = useState(false)
  const [error, setError] = useState('')
  const [firebaseSensor, setFirebaseSensor] = useState(null)
  const [sensorUpdatedAt, setSensorUpdatedAt] = useState(null)
  const [form, setForm] = useState({
    soilType: 'Clay',
    cropType: 'Rice',
    fertilizerUsed: false,
  })
  const getStatusLabel = (status) => t(`npk.status.${String(status).toLowerCase()}`, status)

  useEffect(() => {
    const sensorRef = ref(database, 'sensor')
    const unsubscribe = onValue(sensorRef, (snapshot) => {
      const data = snapshot.val()
      if (!data) {
        setFirebaseSensor(null)
        return
      }

      const nextMoisture = toMoisturePercent(data.soil_moisture)
      const nextTemperature = Number(data.temperature)
      const nextHumidity = Number(data.humidity)
      const nextRainfall = Number(data.rainfall)

      setFirebaseSensor({
        moisture: Number.isFinite(nextMoisture) ? nextMoisture : null,
        temperature: Number.isFinite(nextTemperature) ? Number(nextTemperature.toFixed(1)) : null,
        humidity: Number.isFinite(nextHumidity) ? round(nextHumidity) : null,
        rainfall: Number.isFinite(nextRainfall) ? round(nextRainfall) : null,
      })
      setSensorUpdatedAt(new Date())
    })

    return () => unsubscribe()
  }, [])

  const getAuthHeaders = async () => {
    const currentUser = auth.currentUser
    if (!currentUser) {
      throw new Error(t('npk.errors.loginRequired'))
    }

    const idToken = await currentUser.getIdToken(true)
    return {
      Authorization: `Bearer ${idToken}`,
    }
  }

  const fetchJson = async (url, options = {}) => {
    const controller = new AbortController()
    const timeoutMs = Number(options.timeoutMs || 10000)
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
      })
    } catch (networkError) {
      if (networkError?.name === 'AbortError') {
        throw new Error(t('npk.errors.timeout'))
      }
      throw new Error(t('npk.errors.backendUnavailable'))
    } finally {
      clearTimeout(timer)
    }

    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }

    if (!response.ok) {
      throw new Error(data?.error || data?.message || t('npk.errors.requestFailed'))
    }

    return data
  }

  const loadData = async () => {
    try {
      setIsLoading(true)
      setError('')

      const authHeaders = await getAuthHeaders()
      const weatherLocation = localStorage.getItem('weatherLocationQuery') || ''
      const weatherCountry = localStorage.getItem('weatherCountryCode') || 'IN'
      const liveLocation = weatherLocation ? `${weatherLocation},${weatherCountry}` : ''

      const liveSensorPromise = fetchJson(
        `${API_BASE_URL}/api/npk/live-sensor${liveLocation ? `?location=${encodeURIComponent(liveLocation)}` : ''}`,
        { headers: authHeaders },
      )

      const [latestPayload, historyPayload] = await Promise.all([
        fetchJson(`${API_BASE_URL}/api/npk/latest`, { headers: authHeaders }),
        fetchJson(`${API_BASE_URL}/api/npk/history?limit=10`, { headers: authHeaders }),
      ])

      const liveData = await liveSensorPromise
      setLiveSensor(liveData)

      let nextLatest = normalizeLatestResponse(latestPayload)
      let nextHistory = normalizeHistoryResponse(historyPayload)

      if (nextHistory.length === 0 && nextLatest) {
        nextHistory = [nextLatest]
      }

      if (!nextLatest && nextHistory.length > 0) {
        nextLatest = nextHistory[0]
      }

      if (nextHistory.length === 0) {
        const cachedHistory = readCachedHistory()
        if (cachedHistory.length > 0) {
          nextHistory = cachedHistory
          if (!nextLatest) {
            nextLatest = cachedHistory[0]
          }
        }
      }

      if (nextHistory.length === 0) {
        const liveSeed = await fetchJson(`${API_BASE_URL}/api/predict-npk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({ mode: 'live' }),
          timeoutMs: 10000,
        })
        nextLatest = liveSeed
        nextHistory = [liveSeed]
      }

      if (nextHistory.length > 0) {
        cacheHistory(nextHistory)
      }

      setLatest(nextLatest)
      setHistory(nextHistory)

      if (nextLatest?.inputs) {
        setForm((prev) => ({
          ...prev,
          soilType: nextLatest.inputs.soilType || prev.soilType,
          cropType: nextLatest.inputs.cropType || prev.cropType,
          fertilizerUsed: Boolean(nextLatest.inputs.fertilizerUsed),
        }))
      }
    } catch (loadError) {
      setError(loadError?.message || t('npk.errors.loadFailed'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setIsLoading(false)
        setError(t('npk.errors.loginRequired'))
        return
      }

      loadData()
    })

    return () => unsubscribe()
  }, [])

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const mapHistoryPoint = (item, index) => {
    const N = Number(item?.N ?? item?.prediction?.values?.N)
    const P = Number(item?.P ?? item?.prediction?.values?.P)
    const K = Number(item?.K ?? item?.prediction?.values?.K)
    const moisture = Number(item?.moisture ?? item?.inputs?.moisture)
    const rawTimestamp = item?.timestamp || item?.generatedAt || item?.createdAt || Date.now()

    return {
      label: new Date(rawTimestamp).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
      n: round(N),
      p: round(P),
      k: round(K),
      moisture: round(moisture),
      soilHealthScore: round(item?.soilHealthScore, 0),
      isNow: index === 0,
      timestamp: rawTimestamp,
    }
  }

  const handlePredict = async () => {
    try {
      setIsPredicting(true)
      setError('')

      const authHeaders = await getAuthHeaders()
      const weatherLocation = localStorage.getItem('weatherLocationQuery') || ''
      const weatherCountry = localStorage.getItem('weatherCountryCode') || 'IN'
      const liveLocation = weatherLocation ? `${weatherLocation},${weatherCountry}` : undefined
      const payload = {
        mode: 'live',
        soilType: form.soilType,
        cropType: form.cropType,
        fertilizerUsed: Boolean(form.fertilizerUsed),
        location: liveLocation,
      }

      const data = await fetchJson(`${API_BASE_URL}/api/predict-npk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(payload),
        timeoutMs: 10000,
      })

      setLatest(data)
      setHistory((prev) => {
        const nextHistory = [data, ...prev].slice(0, 6)
        cacheHistory(nextHistory)
        return nextHistory
      })

      const liveData = await fetchJson(
        `${API_BASE_URL}/api/npk/live-sensor${liveLocation ? `?location=${encodeURIComponent(liveLocation)}` : ''}`,
        { headers: authHeaders },
      )
      setLiveSensor(liveData)
    } catch (predictError) {
      setError(predictError?.message || t('npk.errors.predictFailed'))
    } finally {
      setIsPredicting(false)
    }
  }

  const trendRows = useMemo(
    () => history.map((item, index) => mapHistoryPoint(item, index)),
    [history],
  )

  const trendChartData = useMemo(() => {
    const labels = trendRows.map((row) => (row.isNow ? t('npk.trend.nowLabel') : row.label))
    return {
      labels,
      datasets: [
        { label: 'N', data: trendRows.map((row) => row.n), color: '#059669' },
        { label: 'P', data: trendRows.map((row) => row.p), color: '#65a30d' },
        { label: 'K', data: trendRows.map((row) => row.k), color: '#0d9488' },
      ],
    }
  }, [trendRows, t])

  const buildTrendPath = (values) => {
    const points = values.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    if (points.length === 0) return ''

    const width = 560
    const height = 160
    const min = Math.min(...points)
    const max = Math.max(...points)
    const range = max - min || 1

    return points
      .map((value, index) => {
        const x = (index / Math.max(points.length - 1, 1)) * width
        const y = height - ((value - min) / range) * height
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(' ')
  }

  const prediction = latest?.prediction
  const inputs = latest?.inputs
  const soilProfile = soilTypeProfiles[form.soilType] || soilTypeProfiles.Clay

  const liveMoistureCandidate = Number.isFinite(firebaseSensor?.moisture)
    ? firebaseSensor.moisture
    : pickNumber(liveSensor?.moisture, inputs?.moisture)
  const liveTemperatureCandidate = Number.isFinite(firebaseSensor?.temperature)
    ? firebaseSensor.temperature
    : pickNumber(liveSensor?.temperature, inputs?.temperature)
  const humidityFromWeather = pickNumber(
    latest?.weatherContext?.humidity,
    latest?.weatherContext?.avgHumidityTomorrow,
    liveSensor?.humidity,
    firebaseSensor?.humidity,
    inputs?.humidity,
  )
  const rainfallFromWeather = pickNumber(
    latest?.weatherContext?.rainfallCurrent,
    latest?.weatherContext?.rainfallNext24h,
    liveSensor?.rainfall,
    firebaseSensor?.rainfall,
    inputs?.rainfall,
  )

  const liveMoisture = Number.isFinite(liveMoistureCandidate) ? round(liveMoistureCandidate) : null
  const liveTemperature = Number.isFinite(liveTemperatureCandidate)
    ? Number(Number(liveTemperatureCandidate).toFixed(1))
    : null
  const liveHumidity = Number.isFinite(humidityFromWeather) ? round(humidityFromWeather) : null
  const liveRainfall = Number.isFinite(rainfallFromWeather) ? round(rainfallFromWeather) : null
  const hasLiveCardData = [liveMoisture, liveTemperature, liveHumidity, liveRainfall].some((value) =>
    Number.isFinite(value),
  )
  const sensorTimestampLabel = sensorUpdatedAt
    ? sensorUpdatedAt.toLocaleTimeString()
    : liveSensor?.timestamp
      ? new Date(liveSensor.timestamp).toLocaleTimeString()
      : null
  const forecastRisk = String(latest?.forecastRisk || latest?.forecast?.forecastRisk || 'low').toLowerCase()
  const weatherAlert = latest?.weatherAlert || { type: 'normal', message: t('npk.suggestions.weatherFallback') }
  const rainfallForAlert = Number.isFinite(liveRainfall) ? liveRainfall : Number(latest?.weatherContext?.rainfallNext24h || 0)
  const safeWeatherAlertType =
    weatherAlert.type === 'rain' && Number(rainfallForAlert || 0) <= 1
      ? 'normal'
      : weatherAlert.type || 'normal'

  const displayNpk = prediction
    ? {
        N: Number(prediction.values.N),
        P: Number(prediction.values.P),
        K: Number(prediction.values.K),
        status: {
          N: prediction.status.N,
          P: prediction.status.P,
          K: prediction.status.K,
        },
      }
    : {
        N: soilProfile.N,
        P: soilProfile.P,
        K: soilProfile.K,
        status: {
          N: 'Baseline',
          P: 'Baseline',
          K: 'Baseline',
        },
      }

  useEffect(() => {
    if (typeof window === 'undefined') return

    const cropText = Array.isArray(latest?.cropRecommendation)
      ? latest.cropRecommendation
          .slice(0, 3)
          .map((item) => `${localizeCropName(item.crop, i18n.language)} (${Math.round(Number(item.confidence || 0))}%)`)
          .join(', ')
      : ''

    const irrigationText = localizeFarmText(latest?.irrigationAdvice || t('npk.suggestions.irrigationFallback'), i18n.language)
    const fertilizerText = localizeFarmText(latest?.fertilizerAdvice || t('npk.suggestions.fertilizerFallback'), i18n.language)
    const weatherText = localizeFarmText(weatherAlert?.message || t('npk.suggestions.weatherFallback'), i18n.language)

    const summary =
      i18n.language === 'ta'
        ? `N:${round(displayNpk.N)} P:${round(displayNpk.P)} K:${round(displayNpk.K)}. நீர்ப்பாசனம்: ${irrigationText}. உரம்: ${fertilizerText}. வானிலை: ${weatherText}. பரிந்துரைக்கப்பட்ட பயிர்கள்: ${cropText || 'இல்லை'}`
        : `N:${round(displayNpk.N)} P:${round(displayNpk.P)} K:${round(displayNpk.K)}. Irrigation: ${irrigationText}. Fertilizer: ${fertilizerText}. Weather: ${weatherText}. Top crops: ${cropText || 'none'}`

    window.__uzhavarPageSummary = {
      page: 'npk',
      summary,
      timestamp: Date.now(),
    }
  }, [
    displayNpk.K,
    displayNpk.N,
    displayNpk.P,
    i18n.language,
    latest?.cropRecommendation,
    latest?.fertilizerAdvice,
    latest?.irrigationAdvice,
    t,
    weatherAlert?.message,
  ])

  return (
    <section>
      <h1 className="text-3xl font-bold text-emerald-700">{t('npk.title')}</h1>
      <p className="mt-2 text-sm text-slate-600">{t('npk.subtitle')}</p>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
          <h2 className="text-xl font-semibold text-slate-800">{t('npk.liveCard.title')}</h2>
          {!hasLiveCardData && isLoading ? (
            <p className="mt-3 text-sm text-slate-500">{t('npk.liveCard.loading')}</p>
          ) : (
            <div className="mt-4 space-y-3 text-sm text-slate-700">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('npk.liveCard.metrics.moisture')}</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">{Number.isFinite(liveMoisture) ? `${liveMoisture}%` : '—'}</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('npk.liveCard.metrics.temperature')}</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">{Number.isFinite(liveTemperature) ? `${liveTemperature}°C` : '—'}</p>
                </div>
                <div className="rounded-xl bg-emerald-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">{t('npk.liveCard.metrics.humidity')}</p>
                  <p className="mt-1 text-2xl font-bold text-emerald-900">{Number.isFinite(liveHumidity) ? `${liveHumidity}%` : '—'}</p>
                </div>
                <div className="rounded-xl bg-sky-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-sky-600">{t('npk.liveCard.metrics.rainfall')}</p>
                  <p className="mt-1 text-2xl font-bold text-sky-900">{Number.isFinite(liveRainfall) ? `${liveRainfall} mm` : '—'}</p>
                </div>
              </div>

              <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                <p>
                  {t('npk.liveCard.cropFocus', { crop: inputs?.cropType || form.cropType })}
                </p>
                <p className="mt-1">
                  {t('npk.liveCard.firebasePing', {
                    time: sensorTimestampLabel || t('npk.syncing'),
                  })}
                </p>
              </div>
            </div>
          )}
        </article>

        <article className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
          <h2 className="text-xl font-semibold text-slate-800">{t('npk.controls.title')}</h2>
          <p className="mt-1 text-xs text-slate-500">{t('npk.controls.description')}</p>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <select
              value={form.soilType}
              onChange={(event) => handleChange('soilType', event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2"
            >
              {soilTypeOptions.map((soilType) => (
                <option key={soilType} value={soilType}>{t(`npk.options.soilTypes.${soilType}`, `${soilType} Soil`)}</option>
              ))}
            </select>
            <select
              value={form.cropType}
              onChange={(event) => handleChange('cropType', event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2"
            >
              {cropOptions.map((crop) => (
                <option key={crop} value={crop}>{t(`npk.options.crops.${crop}`, crop)}</option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={handlePredict}
            disabled={isPredicting}
            className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700 disabled:opacity-70"
          >
            {isPredicting ? t('npk.controls.buttonRunning') : t('npk.controls.buttonRun')}
          </button>

          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
            <p className="font-semibold text-slate-800">{t('npk.controls.baselineTitle', { soil: t(`npk.options.soilTypes.${form.soilType}`, `${form.soilType} Soil`) })}</p>
            <p className="mt-1">{t('npk.controls.baselineStats', { n: soilProfile.N, p: soilProfile.P, k: soilProfile.K })}</p>
            <p className="mt-1">{t('npk.controls.baselinePh', { value: soilProfile.ph })}</p>
          </div>
        </article>
      </div>

      {error ? <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p> : null}

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {['N', 'P', 'K'].map((keyName) => (
          <article key={keyName} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
            <h3 className="text-lg font-semibold text-slate-800">{keyName}</h3>
            <p className="mt-2 text-3xl font-bold text-slate-900">{displayNpk[keyName]} mg/kg</p>
            <span className={`mt-3 inline-block rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[displayNpk.status[keyName]] || 'bg-slate-100 text-slate-700'}`}>
              {getStatusLabel(displayNpk.status[keyName])}
            </span>
          </article>
        ))}
      </div>

      <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-emerald-100">
        <h2 className="text-xl font-semibold text-slate-800">{t('npk.trend.title')}</h2>
        <div className="mt-4 space-y-4">
          {trendRows.length === 0 ? (
            <p className="text-sm text-slate-500">{t('npk.trend.empty')}</p>
          ) : (
            <div className="space-y-3">
              <svg viewBox="0 0 560 170" className="h-44 w-full rounded-lg bg-slate-50 p-2">
                <path d={buildTrendPath(trendChartData.datasets[0].data)} fill="none" stroke={trendChartData.datasets[0].color} strokeWidth="3" />
                <path d={buildTrendPath(trendChartData.datasets[1].data)} fill="none" stroke={trendChartData.datasets[1].color} strokeWidth="3" />
                <path d={buildTrendPath(trendChartData.datasets[2].data)} fill="none" stroke={trendChartData.datasets[2].color} strokeWidth="3" />
              </svg>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-600" /> N</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-lime-600" /> P</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-teal-600" /> K</span>
                <span className="ml-2">{t('npk.trend.timestamps', { labels: trendChartData.labels.join(' · ') })}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-emerald-100">
        <h2 className="text-xl font-semibold text-slate-800">{t('npk.suggestions.title')}</h2>
        {latest ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-800">{t('npk.suggestions.irrigation')}</p>
              <p className="mt-2 text-sm text-slate-700">{localizeFarmText(latest.irrigationAdvice || t('npk.suggestions.irrigationFallback'), i18n.language)}</p>
            </div>
            <div className="rounded-xl bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-800">{t('npk.suggestions.fertilizer')}</p>
              <p className="mt-2 text-sm text-slate-700">{localizeFarmText(latest.fertilizerAdvice || t('npk.suggestions.fertilizerFallback'), i18n.language)}</p>
            </div>

            <div className="rounded-xl bg-slate-50 p-4 lg:col-span-2">
              <p className="text-sm font-semibold text-slate-800">{t('npk.suggestions.insight')}</p>
              <p className="mt-2 text-sm text-slate-700">{localizeFarmText(latest.insightMessage || t('npk.suggestions.insightFallback'), i18n.language)}</p>
            </div>

            <div className="rounded-xl bg-cyan-50 p-4 lg:col-span-2">
              <p className="text-sm font-semibold text-cyan-800">{t('npk.suggestions.weatherAlert')}</p>
              <p className="mt-2">
                <span className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${weatherAlertStyles[safeWeatherAlertType] || 'bg-slate-100 text-slate-700'}`}>
                  {t(`npk.weatherAlertTags.${safeWeatherAlertType}`, String(safeWeatherAlertType).toUpperCase())}
                </span>
              </p>
              <p className="mt-2 text-sm text-slate-700">{localizeFarmText(weatherAlert.message || t('npk.suggestions.weatherFallback'), i18n.language)}</p>
              <p className="mt-1 text-xs text-slate-500">
                {t('npk.suggestions.rainHumidity', {
                  rainfall: Number.isFinite(liveRainfall) ? `${liveRainfall} mm` : '—',
                  humidity: Number.isFinite(liveHumidity) ? `${liveHumidity}%` : '—',
                })}
              </p>
            </div>

            <div className="rounded-xl bg-indigo-50 p-4">
              <p className="text-sm font-semibold text-indigo-800">{t('npk.suggestions.topCrops')}</p>
              {Array.isArray(latest.cropRecommendation) && latest.cropRecommendation.length > 0 ? (
                <ul className="mt-2 space-y-1 text-sm text-slate-700">
                  {latest.cropRecommendation.slice(0, 3).map((item) => (
                    <li key={item.crop}>{localizeCropName(item.crop, i18n.language)} ({Math.round(Number(item.confidence || 0))}%)</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-slate-600">{t('npk.suggestions.noCrops')}</p>
              )}
            </div>

            <div className="rounded-xl bg-teal-50 p-4">
              <p className="text-sm font-semibold text-teal-800">{t('npk.suggestions.forecast')}</p>
              {latest.forecast?.next3Cycles ? (
                <div className="mt-2 space-y-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <ForecastSparkline label="N" values={latest.forecast.next3Cycles.N} colorClass="stroke-emerald-600" emptyLabel={t('npk.forecast.noData')} />
                    <ForecastSparkline label="P" values={latest.forecast.next3Cycles.P} colorClass="stroke-lime-600" emptyLabel={t('npk.forecast.noData')} />
                    <ForecastSparkline label="K" values={latest.forecast.next3Cycles.K} colorClass="stroke-teal-600" emptyLabel={t('npk.forecast.noData')} />
                    <ForecastSparkline label={t('npk.forecast.sparklineLabels.moisture')} values={latest.forecast.next3Cycles.moisture} colorClass="stroke-sky-600" emptyLabel={t('npk.forecast.noData')} />
                  </div>
                  <p>
                    <span className="mr-2 text-sm font-semibold text-slate-700">{t('npk.suggestions.forecastRiskLabel')}</span>
                    <span className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${riskStyles[forecastRisk] || 'bg-slate-100 text-slate-700'}`}>
                      {t(`npk.forecast.risk.${forecastRisk}`, forecastRisk.toUpperCase())}
                    </span>
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-600">{t('npk.suggestions.forecastPrompt')}</p>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">{t('npk.suggestions.predictionPrompt')}</p>
        )}
      </div>
    </section>
  )
}

export default NpkTrend
