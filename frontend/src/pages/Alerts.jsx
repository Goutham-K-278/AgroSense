import { useEffect, useMemo, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { useTranslation } from 'react-i18next'
import { auth } from '../firebase'
import { localizeFarmText } from '../utils/localizeFarmText'
import {
  getNotificationFeed,
  removeNotificationsByIds,
  subscribeNotificationFeed,
} from '../utils/notificationCenter'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const priorityStyles = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-yellow-100 text-yellow-800',
  low: 'bg-green-100 text-green-800',
}

const typeIcons = {
  irrigation: '💧',
  fertilizer: '🧪',
  weather: '🌧',
  soil: '📉',
  deadline: '⏳',
  npk: '🧬',
  community: '📣',
  general: '🔔',
}

const filters = ['all', 'high', 'medium', 'low']

const hoursLeftText = (deadlineHours, t) => {
  const value = Number(deadlineHours)
  if (!Number.isFinite(value) || value <= 0) {
    return t('alerts.noDeadline')
  }
  return t('alerts.actionWithin', { hours: Math.round(value) })
}

function Alerts() {
  const [alerts, setAlerts] = useState([])
  const [feedItems, setFeedItems] = useState([])
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dismissedIds, setDismissedIds] = useState(new Set())
  const [activeUserId, setActiveUserId] = useState('')
  const { t, i18n } = useTranslation()

  const dismissedStorageKey = activeUserId ? `agrosense_dismissed_alerts_${activeUserId}` : ''

  const loadDismissed = (key) => {
    if (!key) {
      return new Set()
    }

    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '[]')
      return new Set(Array.isArray(parsed) ? parsed : [])
    } catch {
      return new Set()
    }
  }

  const saveDismissed = (nextSet, key) => {
    if (!key) {
      return
    }
    localStorage.setItem(key, JSON.stringify([...nextSet]))
  }

  const fetchAlerts = async () => {
    const currentUser = auth.currentUser
    if (!currentUser) {
      throw new Error(t('alerts.errors.loginRequired'))
    }

    const token = await currentUser.getIdToken(true)
    const response = await fetch(`${API_BASE_URL}/api/alerts`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    const data = await response.json()
    if (!response.ok) {
      throw new Error(data?.error || t('alerts.errors.fetchFailed'))
    }

    return Array.isArray(data?.alerts) ? data.alerts : []
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setActiveUserId('')
        setDismissedIds(new Set())
        setLoading(false)
        setAlerts([])
        setError(t('alerts.errors.loginRequired'))
        return
      }

      setActiveUserId(user.uid)
      setDismissedIds(loadDismissed(`agrosense_dismissed_alerts_${user.uid}`))

      try {
        setLoading(true)
        setError('')
        const items = await fetchAlerts()
        setAlerts(items)
      } catch (fetchError) {
        setAlerts([])
        setError(fetchError?.message || t('alerts.errors.loadFailed'))
      } finally {
        setLoading(false)
      }
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    setFeedItems(getNotificationFeed())

    const unsubscribe = subscribeNotificationFeed(() => {
      setFeedItems(getNotificationFeed())
    })

    return () => unsubscribe()
  }, [])

  const mergedAlerts = useMemo(() => {
    const apiAlerts = alerts.map((item) => ({
      id: `api-${item.id}`,
      source: 'api',
      type: String(item?.type || 'deadline').toLowerCase(),
      priority: String(item?.priority || 'low').toLowerCase(),
      title: item.title || t('alerts.defaultTitle'),
      message: item.message || t('alerts.defaultMessage'),
      actionDeadlineHours: item.actionDeadlineHours,
      createdAt: Number(item.createdAt) || 0,
    }))

    const notificationAlerts = feedItems
      .filter((item) => String(item?.source || '').toLowerCase() !== 'environment')
      .map((item) => ({
        id: item.id,
        source: item.source || 'general',
        type: String(item?.type || 'general').toLowerCase(),
        priority: String(item?.priority || 'medium').toLowerCase(),
        title: item.title || t('alerts.defaultTitle'),
        message: item.message || t('alerts.defaultMessage'),
        actionDeadlineHours: item.actionDeadlineHours,
        createdAt: Number(item.createdAt) || Date.now(),
      }))

    return [...notificationAlerts, ...apiAlerts]
      .filter((item) => !dismissedIds.has(item.id))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
  }, [alerts, dismissedIds, feedItems, t])

  const filteredAlerts = useMemo(() => {
    if (filter === 'all') {
      return mergedAlerts
    }

    return mergedAlerts.filter((item) => String(item?.priority || '').toLowerCase() === filter)
  }, [filter, mergedAlerts])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const top = filteredAlerts.slice(0, 3).map((item) => {
      const title = localizeFarmText(item.title || t('alerts.defaultTitle'), i18n.language)
      const message = localizeFarmText(item.message || t('alerts.defaultMessage'), i18n.language)
      return `${title}: ${message}`
    })

    const summary =
      i18n.language === 'ta'
        ? `மொத்த எச்சரிக்கைகள்: ${filteredAlerts.length}. முக்கியமானவை: ${top.join(' | ') || 'இல்லை'}`
        : `Total alerts: ${filteredAlerts.length}. Top alerts: ${top.join(' | ') || 'none'}`

    window.__uzhavarPageSummary = {
      page: 'alerts',
      summary,
      timestamp: Date.now(),
    }
  }, [filteredAlerts, i18n.language, t])

  const handleClearByPriority = () => {
    if (filter === 'all') {
      return
    }

    const targetIds = mergedAlerts
      .filter((item) => item.priority === filter)
      .map((item) => item.id)

    const next = new Set(dismissedIds)
    targetIds.forEach((id) => next.add(id))

    setDismissedIds(next)
    saveDismissed(next, dismissedStorageKey)
    removeNotificationsByIds(targetIds)
  }

  const handleClearAll = () => {
    const targetIds = mergedAlerts.map((item) => item.id)
    const next = new Set(dismissedIds)
    targetIds.forEach((id) => next.add(id))

    setDismissedIds(next)
    saveDismissed(next, dismissedStorageKey)
    removeNotificationsByIds(targetIds)
  }

  return (
    <section>
      <h1 className="text-3xl font-bold text-emerald-700">{t('alerts.title')}</h1>
      <p className="mt-2 text-sm text-slate-600">{t('alerts.subtitle')}</p>

      <div className="mt-6 flex flex-wrap gap-2">
        {filters.map((item) => (
          <button
            type="button"
            key={item}
            onClick={() => setFilter(item)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              filter === item
                ? 'bg-emerald-600 text-white'
                : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-emerald-50'
            }`}
          >
            {t(`alerts.filters.${item}`)}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={handleClearByPriority}
          disabled={filter === 'all' || mergedAlerts.length === 0}
          className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('alerts.buttons.clear')}
        </button>

        <button
          type="button"
          onClick={handleClearAll}
          disabled={mergedAlerts.length === 0}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('alerts.buttons.clearAll')}
        </button>
      </div>

      <div className="mt-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-emerald-100">
        {loading ? (
          <p className="text-sm text-slate-600">{t('alerts.loading')}</p>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : filteredAlerts.length === 0 ? (
          <p className="text-sm text-slate-600">{t('alerts.empty')}</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {filteredAlerts.map((item) => {
              const priority = String(item?.priority || 'low').toLowerCase()
              const type = String(item?.type || 'deadline').toLowerCase()

              return (
                <article key={item.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-base font-semibold text-slate-900">
                      <span className="mr-2">{typeIcons[type] || '🔔'}</span>
                      {localizeFarmText(item.title || t('alerts.defaultTitle'), i18n.language)}
                    </h2>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${priorityStyles[priority] || priorityStyles.low}`}>
                      {t(`alerts.priority.${priority}`, priority.toUpperCase())}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-slate-700">{localizeFarmText(item.message || t('alerts.defaultMessage'), i18n.language)}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    {item.source === 'environment'
                      ? t('alerts.sources.environment')
                      : item.source === 'alerts'
                        ? t('alerts.sources.system')
                        : item.source === 'api'
                          ? t('alerts.sources.system')
                          : t('alerts.sources.general')}
                  </p>
                  <p className="mt-3 text-xs font-medium text-slate-500">{hoursLeftText(item.actionDeadlineHours, t)}</p>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

export default Alerts
