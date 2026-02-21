const FEED_KEY = 'agrosense_notification_feed'
const FEED_EVENT = 'agrosense:notification'

const safeParse = (value, fallback) => {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const canUseWindow = () => typeof window !== 'undefined'

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index)
  }

  return outputArray
}

export const getNotificationFeed = () => {
  if (!canUseWindow()) {
    return []
  }

  const stored = window.localStorage.getItem(FEED_KEY)
  const parsed = safeParse(stored, [])
  return Array.isArray(parsed) ? parsed : []
}

const writeNotificationFeed = (items) => {
  if (!canUseWindow()) {
    return
  }

  window.localStorage.setItem(FEED_KEY, JSON.stringify(items))
}

export const subscribeNotificationFeed = (listener) => {
  if (!canUseWindow()) {
    return () => {}
  }

  const handler = (event) => listener(event.detail)
  window.addEventListener(FEED_EVENT, handler)
  return () => window.removeEventListener(FEED_EVENT, handler)
}

const emitFeedEvent = (item) => {
  if (!canUseWindow()) {
    return
  }

  window.dispatchEvent(new CustomEvent(FEED_EVENT, { detail: item }))
}

const maybeBrowserNotify = async (item) => {
  if (!canUseWindow() || !('Notification' in window) || item.notifyDevice === false) {
    return
  }

  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      return
    }
  }

  if (Notification.permission === 'granted') {
    new Notification(item.title, { body: item.message })
  }
}

const fetchPushPublicKey = async (apiBaseUrl) => {
  const response = await fetch(`${apiBaseUrl}/api/push/public-key`)
  if (!response.ok) {
    throw new Error('Unable to fetch push public key')
  }

  const data = await response.json()
  if (!data?.publicKey) {
    throw new Error('Public key missing from server')
  }
  return data.publicKey
}

export const ensurePushSubscription = async (apiBaseUrl, getAuthToken) => {
  if (!canUseWindow()) {
    return null
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return null
  }

  if (Notification.permission === 'denied') {
    return null
  }

  if (!apiBaseUrl) {
    return null
  }

  const publicKey = await fetchPushPublicKey(apiBaseUrl)
  const registration = await navigator.serviceWorker.register('/service-worker.js')
  let subscription = await registration.pushManager.getSubscription()

  if (!subscription) {
    if (Notification.permission === 'default') {
      try {
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
          return null
        }
      } catch {
        return null
      }
    }

    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  }

  try {
    const token = typeof getAuthToken === 'function' ? await getAuthToken() : ''
    await fetch(`${apiBaseUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ subscription }),
    })
  } catch (error) {
    console.error('Push subscription sync failed:', error)
  }

  return subscription
}

export const pushNotification = async (payload) => {
  const normalized = {
    id: payload.id || `${payload.source || 'general'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    referenceId: payload.referenceId || '',
    source: payload.source || 'general',
    type: payload.type || 'general',
    priority: (payload.priority || 'medium').toLowerCase(),
    title: payload.title || 'AgroSense Alert',
    message: payload.message || '',
    createdAt: payload.createdAt || Date.now(),
    notifyDevice: payload.notifyDevice !== false,
  }

  const current = getNotificationFeed()
  if (normalized.referenceId && current.some((item) => item.referenceId === normalized.referenceId)) {
    return null
  }

  const next = [normalized, ...current].slice(0, 200)
  writeNotificationFeed(next)
  emitFeedEvent(normalized)
  await maybeBrowserNotify(normalized)
  return normalized
}

export const removeNotificationsByIds = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    return
  }

  const idSet = new Set(ids)
  const next = getNotificationFeed().filter((item) => !idSet.has(item.id))
  writeNotificationFeed(next)
}

export const clearAllNotifications = () => {
  writeNotificationFeed([])
}
