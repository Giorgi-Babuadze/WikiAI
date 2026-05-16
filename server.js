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
const DEFAULT_QUOTA_COOLDOWN_MS = 16000
const GENERATED_IMAGE_DIR = path.join(process.cwd(), 'public', 'generated')
const FALLBACK_IMAGE_DIR = path.join(process.cwd(), 'public', 'fallbacks')
const SMART_PERSONA_TEXT_CONFIG = {
  temperature: 0.45,
  maxOutputTokens: 320,
  thinkingConfig: {
    thinkingLevel: 'LOW',
  },
}
let modelCooldownUntil = 0

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

function normalizeAudienceProfile(value) {
  return value === 'pupil' ? 'pupil' : 'adult'
}

function getAudienceInstructions(audienceProfile) {
  if (normalizeAudienceProfile(audienceProfile) === 'pupil') {
    return {
      personaTone:
        'Make the persona warmer, more encouraging, easier to understand, and slightly more educational for pupils. Explanations should be clearer and more informative without becoming childish.',
      chatTone:
        'Use a friendly, supportive, more informative style suitable for pupils. Prefer clearer explanations, helpful context, and simple wording when possible.',
      openingTone:
        'The opening should feel especially welcoming, easy to understand, and encouraging for pupils.',
      duoTone:
        'The exchange should be friendly, easy to follow, and a little more educational for pupils.',
    }
  }

  return {
    personaTone:
      'Keep the current balanced adult tone: conversational, natural, and grounded without extra simplification.',
    chatTone:
      'Use the existing adult style: natural, balanced, and concise unless the user asks for more depth.',
    openingTone:
      'Keep the opening warm and natural for an adult general audience.',
    duoTone:
      'Keep the exchange natural, warm, and grounded for an adult general audience.',
  }
}

