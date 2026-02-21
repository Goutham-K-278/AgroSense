import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://uzhavar-ai-1.onrender.com'

const AssistantWidget = () => {
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const [isOpen, setIsOpen] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [voiceLocale, setVoiceLocale] = useState(i18n.language === 'ta' ? 'ta' : 'en')
  const recognitionRef = useRef(null)
  const speechRef = useRef(null)

  const sanitizeSpeechText = (rawText = '') => {
    if (typeof rawText !== 'string') {
      return ''
    }
    return rawText
      .replace(/\*\*|__|`|~~/g, '')
      .replace(/[#>*_-]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  const stopSpeaking = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return
    }
    window.speechSynthesis.cancel()
    speechRef.current = null
    setIsSpeaking(false)
  }

  const pickVoice = (targetLocale) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return null
    }
    const voices = window.speechSynthesis.getVoices?.() || []
    if (targetLocale === 'ta') {
      return (
        voices.find((voice) => (voice.lang || '').toLowerCase().startsWith('ta')) ||
        voices.find((voice) => (voice.lang || '').toLowerCase().includes('in')) ||
        null
      )
    }

    return (
      voices.find((voice) => (voice.lang || '').toLowerCase().startsWith('en-in')) ||
      voices.find((voice) => (voice.lang || '').toLowerCase().startsWith('en')) ||
      null
    )
  }

  const speakOut = (text) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) {
      setIsSpeaking(false)
      return
    }
    const cleanedText = sanitizeSpeechText(text)
    if (!cleanedText) {
      setIsSpeaking(false)
      return
    }
    stopSpeaking()
    const utterance = new SpeechSynthesisUtterance(cleanedText)
    utterance.lang = voiceLocale === 'ta' ? 'ta-IN' : 'en-IN'
    const selectedVoice = pickVoice(voiceLocale)
    if (selectedVoice) {
      utterance.voice = selectedVoice
      utterance.lang = selectedVoice.lang || utterance.lang
    }
    utterance.onend = () => {
      setIsSpeaking(false)
      speechRef.current = null
    }
    utterance.onerror = () => {
      setIsSpeaking(false)
      speechRef.current = null
    }
    speechRef.current = utterance
    window.speechSynthesis.speak(utterance)
    setIsSpeaking(true)
  }

  const ensureRecognition = () => {
    if (typeof window === 'undefined') {
      return null
    }
    if (recognitionRef.current) {
      recognitionRef.current.lang = voiceLocale === 'ta' ? 'ta-IN' : 'en-IN'
      return recognitionRef.current
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setError(t('assistantError'))
      return null
    }
    const recognition = new SpeechRecognition()
    recognition.lang = voiceLocale === 'ta' ? 'ta-IN' : 'en-IN'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript
      if (transcript) {
        setInput(transcript)
      }
    }
    recognition.onerror = () => {
      setError(t('assistantError'))
      setIsListening(false)
    }
    recognition.onend = () => {
      setIsListening(false)
    }
    recognitionRef.current = recognition
    return recognition
  }

  const handleVoiceToggle = () => {
    const recognition = ensureRecognition()
    if (!recognition) {
      return
    }
    if (isListening) {
      recognition.stop()
      setIsListening(false)
      return
    }
    setError('')
    setIsListening(true)
    recognition.start()
  }

  const getPageName = (pathname) => {
    if (pathname.startsWith('/dashboard/soil')) return t('sidebar.menu.soil')
    if (pathname.startsWith('/dashboard/npk')) return t('sidebar.menu.npk')
    if (pathname.startsWith('/dashboard/weather')) return t('sidebar.menu.weather')
    if (pathname.startsWith('/dashboard/alerts')) return t('sidebar.menu.alerts')
    if (pathname.startsWith('/dashboard/fertilizer')) return t('sidebar.menu.fertilizer')
    if (pathname.startsWith('/dashboard/crop-analysis')) return t('sidebar.menu.cropAnalysis')
    if (pathname.startsWith('/dashboard/environment')) return t('sidebar.menu.environment')
    if (pathname.startsWith('/analyze')) return t('cropInput')
    if (pathname === '/') return t('sidebar.menu.home')
    return t('assistantTitle')
  }

  const collectPageSnapshot = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return ''
    }

    const root =
      document.querySelector('[data-assistant-scope]') ||
      document.querySelector('main') ||
      document.body
    const text = root?.innerText || ''
    return text.replace(/\s+/g, ' ').trim().slice(0, 3200)
  }

  const sendMessage = async () => {
    if (!input.trim()) {
      return
    }
    const text = input.trim()
    const locale = i18n.language === 'ta' ? 'ta' : 'en'
    const pageSummary =
      typeof window !== 'undefined' && window.__uzhavarPageSummary?.page
        ? window.__uzhavarPageSummary
        : null
    const pageContext = {
      page: getPageName(location.pathname),
      path: location.pathname,
      summary: pageSummary?.summary || '',
      snapshot: collectPageSnapshot(),
    }
    const history = messages.slice(-6).map((msg) => ({ role: msg.role, text: msg.text }))
    setMessages((prev) => [...prev, { role: 'user', text, locale }])
    setInput('')
    setIsSending(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, locale, pageContext, history }),
      })

      const data = await response.json().catch(() => null)

      if (!response.ok) {
        const serverMessage = data?.reply || data?.error || data?.details
        if (serverMessage) {
          setMessages((prev) => [...prev, { role: 'assistant', text: serverMessage, locale }])
        }
        setError(
          data?.error ||
            (data?.details ? `${t('assistantError')} (${data.details})` : '') ||
            `${t('assistantError')} ${
              response.status === 503 ? 'Start the backend server (npm start in /backend) and set GEMINI_API_KEY.' : ''
            }`.trim(),
        )
        return
      }

      const reply = data?.reply || t('assistantError')
      setMessages((prev) => [...prev, { role: 'assistant', text: reply, locale }])
      speakOut(reply)
    } catch (fetchError) {
      console.error(fetchError)
      setError(t('assistantError'))
    } finally {
      setIsSending(false)
    }
  }

  const speakLatestAssistant = () => {
    const lastAssistant = [...messages].reverse().find((msg) => msg.role === 'assistant')
    speakOut(lastAssistant?.text || t('assistantSubtitle'))
  }

  const handleStopClick = () => {
    stopSpeaking()
  }

  useEffect(() => {
    setVoiceLocale(i18n.language === 'ta' ? 'ta' : 'en')
  }, [i18n.language])

  useEffect(() => () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }
    stopSpeaking()
  }, [])

  return (
    <div className="fixed bottom-6 right-6 z-30 flex flex-col items-end gap-3">
      {isOpen && (
        <div className="w-80 rounded-2xl bg-white/95 p-4 shadow-2xl ring-1 ring-emerald-50">
          <div className="mb-3">
            <p className="text-sm font-semibold text-emerald-700">{t('assistantTitle')}</p>
            <p className="text-xs text-slate-500">{t('assistantSubtitle')}</p>
          </div>

          <div className="max-h-60 space-y-2 overflow-y-auto rounded-xl bg-emerald-50/50 p-2">
            {messages.length === 0 && (
              <p className="text-xs text-slate-500">{t('assistantPlaceholder')}</p>
            )}
            {messages.map((msg, index) => (
              <div
                key={`${msg.role}-${index}`}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow ${
                    msg.role === 'user'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white text-slate-800'
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            {isSending && (
              <div className="text-xs text-emerald-600">{t('assistantThinking')}</div>
            )}
          </div>

          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t('assistantPlaceholder')}
            className="mt-3 h-20 w-full rounded-xl border border-emerald-100 bg-white p-2 text-sm text-slate-700 focus:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-200"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={sendMessage}
              disabled={isSending}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-400"
            >
              {isSending ? t('assistantThinking') : t('assistantSend')}
            </button>
            <button
              type="button"
              onClick={handleVoiceToggle}
              className={`flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                isListening
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                  : 'border-emerald-100 text-emerald-700'
              }`}
            >
              🎙 {isListening ? t('assistantListening') : t('assistantVoice')}
            </button>
            <button
              type="button"
              onClick={speakLatestAssistant}
              className="rounded-xl border border-transparent px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
            >
              🔊 {t('assistantSpeak')}
            </button>
            <button
              type="button"
              onClick={handleStopClick}
              disabled={!isSpeaking}
              className="rounded-xl border border-transparent px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              ⏹ {t('assistantStopVoice')}
            </button>
            <button
              type="button"
              onClick={() => setMessages([])}
              className="text-xs font-medium text-emerald-600"
            >
              {t('assistantClear')}
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label="Open AI assistant"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-2xl text-white shadow-2xl transition hover:scale-105"
      >
        {isOpen ? '×' : '🤖'}
      </button>
    </div>
  )
}

export default AssistantWidget
