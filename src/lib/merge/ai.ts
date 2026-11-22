// ============================================================
// ReviewForge — ReviewAgent v4 "SearchRank": AI Agentic Engine
// (z-ai-web-dev-sdk, backend only)
//
// MISI v4: pemetaan SHORT QUERY (2-5 kata seperti diketik orang nyata
// di pencarian) minimal 3 query → ditanam di SEMUA permukaan yang
// dibaca mesin — judul, caption baris-1, hashtag, overlay, keywords,
// nama file — sehingga algoritma media MANAPUN (TikTok, YouTube Shorts,
// Instagram Reels, Douyin, Google) mudah MEMAHAMI maksud video,
// mencocokkannya dengan query pencarian, dan MERANKING-nya.
//
// Arsitektur 9 tahap (basis riset non-mainstream):
//   0. PACING     — metrik deterministik via scene-cut detection ffmpeg:
//                   cut density + panjang shot rata-rata (riset algoritma
//                   TikTok: shot pendek menahan retensi detik-awal).
//   1. PERSEPSI   — multi-scale observation: vision video penuh + keyframe
//                   adaptif (CVPR 2025 Adaptive Keyframe Sampling:
//                   relevansi + coverage, bukan uniform) + audio insight
//                   (loudness + ASR). Semua paralel.
//   2. SINTESES   — LLM merakit "Content Dossier" terstruktur (terinspirasi
//                   MSTED dari NVIDIA MAVEN: intermediate terstruktur =
//                   satu-satunya input tahap downstream). v3: dossier kini
//                   memuat SEMANTIC CORE (maksud video 1 kalimat mesin-
//                   friendly), ENTITIES (jangkar knowledge graph), CATEGORY
//                   (taksonomi) & WATCH GOAL (intent) — jangkar pemahaman
//                   SEMUA algoritma.
//   3. QUERY MAP  — v4 SearchRank: mesin pemetaan short query (lib/seo.ts).
//                   Produk terdeteksi → variasi sebutan → 3 lapis query
//                   (nama umum / use-case / variasi) minimal 3 + intent
//                   (beli/solusi/info) + blueprint caption per baris.
//                   Query set terbukti dari Neural Memory di-recall sebagai
//                   referensi pola (self-learning).
//   4. STRATEGI   — LLM strategist + DEEP THINKING menghasilkan 6 kandidat
//                   hook (formula proven) + paket sinyal TikTok: cover text,
//                   jam posting, strategi sound, saran durasi (完播率),
//                   retention plan per beat. v3: + PLATFORM PACKAGES.
//                   v4: WAJIB menanamkan ≥3 query dari peta secara natural.
//   5. KRITIK v2  — TURNAMEN 2 fase (LATS arXiv:2310.04406 + Debate
//                   arXiv:2305.14325): fase A skor rubrik semua kandidat →
//                   shortlist 3 finalis → fase B debat head-to-head →
//                   juara + revisi field lemah. v3: rubrik juri memuat
//                   KEJELASAN MAKSUD + SINYAL ENTITAS.
//   6. REFLEKSI   — Reflexion pattern (arXiv:2303.11366): bila rubrik
//                   deterministik < 78, agent menerima feedback kegagalan
//                   dan merevisi field lemah, lalu re-validasi (max 1
//                   putaran — biaya terbatas, kualitas terjaga).
//   7. VALIDASI   — validator deterministik + rubrik v4 9 faktor transparan
//                   (HOOK 22, SEO 18, MAKSUD 14, ENTITY 9, SHARE 9, OCR 9,
//                   COVER 5, TAG 4, QUERIES 10) + sanitasi + fallback berlapis.
//                   QUERIES = coverage short-query lintas permukaan.
//   8. INJEKSI    — metadata (maksud video, judul, caption, keywords+entitas,
//                   artist, komentar pin, genre niche) disuntik ke atom udta
//                   MP4 + verifikasi ffprobe otomatis (kontrak file).
//
// Deep thinking mode: diaktifkan untuk STRATEGI/KRITIK/REFLEKSI (tahapan
// yang butuh penalaran berlapis), dinonaktifkan untuk PERSEPSI/SINTESES/QUERY MAP
// (latensi rendah, observasi faktual).
//
// Kontrak: pipeline TIDAK PERNAH gagal karena AI — setiap tahap punya fallback.
// ============================================================

import ZAI from "z-ai-web-dev-sdk"
import { execFile } from "child_process"
import { promisify } from "util"
import { mkdir, readFile, readdir, rm } from "fs/promises"
import path from "path"
import type { CreateChatCompletionVisionBody } from "z-ai-web-dev-sdk"
import type { PlatformPackage, TikTokMetadata } from "./types"
import type { SearchQueryMap } from "./seo"
import { findQueryPlacements } from "./seo"
import { ACCOUNT, captionSignatureLine } from "@/lib/account"

const execFileAsync = promisify(execFile)

// ------------------------------------------------------------
// Timeout per tahap — agent yang menggantung tidak boleh membekukan pipeline
// ------------------------------------------------------------
const VISION_TIMEOUT_MS = 180_000
const FRAMES_TIMEOUT_MS = 150_000
const AUDIO_ASR_TIMEOUT_MS = 120_000
const SYNTHESIS_TIMEOUT_MS = 120_000
const STRATEGY_TIMEOUT_MS = 240_000
const CRITIQUE_SCORE_TIMEOUT_MS = 200_000
const CRITIQUE_DEBATE_TIMEOUT_MS = 200_000
const REFINE_TIMEOUT_MS = 200_000
/** Batas sampel audio untuk ASR — 60 detik sudah mewakili konteks narasi */
const ASR_SAMPLE_SECONDS = 60
/** Maksimal keyframe adaptif — relevansi+coverage (CVPR 2025) */
const MAX_KEYFRAMES = 8
/** Gate Reflexion: di bawah skor ini agent wajib merenung & merevisi */
export const REFLEXION_GATE = 78

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

type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>

/** Body vision SDK — properti `model` diisi otomatis oleh server gateway */
type VisionBody = Omit<CreateChatCompletionVisionBody, "model"> & { model?: string }

// ============================================================
// TAHAP 1 — PERSEPSI
// ============================================================

export interface VisualObservation {
  source: "video" | "frames"
  text: string
}

/**
 * Vision call utama: kirim proxy video penuh. Bila gagal → keyframe adaptif.
 * (Fallback chain terjaga persis seperti desain lama, tapi keyframe kini
 * diambil secara ADAPTIF: scene-change + anchor temporal, bukan uniform.)
 */
export async function observeVisual(proxyPath: string, durationSec: number): Promise<VisualObservation> {
  const zai = await ZAI.create()
  try {
    const buf = await readFile(proxyPath)
    const b64 = buf.toString("base64")
    const body: VisionBody = {
      messages: [
        { role: "user", content: [{ type: "text", text: PERCEPTION_PROMPT }, { type: "video_url", video_url: { url: `data:video/mp4;base64,${b64}` } }] },
      ],
      thinking: { type: "disabled" },
    }
    const res = await withTimeout(
      zai.chat.completions.createVision(body as CreateChatCompletionVisionBody),
      VISION_TIMEOUT_MS,
      "Observasi video AI"
    )
    const content = res.choices[0]?.message?.content?.trim()
    if (content) return { source: "video", text: content }
    throw new Error("Respons observasi kosong")
  } catch {
    return observeWithAdaptiveFrames(zai, proxyPath, durationSec)
  }
}

/**
 * Keyframe ADAPTIF: gabungan (a) scene-change detection via ffmpeg select
 * filter + (b) anchor temporal awal/tengah/akhir → dedup → maks MAX_KEYFRAMES.
 * Riset: uniform sampling boros & melewatkan momen penting (CVPR 2025).
 */
async function extractAdaptiveKeyframes(proxyPath: string, durationSec: number): Promise<string[]> {
  const dir = path.join(path.dirname(proxyPath), "keyframes")
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(dir, { recursive: true })

  const picks: string[] = []
  const addUnique = (f: string | null) => {
    if (!f) return
    if (!picks.some((p) => path.basename(p) === path.basename(f))) picks.push(f)
  }

  // (a) Scene-change — ambil hingga 5 momen perubahan besar
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", proxyPath,
      "-vf", `select='gt(scene,0.35)',scale=512:-2`,
      "-frames:v", "5", "-q:v", "4",
      path.join(dir, "scene_%02d.jpg"),
    ], { timeout: 60_000, killSignal: "SIGKILL" })
    const scenes = (await readdir(dir)).filter((f) => f.startsWith("scene_")).sort()
    for (const s of scenes) addUnique(path.join(dir, s))
  } catch {
    // scene detection gagal (mis. video 1 frame) — anchor tetap jalan
  }

  // (b) Anchor temporal: 5%, 25%, 50%, 75%, 95% durasi — jamin coverage
  const anchors = [0.05, 0.25, 0.5, 0.75, 0.95]
  for (let i = 0; i < anchors.length && picks.length < MAX_KEYFRAMES; i++) {
    const name = `anchor_${String(i).padStart(2, "0")}.jpg`
    const out = path.join(dir, name)
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-ss", String(Math.max(0, Math.min(durationSec - 0.1, durationSec * anchors[i]))),
        "-i", proxyPath,
        "-frames:v", "1", "-q:v", "4", "-vf", "scale=512:-2",
        out,
      ], { timeout: 60_000, killSignal: "SIGKILL" })
      addUnique(out)
    } catch {
      // skip anchor gagal
    }
  }

  // Urutkan supaya urutan temporal terjaga (scene_ sebelum anchor_ tak penting —
  // kita urutkan berdasarkan waktu ekstraksi: scene sudah kronologis dari ffmpeg,
  // anchor juga. Cukup stabilkan nama agar deterministik di prompt.)
  return picks.slice(0, MAX_KEYFRAMES)
}

