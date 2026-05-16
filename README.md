# WikiAI V3

`WikiAI V3` არის React + Vite + Express აპლიკაცია, რომელიც Wikipedia-ს საჯარო გვერდიდან ქმნის AI-პერსონას და ამ პერსონასთან ჩატს ხსნის. პროექტს ასევე აქვს ორი ადამიანის წინასწარ დაგენერირებული დიალოგის რეჟიმი, აუდიტორიის არჩევა (`adult` / `pupil`) და პერსონაზე მორგებული ვიზუალური თემა.

## რას აკეთებს საიტი

- იღებს Wikipedia URL-ს, მაგალითად `https://en.wikipedia.org/wiki/Marie_Curie`
- მოაქვს ადამიანის მოკლე ბიოგრაფიული ინფორმაცია Wikipedia-დან
- Gemini-ს საშუალებით აგენერირებს პერსონას, ტონს, თემებს, ენებს და გახსნის მესიჯს
- ხსნის ჩატს ამ პერსონასთან
- შეუძლია ორი განსხვავებული ადამიანის შორის წინასწარ შექმნილი დიალოგის დაგენერირებაც
- პერსონის სფეროს მიხედვით ქმნის ვიზუალურ თემას და ფონურ გამოსახულებას

## მთავარი ფუნქციები

### 1. Single Persona Mode

- ერთი Wikipedia გვერდიდან იქმნება ერთი პერსონა
- მომხმარებელი ირჩევს, ვინ დაიწყოს საუბარი: პერსონამ თუ თვითონ მომხმარებელმა
- მხარდაჭერილია რამდენიმე ენა, მათ შორის ინგლისური და საჭიროების შემთხვევაში ქართული
- დიალოგი რჩება Wikipedia-ს ბიოგრაფიულ კონტექსტზე მიბმული

### 2. Two-Person Mode

- ორი Wikipedia ბმულიდან იქმნება ორი განსხვავებული პერსონა
- სისტემა აგენერირებს წინასწარ მომზადებულ დიალოგს ამ ორ პერსონას შორის
- შედეგი ინახება ლოკალურ ისტორიაში და შესაძლებელია ხელახლა გახსნა

### 3. Audience Profiles

- `adult`: სტანდარტული, ბუნებრივი ტონი
- `pupil`: უფრო მარტივი, თბილი და განმარტებითი ტონი

### 4. Visual Personalization

- პერსონის პროფესიიდან/ბიოგრაფიიდან განისაზღვრება ვიზუალური კატეგორია
- ფერები, ბარათების სტილი და ფონი იცვლება პერსონაზე დაყრდნობით
- თუ ფონური სურათის გენერაცია ვერ მოხერხდა, გამოიყენება fallback გამოსახულება

### 5. Local History

- შექმნილი პერსონები ინახება `localStorage`-ში
- ინახება ორი-პერსონის დიალოგებიც
- შენახული ჩანაწერები UI-დან ხელახლა იტვირთება

## ტექნოლოგიები

- `React 19`
- `Vite`
- `Express 5`
- `@google/genai`
- `Wikipedia REST + MediaWiki APIs`

## პროექტის სტრუქტურა

```text
WikiAiV3/
├─ public/
│  ├─ fallbacks/            # სარეზერვო ფონური სურათები კატეგორიების მიხედვით
│  ├─ favicon.svg
│  ├─ icons.svg
│  └─ WikiAI.png
├─ src/ме
│  ├─ App.jsx               # ძირითადი UI, state და მომხმარებლის flow
│  ├─ App.css               # კომპონენტების სტილები
│  ├─ index.css             # გლობალური სტილები
│  └─ main.jsx              # React entry point
├─ dist/                    # build შედეგი
├─ server.js                # API, Gemini ინტეგრაცია და Wikipedia parsing
├─ vite.config.js           # Vite config + /api proxy
├─ .env                     # ლოკალური გარემოს ცვლადები
└─ .env.example             # example env ფაილი
```

## მოთხოვნები

- `Node.js 18+`
- `npm`
- `Gemini API key`

## დაყენება და გაშვება

1. დააინსტალირე პაკეტები:

```bash
npm install
```

2. შექმენი `.env` ფაილი:

```bash
copy .env.example .env
```

თუ Windows `copy` არ გამოიყენე, უბრალოდ შექმენი `.env` ხელით ამავე მნიშვნელობებით.

3. ჩაწერე Gemini API key:

```env
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-2.5-flash
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image-preview
PORT=8787
```

4. გაუშვი development რეჟიმში:

```bash
npm run dev
```

ეს ერთდროულად გაუშვებს:

- Vite frontend-ს
- Express backend-ს

ნაგულისხმევად:

- frontend: `http://localhost:5173`
- backend: `http://localhost:8787`

## ხელმისაწვდომი სკრიპტები

### `npm run dev`

ერთდროულად უშვებს frontend-ს და backend-ს.

### `npm run dev:client`

უშვებს მხოლოდ Vite client-ს.

### `npm run dev:server`

უშვებს მხოლოდ Node server-ს watcher-ით.

### `npm run build`

აკეთებს production build-ს `dist/` დირექტორიაში.

### `npm run preview`

აჩვენებს უკვე დაბილდულ frontend-ს.

### `npm start`

უშვებს `server.js`-ს production სტილში.

### `npm run lint`

ამოწმებს კოდს ESLint-ით.

## გარემოს ცვლადები

