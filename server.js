import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import { GoogleGenAI } from '@google/genai'

const app = express()
const port = Number(process.env.PORT || 8787)
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview'
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503])
const MAX_MODEL_RETRIES = 3
const RETRY_DELAY_MS = 1200
const GENERATED_IMAGE_DIR = path.join(process.cwd(), 'public', 'generated')
const FALLBACK_IMAGE_DIR = path.join(process.cwd(), 'public', 'fallbacks')

app.use(express.json({ limit: '1mb' }))
app.use('/generated', express.static(GENERATED_IMAGE_DIR))
app.use('/fallbacks', express.static(FALLBACK_IMAGE_DIR))

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
- visualTheme: object with:
  - category: one of sports, politics, science, performance, business, general
  - name: short theme name
  - motif: short thematic phrase grounded in the biography, like football stadium energy, laboratory glow, courtroom authority, stage spotlight
  - description: one short sentence describing the visual direction
  - backgroundPrompt: one sentence prompt for a cinematic background image with no person visible
  - primaryColor: hex color like #0B556A
  - secondaryColor: hex color like #C55F3C
  - surfaceColor: hex color for cards and panels
  - backgroundColor: hex color for page background
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
- The visualTheme must be clearly inspired by the person's public domain or biography. Example: a footballer should feel athletic, stadium-like, and energetic rather than generic.
- Keep visualTheme grounded in profession, setting, or cultural context strongly supported by the Wikipedia text.
- category must match the strongest public domain, like sports for athletes and politics for politicians.
- backgroundPrompt must describe an atmospheric background scene only, not a portrait of the person.
- backgroundPrompt must avoid faces, people, readable text, logos, watermarks, and brand marks.
- Every color in visualTheme must be a 6-digit hex code.
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

