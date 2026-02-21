import { Outlet } from 'react-router-dom'
import Sidebar from '../components/Sidebar.jsx'

function DashboardLayout() {
  return (
    <div className="flex min-h-screen bg-green-50">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-6 md:p-8">
        <Outlet />
      </div>
    </div>
  )
}

export default DashboardLayout
