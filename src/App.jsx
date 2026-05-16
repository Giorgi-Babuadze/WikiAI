import { useEffect, useRef, useState } from 'react'
import './App.css'

const PERSONA_STORAGE_KEY = 'wikipedia-persona-history'

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

function App() {
  const [wikipediaUrl, setWikipediaUrl] = useState('')
  const [profile, setProfile] = useState(null)
  const [persona, setPersona] = useState(null)
  const [messages, setMessages] = useState([])
  const [personaHistory, setPersonaHistory] = useState(() => readStoredHistory())
  const [selectedLanguageCode, setSelectedLanguageCode] = useState('en')
  const [conversationReady, setConversationReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [loadingPersona, setLoadingPersona] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [error, setError] = useState('')
  const chatScrollerRef = useRef(null)

  useEffect(() => {
    if (chatScrollerRef.current) {
      chatScrollerRef.current.scrollTop = chatScrollerRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    window.localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(personaHistory))
  }, [personaHistory])

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

      const data = await response.json()

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

      const data = await response.json()

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

      const data = await response.json()

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
      setMessages(previousMessages)
    } finally {
      setSendingMessage(false)
    }
  }

  return (
    <main className="shell">
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

          <div className="chat-stream" ref={chatScrollerRef}>
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
