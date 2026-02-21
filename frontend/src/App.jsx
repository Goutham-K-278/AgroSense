import { useEffect, useRef } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { onValue, ref as dbRef } from 'firebase/database'
import { useTranslation } from 'react-i18next'
import Analyze from './pages/Analyze.jsx'
import Home from './pages/Home.jsx'
import AssistantWidget from './components/AssistantWidget.jsx'
import Navbar from './components/Navbar.jsx'
import NotificationHost from './components/NotificationHost.jsx'
import DashboardLayout from './layout/DashboardLayout.jsx'
import Environment from './pages/Environment.jsx'
import CropAnalysis from './pages/CropAnalysis.jsx'
import SoilData from './pages/SoilData.jsx'
import NpkTrend from './pages/NpkTrend.jsx'
import Weather from './pages/Weather.jsx'
import Alerts from './pages/Alerts.jsx'
import Fertilizer from './pages/Fertilizer.jsx'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import { auth, database } from './firebase'
import { ensurePushSubscription, pushNotification } from './utils/notificationCenter'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

function App() {
  const { t } = useTranslation()
  const knownAlertIdsRef = useRef(new Set())
  const knownPostIdsRef = useRef(new Set())
  const pushRegisteredRef = useRef(false)

  useEffect(() => {
    let alertInterval = null
    let stopPostsListener = null

    const stopAuthListener = onAuthStateChanged(auth, async (user) => {
      knownAlertIdsRef.current = new Set()
      knownPostIdsRef.current = new Set()

      if (alertInterval) {
        window.clearInterval(alertInterval)
        alertInterval = null
      }

      if (stopPostsListener) {
        stopPostsListener()
        stopPostsListener = null
      }

      if (!user) {
        pushRegisteredRef.current = false
        return
      }

      try {
        if (!pushRegisteredRef.current) {
          await ensurePushSubscription(API_BASE_URL, () => user.getIdToken())
          pushRegisteredRef.current = true
        }
      } catch (error) {
        console.error('Push subscription setup failed:', error)
      }

      const pollAlerts = async (notifyOnNew = false) => {
        try {
          const token = await user.getIdToken()
          const response = await fetch(`${API_BASE_URL}/api/alerts`, {
            headers: { Authorization: `Bearer ${token}` },
          })

          if (!response.ok) {
            return
          }

          const data = await response.json()
          const items = Array.isArray(data?.alerts) ? data.alerts : []
          items.forEach((item) => {
            const id = String(item.id || '')
            if (!id) {
              return
            }

            if (!knownAlertIdsRef.current.has(id) && notifyOnNew) {
              pushNotification({
                referenceId: `api-alert-${id}`,
                source: 'alerts',
                type: String(item.type || 'deadline').toLowerCase(),
                priority: String(item.priority || 'medium').toLowerCase(),
                title: item.title || t('notifications.farmAlertTitle'),
                message: item.message || t('notifications.farmAlertMessage'),
                createdAt: Date.now(),
                notifyDevice: true,
              })
            }

            knownAlertIdsRef.current.add(id)
          })
        } catch {
          // silently ignore polling failures
        }
      }

      await pollAlerts(false)
      alertInterval = window.setInterval(() => {
        pollAlerts(true)
      }, 30000)

      const postsRef = dbRef(database, 'posts')
      let initialized = false

      stopPostsListener = onValue(postsRef, (snapshot) => {
        const data = snapshot.val()
        const nextPostIds = new Set(Object.keys(data || {}))

        if (!initialized) {
          knownPostIdsRef.current = nextPostIds
          initialized = true
          return
        }

        Object.entries(data || {}).forEach(([id, post]) => {
          if (knownPostIdsRef.current.has(id)) {
            return
          }

          const postType = String(post?.type || 'sale').toLowerCase()
          const postTitle = postType === 'disease' ? post?.question : post?.title

          pushNotification({
            referenceId: `env-post-${id}`,
            source: 'environment',
            type: 'community',
            priority: postType === 'disease' ? 'high' : 'medium',
            title:
              postType === 'disease'
                ? t('notifications.newDiseasePostTitle')
                : t('notifications.newSalePostTitle'),
            message: postTitle || t('notifications.newEnvironmentPostMessage'),
            createdAt: Number(post?.createdAt) || Date.now(),
            notifyDevice: true,
          })
          nextPostIds.add(id)
        })

        knownPostIdsRef.current = nextPostIds
      })
    })

    return () => {
      stopAuthListener()
      if (alertInterval) {
        window.clearInterval(alertInterval)
      }
      if (stopPostsListener) {
        stopPostsListener()
      }
    }
  }, [t])

  return (
    <>
      <Navbar />
      <div data-assistant-scope>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/analyze" element={<Analyze />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="environment" replace />} />
            <Route path="soil" element={<SoilData />} />
            <Route path="npk" element={<NpkTrend />} />
            <Route path="weather" element={<Weather />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="fertilizer" element={<Fertilizer />} />
            <Route path="crop-analysis" element={<CropAnalysis />} />
            <Route path="environment" element={<Environment />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <NotificationHost />
      <AssistantWidget />
    </>
  )
}

export default App
