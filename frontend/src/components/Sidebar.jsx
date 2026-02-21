import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

function Sidebar() {
  const { t } = useTranslation()
  const menuItems = [
    { key: 'home', path: '/' },
    { key: 'soil', path: '/dashboard/soil' },
    { key: 'npk', path: '/dashboard/npk' },
    { key: 'weather', path: '/dashboard/weather' },
    { key: 'alerts', path: '/dashboard/alerts' },
    { key: 'fertilizer', path: '/dashboard/fertilizer' },
    { key: 'cropAnalysis', path: '/dashboard/crop-analysis' },
    { key: 'environment', path: '/dashboard/environment' },
  ]

  return (
    <aside className="sticky top-0 h-screen w-72 shrink-0 border-r border-emerald-100 bg-white p-4 shadow-lg">
      <h2 className="mb-6 text-xl font-bold text-green-700">{t('sidebar.title', '🌾 AgroSense')}</h2>

      <ul className="space-y-2">
        {menuItems.map((item) => (
          <li key={item.key}>
            <NavLink
              to={item.path}
              className={({ isActive }) =>
                `block rounded-lg p-3 text-sm font-medium transition ${
                  isActive
                    ? 'bg-green-600 text-white shadow'
                    : 'text-slate-700 hover:bg-green-100'
                }`
              }
            >
              {t(`sidebar.menu.${item.key}`)}
            </NavLink>
          </li>
        ))}
      </ul>
    </aside>
  )
}

export default Sidebar
