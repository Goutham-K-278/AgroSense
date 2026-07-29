import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

function MobileBottomNav() {
  const { t } = useTranslation()

  const handleOpenAssistant = () => {
    if (typeof window === 'undefined') {
      return
    }

    window.dispatchEvent(new CustomEvent('assistant:open'))
  }

  const navItems = [
    { key: 'home', path: '/', label: t('sidebar.menu.home'), icon: '🏠' },
    { key: 'soil', path: '/dashboard/soil', label: t('sidebar.menu.soil'), icon: '🌱' },
    { key: 'weather', path: '/dashboard/weather', label: t('sidebar.menu.weather'), icon: '☁️' },
    { key: 'alerts', path: '/dashboard/alerts', label: t('sidebar.menu.alerts'), icon: '🔔' },
  ]

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-emerald-100 bg-white/95 px-2 pb-[calc(env(safe-area-inset-bottom,0px)+0.35rem)] pt-2 backdrop-blur md:hidden"
      aria-label="Mobile bottom navigation"
    >
      <ul className="grid grid-cols-5 gap-1">
        {navItems.map((item) => (
          <li key={item.key}>
            <NavLink
              to={item.path}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center rounded-lg px-1 py-1.5 text-[11px] font-medium leading-tight transition ${
                  isActive ? 'bg-emerald-100 text-emerald-700' : 'text-slate-600 hover:bg-emerald-50'
                }`
              }
            >
              <span className="text-base" aria-hidden="true">{item.icon}</span>
              <span className="truncate">{item.label}</span>
            </NavLink>
          </li>
        ))}

        <li>
          <button
            type="button"
            onClick={handleOpenAssistant}
            className="flex w-full flex-col items-center justify-center rounded-lg px-1 py-1.5 text-[11px] font-medium leading-tight text-slate-600 transition hover:bg-emerald-50"
            aria-label="Open AI assistant"
          >
            <span className="text-base" aria-hidden="true">🤖</span>
            <span>AI</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}

export default MobileBottomNav