function normalizeHexColor(value, fallback) {
  const candidate = String(value || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate.toUpperCase() : fallback
}

function inferThemeCategory(profile, persona = {}) {
  const sourceText = `${profile.title}\n${profile.description}\n${profile.extract}\n${persona.tagline || ''}\n${persona.motif || ''}`.toLowerCase()

  if (/\bfootball\b|\bsoccer\b|\bwinger\b|\bstriker\b|\bmidfielder\b|\bgoal\b|\bclub\b|\bathlete\b|\btennis\b|\bbasketball\b|\bolympic\b/.test(sourceText)) {
    return 'sports'
  }

  if (/\bpolitician\b|\bpresident\b|\bprime minister\b|\bminister\b|\bparliament\b|\bsenator\b|\bgovernor\b|\bgovernment\b|\bdiplomat\b/.test(sourceText)) {
    return 'politics'
  }

  if (/\bscientist\b|\bphysics\b|\bchemist\b|\blaboratory\b|\bresearch\b|\bmathematician\b|\bengineer\b/.test(sourceText)) {
    return 'science'
  }

  if (/\bsinger\b|\bmusician\b|\bactor\b|\bactress\b|\bperformer\b|\bstage\b|\bcomposer\b|\bdancer\b/.test(sourceText)) {
    return 'performance'
  }

  if (/\bentrepreneur\b|\bbusiness\b|\bceo\b|\bexecutive\b|\binvestor\b|\bcompany\b|\bfounder\b/.test(sourceText)) {
    return 'business'
  }

  return 'general'
}

function buildDefaultTheme(profile, persona) {
  const sourceText = `${profile.title}\n${profile.description}\n${profile.extract}\n${persona.tagline || ''}`.toLowerCase()
  const category = inferThemeCategory(profile, persona)

  if (/\bfootball\b|\bsoccer\b|\bforward\b|\bstriker\b|\bclub\b|\bgoal\b/.test(sourceText)) {
    return {
      category,
      name: 'Stadium Pulse',
      motif: 'football stadium energy',
      description: 'A bright athletic look with pitch greens, arena lights, and high-match momentum.',
      backgroundPrompt: 'A cinematic football stadium at night with vivid green pitch lines, glowing floodlights, motion-filled atmosphere, dramatic depth, and no people in frame.',
      primaryColor: '#1F6A4C',
      secondaryColor: '#E8C547',
      surfaceColor: '#F4F8F2',
      backgroundColor: '#E5F0E8',
    }
  }

  if (/\bscientist\b|\bphysics\b|\bchemist\b|\blaboratory\b|\bresearch\b/.test(sourceText)) {
    return {
      category,
      name: 'Laboratory Glow',
      motif: 'scientific laboratory atmosphere',
      description: 'A clean research-inspired look with cool tones, glassy surfaces, and focused energy.',
      backgroundPrompt: 'A cinematic science laboratory interior with glass reflections, soft blue instrument lights, elegant work surfaces, atmospheric depth, and no people in frame.',
      primaryColor: '#235C7A',
      secondaryColor: '#D88C3A',
      surfaceColor: '#F4F8FB',
      backgroundColor: '#E8F0F5',
    }
  }

  if (/\bsinger\b|\bmusician\b|\bactor\b|\bactress\b|\bperformer\b|\bstage\b/.test(sourceText)) {
    return {
      category,
      name: 'Spotlight Stage',
      motif: 'performance spotlight atmosphere',
      description: 'A dramatic entertainment-inspired look with stage warmth and polished contrast.',
      backgroundPrompt: 'A cinematic theater stage with warm spotlights, velvet tones, subtle haze, elegant depth, and no people in frame.',
      primaryColor: '#7A2E52',
      secondaryColor: '#D17B49',
      surfaceColor: '#FBF4F6',
      backgroundColor: '#F2E7EB',
    }
  }

  if (category === 'politics') {
    return {
      category,
      name: 'Chamber Focus',
      motif: 'parliament chamber atmosphere',
      description: 'A stately civic look with formal interiors, balanced lighting, and institutional depth.',
      backgroundPrompt: 'A cinematic parliament or government chamber interior with polished wood, dramatic architecture, dignified atmosphere, and no people in frame.',
      primaryColor: '#6A2F2B',
      secondaryColor: '#B58A4C',
      surfaceColor: '#FBF5EF',
      backgroundColor: '#EFE3D5',
    }
  }

  if (category === 'business') {
    return {
      category,
      name: 'Boardroom Momentum',
      motif: 'executive strategy atmosphere',
      description: 'A sleek professional look with city lights, glass reflections, and modern ambition.',
      backgroundPrompt: 'A cinematic modern boardroom or skyline office interior with ambient city lights, elegant reflections, strong depth, and no people in frame.',
      primaryColor: '#233B63',
      secondaryColor: '#D08E44',
      surfaceColor: '#F6F8FC',
      backgroundColor: '#E8EDF5',
    }
  }

  return {
    category,
    name: 'Signature Presence',
    motif: 'distinctive public persona atmosphere',
    description: 'A tailored editorial look inspired by the person’s public image and biography.',
    backgroundPrompt: 'A cinematic editorial background inspired by a public figure biography, with layered atmosphere, rich depth, and no people in frame.',
    primaryColor: '#214C74',
    secondaryColor: '#B25B3A',
    surfaceColor: '#FFF9F3',
    backgroundColor: '#F4E9DD',
  }
}

function normalizeVisualTheme(profile, persona) {
  const sourceTheme = persona?.visualTheme && typeof persona.visualTheme === 'object'
    ? persona.visualTheme
    : {}
  const fallbackTheme = buildDefaultTheme(profile, persona)
  const category = ['sports', 'politics', 'science', 'performance', 'business', 'general'].includes(sourceTheme.category)
    ? sourceTheme.category
    : fallbackTheme.category

  return {
    category,
    name: String(sourceTheme.name || '').trim() || fallbackTheme.name,
    motif: String(sourceTheme.motif || '').trim() || fallbackTheme.motif,
    description: String(sourceTheme.description || '').trim() || fallbackTheme.description,
    backgroundPrompt: String(sourceTheme.backgroundPrompt || '').trim() || fallbackTheme.backgroundPrompt,
    primaryColor: normalizeHexColor(sourceTheme.primaryColor, fallbackTheme.primaryColor),
    secondaryColor: normalizeHexColor(sourceTheme.secondaryColor, fallbackTheme.secondaryColor),
    surfaceColor: normalizeHexColor(sourceTheme.surfaceColor, fallbackTheme.surfaceColor),
    backgroundColor: normalizeHexColor(sourceTheme.backgroundColor, fallbackTheme.backgroundColor),
  }
}

function ensureGeneratedImageDir() {
  fs.mkdirSync(GENERATED_IMAGE_DIR, { recursive: true })
}

function getGeneratedBackgroundPath(profile, visualTheme) {
  const key = `${profile.fullUrl}|${visualTheme.name}|${visualTheme.motif}|${visualTheme.backgroundPrompt}`
  const fileId = createHash('sha1').update(key).digest('hex').slice(0, 16)
  const fileName = `background-${fileId}.png`

  return {
    fileName,
    filePath: path.join(GENERATED_IMAGE_DIR, fileName),
    publicUrl: `/generated/${fileName}`,
  }
}

function buildBackgroundImagePrompt(profile, visualTheme) {
  return `Create a cinematic website background image inspired by this public figure biography.

Subject inspiration: ${profile.title}
Biography context: ${profile.description}
Theme name: ${visualTheme.name}
Theme motif: ${visualTheme.motif}
Theme direction: ${visualTheme.description}
Scene prompt: ${visualTheme.backgroundPrompt}

Requirements:
- Create an atmospheric environment only, not a portrait.
- Do not show the selected person or their likeness.
- No people, faces, crowds in focus, readable text, logos, watermarks, or brand marks.
- Designed for a chat app background with strong depth and clean negative space for interface panels.
- Rich, premium, photorealistic editorial look.
- Use the theme colors naturally: ${visualTheme.primaryColor}, ${visualTheme.secondaryColor}, ${visualTheme.backgroundColor}.
- Wide composition, 16:9 aspect ratio.`
}

function getFallbackBackgroundImageUrl(profile, visualTheme) {
  const fallbackByCategory = {
    sports: '/fallbacks/sports.jpg',
    politics: '/fallbacks/politics.jpg',
    science: '/fallbacks/science.jpg',
    performance: '/fallbacks/performance.jpg',
    business: '/fallbacks/business.jpg',
    general: '/fallbacks/general.jpg',
  }

  return fallbackByCategory[visualTheme?.category] || fallbackByCategory[inferThemeCategory(profile)] || ''
}

async function generateBackgroundImage(profile, visualTheme) {
  ensureGeneratedImageDir()

  const { filePath, publicUrl } = getGeneratedBackgroundPath(profile, visualTheme)

  if (fs.existsSync(filePath)) {
    return publicUrl
  }

  const response = await generateContentWithRetry({
    model: imageModel,
    contents: [{ text: buildBackgroundImagePrompt(profile, visualTheme) }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: '16:9',
        imageSize: '2K',
      },
    },
  })

  const parts = response?.candidates?.[0]?.content?.parts || []
  const imagePart = parts.find((part) => part.inlineData?.data)

  if (!imagePart?.inlineData?.data) {
    throw new Error('The image model returned no background image.')
  }

  fs.writeFileSync(filePath, Buffer.from(imagePart.inlineData.data, 'base64'))
  return publicUrl
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

function toSentenceCase(value) {
  const text = String(value || '').trim()

  if (!text) {
    return ''
  }

  return text.charAt(0).toUpperCase() + text.slice(1)
}

function extractTalkingPoints(profile) {
  const source = `${profile.description}. ${profile.extract}`
  const sentences = source
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)

  const candidates = []

  for (const sentence of sentences) {
    const cleaned = sentence.replace(/\s+/g, ' ')

    if (cleaned.length < 24) {
      continue
    }

    candidates.push(cleaned)

    if (candidates.length === 4) {
      break
    }
  }

  return candidates.length
    ? candidates
    : [
        `${profile.title} is best known for ${profile.description || 'their public work'}.`,
        'The conversation stays grounded in the linked Wikipedia biography.',
      ]
}

