import { useEffect, useMemo, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { useTranslation } from 'react-i18next'
import { database } from '../firebase'

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const cropProfiles = {
  Paddy: { moistureMin: 70, moistureMax: 90, tempMin: 20, tempMax: 35 },
  Wheat: { moistureMin: 45, moistureMax: 65, tempMin: 15, tempMax: 25 },
  Maize: { moistureMin: 50, moistureMax: 70, tempMin: 18, tempMax: 32 },
  Sugarcane: { moistureMin: 55, moistureMax: 75, tempMin: 20, tempMax: 35 },
  Cotton: { moistureMin: 40, moistureMax: 60, tempMin: 21, tempMax: 34 },
  Groundnut: { moistureMin: 35, moistureMax: 55, tempMin: 22, tempMax: 32 },
  Banana: { moistureMin: 65, moistureMax: 85, tempMin: 20, tempMax: 35 },
  Tomato: { moistureMin: 60, moistureMax: 80, tempMin: 18, tempMax: 30 },
  Onion: { moistureMin: 55, moistureMax: 75, tempMin: 13, tempMax: 30 },
  Potato: { moistureMin: 60, moistureMax: 80, tempMin: 15, tempMax: 25 },
  Millets: { moistureMin: 30, moistureMax: 50, tempMin: 20, tempMax: 35 },
  Pulses: { moistureMin: 35, moistureMax: 55, tempMin: 18, tempMax: 32 },
  Soybean: { moistureMin: 45, moistureMax: 65, tempMin: 20, tempMax: 32 },
  Chili: { moistureMin: 50, moistureMax: 70, tempMin: 20, tempMax: 32 },
  Brinjal: { moistureMin: 55, moistureMax: 75, tempMin: 20, tempMax: 32 },
  Vegetables: { moistureMin: 55, moistureMax: 75, tempMin: 18, tempMax: 32 },
}

const cropOptions = Object.keys(cropProfiles)

const districtZoneProfiles = {
  Chennai: { moistureDelta: -4, tempDelta: 1.5 },
  Kanchipuram: { moistureDelta: -2, tempDelta: 1.0 },
  Cuddalore: { moistureDelta: 0, tempDelta: 0.6 },
  Thanjavur: { moistureDelta: 2, tempDelta: 0.2 },
  Tiruchirappalli: { moistureDelta: -1, tempDelta: 0.8 },
  Erode: { moistureDelta: -3, tempDelta: 1.0 },
  Coimbatore: { moistureDelta: -2, tempDelta: 0.5 },
  Madurai: { moistureDelta: -3, tempDelta: 1.2 },
  Tirunelveli: { moistureDelta: -2, tempDelta: 1.0 },
  Kanyakumari: { moistureDelta: 3, tempDelta: -0.8 },
  Nilgiris: { moistureDelta: 2, tempDelta: -6.0 },
}

const districtOptions = Object.keys(districtZoneProfiles)

const seasonProfiles = {
  Kuruvai: { moistureDelta: 3, tempDelta: -0.2 },
  Samba: { moistureDelta: 5, tempDelta: -0.8 },
  Navarai: { moistureDelta: 1, tempDelta: 0.0 },
  Summer: { moistureDelta: -5, tempDelta: 1.8 },
  Monsoon: { moistureDelta: 4, tempDelta: -0.6 },
}

const seasonOptions = Object.keys(seasonProfiles)

const growthStageProfiles = {
  Establishment: { moistureDelta: 4, tempDelta: -0.4 },
  Vegetative: { moistureDelta: 2, tempDelta: 0.0 },
  Flowering: { moistureDelta: 1, tempDelta: -0.2 },
  Fruiting: { moistureDelta: 0, tempDelta: 0.0 },
  Maturity: { moistureDelta: -4, tempDelta: 0.4 },
}

const growthStageOptions = Object.keys(growthStageProfiles)

const toMoisturePercent = (rawValue) => {
  const raw = Number(rawValue)
  if (!Number.isFinite(raw)) {
    return null
  }

  const percent = (1 - raw / 4095) * 100
  return Math.round(clamp(percent, 0, 100))
}

const moistureMeta = (value, t) => {
  if (!Number.isFinite(value)) {
    return { label: t('soilData.meta.moisture.unknown'), badgeClass: 'bg-slate-100 text-slate-700' }
  }

  if (value < 30) {
    return { label: t('soilData.meta.moisture.dry'), badgeClass: 'bg-red-100 text-red-700' }
  }

  if (value <= 70) {
    return { label: t('soilData.meta.moisture.optimal'), badgeClass: 'bg-emerald-100 text-emerald-700' }
  }

  return { label: t('soilData.meta.moisture.wet'), badgeClass: 'bg-sky-100 text-sky-700' }
}

const temperatureMeta = (value, t) => {
  if (!Number.isFinite(value)) {
    return { label: t('soilData.meta.temperature.unknown'), textClass: 'text-slate-700' }
  }

  if (value > 35) {
    return { label: t('soilData.meta.temperature.heatWarning'), textClass: 'text-red-700' }
  }

  if (value < 15) {
    return { label: t('soilData.meta.temperature.coldStress'), textClass: 'text-sky-700' }
  }

  return { label: t('soilData.meta.temperature.normal'), textClass: 'text-emerald-700' }
}

function SoilData() {
  const [moisturePercent, setMoisturePercent] = useState(null)
  const [temperature, setTemperature] = useState(null)
  const [previousMoisture, setPreviousMoisture] = useState(null)
  const [updatedAt, setUpdatedAt] = useState(null)
  const [clock, setClock] = useState(new Date())
  const [selectedCrop, setSelectedCrop] = useState('Paddy')
  const [selectedDistrict, setSelectedDistrict] = useState('Thanjavur')
  const [selectedSeason, setSelectedSeason] = useState('Samba')
  const [selectedStage, setSelectedStage] = useState('Vegetative')
  const { t, i18n } = useTranslation()

  useEffect(() => {
    const sensorRef = ref(database, 'sensor')
    const unsubscribe = onValue(sensorRef, (snapshot) => {
      const data = snapshot.val()
      if (!data) {
        setMoisturePercent(null)
        setTemperature(null)
        setUpdatedAt(null)
        return
      }

      const nextMoisture = toMoisturePercent(data.soil_moisture)
      const nextTemperature = Number(data.temperature)

      setPreviousMoisture((current) =>
        Number.isFinite(current)
          ? current
          : Number.isFinite(nextMoisture)
            ? nextMoisture
            : null,
      )
      setMoisturePercent(nextMoisture)
      setTemperature(Number.isFinite(nextTemperature) ? Number(nextTemperature.toFixed(1)) : null)
      setUpdatedAt(new Date())
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      setClock(new Date())
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  const moisture = Number.isFinite(moisturePercent) ? moisturePercent : null
  const temp = Number.isFinite(temperature) ? temperature : null
  const cropProfile = cropProfiles[selectedCrop] || cropProfiles.Paddy
  const districtProfile = districtZoneProfiles[selectedDistrict] || { moistureDelta: 0, tempDelta: 0 }
  const seasonProfile = seasonProfiles[selectedSeason] || { moistureDelta: 0, tempDelta: 0 }
  const stageProfile = growthStageProfiles[selectedStage] || { moistureDelta: 0, tempDelta: 0 }

  const adjustedProfile = useMemo(() => {
    const moistureDelta = districtProfile.moistureDelta + seasonProfile.moistureDelta + stageProfile.moistureDelta
    const tempDelta = districtProfile.tempDelta + seasonProfile.tempDelta + stageProfile.tempDelta

    return {
      moistureMin: clamp(cropProfile.moistureMin + moistureDelta, 10, 95),
      moistureMax: clamp(cropProfile.moistureMax + moistureDelta, 20, 98),
      tempMin: Number((cropProfile.tempMin + tempDelta).toFixed(1)),
      tempMax: Number((cropProfile.tempMax + tempDelta).toFixed(1)),
    }
  }, [cropProfile.moistureMax, cropProfile.moistureMin, cropProfile.tempMax, cropProfile.tempMin, districtProfile.moistureDelta, districtProfile.tempDelta, seasonProfile.moistureDelta, seasonProfile.tempDelta, stageProfile.moistureDelta, stageProfile.tempDelta])
  const moistureInfo = moistureMeta(moisture, t)
  const temperatureInfo = temperatureMeta(temp, t)

  const translateOption = (group, value) => t(`soilData.options.${group}.${value}`, value)

  const localizedSelections = useMemo(
    () => ({
      crop: translateOption('crops', selectedCrop),
      district: translateOption('districts', selectedDistrict),
      season: translateOption('seasons', selectedSeason),
      stage: translateOption('stages', selectedStage),
    }),
    [selectedCrop, selectedDistrict, selectedSeason, selectedStage, t],
  )

  const trendArrow = useMemo(() => {
    if (!Number.isFinite(moisture) || !Number.isFinite(previousMoisture)) {
      return '→'
    }
    if (moisture > previousMoisture) return '↑'
    if (moisture < previousMoisture) return '↓'
    return '→'
  }, [moisture, previousMoisture])

  const irrigationSuggestion = useMemo(() => {
    if (!Number.isFinite(moisture)) {
      return t('soilData.irrigation.waiting')
    }
    if (moisture < 30) {
      return t('soilData.irrigation.dry')
    }
    if (moisture <= 70) {
      return t('soilData.irrigation.optimal')
    }
    return t('soilData.irrigation.wet')
  }, [moisture, t])

  const cropSuitability = useMemo(() => {
    if (!Number.isFinite(moisture) || !Number.isFinite(temp)) {
      return {
        badge: t('soilData.statuses.waiting'),
        badgeClass: 'bg-slate-100 text-slate-700',
        message: t('soilData.messages.waiting'),
      }
    }

    const moistureGapLow = adjustedProfile.moistureMin - moisture
    const moistureGapHigh = moisture - adjustedProfile.moistureMax
    const tempGapLow = adjustedProfile.tempMin - temp
    const tempGapHigh = temp - adjustedProfile.tempMax

    const moistureOptimal = moisture >= adjustedProfile.moistureMin && moisture <= adjustedProfile.moistureMax
    const tempOptimal = temp >= adjustedProfile.tempMin && temp <= adjustedProfile.tempMax

    if (moistureOptimal && tempOptimal) {
      return {
        badge: t('soilData.statuses.good'),
        badgeClass: 'bg-emerald-100 text-emerald-700',
        message: t('soilData.messages.good', {
          crop: localizedSelections.crop,
          district: localizedSelections.district,
          season: localizedSelections.season,
          stage: localizedSelections.stage,
        }),
      }
    }

    if (moistureGapLow > 10 || moistureGapHigh > 10 || tempGapLow > 5 || tempGapHigh > 5) {
      return {
        badge: t('soilData.statuses.poor'),
        badgeClass: 'bg-red-100 text-red-700',
        message:
          moisture < adjustedProfile.moistureMin
            ? t('soilData.messages.lowMoisture', {
                crop: localizedSelections.crop,
                season: localizedSelections.season,
                stage: localizedSelections.stage,
                min: adjustedProfile.moistureMin,
                max: adjustedProfile.moistureMax,
              })
            : moisture > adjustedProfile.moistureMax
              ? t('soilData.messages.highMoisture', {
                  crop: localizedSelections.crop,
                  district: localizedSelections.district,
                  min: adjustedProfile.moistureMin,
                  max: adjustedProfile.moistureMax,
                })
              : t('soilData.messages.temperature', {
                  crop: localizedSelections.crop,
                  min: adjustedProfile.tempMin,
                  max: adjustedProfile.tempMax,
                }),
      }
    }

    return {
      badge: t('soilData.statuses.moderate'),
      badgeClass: 'bg-amber-100 text-amber-700',
      message: t('soilData.messages.moderate', {
        crop: localizedSelections.crop,
        district: localizedSelections.district,
      }),
    }
  }, [
    adjustedProfile.moistureMax,
    adjustedProfile.moistureMin,
    adjustedProfile.tempMax,
    adjustedProfile.tempMin,
    moisture,
    temp,
    localizedSelections,
    t,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const summary =
      t('soilData.suitabilityTitle') +
      ` - ${localizedSelections.crop}, ${localizedSelections.district}, ${localizedSelections.season}, ${localizedSelections.stage}. ` +
      (i18n.language === 'ta'
        ? `ஈரப்பதம்: ${Number.isFinite(moisture) ? `${moisture}%` : '--'}, வெப்பநிலை: ${Number.isFinite(temp) ? `${temp}°C` : '--'}. நிலை: ${cropSuitability.badge}. ஆலோசனை: ${irrigationSuggestion}.`
        : `Moisture: ${Number.isFinite(moisture) ? `${moisture}%` : '--'}, temperature: ${Number.isFinite(temp) ? `${temp}°C` : '--'}. Status: ${cropSuitability.badge}. Advice: ${irrigationSuggestion}.`)

    window.__uzhavarPageSummary = {
      page: 'soil',
      summary,
      timestamp: Date.now(),
    }
  }, [
    cropSuitability.badge,
    i18n.language,
    irrigationSuggestion,
    localizedSelections.crop,
    localizedSelections.district,
    localizedSelections.season,
    localizedSelections.stage,
    moisture,
    t,
    temp,
  ])

  const gaugePercent = Number.isFinite(moisture) ? moisture : 0
  const gaugeStyle = {
    background: `conic-gradient(#10b981 ${gaugePercent * 3.6}deg, #e2e8f0 ${gaugePercent * 3.6}deg 360deg)`,
  }

  return (
    <section>
      <h1 className="text-3xl font-bold text-emerald-700">{t('soilData.title')}</h1>
      <p className="mt-2 text-sm text-slate-600">{t('soilData.subtitle')}</p>

      <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-emerald-100 transition-all duration-500">
        {Number.isFinite(moisture) || Number.isFinite(temp) ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <div className="mx-auto grid h-44 w-44 place-items-center rounded-full p-3" style={gaugeStyle}>
                <div className="grid h-full w-full place-items-center rounded-full bg-white">
                  <div className="text-center">
                    <p className="text-4xl font-bold text-slate-900">{gaugePercent}%</p>
                    <p className="text-xs text-slate-500">{t('soilData.gauge.moisture')}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-sm text-slate-600">{t('soilData.gauge.temperature')}</p>
                <p className={`text-3xl font-bold transition-all duration-500 ${temperatureInfo.textClass}`}>
                  {Number.isFinite(temp) ? `${temp}°C` : '--'}
                </p>
                <p className={`mt-1 text-sm font-semibold ${temperatureInfo.textClass}`}>{temperatureInfo.label}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
                <p className="text-sm font-semibold text-slate-800">{t('soilData.suitabilityTitle')}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <select
                    value={selectedCrop}
                    onChange={(event) => setSelectedCrop(event.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {cropOptions.map((crop) => (
                      <option key={crop} value={crop}>{translateOption('crops', crop)}</option>
                    ))}
                  </select>
                  <select
                    value={selectedDistrict}
                    onChange={(event) => setSelectedDistrict(event.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {districtOptions.map((district) => (
                      <option key={district} value={district}>{translateOption('districts', district)}</option>
                    ))}
                  </select>
                  <select
                    value={selectedSeason}
                    onChange={(event) => setSelectedSeason(event.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {seasonOptions.map((season) => (
                      <option key={season} value={season}>{translateOption('seasons', season)}</option>
                    ))}
                  </select>
                  <select
                    value={selectedStage}
                    onChange={(event) => setSelectedStage(event.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {growthStageOptions.map((stage) => (
                      <option key={stage} value={stage}>{translateOption('stages', stage)}</option>
                    ))}
                  </select>
                </div>

                <div className="mt-3 text-xs text-slate-600">
                  <p>{t('soilData.localized.moisture', { min: adjustedProfile.moistureMin, max: adjustedProfile.moistureMax })}</p>
                  <p>{t('soilData.localized.temperature', { min: adjustedProfile.tempMin, max: adjustedProfile.tempMax })}</p>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${cropSuitability.badgeClass}`}>
                    {cropSuitability.badge}
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-700">{cropSuitability.message}</p>
              </div>

              <div className="flex items-center gap-2">
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${moistureInfo.badgeClass}`}>
                  {moistureInfo.label}
                </span>
                <span className="text-sm font-semibold text-slate-700">{t('soilData.trend', { arrow: trendArrow })}</span>
              </div>

              <div className="rounded-xl bg-emerald-50 p-4">
                <p className="text-sm font-semibold text-emerald-800">{t('soilData.irrigation.title')}</p>
                <p className="mt-1 text-sm text-slate-700">{irrigationSuggestion}</p>
              </div>

              <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                <p>
                  {t('soilData.lastUpdate', {
                    time: updatedAt ? updatedAt.toLocaleTimeString() : t('soilData.syncing'),
                  })}
                </p>
                <p className="mt-1">
                  {t('soilData.liveClock', { time: clock.toLocaleTimeString() })}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-600">{t('soilData.waitingSensor')}</p>
        )}
      </div>
    </section>
  )
}

export default SoilData
