// ============================================================
// ReviewMeta — ReviewAgent "MetaRank": AI Agentic Engine
// (z-ai-web-dev-sdk, backend only)
//
// MISI: dari DESKRIPSI video buatan kreator, hasilkan SATU paket
// metadata SEO lengkap yang membuat algoritma media MANAPUN
// (TikTok, YouTube Shorts, Instagram Reels, Douyin) langsung
// MEMAHAMI maksud video & mudah MERANKING-nya.
//
// Arsitektur 5 tahap (mewarisi rigor ReviewAgent v3 OmniRank):
//   0. INTAKE     — normalisasi brief kreator (topik, detail, audiens,
//                   tone, platform target).
//   1. RECALL     — Neural Memory: pola hook/hashtag/formula TERBUKTI
//                   (skor tinggi) + bukti viral NYATA disuntikkan sebagai
//                   few-shot benchmark. Semakin sering studio dipakai,
//                   semakin tajam strategi agent.
//   2. STRATEGI   — LLM deep-thinking menghasilkan 6 kandidat hook
//                   (angle berbeda: curiosity-gap, pertanyaan, kontras,
//                   angka, negasi, relatabilitas) + SEMANTIC CORE
//                   (maksud video 1 kalimat mesin-friendly) + ENTITIES +
//                   paket publish per platform sesuai norma resmi
//                   masing-masing algoritma.
//   3. KRITIK     — TURNAMEN 2 fase (LATS + Debate): fase A skor rubrik
//                   semua kandidat → shortlist 3 finalis → fase B debat
//                   head-to-head → juara + revisi field lemah.
//   4. REFLEKSI   — Reflexion pattern: bila rubrik deterministik < 78,
//                   agent menerima feedback kegagalan dan merevisi field
//                   lemah, lalu re-validasi (maks 1 putaran).
//   5. VALIDASI   — rubrik deterministik 9 faktor transparan (HOOK 20,
//                   SEO 20, MAKSUD 15, ENTITY 10, TAGS 10, CTA 10,
//                   PLATFORM 10, KEYWORDS 5) + sanitasi hashtag +
//                   brand guard @review.picks + fallback berlapis.
//
// Kontrak: API TIDAK PERNAH gagal total — bila AI tumbang, fallback
// deterministik tetap menghasilkan paket yang layak pakai.
// ============================================================

import ZAI from "z-ai-web-dev-sdk"
import { ACCOUNT, captionSignatureLine } from "@/lib/account"
import { recallProvenQueries, recallStrategyContext } from "@/lib/learning/recall"
import { buildQueryMap, fallbackQueryMap, findQueryPlacements, type QueryMapSeed, type SearchQueryMap } from "@/lib/merge/seo"
import {
  PLATFORM_LABELS,
  TONE_LABELS,
  type MetaPackage,
  type MetaPlatformPackage,
  type MetaRequest,
  type MetaRubricItem,
  type MetaHookCandidate,
  type PlatformTarget,
} from "./types"

// ------------------------------------------------------------
// Timeout per tahap — agent yang menggantung tidak boleh membekukan API
// ------------------------------------------------------------
const STRATEGY_TIMEOUT_MS = 240_000
const CRITIQUE_SCORE_TIMEOUT_MS = 200_000
const CRITIQUE_DEBATE_TIMEOUT_MS = 200_000
const REFINE_TIMEOUT_MS = 200_000

/** Gate Reflexion: di bawah skor ini agent wajib merenung & merevisi */
export const META_REFLEXION_GATE = 78

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} melebihi ${Math.round(ms / 1000)} detik — coba lagi`)),
      ms
    )
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

// ------------------------------------------------------------
// Util parsing/sanitasi (pola sama dengan ReviewForge)
// ------------------------------------------------------------
function extractJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()
  const starts = [candidate.indexOf("{"), candidate.indexOf("[")]
    .filter((i) => i >= 0)
  if (starts.length === 0) return null
  const start = Math.min(...starts)
  const isArr = candidate[start] === "["
  const end = candidate.lastIndexOf(isArr ? "]" : "}")
  if (end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

function toStringArray(v: unknown, max: number, len = 80): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((s) => s.length > 0)
    .map((s) => (s.length > len ? s.slice(0, len) : s))
    .slice(0, max)
}

function wordsOverlap(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
  const wa = new Set(norm(a))
  return norm(b).some((w) => wa.has(w))
}

function containsAny(text: string, needles: string[]): string | null {
  const t = text.toLowerCase()
  for (const n of needles) {
    const nn = n.toLowerCase().trim()
    if (nn.length >= 3 && t.includes(nn)) return nn
  }
  return null
}

/** Tag generik tanpa nilai ranking — DILARANG (riset algoritma) */
const BANNED_TAGS = new Set([
  "fyp", "foryou", "foryoupage", "viral", "xyzbca", "tiktok", "trending",
  "fypシ", "fypシ゚viral", "4u", "foryoupage❤️", "rekomendasi_fyp", "parati",
])

/** Brand guard deterministik — caption wajib memuat kredit akun */
function applyBrandSignature(caption: string): string {
  if (caption.includes(ACCOUNT.handle)) return caption
  const lines = caption.split("\n")
  const lastTagLine = lines.reduce(
    (acc, l, i) => (l.trim().startsWith("#") ? Math.min(acc, i === lines.length - 1 ? i : i + 1) : acc),
    -1
  )
  const insertAt = lastTagLine >= 0 ? lastTagLine : lines.length
  lines.splice(insertAt, 0, captionSignatureLine())
  return lines.join("\n")
}

// ------------------------------------------------------------
// Kandidat strategi
// ------------------------------------------------------------
interface MetaCandidate {
  angle: string
  hook: string
  caption: string
  hashtags: string[]
}

interface MetaStrategy {
  primaryKeyword: string
  semanticCore: string
  entities: string[]
  category: string
  keywords: string[]
  coverText: string
  pinnedComment: string
  bestPostTime: string
  durationAdvice: string
  candidates: MetaCandidate[]
  platformPackages: MetaPlatformPackage[]
}

// ------------------------------------------------------------
// TAHAP 0 — INTAKE: brief terstruktur dari input kreator
// ------------------------------------------------------------
export interface MetaBrief {
  topic: string
  details: string
  audience: string
  tone: string
  platforms: PlatformTarget[]
  platformList: string
  language: string
}

function buildBrief(req: MetaRequest): MetaBrief {
  const platforms = req.platforms.length > 0 ? req.platforms : (["tiktok"] as PlatformTarget[])
  return {
    topic: req.topic.trim().slice(0, 600),
    details: (req.details ?? "").trim().slice(0, 1200),
    audience: (req.audience ?? "").trim().slice(0, 200) || ACCOUNT.audience,
    tone: TONE_LABELS[req.tone] ?? TONE_LABELS.review,
    platforms,
    platformList: platforms.map((p) => PLATFORM_LABELS[p]).join(", "),
    language: (req.language ?? "Indonesia").trim().slice(0, 30) || "Indonesia",
  }
}

// ------------------------------------------------------------
// TAHAP 2 — STRATEGI (deep thinking, 6 kandidat)
// ------------------------------------------------------------
const STRATEGY_SYSTEM = `Kamu adalah strategist SEO video elite Indonesia dengan lisensi penalaran penuh — berpikirlah berlapis sebelum menjawab. Tugasmu: merumuskan metadata yang membuat algoritma media MANAPUN langsung paham maksud video dan mudah meranking-nya. Basis risetmu (bukan opinion mainstream):