function buildFallbackVoice(profile) {
  const source = `${profile.description} ${profile.extract}`.toLowerCase()

  if (/\bfootball\b|\bsoccer\b|\bwinger\b|\bstriker\b|\bgoal\b/.test(source)) {
    return [
      'Energetic and direct',
      'Focused on teamwork and momentum',
      'Speaks confidently about performance',
      'Brings a competitive but upbeat tone',
    ]
  }

  if (/\bscientist\b|\bresearch\b|\bphysics\b|\blaboratory\b/.test(source)) {
    return [
      'Thoughtful and analytical',
      'Calm when explaining complex ideas',
      'Curious about how things work',
      'Grounded in evidence and observation',
    ]
  }

  if (/\bactor\b|\bactress\b|\bsinger\b|\bmusician\b|\bperformer\b/.test(source)) {
    return [
      'Expressive and warm',
      'Comfortable discussing craft and performance',
      'Reflective about creative work',
      'Polished but conversational',
    ]
  }

  return [
    'Warm and conversational',
    'Grounded in public biography',
    'Confident about known work and achievements',
    'Careful not to invent unsupported details',
  ]
}

function buildFallbackPersona(profile) {
  const basePersona = {
    displayName: profile.title,
    tagline: toSentenceCase(profile.description || `A public figure with a story grounded in Wikipedia.`),
    voice: buildFallbackVoice(profile),
    talkingPoints: extractTalkingPoints(profile),
    defaultLanguageCode: 'en',
    openingMessage: `Hi, I'm ${profile.title}. We can talk using the public information from my Wikipedia biography.`,
    groundingNote: `This persona is generated from public information about ${profile.title} found on Wikipedia.`,
  }

  return finalizePersona(profile, basePersona)
}

