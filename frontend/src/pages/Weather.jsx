import { useEffect, useState } from 'react'
import { CloudRain, Droplets, MapPin, Wind, Clock3, Navigation, Bell } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { localizeWeatherDescription } from '../utils/localizeFarmText'

const cityOptions = [
  'Selaiyur',
  'Chennai',
  'Coimbatore',
  'Madurai',
  'Tiruchirappalli',
  'Trichy',
  'Salem',
  'Erode',
  'Vellore',
  'Tirunelveli',
  'Thoothukudi',
  'Nagercoil',
  'Thanjavur',
  'Dindigul',
  'Kanchipuram',
  'Kancheepuram',
  'Tiruppur',
  'Karur',
  'Namakkal',
  'Sivakasi',
  'Cuddalore',
  'Kumbakonam',
  'Mayiladuthurai',
  'Nagapattinam',
  'Hosur',
  'Pollachi',
  'Udhagamandalam',
  'Ooty',
  'Villupuram',
  'Virudhunagar',
]

const stateOptions = [
  'Tamil Nadu',
  'Puducherry',
  'Karnataka',
  'Kerala',
  'Andhra Pradesh',
  'Telangana',
  'Maharashtra',
  'Gujarat',
  'Rajasthan',
  'Uttar Pradesh',
  'West Bengal',
  'Odisha',
  'Punjab',
]

const districtOptions = [
  'Ariyalur',
  'Chengalpattu',
  'Chennai',
  'Coimbatore',
  'Cuddalore',
  'Dharmapuri',
  'Dindigul',
  'Erode',
  'Kallakurichi',
  'Kancheepuram',
  'Kanyakumari',
  'Karur',
  'Krishnagiri',
  'Madurai',
  'Mayiladuthurai',
  'Nagapattinam',
  'Namakkal',
  'The Nilgiris',
  'Nilgiris',
  'Perambalur',
  'Pudukkottai',
  'Ramanathapuram',
  'Ranipet',
  'Salem',
  'Sivaganga',
  'Tenkasi',
  'Thanjavur',
  'Theni',
  'Thoothukudi',
  'Tiruchirappalli',
  'Trichy',
  'Tirunelveli',
  'Tirupathur',
  'Tiruppur',
  'Tiruvallur',
  'Tiruvannamalai',
  'Tiruvarur',
  'Vellore',
  'Viluppuram',
  'Virudhunagar',
]

const toDayLabelFromDateKey = (dateKey, locale = undefined) => {
  if (!dateKey) {
    return ''
  }

  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString(locale, {
    weekday: 'short',
    timeZone: 'UTC',
  })
}

const toTimeLabel = (unixSeconds) =>
  new Date(unixSeconds * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const getDateKey = (item) => item.dt_txt?.split(' ')[0] || ''

const toDateKeyFromUnix = (unixSeconds, offsetSeconds = 0) => {
  const date = new Date((unixSeconds + offsetSeconds) * 1000)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const toLocalDateKey = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const addDaysToDateKey = (dateKey, days) => {
  if (!dateKey) {
    return ''
  }

  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 12))
  date.setUTCDate(date.getUTCDate() + days)

  const nextYear = date.getUTCFullYear()
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, '0')
  const nextDay = String(date.getUTCDate()).padStart(2, '0')
  return `${nextYear}-${nextMonth}-${nextDay}`
}

const getCardDayLabel = (dateKey, index, t, locale) => {
  if (index === 0) {
    return t('weather.days.today')
  }

  if (index === 1) {
    return t('weather.days.tomorrow')
  }

  return toDayLabelFromDateKey(dateKey, locale)
}