async function observeWithAdaptiveFrames(zai: ZaiClient, proxyPath: string, durationSec: number): Promise<VisualObservation> {
  const files = await extractAdaptiveKeyframes(proxyPath, durationSec)
  if (files.length === 0) throw new Error("Tidak dapat mengekstrak frame untuk analisis")
  try {
    // Pasangan label + gambar per frame — agent melihat urutan kronologis
    const parts: Array<Record<string, unknown>> = []
    for (let i = 0; i < files.length; i++) {
      const b64 = (await readFile(files[i])).toString("base64")
      parts.push({ type: "text", text: `[Frame ${i + 1}/${files.length}]` })
      parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } })
    }
    const frameBody: VisionBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${PERCEPTION_PROMPT}\n\nCatatan: kamu menerima ${files.length} keyframe ADAPTIF yang dipilih oleh deteksi perubahan adegan + anchor temporal. Frame berurutan mewakili alur video dari awal ke akhir.` },
            ...parts,
          ] as never,
        },
      ],
      thinking: { type: "disabled" },
    }
    const res = await withTimeout(
      zai.chat.completions.createVision(frameBody as CreateChatCompletionVisionBody),
      FRAMES_TIMEOUT_MS,
      "Observasi keyframe AI"
    )
    const txt = res.choices[0]?.message?.content?.trim()
    if (!txt) throw new Error("Observasi keyframe kosong")
    return { source: "frames", text: txt }
  } finally {
    await rm(path.dirname(files[0]), { recursive: true, force: true }).catch(() => undefined)
  }
}

// Prompt PERSEPSI — observasi mentah kaya, TANPA strategi (tugas tahap 2)
const PERCEPTION_PROMPT = `Kamu adalah mesin persepsi video — observasi apa adanya, presisi dan faktual, untuk kreator TikTok Indonesia. Video ini akan dipublikasikan di akun TikTok ${ACCOUNT.handle} — "${ACCOUNT.displayName}" (${ACCOUNT.niche}): amati produk/objek dengan TELITI (brand, kemasan, label, harga bila terlihat) karena audiens akun adalah pembeli yang mencari rekomendasi. Karena algoritma membaca video lewat frame (抽帧), teks layar (OCR), dan ucapan (ASR), dokumentasikan SEMUA yang terlihat. Jawab dalam Bahasa Indonesia dengan format ini:

[SUBJEK] siapa/apa yang tampil — orang, objek, produk, brand, terlihat jelas
[SETTING] lokasi, waktu, suasana, latar
[ALUR] kronologi kejadian dari awal sampai akhir — sebutkan momen/segmen berurutan
[TEKS LAYAR] SEMUA tulisan yang terlihat (caption, judul, subtitle, label, logo) — kutip PERSIS; tulis "(tidak ada)" bila kosong
[VISUAL] warna dominan, gaya (vlog/kinematik/amateur/tutorial/produk), transisi antar adegan
[MOOD] nuansa emosional
[KATEGORI] niche paling tepat
[AUDIENCE] penonton yang paling cocok
[KATA KUNCI VISUAL] 5-8 frasa deskriptif

Faktual saja — jangan mengarang, jangan menilai kualitas editing.`

// ------------------------------------------------------------
// Audio insight (dipertahankan — loudness + ASR; riset CSDN: 语音识别 = sinyal)
// ------------------------------------------------------------

export interface AudioInsight {
  hasAudio: boolean
  audioCodec: string | null
  meanVolumeDb: number | null
  maxVolumeDb: number | null
  speechDetected: boolean
  transcript: string | null
}

export async function extractAudioInsight(
  videoPath: string,
  hasAudio: boolean,
  audioCodec?: string | null
): Promise<AudioInsight> {
  const insight: AudioInsight = {
    hasAudio,
    audioCodec: audioCodec ?? null,
    meanVolumeDb: null,
    maxVolumeDb: null,
    speechDetected: false,
    transcript: null,
  }
  if (!hasAudio) return insight

  // 1. Statistik loudness (volumedetect) — murah dan cepat
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-t",
      String(Math.min(ASR_SAMPLE_SECONDS, 90)),
      "-i",
      videoPath,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ], { timeout: 120_000, killSignal: "SIGKILL" })
    const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)
    const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)
    if (mean) insight.meanVolumeDb = Number(mean[1])
    if (max) insight.maxVolumeDb = Number(max[1])
  } catch {
    // lanjut — loudness opsional
  }

  // 2. Ekstrak sampel audio 16kHz mono → ASR
  let samplePath: string | null = null
  try {
    const dir = path.join(path.dirname(videoPath), "audio-sample")
    await mkdir(dir, { recursive: true })
    samplePath = path.join(dir, "sample.wav")
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", videoPath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-t", String(ASR_SAMPLE_SECONDS),
      "-sample_fmt", "s16",
      samplePath,
    ], { timeout: 240_000, killSignal: "SIGKILL" })
    const buf = await readFile(samplePath)
    if (buf.length > 20_000) {
      const zai = await ZAI.create()
      const res = await withTimeout(
        zai.audio.asr.create({ file_base64: buf.toString("base64") }),
        AUDIO_ASR_TIMEOUT_MS,
        "Transkripsi audio ASR"
      )
      const text = (res as { text?: string }).text?.trim()
      // Guard: transkrip harus mengandung ≥3 karakter alfanumerik agar dihitung
      // sebagai ucapan sungguhan (bukan noise dari musik/sFX murni).
      const meaningful = (text?.match(/[a-zA-Z0-9\u00C0-\u024F\u4E00-\u9FFF]/g) ?? []).length >= 3
      if (text && meaningful) {
        insight.transcript = text.slice(0, 1500)
        insight.speechDetected = true
      }
    }
  } catch {
    // ASR gagal — non-fatal, lanjut tanpa transkrip
  } finally {
    if (samplePath) await rm(path.dirname(samplePath), { recursive: true, force: true }).catch(() => undefined)
  }

  return insight
}

/** Render insight audio menjadi blok teks untuk agent */
export function renderAudioInsight(a: AudioInsight): string {
  if (!a.hasAudio) return "AUDIO: video ini TIDAK memiliki track audio."
  const lines = ["AUDIO:"]
  lines.push(`- Codec audio: ${a.audioCodec ?? "tidak diketahui"}`)
  if (a.meanVolumeDb !== null) {
    const character =
      a.meanVolumeDb > -20 ? "audio dominan (musik/ucapan jelas)" : "audio latar (ambient/lunak)"
    lines.push(`- Volume rata-rata ${a.meanVolumeDb.toFixed(1)} dB / puncak ${a.maxVolumeDb?.toFixed(1) ?? "?"} dB — ${character}`)
  }
  if (a.transcript) {
    lines.push(`- ADA UCAPAN. Transkripsi (menit-detik pertama): "${a.transcript}"`)
  } else {
    lines.push("- Tidak ada ucapan yang terdeteksi (kemungkinan musik/sound effect saja)")
  }
  return lines.join("\n")
}

/** Render metrik pacing (terukur ffmpeg) menjadi blok teks untuk agent */
export function renderPacingMetrics(p: {
  cuts: number
  sampledSeconds: number
  cutsPer10s: number
  avgShotLength: number
  pacingLabel: string
}): string {
  const lines = [
    "PACING (terukur dari scene-cut detection ffmpeg — data deterministik, bukan tebakan):",
    `- Cut density: ${p.cuts} cut dalam ${p.sampledSeconds}s sampel (${p.cutsPer10s} cut per 10 detik) — kategori "${p.pacingLabel}"`,
    `- Panjang shot rata-rata: ${p.avgShotLength} detik`,
  ]
  if (p.pacingLabel === "sangat-lambat" || p.pacingLabel === "lambat") {
    lines.push("- PERINGATAN riset: hook statis > 3 detik berisiko swipe-away — strategi HARUS menyarankan trim/zoom dinamis di detik awal")
  }
  if (p.pacingLabel === "sangat-cepat") {
    lines.push("- NOTE riset: cut density sangat tinggi — jaga keterbacaan overlay & narasi agar penonton tidak kehilangan konteks")
  }
  return lines.join("\n")
}

// ============================================================
// TAHAP 2 — SINTESES: Content Dossier (terinspirasi MAVEN/MSTED)
// ============================================================

export interface ContentDossier {
  niche: string
  audience: string
  narrativeArc: string
  sceneBeats: { t: string; note: string }[]
  coreSubject: string
  /** v3 OmniRank — pernyataan semantik "maksud video": 1 kalimat mesin-friendly
   *  (subjek + manfaat + audiens). Jangkar pemahaman SEMUA algoritma. */
  semanticCore: string
  /** v3 OmniRank — entitas bernama: brand, model produk, lokasi, nama */
  entities: string[]
  /** v3 OmniRank — kategori taksonomi "induk > anak" (mis. elektronik > kulkas) */
  category: string
  /** v3 OmniRank — tujuan nonton utama: belajar | membeli | hiburan | inspirasi */
  watchGoal: string
  textOnScreen: string[]
  spokenKeywords: string[]
  emotionalDrivers: string[]
  searchIntents: string[]
  differentiators: string[]
  summary: string
}

const SYNTHESIS_SYSTEM = `Kamu adalah analis konten senior yang merangkum observasi mentah menjadi dosen intelijen ("Content Dossier") untuk strategist TikTok. Kamu TIDAK menulis caption — kamu membangun pemahaman yang presisi. Pemahamanmu nanti dipakai agar SEMUA algoritma media (TikTok, YouTube Shorts, Instagram Reels, Douyin) mudah memahami maksud video — jadi rumuskan pemahaman sejelas mungkin, bukan sekadar deskripsi. Jawab HANYA JSON valid.`

export async function synthesizeDossier(
  visual: string,
  audio: string,
  clipNames: string[],
  duration: number,
  pacingText?: string
): Promise<ContentDossier> {
  const zai = await ZAI.create()
  const userPrompt = `Rangkailah observasi multi-sumber menjadi Content Dossier.

DURASI TOTAL: ${Math.round(duration)} detik
NAMA FILE SUMBER (urutan): ${clipNames.map((n) => `- ${n}`).join("\n")}
AKUN PUBLISHER: ${ACCOUNT.handle} — "${ACCOUNT.displayName}" (${ACCOUNT.niche}). Field "audience" WAJIB mempertimbangkan basis penonton akun ini: ${ACCOUNT.audience}.

=== OBSERVASI VISUAL (vision model) ===
${visual || "(tidak tersedia)"}

=== OBSERVASI AUDIO ===
${audio || "(tidak tersedia)"}

=== METRIK PACING ===
${pacingText || "(tidak tersedia)"}