function buildFallbackOpeningMessage(profile, persona, selectedLanguage) {
  const supportedLanguages = Array.isArray(persona.supportedLanguages) ? persona.supportedLanguages : []
  const activeLanguage =
    supportedLanguages.find((item) => item.code === selectedLanguage) ||
    supportedLanguages.find((item) => item.code === persona.defaultLanguageCode) ||
    supportedLanguages[0] || {
      code: 'en',
      label: 'English',
    }

  if (String(activeLanguage.code).toLowerCase() === 'ka') {
    return `გამარჯობა, მე ვარ ${persona.displayName || profile.title}. მოდი ვისაუბროთ ჩემ შესახებ იმ საჯარო ინფორმაციაზე დაყრდნობით, რაც Wikipedia-ზეა მოცემული.`
  }

  return (
    String(persona.openingMessage || '').trim() ||
    `Hi, I'm ${persona.displayName || profile.title}. Let's talk using the public information available about me on Wikipedia.`
  )
}

function buildFallbackChatReply(profile, persona, message, selectedLanguage) {
  const supportedLanguages = Array.isArray(persona.supportedLanguages) ? persona.supportedLanguages : []
  const activeLanguage =
    supportedLanguages.find((item) => item.code === selectedLanguage) ||
    supportedLanguages.find((item) => item.code === persona.defaultLanguageCode) ||
    supportedLanguages[0] || {
      code: 'en',
      label: 'English',
    }
  const talkingPoint = persona.talkingPoints?.[0] || profile.description || 'my public work'
  const trimmedMessage = String(message || '').trim()
  const lowerMessage = trimmedMessage.toLowerCase()
  const displayName = persona.displayName || profile.title

  if (String(activeLanguage.code).toLowerCase() === 'ka') {
    return `მე ახლა მხოლოდ იმ საჯარო ინფორმაციას ვეყრდნობი, რაც Wikipedia-ზეა მოცემული. შენი კითხვის პასუხად შემიძლია ვთქვა, რომ ჩემი ისტორია განსაკუთრებით უკავშირდება ${talkingPoint}. თუ გინდა, ამ თემას უფრო კონკრეტულად გავყვეთ.`
  }

  if (!trimmedMessage || /\bhi\b|\bhello\b|\bhey\b|\bhow are you\b/.test(lowerMessage)) {
    return `Hi. It's good to hear from you. I'm ${displayName}, and I'm doing well. What would you like to talk about? We can start with ${talkingPoint}, or anything else you're curious about.`
  }

  if (/\bwho are you\b|\btell me about yourself\b/.test(lowerMessage)) {
    return `I'm ${displayName}. People usually know me for ${profile.description || talkingPoint}. If you want, ask me about ${talkingPoint} and we can get into it.`
  }

  return `That's a fair question. I'd say ${talkingPoint} is one of the clearest ways to understand my story. If you want to go deeper, ask me something more specific and I'll answer as directly as I can.`
}