function personaPrompt(profile, audienceProfile = 'adult') {
  const audience = getAudienceInstructions(audienceProfile)
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
- ${audience.personaTone}
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

function buildFallbackVoice(profile, audienceProfile = 'adult') {
  const source = `${profile.description} ${profile.extract}`.toLowerCase()
  const isPupil = normalizeAudienceProfile(audienceProfile) === 'pupil'

  if (/\bfootball\b|\bsoccer\b|\bwinger\b|\bstriker\b|\bgoal\b/.test(source)) {
    return isPupil ? [
      'Friendly and energetic',
      'Explains ideas in a simple, encouraging way',
      'Enjoys teaching through examples from public work',
      'Keeps the tone upbeat and easy to follow',
    ] : [
      'Energetic and direct',
      'Focused on teamwork and momentum',
      'Speaks confidently about performance',
      'Brings a competitive but upbeat tone',
    ]
  }

  if (/\bscientist\b|\bresearch\b|\bphysics\b|\blaboratory\b/.test(source)) {
    return isPupil ? [
      'Thoughtful and welcoming',
      'Breaks complex ideas into clearer explanations',
      'Encourages curiosity and learning',
      'Grounded in evidence but easy to follow',
    ] : [
      'Thoughtful and analytical',
      'Calm when explaining complex ideas',
      'Curious about how things work',
      'Grounded in evidence and observation',
    ]
  }

  if (/\bactor\b|\bactress\b|\bsinger\b|\bmusician\b|\bperformer\b/.test(source)) {
    return isPupil ? [
      'Expressive and warm',
      'Explains creative work in a friendly way',
      'Encourages curiosity about craft and practice',
      'Polished but easy to understand',
    ] : [
      'Expressive and warm',
      'Comfortable discussing craft and performance',
      'Reflective about creative work',
      'Polished but conversational',
    ]
  }

  return isPupil ? [
    'Warm and encouraging',
    'Clear and informative',
    'Grounded in public biography',
    'Careful to explain ideas in simple language',
  ] : [
    'Warm and conversational',
    'Grounded in public biography',
    'Confident about known work and achievements',
    'Careful not to invent unsupported details',
  ]
}

function buildFallbackPersona(profile, audienceProfile = 'adult') {
  const isPupil = normalizeAudienceProfile(audienceProfile) === 'pupil'
  const basePersona = {
    displayName: profile.title,
    tagline: toSentenceCase(profile.description || `A public figure with a story grounded in Wikipedia.`),
    voice: buildFallbackVoice(profile, audienceProfile),
    talkingPoints: extractTalkingPoints(profile),
    defaultLanguageCode: 'en',
    openingMessage: isPupil
      ? `Hi, I'm ${profile.title}. We can talk about my story using the public information from Wikipedia, and I'll try to explain things in a friendly, clear way.`
      : `Hi, I'm ${profile.title}. We can talk using the public information from my Wikipedia biography.`,
    groundingNote: isPupil
      ? `This pupil version is generated from public information about ${profile.title} found on Wikipedia, with a friendlier and more informative tone.`
      : `This persona is generated from public information about ${profile.title} found on Wikipedia.`,
    audienceProfile: normalizeAudienceProfile(audienceProfile),
  }

  return finalizePersona(profile, basePersona)
}

function buildFallbackOpeningMessage(profile, persona, selectedLanguage, audienceProfile = 'adult') {
  const supportedLanguages = Array.isArray(persona.supportedLanguages) ? persona.supportedLanguages : []
  const activeLanguage =
    supportedLanguages.find((item) => item.code === selectedLanguage) ||
    supportedLanguages.find((item) => item.code === persona.defaultLanguageCode) ||
    supportedLanguages[0] || {
      code: 'en',
      label: 'English',
    }
  const isPupil = normalizeAudienceProfile(audienceProfile || persona?.audienceProfile) === 'pupil'

  if (String(activeLanguage.code).toLowerCase() === 'ka') {
    return `გამარჯობა, მე ვარ ${persona.displayName || profile.title}. მოდი ვისაუბროთ ჩემ შესახებ იმ საჯარო ინფორმაციაზე დაყრდნობით, რაც Wikipedia-ზეა მოცემული.`
  }

  return (
    String(persona.openingMessage || '').trim() ||
    (isPupil
      ? `Hi, I'm ${persona.displayName || profile.title}. Let's talk using the public information about me on Wikipedia, and I'll try to explain things clearly and helpfully.`
      : `Hi, I'm ${persona.displayName || profile.title}. Let's talk using the public information available about me on Wikipedia.`)
  )
}

function buildFallbackChatReply(profile, persona, message, selectedLanguage, audienceProfile = 'adult') {
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
  const isPupil = normalizeAudienceProfile(audienceProfile || persona?.audienceProfile) === 'pupil'

  if (String(activeLanguage.code).toLowerCase() === 'ka') {
    return `მე ახლა მხოლოდ იმ საჯარო ინფორმაციას ვეყრდნობი, რაც Wikipedia-ზეა მოცემული. შენი კითხვის პასუხად შემიძლია ვთქვა, რომ ჩემი ისტორია განსაკუთრებით უკავშირდება ${talkingPoint}. თუ გინდა, ამ თემას უფრო კონკრეტულად გავყვეთ.`
  }

  if (!trimmedMessage || /\bhi\b|\bhello\b|\bhey\b|\bhow are you\b/.test(lowerMessage)) {
    return isPupil
      ? `Hi. It's great to hear from you. I'm ${displayName}. We can talk about ${talkingPoint}, and I can explain it in a clear and friendly way if you'd like.`
      : `Hi. It's good to hear from you. I'm ${displayName}, and I'm doing well. What would you like to talk about? We can start with ${talkingPoint}, or anything else you're curious about.`
  }

  if (/\bwho are you\b|\btell me about yourself\b/.test(lowerMessage)) {
    return isPupil
      ? `I'm ${displayName}. People usually know me for ${profile.description || talkingPoint}. If you want, ask me about that and I'll explain it step by step in a simple way.`
      : `I'm ${displayName}. People usually know me for ${profile.description || talkingPoint}. If you want, ask me about ${talkingPoint} and we can get into it.`
  }

  return isPupil
    ? `That's a good question. ${talkingPoint} is one of the best ways to understand my story, and I can explain it more clearly if you ask about one part at a time.`
    : `That's a fair question. I'd say ${talkingPoint} is one of the clearest ways to understand my story. If you want to go deeper, ask me something more specific and I'll answer as directly as I can.`
}

function buildFallbackDuoOpening(speakerProfile, speakerPersona, otherProfile, otherPersona, audienceProfile = 'adult') {
  const speakerName = speakerPersona?.displayName || speakerProfile?.title || 'Speaker'
  const otherName = otherPersona?.displayName || otherProfile?.title || 'my fellow guest'
  const speakerPoint =
    speakerPersona?.talkingPoints?.[0] ||
    speakerProfile?.description ||
    'the work I am best known for'
  const otherPoint =
    otherPersona?.talkingPoints?.[0] ||
    otherProfile?.description ||
    'your public work'
  const isPupil = normalizeAudienceProfile(audienceProfile || speakerPersona?.audienceProfile) === 'pupil'

  return isPupil
    ? `Hello ${otherName}. I'm ${speakerName}. A simple place to begin is ${speakerPoint}. I'm also curious about ${otherPoint}, because it helps show where our stories connect.`
    : `Hello ${otherName}. I'm ${speakerName}. A good starting point from my side is ${speakerPoint}. I'm also interested in ${otherPoint}, because that seems like the clearest point of connection between us.`
}

function buildFallbackDuoReply(
  speakerProfile,
  speakerPersona,
  otherProfile,
  otherPersona,
  transcript,
  speakerIndex,
  audienceProfile = 'adult',
) {
  const otherName = otherPersona?.displayName || otherProfile?.title || 'the other speaker'
  const speakerPoint =
    speakerPersona?.talkingPoints?.[0] ||
    speakerProfile?.description ||
    'the work I am best known for'
  const otherPoint =
    otherPersona?.talkingPoints?.[0] ||
    otherProfile?.description ||
    'your public work'
  const safeTranscript = Array.isArray(transcript) ? transcript : []
  const incomingText = String(safeTranscript[safeTranscript.length - 1]?.content || '').trim()
  const previousOwnTurn = [...safeTranscript]
    .reverse()
    .find((turn) => (turn?.speakerCode === 'A' ? 0 : 1) === speakerIndex)
  const previousOwnText = String(previousOwnTurn?.content || '').trim().toLowerCase()
  const isPupil = normalizeAudienceProfile(audienceProfile || speakerPersona?.audienceProfile) === 'pupil'

  if (!incomingText) {
    return buildFallbackDuoOpening(
      speakerProfile,
      speakerPersona,
      otherProfile,
      otherPersona,
      audienceProfile,
    )
  }

  // When fallback mode is active repeatedly, keep the exchange moving by
  // acknowledging the latest point and then adding a different follow-up idea.
  if (previousOwnText.includes('starting point') || previousOwnText.includes('simple place to begin')) {
    return isPupil
      ? `${otherName}, that gives us a clearer bridge. From my side, another part worth adding is how ${speakerPoint} shaped the way people understand me, while ${otherPoint} shows the other side of this comparison.`
      : `${otherName}, that's a useful connection. Another angle from my side is how ${speakerPoint} shaped my public identity, while ${otherPoint} highlights the contrast that keeps this comparison interesting.`
  }

  if (previousOwnText.includes('another angle') || previousOwnText.includes('another part worth adding')) {
    return isPupil
      ? `${otherName}, I think that also shows why people compare us so often. We each have a different style, but ${speakerPoint} keeps me grounded in what I am best known for.`
      : `${otherName}, I think that also explains why our names are often discussed together. We each bring a different style, but ${speakerPoint} still anchors the way my career is usually understood.`
  }

  if (incomingText.toLowerCase().includes('compare') || incomingText.toLowerCase().includes('different style')) {
    return isPupil
      ? `${otherName}, that comparison makes sense. I would say ${speakerPoint} describes my side best, while ${otherPoint} explains what makes your side distinct.`
      : `${otherName}, that's a fair comparison. I'd put ${speakerPoint} at the center of my side, while ${otherPoint} captures what makes your side distinct in the public imagination.`
  }

  if (isPupil) {
    return `${otherName}, that's a helpful point. Building on what we've already said, ${speakerPoint} is still one of the clearest ways to understand my work, and it connects naturally with ${otherPoint}.`
  }

  return `${otherName}, that's a thoughtful point. Building on what we've already said, ${speakerPoint} remains one of the clearest ways to understand my work, and it still intersects naturally with ${otherPoint}.`
}

function buildPreloadedDuoConversationShell(firstProfile, firstPersona, secondProfile, secondPersona) {
  const overlap = inferThemeCategory(firstProfile, firstPersona) === inferThemeCategory(secondProfile, secondPersona)
    ? 'their shared public field'
    : 'the overlap between their different public worlds'

  return {
    title: `${firstPersona.displayName} and ${secondPersona.displayName}`,
    setup: `A preloaded Wikipedia-grounded dialogue about ${overlap}.`,
    transcript: [],
    mode: 'preloaded',
    maxTurns: 8,
  }
}

function buildDuoPerspectiveHistory(transcript, speakerIndex) {
  return transcript
    .slice(-4)
    .map((turn) => ({
      role:
        (turn.speakerCode === 'A' ? 0 : 1) === speakerIndex
          ? 'assistant'
          : 'user',
      content: String(turn.content || '').trim(),
    }))
    .filter((turn) => turn.content)
}

async function generateDuoTurn(participants, transcript, audienceProfile = 'adult') {
  const safeParticipants = Array.isArray(participants) ? participants.slice(0, 2) : []
  const safeTranscript = Array.isArray(transcript) ? transcript : []

  if (safeParticipants.length !== 2) {
    throw new Error('Missing duo participants.')
  }

  const speakerIndex = safeTranscript.length % 2
  const speaker = safeParticipants[speakerIndex]
  const otherSpeaker = safeParticipants[(speakerIndex + 1) % 2]
  const speakerProfile = speaker?.profile
  const speakerPersona = speaker?.persona
  const otherSpeakerProfile = otherSpeaker?.profile
  const otherSpeakerPersona = otherSpeaker?.persona
  const languageCode = speakerPersona?.defaultLanguageCode || 'en'
  const perspectiveHistory = buildDuoPerspectiveHistory(safeTranscript, speakerIndex)
  let content

  try {
    if (!safeTranscript.length) {
      content = await generateText(
        openingPrompt(speakerProfile, speakerPersona, languageCode, audienceProfile),
      )
    } else {
      const latestIncomingTurn = safeTranscript[safeTranscript.length - 1]
      content = await generateText(
        chatPrompt(
          speakerProfile,
          speakerPersona,
          perspectiveHistory,
          latestIncomingTurn?.content || '',
          languageCode,
          audienceProfile,
        ),
      )
    }
  } catch (turnError) {
    if (!isRetryableModelError(turnError)) {
      throw turnError
    }

    console.warn(`Duo turn model unavailable, using fallback turn: ${summarizeModelError(turnError)}`)
    content = !safeTranscript.length
      ? buildFallbackDuoOpening(
          speakerProfile,
          speakerPersona,
          otherSpeakerProfile,
          otherSpeakerPersona,
          audienceProfile,
        )
      : buildFallbackDuoReply(
          speakerProfile,
          speakerPersona,
          otherSpeakerProfile,
          otherSpeakerPersona,
          safeTranscript,
          speakerIndex,
          audienceProfile,
        )
  }

  return {
    speakerCode: speakerIndex === 0 ? 'A' : 'B',
    speakerName: speaker?.persona?.displayName || speaker?.profile?.title || `Speaker ${speakerIndex + 1}`,
    content: String(content || '').trim(),
  }
}

function buildFallbackDuoTurn(participants, transcript, audienceProfile = 'adult') {
  const safeParticipants = Array.isArray(participants) ? participants.slice(0, 2) : []
  const safeTranscript = Array.isArray(transcript) ? transcript : []
  const speakerIndex = safeTranscript.length % 2
  const speaker = safeParticipants[speakerIndex]
  const otherSpeaker = safeParticipants[(speakerIndex + 1) % 2]
  const speakerProfile = speaker?.profile
  const speakerPersona = speaker?.persona
  const otherSpeakerProfile = otherSpeaker?.profile
  const otherSpeakerPersona = otherSpeaker?.persona

  return {
    speakerCode: speakerIndex === 0 ? 'A' : 'B',
    speakerName: speaker?.persona?.displayName || speaker?.profile?.title || `Speaker ${speakerIndex + 1}`,
    content: String(
      !safeTranscript.length
        ? buildFallbackDuoOpening(
            speakerProfile,
            speakerPersona,
            otherSpeakerProfile,
            otherSpeakerPersona,
            audienceProfile,
          )
        : buildFallbackDuoReply(
            speakerProfile,
            speakerPersona,
            otherSpeakerProfile,
            otherSpeakerPersona,
            safeTranscript,
            speakerIndex,
            audienceProfile,
          ),
    ).trim(),
  }
}

async function buildPreloadedDuoConversation(firstProfile, firstPersona, secondProfile, secondPersona, audienceProfile = 'adult') {
  const participants = [
    { profile: firstProfile, persona: firstPersona },
    { profile: secondProfile, persona: secondPersona },
  ]
  const conversation = buildPreloadedDuoConversationShell(
    firstProfile,
    firstPersona,
    secondProfile,
    secondPersona,
  )

  let fallbackOnly = false

  for (let turnIndex = 0; turnIndex < conversation.maxTurns; turnIndex += 1) {
    let nextTurn

    if (fallbackOnly || isModelCoolingDown()) {
      nextTurn = buildFallbackDuoTurn(participants, conversation.transcript, audienceProfile)
    } else {
      try {
        nextTurn = await generateDuoTurn(participants, conversation.transcript, audienceProfile)
      } catch (error) {
        if (!isQuotaExceededError(error)) {
          throw error
        }

        fallbackOnly = true
        console.warn(`Duo preloaded conversation switched to fallback mode: ${summarizeModelError(error)}`)
        nextTurn = buildFallbackDuoTurn(participants, conversation.transcript, audienceProfile)
      }
    }

    conversation.transcript.push(nextTurn)
  }

  return conversation
}

async function buildPersonaFromProfile(profile, audienceProfile = 'adult') {
  try {
    const rawPersona = await generateJson(personaPrompt(profile, audienceProfile))
    return finalizePersona(profile, {
      ...rawPersona,
      audienceProfile: normalizeAudienceProfile(audienceProfile),
    })
  } catch (personaError) {
    if (!isRetryableModelError(personaError)) {
      throw personaError
    }

    console.warn(`Persona model unavailable, using fallback persona: ${summarizeModelError(personaError)}`)
    return buildFallbackPersona(profile, audienceProfile)
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
    audienceProfile: normalizeAudienceProfile(persona?.audienceProfile),
    supportedLanguages,
    defaultLanguageCode,
    visualTheme,
  }
}

function chatPrompt(profile, persona, history, message, selectedLanguage, audienceProfile = 'adult') {
  const audience = getAudienceInstructions(audienceProfile || persona?.audienceProfile)
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
Before answering, think quietly about what the user is really asking, which parts of the Wikipedia grounding are most relevant, and what would make the reply more helpful.
Prefer direct answers first, then add the best supporting context or nuance if it helps.
When the question is broad or reflective, synthesize a thoughtful answer instead of giving a shallow one-liner.
When the question depends on uncertain details, be transparent about limits instead of guessing.
Keep responses conversational, natural, and usually under 220 words unless the user asks for more depth.
- ${audience.chatTone}
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

function openingPrompt(profile, persona, selectedLanguage, audienceProfile = 'adult') {
  const audience = getAudienceInstructions(audienceProfile || persona?.audienceProfile)
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
Think briefly before writing so the opening feels specific to this person instead of generic.
Let the opening sound intelligent, grounded, and personally recognizable from the biography.
Keep the opening warm, natural, and under 90 words.
- ${audience.openingTone}
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

function markModelCooldown(error) {
  const retryDelaySeconds = getRetryDelaySeconds(error)
  const cooldownMs = Math.max(
    retryDelaySeconds ? retryDelaySeconds * 1000 : DEFAULT_QUOTA_COOLDOWN_MS,
    1000,
  )

  modelCooldownUntil = Math.max(modelCooldownUntil, Date.now() + cooldownMs)
}

function isModelCoolingDown() {
  return Date.now() < modelCooldownUntil
}

function createQuotaCooldownError() {
  const remainingSeconds = Math.max(1, Math.ceil((modelCooldownUntil - Date.now()) / 1000))
  const error = new Error(`quota exceeded (status 429, retry in about ${remainingSeconds}s)`)
  error.statusCode = 429
  return error
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

function getModelRequestDebugInfo(config) {
  return {
    model: config?.model || model,
    hasThinkingConfig: Boolean(config?.config?.thinkingConfig),
    promptLength: typeof config?.contents === 'string'
      ? config.contents.length
      : Array.isArray(config?.contents)
        ? config.contents.length
        : undefined,
  }
}

async function generateWithRetry(config, emptyResponseMessage) {
  const client = getClient()
  let lastError = null

  if (isModelCoolingDown()) {
    throw createQuotaCooldownError()
  }

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

      const debugInfo = getModelRequestDebugInfo(config)
      const status = getErrorStatus(error)

      if (status === 400) {
        console.error('Gemini request failed with status 400:', {
          message: error instanceof Error ? error.message : String(error),
          request: debugInfo,
        })
      }

      if (config?.config?.thinkingConfig && supportsThinkingConfigError(error)) {
        console.warn('Retrying Gemini request without thinkingConfig due to unsupported option.', {
          message: error instanceof Error ? error.message : String(error),
          request: debugInfo,
        })

        const fallbackConfig = {
          ...config,
          config: {
            ...config.config,
          },
        }
        delete fallbackConfig.config.thinkingConfig

        return generateWithRetry(fallbackConfig, emptyResponseMessage)
      }

      if (isQuotaExceededError(error)) {
        markModelCooldown(error)
      }

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

  if (isModelCoolingDown()) {
    throw createQuotaCooldownError()
  }

  for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt += 1) {
    try {
      return await client.models.generateContent(config)
    } catch (error) {
      lastError = error

      if (isQuotaExceededError(error)) {
        markModelCooldown(error)
      }

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

function supportsThinkingConfigError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase()
  return message.includes('thinking') && (
    message.includes('not support') ||
    message.includes('unsupported') ||
    message.includes('unknown field') ||
    message.includes('invalid argument')
  )
}

async function generateText(prompt, generationConfig = null) {
  try {
    return await generateWithRetry(
      {
        contents: prompt,
        ...(generationConfig ? { config: generationConfig } : {}),
      },
      'Gemini returned an empty response.',
    )
  } catch (error) {
    if (!generationConfig?.thinkingConfig || !supportsThinkingConfigError(error)) {
      throw error
    }

    const fallbackConfig = { ...generationConfig }
    delete fallbackConfig.thinkingConfig

    return generateWithRetry(
      {
        contents: prompt,
        config: fallbackConfig,
      },
      'Gemini returned an empty response.',
    )
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model })
})

app.post('/api/persona', async (req, res) => {
  try {
    const wikipediaUrl = req.body?.wikipediaUrl
    const audienceProfile = normalizeAudienceProfile(req.body?.audienceProfile)

    if (!wikipediaUrl) {
      return res.status(400).json({ error: 'Missing wikipediaUrl.' })
    }

    const title = parseWikipediaTitle(wikipediaUrl)
    const profile = await fetchWikipediaProfile(title)
    const persona = await buildPersonaFromProfile(profile, audienceProfile)
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

app.get('/api/duo', (_req, res) => {
  res.status(405).json({
    error: 'Use POST /api/duo with JSON body { firstWikipediaUrl, secondWikipediaUrl, audienceProfile }.',
  })
})

app.post('/api/duo', async (req, res) => {
  try {
    const { firstWikipediaUrl, secondWikipediaUrl } = req.body ?? {}
    const audienceProfile = normalizeAudienceProfile(req.body?.audienceProfile)

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
      buildPersonaFromProfile(firstProfile, audienceProfile),
      buildPersonaFromProfile(secondProfile, audienceProfile),
    ])
    const conversation = await buildPreloadedDuoConversation(
      firstProfile,
      firstPersona,
      secondProfile,
      secondPersona,
      audienceProfile,
    )

    res.json({
      participants: [
        { profile: firstProfile, persona: firstPersona },
        { profile: secondProfile, persona: secondPersona },
      ],
      conversation,
    })
  } catch (error) {
    console.error('API /api/duo error:', error)
    const appError = toAppError(error, 'Unable to create a two-person conversation right now.')
    res.status(appError.statusCode).json({
      error: appError.message,
    })
  }
})

app.post('/api/duo-turn', async (req, res) => {
  try {
    const participants = Array.isArray(req.body?.participants) ? req.body.participants.slice(0, 2) : []
    const transcript = Array.isArray(req.body?.transcript) ? req.body.transcript : []
    const audienceProfile = normalizeAudienceProfile(req.body?.audienceProfile)

    if (participants.length !== 2) {
      return res.status(400).json({ error: 'Missing duo participants.' })
    }

    const maxTurns = Math.min(Number(req.body?.maxTurns) || 8, 8)

    if (transcript.length >= maxTurns) {
      return res.json({ done: true })
    }
    const nextTurn = await generateDuoTurn(participants, transcript, audienceProfile)

    res.json({
      done: transcript.length + 1 >= maxTurns,
      turn: nextTurn,
    })
  } catch (error) {
    const appError = toAppError(error, 'Unable to continue the duo conversation right now.')
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

app.get('/api/chat', (_req, res) => {
  res.status(405).json({
    error: 'Use POST /api/chat with JSON body { profile, persona, message, languageCode?, audienceProfile? }.',
  })
})

app.post('/api/chat', async (req, res) => {
  try {
    const { profile, persona, history, message, languageCode } = req.body ?? {}
    const audienceProfile = normalizeAudienceProfile(req.body?.audienceProfile || persona?.audienceProfile)

    if (!profile || !persona || !message) {
      return res.status(400).json({ error: 'Missing profile, persona, or message.' })
    }

    let reply

    try {
      reply = await generateText(
        chatPrompt(profile, persona, Array.isArray(history) ? history : [], message, languageCode, audienceProfile),
        SMART_PERSONA_TEXT_CONFIG,
      )
    } catch (replyError) {
      if (!isRetryableModelError(replyError)) {
        throw replyError
      }

      console.warn(`Chat model unavailable, using fallback reply: ${summarizeModelError(replyError)}`)
      reply = buildFallbackChatReply(profile, persona, message, languageCode, audienceProfile)
    }

    res.json({ reply })
  } catch (error) {
    console.error('API /api/chat error:', error)
    const appError = toAppError(error, 'Unable to generate a reply right now.')
    res.status(appError.statusCode).json({
      error: appError.message,
    })
  }
})

app.post('/api/opening', async (req, res) => {
  try {
    const { profile, persona, languageCode } = req.body ?? {}
    const audienceProfile = normalizeAudienceProfile(req.body?.audienceProfile || persona?.audienceProfile)

    if (!profile || !persona) {
      return res.status(400).json({ error: 'Missing profile or persona.' })
    }

    let openingMessage

    try {
      openingMessage = await generateText(
        openingPrompt(profile, persona, languageCode, audienceProfile),
        SMART_PERSONA_TEXT_CONFIG,
      )
    } catch (openingError) {
      console.warn(`Opening generation failed, using fallback opening: ${summarizeModelError(openingError)}`)
      openingMessage = buildFallbackOpeningMessage(profile, persona, languageCode, audienceProfile)
    }

    res.json({ openingMessage })
  } catch (error) {
    const appError = toAppError(error, 'Unable to generate an opening message right now.')
    res.status(appError.statusCode).json({
      error: appError.message,
    })
  }
})

app.listen(port, () => {
  console.log(`Persona server listening on http://localhost:${port}`)
})