Buat JSON dengan struktur persis:
{
  "niche": "niche konten spesifik (bukan generik)",
  "audience": "profil penonton target — usia, minat, konteks menonton",
  "narrativeArc": "1-2 kalimat: cerita/arc dari awal ke akhir",
  "sceneBeats": [{"t": "0-2s", "note": "apa yang terjadi & kenapa penonton harus bertahan"}, ...maksimal 6 beat berurutan berdasarkan durasi],
  "coreSubject": "subjek inti dalam 1 frasa",
  "semanticCore": "SATU kalimat MAKSUD VIDEO yang langsung dipahami mesin & manusia — pola: 'Video ini [menunjukkan/mereview/menjelaskan] [subjek spesifik + entitas] untuk [audiens] yang ingin [hasil/manfaat konkret]'. INI jangkar pemahaman semua algoritma — buat sejelas mungkin, tanpa metafora",
  "entities": ["entitas bernama yang TERLIHAT/DISEBUT: brand, model produk, tempat, nama orang (mis. 'Changhong', 'kulkas 2 pintu')"],
  "category": "kategori taksonomi 'induk > anak' (mis. 'elektronik > kulkas', 'makanan > resep')",
  "watchGoal": "tujuan utama penonton menonton: belajar | membeli | hiburan | inspirasi",
  "textOnScreen": ["teks yang TERBACA di layar", ...],
  "spokenKeywords": ["kata kunci dari ucapan (jika ada)"],
  "emotionalDrivers": ["2-4 emosi yang memicu nonton-sampai-habis / share"],
  "searchIntents": ["3-6 frasa yang mungkin diketik orang di pencarian TikTok/Google terkait konten INI"],
  "differentiators": ["1-3 hal yang membuat video ini beda dari konten sejenis"],
  "summary": "ringkasan 3-4 kalimat untuk strategist — SERTAKAN interpretasi metrik pacing"
}

ATURAN: sceneBeats.wajib realistis terhadap durasi; textOnScreen kosong boleh []; jangan mengarang teks yang tidak terbaca; entities WAJIB diisi bila ada produk/objek teridentifikasi — entitas = jangkar knowledge graph algoritma.`

  let lastError = "Sintesis dossier tidak valid"
  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: SYNTHESIS_SYSTEM },
          {
            role: "user",
            content: attempt === 0 ? userPrompt : `${userPrompt}\n\nPENTING: Balas HANYA JSON valid tanpa teks lain.`,
          },
        ],
        thinking: { type: "disabled" },
      }),
      SYNTHESIS_TIMEOUT_MS,
      "Sintesis dossier"
    )
    const parsed = extractJson(completion.choices[0]?.message?.content ?? "")
    if (!parsed) continue
    const dossier = normalizeDossier(parsed)
    if (dossier) return dossier
    lastError = "Struktur dossier tidak lengkap"
  }
  throw new Error(lastError)
}

function normalizeDossier(obj: Record<string, unknown>): ContentDossier | null {
  const niche = String(obj.niche ?? "").trim()
  const summary = String(obj.summary ?? "").trim()
  if (!niche || !summary) return null
  const beatsRaw = Array.isArray(obj.sceneBeats) ? obj.sceneBeats : []
  const sceneBeats = beatsRaw
    .map((b) => {
      const beat = b as Record<string, unknown>
      return { t: String(beat?.t ?? "").slice(0, 12), note: String(beat?.note ?? "").slice(0, 140) }
    })
    .filter((b) => b.note)
    .slice(0, 6)
  const arr = (v: unknown, max: number, len = 120) =>
    Array.isArray(v)
      ? v.map((x) => String(x ?? "").trim().slice(0, len)).filter(Boolean).slice(0, max)
      : []
  return {
    niche,
    audience: String(obj.audience ?? "").slice(0, 160),
    narrativeArc: String(obj.narrativeArc ?? "").slice(0, 400),
    sceneBeats,
    coreSubject: String(obj.coreSubject ?? "").slice(0, 120),
    // v3 OmniRank — pemahaman semantik mesin
    semanticCore: String(obj.semanticCore ?? "").trim().slice(0, 300),
    entities: arr(obj.entities, 6, 60),
    category: String(obj.category ?? "").trim().slice(0, 80),
    watchGoal: String(obj.watchGoal ?? "").trim().slice(0, 40),
    textOnScreen: arr(obj.textOnScreen, 8, 80),
    spokenKeywords: arr(obj.spokenKeywords, 8, 60),
    emotionalDrivers: arr(obj.emotionalDrivers, 4, 60),
    searchIntents: arr(obj.searchIntents, 6, 80),
    differentiators: arr(obj.differentiators, 3, 120),
    summary: summary.slice(0, 900),
  }
}

/** Dossier darurat bila tahap sintesis gagal — dipakai langsung dari observasi */
export function fallbackDossier(visual: string, audio: string, clipNames: string[]): ContentDossier {
  const nameHint = clipNames
    .map((n) => n.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim())
    .filter(Boolean)
    .join(", ")
  const subject = nameHint.slice(0, 100) || "konten video"
  return {
    niche: "general",
    audience: "penonton umum TikTok Indonesia",
    narrativeArc: "",
    sceneBeats: [],
    coreSubject: subject,
    // v3 OmniRank — fallback tetap menyediakan jangkar semantik minimal
    semanticCore: `Video ini menunjukkan ${subject} untuk penonton yang ingin mengetahuinya lebih jelas`,
    entities: [],
    category: "",
    watchGoal: "",
    textOnScreen: [],
    spokenKeywords: [],
    emotionalDrivers: [],
    searchIntents: [],
    differentiators: [],
    summary: [visual.slice(0, 600), audio.slice(0, 300), nameHint ? `Petunjuk nama file: ${nameHint}` : ""]
      .filter(Boolean)
      .join("\n"),
  }
}

// ============================================================
// TAHAP 3 — STRATEGI v2: 6 kandidat hook + paket sinyal TikTok
// (deep thinking mode aktif)
// ============================================================

export interface StrategyCandidate {
  hook: string
  caption: string
  hashtags: string[]
  keywords: string[]
  overlays: { text: string; when: string }[]
  pinnedComment: string
  filename: string
}

/** Paket sinyal TikTok level-paket (bukan per-kandidat) — tahap STRATEGI v2 */
export interface StrategyExtras {
  /** Teks cover/thumbnail — CTR grid profil (封面文字) */
  coverText?: string
  /** Jam posting terbaik per niche/audience — window distribusi awal */
  bestPostTime?: string
  /** Strategi sound/musik — trending sound memicu boost (声音流量池) */
  soundStrategy?: string
  /** Saran durasi/trim — completion rate (完播率) bobot tertinggi */
  durationAdvice?: string
  /** Rencana retensi per beat — menjaga penonton menonton sampai habis */
  retentionPlan?: { t: string; action: string }[]
  /** v3 OmniRank — paket publish per platform (TikTok · YouTube Shorts · IG Reels · Douyin) */
  platformPackages?: PlatformPackage[]
}

export interface StrategyPackage {
  candidates: StrategyCandidate[]
  primaryKeyword: string
  extras: StrategyExtras
}

const STRATEGY_SYSTEM = `Kamu adalah strategist TikTok SEO elite Indonesia dengan lisensi penalaran penuh — berpikirlah berlapis sebelum menjawab. Basis risetmu (bukan opinion mainstream):

[RETENSI 2-5 DETIK — r/tiktok_reversing] Penonton yang swipe-away di detik awal menghentikan distribusi video. Hook harus memaksa bertahan lewat detik 1-3.
[ALGORITMA MEMBACA 3 SUMBER — CSDN 抖音算法] Sistem membaca video lewat frame, teks layar (OCR), dan ucapan (ASR). Keyword utama harus hadir di: judul, teks overlay yang kausarankan, dan caption.
[5 KARAKTER PERTAMA JUDUL — 抖音SEO] Karakter awal judul menentukan ranking pencarian. Keyword utama WAJIB di paling depan judul.
[完播率 — CSDN] Completion rate punya bobot tertinggi: video singkat yang ditonton sampai habis mengalahkan video panjang yang ditinggal. Saran durasi harus realistis terhadap konten.
[叠 加 推 荐 — Zhihu] Share berbobot LEBIH TINGGI dari komentar, komentar lebih tinggi dari like. CTA harus memancing SHARE atau komentar.
[COVER — 封面文字] Teks cover di grid profil menentukan CTR saat penonton mengunjungi profil; tulis teks cover maksimal 30 karakter yang cocok dengan hook.
[SOUND — 声音流量池] Menggunakan trending sound yang relevan menaikkan distribusi; sarankan strategi sound spesifik untuk konten ini.
[JAM POSTING — r/Tiktokhelp] Window distribusi awal ditentukan aktivitas audience niche; rekomendasikan rentang jam WIB yang realistis.
[PENCARIAN TIKTOK — data Google internal] 40-45% pengguna muda memakai TikTok sebagai mesin pencari. Keyword juga harus masuk overlay detik awal.
[EMBEDDING SEMANTIK LINTAS-PLATFORM — TikTok Sphinx · YouTube · Instagram] Semua platform besar mengubah video + teks menjadi vektor semantik. Semakin KONSISTEN keyword utama muncul di SEMUA permukaan yang dibaca mesin — judul, caption, teks layar (OCR), ucapan (ASR), hashtag, deskripsi file — semakin yakin sistem mengklasifikasi konten → relevansi naik → peluang ranking naik.
[MAKSUD VIDEO — jangkar pemahaman] Pernyataan semantik 1 kalimat (subjek + manfaat + audiens) dari dossier adalah cara TERCEPAT algoritma manapun memahami "video ini tentang apa" — WAJIB tercermin di baris-1 caption SETIAP platform, bukan hanya TikTok.
[YOUTUBE SHORTS — help.google.com] Judul ≤100 karakter keyword-first; deskripsi kalimat penuh dengan keyword natural (Shorts membaca deskripsi utuh); HASHTAG MAKSIMAL 3 — lebih dari itu semua diabaikan sistem.
[INSTAGRAM REELS — Instagram SEO] Baris-1 caption = hook + keyword (Reels diindeks via caption); 5-8 hashtag campuran broad+niche+intent; CTA simpan/share kuat dinilai ranking.
[DOUYIN — 抖音SEO] Judul pendek tegas + 2-4 topik hashtag; gaya bahasa langsung.
[ENTITY — knowledge graph] Sebut nama brand/produk/model SECARA EKSPLISIT di hook & caption — sistem merepresentasikan konten sebagai entitas di graph topik; konten dengan entitas jelas lebih mudah dicocokkan ke query pencarian & minat penonton.
[HASHTAG] 3-4 tag di caption (broad + niche + search-intent), DILARANG generik: fyp, viral, foryou, foryoupage, xyzbca — tanpa nilai ranking.
[NAMA FILE] kebab-case, 4-8 kata, keyword utama di depan.