function normalizeTranscript(rawTranscript, firstPersona, secondPersona) {
  const transcript = Array.isArray(rawTranscript) ? rawTranscript : []
  const speakers = [
    { code: 'A', displayName: firstPersona.displayName },
    { code: 'B', displayName: secondPersona.displayName },
  ]

  return transcript
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const fallbackSpeaker = speakers[index % 2]
      const speakerCode = item.speakerCode === 'B' ? 'B' : 'A'
      const activeSpeaker = speakers.find((speaker) => speaker.code === speakerCode) || fallbackSpeaker

      return {
        speakerCode: activeSpeaker.code,
        speakerName: String(item.speakerName || activeSpeaker.displayName).trim() || activeSpeaker.displayName,
        content: String(item.content || '').trim(),
      }
    })
    .filter((item) => item.content)
}

function duoConversationPrompt(firstProfile, firstPersona, secondProfile, secondPersona) {
  return `Create a short conversation between two Wikipedia-grounded public personas.

Return JSON with:
- title: string
- setup: string
- transcript: array of exactly 6 objects with:
  - speakerCode: "A" or "B"
  - speakerName: string
  - content: string

Rules:
- Alternate speakers strictly A, B, A, B, A, B.
- The two personas speak only to each other, not to the user.
- Keep every turn under 70 words.
- The exchange should feel natural, warm, and specific to their public work.
- Base all details on the supplied Wikipedia summaries and persona notes.
- Do not invent private facts or unsupported meetings between them.
- If their fields differ, let them compare ideas respectfully and find an interesting overlap.

Persona A:
Name: ${firstPersona.displayName}
Tagline: ${firstPersona.tagline}
Voice:
${Array.isArray(firstPersona.voice) ? firstPersona.voice.map((item) => `- ${item}`).join('\n') : ''}
Talking points:
${Array.isArray(firstPersona.talkingPoints) ? firstPersona.talkingPoints.map((item) => `- ${item}`).join('\n') : ''}
Wikipedia:
${firstProfile.title} - ${firstProfile.description}
${firstProfile.extract}

Persona B:
Name: ${secondPersona.displayName}
Tagline: ${secondPersona.tagline}
Voice:
${Array.isArray(secondPersona.voice) ? secondPersona.voice.map((item) => `- ${item}`).join('\n') : ''}
Talking points:
${Array.isArray(secondPersona.talkingPoints) ? secondPersona.talkingPoints.map((item) => `- ${item}`).join('\n') : ''}
Wikipedia:
${secondProfile.title} - ${secondProfile.description}
${secondProfile.extract}`
}