| ცვლადი | სავალდებულო | აღწერა |
|---|---|---|
| `GEMINI_API_KEY` | კი | Google Gemini API გასაღები |
| `GEMINI_MODEL` | არა | ტექსტური გენერაციის მოდელი. default: `gemini-2.5-flash` |
| `GEMINI_IMAGE_MODEL` | არა | ფონური სურათების გენერაციის მოდელი. default: `gemini-3.1-flash-image-preview` |
| `PORT` | არა | Express server port. default: `8787` |

## როგორ მუშაობს სისტემა

## Persona Flow

1. მომხმარებელი აწვდის Wikipedia URL-ს
2. `server.js` ამოწმებს URL-ს და გამოჰყავს სტატიის სათაური
3. ხდება Wikipedia summary + extract ტექსტის წამოღება
4. Gemini აგენერირებს:
   - `displayName`
   - `tagline`
   - `voice`
   - `talkingPoints`
   - `supportedLanguages`
   - `openingMessage`
   - `groundingNote`
   - `visualTheme`
5. სერვერი ამატებს ფონურ სურათს ან fallback სურათს
6. frontend ინახავს შედეგს ისტორიაში და ხსნის ჩატს

## Chat Flow

1. მომხმარებელი იწყებს ჩატს
2. თუ პირველი მესიჯი პერსონამ უნდა დაწეროს, frontend იძახებს `/api/opening`
3. ყოველ შემდეგ შეტყობინებაზე frontend იძახებს `/api/chat`
4. პასუხი მოდის არჩეულ ენაზე და პერსონის ტონალობაში

## Duo Flow

1. მომხმარებელი აწვდის ორ Wikipedia URL-ს
2. ორივე პროფილზე იქმნება ცალკე პერსონა
3. სისტემა აგენერირებს წინასწარ დიალოგს
4. შედეგი ნაჩვენებია transcript-ის სახით

## API Endpoints

### `GET /api/health`

აბრუნებს სერვერის სტატუსს და აქტიურ ტექსტურ მოდელს.

მაგალითი:

```json
{
  "ok": true,
  "model": "gemini-2.5-flash"
}
```

### `POST /api/persona`

ქმნის ერთ პერსონას Wikipedia ბმულიდან.

Request body:

```json
{
  "wikipediaUrl": "https://en.wikipedia.org/wiki/Marie_Curie",
  "audienceProfile": "adult"
}
```

### `POST /api/opening`

აგენერირებს ჩატის პირველ მესიჯს პერსონისგან.

### `POST /api/chat`

აგენერირებს ჩატის შემდეგ პასუხს.

### `POST /api/duo`

ქმნის ორ-პერსონიან დიალოგს.

Request body:

```json
{
  "firstWikipediaUrl": "https://en.wikipedia.org/wiki/Marie_Curie",
  "secondWikipediaUrl": "https://en.wikipedia.org/wiki/Albert_Einstein",
  "audienceProfile": "pupil"
}
```

### `POST /api/duo-turn`

განაგრძობს duo დიალოგს turn-by-turn რეჟიმში.

შენიშვნა: მიმდინარე UI ძირითადად იყენებს წინასწარ ჩატვირთულ (`preloaded`) დიალოგს, მაგრამ backend-ში ეს endpoint უკვე არსებობს.

### `POST /api/background`

აგენერირებს ან აბრუნებს შესაბამის ფონურ გამოსახულებას.

## Frontend მხარის შენახვა

`src/App.jsx` იყენებს `localStorage`-ს შემდეგი გასაღებებით:

- `wikipedia-persona-history`
- `wikipedia-duo-history`
- `wikipedia-audience-profile`

## დიზაინის ლოგიკა

- გლობალური სტილები არის `src/index.css`-ში
- ძირითადი UI სტილები არის `src/App.css`-ში
- თემა დინამიკურად იგება `visualTheme` ობიექტიდან
- ფერები და layout იცვლება პერსონის კატეგორიის მიხედვით

## შეცდომების დამუშავება

სერვერს აქვს რამდენიმე დაცვა:

- არასწორი Wikipedia URL ვალიდაცია
- Wikipedia-ს ცარიელი ან არასაკმარისი გვერდის ბლოკირება
- Gemini quota/retry მექანიზმი
- fallback persona / opening / reply / duo logic
- fallback background image

ეს ნიშნავს, რომ მოდელის დროებითი შეცდომის დროს აპი ყოველთვის არ “გაჩერდება” და ხშირად სარეზერვო პასუხით გააგრძელებს მუშაობას.

## მნიშვნელოვანი შენიშვნები

- აპი შექმნილია საჯარო ფიგურების Wikipedia გვერდებისთვის
- პასუხები უნდა დარჩეს ბიოგრაფიულ კონტექსტზე მიბმული
- ზოგი პასუხი მოდის fallback ლოგიკიდან, თუ მოდელი დროებით მიუწვდომელია
- ფონის სურათები ინახება `public/generated/` დირექტორიაში
- development proxy კონფიგურაცია წერია `vite.config.js`-ში

## რეკომენდებული მოდელები

- ტექსტი: `gemini-2.5-flash`
- სურათი: `gemini-3.1-flash-image-preview`

ეს კონფიგურაცია კარგად ერგება ამ პროექტს სიჩქარისა და ღირებულების ბალანსის გამო.

## სად შეცვლი რა ნაწილს

- UI/UX ცვლილებები: `src/App.jsx`, `src/App.css`, `src/index.css`
- API ლოგიკა: `server.js`
- proxy / dev server: `vite.config.js`
- სტატიკური asset-ები: `public/`

## მომავალი გაუმჯობესებების იდეები

- ნამდვილი turn-by-turn duo chat UI
- მრავალენოვანი UI ტექსტები
- ისტორიის export/import
- უკეთესი moderation layer
- unit/integration tests

