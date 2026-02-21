import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { auth, provider, db } from '../firebase'

function Navbar() {
  const [user, setUser] = useState(null)
  const [userLabel, setUserLabel] = useState('')
  const { t, i18n } = useTranslation()
  const [language, setLanguage] = useState(i18n.language)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
      setUser(authUser)

      if (!authUser) {
        setUserLabel('')
        return
      }

      try {
        const userRef = doc(db, 'users', authUser.uid)
        const profileSnap = await getDoc(userRef)
        const profileName = profileSnap.exists() ? profileSnap.data()?.name : ''
        setUserLabel(profileName || authUser.displayName || authUser.email || 'Logged in')
      } catch {
        setUserLabel(authUser.displayName || authUser.email || 'Logged in')
      }
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    const handleLanguageChange = (lng) => setLanguage(lng)
    i18n.on('languageChanged', handleLanguageChange)
    return () => {
      i18n.off('languageChanged', handleLanguageChange)
    }
  }, [i18n])

  const handleLogin = async () => {
    try {
      const result = await signInWithPopup(auth, provider)
      const userData = result.user

      const userRef = doc(db, 'users', userData.uid)
      const docSnap = await getDoc(userRef)

      if (!docSnap.exists()) {
        const phone = prompt('Enter your phone number:')
        const username = prompt('Enter your username:')

        await setDoc(userRef, {
          name: username || userData.displayName || '',
          email: userData.email,
          phone: phone,
          createdAt: serverTimestamp(),
        })
      }
    } catch (error) {
      console.error(error)
    }
  }

  const handleLogout = async () => {
    await signOut(auth)
  }

  const applyLanguage = (nextLanguage) => {
    i18n.changeLanguage(nextLanguage)
    setLanguage(nextLanguage)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('preferredLanguage', nextLanguage)
    }
  }

  const toggleLanguage = () => {
    applyLanguage(language === 'ta' ? 'en' : 'ta')
  }

  const LanguageToggle = () => (
    <button
      type="button"
      onClick={toggleLanguage}
      className="flex items-center gap-1 rounded-full border border-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
      aria-label={t('navbar.languageToggle', 'Toggle language')}
    >
      <span className={language === 'ta' ? 'font-bold text-emerald-700' : 'text-slate-500'}>தமிழ்</span>
      <span className="text-slate-400">/</span>
      <span className={language === 'en' ? 'font-bold text-emerald-700' : 'text-slate-500'}>English</span>
    </button>
  )

  return (
    <nav className="flex items-center justify-between p-4 shadow-md">
      <h1 className="text-xl font-bold">{t('navbar.brand', '🌾 AgroSense')}</h1>

      <div className="flex items-center gap-3">
        <LanguageToggle />
        {user ? (
          <>
            <span className="text-sm text-slate-700">{userLabel}</span>
            <button onClick={handleLogout} className="rounded bg-red-500 px-3 py-1 text-white">
              {t('navbar.logout')}
            </button>
          </>
        ) : (
          <button onClick={handleLogin} className="rounded bg-green-600 px-4 py-2 text-white">
            {t('navbar.login')}
          </button>
        )}
      </div>
    </nav>
  )
}

export default Navbar