function buildFallbackDuoConversation(firstProfile, firstPersona, secondProfile, secondPersona) {
  const firstTopic = firstPersona.talkingPoints?.[0] || firstProfile.description || 'public work'
  const secondTopic = secondPersona.talkingPoints?.[0] || secondProfile.description || 'public work'
  const overlap = inferThemeCategory(firstProfile, firstPersona) === inferThemeCategory(secondProfile, secondPersona)
    ? 'shared ground in their public fields'
    : 'how different fields can still shape culture and ideas'

  return {
    title: `${firstPersona.displayName} and ${secondPersona.displayName}`,
    setup: `A short exchange grounded in both Wikipedia biographies, focused on ${overlap}.`,
    transcript: [
      {
        speakerCode: 'A',
        speakerName: firstPersona.displayName,
        content: `It's good to speak with you. People often know me for ${firstTopic}. I'm curious what part of your own work feels most defining to you.`,
      },
      {
        speakerCode: 'B',
        speakerName: secondPersona.displayName,
        content: `For me, it starts with ${secondTopic}. That usually shapes how people understand my public role, even when the fuller story is more layered.`,
      },
      {
        speakerCode: 'A',
        speakerName: firstPersona.displayName,
        content: `That makes sense. Public work can look simple from the outside, but the discipline behind it is usually what people miss first.`,
      },
      {
        speakerCode: 'B',
        speakerName: secondPersona.displayName,
        content: `Exactly. The visible moments matter, but the habits, decisions, and preparation underneath them often tell the deeper story.`,
      },
      {
        speakerCode: 'A',
        speakerName: firstPersona.displayName,
        content: `I like that. Even from different backgrounds, there is something shared in commitment, pressure, and the need to keep improving.`,
      },
      {
        speakerCode: 'B',
        speakerName: secondPersona.displayName,
        content: `And that may be the best overlap of all: different arenas, but the same demand to grow in public and keep your purpose clear.`,
      },
    ],
  }
}

async function buildPersonaFromProfile(profile) {
  try {
    const rawPersona = await generateJson(personaPrompt(profile))
    return finalizePersona(profile, rawPersona)
  } catch (personaError) {
    if (!isRetryableModelError(personaError)) {
      throw personaError
    }

    console.warn(`Persona model unavailable, using fallback persona: ${summarizeModelError(personaError)}`)
    return buildFallbackPersona(profile)
  }
}

async function attachBackgroundImage(profile, persona) {
  try {
    return await generateBackgroundImage(profile, persona.visualTheme)
  } catch (backgroundError) {
    console.warn(`Unable to generate background image, using fallback image: ${summarizeModelError(backgroundError)}`)
    return getFallbackBackgroundImageUrl(profile, persona.visualTheme)
  }
}

function finalizePersona(profile, persona) {
  const supportedLanguages = normalizeSupportedLanguages(profile, persona)
  const availableCodes = new Set(supportedLanguages.map((item) => item.code))
  const defaultLanguageCode = availableCodes.has(persona.defaultLanguageCode)
    ? persona.defaultLanguageCode
    : 'en'
  const visualTheme = normalizeVisualTheme(profile, persona)

  return {
    ...persona,
    supportedLanguages,
    defaultLanguageCode,
    visualTheme,
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function getErrorStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.code,
    error?.error?.status,
    error?.error?.code,
  ]

  for (const candidate of candidates) {
    const numeric = Number(candidate)

    if (Number.isInteger(numeric) && numeric > 0) {
      return numeric
    }
  }

  const message = error instanceof Error ? error.message : String(error || '')
  const statusMatch = message.match(/\b(429|500|503)\b/)
  return statusMatch ? Number(statusMatch[1]) : null
}

function isRetryableModelError(error) {
  const status = getErrorStatus(error)

  if (status && RETRYABLE_STATUS_CODES.has(status)) {
    return true
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase()
  return (
    message.includes('high demand') ||
    message.includes('unavailable') ||
    message.includes('overloaded') ||
    message.includes('rate limit') ||
    message.includes('temporarily')
  )
}

function isQuotaExceededError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase()
  return (
    message.includes('quota exceeded') ||
    message.includes('resource_exhausted') ||
    message.includes('billing details') ||
    message.includes('rate limit')
  )
}

function getRetryDelaySeconds(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  const retryMatch = message.match(/retry in ([\d.]+)s/i)

  if (!retryMatch) {
    return null
  }

  const seconds = Number(retryMatch[1])
  return Number.isFinite(seconds) ? Math.ceil(seconds) : null
}