[IDENTITAS AKUN — WAJIB] Output dipublikasikan di akun TikTok ${ACCOUNT.handle} — "${ACCOUNT.displayName}": ${ACCOUNT.niche}, untuk ${ACCOUNT.audience}. Suara akun: ${ACCOUNT.voice}.
- Bila video membahas produk/barang/jasa → pakai angle review/rekomendasi khas akun; konten lain → tetap pertahankan gaya bahasa akun.
- Caption WAJIB memuat "${ACCOUNT.handle}" secara natural sebagai baris kredit SEBELUM baris hashtag (contoh: "Follow ${ACCOUNT.handle} buat rekomendasi lainnya").
- Sertakan 1 hashtag niche akun (mis. #reviewproduk / #rekomendasi) HANYA bila relevan dengan isi video.
- pinnedComment boleh mengarahkan ke profil ${ACCOUNT.handle} untuk rekomendasi konten berikutnya.

Balas HANYA JSON valid.`

export async function generateStrategyCandidates(
  dossier: ContentDossier,
  duration: number,
  fps: number,
  pacingText?: string,
  learnedContext?: string,
  queryMap?: SearchQueryMap | null
): Promise<StrategyPackage> {
  const zai = await ZAI.create()

  // ===== v4 SearchRank — blok peta keyword pencarian =====
  const queryMapBlock = queryMap
    ? `
=== PETA KEYWORD PENCARIAN (short query — hasil pemetaan cara orang mencari) ===
produk terdeteksi: ${queryMap.product} (${queryMap.productType})
variasi sebutan: ${JSON.stringify(queryMap.aliases)}
SHORT QUERY YANG ORANG CARI (WAJIB dipakai — ini frasa PERSIS seperti diketik di search bar):
${queryMap.queries.map((q, i) => `${i + 1}. "${q.query}" [intent: ${q.intent}] — ${q.angle}`).join("\n")}
BLUEPRINT CAPTION (susun caption mengikuti struktur ini):
${queryMap.captionBlueprint.map((b) => `- ${b.line} → ${b.purpose}`).join("\n")}

ATURAN PETA QUERY (WAJIB — v4 SearchRank):
- primaryKeyword = query intent "beli" PERTAMA dari peta; kalau tidak ada intent beli → query pertama. DILARANG menciptakan keyword lain di luar peta.
- Caption WAJIB memuat MINIMAL 3 query dari peta secara natural — kalimat yang enak dibaca, dilarang asal disambung-tempel.
- hashtags: 3-4 tag, MINIMAL 2 diambil dari query peta (spasi dihapus: "lap pengering mobil" → "lappengeringmobil").
- keywords kandidat = SELURUH query peta (urut intent beli > solusi > info).
- primaryKeyword WAJIB di 5 karakter pertama hook & baris 1 caption.
- SETIAP paket platform: baris/kalimat pertama memuat query utama.
`
    : ""

  const userPrompt = `Dari Content Dossier berikut, hasilkan PAKET STRATEGI untuk video ${Math.round(duration)}s ${fps}fps vertikal.

=== CONTENT DOSSIER ===
niche: ${dossier.niche}
audience: ${dossier.audience}
arc: ${dossier.narrativeArc || "(tidak diketahui)"}
beats: ${JSON.stringify(dossier.sceneBeats)}
subjek inti: ${dossier.coreSubject}
MAKSUD VIDEO (jangkar semantik — WAJIB konsisten di SEMUA platform): ${dossier.semanticCore || "(belum dirumuskan — rumuskan dari subjek inti)"}
entitas: ${JSON.stringify(dossier.entities)}
kategori: ${dossier.category || "(tidak diketahui)"}
tujuan nonton: ${dossier.watchGoal || "(tidak diketahui)"}
teks layar: ${JSON.stringify(dossier.textOnScreen)}
ucapan: ${JSON.stringify(dossier.spokenKeywords)}
emosi pemicu: ${JSON.stringify(dossier.emotionalDrivers)}
search intent: ${JSON.stringify(dossier.searchIntents)}
pembeda: ${JSON.stringify(dossier.differentiators)}
ringkasan: ${dossier.summary}
${queryMapBlock}
=== METRIK PACING ===
${pacingText || "(tidak tersedia)"}
${learnedContext ? `\n${learnedContext}\n` : ""}

JSON dengan struktur:
{
  "primaryKeyword": "1 frasa keyword pencarian UTAMA (2-4 kata, bahasa Indonesia, seperti diketik di TikTok search)",
  "candidates": [
    {
      "hook": "judul hook maksimal 90 karakter — primaryKeyword di 5 KARAKTER PERTAMA",
      "caption": "2-5 baris (pakai \\n), baris 1 mengandung primaryKeyword natural, diakhiri PERTANYAAN CTA pancing komentar, disusul baris kredit natural berisi \"@review.picks\", baris terakhir TEPAT 3-4 hashtag dengan tanda #",
      "hashtags": ["3-4 tag tanpa #, broad+niche+search-intent, semua relevan"],
      "keywords": ["6-10 frasa pencarian sekunder"],
      "overlays": [{"text": "maks 6 kata, mengandung keyword", "when": "0-2s atau posisi beat"}],
      "pinnedComment": "komentar yang akan dipin kreator — memancing balasan (pertanyaan terbuka / debat ringan / polling)",
      "filename": "slug-kebab-case-4-8-kata.mp4"
    }
    // TEPAT 6 kandidat dengan ANGLES BERBEDA:
    // 1 = curiosity-gap, 2 = pertanyaan langsung, 3 = kontras/sebelum-sesudah,
    // 4 = angka/listicle, 5 = negasi/miskonsepsi ("jangan..."), 6 = relatabilitas/emosi
  ],
  "coverText": "teks cover grid profil — maksimal 30 karakter, kuat, cocok dengan hook juara",
  "bestPostTime": "rentang jam WIB terbaik untuk niche & audience ini + alasan 1 kalimat",
  "soundStrategy": "strategi sound spesifik: jenis sound, kenapa cocok, cara pakai",
  "durationAdvice": "saran durasi/trim berbasis completion rate — sebutkan segmen yang boleh dipangkas jika ada",
  "retentionPlan": [{"t": "0-2s", "action": "tindakan konkret menjaga penonton di segmen ini"}],
  "platformPackages": [
    {"platform": "TikTok", "caption": "caption TikTok: baris 1 primaryKeyword natural, baris CTA pertanyaan, baris kredit @review.picks, baris terakhir 3-4 hashtag #", "hashtags": ["3-4 tanpa #"], "note": "1 catatan singkat khusus TikTok"},
    {"platform": "YouTube Shorts", "title": "judul keyword-first maksimal 100 karakter", "caption": "deskripsi 2-4 kalimat PENUH dengan primaryKeyword di kalimat pertama + entitas + ajakan tonton sampai habis", "hashtags": ["TEPAT 3 tanpa #"], "note": "hashtag maksimal 3 — lebih diabaikan sistem"},
    {"platform": "Instagram Reels", "caption": "baris 1 hook+primaryKeyword, 2-3 baris value, CTA simpan/share, kredit @review.picks", "hashtags": ["5-8 tanpa #, campuran broad+niche+intent"], "note": ""},
    {"platform": "Douyin", "caption": "judul pendek tegas + kalimat value, kredit @review.picks", "hashtags": ["2-4 tanpa #"], "note": ""}
  ]
}

ATURAN PAKET PLATFORM (WAJIB):
- SETIAP caption platform memuat primaryKeyword di baris/kalimat PERTAMA — konsistensi = keyakinan klasifikasi mesin.
- SETIAP caption memuat maksud video (subjek + manfaat) secara eksplisit — algoritma manapun harus langsung paham.
- Entitas (brand/produk) dari dossier WAJIB disebut di title/caption YouTube Shorts & minimal 1 platform lain.
- Semua caption tetap dalam suara akun ${ACCOUNT.handle} — santai, jujur, to-the-point.
- Panjang caption TikTok ≤ 500 karakter; YouTube Shorts deskripsi boleh lebih panjang; Douyin paling pendek.

Overlay WAJIB ada 1 overlay untuk detik "0-2s" (hook visual — riset: detik pertama menentukan distribusi).
retentionPlan: maksimal 5 beat, sesuai durasi video.`

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
      "Strategi hook"
    )
    const parsed = extractJson(completion.choices[0]?.message?.content ?? "")
    if (!parsed) continue

    const primaryKeyword = String(parsed.primaryKeyword ?? "").trim()
    const raw = Array.isArray(parsed.candidates) ? parsed.candidates : []
    const candidates = raw
      .map(normalizeCandidate)
      .filter((c): c is StrategyCandidate => c !== null)
      .slice(0, 6)
    if (primaryKeyword && candidates.length >= 2) {
      return { candidates, primaryKeyword, extras: normalizeExtras(parsed) }
    }
    lastError = candidates.length === 0 ? "Tidak ada kandidat valid" : "primaryKeyword hilang"
  }
  throw new Error(lastError)
}

function normalizeExtras(obj: Record<string, unknown>): StrategyExtras {
  const retentionRaw = Array.isArray(obj.retentionPlan) ? (obj.retentionPlan as Record<string, unknown>[]) : []
  // v3 OmniRank — paket publish per platform (caption/hashtag/judul sesuai norma tiap algoritma)
  const packagesRaw = Array.isArray(obj.platformPackages) ? (obj.platformPackages as Record<string, unknown>[]) : []
  const platformPackages: PlatformPackage[] = packagesRaw
    .map((p) => {
      const platform = String(p?.platform ?? "").trim().slice(0, 40)
      const caption = String(p?.caption ?? "").trim().slice(0, 2200)
      if (!platform || !caption) return null
      const title = String(p?.title ?? "").trim().slice(0, 110)
      const note = String(p?.note ?? "").trim().slice(0, 160)
      return {
        platform,
        caption,
        hashtags: toStringArray(p?.hashtags, 10, 40),
        ...(title ? { title } : {}),
        ...(note ? { note } : {}),
      }
    })
    .filter((p): p is PlatformPackage => p !== null)
    .slice(0, 6)
  return {
    coverText: String(obj.coverText ?? "").trim().slice(0, 40) || undefined,
    bestPostTime: String(obj.bestPostTime ?? "").trim().slice(0, 140) || undefined,
    soundStrategy: String(obj.soundStrategy ?? "").trim().slice(0, 220) || undefined,
    durationAdvice: String(obj.durationAdvice ?? "").trim().slice(0, 180) || undefined,
    retentionPlan: retentionRaw
      .map((r) => ({ t: String(r?.t ?? "").slice(0, 12), action: String(r?.action ?? "").trim().slice(0, 140) }))
      .filter((r) => r.action)
      .slice(0, 5),
    ...(platformPackages.length > 0 ? { platformPackages } : {}),
  }
}

function normalizeCandidate(raw: unknown): StrategyCandidate | null {
  const c = raw as Record<string, unknown>
  const hook = String(c?.hook ?? "").trim()
  const caption = String(c?.caption ?? "").trim()
  const hashtags = toStringArray(c?.hashtags, 4)
  if (!hook || !caption || hashtags.length === 0) return null
  const overlaysRaw = Array.isArray(c?.overlays) ? (c.overlays as Record<string, unknown>[]) : []
  const overlays = overlaysRaw
    .map((o) => ({ text: String(o?.text ?? "").trim().slice(0, 60), when: String(o?.when ?? "").trim().slice(0, 16) }))
    .filter((o) => o.text)
    .slice(0, 4)
  return {
    hook: hook.slice(0, 150),
    caption: caption.slice(0, 2200),
    hashtags,
    keywords: toStringArray(c?.keywords, 10),
    overlays,
    pinnedComment: String(c?.pinnedComment ?? "").trim().slice(0, 300),
    filename: String(c?.filename ?? "")
      .trim()
      .replace(/\.mp4$/i, "")
      .slice(0, 80),
  }
}

// ============================================================
// TAHAP 4 — KRITIK v2: TURNAMEN 2 FASE (LATS + Debate pattern)
// Fase A: skor rubrik semua kandidat → shortlist 3 finalis
// Fase B: debat head-to-head finalis → juara + revisi
// ============================================================

export interface CritiqueResult {
  winnerIndex: number
  reasoning: string
  finalHook: string
  finalCaption: string
  finalPinnedComment: string
  revisionNotes: string[]
  /** Skor fase A per kandidat (indeks 0-based) — transparansi turnamen */
  scores?: number[]
}

const CRITIQUE_SCORE_SYSTEM = `Kamu adalah juri kelompok untuk konten TikTok — objektif, berbasis rubrik riset, tidak peduli selera. Konten dipublikasikan di akun ${ACCOUNT.handle} — "${ACCOUNT.displayName}" (${ACCOUNT.niche}); nilai keselarasan suara akun & baris kredit handle sebagai pertimbangan kualitatif. Beri skor 0-100 untuk SETIAP kandidat secara independen. Jawab HANYA JSON valid.`

const CRITIQUE_DEBATE_SYSTEM = `Kamu adalah kritikus brutal namun objektif untuk konten TikTok. Tiga finalis berdebat di "ruang kritik" internmu — simulasi argumen pro-kontra SETIAP finalis terhadap rubrik ranking, lalu tentukan juara. Konten dipublikasikan di akun ${ACCOUNT.handle} — "${ACCOUNT.displayName}": pemenang harus paling terasa KHAS akun ini (suara, angle, kredit handle). Kamu boleh MEMPERBAIKI bagian lemah (revisi, bukan menolak semuanya). Balas HANYA JSON valid.`

/** Fase A — skor semua kandidat + shortlist (turnamen) */
export async function scoreCandidates(
  candidates: StrategyCandidate[],
  primaryKeyword: string,
  dossier: ContentDossier,
  duration: number
): Promise<{ scores: number[]; shortlist: number[] }> {
  const zai = await ZAI.create()

  const list = candidates
    .map(
      (c, i) =>
        `KANDIDAT ${i + 1}:\n  hook: ${c.hook}\n  caption: ${JSON.stringify(c.caption)}\n  hashtags: ${JSON.stringify(c.hashtags)}\n  overlay 0-2s: ${JSON.stringify(c.overlays.find((o) => o.when.includes("0-2"))?.text ?? "(TIDAK ADA — otomatis gagal kriteria)")}`
    )
    .join("\n\n")

  const userPrompt = `Skor SETIAP kandidat untuk video ${Math.round(duration)}s niche "${dossier.niche}". Keyword utama: "${primaryKeyword}". Maksud video (jangkar semantik): "${dossier.semanticCore || dossier.coreSubject}". Entitas: ${JSON.stringify(dossier.entities)}.

${list}

RUBRIK PENSKORAN (total 100):
- HOOK RETENSI (30): apakah hook memaksa bertahan lewat detik 1-3? Spesifik > generik.
- SEO SEARCH (20): primaryKeyword di 5 karakter PERTAMA hook? di baris 1 caption? di overlay detik 0-2s?
- KEJELASAN MAKSUD (15): apakah maksud video (subjek + manfaat + untuk siapa) langsung terpahami dari judul + baris-1 caption TANPA menonton video? Semantik jelas = mudah diklasifikasi algoritma manapun.
- SINYAL ENTITAS (10): nama brand/produk/entitas spesifik disebut eksplisit di hook/caption? (jangkar knowledge graph)
- SHARE-ABILITY (15): caption/pertanyaan CTA memancing share atau komentar?
- OCR SYNERGY (10): overlay bisa dibaca OCR & menguatkan keyword?

JSON:
{
  "scores": [{"index": 1, "score": 0, "oneLine": "alasan singkat"}, ...SEMUA kandidat berurutan],
  "shortlist": [i1, i2, i3]
}
shortlist = nomor (1-based) 3 kandidat dengan skor tertinggi.`

  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: CRITIQUE_SCORE_SYSTEM },
          {
            role: "user",
            content: attempt === 0 ? userPrompt : `${userPrompt}\n\nPENTING: Balas HANYA JSON valid.`,
          },
        ],
        thinking: { type: "enabled" },
      }),
      CRITIQUE_SCORE_TIMEOUT_MS,
      "Skor turnamen"
    )
    const parsed = extractJson(completion.choices[0]?.message?.content ?? "")
    if (!parsed) continue
    const rawScores = Array.isArray(parsed.scores) ? parsed.scores : []
    const scores = new Array<number>(candidates.length).fill(-1)
    for (const s of rawScores) {
      const rec = s as Record<string, unknown>
      const idx = Number(rec?.index)
      const val = Number(rec?.score)
      if (Number.isInteger(idx) && idx >= 1 && idx <= candidates.length && Number.isFinite(val)) {
        scores[idx - 1] = Math.max(0, Math.min(100, Math.round(val)))
      }
    }
    // Fallback indeks tanpa skor: turunkan ke 0 (peserta tanpa nilai kalah)
    for (let i = 0; i < scores.length; i++) if (scores[i] < 0) scores[i] = 0

    // Shortlist dari model; bila tidak valid → pilih 3 skor tertinggi (deterministik)
    let shortlist: number[] = Array.isArray(parsed.shortlist)
      ? parsed.shortlist
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length)
          .map((n) => n - 1)
      : []
    shortlist = Array.from(new Set(shortlist)).slice(0, 3)
    if (shortlist.length === 0) {
      shortlist = scores
        .map((s, i) => ({ s, i }))
        .sort((a, b) => b.s - a.s)
        .slice(0, Math.min(3, candidates.length))
        .map((x) => x.i)
    }
    return { scores, shortlist }
  }
  throw new Error("Fase skor turnamen tidak valid")
}

/** Fase B — debat head-to-head finalis → juara + revisi (gaya critiqueAndSelect lama) */
export async function debateFinalists(
  candidates: StrategyCandidate[],
  scores: number[],
  shortlist: number[],
  primaryKeyword: string,
  dossier: ContentDossier,
  duration: number
): Promise<CritiqueResult> {
  const zai = await ZAI.create()

  const list = shortlist
    .map(
      (idx, pos) =>
        `FINALIS ${pos + 1} (KANDIDAT ${idx + 1} — skor rubrik fase skor: ${scores[idx]}/100):\n  hook: ${candidates[idx].hook}\n  caption: ${JSON.stringify(candidates[idx].caption)}\n  hashtags: ${JSON.stringify(candidates[idx].hashtags)}\n  overlay 0-2s: ${JSON.stringify(candidates[idx].overlays.find((o) => o.when.includes("0-2"))?.text ?? "(TIDAK ADA)")}\n  pinnedComment: ${JSON.stringify(candidates[idx].pinnedComment)}`
    )
    .join("\n\n")

  const userPrompt = `Debatkan ${shortlist.length} finalis untuk video ${Math.round(duration)}s niche "${dossier.niche}". Keyword utama: "${primaryKeyword}". Maksud video (jangkar semantik): "${dossier.semanticCore || dossier.coreSubject}". Entitas: ${JSON.stringify(dossier.entities)}.

${list}

RUBRIK (total 100):
- HOOK RETENSI (30): hook memaksa bertahan lewat detik 1-3? Spesifik > generik.
- SEO SEARCH (20): primaryKeyword di 5 karakter PERTAMA hook? di baris 1 caption? di overlay detik 0-2s?
- KEJELASAN MAKSUD (15): maksud video (subjek + manfaat + untuk siapa) langsung terpahami dari judul + baris-1 caption tanpa menonton — semakin jelas semakin mudah diranking algoritma manapun.
- SINYAL ENTITAS (10): brand/produk/entitas spesifik disebut eksplisit (jangkar knowledge graph).
- SHARE-ABILITY (15): CTA memancing share/komentar? (share > komentar > like)
- OCR SYNERGY (10): overlay terbaca OCR & menguatkan keyword?

Di internmu, jalankan debat: argumen TERKUAT tiap finalis, kelemahan tiap finalis, rebuttal. Pilih 1 JUARA. Revisi field juara yang lemah (boleh menulis ulang hook/caption/pinnedComment agar rubrik naik) — JANGAN mengubah primaryKeyword dan niche.

JSON:
{
  "debateSummary": "2-3 kalimat: argumen kunci finalis kuat vs lemah",
  "winnerIndex": "nomor KANDIDAT juara (1-${candidates.length}, sesuai nomor kandidat asli)",
  "reasoning": "2-3 kalimat kenapa juara menang",
  "finalHook": "hook juara — sudah direvisi bila perlu (primaryKeyword tetap di depan)",
  "finalCaption": "caption juara — sudah direvisi, struktur tetap: baris 1 keyword, pertanyaan CTA, baris terakhir 3-4 hashtag #",
  "finalPinnedComment": "komentar pin terbaik",
  "revisionNotes": ["apa yang kamu revisi & kenapa", ...maks 3]
}`

  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: CRITIQUE_DEBATE_SYSTEM },
          {
            role: "user",
            content: attempt === 0 ? userPrompt : `${userPrompt}\n\nPENTING: Balas HANYA JSON valid.`,
          },
        ],
        thinking: { type: "enabled" },
      }),
      CRITIQUE_DEBATE_TIMEOUT_MS,
      "Debat finalis"
    )
    const parsed = extractJson(completion.choices[0]?.message?.content ?? "")
    if (!parsed) continue
    const idx = Number(parsed.winnerIndex)
    if (!Number.isInteger(idx) || idx < 1 || idx > candidates.length) continue
    const winner = candidates[idx - 1]
    const finalHook = String(parsed.finalHook ?? "").trim()
    const finalCaption = String(parsed.finalCaption ?? "").trim()
    if (!finalHook || !finalCaption) continue
    return {
      winnerIndex: idx - 1,
      reasoning: `${String(parsed.debateSummary ?? "").slice(0, 250)} — ${String(parsed.reasoning ?? "").slice(0, 250)}`.trim(),
      finalHook: finalHook.slice(0, 150),
      finalCaption: finalCaption.slice(0, 2200),
      finalPinnedComment: String(parsed.finalPinnedComment ?? winner.pinnedComment ?? "").trim().slice(0, 300),
      revisionNotes: toStringArray(parsed.revisionNotes, 3, 200),
      scores,
    }
  }
  throw new Error("Debat finalis tidak menghasilkan juara valid")
}

/**
 * Orkestrator KRITIK v2: fase skor → fase debat.
 * Bila fase debat gagal, fallback: kandidat skor tertinggi tanpa revisi.
 */
export async function critiqueAndSelect(
  candidates: StrategyCandidate[],
  primaryKeyword: string,
  dossier: ContentDossier,
  duration: number
): Promise<CritiqueResult> {
  const { scores, shortlist } = await scoreCandidates(candidates, primaryKeyword, dossier, duration)
  try {
    return await debateFinalists(candidates, scores, shortlist, primaryKeyword, dossier, duration)
  } catch {
    // Fallback deterministik: finalis skor tertinggi menang tanpa revisi
    const best = shortlist[0] ?? 0
    return {
      winnerIndex: best,
      reasoning: `Fase debat gagal — dipilih finalis skor tertinggi (${scores[best]}/100) dari turnamen rubrik.`,
      finalHook: candidates[best].hook,
      finalCaption: candidates[best].caption,
      finalPinnedComment: candidates[best].pinnedComment,
      revisionNotes: [],
      scores,
    }
  }
}

// ============================================================
// TAHAP 5 — REFLEKSI (Reflexion pattern): revisi field lemah
// Dipanggil pipeline HANYA bila rubrik deterministik < gate.
// ============================================================

export interface FieldOverrides {
  hook?: string
  caption?: string
  pinnedComment?: string
  hashtags?: string[]
  overlays?: { text: string; when: string }[]
  coverText?: string
}

const REFINE_SYSTEM = `Kamu adalah agen refleksi untuk metadata TikTok yang baru GAGAL rubrik kualitas. Kamu menerima: field saat ini + daftar kegagalan rubrik. Perbaiki HANYA field yang terkait kegagalan — field yang sudah baik TIDAK boleh diubah (tulis string kosong ""). Jawab HANYA JSON valid.`

export async function refineWeakFields(input: {
  hook: string
  caption: string
  pinnedComment: string
  coverText: string
  primaryKeyword: string
  dossier: ContentDossier
  failures: string[]
}): Promise<FieldOverrides | null> {
  const zai = await ZAI.create()

  const userPrompt = `Metadata TikTok berikut GAGAL rubrik. Keyword utama: "${input.primaryKeyword}". Niche: "${input.dossier.niche}".

=== FIELD SAAT INI ===
hook: ${input.hook}
caption: ${JSON.stringify(input.caption)}
pinnedComment: ${JSON.stringify(input.pinnedComment)}
coverText: ${JSON.stringify(input.coverText)}

=== KEGAGALAN RUBRIK (deterministik) ===
${input.failures.map((f, i) => `${i + 1}. ${f}`).join("\n")}

=== ATURAN RUBRIK ===
- Hook: ada angka ATAU kontras/pertanyaan (jangan|ternyata|sebelum|sesudah|dari X ke Y), panjang 25-90 karakter.
- SEO: primaryKeyword "${input.primaryKeyword}" WAJIB di 5 karakter PERTAMA hook, di baris 1 caption, dan di overlay detik 0-2s.
- Share: caption WAJIB punya pertanyaan CTA; pinnedComment wajib ada.
- OCR: overlay 0-2s wajib mengandung bagian keyword.
- Cover: coverText 4-40 karakter & mengandung bagian keyword atau kata kuat (jangan/ternyata/wajib/rahasia/angka).
- Brand: caption revisi TETAP memuat "@review.picks" (baris kredit sebelum hashtag) dan terasa khas akun ${ACCOUNT.handle}.

JSON — tulis "" untuk field TIDAK PERLU diubah:
{
  "hook": "revisi hook",
  "caption": "revisi caption (baris 1 keyword, pertanyaan CTA, 3-4 hashtag # di akhir)",
  "pinnedComment": "revisi komentar pin",
  "coverText": "revisi teks cover",
  "overlay02s": "revisi overlay detik 0-2s",
  "fixNotes": ["apa yang diperbaiki", ...maks 3]
}`

  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: REFINE_SYSTEM },
          {
            role: "user",
            content: attempt === 0 ? userPrompt : `${userPrompt}\n\nPENTING: Balas HANYA JSON valid.`,
          },
        ],
        thinking: { type: "enabled" },
      }),
      REFINE_TIMEOUT_MS,
      "Refleksi revisi"
    )
    const parsed = extractJson(completion.choices[0]?.message?.content ?? "")
    if (!parsed) continue

    const overrides: FieldOverrides = {}
    const hook = String(parsed.hook ?? "").trim()
    const caption = String(parsed.caption ?? "").trim()
    const pinned = String(parsed.pinnedComment ?? "").trim()
    const cover = String(parsed.coverText ?? "").trim()
    const overlay = String(parsed.overlay02s ?? "").trim()
    if (hook) overrides.hook = hook.slice(0, 150)
    if (caption) overrides.caption = caption.slice(0, 2200)
    if (pinned) overrides.pinnedComment = pinned.slice(0, 300)
    if (cover) overrides.coverText = cover.slice(0, 40)
    if (overlay) overrides.overlays = [{ text: overlay.slice(0, 60), when: "0-2s" }]

    // Guard refleksi: jangan biarkan revisi MENGHAPUS keyword utama dari hook
    if (overrides.hook) {
      const kwFirst = input.primaryKeyword.split(" ")[0]?.toLowerCase() ?? ""
      if (kwFirst && !overrides.hook.toLowerCase().slice(0, 12).includes(kwFirst)) {
        // Revisi buruk — buang, pertahankan hook lama
        delete overrides.hook
      }
    }

    const hasAny = Object.values(overrides).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))
    return hasAny ? overrides : null
  }
  throw new Error("Refleksi tidak menghasilkan revisi valid")
}

// ============================================================
// TAHAP 6 — VALIDASI DETERMINISTIK + RUBRIK 6 FAKTOR
// ============================================================

/** Tag generik tanpa nilai ranking (riset: hashtag generik tidak menaikkan distribusi) */
const BANNED_TAGS = new Set([
  "fyp", "foryou", "foryoupage", "viral", "xyzbca", "tiktok", "tiktokindonesia", "paratiiktok",
])

/**
 * BRAND GUARD deterministik — caption final WAJIB memuat kredit akun
 * @review.picks. Bila LLM lupa menyebut handle, sisipkan baris kredit
 * standar tepat sebelum baris hashtag (baris terakhir tetap hashtag,
 * jadi rubrik SEO/SHARE tidak terpengaruh). Jaminan 100% — tidak
 * bergantung pada kepatuhan model.
 */
function applyBrandSignature(caption: string): string {
  if (caption.toLowerCase().includes(ACCOUNT.username)) return caption
  const sig = captionSignatureLine()
  const lines = caption.split(/\r?\n/)
  const tagIdx = lines.findIndex((l) => l.trim().startsWith("#"))
  if (tagIdx === -1) return `${caption}\n\n${sig}`
  if (tagIdx === 0) return `${sig}\n\n${caption}`
  const prev = lines[tagIdx - 1]?.trim() ?? ""
  lines.splice(tagIdx, 0, ...(prev === "" ? [sig] : ["", sig]))
  return lines.join("\n")
}

export interface RubricItem {
  id: string
  label: string
  score: number
  max: number
  detail: string
}

export interface ReviewAgentResult {
  metadata: TikTokMetadata
  dossier: ContentDossier
  hookAlternatives: { hook: string; angle: string }[]
  critiqueReasoning: string
  agentTrace: string[]
  /** Total skor rubrik — dipakai pipeline sebagai gate Reflexion */
  score: number
  /** Breakdown rubrik per faktor — masuk metadata UI */
  rubric: RubricItem[]
}

/**
 * Validasi + rubrik skor DETERMINISTIK (bukan angka dari LLM), v3 OmniRank —
 * 9 faktor 100 pts. Dua faktor baru menjawab misi "algoritma manapun mudah
 * memahami maksud video & bisa ranking":
 * - HOOK 25: kontras/pertanyaan 12 + angka 6 + panjang 25-90 → 7
 * - SEO 20: keyword di awal hook 8 + di hook 4 + di caption baris 1 4 + overlay 0-2s 4
 * - MAKSUD 15: semantic core eksplisit 5 + hook menyampaikan maksud 5 + entitas di caption 5
 * - ENTITY 10: entitas teridentifikasi 3 + entitas di hook 4 + entitas di keyword 3
 * - SHARE 10: CTA pertanyaan di caption 7 + pinnedComment ada 3
 * - OCR 10: overlay-0 mengandung keyword 10 / overlay ada 5
 * - COVER 5: coverText ideal 3 + mengandung keyword/kata-kuat 2
 * - TAG 5: 3-4 tag bersih 3 + ≥1 tag spesifik 2
 */

/** Cek overlap kata bermakna (≥4 huruf) antar dua teks — deterministik */
function wordsOverlap(a: string, b: string): boolean {
  const wb = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 4)
  )
  if (wb.size === 0) return false
  return a
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .some((w) => wb.has(w))
}

/** Cari needle pertama yang muncul di text (case-insensitive, ≥3 huruf) */
function containsAny(text: string, needles: string[]): string | null {
  const t = text.toLowerCase()
  for (const n of needles) {
    const nn = n.toLowerCase().trim()
    if (nn.length >= 3 && t.includes(nn)) return nn
  }
  return null
}
export function validateAndScore(
  winner: StrategyCandidate,
  critique: CritiqueResult | null,
  dossier: ContentDossier,
  allCandidates: StrategyCandidate[],
  primaryKeyword: string,
  extras?: StrategyExtras | null,
  overrides?: FieldOverrides | null,
  queryMap?: SearchQueryMap | null
): ReviewAgentResult {
  const kw = primaryKeyword.toLowerCase()
  const kwFirst = kw.split(" ")[0] ?? kw
  const hook = (overrides?.hook || critique?.finalHook || winner.hook).slice(0, 150)
  // Brand guard — caption final wajib memuat kredit akun (deterministik)
  const caption = applyBrandSignature(
    (overrides?.caption || critique?.finalCaption || winner.caption).slice(0, 2200)
  )
  const pinnedComment = (overrides?.pinnedComment || critique?.finalPinnedComment || winner.pinnedComment).trim()
  const coverText = (overrides?.coverText || extras?.coverText || "").trim()
  const overlays =
    overrides?.overlays ??
    (winner.overlays.length > 0
      ? winner.overlays
      : [{ text: primaryKeyword.toUpperCase(), when: "0-2s" }])

  // ---- Sanitasi hashtag: buang banned, duplikat, terlalu panjang ----
  const seen = new Set<string>()
  const hashtags = (overrides?.hashtags ?? winner.hashtags)
    .map((h) => h.replace(/^#/, "").trim().toLowerCase())
    .filter((h) => {
      if (!h || h.length > 30 || BANNED_TAGS.has(h) || seen.has(h)) return false
      seen.add(h)
      return true
    })
    .slice(0, 4)

  // ---- Filename: kebab-case, keyword-first ----
  const slug = winner.filename
    .toLowerCase()
    .replace(/\.mp4$/i, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")

  // ---- Rubrik skor deterministik (v4 SearchRank — 9 faktor, total 100) ----
  const rubric: RubricItem[] = []
  let score = 0

  // HOOK (22)
  const hookHasQuestion = /\?/.test(hook)
  const hookHasNumber = /\d/.test(hook)
  const hookHasContrast =
    /(jangan|jangan sampai|bukan|sebelum|sesudah|ternyata|ni|ini kenapa)/i.test(hook) ||
    /dari\s+\S+(\s+\S+){0,3}\s+ke\s+\S+/i.test(hook)
  const hookLen = hook.length
  let hookScore = 0
  const hookDetails: string[] = []
  if (hookHasQuestion || hookHasContrast) {
    hookScore += 10
    hookDetails.push("ada pertanyaan/kontras")
  } else {
    hookDetails.push("TIDAK ada pertanyaan/kontras/angka")
  }
  if (hookHasNumber) {
    hookScore += 6
    hookDetails.push("ada angka")
  }
  if (hookLen >= 25 && hookLen <= 90) {
    hookScore += 6
    hookDetails.push(`panjang ${hookLen} karakter ideal`)
  } else {
    hookDetails.push(`panjang ${hookLen} karakter (ideal 25-90)`)
  }
  score += hookScore
  rubric.push({ id: "HOOK", label: "Hook Retention", score: hookScore, max: 22, detail: hookDetails.join(", ") })

  // SEO (18)
  let seoScore = 0
  const seoDetails: string[] = []
  if (hook.toLowerCase().slice(0, 12).includes(kwFirst)) {
    seoScore += 7
    seoDetails.push("keyword di 12 karakter awal hook")
  } else {
    seoDetails.push("keyword TIDAK di awal hook")
  }
  if (hook.toLowerCase().includes(kw)) {
    seoScore += 4
    seoDetails.push("frasa keyword utuh di hook")
  }
  const firstCaptionLine = caption.split(/\r?\n/)[0]?.toLowerCase() ?? ""
  if (firstCaptionLine.includes(kwFirst)) {
    seoScore += 4
    seoDetails.push("keyword di baris 1 caption")
  } else {
    seoDetails.push("keyword TIDAK di baris 1 caption")
  }
  if (
    overlays.some(
      (o) =>
        o.when.includes("0-2") &&
        o.text.toLowerCase().split(/\s+/).some(
          (w) => kw.includes(w.toLowerCase()) || w.toLowerCase().includes(kwFirst)
        )
    )
  ) {
    seoScore += 3
    seoDetails.push("overlay 0-2s mengandung keyword")
  } else {
    seoDetails.push("overlay 0-2s TIDAK mengandung keyword")
  }
  score += seoScore
  rubric.push({ id: "SEO", label: "SEO Pencarian", score: seoScore, max: 18, detail: seoDetails.join(", ") })

  // MAKSUD (14) — v3 OmniRank: kejelasan maksud video untuk SEMUA algoritma.
  // Video yang maksudnya eksplisit → embedding semantik presisi → relevansi tinggi.
  const semanticCore = dossier.semanticCore?.trim() ?? ""
  const meaningAnchor = semanticCore || dossier.coreSubject
  let meaningScore = 0
  const meaningDetails: string[] = []
  if (semanticCore.length >= 20) {
    meaningScore += 5
    meaningDetails.push("maksud video dirumuskan eksplisit (semantic core)")
  } else {
    meaningDetails.push("semantic core kosong/terlalu pendek")
  }
  if (wordsOverlap(hook, meaningAnchor)) {
    meaningScore += 5
    meaningDetails.push("hook menyampaikan maksud video")
  } else {
    meaningDetails.push("hook TIDAK mencerminkan maksud video")
  }
  const captionEntityHit = containsAny(caption, dossier.entities)
  if (captionEntityHit) {
    meaningScore += 4
    meaningDetails.push(`entitas "${captionEntityHit}" hadir di caption`)
  } else {
    meaningDetails.push(
      dossier.entities.length > 0 ? "entitas TIDAK hadir di caption" : "tidak ada entitas teridentifikasi"
    )
  }
  score += meaningScore
  rubric.push({ id: "MAKSUD", label: "Kejelasan Maksud", score: meaningScore, max: 14, detail: meaningDetails.join(", ") })

  // ENTITY (9) — v3 OmniRank: jangkar knowledge graph. Konten dengan entitas
  // jelas lebih mudah dicocokkan ke query pencarian & minat penonton.
  let entityScore = 0
  const entityDetails: string[] = []
  if (dossier.entities.length > 0) {
    entityScore += 3
    entityDetails.push(`${dossier.entities.length} entitas teridentifikasi`)
  } else {
    entityDetails.push("tidak ada entitas (konten tanpa produk/brand)")
  }
  const hookEntityHit = containsAny(hook, dossier.entities)
  if (hookEntityHit) {
    entityScore += 4
    entityDetails.push(`entitas "${hookEntityHit}" di hook`)
  } else if (dossier.entities.length > 0) {
    entityDetails.push("hook TIDAK menyebut entitas")
  }
  const keywordBlob = [primaryKeyword, ...toStringArray(winner.keywords, 10), ...dossier.searchIntents]
    .join(" ")
    .toLowerCase()
  const kwEntityHit = containsAny(keywordBlob, dossier.entities)
  if (kwEntityHit) {
    entityScore += 2
    entityDetails.push(`entitas "${kwEntityHit}" di keyword pencarian`)
  } else if (dossier.entities.length > 0) {
    entityDetails.push("keyword TIDAK memuat entitas")
  }
  score += entityScore
  rubric.push({ id: "ENTITY", label: "Sinyal Entitas", score: entityScore, max: 9, detail: entityDetails.join(", ") })

  // SHARE (9) — share > komentar > like (叠加推荐); CTA pertanyaan memicu komentar
  const bodyCaption = caption.split(/\r?\n/).filter((l) => !l.startsWith("#")).join(" ")
  const hasCtaQuestion = /\?/.test(bodyCaption)
  let shareScore = 0
  const shareDetails: string[] = []
  if (hasCtaQuestion) {
    shareScore += 6
    shareDetails.push("CTA pertanyaan di caption")
  } else {
    shareDetails.push("TIDAK ada CTA pertanyaan di caption")
  }
  if (pinnedComment) {
    shareScore += 3
    shareDetails.push("komentar pin tersedia")
  } else {
    shareDetails.push("komentar pin kosong")
  }
  score += shareScore
  rubric.push({ id: "SHARE", label: "Share-ability", score: shareScore, max: 9, detail: shareDetails.join(", ") })

  // OCR (9)
  const firstOverlay = overlays[0]?.text?.toLowerCase() ?? ""
  let ocrScore = 0
  let ocrDetail = "TIDAK ada overlay"
  if (firstOverlay) {
    if (firstOverlay.includes(kwFirst) || kw.includes(firstOverlay.split(/\s+/)[0] ?? "~~~")) {
      ocrScore = 9
      ocrDetail = "overlay utama mengandung keyword"
    } else {
      ocrScore = 4
      ocrDetail = "overlay ada tapi TIDAK mengandung keyword"
    }
  }
  score += ocrScore
  rubric.push({ id: "OCR", label: "Sinergi OCR", score: ocrScore, max: 9, detail: ocrDetail })

  // COVER (5)
  const cover = coverText.toLowerCase()
  let coverScore = 0
  const coverDetails: string[] = []
  if (cover.length >= 4 && cover.length <= 40) {
    coverScore += 3
    coverDetails.push("panjang cover ideal")
  } else {
    coverDetails.push("coverText kosong/panjang tidak ideal")
  }
  const hasPowerWord = /(jangan|ternyata|wajib|rahasia|\d)/.test(cover)
  if (cover && (cover.includes(kwFirst) || hasPowerWord)) {
    coverScore += 2
    coverDetails.push("cover mengandung keyword/kata kuat")
  } else if (cover) {
    coverDetails.push("cover TIDAK mengandung keyword/kata kuat")
  }
  score += coverScore
  rubric.push({ id: "COVER", label: "Cover CTR", score: coverScore, max: 5, detail: coverDetails.join(", ") })

  // TAG (4)
  let tagScore = 0
  const tagDetails: string[] = []
  if (hashtags.length >= 3) {
    tagScore += 2
    tagDetails.push(`${hashtags.length} tag bersih (3-4 ideal)`)
  } else {
    tagDetails.push(`hanya ${hashtags.length} tag bersih`)
  }
  const tagSpecific =
    hashtags.some((h) => h.includes(kwFirst.replace(/\s+/g, "")) || h.length >= 8) || hashtags.length >= 4
  if (tagSpecific) {
    tagScore += 2
    tagDetails.push("ada tag niche spesifik")
  } else {
    tagDetails.push("tag terlalu generik")
  }
  score += tagScore
  rubric.push({ id: "TAG", label: "Kualitas Hashtag", score: tagScore, max: 4, detail: tagDetails.join(", ") })

  // QUERIES (10) — v4 SearchRank: coverage short-query lintas permukaan.
  // Query peta harus hadir di judul/caption/hashtag/overlay/keywords/nama file —
  // semakin banyak permukaan yang cocok, semakin yakin algoritma meranking.
  const qList = queryMap?.queries.map((q) => q.query) ?? []
  let queryScore = 0
  const queryDetails: string[] = []
  if (qList.length === 0) {
    queryDetails.push("peta query tidak tersedia (tahap query map gagal — pakai fallback)")
  } else {
    const querySurfaces = {
      title: hook,
      caption,
      hashtags,
      overlays: overlays.map((o) => o.text),
      filename: slug,
      keywords: Array.from(
        new Set([...qList, primaryKeyword, ...dossier.searchIntents, ...dossier.entities])
      ),
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
    } else if (foundCount === 1) {
      queryScore = 3
      queryDetails.push(`hanya 1/${qList.length} query hadir — target minimal 3`)
    } else {
      queryDetails.push("TIDAK ada satu pun query peta yang hadir di metadata")
    }
    const placedSample = placements
      .filter((p) => p.where.length > 0)
      .slice(0, 3)
      .map((p) => `"${p.q}"→${p.where.join("/")}`)
      .join(", ")
    if (placedSample) queryDetails.push(placedSample)
    if (missing.length > 0) queryDetails.push(`belum ditanam: ${missing.slice(0, 3).join(", ")}`)
  }
  score += queryScore
  rubric.push({ id: "QUERIES", label: "Peta Query", score: queryScore, max: 10, detail: queryDetails.join(", ") })

  // Keyword gabungan: primaryKeyword + SELURUH query peta (v4 SearchRank) +
  // entitas (jangkar knowledge graph) + keyword strategi + search intent —
  // semua masuk atom keywords MP4 & panel UI.
  const keywords = Array.from(
    new Set([
      primaryKeyword,
      ...qList,
      ...dossier.entities,
      ...toStringArray(winner.keywords, 10),
      ...dossier.searchIntents,
    ])
  ).slice(0, 16)

  // Label angle mengikuti urutan GENERASI kandidat (1=curiosity, 2=pertanyaan,
  // 3=kontras, 4=angka, 5=negasi, 6=relatabil) — bukan urutan baru setelah
  // filter, agar label selalu cocok dengan hook yang sebenarnya.
  // Dedupe: LLM kadang mengembalikan teks hook identik untuk dua angle —
  // jangan tampilkan alternatif duplikat di UI.
  const CANDIDATE_ANGLES = ["curiosity", "pertanyaan", "kontras", "angka", "negasi", "relatabil"]
  const hookAlternatives = allCandidates
    .map((c, i) => ({ hook: c.hook, angle: CANDIDATE_ANGLES[i] ?? "alternatif" }))
    .filter((_, i) => i !== (critique?.winnerIndex ?? 0))
    .filter((h, i, arr) => arr.findIndex((x) => x.hook.trim() === h.hook.trim()) === i)
    .slice(0, 3)

  const platformCount = extras?.platformPackages?.length ?? 0
  const queryTrace = queryMap
    ? `Query Map: produk "${queryMap.product}" (${queryMap.productType}) — ${queryMap.queries.length} short query: ${queryMap.queries.map((q) => `"${q.query}"[${q.intent}]`).join(", ")}`
    : "Query Map: tidak tersedia — rubrik QUERIES dinilai dari keyword strategi"
  const agentTrace = [
    `Persepsi: multi-scale observation (vision + keyframe adaptif + audio)`,
    `Sintesis: Content Dossier — niche "${dossier.niche}" · maksud video terkunci${semanticCore ? " (semantic core siap)" : ""} · ${dossier.entities.length} entitas`,
    queryTrace,
    `Strategi: ${allCandidates.length} kandidat hook dari 6 angle + paket sinyal TikTok (cover, jam posting, sound, durasi)${platformCount > 0 ? ` + OmniRank ${platformCount} platform (TikTok · YouTube Shorts · Instagram Reels · Douyin)` : ""}${queryMap ? " + ≥3 query peta ditanam di caption" : ""}`,
    critique?.scores
      ? `Kritik: turnamen — ${critique.scores.map((s, i) => `#${i + 1}=${s}`).join(" ")} → debat finalis → juara #${critique.winnerIndex + 1}`
      : critique
        ? `Kritik: juara #${critique.winnerIndex + 1} — ${critique.reasoning.slice(0, 140)}`
        : `Kritik: dilewati — pakai kandidat terbaik langsung`,
    overrides
      ? `Refleksi: revisi 1 putaran — ${Object.keys(overrides).join(", ")} diperbaiki`
      : "Refleksi: gate terlewati (skor ≥ gate) atau refleksi tidak tersedia",
    `Validasi SearchRank: rubrik 9 faktor ${score}/100 — ${rubric.map((r) => `${r.label} ${r.score}/${r.max}`).join(" · ")}`,
  ]

  const retentionPlan = extras?.retentionPlan?.length ? extras.retentionPlan : undefined

  return {
    metadata: {
      title: hook,
      caption,
      hashtags,
      keywords,
      overlays: overlays.map((o) => `${o.when}: ${o.text}`),
      seoTips: buildSeoTips(dossier, overlays, hashtags, critique, caption, extras?.platformPackages, queryMap),
      seoScore: Math.max(40, Math.min(100, score)),
      filename: slug || "review-picks-video",
      coverText: coverText || undefined,
      bestPostTime: extras?.bestPostTime || undefined,
      soundStrategy: extras?.soundStrategy || undefined,
      durationAdvice: extras?.durationAdvice || undefined,
      retentionPlan,
      // ===== v3 OmniRank — pemahaman mesin & paket lintas-platform =====
      semanticCore: semanticCore || undefined,
      entities: dossier.entities.length > 0 ? dossier.entities : undefined,
      category: dossier.category || undefined,
      platformPackages: extras?.platformPackages?.length ? extras.platformPackages : undefined,
      // ===== v4 SearchRank — Peta Keyword Pencarian =====
      queryMap: queryMap ?? undefined,
    },
    dossier,
    hookAlternatives,
    critiqueReasoning: critique?.reasoning ?? "",
    agentTrace,
    score,
    rubric,
  }
}

