import 'dotenv/config'
import express from 'express'
import { GoogleGenAI } from '@google/genai'

const app = express()
const port = Number(process.env.PORT || 8787)
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

app.use(express.json({ limit: '1mb' }))

function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY environment variable.')
  }

  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
}

function parseWikipediaTitle(url) {
  let parsed

  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Enter a valid Wikipedia URL.')
  }

  const isWikipediaHost = parsed.hostname.endsWith('wikipedia.org')
  const pathMatch = parsed.pathname.match(/^\/wiki\/(.+)$/)

  if (!isWikipediaHost || !pathMatch) {
    throw new Error('Use a link in the format https://en.wikipedia.org/wiki/Person_Name')
  }

  return decodeURIComponent(pathMatch[1]).replace(/_/g, ' ')
}

async function fetchWikipediaProfile(title) {
  const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'))

  const [summaryResponse, extractResponse] = await Promise.all([
    fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`),
    fetch(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodedTitle}&format=json&origin=*`,
    ),
  ])

  if (!summaryResponse.ok || !extractResponse.ok) {
    throw new Error('Wikipedia did not return a usable page for that link.')
  }

  const summary = await summaryResponse.json()
  const extractJson = await extractResponse.json()
  const pages = extractJson?.query?.pages || {}
  const firstPage = Object.values(pages)[0]
  const extract = typeof firstPage?.extract === 'string' ? firstPage.extract : ''

  if (!summary?.title || (!summary?.extract && !extract)) {
    throw new Error('That Wikipedia page does not contain enough biography text yet.')
  }

  return {
    title: summary.title,
    description: summary.description || '',
    extract: summary.extract || extract,
    fullUrl: summary.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodedTitle}`,
    imageUrl: summary.thumbnail?.source || '',
  }
}

function personaPrompt(profile) {
  return `You are creating a roleplay-safe public-persona chat based only on the Wikipedia material below.

Return JSON with:
- displayName: string
- tagline: string
- voice: array of 4 short strings describing tone and communication habits
- talkingPoints: array of 4 short strings about the subjects this persona can speak about confidently
- supportedLanguages: array of objects with:
  - code: short BCP-47 style code like en, ka, fr
  - label: user-facing name like English, Georgian, French
  - reason: short reason grounded in the Wikipedia text
- defaultLanguageCode: string
- openingMessage: string
- groundingNote: string

Rules:
- Base every detail on the supplied Wikipedia summary.
- Do not invent private facts, scandals, opinions, or exact quotes not present in the source.
- The persona should feel conversational, recognizable, and emotionally present, as if speaking with the user right now.
- Do not frame the person as dead, historical, or unavailable unless the user explicitly asks about that.
- The opening message should sound like the person speaking warmly to the user in first person, in a live present-tense conversation.
- Always include English in supportedLanguages.
- If the page suggests the person is from Georgia or is described as Georgian, include Georgian with code ka.
- Include additional languages only when the page explicitly mentions them or strongly supports them.

Wikipedia title: ${profile.title}
Wikipedia description: ${profile.description}
Wikipedia extract:
${profile.extract}`
}

function detectGeorgianSupport(profile) {
  const text = `${profile.title}\n${profile.description}\n${profile.extract}`.toLowerCase()
  return /\bgeorgia\b|\bgeorgian\b/.test(text)
}

function normalizeSupportedLanguages(profile, persona) {
  const sourceLanguages = Array.isArray(persona.supportedLanguages) ? persona.supportedLanguages : []
  const normalized = []
  const seen = new Set()

  function pushLanguage(code, label, reason) {
    const safeCode = String(code || '').trim().toLowerCase()
    const safeLabel = String(label || '').trim()

    if (!safeCode || !safeLabel || seen.has(safeCode)) {
      return
    }

    seen.add(safeCode)
    normalized.push({
      code: safeCode,
      label: safeLabel,
      reason: String(reason || '').trim() || 'Inferred from the public Wikipedia biography.',
    })
  }

  pushLanguage('en', 'English', 'English is always available in the app.')

  for (const item of sourceLanguages) {
    if (item && typeof item === 'object') {
      pushLanguage(item.code, item.label, item.reason)
    }
  }

  if (detectGeorgianSupport(profile)) {
    pushLanguage('ka', 'Georgian', 'The Wikipedia page suggests the person is Georgian or from Georgia.')
  }

  return normalized.slice(0, 8)
}

function finalizePersona(profile, persona) {
  const supportedLanguages = normalizeSupportedLanguages(profile, persona)
  const availableCodes = new Set(supportedLanguages.map((item) => item.code))
  const defaultLanguageCode = availableCodes.has(persona.defaultLanguageCode)
    ? persona.defaultLanguageCode
    : 'en'

  return {
    ...persona,
    supportedLanguages,
    defaultLanguageCode,
  }
}

function chatPrompt(profile, persona, history, message, selectedLanguage) {
  const voice = Array.isArray(persona.voice) ? persona.voice : []
  const talkingPoints = Array.isArray(persona.talkingPoints) ? persona.talkingPoints : []
  const supportedLanguages = Array.isArray(persona.supportedLanguages) ? persona.supportedLanguages : []
  const activeLanguage =
    supportedLanguages.find((item) => item.code === selectedLanguage) ||
    supportedLanguages.find((item) => item.code === persona.defaultLanguageCode) ||
    supportedLanguages[0] || {
      code: 'en',
      label: 'English',
      reason: 'English fallback.',
    }
  const safeHistory = history
    .slice(-10)
    .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`)
    .join('\n')

  return `You are simulating a chat persona inspired by the public Wikipedia biography below.

Stay in first person as ${persona.displayName}, and talk like you are here with the user in a live conversation now.
Avoid phrases that frame you as deceased, historical, or distant unless the user explicitly asks about biography or timelines.
If the user asks for facts not supported by the biography, say you are relying on the provided Wikipedia information.
Do not claim private experiences or hidden details not supported by the source.
Keep responses conversational, natural, and under 140 words unless the user asks for more depth.
Reply in ${activeLanguage.label} (${activeLanguage.code}) unless the user clearly asks to switch to one of the other supported languages.

Supported languages:
${supportedLanguages.map((item) => `- ${item.label} (${item.code}): ${item.reason}`).join('\n')}

Persona voice:
${voice.map((item) => `- ${item}`).join('\n')}

Persona talking points:
${talkingPoints.map((item) => `- ${item}`).join('\n')}

Wikipedia title: ${profile.title}
Wikipedia description: ${profile.description}
Wikipedia extract:
${profile.extract}

Recent chat:
${safeHistory || 'No prior messages.'}

User: ${message}`
}