function summarizeModelError(error) {
  const status = getErrorStatus(error) || 'unknown'
  const retryDelaySeconds = getRetryDelaySeconds(error)

  if (isQuotaExceededError(error)) {
    return retryDelaySeconds
      ? `quota exceeded (status ${status}, retry in about ${retryDelaySeconds}s)`
      : `quota exceeded (status ${status})`
  }

  if (isRetryableModelError(error)) {
    return retryDelaySeconds
      ? `temporary model issue (status ${status}, retry in about ${retryDelaySeconds}s)`
      : `temporary model issue (status ${status})`
  }

  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function toAppError(error, fallbackMessage) {
  const status = getErrorStatus(error)
  const retryable = isRetryableModelError(error)
  const friendlyMessage = isQuotaExceededError(error)
    ? 'The AI quota is exhausted right now. Please wait a bit or switch to a different API plan/model.'
    : retryable
      ? 'The AI model is busy right now. Please try again in a moment.'
      : fallbackMessage
  const appError = new Error(friendlyMessage)

  appError.statusCode = isQuotaExceededError(error) ? 429 : retryable ? 503 : status || 500
  appError.cause = error

  return appError
}

async function generateWithRetry(config, emptyResponseMessage) {
  const client = getClient()
  let lastError = null

  for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt += 1) {
    try {
      const response = await client.models.generateContent({
        model,
        ...config,
      })

      if (!response.text) {
        throw new Error(emptyResponseMessage)
      }

      return response.text.trim()
    } catch (error) {
      lastError = error

      if (isQuotaExceededError(error) || !isRetryableModelError(error) || attempt === MAX_MODEL_RETRIES) {
        throw error
      }

      await sleep(RETRY_DELAY_MS * (attempt + 1))
    }
  }

  throw lastError || new Error(emptyResponseMessage)
}

async function generateContentWithRetry(config) {
  const client = getClient()
  let lastError = null

  for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt += 1) {
    try {
      return await client.models.generateContent(config)
    } catch (error) {
      lastError = error

      if (isQuotaExceededError(error) || !isRetryableModelError(error) || attempt === MAX_MODEL_RETRIES) {
        throw error
      }

      await sleep(RETRY_DELAY_MS * (attempt + 1))
    }
  }

  throw lastError || new Error('The AI model returned an unexpected error.')
}

async function generateJson(prompt) {
  const text = await generateWithRetry(
    {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    },
    'Gemini returned an empty response.',
  )

  return JSON.parse(text)
}

async function generateText(prompt) {
  return generateWithRetry(
    {
      contents: prompt,
    },
    'Gemini returned an empty response.',
  )
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
    const persona = await buildPersonaFromProfile(profile)
    persona.backgroundImageUrl = await attachBackgroundImage(profile, persona)

    res.json({
      profile,
      persona,
    })
  } catch (error) {
    const appError = toAppError(error, 'Unable to build that persona right now.')
    res.status(appError.statusCode).json({
      error: appError.message,
    })
  }
})

app.post('/api/duo', async (req, res) => {
  try {
    const { firstWikipediaUrl, secondWikipediaUrl } = req.body ?? {}

    if (!firstWikipediaUrl || !secondWikipediaUrl) {
      return res.status(400).json({ error: 'Missing firstWikipediaUrl or secondWikipediaUrl.' })
    }

    const [firstTitle, secondTitle] = [
      parseWikipediaTitle(firstWikipediaUrl),
      parseWikipediaTitle(secondWikipediaUrl),
    ]

    const [firstProfile, secondProfile] = await Promise.all([
      fetchWikipediaProfile(firstTitle),
      fetchWikipediaProfile(secondTitle),
    ])

    const [firstPersona, secondPersona] = await Promise.all([
      buildPersonaFromProfile(firstProfile),
      buildPersonaFromProfile(secondProfile),
    ])

    const [firstBackgroundImageUrl, secondBackgroundImageUrl] = await Promise.all([
      attachBackgroundImage(firstProfile, firstPersona),
      attachBackgroundImage(secondProfile, secondPersona),
    ])

    firstPersona.backgroundImageUrl = firstBackgroundImageUrl
    secondPersona.backgroundImageUrl = secondBackgroundImageUrl

    let conversation

    try {
      const rawConversation = await generateJson(
        duoConversationPrompt(firstProfile, firstPersona, secondProfile, secondPersona),
      )

      conversation = {
        title:
          String(rawConversation?.title || '').trim() ||
          `${firstPersona.displayName} and ${secondPersona.displayName}`,
        setup:
          String(rawConversation?.setup || '').trim() ||
          'A short exchange between two Wikipedia-grounded personas.',
        transcript: normalizeTranscript(rawConversation?.transcript, firstPersona, secondPersona),
      }
    } catch (conversationError) {
      if (!isRetryableModelError(conversationError)) {
        throw conversationError
      }

      console.warn(
        `Conversation model unavailable, using fallback duo conversation: ${summarizeModelError(conversationError)}`,
      )
      conversation = buildFallbackDuoConversation(
        firstProfile,
        firstPersona,
        secondProfile,
        secondPersona,
      )
    }

    if (!conversation.transcript.length) {
      conversation = buildFallbackDuoConversation(
        firstProfile,
        firstPersona,
        secondProfile,
        secondPersona,
      )
    }

    res.json({
      participants: [
        { profile: firstProfile, persona: firstPersona },
        { profile: secondProfile, persona: secondPersona },
      ],
      conversation,
    })
  } catch (error) {
    const appError = toAppError(error, 'Unable to create a two-person conversation right now.')
    res.status(appError.statusCode).json({
      error: appError.message,
    })
  }
})

