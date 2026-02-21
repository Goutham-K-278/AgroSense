import { useEffect, useMemo, useRef, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { onValue, push, ref as dbRef, remove, set } from 'firebase/database'
import { useTranslation } from 'react-i18next'
import { auth, db, database } from '../firebase'

const cropTypes = ['Paddy', 'Groundnut', 'Sugarcane', 'Banana', 'Cotton', 'Vegetables']
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
const REQUEST_TIMEOUT_MS = 25000
const CLOUDINARY_CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || 'dzmxkwesn'
const CLOUDINARY_UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || 'AgroSence'
const MAX_MEDIA_SIZE_BYTES = 20 * 1024 * 1024
const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
])

const timeoutError = () => {
  const error = new Error('Request timed out')
  error.code = 'TIMEOUT'
  return error
}

const withTimeout = (promise, timeoutMs = REQUEST_TIMEOUT_MS) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(timeoutError()), timeoutMs)
    }),
  ])

const typeMeta = {
  sale: {
    badgeClass: 'bg-emerald-100 text-emerald-800',
    icon: '🟢',
    labelKey: 'environment.tags.sale',
  },
  disease: {
    badgeClass: 'bg-rose-100 text-rose-800',
    icon: '🔴',
    labelKey: 'environment.tags.disease',
  },
}

const formatTimeAgo = (timestamp) => {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) {
    return ''
  }

  const diffMs = Date.now() - value
  if (diffMs < 60000) {
    return ''
  }

  const diffMinutes = Math.floor(diffMs / 60000)
  if (diffMinutes < 60) {
    return `${diffMinutes}m`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}h`
  }

  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d`
}

