import { useEffect, useState } from 'react'
import { subscribeNotificationFeed } from '../utils/notificationCenter'

function NotificationHost() {
  const [items, setItems] = useState([])

  useEffect(() => {
    const unsubscribe = subscribeNotificationFeed((item) => {
      if (!item) {
        return
      }

      setItems((prev) => [item, ...prev].slice(0, 4))
      setTimeout(() => {
        setItems((prev) => prev.filter((entry) => entry.id !== item.id))
      }, 4500)
    })

    return () => unsubscribe()
  }, [])

  if (items.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-none fixed right-4 top-20 z-[70] flex w-[min(360px,92vw)] flex-col gap-2">
      {items.map((item) => (
        <article
          key={item.id}
          className="rounded-xl border border-emerald-200 bg-white/95 p-3 shadow-lg backdrop-blur"
        >
          <p className="text-sm font-semibold text-slate-900">{item.title}</p>
          <p className="mt-1 text-xs text-slate-600">{item.message}</p>
        </article>
      ))}
    </div>
  )
}

export default NotificationHost