app.post('/api/background', async (req, res) => {
  try {
    const { profile, persona } = req.body ?? {}

    if (!profile || !persona) {
      return res.status(400).json({ error: 'Missing profile or persona.' })
    }

    const visualTheme = normalizeVisualTheme(profile, persona)
    let backgroundImageUrl

    try {
      backgroundImageUrl = await generateBackgroundImage(profile, visualTheme)
    } catch (backgroundError) {
      console.warn(
        `Unable to generate requested background image, using fallback image: ${summarizeModelError(backgroundError)}`,
      )
      backgroundImageUrl = getFallbackBackgroundImageUrl(profile, visualTheme)
    }

    res.json({
      backgroundImageUrl,
      visualTheme,
    })
  } catch (error) {
    const appError = toAppError(error, 'Unable to generate a background image right now.')
    res.status(appError.statusCode).json({
      error: appError.message,
    })
  }
})

app.post('/api/chat', async (req, res) => {
  try {
    const { profile, persona, history, message, languageCode } = req.body ?? {}

    if (!profile || !persona || !message) {
      return res.status(400).json({ error: 'Missing profile, persona, or message.' })
    }

    let reply

    try {
      reply = await generateText(
        chatPrompt(profile, persona, Array.isArray(history) ? history : [], message, languageCode),
      )
    } catch (replyError) {
      if (!isRetryableModelError(replyError)) {
        throw replyError
      }

      console.warn(`Chat model unavailable, using fallback reply: ${summarizeModelError(replyError)}`)
      reply = buildFallbackChatReply(profile, persona, message, languageCode)
    }

    res.json({ reply })
  } catch (error) {
    const appError = toAppError(error, 'Unable to generate a reply right now.')
    res.status(appError.statusCode).json({
      error: appError.message,
    })
  }
})

app.post('/api/opening', async (req, res) => {
  try {
    const { profile, persona, languageCode } = req.body ?? {}

    if (!profile || !persona) {
      return res.status(400).json({ error: 'Missing profile or persona.' })
    }

    let openingMessage

    try {
      openingMessage = await generateText(openingPrompt(profile, persona, languageCode))
    } catch (openingError) {
      if (!isRetryableModelError(openingError)) {
        throw openingError
      }

      console.warn(
        `Opening model unavailable, using fallback opening: ${summarizeModelError(openingError)}`,
      )
      openingMessage = buildFallbackOpeningMessage(profile, persona, languageCode)
    }

    res.json({ openingMessage })
  } catch (error) {
    const appError = toAppError(error, 'Unable to generate an opening message right now.')
    res.status(appError.statusCode).json({
      error: appError.message,
    })
  }
})

app.use((err, req, res, next) => {
  console.error('Express internal error:', err)

  if (res.headersSent) {
    return next(err)
  }

  res.status(500).json({ error: 'Internal server error' })
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

app.listen(port, () => {
  console.log(`Persona server listening on http://localhost:${port}`)
})