function openingPrompt(profile, persona, selectedLanguage) {
  const supportedLanguages = Array.isArray(persona.supportedLanguages) ? persona.supportedLanguages : []
  const activeLanguage =
    supportedLanguages.find((item) => item.code === selectedLanguage) ||
    supportedLanguages.find((item) => item.code === persona.defaultLanguageCode) ||
    supportedLanguages[0] || {
      code: 'en',
      label: 'English',
      reason: 'English fallback.',
    }

  return `You are simulating a chat persona inspired by the public Wikipedia biography below.

Stay in first person as ${persona.displayName}, and talk like you are here with the user in a live conversation now.
Avoid phrases that frame you as deceased, historical, or distant unless the user explicitly asks about biography or timelines.
Do not claim private experiences or hidden details not supported by the source.
Keep the opening warm, natural, and under 90 words.
Reply only in ${activeLanguage.label} (${activeLanguage.code}).

Persona voice:
${Array.isArray(persona.voice) ? persona.voice.map((item) => `- ${item}`).join('\n') : ''}

Wikipedia title: ${profile.title}
Wikipedia description: ${profile.description}
Wikipedia extract:
${profile.extract}

Write only the opening message for the start of the conversation.`
}

async function generateJson(prompt) {
  const client = getClient()
  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
    },
  })

  const text = response.text

  if (!text) {
    throw new Error('Gemini returned an empty response.')
  }

  return JSON.parse(text)
}

async function generateText(prompt) {
  const client = getClient()
  const response = await client.models.generateContent({
    model,
    contents: prompt,
  })

  if (!response.text) {
    throw new Error('Gemini returned an empty response.')
  }

  return response.text.trim()
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model })
})

app.post('/api/persona', async (req, res) => {
  try {
    const wikipediaUrl = req.body?.wikipediaUrl

    if (!wikipediaUrl) {
      return res.status(400).json({ error: 'Missing wikipediaUrl.' })
    }

    const title = parseWikipediaTitle(wikipediaUrl)
    const profile = await fetchWikipediaProfile(title)
    const rawPersona = await generateJson(personaPrompt(profile))
    const persona = finalizePersona(profile, rawPersona)

    res.json({
      profile,
      persona,
    })
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to build that persona right now.',
    })
  }
})

app.post('/api/chat', async (req, res) => {
  try {
    const { profile, persona, history, message, languageCode } = req.body ?? {}

    if (!profile || !persona || !message) {
      return res.status(400).json({ error: 'Missing profile, persona, or message.' })
    }

    const reply = await generateText(
      chatPrompt(profile, persona, Array.isArray(history) ? history : [], message, languageCode),
    )

    res.json({ reply })
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to generate a reply right now.',
    })
  }
})

app.post('/api/opening', async (req, res) => {
  try {
    const { profile, persona, languageCode } = req.body ?? {}

    if (!profile || !persona) {
      return res.status(400).json({ error: 'Missing profile or persona.' })
    }

    const openingMessage = await generateText(openingPrompt(profile, persona, languageCode))

    res.json({ openingMessage })
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to generate an opening message right now.',
    })
  }
})

app.listen(port, () => {
  console.log(`Persona server listening on http://localhost:${port}`)
})
