import { useEffect, useRef, useState } from 'react'
import './App.css'

const PERSONA_STORAGE_KEY = 'wikipedia-persona-history'
const DUO_HISTORY_STORAGE_KEY = 'wikipedia-duo-history'
const AUDIENCE_PROFILE_STORAGE_KEY = 'wikipedia-audience-profile'
const DEFAULT_DUO_PLAYBACK_MODE = 'preloaded'
const DEFAULT_VISUAL_THEME = {
  name: 'Signature Presence',
  motif: 'distinctive public persona atmosphere',
  description: 'A tailored editorial look inspired by the selected person.',
  primaryColor: '#214C74',
  secondaryColor: '#B25B3A',
  surfaceColor: '#FFF9F3',
  backgroundColor: '#F4E9DD',
}

const PERSONA_EXAMPLE_POOL = [
  'https://en.wikipedia.org/wiki/Albert_Einstein',
  'https://en.wikipedia.org/wiki/Taylor_Swift',
  'https://en.wikipedia.org/wiki/Leonardo_da_Vinci',
  'https://en.wikipedia.org/wiki/Marie_Curie',
  'https://en.wikipedia.org/wiki/Nikola_Tesla',
  'https://en.wikipedia.org/wiki/Ada_Lovelace',
  'https://en.wikipedia.org/wiki/William_Shakespeare',
  'https://en.wikipedia.org/wiki/Cleopatra',
  'https://en.wikipedia.org/wiki/Elon_Musk',
  'https://en.wikipedia.org/wiki/Michael_Jackson',
]