function Environment() {
  const { t, i18n } = useTranslation()
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [posts, setPosts] = useState([])
  const [commentInputs, setCommentInputs] = useState({})
  const [commentSubmitting, setCommentSubmitting] = useState(new Set())
  const [postType, setPostType] = useState('sale')
  const [form, setForm] = useState({
    title: '',
    price: '',
    description: '',
    question: '',
    cropType: '',
    phone: '',
  })
  const [imageFile, setImageFile] = useState(null)
  const [isPosting, setIsPosting] = useState(false)
  const [errorKey, setErrorKey] = useState('')
  const [feedbackKey, setFeedbackKey] = useState('')
  const [deletingPostId, setDeletingPostId] = useState('')
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const fileInputRef = useRef(null)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (authUser) => {
      setUser(authUser)
    })
    return () => unsubscribe()
  }, [])

  useEffect(() => {
    if (!user) {
      setProfile(null)
      return
    }

    const fetchProfile = async () => {
      try {
        const snap = await getDoc(doc(db, 'users', user.uid))
        if (snap.exists()) {
          const data = snap.data()
          setProfile(data)
          setForm((prev) => ({ ...prev, phone: data.phone || prev.phone }))
        }
      } catch {
        // ignore optional profile failures
      }
    }

    fetchProfile()
  }, [user])

  useEffect(() => {
    const postsRef = dbRef(database, 'posts')
    const unsubscribe = onValue(
      postsRef,
      (snapshot) => {
        const data = snapshot.val()
        if (!data) {
          setPosts([])
          return
        }

        const nextPosts = Object.entries(data)
          .map(([id, value]) => {
            const commentEntries = Object.entries(value.comments || {})
            const comments = commentEntries
              .map(([commentId, commentValue]) => ({
                id: commentId,
                text: commentValue?.text || '',
                createdAt: Number(commentValue?.createdAt) || 0,
                createdBy: commentValue?.createdBy || '',
                createdByName: commentValue?.createdByName || t('environment.identity.farmer'),
              }))
              .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))

            return { id, ...value, comments }
          })
          .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))

        setPosts(nextPosts)
      },
      () => {
        setPosts([])
        setErrorKey('environment.errors.loadFailed')
      },
    )

    return () => unsubscribe()
  }, [])

  const identityLabel = useMemo(() => {
    if (!user) {
      return t('environment.identity.guest')
    }
    return profile?.name || user.displayName || user.email || t('environment.identity.farmer')
  }, [profile, t, user])

  const updateForm = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const resetForm = () => {
    setForm({
      title: '',
      price: '',
      description: '',
      question: '',
      cropType: '',
      phone: profile?.phone || '',
    })
    setImageFile(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    setUploadProgress(0)
  }

  const sendPushBroadcast = async ({ title, message, priority = 'medium' }) => {
    if (!user) {
      return
    }

    try {
      const token = await user.getIdToken()
      await fetch(`${API_BASE_URL}/api/push/notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title,
          message,
          tag: 'environment',
          source: 'environment',
          url: '/dashboard/environment',
          priority,
        }),
      })
    } catch (error) {
      console.error('Environment push send failed:', error)
    }
  }

  const updateCommentInput = (postId, value) => {
    setCommentInputs((prev) => ({ ...prev, [postId]: value }))
  }

  const handleAddComment = async (post) => {
    if (!user) {
      setErrorKey('environment.errors.loginComment')
      setFeedbackKey('')
      return
    }

    const text = (commentInputs[post.id] || '').trim()
    if (!text) {
      return
    }

    setErrorKey('')
    setFeedbackKey('')
    setCommentSubmitting((prev) => {
      const next = new Set(prev)
      next.add(post.id)
      return next
    })

    const commenterName = profile?.name || user.displayName || user.email || t('environment.identity.farmer')

    try {
      const commentsRef = dbRef(database, `posts/${post.id}/comments`)
      await push(commentsRef, {
        text,
        createdAt: Date.now(),
        createdBy: user.uid,
        createdByName: commenterName,
      })
      updateCommentInput(post.id, '')
      await sendPushBroadcast({
        title: t('environment.labels.comments'),
        message: text,
        priority: 'medium',
      })
    } catch {
      setErrorKey('environment.errors.editFailed')
    } finally {
      setCommentSubmitting((prev) => {
        const next = new Set(prev)
        next.delete(post.id)
        return next
      })
    }
  }

  const uploadImageIfAny = async () => {
    if (!imageFile || !user) {
      return { mediaUrl: '', mediaType: '', warningKey: '' }
    }

    if (imageFile.size > MAX_MEDIA_SIZE_BYTES) {
      return { mediaUrl: '', mediaType: '', warningKey: 'environment.errors.imageTooLarge' }
    }

    if (!ALLOWED_MEDIA_TYPES.has(imageFile.type)) {
      return { mediaUrl: '', mediaType: '', warningKey: 'environment.errors.invalidMediaType' }
    }

    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
      return { mediaUrl: '', mediaType: '', warningKey: 'environment.errors.cloudinaryMissing' }
    }

    setIsUploadingImage(true)
    setUploadProgress(0)

    try {
      const resourceType = imageFile.type.startsWith('video/') ? 'video' : 'image'
      const formData = new FormData()
      formData.append('file', imageFile)
      formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET)
      formData.append('folder', 'uzhavar/posts')

      const result = await withTimeout(
        new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`)

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && event.total > 0) {
              const percent = Math.round((event.loaded / event.total) * 100)
              setUploadProgress(Math.min(99, percent))
            }
          }

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const parsed = JSON.parse(xhr.responseText)
                setUploadProgress(100)
                resolve(parsed)
              } catch {
                reject(new Error('Invalid upload response'))
              }
              return
            }

            reject(new Error('Cloudinary upload failed'))
          }

          xhr.onerror = () => reject(new Error('Upload network error'))
          xhr.onabort = () => reject(new Error('Upload aborted'))
          xhr.send(formData)
        }),
        120000,
      )

      return {
        mediaUrl: result.secure_url || '',
        mediaType: result.resource_type || resourceType,
        warningKey: '',
      }
    } catch (error) {
      if (error?.code === 'TIMEOUT') {
        return { mediaUrl: '', mediaType: '', warningKey: 'environment.errors.imageUploadTimedOut' }
      }
      return { mediaUrl: '', mediaType: '', warningKey: 'environment.errors.imageUploadFailed' }
    } finally {
      setIsUploadingImage(false)
    }
  }

  const handleCreatePost = async () => {
    if (!user) {
      setErrorKey('environment.errors.loginCreate')
      setFeedbackKey('')
      return
    }

    setErrorKey('')
    setFeedbackKey('')

    if (postType === 'sale' && (!form.title || !form.price || !form.description || !form.phone)) {
      setErrorKey('environment.errors.saleRequired')
      return
    }

    if (postType === 'disease' && (!form.question || !form.cropType || !form.phone)) {
      setErrorKey('environment.errors.diseaseRequired')
      return
    }

    setIsPosting(true)

    try {
      const pushPayload = {
        title: postType === 'disease' ? t('environment.tags.disease') : t('environment.tags.sale'),
        message:
          postType === 'disease'
            ? form.question || t('environment.layout.formSubtitle')
            : form.title || t('environment.layout.formSubtitle'),
        priority: postType === 'disease' ? 'high' : 'medium',
      }

      const { mediaUrl, mediaType, warningKey } = await uploadImageIfAny()
      const postsRef = dbRef(database, 'posts')
      const newPostRef = push(postsRef)
      const createdByName = profile?.name || user.displayName || user.email || 'Farmer'
      const normalizedPrice = postType === 'sale' ? form.price : ''

      await withTimeout(
        set(newPostRef, {
        type: postType,
        title: postType === 'sale' ? form.title.trim() : '',
        description: postType === 'sale' ? form.description.trim() : '',
        price: postType === 'sale' ? normalizedPrice : '',
        question: postType === 'disease' ? form.question.trim() : '',
        cropType: postType === 'disease' ? form.cropType : '',
        phone: form.phone.trim(),
        imageUrl: mediaType === 'image' ? mediaUrl : '',
        mediaUrl,
        mediaType,
        createdBy: user.uid,
        createdByName,
        createdAt: Date.now(),
        status: 'active',
        }),
      )

      resetForm()
      if (warningKey) {
        setFeedbackKey(warningKey)
      }
      await sendPushBroadcast(pushPayload)
    } catch {
      setErrorKey('environment.errors.createFailed')
      setFeedbackKey('')
    } finally {
      setIsPosting(false)
    }
  }

  const handleDeletePost = async (post) => {
    if (!user || post.createdBy !== user.uid) {
      setErrorKey('environment.errors.ownerDelete')
      return
    }

    const shouldDelete = window.confirm(t('environment.errors.deleteConfirm'))
    if (!shouldDelete) {
      return
    }

    setErrorKey('')
    setDeletingPostId(post.id)

    try {
      await remove(dbRef(database, `posts/${post.id}`))
    } catch {
      setErrorKey('environment.errors.deleteFailed')
    } finally {
      setDeletingPostId('')
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return

    const latestPost = posts[0]
    const latestType = latestPost?.type ? t(`environment.tags.${latestPost.type}`, latestPost.type) : ''
    const latestText = latestPost
      ? (latestPost.type === 'disease' ? latestPost.question : latestPost.title || latestPost.description)
      : ''

    const summary =
      t('environment.layout.feedTitle') +
      ` - ${i18n.language === 'ta' ? 'மொத்த பதிவுகள்' : 'Total posts'}: ${posts.length}. ` +
      (latestPost
        ? `${i18n.language === 'ta' ? 'சமீபத்திய பதிவு' : 'Latest post'}: ${latestType}. ${latestText || '-'}`
        : i18n.language === 'ta'
          ? 'பதிவுகள் இல்லை.'
          : 'No posts yet.')

    window.__uzhavarPageSummary = {
      page: 'environment',
      summary,
      timestamp: Date.now(),
    }
  }, [i18n.language, posts, t])

  return (
    <section>
      <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
        <h1 className="text-3xl font-bold text-emerald-700">🌍 {t('environment.title')}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {t('environment.loggedInAs')}{' '}
          <span className="font-semibold text-slate-800">{identityLabel}</span>
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
          <h2 className="text-xl font-semibold text-slate-900">{t('environment.layout.formTitle')}</h2>
          <p className="mt-1 text-sm text-slate-600">{t('environment.layout.formSubtitle')}</p>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setPostType('sale')}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                postType === 'sale' ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700'
              }`}
            >
              {t('environment.tabs.sale')}
            </button>
            <button
              type="button"
              onClick={() => setPostType('disease')}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                postType === 'disease' ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700'
              }`}
            >
              {t('environment.tabs.disease')}
            </button>
          </div>

          <div className="mt-4 grid gap-3">
            {postType === 'sale' ? (
              <>
                <input
                  type="text"
                  placeholder={t('environment.placeholders.cropTitle')}
                  value={form.title}
                  onChange={(event) => updateForm('title', event.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="number"
                  placeholder={t('environment.placeholders.price')}
                  value={form.price}
                  onChange={(event) => updateForm('price', event.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <textarea
                  placeholder={t('environment.placeholders.description')}
                  value={form.description}
                  onChange={(event) => updateForm('description', event.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
              </>
            ) : (
              <>
                <select
                  value={form.cropType}
                  onChange={(event) => updateForm('cropType', event.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="">{t('environment.placeholders.cropType')}</option>
                  {cropTypes.map((crop) => (
                    <option key={crop} value={crop}>
                      {t(`environment.cropNames.${crop}`)}
                    </option>
                  ))}
                </select>
                <textarea
                  placeholder={t('environment.placeholders.diseaseQuestion')}
                  value={form.question}
                  onChange={(event) => updateForm('question', event.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
              </>
            )}

            <input
              type="text"
              placeholder={t('environment.placeholders.phone')}
              value={form.phone}
              onChange={(event) => updateForm('phone', event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2"
            />

            <div className="rounded-lg border border-slate-300 bg-white px-3 py-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp,video/mp4,video/quicktime"
                onChange={(event) => setImageFile(event.target.files?.[0] || null)}
                className="hidden"
              />

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={isPosting}
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {imageFile ? t('environment.buttons.changeFile') : t('environment.buttons.chooseFile')}
                </button>

                <span className="text-xs text-slate-500">{t('environment.labels.fileLimit')}</span>

                <p className="min-w-0 flex-1 truncate text-sm text-slate-600">
                  {imageFile ? imageFile.name : t('environment.labels.noFileChosen')}
                </p>

                {imageFile ? (
                  <button
                    type="button"
                    disabled={isPosting}
                    onClick={() => {
                      setImageFile(null)
                      if (fileInputRef.current) {
                        fileInputRef.current.value = ''
                      }
                    }}
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('environment.buttons.removeFile')}
                  </button>
                ) : null}
              </div>

              {isUploadingImage ? (
                <div className="mt-2 flex items-center gap-2 text-xs text-emerald-700">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" />
                  <span>
                    {t('environment.buttons.posting')}
                    {uploadProgress > 0 ? ` (${uploadProgress}%)` : ''}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {errorKey ? <p className="mt-3 text-sm text-red-600">{t(errorKey)}</p> : null}
          {feedbackKey ? <p className="mt-2 text-sm text-amber-600">{t(feedbackKey)}</p> : null}

          <button
            type="button"
            onClick={handleCreatePost}
            disabled={isPosting}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-70"
          >
            {isPosting ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span>{t('environment.buttons.posting')}</span>
              </>
            ) : (
              t('environment.buttons.publish')
            )}
          </button>
        </div>

        <div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
            <h2 className="text-xl font-semibold text-slate-900">{t('environment.layout.feedTitle')}</h2>
            <p className="mt-1 text-sm text-slate-600">{t('environment.layout.feedSubtitle')}</p>
          </div>

          <div className="mt-4 space-y-4">
            {posts.length === 0 ? (
              <p className="rounded-2xl bg-white p-5 text-sm text-slate-500 shadow-sm ring-1 ring-emerald-50">
                {t('environment.feed.empty')}
              </p>
            ) : (
              posts.map((post) => {
                const meta = typeMeta[post.type] || typeMeta.sale
                const relativeTime = formatTimeAgo(post.createdAt)
                const timeLabel = relativeTime
                  ? t('environment.feed.postedAgo', { time: relativeTime })
                  : t('environment.feed.justNow')
                const cropLabel = post.cropType
                  ? t(`environment.cropNames.${post.cropType}`, { defaultValue: post.cropType })
                  : ''
                const isOwner = user && post.createdBy === user.uid
                const mediaUrl = post.mediaUrl || post.imageUrl || ''
                const mediaType = post.mediaType || (post.imageUrl ? 'image' : '')
                const comments = Array.isArray(post.comments) ? post.comments : []
                const isCommenting = commentSubmitting.has(post.id)

                return (
                  <article key={post.id} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${meta.badgeClass}`}>
                        {meta.icon} {t(meta.labelKey)}
                      </span>
                      <p className="text-xs text-slate-500">{timeLabel}</p>
                    </div>

                    {mediaUrl && mediaType === 'video' ? (
                      <video
                        src={mediaUrl}
                        controls
                        className="mt-3 h-56 w-full rounded-xl object-cover"
                      />
                    ) : null}

                    {mediaUrl && mediaType !== 'video' ? (
                      <img
                        src={mediaUrl}
                        alt={post.title || post.question || 'Post'}
                        className="mt-3 h-56 w-full rounded-xl object-cover"
                      />
                    ) : null}

                    {post.type === 'sale' ? (
                      <div className="mt-3 space-y-1">
                        <h3 className="text-lg font-semibold text-slate-900">{post.title}</h3>
                        {post.price ? (
                          <p className="text-sm font-semibold text-emerald-700">₹ {post.price}</p>
                        ) : null}
                        <p className="text-sm text-slate-700">{post.description}</p>
                      </div>
                    ) : (
                      <div className="mt-3 space-y-1">
                        {cropLabel ? <p className="text-sm font-semibold text-emerald-700">{cropLabel}</p> : null}
                        <p className="text-sm text-slate-700">{post.question}</p>
                      </div>
                    )}

                    <p className="mt-3 text-xs text-slate-500">
                      {t('environment.feed.postedBy', {
                        name: post.createdByName || t('environment.identity.farmer'),
                      })}
                    </p>
                    <p className="text-xs text-slate-500">{t('environment.labels.phone', { value: post.phone })}</p>
                    <p className="text-xs text-slate-500">{t('environment.feed.statusActive')}</p>

                    {isOwner ? (
                      <button
                        type="button"
                        onClick={() => handleDeletePost(post)}
                        disabled={deletingPostId === post.id}
                        className="mt-3 rounded-full bg-red-100 px-4 py-1 text-xs font-semibold text-red-700 disabled:opacity-60"
                      >
                        {deletingPostId === post.id
                          ? t('environment.buttons.deleting')
                          : t('environment.buttons.delete')}
                      </button>
                    ) : null}

                    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-semibold text-slate-900">{t('environment.labels.comments')}</p>

                      {comments.length === 0 ? (
                        <p className="mt-2 text-xs text-slate-500">{t('environment.labels.noComments')}</p>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {comments.map((comment) => (
                            <div key={comment.id} className="rounded-lg bg-white px-3 py-2 shadow-sm ring-1 ring-slate-100">
                              <p className="text-xs font-semibold text-slate-800">{comment.createdByName || t('environment.identity.farmer')}</p>
                              <p className="text-sm text-slate-700">{comment.text}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                        <input
                          type="text"
                          value={commentInputs[post.id] || ''}
                          onChange={(event) => updateCommentInput(post.id, event.target.value)}
                          placeholder={t('environment.placeholders.comment')}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => handleAddComment(post)}
                          disabled={isCommenting}
                          className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
                        >
                          {isCommenting ? t('environment.buttons.saving') : t('environment.buttons.comment')}
                        </button>
                      </div>
                    </div>
                  </article>
                )
              })
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

export default Environment