function buildSeoTips(
  dossier: ContentDossier,
  overlays: { text: string; when: string }[],
  hashtags: string[],
  critique: CritiqueResult | null,
  caption?: string,
  platformPackages?: PlatformPackage[],
  queryMap?: SearchQueryMap | null
): string[] {
  const tips: string[] = []
  tips.push(
    overlays.some((o) => o.when.includes("0-2"))
      ? "Overlay detik 0-2s sudah terpasang — jaga agar teksnya tampil sejak frame pertama saat editing"
      : "Tambahkan teks overlay di detik 0-2 — riset menunjukkan swipe-away awal menghentikan distribusi"
  )
  if (queryMap && queryMap.queries.length >= 3) {
    tips.push(
      `${queryMap.queries.length} short query terpetakan: ${queryMap.queries.slice(0, 3).map((q) => `"${q.query}"`).join(", ")} — ucapkan minimal 2 di antaranya secara lisan di video (ASR membaca ucapan sebagai sinyal pencarian)`
    )
  }
  if (dossier.searchIntents.length > 0) {
    tips.push(`Ucapkan "${dossier.searchIntents[0]}" secara lisan di 3 detik pertama — ASR semua platform membaca ucapanmu sebagai sinyal SEO`)
  }
  if (dossier.semanticCore) {
    tips.push(`Maksud video sudah dirumuskan mesin — pastikan kalimat ini tercermin di judul/caption manual: "${dossier.semanticCore.slice(0, 120)}"`)
  }
  if (platformPackages && platformPackages.length > 0) {
    tips.push(`Paket ${platformPackages.length} platform siap salin (TikTok · YouTube Shorts · Instagram Reels · Douyin) — unggah versi masing-masing untuk memperluas distribusi tanpa pindah aplikasi`)
  }
  if (hashtags.length >= 3) {
    tips.push(`Pasang kontenmu di niche "${dossier.niche}" — konsistensi niche di akun ${ACCOUNT.handle} menaikkan tag akun di sistem distribusi`)
  }
  if (caption?.toLowerCase().includes(ACCOUNT.username)) {
    tips.push(`Kredit ${ACCOUNT.handle} sudah terpasang di caption — arahkan penonton ke profil untuk rekomendasi berikutnya`)
  }
  if (critique?.revisionNotes?.length) tips.push(critique.revisionNotes[0])
  return tips.slice(0, 6)
}