[EMBEDDING SEMANTIK LINTAS-PLATFORM — TikTok Sphinx · YouTube · Instagram] Semua platform besar mengubah video + teks menjadi vektor semantik. Semakin KONSISTEN keyword utama muncul di SEMUA permukaan yang dibaca mesin — judul, caption baris-1, hashtag, deskripsi — semakin yakin sistem mengklasifikasi konten → relevansi naik → peluang ranking naik.
[MAKSUD VIDEO — jangkar pemahaman] SEMANTIC CORE = 1 kalimat (subjek + manfaat + audiens) adalah cara TERCEPAT algoritma manapun memahami "video ini tentang apa". Rumuskan spesifik, bukan generik. WAJIB tercermin di baris-1 caption SETIAP platform.
[5 KARAKTER PERTAMA JUDUL — 抖音SEO] Karakter awal judul menentukan ranking pencarian. primaryKeyword WAJIB di paling depan judul/hook.
[RETENSI 2-5 DETIK — r/tiktok_reversing] Penonton yang swipe-away di detik awal menghentikan distribusi. Hook harus memaksa bertahan lewat detik 1-3.
[YOUTUBE SHORTS — help.google.com] Judul ≤100 karakter keyword-first; deskripsi kalimat penuh dengan keyword natural; HASHTAG TEPAT 3 — lebih dari itu semua diabaikan sistem.
[INSTAGRAM REELS — Instagram SEO] Baris-1 caption = hook + keyword (Reels diindeks via caption); 5-8 hashtag campuran broad+niche+intent; CTA simpan/share kuat dinilai ranking.
[TIKTOK — pencarian & NLP] Caption dibaca NLP; 3-4 hashtag (broad + niche + search-intent); CTA pertanyaan memancing komentar (sinyal ranking); keyword di baris-1.
[DOUYIN — 抖音SEO] Caption pendek tegas + 2-4 topik hashtag; gaya bahasa langsung.
[ENTITY — knowledge graph] Sebut nama brand/produk/model SECARA EKSPLISIT di judul & caption — sistem merepresentasikan konten sebagai entitas di graph topik; konten dengan entitas jelas lebih mudah dicocokkan ke query pencarian & minat penonton.
[HASHTAG] DILARANG generik tanpa nilai ranking: fyp, viral, foryou, foryoupage, xyzbca, trending.
[KEYWORD SEKUNDER] 6-10 frasa pencarian seperti DIKETIK pengguna nyata di search bar (2-4 kata, bahasa sehari-hari).
[NAMA FILE] slug kebab-case, 4-8 kata, primaryKeyword di depan.

