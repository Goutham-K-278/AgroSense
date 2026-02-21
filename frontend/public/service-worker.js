self.addEventListener('push', (event) => {
  const data = event.data ? (() => {
    try {
      return event.data.json()
    } catch (error) {
      return { title: 'AgroSense', message: event.data.text() }
    }
  })() : { title: 'AgroSense', message: '' }

  const title = data.title || 'AgroSense'
  const body = data.message || ''
  const tag = data.tag || 'agrosense'
  const url = data.url || '/'

  const options = {
    body,
    tag,
    data: { url },
    icon: '/favicon.ico',
    badge: '/favicon.ico',
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification?.data?.url || '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus()
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl)
      }
      return null
    }),
  )
})
