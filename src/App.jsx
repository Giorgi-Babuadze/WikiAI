import { useEffect, useRef, useState } from 'react'
import './App.css'

const PERSONA_STORAGE_KEY = 'wikipedia-persona-history'
const DUO_HISTORY_STORAGE_KEY = 'wikipedia-duo-history'
const DEFAULT_VISUAL_THEME = {
  name: 'Signature Presence',
  motif: 'distinctive public persona atmosphere',
  description: 'A tailored editorial look inspired by the selected person.',
  primaryColor: '#214C74',
  secondaryColor: '#B25B3A',
  surfaceColor: '#FFF9F3',
  backgroundColor: '#F4E9DD',
}

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

function App() {
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
  const [conversationReady, setConversationReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [loadingPersona, setLoadingPersona] = useState(false)
  const [loadingDuoConversation, setLoadingDuoConversation] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [error, setError] = useState('')
  const chatScrollerRef = useRef(null)
  const visualTheme = normalizeVisualTheme(persona)
  const activeTheme = buildAppTheme(visualTheme)
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
    window.localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(personaHistory))
  }, [personaHistory])

  useEffect(() => {
    window.localStorage.setItem(DUO_HISTORY_STORAGE_KEY, JSON.stringify(duoHistory))
  }, [duoHistory])

  useEffect(() => {
    if (!profile || !persona || persona.backgroundImageUrl || loadingPersona) {
      return
    }

    let cancelled = false

    async function ensureBackgroundImage() {
      try {
        const response = await fetch('/api/background', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            profile,
            persona,
          }),
        })

        const data = await readApiResponse(response)

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
    setDuoConversation(entry.conversation || null)
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
      const response = await fetch('/api/persona', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ wikipediaUrl }),
      })

      const data = await readApiResponse(response)

      if (!response.ok) {
        throw new Error(data.error || 'Unable to create persona.')
      }

      setProfile(data.profile)
      setPersona(data.persona)
      setSelectedLanguageCode(data.persona.defaultLanguageCode || 'en')
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
      const response = await fetch('/api/duo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          firstWikipediaUrl: firstDuoWikipediaUrl,
          secondWikipediaUrl: secondDuoWikipediaUrl,
        }),
      })

      const data = await readApiResponse(response)

      if (!response.ok) {
        throw new Error(data.error || 'Unable to create the duo conversation.')
      }

      const nextParticipants = Array.isArray(data.participants) ? data.participants : []
      const nextConversation = data.conversation || null

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

    setSendingMessage(true)
    setError('')

    try {
      const response = await fetch('/api/opening', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          profile,
          persona,
          languageCode: selectedLanguageCode,
        }),
      })

      const data = await readApiResponse(response)

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
      const response = await fetch('/api/chat', {
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
        }),
      })

      const data = await readApiResponse(response)

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

  return (
    <main className="shell" style={appThemeStyle}>
      <section className="hero-panel">
        <p className="eyebrow">Wikipedia Persona Chat</p>
        <h1>Paste a Wikipedia link and talk to a Gemini-powered character voice.</h1>
        <p className="lead">
          The app reads the public biography, builds a grounded conversation style, and lets
          the AI answer in first person while staying anchored to the page.
        </p>

        <form className="persona-form" onSubmit={createPersona}>
          <label htmlFor="wikipediaUrl" className="sr-only">
            Wikipedia URL
          </label>
          <input
            id="wikipediaUrl"
            name="wikipediaUrl"
            type="url"
            placeholder="https://en.wikipedia.org/wiki/Albert_Einstein"
            value={wikipediaUrl}
            onChange={(event) => setWikipediaUrl(event.target.value)}
            required
          />
          <button type="submit" disabled={loadingPersona}>
            {loadingPersona ? 'Building persona...' : 'Create persona'}
          </button>
        </form>

        <div className="hint-row">
          <span>Recommended Gemini model: `gemini-2.5-flash`</span>
          <span>Best for fast grounded roleplay from public biography text.</span>
        </div>

        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="duo-panel">
        <div className="duo-copy">
          <p className="eyebrow">Two-Person Mode</p>
          <h2>Paste two Wikipedia links and let the personas talk to each other.</h2>
          <p className="lead">
            This mode builds two grounded personas and generates a back-and-forth conversation
            without needing user messages.
          </p>
        </div>

        <form className="duo-form" onSubmit={createDuoConversation}>
          <input
            type="url"
            placeholder="https://en.wikipedia.org/wiki/Cristiano_Ronaldo"
            value={firstDuoWikipediaUrl}
            onChange={(event) => setFirstDuoWikipediaUrl(event.target.value)}
            required
          />
          <input
            type="url"
            placeholder="https://en.wikipedia.org/wiki/Lionel_Messi"
            value={secondDuoWikipediaUrl}
            onChange={(event) => setSecondDuoWikipediaUrl(event.target.value)}
            required
          />
          <button type="submit" disabled={loadingDuoConversation}>
            {loadingDuoConversation ? 'Making them talk...' : 'Make them talk'}
          </button>
        </form>

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
                    <span>{entry.conversation?.setup || 'Saved two-person conversation'}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="history-empty">Saved two-person conversations will appear here for quick reuse.</p>
          )}
        </div>

        {duoConversation ? (
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

              <div className="duo-transcript">
                {duoConversation.transcript?.map((turn, index) => (
                  <article
                    key={`${turn.speakerCode}-${index}`}
                    className={`duo-turn ${
                      turn.speakerCode === 'A' ? 'speaker-a' : 'speaker-b'
                    }`}
                  >
                    <p className="message-role">{turn.speakerName}</p>
                    <p>{turn.content}</p>
                  </article>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="workspace">
        <aside className="persona-card">
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
                  <p className="card-label">Persona</p>
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
                <p className="card-label">Visual theme</p>
                <p className="theme-name">{visualTheme.name}</p>
                <p className="theme-motif">{visualTheme.motif}</p>
                <p>{visualTheme.description}</p>
              </div>

              <div className="card-block">
                <p className="card-label">Voice style</p>
                <ul>
                  {persona.voice?.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="card-block">
                <p className="card-label">Grounding note</p>
                <p>{persona.groundingNote}</p>
              </div>

              <div className="card-block">
                <p className="card-label">Supported languages</p>
                <ul>
                  {persona.supportedLanguages?.map((item) => (
                    <li key={item.code}>
                      <strong>{item.label}</strong>: {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <div className="empty-card">
              <p className="card-label">How it works</p>
              <h2>Start with a public figure on Wikipedia.</h2>
              <p>
                The app reads the biography, extracts tone and talking points, then opens a
                first-person chat persona grounded in that source.
              </p>
            </div>
          )}
        </aside>

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
                    ? 'Grounded in Wikipedia biography'
                    : 'Choose a language before starting'
                  : 'Create a persona to begin'}
              </p>
              {persona?.supportedLanguages?.length ? (
                <label className="language-picker">
                  <span>Language</span>
                  <select
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
                <button type="button" className="start-chat-button" onClick={startConversation}>
                  {conversationReady ? 'Restart in selected language' : 'Start conversation'}
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
                      : 'You'}
                  </p>
                  <p>{message.content}</p>
                </article>
              ))
            ) : (
              <div className="empty-chat">
                <p>
                  {persona
                    ? 'Pick a language and press Start conversation.'
                    : 'Paste a Wikipedia link to generate the persona and unlock the chat.'}
                </p>
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
            <textarea
              rows="3"
              placeholder="Ask about their work, beliefs, routine, or advice..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={!persona || !conversationReady || sendingMessage}
            />
            <button
              type="submit"
              disabled={!persona || !conversationReady || sendingMessage || !draft.trim()}
            >
              {sendingMessage ? 'Thinking...' : 'Send'}
            </button>
          </form>
        </section>
      </section>
    </main>
  )
}

export default App
