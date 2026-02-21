import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { auth } from '../firebase'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
const MAX_IMAGE_EDGE = 1280
const MAX_IMAGE_SIZE_BYTES = 1_200_000

const optimizeImageForUpload = async (file) => {
  if (!file || !file.type?.startsWith('image/')) {
    return file
  }

  if (file.size <= MAX_IMAGE_SIZE_BYTES) {
    return file
  }

  if (typeof window === 'undefined') {
    return file
  }

  const imageUrl = URL.createObjectURL(file)

  try {
    const optimizedBlob = await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height))
        const targetWidth = Math.max(1, Math.round(image.width * scale))
        const targetHeight = Math.max(1, Math.round(image.height * scale))

        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetHeight
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error('Unable to optimize image'))
          return
        }

        context.drawImage(image, 0, 0, targetWidth, targetHeight)
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Image optimization failed'))
              return
            }
            resolve(blob)
          },
          'image/jpeg',
          0.84,
        )
      }
      image.onerror = () => reject(new Error('Image load failed'))
      image.src = imageUrl
    })

    return new File([optimizedBlob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(imageUrl)
  }
}

function CropAnalysis() {
  const { t, i18n } = useTranslation()
  const cropOptions = ['Rice', 'Corn', 'Potato', 'Wheat', 'Sugarcane']
  const [mediaFile, setMediaFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [symptomText, setSymptomText] = useState('')
  const [selectedCropType, setSelectedCropType] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!mediaFile) {
      setPreviewUrl('')
      return
    }

    const objectUrl = URL.createObjectURL(mediaFile)
    setPreviewUrl(objectUrl)

    return () => URL.revokeObjectURL(objectUrl)
  }, [mediaFile])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    if (!analysis) {
      window.__uzhavarPageSummary = {
        page: 'crop-analysis',
        summary: '',
      }
      return
    }

    const summary =
      i18n.language === 'ta'
        ? `கண்டறிதல்: ${analysis.diseaseTa || analysis.disease}. நம்பிக்கை: ${Math.round((analysis.confidence || 0) * 100)}%. சிக்கல்: ${analysis.problem}. உடனடி செயல்: ${(analysis.whatToDo || []).slice(0, 2).join(', ')}. உரம்: ${(analysis.fertilizer || []).slice(0, 1).join(', ')}. மருந்து: ${(analysis.medicine || []).slice(0, 1).join(', ')}`
        : `Detection: ${analysis.diseaseEn || analysis.disease}. Confidence: ${Math.round((analysis.confidence || 0) * 100)}%. Problem: ${analysis.problem}. Immediate actions: ${(analysis.whatToDo || []).slice(0, 2).join(', ')}. Fertilizer: ${(analysis.fertilizer || []).slice(0, 1).join(', ')}. Medicine: ${(analysis.medicine || []).slice(0, 1).join(', ')}`

    window.__uzhavarPageSummary = {
      page: 'crop-analysis',
      summary,
      timestamp: Date.now(),
    }
  }, [analysis, i18n.language])

  const mediaType = useMemo(() => {
    if (!mediaFile) {
      return ''
    }
    return mediaFile.type.startsWith('video/') ? 'video' : 'image'
  }, [mediaFile])

  const handlePickMedia = (event) => {
    const selectedFile = event.target.files?.[0] || null
    setMediaFile(selectedFile)
    setAnalysis(null)
    setError('')
  }

  const handleAnalyze = async () => {
    if (!mediaFile) {
      setError(t('cropAnalysis.errors.mediaRequired'))
      return
    }

    if (!mediaFile.type.startsWith('image/')) {
      setError(t('cropAnalysis.errors.imageOnly'))
      return
    }

    if (!symptomText.trim()) {
      setError(t('cropAnalysis.errors.symptomRequired'))
      return
    }

    if (!selectedCropType) {
      setError(t('cropAnalysis.errors.cropRequired'))
      return
    }

    setIsAnalyzing(true)
    setError('')
    setAnalysis(null)

    try {
      const user = auth.currentUser
      if (!user) {
        throw new Error(t('cropAnalysis.errors.loginRequired'))
      }

      const token = await user.getIdToken()
      const formData = new FormData()
      const optimizedImage = await optimizeImageForUpload(mediaFile)
      formData.append('image', optimizedImage)
      formData.append('note', symptomText.trim())
      formData.append('cropType', selectedCropType)

      const response = await fetch(`${API_BASE_URL}/api/crop-diagnosis`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      })

      const contentType = response.headers.get('content-type') || ''
      const isJson = contentType.includes('application/json')
      const rawBody = await response.text()

      let data = null
      if (isJson) {
        try {
          data = JSON.parse(rawBody)
        } catch (parseError) {
          const snippet = rawBody.slice(0, 120)
          throw new Error(
            `${t('cropAnalysis.errors.server')} (invalid JSON ${response.status} ${response.statusText}: ${snippet || 'empty body'})`
          )
        }
      } else {
        const snippet = rawBody.slice(0, 120)
        throw new Error(
          `${t('cropAnalysis.errors.server')} (expected JSON, got ${response.status} ${response.statusText}: ${snippet || 'empty body'})`
        )
      }

      if (!response.ok) {
        throw new Error(data?.error || t('cropAnalysis.errors.server'))
      }

      const recEn = data?.recommendation || {}
      const recTa = data?.recommendationTa || recEn
      const isTamil = i18n.language === 'ta'
      const rec = isTamil ? recTa : recEn
      const diseaseName = isTamil ? data?.diseaseTa || data?.disease : data?.disease
      const confidenceValue = Number(data?.confidence || 0)
      const confidenceText = isTamil
        ? data?.confidenceText?.ta || t('cropAnalysis.results.notConfident')
        : data?.confidenceText?.en || t('cropAnalysis.results.notConfident')

      setAnalysis({
        disease: diseaseName || t('cropAnalysis.results.fallbackDisease'),
        diseaseEn: data?.disease || t('cropAnalysis.results.fallbackDisease'),
        diseaseTa: data?.diseaseTa || data?.disease || t('cropAnalysis.results.fallbackDisease'),
        confidence: confidenceValue,
        confidenceText,
        urgency: recEn?.urgency || 'medium',
        whatToDo: rec?.whatToDo || [],
        prevention: rec?.prevention || [],
        fertilizer: rec?.fertilizer || [],
        medicine: rec?.medicine || [],
        whatToDoEn: recEn?.whatToDo || [],
        preventionEn: recEn?.prevention || [],
        fertilizerEn: recEn?.fertilizer || [],
        medicineEn: recEn?.medicine || [],
        problemEn: recEn?.problem || t('cropAnalysis.results.fallbackProblem'),
        whatToDoTa: recTa?.whatToDo || recEn?.whatToDo || [],
        preventionTa: recTa?.prevention || recEn?.prevention || [],
        fertilizerTa: recTa?.fertilizer || recEn?.fertilizer || [],
        medicineTa: recTa?.medicine || recEn?.medicine || [],
        problemTa: recTa?.problem || recEn?.problem || t('cropAnalysis.results.fallbackProblem'),
        problem: rec?.problem || t('cropAnalysis.results.fallbackProblem'),
        diseaseKey: data?.diseaseKey || '',
        note: symptomText.trim(),
        mediaName: mediaFile.name,
        adjustedByFarmerNote: Boolean(data?.adjustedByFarmerNote),
        adjustedByCropHint: Boolean(data?.adjustedByCropHint),
      })
    } catch (requestError) {
      setError(requestError?.message || t('cropAnalysis.errors.server'))
    } finally {
      setIsAnalyzing(false)
    }
  }

  return (
    <section className="space-y-6">
      <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
        <h1 className="text-3xl font-bold text-emerald-700">🔍 {t('cropAnalysis.title')}</h1>
        <p className="mt-2 text-sm text-slate-600">{t('cropAnalysis.subtitle')}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
          <h2 className="text-lg font-semibold text-slate-900">{t('cropAnalysis.upload.title')}</h2>
          <p className="mt-1 text-sm text-slate-600">{t('cropAnalysis.upload.subtitle')}</p>

          <div className="mt-4 flex flex-wrap gap-3">
            <label className="cursor-pointer rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100">
              {t('cropAnalysis.upload.uploadButton')}
              <input
                type="file"
                accept="image/*,video/*"
                onChange={handlePickMedia}
                className="hidden"
              />
            </label>

            <label className="cursor-pointer rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100">
              {t('cropAnalysis.upload.scanButton')}
              <input
                type="file"
                accept="image/*,video/*"
                capture="environment"
                onChange={handlePickMedia}
                className="hidden"
              />
            </label>
          </div>

          <p className="mt-3 text-xs text-slate-500">{t('cropAnalysis.upload.limit')}</p>

          <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3">
            {!previewUrl ? (
              <p className="text-sm text-slate-500">{t('cropAnalysis.upload.noFile')}</p>
            ) : mediaType === 'video' ? (
              <video src={previewUrl} controls className="h-56 w-full rounded-lg object-cover" />
            ) : (
              <img
                src={previewUrl}
                alt={t('cropAnalysis.upload.previewAlt')}
                className="h-56 w-full rounded-lg object-cover"
              />
            )}
          </div>

          <div className="mt-4">
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="crop-type-select">
              {t('cropAnalysis.upload.cropTypeLabel')}
            </label>
            <select
              id="crop-type-select"
              value={selectedCropType}
              onChange={(event) => {
                setSelectedCropType(event.target.value)
                setAnalysis(null)
              }}
              className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
            >
              <option value="">{t('cropAnalysis.upload.cropTypePlaceholder')}</option>
              {cropOptions.map((item) => (
                <option key={item} value={item}>{t(`cropAnalysis.upload.cropNames.${item}`, item)}</option>
              ))}
            </select>

            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="symptom-text">
              {t('cropAnalysis.upload.symptomLabel')}
            </label>
            <textarea
              id="symptom-text"
              value={symptomText}
              onChange={(event) => {
                setSymptomText(event.target.value)
                setAnalysis(null)
              }}
              placeholder={t('cropAnalysis.upload.symptomPlaceholder')}
              className="min-h-28 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
            />
          </div>

          {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}

          <button
            type="button"
            onClick={handleAnalyze}
            disabled={!mediaFile || !symptomText.trim() || isAnalyzing}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isAnalyzing ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span>{t('cropAnalysis.buttons.analyzing')}</span>
              </>
            ) : (
              t('cropAnalysis.buttons.analyze')
            )}
          </button>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
          <h2 className="text-lg font-semibold text-slate-900">{t('cropAnalysis.about.title')}</h2>
          <p className="mt-2 max-h-80 overflow-y-auto whitespace-pre-line pr-1 text-sm leading-6 text-slate-700">
            {t('cropAnalysis.about.description')}
          </p>

          <ul className="mt-4 space-y-2 text-sm text-slate-600">
            <li className="rounded-lg bg-emerald-50 px-3 py-2">✅ {t('cropAnalysis.about.point1')}</li>
            <li className="rounded-lg bg-emerald-50 px-3 py-2">✅ {t('cropAnalysis.about.point2')}</li>
            <li className="rounded-lg bg-emerald-50 px-3 py-2">✅ {t('cropAnalysis.about.point3')}</li>
          </ul>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <article className="space-y-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">{t('cropAnalysis.results.problemTitle')}</h3>
              <p className="text-sm text-slate-600">{t('cropAnalysis.results.detectedLabel')}</p>
            </div>
            {analysis ? (
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  analysis.urgency === 'high'
                    ? 'bg-red-100 text-red-800'
                    : analysis.urgency === 'low'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-amber-100 text-amber-800'
                }`}
              >
                {t(`cropAnalysis.results.urgency.${analysis.urgency}`, analysis.urgency)}
              </span>
            ) : null}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-base font-semibold text-slate-900">
              {analysis
                ? (i18n.language === 'ta' ? analysis.diseaseTa || analysis.disease : analysis.diseaseEn || analysis.disease)
                : t('cropAnalysis.results.problemPlaceholder')}
            </p>
            {analysis ? (
              <p className="mt-1 text-sm text-slate-700">
                {i18n.language === 'ta' ? analysis.problemTa || analysis.problem : analysis.problemEn || analysis.problem}
              </p>
            ) : (
              <p className="mt-1 text-sm text-slate-500">{t('cropAnalysis.results.solutionPlaceholder')}</p>
            )}

            {analysis ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-700">
                <span className="rounded-full bg-emerald-50 px-3 py-1 font-semibold text-emerald-800">
                  {analysis.confidenceText ||
                    t('cropAnalysis.results.confidenceLabel', {
                      value: Math.round((analysis.confidence || 0) * 100),
                    })}
                </span>
                {analysis.confidence < 0.6 ? (
                  <span className="rounded-full bg-amber-50 px-3 py-1 font-semibold text-amber-800">
                    {t('cropAnalysis.results.notConfident')}
                  </span>
                ) : null}
                {analysis.adjustedByFarmerNote ? (
                  <span className="rounded-full bg-blue-50 px-3 py-1 font-semibold text-blue-800">
                    {t('cropAnalysis.results.adjustedByNote')}
                  </span>
                ) : null}
                {analysis.adjustedByCropHint ? (
                  <span className="rounded-full bg-indigo-50 px-3 py-1 font-semibold text-indigo-800">
                    {t('cropAnalysis.results.adjustedByCrop')}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {analysis ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <p className="font-semibold text-slate-700">{t('cropAnalysis.results.referenceTitle')}</p>
              <p className="mt-1">{t('cropAnalysis.results.referenceMedia', { media: analysis.mediaName })}</p>
              <p className="mt-1">{t('cropAnalysis.results.referenceNote', { note: analysis.note })}</p>
            </div>
          ) : null}
        </article>

        <article className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">{t('cropAnalysis.results.solutionTitle')}</h3>
            <p className="text-sm text-slate-600">{t('cropAnalysis.results.actionsSubtitle')}</p>
          </div>

          <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-900">
            <p className="font-semibold">{t('cropAnalysis.results.whatToDo')}</p>
            {analysis && (i18n.language === 'ta' ? analysis.whatToDoTa : analysis.whatToDoEn).length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {(i18n.language === 'ta' ? analysis.whatToDoTa : analysis.whatToDoEn).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-emerald-800">{t('cropAnalysis.results.solutionPlaceholder')}</p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
            <p className="font-semibold">{t('cropAnalysis.results.prevention')}</p>
            {analysis && (i18n.language === 'ta' ? analysis.preventionTa : analysis.preventionEn).length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {(i18n.language === 'ta' ? analysis.preventionTa : analysis.preventionEn).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-700">{t('cropAnalysis.results.solutionPlaceholder')}</p>
            )}
          </div>

          <div className="rounded-xl border border-lime-200 bg-lime-50 p-4 text-sm text-lime-900">
            <p className="font-semibold">{t('cropAnalysis.results.fertilizerTitle')}</p>
            {analysis && (i18n.language === 'ta' ? analysis.fertilizerTa : analysis.fertilizerEn).length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {(i18n.language === 'ta' ? analysis.fertilizerTa : analysis.fertilizerEn).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-lime-800">{t('cropAnalysis.results.fertilizerPlaceholder')}</p>
            )}
          </div>

          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
            <p className="font-semibold">{t('cropAnalysis.results.medicineTitle')}</p>
            {analysis && (i18n.language === 'ta' ? analysis.medicineTa : analysis.medicineEn).length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {(i18n.language === 'ta' ? analysis.medicineTa : analysis.medicineEn).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-rose-800">{t('cropAnalysis.results.medicinePlaceholder')}</p>
            )}
          </div>
        </article>
      </div>
    </section>
  )
}

export default CropAnalysis