// ============================================================
// METADATA darurat (semua agent gagal) — pipeline tetap selesai
// ============================================================

export function fallbackMetadata(clipNames: string[], duration: number): TikTokMetadata {
  const first = (clipNames[0] ?? "video")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
  const base = first.length > 0 ? first : "Video gabungan"
  const hashtags = ["kontenkreator", "kreatorindonesia", "videomenarik"]
  const semanticCore = `Video ini menunjukkan ${base.toLowerCase()} untuk penonton yang mencari informasi tentangnya`
  return {
    title: `${base} — tonton sampai habis!`.slice(0, 90),
    caption: `${base}\n\nVideo ${
      clipNames.length === 1 ? "yang sudah dioptimalkan" : "gabungan"
    } ${duration < 60 ? "singkat" : "menarik"} ini wajib kamu tonton sampai akhir! Menurut kamu gimana? Komen di bawah 👇\n\n${captionSignatureLine()}\n\n${hashtags
      .map((h) => `#${h}`)
      .join(" ")}`,
    hashtags,
    keywords: [base.toLowerCase(), "video gabungan", "konten kreator indonesia"],
    overlays: ["0-2s: Tonton sampai habis!", "Tengah: Jangan lewatkan!"],
    seoTips: [
      "AI agent gagal merangkai metadata — edit manual dengan keyword niche kontenmu",
      "Sebutkan topik utama secara lisan di 3 detik pertama video",
      "Tambahkan 3-4 hashtag spesifik dengan niche kamu",
      `Baris kredit ${ACCOUNT.handle} sudah otomatis terpasang di caption sebelum hashtag`,
    ],
    seoScore: 55,
    // ===== v3 OmniRank — fallback tetap menyediakan jangkar semantik & paket platform =====
    semanticCore,
    entities: [],
    platformPackages: [
      {
        platform: "TikTok",
        caption: `${base}\n\n${captionSignatureLine()}\n\n${hashtags.map((h) => `#${h}`).join(" ")}`,
        hashtags,
        note: "mode fallback — cek & lengkapi manual",
      },
      {
        platform: "YouTube Shorts",
        title: base.slice(0, 100),
        caption: `${base}. Video singkat tentang ${base.toLowerCase()} — tonton sampai habis biar tidak ada yang terlewat.`,
        hashtags: hashtags.slice(0, 3),
        note: "mode fallback",
      },
      {
        platform: "Instagram Reels",
        caption: `${base} — tonton sampai habis!\n\n${captionSignatureLine()}`,
        hashtags: [...hashtags, "reels", "instagramreels"].slice(0, 6),
        note: "mode fallback",
      },
    ],
  }
}

// ------------------------------------------------------------
// Util JSON
// ------------------------------------------------------------

function extractJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

function toStringArray(v: unknown, max: number, len = 80): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => String(x ?? "").replace(/^#/, "").trim().slice(0, len))
    .filter(Boolean)
    .slice(0, max)
}
