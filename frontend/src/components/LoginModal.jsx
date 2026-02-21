import { useState } from 'react'
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
} from 'firebase/auth'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { auth, db, provider } from '../firebase'

function LoginModal({ open, onClose, onSuccess }) {
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    phone: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (!open) {
    return null
  }

  const updateForm = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const mapAuthError = (code) => {
    const messages = {
      'auth/operation-not-allowed': 'This sign-in method is disabled in Firebase Console. Enable it in Authentication > Sign-in method.',
      'auth/invalid-email': 'Invalid email format.',
      'auth/missing-password': 'Password is required.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/email-already-in-use': 'This email is already registered. Use the same password to sign in.',
      'auth/invalid-credential': 'Invalid email or password.',
      'auth/wrong-password': 'Wrong password for this account.',
      'auth/user-not-found': 'No account found for this email.',
      'auth/popup-closed-by-user': 'Google sign-in popup was closed before completing login.',
      'auth/popup-blocked': 'Popup was blocked by browser. Allow popups and try again.',
      'auth/cancelled-popup-request': 'Another popup request is already in progress.',
      'auth/unauthorized-domain': 'This domain is not authorized in Firebase. Add localhost in Authentication > Settings > Authorized domains.',
      'auth/network-request-failed': 'Network error. Check your internet connection and try again.',
    }

    return messages[code] || `Authentication failed (${code || 'unknown error'}).`
  }

  const saveUserProfile = async (user, username, phone) => {
    const userRef = doc(db, 'users', user.uid)
    const userSnap = await getDoc(userRef)

    if (!userSnap.exists()) {
      await setDoc(userRef, {
        name: username || user.displayName || '',
        email: user.email || '',
        phone: phone || '',
        createdAt: serverTimestamp(),
      })
      return
    }

    await setDoc(
      userRef,
      {
        name: username || userSnap.data()?.name || user.displayName || '',
        phone: phone || userSnap.data()?.phone || '',
      },
      { merge: true },
    )
  }

  const handleEmailLogin = async (event) => {
    event.preventDefault()
    setError('')

    const { username, email, password, phone } = form
    if (!username || !email || !password || !phone) {
      setError('Please enter username, email, password, and phone number.')
      return
    }

    setLoading(true)
    try {
      const created = await createUserWithEmailAndPassword(auth, email, password)
      await saveUserProfile(created.user, username, phone)
      onSuccess?.(created.user)
      onClose()
    } catch (createError) {
      if (createError.code === 'auth/email-already-in-use') {
        try {
          const signedIn = await signInWithEmailAndPassword(auth, email, password)
          await saveUserProfile(signedIn.user, username, phone)
          onSuccess?.(signedIn.user)
          onClose()
        } catch (signInError) {
          setError(mapAuthError(signInError.code))
        }
      } else {
        setError(mapAuthError(createError.code))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleSignIn = async () => {
    setError('')
    setLoading(true)
    try {
      const result = await signInWithPopup(auth, provider)
      const username = form.username || prompt('Enter your username:') || ''
      const phone = form.phone || prompt('Enter your phone number:') || ''
      await saveUserProfile(result.user, username, phone)
      onSuccess?.(result.user)
      onClose()
    } catch (googleError) {
      setError(mapAuthError(googleError.code))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-slate-800">Login</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleEmailLogin} className="space-y-3">
          <input
            type="text"
            placeholder="Username"
            value={form.username}
            onChange={(event) => updateForm('username', event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-700 outline-none focus:border-emerald-500"
          />
          <input
            type="email"
            placeholder="Email"
            value={form.email}
            onChange={(event) => updateForm('email', event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-700 outline-none focus:border-emerald-500"
          />
          <input
            type="password"
            placeholder="Password"
            minLength={6}
            value={form.password}
            onChange={(event) => updateForm('password', event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-700 outline-none focus:border-emerald-500"
          />
          <input
            type="tel"
            placeholder="Phone Number"
            value={form.phone}
            onChange={(event) => updateForm('phone', event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-700 outline-none focus:border-emerald-500"
          />

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loading ? 'Please wait...' : 'Login with Email'}
          </button>
        </form>

        <div className="my-4 text-center text-sm text-slate-500">or</div>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="w-full rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70"
        >
          Sign in with Google
        </button>
      </div>
    </div>
  )
}

export default LoginModal