function Weather() {
  const [weather, setWeather] = useState(null)
  const [sevenDayDaily, setSevenDayDaily] = useState([])
  const [mode, setMode] = useState('auto')
  const [locationType, setLocationType] = useState('city')
  const [locationInput, setLocationInput] = useState(localStorage.getItem('weatherLocationQuery') || 'Selaiyur')
  const [countryInput, setCountryInput] = useState(localStorage.getItem('weatherCountryCode') || 'IN')
  const [appliedLocation, setAppliedLocation] = useState(localStorage.getItem('weatherLocationQuery') || 'Selaiyur')
  const [appliedCountry, setAppliedCountry] = useState(localStorage.getItem('weatherCountryCode') || 'IN')
  const [locationName, setLocationName] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')
  const [clock, setClock] = useState(new Date().toLocaleTimeString())
  const [selectedDayKey, setSelectedDayKey] = useState('')
  const [advisory, setAdvisory] = useState('')
  const [advisoryFacts, setAdvisoryFacts] = useState(null)
  const [notificationEnabled, setNotificationEnabled] = useState(
    typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted',
  )
  const [refreshToken, setRefreshToken] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { t, i18n } = useTranslation()

  const apiKey = import.meta.env.VITE_OPENWEATHER_API_KEY

  const activeOptions =
    locationType === 'state'
      ? stateOptions
      : locationType === 'district'
        ? districtOptions
        : cityOptions

  useEffect(() => {
    if (mode !== 'manual') {
      return
    }

    if (!activeOptions.includes(locationInput)) {
      setLocationInput(activeOptions[0] || '')
    }
  }, [locationType, mode])

  const createDailyCards = (list) => {
    const byDate = new Map()
    const todayKey = toLocalDateKey()

    ;(list || []).forEach((item) => {
      const dateKey = getDateKey(item)
      if (!dateKey) {
        return
      }

      const existing = byDate.get(dateKey)
      const isNoon = item.dt_txt?.includes('12:00:00')
      if (!existing || isNoon) {
        byDate.set(dateKey, item)
      }
    })

    const ordered = Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, item]) => item)

    const upcoming = ordered.filter((item) => getDateKey(item) >= todayKey)
    const baseCards = (upcoming.length > 0 ? upcoming : ordered).slice(0, 7)

    if (baseCards.length === 0) {
      return []
    }

    if (baseCards.length >= 7) {
      return baseCards
    }

    const paddedCards = [...baseCards]
    while (paddedCards.length < 7) {
      const lastCard = paddedCards[paddedCards.length - 1]
      const nextDateKey = addDaysToDateKey(getDateKey(lastCard), 1)
      const nextNoonTime = Math.floor(new Date(`${nextDateKey}T12:00:00Z`).getTime() / 1000)

      paddedCards.push({
        ...lastCard,
        dt: nextNoonTime,
        dt_txt: `${nextDateKey} 12:00:00`,
      })
    }

    return paddedCards
  }

  const fetchSevenDayDaily = async (lat, lon) => {
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return []
    }

    try {
      const response = await fetch(
        `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,alerts,current&appid=${apiKey}&units=metric`,
      )

      if (!response.ok) {
        return []
      }

      const data = await response.json()
      const offsetSeconds = typeof data?.timezone_offset === 'number' ? data.timezone_offset : 0
      const days = Array.isArray(data?.daily) ? data.daily : []

      return days.slice(0, 7).map((item) => {
        const dateKey = toDateKeyFromUnix(item?.dt, offsetSeconds)
        return {
          dt: item?.dt,
          dt_txt: `${dateKey} 12:00:00`,
          pop: item?.pop ?? 0,
          weather: item?.weather || [],
          main: {
            temp: item?.temp?.day,
            temp_min: item?.temp?.min,
            temp_max: item?.temp?.max,
            humidity: item?.humidity,
          },
          wind: {
            speed: item?.wind_speed,
          },
        }
      })
    } catch {
      return []
    }
  }

  const storeLocationForAlerts = (query, country) => {
    localStorage.setItem('weatherLocationQuery', query)
    localStorage.setItem('weatherCountryCode', country)
  }

  const maybeNotify = (message, keySeed, title = 'AgroSense Farmer Alert') => {
    if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') {
      return
    }

    const notifyKey = `agrosense-weather-${keySeed}-${message}`
    if (localStorage.getItem(notifyKey)) {
      return
    }

    new Notification(title, { body: message })
    localStorage.setItem(notifyKey, '1')
  }

  const evaluateAdvisory = (forecastList, cityLabel, dailyList = []) => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowKey = toLocalDateKey(tomorrow)
    const tomorrowDaily = (dailyList || []).find((item) => getDateKey(item) === tomorrowKey)
    const tomorrowSlots = (forecastList || []).filter((item) => getDateKey(item) === tomorrowKey)

    if (!tomorrowDaily && tomorrowSlots.length === 0) {
      setAdvisory('')
      setAdvisoryFacts(null)
      return
    }

    const conditionCounts = new Map()
    tomorrowSlots.forEach((item) => {
      const code = Number(item?.weather?.[0]?.id)
      if (Number.isFinite(code)) {
        conditionCounts.set(code, (conditionCounts.get(code) || 0) + 1)
      }
    })

    const slotDominantCode = Array.from(conditionCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 800
    const conditionCode = Number(tomorrowDaily?.weather?.[0]?.id) || slotDominantCode
    const rainfallTomorrowMm = Number(
      tomorrowSlots.reduce((sum, item) => sum + Number(item?.rain?.['3h'] || 0), 0).toFixed(1),
    )

    const avgHumidityTomorrow = Number(
      (
        Number(tomorrowDaily?.main?.humidity) ||
        (tomorrowSlots.length > 0
          ? tomorrowSlots.reduce((sum, item) => sum + Number(item?.main?.humidity || 0), 0) / tomorrowSlots.length
          : 0)
      ).toFixed(1),
    )

    const precipitationProbabilityAvg = Number(
      (
        (Number(tomorrowDaily?.pop) ||
          (tomorrowSlots.length > 0
            ? tomorrowSlots.reduce((sum, item) => sum + Number(item?.pop || 0), 0) / tomorrowSlots.length
            : 0)) * 100
      ).toFixed(0),
    )

    const rainRiskLevel = rainfallTomorrowMm >= 15 ? 'HIGH' : rainfallTomorrowMm >= 5 ? 'MODERATE' : 'LOW'
    const humidityRiskLevel = avgHumidityTomorrow > 85 ? 'HIGH' : avgHumidityTomorrow >= 70 ? 'MODERATE' : 'NORMAL'

    const skyCondition =
      conditionCode === 800
        ? 'CLEAR'
        : conditionCode >= 801 && conditionCode <= 804
          ? 'CLOUDY'
          : conditionCode >= 500 && conditionCode <= 531
            ? 'RAINY'
            : 'MIXED'

    let message = t('weather.advisory.messages.lowRain', { city: cityLabel })

    if (rainRiskLevel === 'HIGH') {
      message = t('weather.advisory.messages.heavyRain', { city: cityLabel, amount: rainfallTomorrowMm })
    } else if (rainRiskLevel === 'MODERATE') {
      message = t('weather.advisory.messages.moderateRain', { city: cityLabel, amount: rainfallTomorrowMm })
    } else if (skyCondition === 'CLEAR') {
      message = t('weather.advisory.messages.clearSky', { city: cityLabel })
    } else if (skyCondition === 'CLOUDY') {
      message = t('weather.advisory.messages.cloudySky', { city: cityLabel })
    }

    if (humidityRiskLevel === 'HIGH') {
      message = `${message} ${t('weather.advisory.messages.humidityRisk')}`
    }

    setAdvisory(message)
    setAdvisoryFacts({
      rainfallTomorrowMm,
      avgHumidityTomorrow,
      skyCondition,
      precipitationProbabilityAvg,
    })
    maybeNotify(message, `${cityLabel}-${tomorrowKey}`, t('weather.notifications.title'))
  }

  const applyForecast = (data, preferredLabel, dailyOverride = []) => {
    const cityLabel = preferredLabel || [data.city?.name, data.city?.country].filter(Boolean).join(', ')
    setWeather(data)
    setLocationName(cityLabel)
    setLastUpdated(new Date().toLocaleTimeString())
    setError('')
    setLoading(false)
    setSevenDayDaily(dailyOverride)

    const daily = createDailyCards(dailyOverride.length > 0 ? dailyOverride : (data.list || []))
    setSelectedDayKey(getDateKey(daily[0]))

    if (data.city?.name) {
      storeLocationForAlerts(data.city.name, data.city?.country || 'IN')
    }

    evaluateAdvisory(data.list || [], data.city?.name || cityLabel, dailyOverride)
  }

  const fetchByCoords = async (lat, lon) => {
    try {
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`,
      )

      const data = await response.json()

      if (data.cod !== '200') {
        throw new Error(data?.message || t('weather.errors.fetchFailed'))
      }

      const dailyOverride = await fetchSevenDayDaily(lat, lon)
      applyForecast(data, undefined, dailyOverride)
    } catch (fetchError) {
      setError(fetchError?.message || t('weather.errors.fetchFailed'))
      setLoading(false)
    }
  }

  const fetchByQuery = async (query, country) => {
    try {
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(
          `${query.trim()},${country.trim() || 'IN'}`,
        )}&appid=${apiKey}&units=metric`,
      )

      const data = await response.json()
      if (data.cod !== '200') {
        throw new Error(data?.message || t('weather.errors.locationNotFound'))
      }

      const lat = Number(data?.city?.coord?.lat)
      const lon = Number(data?.city?.coord?.lon)
      const dailyOverride = await fetchSevenDayDaily(lat, lon)
      applyForecast(data, undefined, dailyOverride)
      storeLocationForAlerts(query.trim(), country.trim() || 'IN')
    } catch (fetchError) {
      setError(fetchError?.message || t('weather.errors.fetchFailed'))
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!apiKey) {
      setError(t('weather.errors.apiKeyMissing'))
      setLoading(false)
      return
    }

    const runFetch = () => {
      setLoading(true)

      if (mode === 'auto') {
        if (!navigator.geolocation) {
          setError(t('weather.errors.geolocationUnsupported'))
          setLoading(false)
          return
        }

        navigator.geolocation.getCurrentPosition(
          (position) => {
            fetchByCoords(position.coords.latitude, position.coords.longitude)
          },
          () => {
            setError(t('weather.errors.permissionDenied'))
            setLoading(false)
          },
        )
        return
      }

      fetchByQuery(appliedLocation, appliedCountry)
    }

    runFetch()

    const interval = setInterval(() => {
      runFetch()
    }, 600000)

    return () => clearInterval(interval)
  }, [mode, appliedLocation, appliedCountry, apiKey, refreshToken])

  useEffect(() => {
    const timer = setInterval(() => {
      setClock(new Date().toLocaleTimeString())
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  const requestNotificationPermission = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setError(t('weather.notifications.unsupported'))
      return
    }

    const permission = await Notification.requestPermission()
    setNotificationEnabled(permission === 'granted')
  }

  const applyManualLocation = () => {
    if (!locationInput.trim()) {
      setError(t('weather.errors.locationRequired'))
      return
    }

    setAppliedLocation(locationInput.trim())
    setAppliedCountry(countryInput.trim() || 'IN')
    setRefreshToken((prev) => prev + 1)
  }

  const handleManualLocationPick = (value) => {
    setLocationInput(value)

    if (mode === 'manual') {
      setAppliedLocation(value)
      setAppliedCountry(countryInput.trim() || 'IN')
      setRefreshToken((prev) => prev + 1)
    }
  }

  if (loading) {
    return <p className="mt-10 text-center">{t('weather.loading')}</p>
  }

  if (error) {
    return (
      <section>
        <h1 className="mb-6 text-2xl font-bold text-green-700">{t('weather.errorTitle')}</h1>
        <p className="rounded-xl bg-red-50 px-4 py-3 text-red-600">{error}</p>
      </section>
    )
  }

  const current = weather?.list?.[0]
  const dailyCards = createDailyCards(sevenDayDaily.length > 0 ? sevenDayDaily : (weather?.list || []))
  const selectedCard = dailyCards.find((item) => getDateKey(item) === selectedDayKey) || dailyCards[0] || current
  const selectedTimeline = (() => {
    const timeline = (weather?.list || [])
      .filter((item) => getDateKey(item) === getDateKey(selectedCard))
      .slice(0, 8)

    if (timeline.length > 0) {
      return timeline
    }

    return selectedCard ? [selectedCard] : []
  })()

  const selectedCondition = selectedCard?.weather?.[0]?.description
  const localeForDates = i18n.language === 'ta' ? 'ta-IN' : undefined
  const localizedCondition = localizeWeatherDescription(selectedCondition, i18n.language)
  const selectedTemp = selectedCard?.main?.temp
  const rainProbability = typeof current?.pop === 'number' ? current.pop * 100 : 0

  const bgGradient =
    rainProbability > 50
      ? 'from-blue-700 to-gray-900'
      : 'from-emerald-600 to-green-900'

  useEffect(() => {
    if (typeof window === 'undefined') return

    const summary =
      i18n.language === 'ta'
        ? `இடம்: ${locationName || '-'}, வெப்பநிலை: ${Math.round(Number(selectedTemp || 0))}°C, நிலை: ${localizedCondition || '-'}, மழை வாய்ப்பு: ${Math.round(Number(rainProbability || 0))}%, ஆலோசனை: ${advisory || '-'}`
        : `Location: ${locationName || '-'}, temperature: ${Math.round(Number(selectedTemp || 0))}°C, condition: ${localizedCondition || '-'}, rain chance: ${Math.round(Number(rainProbability || 0))}%, advisory: ${advisory || '-'}`

    window.__uzhavarPageSummary = {
      page: 'weather',
      summary,
      timestamp: Date.now(),
    }
  }, [advisory, i18n.language, localizedCondition, locationName, rainProbability, selectedTemp])

  return (
    <section>
      <h1 className="mb-6 text-3xl font-bold text-emerald-700">{t('weather.title')}</h1>

      <div className="mb-6 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-emerald-100">
        <div className="grid gap-3 md:grid-cols-5">
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="auto">{t('weather.controls.mode.auto')}</option>
            <option value="manual">{t('weather.controls.mode.manual')}</option>
          </select>

          <select
            value={locationType}
            onChange={(event) => setLocationType(event.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            disabled={mode !== 'manual'}
          >
            <option value="city">{t('weather.controls.locationTypes.city')}</option>
            <option value="state">{t('weather.controls.locationTypes.state')}</option>
            <option value="district">{t('weather.controls.locationTypes.district')}</option>
          </select>

          <select
            value={locationInput}
            onChange={(event) => handleManualLocationPick(event.target.value)}
            disabled={mode !== 'manual'}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            {activeOptions.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>

          <input
            value={countryInput}
            onChange={(event) => setCountryInput(event.target.value.toUpperCase())}
            disabled={mode !== 'manual'}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
            placeholder={t('weather.controls.countryPlaceholder')}
          />

          <button
            type="button"
            onClick={mode === 'manual' ? applyManualLocation : () => setRefreshToken((prev) => prev + 1)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            {mode === 'manual' ? t('weather.controls.updateLocation') : t('weather.controls.refreshGps')}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
          <p>{t('weather.controls.info')}</p>
          <button
            type="button"
            onClick={requestNotificationPermission}
            className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-3 py-1 font-semibold text-emerald-700 hover:bg-emerald-50"
          >
            <Bell size={14} />
            {notificationEnabled ? t('weather.controls.alertsEnabled') : t('weather.controls.enableAlerts')}
          </button>
        </div>
      </div>

      <div className="flex min-h-[620px] items-center justify-center bg-green-50">
        <div className={`w-full rounded-3xl bg-gradient-to-br p-8 text-white shadow-2xl ${bgGradient}`}>
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-3xl font-bold">
              <MapPin size={20} /> {locationName}
            </h2>
            <p className="mt-1 flex items-center gap-2 text-sm opacity-80">
              <Clock3 size={14} /> {t('weather.stats.lastUpdated', { time: lastUpdated || t('weather.stats.syncing') })}
            </p>
            <p className="mt-1 flex items-center gap-2 text-sm opacity-80">
              <Navigation size={14} /> {t('weather.stats.liveClock', { time: clock })}
            </p>
          </div>

          {rainProbability > 50 && (
            <div className="flex items-center gap-2 rounded-full bg-red-500 px-4 py-2 text-sm font-semibold">
              <CloudRain size={16} />
              {t('weather.stats.rainAlert')}
            </div>
          )}
        </div>

        {advisory ? (
          <div className="mb-4 rounded-xl bg-white/15 px-4 py-3">
            <p className="text-sm">{advisory}</p>
            {advisoryFacts ? (
              <p className="mt-2 text-xs opacity-90">
                {t('weather.advisory.facts', {
                  rain: advisoryFacts.rainfallTomorrowMm,
                  humidity: advisoryFacts.avgHumidityTomorrow,
                  sky: advisoryFacts.skyCondition,
                  probability: advisoryFacts.precipitationProbabilityAvg,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mb-2 text-6xl font-bold">{Math.round(selectedTemp)}°C</div>

        <p className="mb-6 text-xl capitalize">{localizedCondition}</p>

        <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-7">
          {dailyCards.map((item, index) => (
            <button
              type="button"
              key={item.dt}
              onClick={() => setSelectedDayKey(getDateKey(item))}
              className={`rounded-2xl p-3 text-center transition ${
                selectedDayKey === getDateKey(item) ? 'bg-white/25 ring-1 ring-white/40' : 'bg-white/10'
              }`}
            >
              <p className="text-lg font-semibold">{getCardDayLabel(getDateKey(item), index, t, localeForDates)}</p>
              <img
                src={`https://openweathermap.org/img/wn/${item.weather?.[0]?.icon}@2x.png`}
                alt={item.weather?.[0]?.description || 'icon'}
                className="mx-auto h-12 w-12"
              />
              <p className="text-base font-semibold">{Math.round(item.main?.temp_max)}°</p>
              <p className="text-sm opacity-80">{Math.round(item.main?.temp_min)}°</p>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 text-center md:grid-cols-3">
          <div className="rounded-xl bg-white/20 p-4">
            <Droplets className="mx-auto mb-2" />
            <p className="text-lg font-semibold">{selectedCard?.main?.humidity}%</p>
            <p className="text-sm opacity-80">{t('weather.stats.humidity')}</p>
          </div>

          <div className="rounded-xl bg-white/20 p-4">
            <Wind className="mx-auto mb-2" />
            <p className="text-lg font-semibold">{selectedCard?.wind?.speed} m/s</p>
            <p className="text-sm opacity-80">{t('weather.stats.wind')}</p>
          </div>

          <div className="rounded-xl bg-white/20 p-4">
            <CloudRain className="mx-auto mb-2" />
            <p className="text-lg font-semibold">{rainProbability.toFixed(0)}%</p>
            <p className="text-sm opacity-80">{t('weather.stats.rainProbability')}</p>
          </div>
        </div>

        <div className="mt-8">
          <p className="mb-3 text-2xl font-semibold">{t('weather.stats.precipTimeline')}</p>
          <div className="grid grid-cols-4 gap-3 md:grid-cols-8">
            {selectedTimeline.map((item) => (
              <div key={item.dt} className="rounded-lg bg-white/10 p-2 text-center">
                <p className="text-xl font-semibold">{Math.round((item.pop || 0) * 100)}%</p>
                <p className="text-xs opacity-80">{toTimeLabel(item.dt)}</p>
              </div>
            ))}
          </div>
        </div>
        </div>
      </div>
    </section>
  )
}

export default Weather