function readStoredHistory() {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const raw = window.localStorage.getItem(PERSONA_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readStoredDuoHistory() {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const raw = window.localStorage.getItem(DUO_HISTORY_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readStoredAudienceProfile() {
  if (typeof window === 'undefined') {
    return ''
  }

  try {
    const raw = window.localStorage.getItem(AUDIENCE_PROFILE_STORAGE_KEY)
    return raw === 'adult' || raw === 'pupil' ? raw : ''
  } catch {
    return ''
  }
}

function hexToRgb(hexColor) {
  const clean = String(hexColor || '').replace('#', '')

  if (!/^[\da-fA-F]{6}$/.test(clean)) {
    return { red: 33, green: 76, blue: 116 }
  }

  return {
    red: Number.parseInt(clean.slice(0, 2), 16),
    green: Number.parseInt(clean.slice(2, 4), 16),
    blue: Number.parseInt(clean.slice(4, 6), 16),
  }
}

function toRgba(hexColor, alpha) {
  const { red, green, blue } = hexToRgb(hexColor)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function pickRandomItems(items, count) {
  return [...items]
    .sort(() => Math.random() - 0.5)
    .slice(0, count)
}

function getOpeningTurnLabel(openingTurn) {
  return openingTurn === 'user' ? 'You write first' : 'Persona writes first'
}

function getColorLuminance(hexColor) {
  const { red, green, blue } = hexToRgb(hexColor)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function normalizeVisualTheme(persona) {
  const source = persona?.visualTheme && typeof persona.visualTheme === 'object'
    ? persona.visualTheme
    : {}

  return {
    name: source.name || DEFAULT_VISUAL_THEME.name,
    motif: source.motif || DEFAULT_VISUAL_THEME.motif,
    description: source.description || DEFAULT_VISUAL_THEME.description,
    primaryColor: source.primaryColor || DEFAULT_VISUAL_THEME.primaryColor,
    secondaryColor: source.secondaryColor || DEFAULT_VISUAL_THEME.secondaryColor,
    surfaceColor: source.surfaceColor || DEFAULT_VISUAL_THEME.surfaceColor,
    backgroundColor: source.backgroundColor || DEFAULT_VISUAL_THEME.backgroundColor,
  }
}

function buildAppTheme(visualTheme) {
  const primary = visualTheme.primaryColor
  const secondary = visualTheme.secondaryColor
  const surface = visualTheme.surfaceColor
  const background = visualTheme.backgroundColor
  const isDarkTheme = getColorLuminance(surface) < 120 || getColorLuminance(background) < 120

  return {
    fallbackBackground: `
      linear-gradient(135deg, ${background} 0%, ${surface} 100%)
    `,
    heroGlow: `
      linear-gradient(135deg, ${toRgba(secondary, 0.18)}, ${toRgba(primary, 0.1)})
    `,
    accent: primary,
    accentStrong: secondary,
    assistantBubble: toRgba(primary, 0.12),
    userBubble: toRgba(secondary, 0.16),
    activeBorder: toRgba(primary, 0.38),
    activeSurface: toRgba(primary, 0.08),
    placeholder: `linear-gradient(135deg, ${secondary}, ${primary})`,
    panel: toRgba(surface, 0.9),
    panelStrong: toRgba(surface, 0.96),
    border: toRgba(primary, 0.14),
    shadow: `0 24px 60px ${toRgba(primary, 0.14)}`,
    text: isDarkTheme ? '#EAF1F6' : '#4E463F',
    textStrong: isDarkTheme ? '#FFFFFF' : '#1C1815',
    muted: isDarkTheme ? 'rgba(234, 241, 246, 0.72)' : '#7D6F63',
  }
}

async function readApiResponse(response) {
  const rawText = await response.text()
  const contentType = response.headers.get('content-type') || ''
  const isJsonResponse = contentType.includes('application/json')

  if (!rawText.trim()) {
    if (response.ok) {
      throw new Error('The server returned an empty response.')
    }

    throw new Error('The server connection was interrupted before a response was completed.')
  }

  if (!isJsonResponse) {
    if (!response.ok) {
      throw new Error('The server returned an unexpected response. Please try again.')
    }

    throw new Error('The server returned a non-JSON response.')
  }

  try {
    return JSON.parse(rawText)
  } catch {
    throw new Error('The server returned invalid JSON. Please try again.')
  }
}

function isTransientRequestError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase()

  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('load failed') ||
    message.includes('network request failed') ||
    message.includes('connection was interrupted')
  )
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function fetchApiJson(url, init, options = {}) {
  const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : 3
  const retryDelayMs = Number.isInteger(options.retryDelayMs) ? options.retryDelayMs : 700
  let lastError = null

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const response = await fetch(url, init)
      const data = await readApiResponse(response)
      return { response, data }
    } catch (error) {
      lastError = error

      if (attempt === retryCount || !isTransientRequestError(error)) {
        throw error
      }

      await wait(retryDelayMs * (attempt + 1))
    }
  }

  throw lastError || new Error('The request could not be completed.')
}

function App() {
  const quickEmojis = [
    '😀', '😁', '😂', '🤣', '😊', '🙂', '😉', '😍', '😘', '😎',
    '🤔', '😴', '😭', '😡', '🥳', '😇', '🤩', '😅', '🙌', '👏',
    '🔥', '✨', '🎯', '💡', '📚', '❤️', '👍', '👀', '🎉', '🤝',
  ]
  const [personaExamples] = useState(() => pickRandomItems(PERSONA_EXAMPLE_POOL, 3))
  const duoExamples = [
    [
      'https://en.wikipedia.org/wiki/Cristiano_Ronaldo',
      'https://en.wikipedia.org/wiki/Lionel_Messi',
    ],
    [
      'https://en.wikipedia.org/wiki/Marie_Curie',
      'https://en.wikipedia.org/wiki/Albert_Einstein',
    ],
  ]
  const [activeMode, setActiveMode] = useState('persona')
  const [audienceProfile, setAudienceProfile] = useState(() => readStoredAudienceProfile())
  const [wikipediaUrl, setWikipediaUrl] = useState('')
  const [firstDuoWikipediaUrl, setFirstDuoWikipediaUrl] = useState('')
  const [secondDuoWikipediaUrl, setSecondDuoWikipediaUrl] = useState('')
  const [profile, setProfile] = useState(null)
  const [persona, setPersona] = useState(null)
  const [duoParticipants, setDuoParticipants] = useState([])
  const [duoConversation, setDuoConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [personaHistory, setPersonaHistory] = useState(() => readStoredHistory())
  const [duoHistory, setDuoHistory] = useState(() => readStoredDuoHistory())
  const [selectedLanguageCode, setSelectedLanguageCode] = useState('en')
  const [personaOpeningTurn, setPersonaOpeningTurn] = useState('assistant')
  const [conversationReady, setConversationReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [loadingPersona, setLoadingPersona] = useState(false)
  const [loadingDuoConversation, setLoadingDuoConversation] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [error, setError] = useState('')
  const chatScrollerRef = useRef(null)
  const composerTextareaRef = useRef(null)
  const emojiPickerRef = useRef(null)
  const visualTheme = normalizeVisualTheme(persona)
  const activeTheme = buildAppTheme(visualTheme)
  const isPersonaLinkStepActive = activeMode === 'persona' && !wikipediaUrl.trim()
  const isPersonaCreateStepActive =
    activeMode === 'persona' && !!wikipediaUrl.trim() && !loadingPersona && !persona
  const isStartConversationStepActive =
    activeMode === 'persona' && !!persona && !conversationReady && !sendingMessage
  const isComposeStepActive =
    activeMode === 'persona' && !!persona && conversationReady && !sendingMessage
  const isSendStepActive = isComposeStepActive && !!draft.trim()
  const isDuoFirstLinkStepActive =
    activeMode === 'duo' && !firstDuoWikipediaUrl.trim()
  const isDuoSecondLinkStepActive =
    activeMode === 'duo' && !!firstDuoWikipediaUrl.trim() && !secondDuoWikipediaUrl.trim()
  const isDuoCreateStepActive =
    activeMode === 'duo' &&
    !!firstDuoWikipediaUrl.trim() &&
    !!secondDuoWikipediaUrl.trim() &&
    !loadingDuoConversation &&
    !duoConversation
  const duoTranscript = Array.isArray(duoConversation?.transcript) ? duoConversation.transcript : []
  const duoMaxTurns = duoConversation?.maxTurns || 6
  const appThemeStyle = {
    '--app-background-fallback': activeTheme.fallbackBackground,
    '--app-background-image': persona?.backgroundImageUrl ? `url("${persona.backgroundImageUrl}")` : 'none',
    '--hero-glow': activeTheme.heroGlow,
    '--accent': activeTheme.accent,
    '--accent-strong': activeTheme.accentStrong,
    '--assistant-bubble': activeTheme.assistantBubble,
    '--user-bubble': activeTheme.userBubble,
    '--active-border': activeTheme.activeBorder,
    '--active-surface': activeTheme.activeSurface,
    '--placeholder-gradient': activeTheme.placeholder,
    '--panel': activeTheme.panel,
    '--panel-strong': activeTheme.panelStrong,
    '--border': activeTheme.border,
    '--shadow': activeTheme.shadow,
    '--text': activeTheme.text,
    '--text-h': activeTheme.textStrong,
    '--muted': activeTheme.muted,
  }

  useEffect(() => {
    if (chatScrollerRef.current) {
      chatScrollerRef.current.scrollTop = chatScrollerRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    function handlePointerDown(event) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target)) {
        setEmojiPickerOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(personaHistory))
  }, [personaHistory])

  useEffect(() => {
    window.localStorage.setItem(DUO_HISTORY_STORAGE_KEY, JSON.stringify(duoHistory))
  }, [duoHistory])

  useEffect(() => {
    if (!audienceProfile) {
      window.localStorage.removeItem(AUDIENCE_PROFILE_STORAGE_KEY)
      return
    }

    window.localStorage.setItem(AUDIENCE_PROFILE_STORAGE_KEY, audienceProfile)
  }, [audienceProfile])

  function resetActiveSession(nextAudienceProfile = '') {
    setAudienceProfile(nextAudienceProfile)
    setProfile(null)
    setPersona(null)
    setDuoParticipants([])
    setDuoConversation(null)
    setMessages([])
    setConversationReady(false)
    setDraft('')
    setError('')
    setSelectedLanguageCode('en')
    setPersonaOpeningTurn('assistant')
    setEmojiPickerOpen(false)
    setLoadingDuoTurn(false)
  }

  useEffect(() => {
    if (!profile || !persona || persona.backgroundImageUrl || loadingPersona) {
      return
    }

    let cancelled = false

    async function ensureBackgroundImage() {
      try {
        const { response, data } = await fetchApiJson('/api/background', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            profile,
            persona,
          }),
        })

        if (!response.ok || !data.backgroundImageUrl || cancelled) {
          return
        }

        setPersona((current) => {
          if (!current) {
            return current
          }

          return {
            ...current,
            visualTheme: data.visualTheme || current.visualTheme,
            backgroundImageUrl: data.backgroundImageUrl,
          }
        })

        setPersonaHistory((current) =>
          current.map((entry) =>
            entry.profile.fullUrl === profile.fullUrl
              ? {
                  ...entry,
                  persona: {
                    ...entry.persona,
                    visualTheme: data.visualTheme || entry.persona.visualTheme,
                    backgroundImageUrl: data.backgroundImageUrl,
                  },
                }
              : entry,
          ),
        )
      } catch {
        // Keep the UI usable even when background generation fails.
      }
    }

    ensureBackgroundImage()

    return () => {
      cancelled = true
    }
  }, [profile, persona, loadingPersona])

  useEffect(() => {
    document.body.style.background = activeTheme.fallbackBackground
    document.body.style.backgroundImage = 'none'

    return () => {
      document.body.style.background = ''
      document.body.style.backgroundImage = ''
    }
  }, [activeTheme])

  function savePersonaToHistory(nextProfile, nextPersona, openingMessage) {
    setPersonaHistory((current) => {
      const record = {
        id: nextProfile.fullUrl,
        savedAt: new Date().toISOString(),
        profile: nextProfile,
        persona: nextPersona,
        preview: openingMessage,
      }

      return [record, ...current.filter((item) => item.id !== record.id)].slice(0, 24)
    })
  }

  function loadPersonaFromHistory(entry) {
    setProfile(entry.profile)
    setPersona(entry.persona)
    setWikipediaUrl(entry.profile.fullUrl)
    setSelectedLanguageCode(entry.persona.defaultLanguageCode || 'en')
    setPersonaOpeningTurn('assistant')
    setConversationReady(false)
    setMessages([])
    setDraft('')
    setError('')
  }

  function clearPersonaHistory() {
    setPersonaHistory([])
  }

  function saveDuoToHistory(firstWikipediaUrlValue, secondWikipediaUrlValue, participants, conversation) {
    setDuoHistory((current) => {
      const pairId = [
        participants[0]?.profile?.fullUrl || firstWikipediaUrlValue,
        participants[1]?.profile?.fullUrl || secondWikipediaUrlValue,
      ]
        .sort()
        .join('::')

      const record = {
        id: pairId,
        savedAt: new Date().toISOString(),
        firstWikipediaUrl: firstWikipediaUrlValue,
        secondWikipediaUrl: secondWikipediaUrlValue,
        participants,
        conversation,
      }

      return [record, ...current.filter((item) => item.id !== record.id)].slice(0, 24)
    })
  }

  function loadDuoFromHistory(entry) {
    setFirstDuoWikipediaUrl(entry.firstWikipediaUrl || entry.participants?.[0]?.profile?.fullUrl || '')
    setSecondDuoWikipediaUrl(entry.secondWikipediaUrl || entry.participants?.[1]?.profile?.fullUrl || '')
    setDuoParticipants(Array.isArray(entry.participants) ? entry.participants : [])
    setDuoConversation(
      entry.conversation
        ? {
            ...entry.conversation,
            mode: entry.conversation.mode || DEFAULT_DUO_PLAYBACK_MODE,
          }
        : null,
    )
    setError('')
  }

  function clearDuoHistory() {
    setDuoHistory([])
  }

  async function createPersona(event) {
    event.preventDefault()
    setLoadingPersona(true)
    setError('')

    try {
      const { response, data } = await fetchApiJson('/api/persona', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ wikipediaUrl, audienceProfile }),
      })

      if (!response.ok) {
        throw new Error(data.error || 'Unable to create persona.')
      }

      setProfile(data.profile)
      setPersona(data.persona)
      setSelectedLanguageCode(data.persona.defaultLanguageCode || 'en')
      setPersonaOpeningTurn('assistant')
      setConversationReady(false)
      setMessages([])
      savePersonaToHistory(data.profile, data.persona, data.persona.openingMessage)
      setDraft('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to create persona.')
    } finally {
      setLoadingPersona(false)
    }
  }

  async function createDuoConversation(event) {
    event.preventDefault()
    setLoadingDuoConversation(true)
    setError('')

    try {
      const { response, data } = await fetchApiJson('/api/duo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          firstWikipediaUrl: firstDuoWikipediaUrl,
          secondWikipediaUrl: secondDuoWikipediaUrl,
          audienceProfile,
        }),
      })

      if (!response.ok) {
        throw new Error(data.error || 'Unable to create the duo conversation.')
      }

      const nextParticipants = Array.isArray(data.participants) ? data.participants : []
      const nextConversation = data.conversation
        ? {
            ...data.conversation,
            mode: DEFAULT_DUO_PLAYBACK_MODE,
          }
        : null

      setDuoParticipants(nextParticipants)
      setDuoConversation(nextConversation)
      saveDuoToHistory(
        firstDuoWikipediaUrl,
        secondDuoWikipediaUrl,
        nextParticipants,
        nextConversation,
      )
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to create the duo conversation.',
      )
    } finally {
      setLoadingDuoConversation(false)
    }
  }

  async function startConversation() {
    if (!profile || !persona || !selectedLanguageCode || sendingMessage) {
      return
    }

    if (personaOpeningTurn === 'user') {
      setMessages([])
      setConversationReady(true)
      setError('')
      return
    }

    setSendingMessage(true)
    setError('')

    try {
      const { response, data } = await fetchApiJson('/api/opening', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          profile,
          persona,
          languageCode: selectedLanguageCode,
          audienceProfile,
        }),
      })

      if (!response.ok) {
        throw new Error(data.error || 'Unable to start the conversation.')
      }

      setMessages([{ role: 'assistant', content: data.openingMessage }])
      setConversationReady(true)
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Unable to start the conversation.',
      )
    } finally {
      setSendingMessage(false)
    }
  }

  async function sendMessage(messageText) {
    if (!profile || !persona || !conversationReady || !messageText.trim() || sendingMessage) {
      return
    }

    const userMessage = {
      role: 'user',
      content: messageText.trim(),
    }

    const previousMessages = messages
    const nextMessages = [...previousMessages, userMessage]
    setMessages(nextMessages)
    setDraft('')
    setSendingMessage(true)
    setError('')

    try {
      const { response, data } = await fetchApiJson('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          profile,
          persona,
          history: nextMessages,
          message: userMessage.content,
          languageCode: selectedLanguageCode,
          audienceProfile,
        }),
      })

      if (!response.ok) {
        throw new Error(data.error || 'Unable to continue the conversation.')
      }

      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: data.reply,
        },
      ])
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to continue the conversation.',
      )
    } finally {
      setSendingMessage(false)
    }
  }

  function insertEmoji(emoji) {
    const textarea = composerTextareaRef.current

    if (!textarea) {
      setDraft((current) => `${current}${emoji}`)
      return
    }

    const selectionStart = textarea.selectionStart ?? draft.length
    const selectionEnd = textarea.selectionEnd ?? draft.length
    const nextDraft =
      draft.slice(0, selectionStart) +
      emoji +
      draft.slice(selectionEnd)

    setDraft(nextDraft)

    requestAnimationFrame(() => {
      textarea.focus()
      const nextCursorPosition = selectionStart + emoji.length
      textarea.setSelectionRange(nextCursorPosition, nextCursorPosition)
    })
  }

  return (
    <main className="shell" style={appThemeStyle}>
      {!audienceProfile ? (
        <section className="audience-gate">
          <div className="audience-gate-card audience-gate-enter">
            <p className="eyebrow">Choose your version first</p>
            <h1>Pick who this WikiAI experience is for.</h1>
            <p className="lead">
              Adults keep the current balanced style. Pupils get a warmer tone with more explanation
              and more informative answers.
            </p>

            <div className="audience-options">
              <button
                type="button"
                className="audience-option"
                onClick={() => resetActiveSession('adult')}
              >
                <span className="card-label">Adult</span>
                <strong>Current version</strong>
                <span className="audience-option-copy">
                  Balanced conversational style for general users.
                </span>
              </button>

              <button
                type="button"
                className="audience-option"
                onClick={() => resetActiveSession('pupil')}
              >
                <span className="card-label">Pupil</span>
                <strong>Friendlier and more informative</strong>
                <span className="audience-option-copy">
                  Warmer explanations, more educational detail, easier tone.
                </span>
              </button>
            </div>
          </div>
        </section>
      ) : (
      <section className="workspace-layout app-enter">
        <aside className="sidebar-panel">
          <div className="mode-switcher" aria-label="Choose experience">
            <button
              type="button"
              className={activeMode === 'persona' ? 'is-active' : ''}
              onClick={() => setActiveMode('persona')}
            >
              Single persona
            </button>
            <button
              type="button"
              className={activeMode === 'duo' ? 'is-active' : ''}
              onClick={() => setActiveMode('duo')}
            >
              Two-person mode
            </button>
          </div>

          <div key={`sidebar-mode-${activeMode}`} className="mode-panel-enter">
            {activeMode === 'persona' ? (
              <div className="link-entry-card">
                <p className="card-label">Paste link</p>
                <h2>Start with one person</h2>
                <form className="persona-form compact-form" onSubmit={createPersona}>
                  <div className="field-group">
                    <label htmlFor="wikipediaUrl">Wikipedia URL</label>
                    <input
                      id="wikipediaUrl"
                      name="wikipediaUrl"
                      type="url"
                      className={isPersonaLinkStepActive ? 'guided-glow' : ''}
                      placeholder="https://en.wikipedia.org/wiki/Albert_Einstein"
                      value={wikipediaUrl}
                      onChange={(event) => setWikipediaUrl(event.target.value)}
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    className={isPersonaCreateStepActive ? 'guided-glow' : ''}
                    disabled={loadingPersona}
                  >
                    {loadingPersona ? 'Building persona...' : 'Create persona'}
                  </button>
                </form>

                <div className="example-row" aria-label="Example links">
                  {personaExamples.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="example-chip"
                      onClick={() => setWikipediaUrl(example)}
                    >
                      {example.replace('https://en.wikipedia.org/wiki/', '')}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="link-entry-card">
                <p className="card-label">Paste links</p>
                <h2>Start with two people</h2>
                <form className="duo-form compact-form" onSubmit={createDuoConversation}>
                  <div className="field-group">
                    <label htmlFor="firstDuoWikipediaUrl">First person</label>
                    <input
                      id="firstDuoWikipediaUrl"
                      type="url"
                      className={isDuoFirstLinkStepActive ? 'guided-glow' : ''}
                      placeholder="https://en.wikipedia.org/wiki/Cristiano_Ronaldo"
                      value={firstDuoWikipediaUrl}
                      onChange={(event) => setFirstDuoWikipediaUrl(event.target.value)}
                      required
                    />
                  </div>
                  <div className="field-group">
                    <label htmlFor="secondDuoWikipediaUrl">Second person</label>
                    <input
                      id="secondDuoWikipediaUrl"
                      type="url"
                      className={isDuoSecondLinkStepActive ? 'guided-glow' : ''}
                      placeholder="https://en.wikipedia.org/wiki/Lionel_Messi"
                      value={secondDuoWikipediaUrl}
                      onChange={(event) => setSecondDuoWikipediaUrl(event.target.value)}
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    className={isDuoCreateStepActive ? 'guided-glow' : ''}
                    disabled={loadingDuoConversation}
                  >
                    {loadingDuoConversation ? 'Preparing dialog...' : 'Start preloaded dialog'}
                  </button>
                </form>

                <div className="example-row" aria-label="Example duo links">
                  {duoExamples.map(([firstExample, secondExample]) => (
                    <button
                      key={`${firstExample}-${secondExample}`}
                      type="button"
                      className="example-chip"
                      onClick={() => {
                        setFirstDuoWikipediaUrl(firstExample)
                        setSecondDuoWikipediaUrl(secondExample)
                      }}
                    >
                      {firstExample.replace('https://en.wikipedia.org/wiki/', '')}
                      {' + '}
                      {secondExample.replace('https://en.wikipedia.org/wiki/', '')}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {error ? <p className="error-banner">{error}</p> : null}

          <div key={`sidebar-detail-${activeMode}`} className="mode-panel-enter">
            {activeMode === 'persona' ? (
              <div className="persona-card">
              <div className="history-head">
                <div>
                  <p className="card-label">Saved personas</p>
                  <h2>History</h2>
                </div>
                {personaHistory.length ? (
                  <button type="button" className="ghost-button" onClick={clearPersonaHistory}>
                    Clear
                  </button>
                ) : null}
              </div>

              {personaHistory.length ? (
                <div className="history-list">
                  {personaHistory.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`history-item ${
                        profile?.fullUrl === entry.profile.fullUrl ? 'active' : ''
                      }`}
                      onClick={() => loadPersonaFromHistory(entry)}
                    >
                      {entry.profile.imageUrl ? (
                        <img
                          src={entry.profile.imageUrl}
                          alt={entry.profile.title}
                          className="history-thumb"
                        />
                      ) : (
                        <div className="history-thumb placeholder">
                          {entry.profile.title.slice(0, 2)}
                        </div>
                      )}
                      <span className="history-copy">
                        <strong>{entry.persona.displayName || entry.profile.title}</strong>
                        <span>{entry.persona.tagline || entry.profile.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="history-empty">Created personas will appear here for quick reuse.</p>
              )}

              {persona && profile ? (
                <>
                  <div className="persona-header">
                    {profile.imageUrl ? (
                      <img src={profile.imageUrl} alt={profile.title} className="persona-image" />
                    ) : (
                      <div className="persona-image placeholder">{profile.title.slice(0, 2)}</div>
                    )}
                    <div>
                      <p className="card-label">Selected person</p>
                      <h2>{persona.displayName || profile.title}</h2>
                      <p className="persona-tagline">{persona.tagline}</p>
                    </div>
                  </div>

                  <div className="card-block">
                    <p className="card-label">Wikipedia source</p>
                    <a href={profile.fullUrl} target="_blank" rel="noreferrer">
                      {profile.title}
                    </a>
                    <p>{profile.description}</p>
                  </div>

                  <div className="card-block">
                    <p className="card-label">Info about person</p>
                    <p>{persona.groundingNote}</p>
                  </div>

                  <div className="card-block">
                    <p className="card-label">Voice style</p>
                    <ul>
                      {persona.voice?.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </>
              ) : (
                <div className="empty-card">
                  <p className="card-label">Info about person</p>
                  <h2>Pick a Wikipedia page.</h2>
                  <p>The selected person will appear here with their image, name, and grounding details.</p>
                </div>
              )}
              </div>
            ) : (
              <div className="duo-history-card">
                <div className="history-head">
                  <div>
                    <p className="card-label">Saved duo chats</p>
                    <h3>Duo history</h3>
                  </div>
                  {duoHistory.length ? (
                    <button type="button" className="ghost-button" onClick={clearDuoHistory}>
                      Clear
                    </button>
                  ) : null}
                </div>

                {duoHistory.length ? (
                  <div className="history-list duo-history-list">
                    {duoHistory.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={`history-item ${
                          duoConversation?.title === entry.conversation?.title ? 'active' : ''
                        }`}
                        onClick={() => loadDuoFromHistory(entry)}
                      >
                        <div className="duo-history-avatars">
                          {entry.participants?.slice(0, 2).map((participant) =>
                            participant.profile?.imageUrl ? (
                              <img
                                key={participant.profile.fullUrl}
                                src={participant.profile.imageUrl}
                                alt={participant.profile.title}
                                className="history-thumb duo-history-thumb"
                              />
                            ) : (
                              <div
                                key={participant.profile?.fullUrl || participant.persona?.displayName}
                                className="history-thumb placeholder duo-history-thumb"
                              >
                                {(participant.profile?.title || participant.persona?.displayName || '?').slice(0, 2)}
                              </div>
                            ),
                          )}
                        </div>
                        <span className="history-copy">
                          <strong>
                            {entry.participants?.map((participant) => participant.persona?.displayName || participant.profile?.title).join(' x ')}
                          </strong>
                          <span>Preloaded dialog</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="history-empty">Saved two-person dialogs will appear here for quick reuse.</p>
                )}
              </div>
            )}
          </div>
        </aside>

        <section className="main-stage">
          <div key={`mode-banner-${activeMode}`} className="mode-banner mode-panel-enter">
            <p className="card-label">The mode we chose</p>
            <h2>{activeMode === 'persona' ? 'Single persona' : 'Two-person mode'}</h2>
            <div className="mode-banner-tools">
              <span className="audience-badge">
                {audienceProfile === 'pupil' ? 'Pupil version' : 'Adult version'}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => resetActiveSession('')}
              >
                Change version
              </button>
            </div>
          </div>

          <div key={`main-mode-${activeMode}`} className="mode-panel-enter mode-main-content">
            {activeMode === 'persona' ? (
              <section className="chat-panel">
              <div className="chat-header">
                <div>
                  <p className="card-label">Conversation</p>
                  <h2>{persona ? `Chat with ${persona.displayName || profile?.title}` : 'Persona chat'}</h2>
                </div>
                <div className="chat-tools">
                  <p className="chat-status">
                    {persona
                      ? conversationReady
                        ? `${getOpeningTurnLabel(personaOpeningTurn)} · Grounded in Wikipedia biography`
                        : `${getOpeningTurnLabel(personaOpeningTurn)} · Choose a language before starting`
                      : 'Create a persona to begin'}
                  </p>
                  {persona ? (
                    <div className="starter-toggle" aria-label="Who writes first">
                      <span>Who writes first</span>
                      <div className="starter-toggle-options">
                        <button
                          type="button"
                          className={personaOpeningTurn === 'assistant' ? 'is-active' : ''}
                          onClick={() => setPersonaOpeningTurn('assistant')}
                          disabled={sendingMessage}
                        >
                          Persona
                        </button>
                        <button
                          type="button"
                          className={personaOpeningTurn === 'user' ? 'is-active' : ''}
                          onClick={() => setPersonaOpeningTurn('user')}
                          disabled={sendingMessage}
                        >
                          Me
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {persona?.supportedLanguages?.length ? (
                    <label className="language-picker">
                      <span>Language</span>
                      <select
                        className={isStartConversationStepActive ? 'guided-glow' : ''}
                        value={selectedLanguageCode}
                        onChange={(event) => setSelectedLanguageCode(event.target.value)}
                        disabled={sendingMessage}
                      >
                        {persona.supportedLanguages.map((item) => (
                          <option key={item.code} value={item.code}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {persona ? (
                    <button
                      type="button"
                      className={`start-chat-button ${isStartConversationStepActive ? 'guided-glow' : ''}`}
                      onClick={startConversation}
                    >
                      {conversationReady
                        ? 'Restart in selected language'
                        : personaOpeningTurn === 'user'
                          ? 'Start with me'
                          : 'Start with persona'}
                    </button>
                  ) : null}
                </div>
              </div>

              <div
                className={`chat-stream ${messages.length ? 'has-messages' : 'is-empty'}`}
                ref={chatScrollerRef}
              >
                {messages.length ? (
                  messages.map((message, index) => (
                    <article
                      key={`${message.role}-${index}`}
                      className={`message ${message.role === 'assistant' ? 'assistant' : 'user'}`}
                    >
                      <p className="message-role">
                        {message.role === 'assistant'
                          ? persona?.displayName || 'Persona'
                          : 'Me'}
                      </p>
                      <p>{message.content}</p>
                    </article>
                  ))
                ) : (
                  <div className="empty-chat">
                    <div className="empty-chat-copy">
                      <p className="card-label">Ready when you are</p>
                      <p>
                        {persona
                          ? personaOpeningTurn === 'user'
                            ? 'Pick a language, choose Start with me, and send the first message yourself.'
                            : 'Pick a language and let the persona open the conversation.'
                          : 'Paste a Wikipedia link on the left to generate the persona and unlock the chat.'}
                      </p>
                      <span>Questions about work, beliefs, habits, goals, and advice usually work best.</span>
                    </div>
                  </div>
                )}
              </div>

              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault()
                  sendMessage(draft)
                }}
              >
                <div className="composer-input-wrap">
                  <textarea
                    rows="2"
                    ref={composerTextareaRef}
                    className={isComposeStepActive ? 'guided-glow' : ''}
                    placeholder="Message bar"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={!persona || !conversationReady || sendingMessage}
                  />

                  <div className="emoji-picker-shell" ref={emojiPickerRef}>
                    <button
                      type="button"
                      className={`emoji-trigger ${emojiPickerOpen ? 'is-open' : ''}`}
                      onClick={() => setEmojiPickerOpen((current) => !current)}
                      aria-label="Open emoji picker"
                      aria-expanded={emojiPickerOpen}
                      disabled={!persona || !conversationReady || sendingMessage}
                    >
                      😊
                    </button>

                    <div className={`emoji-panel ${emojiPickerOpen ? 'is-open' : ''}`}>
                      {quickEmojis.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          className="emoji-option"
                          onClick={() => insertEmoji(emoji)}
                        >
                          <span className="emoji-glyph">{emoji}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <button
                  type="submit"
                  className={isSendStepActive ? 'guided-glow' : ''}
                  disabled={!persona || !conversationReady || sendingMessage || !draft.trim()}
                >
                  {sendingMessage ? 'Thinking...' : 'Send'}
                </button>
              </form>
              </section>
            ) : duoConversation ? (
              <div className="duo-results">
                <div className="duo-participants">
                  {duoParticipants.map((participant) => (
                    <article key={participant.profile.fullUrl} className="duo-person-card">
                      {participant.profile.imageUrl ? (
                        <img
                          src={participant.profile.imageUrl}
                          alt={participant.profile.title}
                          className="duo-person-image"
                        />
                      ) : (
                        <div className="duo-person-image placeholder">
                          {participant.profile.title.slice(0, 2)}
                        </div>
                      )}
                      <div>
                        <p className="card-label">Participant</p>
                        <h3>{participant.persona.displayName || participant.profile.title}</h3>
                        <p>{participant.persona.tagline || participant.profile.description}</p>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="duo-transcript-card">
                  <p className="card-label">Conversation</p>
                  <h3>{duoConversation.title}</h3>
                  <p className="duo-setup">{duoConversation.setup}</p>
                  <div className="duo-toolbar">
                    <span className="duo-mode-badge">Preloaded dialog mode</span>
                    <span className="duo-turn-count">
                      {duoTranscript.length} turns ready
                      {duoMaxTurns ? ` of ${duoMaxTurns}` : ''}
                    </span>
                  </div>

                  <div className="duo-transcript">
                    {duoConversation.transcript?.map((turn, index) => (
                      <article
                        key={`${turn.speakerCode}-${index}`}
                        className={`duo-turn ${turn.speakerCode === 'A' ? 'speaker-a' : 'speaker-b'}`}
                      >
                        <p className="message-role">{turn.speakerName}</p>
                        <p>{turn.content}</p>
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="duo-empty-state">
                <p className="card-label">Two-person mode</p>
                <h2>Choose two links on the left.</h2>
                <p>Start the duo here and a full preloaded dialog will open between both people.</p>
              </div>
            )}
          </div>
        </section>
      </section>
      )}
    </main>
  )
}

export default App