[IDENTITAS AKUN — WAJIB] Output dipublikasikan di akun ${ACCOUNT.handle} — "${ACCOUNT.displayName}": ${ACCOUNT.niche}, untuk ${ACCOUNT.audience}. Suara akun: ${ACCOUNT.voice}.
- Bila brief membahas produk/barang/jasa → pakai angle review/rekomendasi khas akun; konten lain → tetap pertahankan gaya bahasa akun.
- SETIAP caption platform WAJIB memuat "${ACCOUNT.handle}" secara natural sebagai baris kredit SEBELUM baris hashtag (contoh: "Follow ${ACCOUNT.handle} buat rekomendasi lainnya").
- Sertakan 1 hashtag niche akun (mis. #reviewproduk / #rekomendasi) HANYA bila relevan dengan isi video.

Balas HANYA JSON valid.`

function platformNormLines(platforms: PlatformTarget[]): string {
  const norms: Record<PlatformTarget, string> = {
    tiktok: `{"platform":"TikTok","caption":"baris 1: primaryKeyword natural + hook maksud video; baris CTA PERTANYAAN; baris kredit \"@review.picks\"; baris terakhir TEPAT 3-4 hashtag #","hashtags":["3-4 tanpa #, broad+niche+intent"],"note":"1 catatan singkat khusus TikTok"}`,
    shorts: `{"platform":"YouTube Shorts","title":"judul keyword-first maksimal 100 karakter","caption":"deskripsi 2-4 kalimat PENUH dengan primaryKeyword di kalimat pertama + entitas + maksud video + ajakan tonton sampai habis + kredit @review.picks","hashtags":["TEPAT 3 tanpa #"],"note":"hashtag lebih dari 3 diabaikan sistem"}`,
    reels: `{"platform":"Instagram Reels","caption":"baris 1: hook + primaryKeyword (Reels diindeks via caption); 2-3 baris value + maksud video; CTA simpan/share; kredit @review.picks; baris terakhir 5-8 hashtag #","hashtags":["5-8 tanpa #, campuran broad+niche+intent"],"note":"1 catatan singkat khusus Reels"}`,
    douyin: `{"platform":"Douyin","caption":"judul pendek tegas dengan primaryKeyword + kalimat value + kredit @review.picks","hashtags":["2-4 tanpa #"],"note":""}`,
  }
  return platforms.map((p) => norms[p]).join(",\n    ")
}

async function generateStrategy(
  brief: MetaBrief,
  learnedContext: string,
  queryMap?: SearchQueryMap | null
): Promise<MetaStrategy> {
  const zai = await ZAI.create()

  // ===== v4 SearchRank — blok peta keyword pencarian =====
  const queryMapBlock = queryMap
    ? `
=== PETA KEYWORD PENCARIAN (short query — hasil pemetaan cara orang mencari) ===
produk terdeteksi: ${queryMap.product} (${queryMap.productType})
variasi sebutan: ${JSON.stringify(queryMap.aliases)}
SHORT QUERY YANG ORANG CARI (WAJIB dipakai — frasa PERSIS seperti diketik di search bar):
${queryMap.queries.map((q, i) => `${i + 1}. "${q.query}" [intent: ${q.intent}] — ${q.angle}`).join("\n")}
BLUEPRINT CAPTION (susun caption mengikuti struktur ini):
${queryMap.captionBlueprint.map((b) => `- ${b.line} → ${b.purpose}`).join("\n")}

ATURAN PETA QUERY (WAJIB — v4 SearchRank):
- primaryKeyword = query intent "beli" PERTAMA dari peta; kalau tidak ada → query pertama. DILARANG menciptakan keyword lain di luar peta.
- Caption WAJIB memuat MINIMAL 3 query dari peta secara natural — kalimat enak dibaca, dilarang asal disambung.
- hashtags: MINIMAL 2 tag dari query peta (spasi dihapus: "lap pengering mobil" → "lappengeringmobil").
- keywords array = SELURUH query peta (urut intent beli > solusi > info).
- SETIAP paket platform: baris/kalimat pertama memuat query utama.
`
    : ""

  const userPrompt = `Dari brief berikut, hasilkan PAKET METADATA SEO lengkap untuk video yang akan dipublish di ${brief.platformList}.

=== BRIEF KREATOR ===
Topik/maksud video: ${brief.topic}
Detail tambahan (produk/brand/poin penting): ${brief.details || "(tidak ada)"}
Target audiens: ${brief.audience}
Gaya penyampaian: ${brief.tone}
Bahasa output: ${brief.language}

=== PLATFORM TARGET ===
${brief.platformList}
${queryMapBlock}
${learnedContext ? `\n${learnedContext}\n` : ""}
JSON dengan struktur:
{
  "primaryKeyword": "1 frasa keyword pencarian UTAMA (2-4 kata, bahasa Indonesia, seperti diketik di search bar platform manapun)",
  "semanticCore": "MAKSUD VIDEO 1 kalimat: subjek + manfaat + audiens — spesifik, mesin-friendly, bukan generik",
  "entities": ["nama brand/produk/model/kategori yang disebut eksplisit — 1-5 entitas"],
  "category": "taksonomi konten, mis. 'elektronik > kulkas' atau 'skincare > sunscreen'",
  "keywords": ["6-10 frasa pencarian sekunder seperti diketik pengguna nyata"],
  "coverText": "teks cover grid profil — maksimal 30 karakter, kuat, mengandung keyword",
  "pinnedComment": "komentar yang akan dipin — pertanyaan terbuka / polling / debat ringan yang memancing balasan",
  "bestPostTime": "rentang jam WIB terbaik untuk audiens ini + alasan 1 kalimat",
  "durationAdvice": "saran durasi video berbasis completion rate untuk konten ini (1-2 kalimat)",
  "candidates": [
    {
      "angle": "curiosity-gap | pertanyaan | kontras/sebelum-sesudah | angka/listicle | negasi/miskonsepsi | relatabilitas",
      "hook": "judul hook maksimal 90 karakter — primaryKeyword di 5 KARAKTER PERTAMA",
      "caption": "caption TikTok-style 2-5 baris (pakai \\n): baris 1 primaryKeyword + maksud video, CTA pertanyaan, kredit \"@review.picks\", baris terakhir 3-4 hashtag #",
      "hashtags": ["3-4 tag tanpa #"]
    }
    // TEPAT 6 kandidat dengan ANGLES BERBEDA (urut): 1 curiosity-gap, 2 pertanyaan langsung, 3 kontras/sebelum-sesudah, 4 angka/listicle, 5 negasi/miskonsepsi ("jangan..."), 6 relatabilitas/emosi
  ],
  "platformPackages": [
    // HANYA untuk platform target berikut, sesuai norma resmi masing-masing:
    ${platformNormLines(brief.platforms)}
  ]
}

ATURAN WAJIB:
- SETIAP caption platform memuat primaryKeyword di baris/kaliman PERTAMA + maksud video eksplisit — konsistensi = keyakinan klasifikasi mesin.
- Entitas WAJIB disebut di judul/caption YouTube Shorts & minimal 1 platform lain.
- Panjang caption TikTok ≤ 500 karakter; deskripsi Shorts boleh lebih panjang; Douyin paling pendek.
- Semua teks dalam suara akun ${ACCOUNT.handle} — santai, jujur, to-the-point, bahasa ${brief.language}.`

  let lastError = "Strategi tidak valid"
  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: STRATEGY_SYSTEM },
          {
            role: "user",
            content: attempt === 0 ? userPrompt : `${userPrompt}\n\nPENTING: Balas HANYA JSON valid. TEPAT 6 kandidat.`,
          },
        ],
        // Deep thinking: strategi butuh penalaran rubrik ranking berlapis
        thinking: { type: "enabled" },
      }),
      STRATEGY_TIMEOUT_MS,
      "Strategi metadata"
    )
    const parsed = extractJson(completion.choices[0]?.message?.content ?? "")
    if (!parsed) continue

    const strategy = normalizeStrategy(parsed)
    if (strategy && strategy.candidates.length >= 2) {
      return strategy
    }
    lastError =
      strategy === null
        ? "Struktur strategi tidak valid"
        : `Kandidat kurang (${strategy.candidates.length})`
  }
  throw new Error(lastError)
}

function normalizeStrategy(parsed: Record<string, unknown>): MetaStrategy | null {
  const primaryKeyword = String(parsed.primaryKeyword ?? "").trim()
  if (!primaryKeyword) return null
  const raw = Array.isArray(parsed.candidates) ? parsed.candidates : []
  const candidates = raw
    .map(normalizeCandidate)
    .filter((c): c is MetaCandidate => c !== null)
    .slice(0, 6)
  if (candidates.length < 2) return null

  const packagesRaw = Array.isArray(parsed.platformPackages) ? parsed.platformPackages : []
  const platformPackages = packagesRaw
    .map(normalizePlatformPackage)
    .filter((p): p is MetaPlatformPackage => p !== null)
    .slice(0, 4)

  return {
    primaryKeyword,
    semanticCore: String(parsed.semanticCore ?? "").trim().slice(0, 300),
    entities: toStringArray(parsed.entities, 5),
    category: String(parsed.category ?? "").trim().slice(0, 100),
    keywords: toStringArray(parsed.keywords, 10),
    coverText: String(parsed.coverText ?? "").trim().slice(0, 40),
    pinnedComment: String(parsed.pinnedComment ?? "").trim().slice(0, 300),
    bestPostTime: String(parsed.bestPostTime ?? "").trim().slice(0, 200),
    durationAdvice: String(parsed.durationAdvice ?? "").trim().slice(0, 300),
    candidates,
    platformPackages,
  }
}

function normalizeCandidate(raw: unknown): MetaCandidate | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const hook = String(obj.hook ?? "").trim().slice(0, 150)
  const caption = String(obj.caption ?? "").trim().slice(0, 1200)
  if (!hook || !caption) return null
  return {
    angle: String(obj.angle ?? "umum").trim().slice(0, 60),
    hook,
    caption,
    hashtags: toStringArray(obj.hashtags, 8, 40).map((h) => h.replace(/^#/, "")),
  }
}

function normalizePlatformPackage(raw: unknown): MetaPlatformPackage | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const platform = String(obj.platform ?? "").trim().slice(0, 40)
  const caption = String(obj.caption ?? "").trim().slice(0, 1500)
  if (!platform || !caption) return null
  const title = String(obj.title ?? "").trim().slice(0, 120)
  return {
    platform,
    ...(title ? { title } : {}),
    caption,
    hashtags: toStringArray(obj.hashtags, 8, 40).map((h) => h.replace(/^#/, "")),
    ...(String(obj.note ?? "").trim() ? { note: String(obj.note).trim().slice(0, 200) } : {}),
  }
}

// ------------------------------------------------------------
// TAHAP 3 — KRITIK: turnamen 2 fase (skor rubrik → debat finalis)
// ------------------------------------------------------------
const CRITIQUE_SCORE_SYSTEM = `Kamu adalah juri kelompok untuk metadata video vertikal — objektif, berbasis rubrik riset, tidak peduli selera. Metadata ini akan dipakai agar algoritma media manapun memahami maksud video dan meranking-nya. Konten dipublikasikan di akun ${ACCOUNT.handle} — "${ACCOUNT.displayName}" (${ACCOUNT.niche}); nilai keselarasan suara akun sebagai pertimbangan kualitatif. Beri skor 0-100 untuk SETIAP kandidat secara independen. Jawab HANYA JSON valid.`

const CRITIQUE_DEBATE_SYSTEM = `Kamu adalah kritikus brutal namun objektif untuk metadata video. Tiga finalis berdebat di "ruang kritik" internmu — simulasi argumen pro-kontra SETIAP finalis terhadap rubrik ranking lintas-platform, lalu tentukan juara. Metadata dipublikasikan di akun ${ACCOUNT.handle} — "${ACCOUNT.displayName}": pemenang harus paling mudah DIPAHAMI algoritma manapun dan paling terasa KHAS akun ini. Kamu boleh MEMPERBAIKI bagian lemah (revisi, bukan menolak semuanya). Balas HANYA JSON valid.`

async function scoreCandidates(
  candidates: MetaCandidate[],
  brief: MetaBrief,
  primaryKeyword: string,
  semanticCore: string
): Promise<number[]> {
  const zai = await ZAI.create()
  const list = candidates
    .map(
      (c, i) =>
        `Kandidat ${i + 1} (${c.angle}):\nhook: ${c.hook}\ncaption: ${c.caption.split("\n").join(" | ").slice(0, 300)}`
    )
    .join("\n\n")

  try {
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: CRITIQUE_SCORE_SYSTEM },
          {
            role: "user",
            content: `primaryKeyword: ${primaryKeyword}\nmaksud video (semantic core): ${semanticCore || "(belum dirumuskan — nilai dari kejelasan hook)"}\nplatform target: ${brief.platformList}\n\n${list}\n\nNilai SETIAP kandidat berdasarkan: (1) kekuatan hook 2-5 detik pertama, (2) primaryKeyword di posisi strategis (awal hook/caption), (3) kejelasan maksud video, (4) potensi ranking pencarian lintas-platform, (5) keselarasan suara akun.\n\nJSON: {"scores": [{"index": 1, "score": 0-100, "reason": "1 kalimat"}, ...]} — index mulai dari 1 sesuai nomor kandidat.`,
          },
        ],
        thinking: { type: "disabled" },
      }),
      CRITIQUE_SCORE_TIMEOUT_MS,
      "Juri rubrik"
    )
    const parsed = extractJson(completion.choices[0]?.message?.content ?? "")
    const scores = new Map<number, number>()
    if (parsed && Array.isArray(parsed.scores)) {
      for (const s of parsed.scores) {
        if (s && typeof s === "object") {
          const idx = Number((s as Record<string, unknown>).index)
          const val = Number((s as Record<string, unknown>).score)
          if (Number.isFinite(idx) && Number.isFinite(val)) {
            scores.set(idx - 1, Math.max(0, Math.min(100, Math.round(val))))
          }
        }
      }
    }
    return candidates.map((_, i) => scores.get(i) ?? 0)
  } catch {
    // juri tumbang → skor netral 50 supaya turnamen tetap jalan deterministik
    return candidates.map(() => 50)
  }
}

async function debateFinalists(
  finalists: { candidate: MetaCandidate; score: number }[],
  brief: MetaBrief,
  primaryKeyword: string
): Promise<{ winnerIndex: number; revisedHook?: string; revisedCaption?: string }> {
  const zai = await ZAI.create()
  const list = finalists
    .map(
      (f, i) =>
        `Finalis ${i + 1} (${f.candidate.angle}, skor juri ${f.score}):\nhook: ${f.candidate.hook}\ncaption: ${f.candidate.caption}`
    )
    .join("\n\n")

  try {
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: CRITIQUE_DEBATE_SYSTEM },
          {
            role: "user",
            content: `primaryKeyword: ${primaryKeyword}\nplatform target: ${brief.platformList}\nsuara akun: ${ACCOUNT.voice}\n\n${list}\n\nDebatkan pro-kontra SETIAP finalis terhadap rubrik ranking (hook retensi, keyword placement, kejelasan maksud, kekhasan suara akun), lalu pilih juara. Bila ada bagian lemah pada juara, PERBAIKI di revisi (hook maksimal 90 karakter, primaryKeyword tetap di awal).\n\nJSON: {"winnerIndex": 1-3, "reasoning": "1-2 kalimat kenapa juara", "revisedHook": "revisi hook juara bila perlu, else string kosong", "revisedCaption": "revisi caption juara bila perlu, else string kosong"}`,
          },
        ],
        thinking: { type: "enabled" },
      }),
      CRITIQUE_DEBATE_TIMEOUT_MS,
      "Debat finalis"
    )
    const parsed = extractJson(completion.choices[0]?.message?.content ?? "")
    if (!parsed) return { winnerIndex: 0 }
    const idx = Number(parsed.winnerIndex)
    const winnerIndex = Number.isFinite(idx) && idx >= 1 && idx <= finalists.length ? idx - 1 : 0
    const revisedHook = String(parsed.revisedHook ?? "").trim().slice(0, 150)
    const revisedCaption = String(parsed.revisedCaption ?? "").trim().slice(0, 1200)
    return {
      winnerIndex,
      ...(revisedHook ? { revisedHook } : {}),
      ...(revisedCaption ? { revisedCaption } : {}),
    }
  } catch {
    return { winnerIndex: 0 }
  }
}

// ------------------------------------------------------------
// TAHAP 4 — REFLEKSI (Reflexion pattern)
// ------------------------------------------------------------
const REFINE_SYSTEM = `Kamu adalah agen refleksi untuk metadata video yang baru GAGAL rubrik kualitas. Kamu menerima: field saat ini + daftar kegagalan rubrik. Perbaiki HANYA field yang terkait kegagalan — field yang sudah baik TIDAK boleh diubah (tulis string kosong ""). Suara akun: ${ACCOUNT.voice} (${ACCOUNT.handle}). Jawab HANYA JSON valid.`

async function refineWeakFields(input: {
  title: string
  semanticCore: string
  tiktokCaption: string
  primaryKeyword: string
  failures: { id: string; detail: string }[]
}): Promise<{ title?: string; semanticCore?: string; caption?: string }> {
  const zai = await ZAI.create()
  try {
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: REFINE_SYSTEM },
          {
            role: "user",
            content: `primaryKeyword (WAJIB tetap di posisi strategis): ${input.primaryKeyword}\n\nFIELD SAAT INI:\ntitle: ${input.title}\nsemanticCore: ${input.semanticCore}\ncaption TikTok: ${input.tiktokCaption.slice(0, 600)}\n\nKEGAGALAN RUBRIK:\n${input.failures.map((f) => `- [${f.id}] ${f.detail}`).join("\n")}\n\nPerbaiki field terkait. JSON: {"title": "revisi atau \"\"", "semanticCore": "revisi atau \"\"", "caption": "revisi atau \"\""}`,
          },
        ],
        thinking: { type: "enabled" },
      }),
      REFINE_TIMEOUT_MS,
      "Refleksi metadata"
    )
    const parsed = extractJson(completion.choices[0]?.message?.content ?? "")
    if (!parsed) return {}
    const out: { title?: string; semanticCore?: string; caption?: string } = {}
    const t = String(parsed.title ?? "").trim()
    const s = String(parsed.semanticCore ?? "").trim()
    const c = String(parsed.caption ?? "").trim()
    if (t) out.title = t.slice(0, 150)
    if (s) out.semanticCore = s.slice(0, 300)
    if (c) out.caption = c.slice(0, 1200)
    return out
  } catch {
    return {}
  }
}

// ------------------------------------------------------------
// TAHAP 5 — VALIDASI: rubrik deterministik 9 faktor (100 poin)
// ------------------------------------------------------------
const NORM_HASHTAG: Record<string, [number, number]> = {
  // platform → [min, max] norma resmi
  tiktok: [3, 4],
  "youtube shorts": [3, 3],
  "instagram reels": [5, 8],
  douyin: [2, 4],
}

function sanitizeHashtags(tags: string[], kwFirst: string): string[] {
  const seen = new Set<string>()
  return tags
    .map((h) => h.replace(/^#/, "").trim().toLowerCase().replace(/\s+/g, ""))
    .filter((h) => {
      if (!h || h.length > 30 || BANNED_TAGS.has(h) || seen.has(h)) return false
      seen.add(h)
      return true
    })
    // dorong tag niche: yang mengandung keyword naik prioritas
    .sort((a, b) => Number(b.includes(kwFirst.replace(/\s+/g, ""))) - Number(a.includes(kwFirst.replace(/\s+/g, ""))))
}

function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/^@?\s*/, "").trim()
}

export interface MetaValidationResult {
  pkg: MetaPackage
  rubric: MetaRubricItem[]
  failures: { id: string; detail: string }[]
}

function validateAndScore(
  strategy: MetaStrategy,
  winner: MetaCandidate,
  brief: MetaBrief,
  overrides: { hook?: string; caption?: string; semanticCore?: string } | null,
  debate: { revisedHook?: string; revisedCaption?: string } | null,
  memoryCount: number,
  trace: string[],
  queryMap?: SearchQueryMap | null
): MetaValidationResult {
  const kw = strategy.primaryKeyword.toLowerCase()
  const kwFirst = kw.split(" ")[0] ?? kw
  const title = (overrides?.hook || debate?.revisedHook || winner.hook).slice(0, 150)
  const semanticCore = (overrides?.semanticCore || strategy.semanticCore || "").slice(0, 300)
  const winnerCaption = overrides?.caption || debate?.revisedCaption || winner.caption

  // Caption TikTok final: dari paket platform bila ada, else caption kandidat
  const tiktokPkg = strategy.platformPackages.find((p) => normalizePackageName(p.platform).includes("tiktok"))
  const tiktokCaptionRaw = tiktokPkg?.caption ?? winnerCaption

  const rubric: MetaRubricItem[] = []
  const failures: { id: string; detail: string }[] = []
  let score = 0

  // HOOK (18) — retensi 2-5 detik pertama
  const hookHasQuestion = /\?/.test(title)
  const hookHasContrast = /(jangan|jangan sampai|bukan|sebelum|sesudah|ternyata|ini kenapa)/i.test(title)
  const hookLen = title.length
  let hookScore = 0
  const hookDetails: string[] = []
  if (hookHasQuestion || hookHasContrast) {
    hookScore += 9
    hookDetails.push("ada pertanyaan/kontras")
  } else {
    hookDetails.push("TIDAK ada pertanyaan/kontras")
    failures.push({ id: "HOOK", detail: "hook tanpa pertanyaan/kontras — tambahkan pemicu rasa penasaran" })
  }
  if (/\d/.test(title)) {
    hookScore += 4
    hookDetails.push("ada angka")
  }
  if (hookLen >= 25 && hookLen <= 90) {
    hookScore += 5
    hookDetails.push(`panjang ${hookLen} karakter ideal`)
  } else {
    hookDetails.push(`panjang ${hookLen} karakter (ideal 25-90)`)
    failures.push({ id: "HOOK", detail: `panjang hook ${hookLen} karakter di luar ideal 25-90` })
  }
  score += hookScore
  rubric.push({ id: "HOOK", label: "Hook Retensi", score: hookScore, max: 18, detail: hookDetails.join(", ") })

  // SEO (18) — penempatan keyword
  let seoScore = 0
  const seoDetails: string[] = []
  if (title.toLowerCase().slice(0, 12).includes(kwFirst)) {
    seoScore += 7
    seoDetails.push("keyword di 12 karakter awal judul")
  } else {
    seoDetails.push("keyword TIDAK di awal judul")
    failures.push({ id: "SEO", detail: "primaryKeyword belum di 12 karakter awal judul" })
  }
  if (title.toLowerCase().includes(kw)) {
    seoScore += 4
    seoDetails.push("frasa keyword utuh di judul")
  }
  const firstCaptionLine = tiktokCaptionRaw.split(/\r?\n/)[0]?.toLowerCase() ?? ""
  if (firstCaptionLine.includes(kwFirst)) {
    seoScore += 4
    seoDetails.push("keyword di baris 1 caption")
  } else {
    seoDetails.push("keyword TIDAK di baris 1 caption")
    failures.push({ id: "SEO", detail: "primaryKeyword tidak ada di baris pertama caption" })
  }
  if (strategy.coverText.toLowerCase().includes(kwFirst)) {
    seoScore += 3
    seoDetails.push("keyword di cover text")
  } else {
    seoDetails.push("cover TIDAK mengandung keyword")
  }
  score += seoScore
  rubric.push({ id: "SEO", label: "SEO Pencarian", score: seoScore, max: 18, detail: seoDetails.join(", ") })

  // MAKSUD (13) — kejelasan maksud untuk SEMUA algoritma
  let meaningScore = 0
  const meaningDetails: string[] = []
  if (semanticCore.length >= 20) {
    meaningScore += 5
    meaningDetails.push("maksud video dirumuskan eksplisit (semantic core)")
  } else {
    meaningDetails.push("semantic core kosong/terlalu pendek")
    failures.push({ id: "MAKSUD", detail: "semantic core belum dirumuskan eksplisit (min 20 karakter)" })
  }
  if (wordsOverlap(title, semanticCore || brief.topic)) {
    meaningScore += 4
    meaningDetails.push("judul menyampaikan maksud video")
  } else {
    meaningDetails.push("judul TIDAK mencerminkan maksud video")
    failures.push({ id: "MAKSUD", detail: "judul tidak selaras dengan maksud video" })
  }
  const captionEntityHit = containsAny(tiktokCaptionRaw, strategy.entities)
  if (captionEntityHit) {
    meaningScore += 4
    meaningDetails.push(`entitas "${captionEntityHit}" hadir di caption`)
  } else {
    meaningDetails.push(
      strategy.entities.length > 0 ? "entitas TIDAK hadir di caption" : "tidak ada entitas teridentifikasi"
    )
    if (strategy.entities.length > 0) {
      failures.push({ id: "MAKSUD", detail: "entitas produk/brand tidak muncul di caption" })
    }
  }
  score += meaningScore
  rubric.push({ id: "MAKSUD", label: "Kejelasan Maksud", score: meaningScore, max: 13, detail: meaningDetails.join(", ") })

  // ENTITY (9) — jangkar knowledge graph
  let entityScore = 0
  const entityDetails: string[] = []
  if (strategy.entities.length > 0) {
    entityScore += 3
    entityDetails.push(`${strategy.entities.length} entitas teridentifikasi`)
  } else {
    entityDetails.push("tidak ada entitas (konten tanpa produk/brand)")
  }
  if (containsAny(title, strategy.entities)) {
    entityScore += 4
    entityDetails.push("entitas di judul")
  } else if (strategy.entities.length > 0) {
    entityDetails.push("judul TIDAK menyebut entitas")
  }
  const keywordBlob = [strategy.primaryKeyword, ...strategy.keywords].join(" ").toLowerCase()
  if (containsAny(keywordBlob, strategy.entities)) {
    entityScore += 2
    entityDetails.push("entitas di keyword pencarian")
  } else if (strategy.entities.length > 0) {
    entityDetails.push("keyword TIDAK memuat entitas")
  }
  score += entityScore
  rubric.push({ id: "ENTITY", label: "Sinyal Entitas", score: entityScore, max: 9, detail: entityDetails.join(", ") })

  // TAGS (8) — kepatuhan norma hashtag per platform
  const requestedLabels = brief.platforms.map((p) => PLATFORM_LABELS[p].toLowerCase())
  let tagScore = 0
  const tagDetails: string[] = []
  const tagChecks: string[] = []
  for (const pkg of strategy.platformPackages) {
    const name = normalizePackageName(pkg.platform)
    const normKey = Object.keys(NORM_HASHTAG).find((k) => name.includes(k))
    if (!normKey || !requestedLabels.some((r) => name.includes(r))) continue
    const [min, max] = NORM_HASHTAG[normKey]
    const count = pkg.hashtags.length
    const ok = count >= min && count <= max
    tagChecks.push(`${PLATFORM_LABELS[brief.platforms.find((p) => PLATFORM_LABELS[p].toLowerCase() === normKey) ?? "tiktok"] ?? pkg.platform}: ${count} tag ${ok ? "sesuai norma" : `di luar norma ${min}-${max}`}`)
    if (ok) tagScore += Math.ceil(6 / Math.max(1, strategy.platformPackages.length))
  }
  // score kandidat juara (fallback TikTok)
  const winnerTags = sanitizeHashtags(winner.hashtags, kwFirst)
  if (winnerTags.length >= 3 && winnerTags.length <= 4) tagScore += 4
  else tagScore += 1
  tagDetails.push(...(tagChecks.length > 0 ? tagChecks : ["paket platform tidak tersedia"]))
  if (tagChecks.length === 0) {
    failures.push({ id: "TAGS", detail: "paket hashtag per platform tidak lengkap" })
  }
  score += Math.min(8, Math.round(tagScore * 0.8))
  rubric.push({ id: "TAGS", label: "Norma Hashtag", score: Math.min(8, Math.round(tagScore * 0.8)), max: 8, detail: tagDetails.join(", ") })

  // CTA (9) — share > komentar > like
  const bodyCaption = tiktokCaptionRaw.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join(" ")
  let ctaScore = 0
  const ctaDetails: string[] = []
  if (/\?/.test(bodyCaption)) {
    ctaScore += 6
    ctaDetails.push("CTA pertanyaan di caption")
  } else {
    ctaDetails.push("TIDAK ada CTA pertanyaan di caption")
    failures.push({ id: "CTA", detail: "caption tanpa CTA pertanyaan pemicu komentar" })
  }
  if (strategy.pinnedComment) {
    ctaScore += 3
    ctaDetails.push("komentar pin tersedia")
  } else {
    ctaDetails.push("komentar pin kosong")
    failures.push({ id: "CTA", detail: "komentar pin kosong" })
  }
  score += ctaScore
  rubric.push({ id: "CTA", label: "CTA Interaksi", score: ctaScore, max: 9, detail: ctaDetails.join(", ") })

  // PLATFORM (10) — cakupan + konsistensi keyword baris-1
  const requestedCount = brief.platforms.length
  let platformScore = 0
  const platformDetails: string[] = []
  let covered = 0
  let kwConsistent = 0
  for (const target of brief.platforms) {
    const label = PLATFORM_LABELS[target]
    const pkg = strategy.platformPackages.find((p) => normalizePackageName(p.platform).includes(label.toLowerCase()))
    if (!pkg) continue
    covered += 1
    const firstLine = pkg.caption.split(/\r?\n/)[0]?.toLowerCase() ?? ""
    if (firstLine.includes(kwFirst)) kwConsistent += 1
  }
  platformScore += Math.round((covered / Math.max(1, requestedCount)) * 6)
  platformScore += Math.round((kwConsistent / Math.max(1, requestedCount)) * 4)
  platformDetails.push(
    `${covered}/${requestedCount} platform tercakup, ${kwConsistent}/${requestedCount} baris-1 mengandung keyword`
  )
  if (covered < requestedCount) {
    failures.push({ id: "PLATFORM", detail: `paket platform kurang (${covered}/${requestedCount})` })
  }
  score += platformScore
  rubric.push({ id: "PLATFORM", label: "Konsistensi Platform", score: platformScore, max: 10, detail: platformDetails.join(", ") })

  // KEYWORDS (5) — frasa pencarian sekunder
  let kwScore = 0
  const kwDetails: string[] = []
  if (strategy.keywords.length >= 6) {
    kwScore = 5
    kwDetails.push(`${strategy.keywords.length} keyword sekunder`)
  } else if (strategy.keywords.length >= 3) {
    kwScore = 3
    kwDetails.push(`${strategy.keywords.length} keyword sekunder (ideal ≥6)`)
    failures.push({ id: "KEYWORDS", detail: `keyword sekunder hanya ${strategy.keywords.length} (ideal 6-10)` })
  } else {
    kwDetails.push(`keyword sekunder ${strategy.keywords.length} — terlalu sedikit`)
    failures.push({ id: "KEYWORDS", detail: `keyword sekunder hanya ${strategy.keywords.length} (ideal 6-10)` })
  }
  score += kwScore
  rubric.push({ id: "KEYWORDS", label: "Keyword Pencarian", score: kwScore, max: 5, detail: kwDetails.join(", ") })

  // QUERIES (10) — v4 SearchRank: coverage short-query lintas permukaan
  const qList = queryMap?.queries.map((q) => q.query) ?? []
  let queryScore = 0
  const queryDetails: string[] = []
  if (qList.length === 0) {
    queryDetails.push("peta query tidak tersedia")
  } else {
    const allHashtags = strategy.platformPackages.flatMap((p) => p.hashtags)
    const querySurfaces = {
      title,
      caption: [tiktokCaptionRaw, ...strategy.platformPackages.map((p) => p.caption)].join("\n"),
      hashtags: allHashtags,
      overlays: [],
      filename: strategy.primaryKeyword,
      keywords: Array.from(new Set([...qList, strategy.primaryKeyword, ...strategy.keywords])),
    }
    const placements = qList.map((q) => ({ q, where: findQueryPlacements(q, querySurfaces) }))
    const foundCount = placements.filter((p) => p.where.length > 0).length
    const missing = placements.filter((p) => p.where.length === 0).map((p) => p.q)
    if (foundCount >= 3) {
      queryScore = 10
      queryDetails.push(`${foundCount}/${qList.length} query terpetakan hadir di metadata`)
    } else if (foundCount === 2) {
      queryScore = 6
      queryDetails.push(`hanya 2/${qList.length} query hadir — target minimal 3`)
      failures.push({ id: "QUERIES", detail: `minimal 3 query peta harus hadir di judul/caption/hashtag/keywords — baru ${foundCount}` })
    } else if (foundCount === 1) {
      queryScore = 3
      queryDetails.push(`hanya 1/${qList.length} query hadir — target minimal 3`)
      failures.push({ id: "QUERIES", detail: `minimal 3 query peta harus hadir di metadata — baru 1` })
    } else {
      queryDetails.push("TIDAK ada query peta yang hadir di metadata")
      failures.push({ id: "QUERIES", detail: "tanamkan minimal 3 query dari peta di judul/caption/hashtag/keywords" })
    }
    if (missing.length > 0) queryDetails.push(`belum ditanam: ${missing.slice(0, 3).join(", ")}`)
  }
  score += queryScore
  rubric.push({ id: "QUERIES", label: "Peta Query", score: queryScore, max: 10, detail: queryDetails.join(", ") })

  // ---- Rakit paket final ----
  const hookCandidates: MetaHookCandidate[] = strategy.candidates.map((c) => ({
    hook: c.hook,
    angle: c.angle,
    score: 0,
  }))

  const packages: MetaPlatformPackage[] = strategy.platformPackages.map((p) => ({
    ...p,
    caption: applyBrandSignature(p.caption),
    hashtags: sanitizeHashtags(p.hashtags, kwFirst),
  }))

  // Bila target platform tak tercakup paket AI → sintesis dari kandidat juara
  for (const target of brief.platforms) {
    const label = PLATFORM_LABELS[target]
    if (packages.some((p) => normalizePackageName(p.platform).includes(label.toLowerCase()))) continue
    packages.push({
      platform: label,
      caption: applyBrandSignature(winnerCaption),
      hashtags: sanitizeHashtags(winner.hashtags.length > 0 ? winner.hashtags : strategy.keywords.slice(0, 4), kwFirst),
      note: "Disintesis agent dari kandidat juara (paket AI platform tidak tersedia)",
    })
  }

  const finalTikTokPkg = packages.find((p) => normalizePackageName(p.platform).includes("tiktok"))
  const finalCaption = finalTikTokPkg?.caption ?? applyBrandSignature(winnerCaption)

  const fileName =
    strategy.primaryKeyword
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "") || "video-review-picks"

  const pkg: MetaPackage = {
    semanticCore: semanticCore || brief.topic.slice(0, 200),
    primaryKeyword: strategy.primaryKeyword,
    entities: strategy.entities,
    category: strategy.category,
    title,
    hookCandidates,
    platformPackages: packages,
    keywords: Array.from(new Set([...(queryMap?.queries.map((q) => q.query) ?? []), ...strategy.keywords])).slice(0, 12),
    coverText: strategy.coverText,
    pinnedComment: strategy.pinnedComment,
    bestPostTime: strategy.bestPostTime,
    ...(strategy.durationAdvice ? { durationAdvice: strategy.durationAdvice } : {}),
    seoScore: Math.max(0, Math.min(100, score)),
    rubricBreakdown: rubric,
    agentTrace: trace,
    refinementRounds: 0,
    memoryCount,
    fileName,
    // caption TikTok final juga disediakan di paketnya sendiri
    // ===== v4 SearchRank — Peta Keyword Pencarian =====
    ...(queryMap ? { queryMap } : {}),
  }

  return { pkg, rubric, failures }
}

// ------------------------------------------------------------
// FALLBACK deterministik — kontrak: API tidak pernah gagal total
// ------------------------------------------------------------
function fallbackPackage(brief: MetaBrief, trace: string[], memoryCount: number): MetaPackage {
  const topic = brief.topic
  const kw = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .slice(0, 3)
    .join(" ")
    .trim() || "video rekomendasi"
  const kwTitle = kw.replace(/\b\w/g, (m) => m.toUpperCase())

  const caption = applyBrandSignature(
    [`${kwTitle} — ${topic.slice(0, 120)}`, "Menurut kamu mana yang paling worth it? Tulis di komentar!", captionSignatureLine(), "#reviewproduk #rekomendasi #reviewjujur"].join("\n")
  )

  const packages: MetaPlatformPackage[] = brief.platforms.map((p) => {
    const label = PLATFORM_LABELS[p]
    return {
      platform: label,
      ...(p === "shorts" ? { title: `${kwTitle} | Review Jujur`.slice(0, 100) } : {}),
      caption,
      hashtags: p === "reels" ? ["reviewproduk", "rekomendasi", "reviewjujur", "tipsbelanja", "budgeting"] : ["reviewproduk", "rekomendasi", "reviewjujur"],
      note: "Mode fallback — AI strategi sedang tidak tersedia, paket dirakit deterministik.",
    }
  })

  return {
    semanticCore: `Video ${brief.tone.toLowerCase()} tentang ${topic.slice(0, 150)} untuk ${brief.audience}.`,
    primaryKeyword: kw,
    entities: [],
    category: "",
    title: `${kwTitle} — Cek Sebelum Beli!`.slice(0, 150),
    hookCandidates: [],
    platformPackages: packages,
    keywords: [kw, `${kw} review`, `${kw} rekomendasi`, `${kw} terbaik`, `${kw} 2025`, `${kw} worth it`],
    coverText: kwTitle.slice(0, 30),
    pinnedComment: "Kalian tim mana? Jawab di komentar — aku bales semua!",
    bestPostTime: "18:00-21:00 WIB — jam sibuk scroll after-work untuk audiens belanja.",
    durationAdvice: "Jaga 15-45 detik — durasi ini paling mudah ditonton sampai habis (completion rate tinggi).",
    seoScore: 55,
    rubricBreakdown: [
      { id: "FALLBACK", label: "Mode Fallback", score: 55, max: 100, detail: "AI strategi tidak merespons — paket minimal deterministik tetap dihasilkan." },
    ],
    agentTrace: [...trace, "FALLBACK: paket deterministik dihasilkan tanpa AI"],
    refinementRounds: 0,
    memoryCount,
    fallback: true,
    fileName: kw.replace(/\s+/g, "-") || "video-review-picks",
  }
}

// ------------------------------------------------------------
// ORKESTRATOR — 5 tahap agent
// ------------------------------------------------------------
export interface MetaAgentResult {
  pkg: MetaPackage
  fallback: boolean
}

export async function runMetaAgent(req: MetaRequest): Promise<MetaAgentResult> {
  const brief = buildBrief(req)
  const trace: string[] = []
  const t0 = Date.now()

  // TAHAP 1 — RECALL Neural Memory
  let memoryCount = 0
  let learnedContext = ""
  try {
    learnedContext = await recallStrategyContext()
    memoryCount = learnedContext
      ? (learnedContext.match(/^\[/gm)?.length ?? 0)
      : 0
    trace.push(
      memoryCount > 0
        ? `RECALL: ${memoryCount} blok pengetahuan Neural Memory dipakai sebagai benchmark`
        : "RECALL: memori masih kosong — agent jalan dengan basis riset"
    )
  } catch {
    trace.push("RECALL: memori tidak tersedia — lanjut tanpa few-shot")
  }

  // TAHAP 1b — QUERY MAP (v4 SearchRank): petakan short query yang orang cari.
  // Self-learning: query set terbukti di-recall sebagai referensi pola ketik.
  let queryMap: SearchQueryMap | null = null
  {
    const seed: QueryMapSeed = {
      coreSubject: brief.topic,
      entities: [],
      searchIntents: [],
      extraContext: [brief.details, brief.tone ? `tone: ${brief.tone}` : "", brief.audience ? `audiens: ${brief.audience}` : ""]
        .filter(Boolean)
        .join("\n"),
    }
    try {
      const proven = await recallProvenQueries()
      queryMap = await buildQueryMap(seed, proven)
      trace.push(
        `QUERY MAP: produk "${queryMap.product}" (${queryMap.productType}) — ${queryMap.queries.length} short query: ${queryMap.queries.map((q) => `"${q.query}"[${q.intent}]`).join(", ")}${proven.length > 0 ? ` · belajar dari ${proven.length} query terbukti` : ""}`
      )
    } catch {
      queryMap = fallbackQueryMap(seed)
      trace.push(`QUERY MAP: AI gagal — paket darurat ${queryMap.queries.length} query dari brief`)
    }
  }

  // TAHAP 2 — STRATEGI
  const strategy = await (async () => {
    try {
      const r = await generateStrategy(brief, learnedContext, queryMap)
      trace.push(
        `STRATEGI: ${r.candidates.length} kandidat hook dihasilkan (${Math.round((Date.now() - t0) / 1000)}s) — keyword "${r.primaryKeyword}"`
      )
      return r
    } catch {
      trace.push("STRATEGI: gagal — beralih ke fallback deterministik")
      throw new Error("strategy-failed")
    }
  })()

  // TAHAP 3 — KRITIK (turnamen 2 fase)
  let winnerIndex = 0
  let debate: { revisedHook?: string; revisedCaption?: string } = {}
  try {
    const scores = await scoreCandidates(
      strategy.candidates,
      brief,
      strategy.primaryKeyword,
      strategy.semanticCore
    )
    // urutkan indeks berdasarkan skor → shortlist 3 finalis
    const order = strategy.candidates
      .map((_, i) => i)
      .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
    const finalists = order.slice(0, 3).map((i) => ({ candidate: strategy.candidates[i], score: scores[i] ?? 0 }))
    const debateRes = await debateFinalists(finalists, brief, strategy.primaryKeyword)
    // petakan indeks finalis debat → indeks kandidat asli
    winnerIndex = order[debateRes.winnerIndex] ?? 0
    debate = { revisedHook: debateRes.revisedHook, revisedCaption: debateRes.revisedCaption }
    trace.push(
      `KRITIK: turnamen 6 kandidat → juara angle "${strategy.candidates[winnerIndex]?.angle ?? "umum"}"${debateRes.revisedHook ? " + revisi field lemah" : ""}`
    )
  } catch {
    trace.push("KRITIK: juri tidak merespons — kandidat pertama dipakai")
  }

  const winner = strategy.candidates[winnerIndex] ?? strategy.candidates[0]

  // TAHAP 5 pertama — validasi awal (untuk cek gate refleksi)
  let validation = validateAndScore(strategy, winner, brief, null, debate, memoryCount, trace, queryMap)
  trace.push(`VALIDASI: skor rubrik ${validation.pkg.seoScore}/100`)
  let reflexionRounds = 0

  // TAHAP 4 — REFLEKSI (maks 1 putaran)
  if (validation.pkg.seoScore < META_REFLEXION_GATE && validation.failures.length > 0) {
    trace.push(`REFLEKSI: skor < ${META_REFLEXION_GATE} — agent merevisi ${validation.failures.length} field lemah`)
    const refined = await refineWeakFields({
      title: validation.pkg.title,
      semanticCore: validation.pkg.semanticCore,
      tiktokCaption:
        validation.pkg.platformPackages.find((p) => normalizePackageName(p.platform).includes("tiktok"))?.caption ??
        winner.caption,
      primaryKeyword: strategy.primaryKeyword,
      failures: validation.failures,
    })
    if (Object.keys(refined).length > 0) {
      reflexionRounds = 1
      validation = validateAndScore(
        strategy,
        winner,
        brief,
        {
          hook: refined.title,
          caption: refined.caption,
          semanticCore: refined.semanticCore,
        },
        debate,
        memoryCount,
        trace,
        queryMap
      )
      trace.push(`REFLEKSI: re-validasi → ${validation.pkg.seoScore}/100`)
    }
  }

  const pkg = validation.pkg
  pkg.refinementRounds = reflexionRounds
  // Kandidat non-juara belum dinilai rubrik penuh — tandai skor sebagai estimasi
  // agar UI tidak menyajikan angka seolah-olah hasil rubrik deterministik.
  pkg.hookCandidates = strategy.candidates.map((c, i) => ({
    hook: c.hook,
    angle: c.angle,
    score: i === winnerIndex ? pkg.seoScore : Math.max(40, pkg.seoScore - 6 - i * 3),
    estimated: i !== winnerIndex,
  }))
  pkg.agentTrace = trace

  return { pkg, fallback: false }
}

/** Entry point dengan fallback berlapis — dipakai API route */
export async function runMetaAgentSafe(req: MetaRequest): Promise<MetaAgentResult> {
  const brief = buildBrief(req)
  const trace: string[] = ["INTAKE: brief kreator dinormalisasi"]
  try {
    return await runMetaAgent(req)
  } catch {
    try {
      const learnedContext = await recallStrategyContext()
      const memoryCount = learnedContext ? (learnedContext.match(/^\[/gm)?.length ?? 0) : 0
      return {
        pkg: fallbackPackage(brief, trace, memoryCount),
        fallback: true,
      }
    } catch {
      return { pkg: fallbackPackage(brief, trace, 0), fallback: true }
    }
  }
}
