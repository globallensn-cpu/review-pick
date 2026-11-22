"use client"

// ============================================================
// Potong Video (ReviewCut) — UI studio baru, pola merge-tool:
// SegTabs Hasil/Riwayat → kartu sumber + progress + hasil
// (tab kerja) → composer melayang (DropZone/FileChip + pill
// + Lanjutan + aksi). FAQ & hero lama dihapus.
// Logika unggah/polling/restore sesi/beforeunload: TIDAK DIUBAH.
// ============================================================

import * as React from "react"
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  Film,
  History as HistoryIcon,
  Loader2,
  Package,
  RefreshCw,
  Scissors,
  Target,
} from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Composer } from "@/components/studio/composer"
import { DropZone, FileChip } from "@/components/studio/drop-input"
import { Pill, PillGroup, PillPopover } from "@/components/studio/option-pills"
import { RunProgress } from "@/components/studio/run-progress"
import { SegTabs } from "@/components/studio/seg-tabs"
import { ResultCard, ResultGrid } from "@/components/studio/result-card"
import { ResetConfirm } from "@/components/studio/reset-confirm"
import { useToast } from "@/hooks/use-toast"
import { uploadVideoRaw, UploadCanceled } from "@/lib/upload-client"
import { fetchAsFile, payloadFromHistory, useHandoff } from "@/lib/studio/handoff"
import { useHistory } from "@/lib/studio/history"
import { fmtBytes, timeAgo } from "@/lib/studio/format"
import { cn } from "@/lib/utils"

// ---------- tipe ----------

type Phase = "idle" | "ready" | "uploading" | "processing" | "done"
type Mode = "fast" | "precise"
type JobStatus = "queued" | "processing" | "done" | "error" | "cancelled"

interface VideoMeta {
  id: string
  name: string
  size: number
  duration: number
  width: number | null
  height: number | null
  hasAudio: boolean
}

interface UploadedVideo {
  id: string
  originalName: string
  size: number
  duration: number
  width: number | null
  height: number | null
  hasAudio: boolean
}

interface Segment {
  index: number
  file: string
  startTime: number
  duration: number
  size: number
  url: string
  downloadUrl: string
}

interface Job {
  id: string
  status: JobStatus
  mode: Mode
  segmentDuration: number
  rangeStart: number
  rangeEnd: number | null
  audioOnly: boolean
  totalDuration: number
  totalSegments: number
  completedSegments: number
  progress: number
  error?: string
  segments: Segment[]
}

// ---------- konstanta ----------

const ALLOWED_EXT = [
  "mp4", "mov", "mkv", "webm", "avi", "m4v",
  "mpg", "mpeg", "wmv", "flv", "3gp", "ts", "mts",
]
const MAX_SIZE = 500 * 1024 * 1024 // 500 MB
const PRESETS = [5, 10, 15, 30, 60]
const LS_VIDEO = "potongvideo:video"
const LS_JOB = "potongvideo:job"
const ACCEPT = `video/*,${ALLOWED_EXT.map((e) => `.${e}`).join(",")}`

// ---------- util ----------

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const mm = String(m).padStart(2, "0")
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function fmtDur(sec: number): string {
  if (sec < 60) {
    if (sec < 10 && !Number.isInteger(sec)) {
      return `${sec.toFixed(1).replace(".", ",")} detik`
    }
    return `${Math.round(sec)} detik`
  }
  const s = Math.round(sec % 60)
  const m = Math.floor(sec / 60)
  return `${m} mnt ${s} dtk`
}

function fileExt(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ""
}

// ---------- komponen utama ----------

export function SplitTool() {
  const { toast } = useToast()

  const [phase, setPhase] = React.useState<Phase>("idle")
  const [file, setFile] = React.useState<File | null>(null)
  const [videoUrl, setVideoUrl] = React.useState<string>("")
  const [meta, setMeta] = React.useState<VideoMeta | null>(null)
  const [bootChecked, setBootChecked] = React.useState(false)
  const [uploadPct, setUploadPct] = React.useState(0)
  const [uploadedBytes, setUploadedBytes] = React.useState(0)

  const [segDur, setSegDur] = React.useState(10)
  const [mode, setMode] = React.useState<Mode>("fast")
  const [useRange, setUseRange] = React.useState(false)
  const [rangeStart, setRangeStart] = React.useState(0)
  const [rangeEnd, setRangeEnd] = React.useState(10)
  const [audioOnly, setAudioOnly] = React.useState(false)

  const [previewError, setPreviewError] = React.useState(false)
  const [job, setJob] = React.useState<Job | null>(null)
  const [activeJobId, setActiveJobId] = React.useState<string | null>(null)
  const [previewSeg, setPreviewSeg] = React.useState<Segment | null>(null)
  const [hiddenSegs, setHiddenSegs] = React.useState<Set<number>>(() => new Set())
  const [tab, setTab] = React.useState<"kerja" | "riwayat">("kerja")

  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const urlRef = React.useRef<string>("")
  const previewVideoRef = React.useRef<HTMLVideoElement | null>(null)
  const xhrRef = React.useRef<XMLHttpRequest | null>(null)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const resultRef = React.useRef<HTMLDivElement>(null)
  const recordedJobRef = React.useRef<string | null>(null)

  const videoId = meta?.id || null
  const busy = phase === "uploading" || phase === "processing"
  const duration = meta?.duration ?? 0
  const noAudio = meta != null && !meta.hasAudio && !!meta.id

  const rangeValid =
    !useRange ||
    (rangeStart >= 0 &&
      rangeEnd > rangeStart &&
      (duration <= 0 || (rangeEnd <= duration + 0.001 && rangeStart < duration)))
  const cutWindow = useRange && rangeValid && rangeEnd > rangeStart ? rangeEnd - rangeStart : duration
  const estSegments = cutWindow > 0 ? Math.max(1, Math.ceil(cutWindow / segDur - 1e-9)) : 0

  // ---------- pemilihan file ----------

  const acceptFile = React.useCallback(
    (f: File | undefined | null) => {
      if (!f) return
      const ext = fileExt(f.name)
      if (!ALLOWED_EXT.includes(ext)) {
        toast({
          title: "Format tidak didukung",
          description: "Gunakan MP4, MOV, MKV, WEBM, AVI, MPG, WMV, FLV, atau 3GP.",
          variant: "destructive",
        })
        return
      }
      if (f.size > MAX_SIZE) {
        toast({
          title: "File terlalu besar",
          description: `Ukuran ${fmtBytes(f.size)} melebihi batas 500 MB.`,
          variant: "destructive",
        })
        return
      }

      // reset state lama
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      const url = URL.createObjectURL(f)
      urlRef.current = url
      try {
        window.localStorage.removeItem(LS_VIDEO)
        window.localStorage.removeItem(LS_JOB)
      } catch {}

      setFile(f)
      setVideoUrl(url)
      setJob(null)
      setActiveJobId(null)
      setUploadPct(0)
      setUploadedBytes(0)
      setHiddenSegs(new Set())
      setMeta({
        id: "",
        name: f.name,
        size: f.size,
        duration: 0,
        width: null,
        height: null,
        hasAudio: true,
      })
      setPreviewError(false)
      setPhase("ready")

      // baca metadata lokal
      const v = document.createElement("video")
      v.preload = "metadata"
      v.onloadedmetadata = () => {
        setMeta((m) =>
          m && m.name === f.name
            ? {
                ...m,
                duration: Number.isFinite(v.duration) ? v.duration : 0,
                width: v.videoWidth || null,
                height: v.videoHeight || null,
              }
            : m
        )
      }
      v.onerror = () => setPreviewError(true)
      v.src = url
    },
    [toast]
  )

  const openPicker = () => fileInputRef.current?.click()

  const resetVideo = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = ""
    try {
      window.localStorage.removeItem(LS_VIDEO)
      window.localStorage.removeItem(LS_JOB)
    } catch {}
    setFile(null)
    setVideoUrl("")
    setMeta(null)
    setJob(null)
    setActiveJobId(null)
    setUploadPct(0)
    setUploadedBytes(0)
    setPreviewError(false)
    setPreviewSeg(null)
    setHiddenSegs(new Set())
    setPhase("idle")
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const resetAll = () => {
    resetVideo()
    document.getElementById("studio-scroll")?.scrollTo({ top: 0, behavior: "smooth" })
  }

  // ---------- pemulihan sesi terakhir (setelah refresh) + handoff ----------

  React.useEffect(() => {
    let stale = false
    ;(async () => {
      let vid: string | null = null
      try {
        vid = window.localStorage.getItem(LS_VIDEO)
      } catch {}
      if (vid) {
        try {
          const res = await fetch(`/api/split/video/${vid}`, { cache: "no-store" })
          if (!res.ok) throw new Error("video hilang")
          const data = await res.json()
          if (!stale && data.ok) {
            const v = data.video
            setMeta({
              id: v.id,
              name: v.originalName,
              size: v.size,
              duration: v.duration,
              width: v.width,
              height: v.height,
              hasAudio: v.hasAudio,
            })
            setVideoUrl(`/api/split/video/${v.id}/file`)
            setPhase("ready")

            // pulihkan job terakhir bila masih relevan
            let lastJobId: string | null = null
            try {
              lastJobId = window.localStorage.getItem(LS_JOB)
            } catch {}
            const jobs: Job[] = data.jobs ?? []
            // Otamakan job tersimpan; jika tidak ada, sambung ulang job yang masih
            // berjalan di server agar refresh di tengah proses tidak kehilangan sesi.
            const j =
              (lastJobId ? jobs.find((x) => x.id === lastJobId) : null) ??
              jobs.find((x) => x.status === "queued" || x.status === "processing") ??
              null
            if (j) {
              setJob(j)
              if (j.status === "done") {
                setPhase("done")
                try {
                  window.localStorage.setItem(LS_JOB, j.id)
                } catch {}
              } else if (j.status === "queued" || j.status === "processing") {
                setPhase("processing")
                setActiveJobId(j.id)
                try {
                  window.localStorage.setItem(LS_JOB, j.id)
                } catch {}
              }
            }
          }
        } catch {
          try {
            window.localStorage.removeItem(LS_VIDEO)
            window.localStorage.removeItem(LS_JOB)
          } catch {}
        }
      }

      if (!stale) setBootChecked(true)

      // Kirim-ke: video terisi otomatis dari tool lain
      if (stale) return
      const p = useHandoff.getState().consume("potong")
      if (p?.kind === "file") {
        acceptFile(p.file)
      } else if (p?.kind === "video-url") {
        try {
          const f = await fetchAsFile(p.url, p.name)
          if (!stale) acceptFile(f)
        } catch {
          if (!stale) toast({ title: "Gagal mengambil berkas", variant: "destructive" })
        }
      }
    })()

    return () => {
      stale = true
    }
  }, [acceptFile])

  // ---------- polling status job ----------
  // Backoff eksponensial: 800ms awal, naik 2x saat gagal, maks 5 detik.
  // Reset ke 800ms begitu ada respons sukses.

  React.useEffect(() => {
    if (!activeJobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let delay = 800
    let failCount = 0

    const poll = async () => {
      let ok = false
      try {
        const res = await fetch(`/api/split/job/${activeJobId}`, { cache: "no-store" })
        const data = await res.json().catch(() => null)
        if (cancelled) return
        if (res.ok && data?.ok) {
          ok = true
          const j: Job = data.job
          setJob(j)
          if (j.status === "done") {
            setPhase("done")
            try {
              window.localStorage.setItem(LS_JOB, j.id)
            } catch {}
            toast({
              title: "Video berhasil dipotong",
              description: `${j.segments.length} bagian siap diunduh.`,
            })
            return
          }
          if (j.status === "cancelled") {
            setPhase("ready")
            toast({
              title: "Pemotongan dibatalkan",
              description: "Kamu bisa memotong ulang kapan saja.",
            })
            return
          }
          if (j.status === "error") {
            setPhase("ready")
            toast({
              title: "Gagal memotong video",
              description: j.error ?? "Terjadi kesalahan saat memproses.",
              variant: "destructive",
            })
            return
          }
        } else if (res.status === 404) {
          // Job sudah tidak ada (dibersihkan server / data hilang) —
          // jangan macet di "Memotong…" selamanya.
          setActiveJobId(null)
          setJob(null)
          setPhase("ready")
          try {
            window.localStorage.removeItem(LS_JOB)
          } catch {}
          toast({
            title: "Pekerjaan tidak ditemukan",
            description: "Data pemotongan sudah dibersihkan. Silakan potong ulang videonya.",
            variant: "destructive",
          })
          return
        }
      } catch {
        // jaringan sedang gangguan — coba lagi dengan backoff
      }
      if (cancelled) return
      if (ok) {
        failCount = 0
        delay = 800
      } else {
        failCount += 1
        // batas keras: setelah 20 gagal beruntun (~2 menit), lepaskan status
        // "processing" agar pengguna tidak terkunci tanpa batas waktu.
        if (failCount > 20) {
          setActiveJobId(null)
          setJob(null)
          setPhase("ready")
          toast({
            title: "Koneksi terputus terlalu lama",
            description: "Pemantauan pekerjaan dihentikan. Silakan potong ulang videonya.",
            variant: "destructive",
          })
          return
        }
        delay = Math.min(5000, 800 * 2 ** Math.min(4, failCount - 1))
      }
      timer = setTimeout(poll, delay)
    }

    timer = setTimeout(poll, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeJobId, toast])

  // ---------- beforeunload: cegah tutup/refresh saat upload/proses ----------
  React.useEffect(() => {
    if (!busy) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Chrome butuh returnValue diset; modern browsers cukup preventDefault
      e.returnValue = ""
      return ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [busy])

  // ---------- catat hasil ke Riwayat (sekali per job) ----------

  React.useEffect(() => {
    if (job?.status === "done" && recordedJobRef.current !== job.id) {
      recordedJobRef.current = job.id
      const firstSeg = job.segments[0]
      const baseName = (meta?.name ?? "Video").replace(/\.[^.]+$/, "")
      useHistory.getState().add({
        tool: "potong",
        kind: job.audioOnly ? "audio" : "video",
        title: `${meta?.name ?? "Video"} · ${job.totalSegments} bagian`,
        sub: `mode ${job.mode} · ${job.segmentDuration}s`,
        url: `/api/split/job/${job.id}/zip`,
        thumbUrl: job.audioOnly ? undefined : job.segments[0]?.url,
        size: job.segments.reduce((a, s) => a + s.size, 0) || undefined,
        duration: job.totalDuration || undefined,
        // Kirim-ke tool lain butuh file video MENTAH — url utama adalah zip
        // bundel yang tak terbaca sebagai video. Pakai segmen pertama.
        payload: firstSeg
          ? {
              videoUrl: firstSeg.downloadUrl,
              videoName: `${baseName}-${String(firstSeg.index + 1).padStart(2, "0")}.${
                job.audioOnly ? "mp3" : "mp4"
              }`,
            }
          : undefined,
      })
    }
  }, [job, meta?.name])

  // Scroll halus ke hasil saat selesai
  React.useEffect(() => {
    if (job?.status === "done") {
      window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 300)
    }
  }, [job?.status])

  // ---------- unggah + potong ----------

  // Upload tahan-gangguan: idempoten (X-Upload-Id) + auto-retry + diagnostik
  const uploadFile = (f: File): Promise<UploadedVideo> =>
    uploadVideoRaw<UploadedVideo>({
      endpoint: "/api/split/upload",
      file: f,
      pick: (d) => (d as { ok?: boolean; video?: UploadedVideo }).video as UploadedVideo,
      onProgress: (pct, loaded) => {
        setUploadPct(pct)
        setUploadedBytes(loaded)
      },
      onXhr: (x) => {
        xhrRef.current = x
      },
    })

  const cancelUpload = () => xhrRef.current?.abort()

  const handleCut = async () => {
    if ((!file && !videoId) || busy) return
    try {
      let vid = videoId
      if (!vid) {
        if (!file) return
        setPhase("uploading")
        setUploadPct(0)
        setUploadedBytes(0)
        const uploaded = await uploadFile(file)
        vid = uploaded.id
        setMeta({
          id: uploaded.id,
          name: uploaded.originalName,
          size: uploaded.size,
          duration: uploaded.duration,
          width: uploaded.width,
          height: uploaded.height,
          hasAudio: uploaded.hasAudio,
        })
        try {
          window.localStorage.setItem(LS_VIDEO, uploaded.id)
        } catch {}
      }

      setPhase("processing")
      setJob(null)
      setHiddenSegs(new Set())
      const res = await fetch("/api/split/split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: vid,
          segmentDuration: segDur,
          mode,
          ...(useRange && rangeValid ? { rangeStart, rangeEnd: Math.round(rangeEnd * 10) / 10 } : {}),
          audioOnly,
        }),
      })
      const data = await res.json().catch(() => ({ ok: false, error: "Respons server tidak valid." }))
      if (!res.ok || !data.ok) throw new Error(data.error || "Gagal memotong video.")
      setActiveJobId(data.job.id as string)
      setJob(data.job as Job)
      // simpan segera agar refresh di tengah proses tetap bisa dipulihkan
      try {
        window.localStorage.setItem(LS_JOB, data.job.id)
      } catch {}
    } catch (err) {
      setPhase(file || videoId ? "ready" : "idle")
      if (err instanceof UploadCanceled) {
        toast({ title: "Upload dibatalkan" })
      } else {
        toast({
          title: "Terjadi kesalahan",
          description: err instanceof Error ? err.message : "Silakan coba lagi.",
          variant: "destructive",
        })
      }
    } finally {
      xhrRef.current = null
    }
  }

  const handleCancel = async () => {
    if (!activeJobId) return
    try {
      const res = await fetch(`/api/split/job/${activeJobId}/cancel`, { method: "POST" })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        const j: Job = data.job
        setJob(j)
        if (j.status === "cancelled") {
          // hentikan poller agar tidak memunculkan toast "dibatalkan" kedua
          setActiveJobId(null)
          try {
            window.localStorage.removeItem(LS_JOB)
          } catch {}
          setPhase("ready")
          toast({
            title: "Pemotongan dibatalkan",
            description: "Kamu bisa memotong ulang kapan saja.",
          })
        }
      }
    } catch {
      toast({
        title: "Gagal membatalkan",
        description: "Coba beberapa saat lagi.",
        variant: "destructive",
      })
    }
  }

  // ---------- turunan tampilan ----------

  const allHistoryItems = useHistory((s) => s.items)
  const historyItems = React.useMemo(
    () => allHistoryItems.filter((i) => i.tool === "potong"),
    [allHistoryItems]
  )

  const visibleSegments = React.useMemo(
    () => (job ? job.segments.filter((s) => !hiddenSegs.has(s.index)) : []),
    [job, hiddenSegs]
  )

  const hideSegment = (index: number) =>
    setHiddenSegs((prev) => {
      const next = new Set(prev)
      next.add(index)
      return next
    })

  const segFileName = (s: Segment) => {
    const base = (meta?.name ?? file?.name ?? "video").replace(/\.[^.]+$/, "")
    return `${base}-${String(s.index + 1).padStart(2, "0")}.${job?.audioOnly ? "mp3" : "mp4"}`
  }

  const fileChipSub = [
    duration > 0 ? fmtTime(duration) : null,
    meta?.width && meta?.height ? `${meta.width}×${meta.height}` : null,
    fmtBytes(meta?.size ?? file?.size ?? 0),
  ]
    .filter(Boolean)
    .join(" · ")

  let estimateLine: string
  if (!file && !videoUrl) {
    estimateLine = "Pilih video dulu untuk melihat estimasi jumlah potongan."
  } else if (useRange && !rangeValid) {
    estimateLine = "Rentang tidak valid — akhir harus lebih besar dari awal dan tidak melebihi durasi video."
  } else if (duration > 0) {
    const windowText =
      useRange && rangeValid
        ? `Rentang ${fmtTime(rangeStart)}–${fmtTime(rangeEnd)} (${fmtDur(cutWindow)})`
        : `Seluruh video ${fmtTime(duration)}`
    estimateLine = `${windowText} · ≈ ${estSegments} potongan × ${segDur} dtk${audioOnly ? " (MP3)" : ""}${
      estSegments > 1 && cutWindow % segDur > 0.01 ? " · potongan terakhir lebih pendek" : ""
    }`
  } else {
    estimateLine = "Durasi belum terbaca — rentang divalidasi setelah video diproses."
  }

  // Buka panel "Lanjutan" composer secara programatik — dipakai saat pill
  // "Rentang" diaktifkan agar kontrol rentang langsung terlihat.
  const openAdvancedPanel = () => {
    requestAnimationFrame(() => {
      const btn = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (b) => (b.textContent ?? "").includes("Lanjutan") && b.getAttribute("aria-expanded") === "false"
      )
      btn?.click()
    })
  }

  const toggleRange = () => {
    const next = !useRange
    setUseRange(next)
    if (next) {
      if (rangeEnd <= rangeStart) {
        setRangeEnd(duration > 0 ? Math.floor(duration) : 10)
      }
      openAdvancedPanel()
    }
  }

  const rangeInputCls =
    "h-9 w-full rounded-lg border border-border bg-card px-2.5 text-center font-mono text-[13px] tabular-nums text-foreground outline-none transition-colors duration-150 focus:border-primary/60"

  // boot: cek sesi tersimpan dulu agar tidak kedip
  if (!bootChecked) {
    return (
      <div className="flex min-h-[50vh] flex-1 flex-col items-center justify-center gap-3">
        <Loader2 className="h-7 w-7 animate-spin text-primary" aria-hidden="true" />
        <p className="text-[12.5px] text-muted-foreground">Memeriksa sesi terakhir…</p>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="flex flex-1 flex-col">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        aria-label="Pilih file video"
        onChange={(e) => {
          acceptFile(e.target.files?.[0])
          e.target.value = ""
        }}
      />

      {/* ---------- Tab atas ---------- */}
      <div className="flex items-center justify-between gap-3 pt-6">
        <SegTabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "kerja", label: "Hasil" },
            { key: "riwayat", label: "Riwayat", count: historyItems.length },
          ]}
        />
        {(file || videoUrl) && meta?.name ? (
          <span
            className="hidden min-w-0 max-w-[280px] truncate text-[11.5px] text-muted-foreground sm:block"
            title={meta.name}
          >
            {meta.name}
          </span>
        ) : null}
      </div>

      {tab === "riwayat" ? (
        /* ---------- Tab Riwayat ---------- */
        <div className="pt-5">
          {historyItems.length === 0 ? (
            <EmptyHint icon={HistoryIcon} text="Belum ada hasil Potong. Pekerjaan selesai otomatis tercatat di sini." />
          ) : (
            <ResultGrid>
              {historyItems.map((item) => (
                <ResultCard
                  key={item.id}
                  title={item.title}
                  sub={`${item.sub ?? ""}${item.sub ? " · " : ""}${timeAgo(item.at)}`}
                  previewUrl={item.kind === "audio" ? undefined : item.thumbUrl ?? item.url}
                  previewKind={item.kind === "audio" ? "audio" : "video"}
                  badge={item.kind === "audio" ? "MP3" : "MP4"}
                  duration={item.duration}
                  downloadUrl={item.url}
                  sendFrom="potong"
                  sendPayload={(t) => payloadFromHistory(item, t)}
                  onDelete={() => useHistory.getState().remove(item.id)}
                />
              ))}
            </ResultGrid>
          )}
        </div>
      ) : (
        /* ---------- Tab Hasil (area kerja) ---------- */
        <div className="flex flex-1 flex-col gap-5 pt-5">
          {/* Kartu video sumber */}
          {(file || videoUrl) && (
            <section
              aria-label="Video sumber"
              className="grid gap-4 rounded-2xl border border-border/70 bg-panel p-4 lg:grid-cols-[minmax(0,1fr)_250px]"
            >
              <div className="relative overflow-hidden rounded-xl border border-border/60 bg-black">
                {previewError ? (
                  <div className="flex aspect-video w-full flex-col items-center justify-center gap-2.5 bg-muted/40 px-4 text-center">
                    <Film className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
                    <div>
                      <p className="text-[13px] font-semibold text-foreground">
                        Pratinjau tidak tersedia di browser
                      </p>
                      <p className="mx-auto mt-1 max-w-xs text-[11.5px] leading-relaxed text-muted-foreground">
                        Beberapa format (MKV, AVI, WMV) tidak bisa diputar di browser — video tetap bisa dipotong normal.
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    <video
                      ref={previewVideoRef}
                      src={videoUrl}
                      controls
                      preload="metadata"
                      onError={() => setPreviewError(true)}
                      className="aspect-video w-full"
                    />
                    {/* penanda posisi potongan di timeline */}
                    {duration > 0 && segDur > 0 && estSegments > 0 && (
                      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                        {/* sorotan rentang terpilih */}
                        {useRange && rangeValid && rangeEnd > rangeStart && (
                          <div
                            className="absolute inset-y-0 border-x-2 border-primary/70 bg-primary/15"
                            style={{
                              left: `${(rangeStart / duration) * 100}%`,
                              width: `${((rangeEnd - rangeStart) / duration) * 100}%`,
                            }}
                          />
                        )}
                        {/* garis batas antar potongan */}
                        {Array.from({ length: Math.max(0, estSegments - 1) }).map((_, i) => {
                          const t = (useRange && rangeValid ? rangeStart : 0) + (i + 1) * segDur
                          if (t >= duration) return null
                          return (
                            <div
                              key={i}
                              className="absolute inset-y-0 w-0.5 bg-foreground/60"
                              style={{ left: `${(t / duration) * 100}%` }}
                            />
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="flex min-w-0 flex-col gap-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-semibold text-foreground" title={meta?.name ?? file?.name}>
                    {meta?.name ?? file?.name}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <Chip>{fmtBytes(meta?.size ?? file?.size ?? 0)}</Chip>
                    {duration > 0 && <Chip className="font-mono">{fmtTime(duration)}</Chip>}
                    {meta?.width && meta?.height ? <Chip>{meta.width}×{meta.height}</Chip> : null}
                  </div>
                </div>

                {duration > 0 ? (
                  <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                    ≈ <span className="font-semibold text-primary">{estSegments} potongan</span> × {segDur} dtk
                    {audioOnly ? " · MP3" : ""}
                  </p>
                ) : (meta || file) && previewError ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                    Durasi tidak terbaca browser — jumlah potongan dihitung setelah diproses.
                  </p>
                ) : null}

                <p
                  className="text-[11px] text-muted-foreground/70"
                  title={
                    videoId
                      ? "Video sudah tersimpan di server — potong ulang tanpa unggah ulang"
                      : "Video terunggah otomatis saat pemotongan dimulai"
                  }
                >
                  {videoId ? "Sudah di server — potong ulang tanpa unggah lagi" : "Terunggah otomatis saat mulai memotong"}
                </p>

                <div className="mt-auto flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={openPicker}
                    disabled={busy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    Ganti Video
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Sedang mengunggah */}
          {phase === "uploading" && (
            <section aria-label="Unggah berjalan" className="rounded-2xl border border-border/70 bg-panel p-4">
              <RunProgress
                value={uploadPct}
                label={
                  <span className="min-w-0">
                    Mengunggah <span className="font-medium text-foreground">{file?.name}</span>{" "}
                    <span className="font-mono text-[11px] tabular-nums">
                      {fmtBytes(uploadedBytes)}/{fmtBytes(meta?.size ?? file?.size ?? 0)}
                    </span>
                  </span>
                }
                onCancel={cancelUpload}
                cancelLabel="Batal"
              />
            </section>
          )}

          {/* Sedang memotong */}
          {phase === "processing" && (
            <section aria-label="Pemotongan berjalan" className="rounded-2xl border border-border/70 bg-panel p-4">
              <RunProgress
                value={job && job.status !== "queued" ? job.progress : null}
                label={
                  job
                    ? job.status === "queued"
                      ? "Menunggu antrean — server memproses pekerjaan lain"
                      : job.mode === "precise"
                        ? `Memotong — ${job.completedSegments}/${job.totalSegments} segmen selesai`
                        : "Memotong video…"
                    : "Menyiapkan pemotongan…"
                }
                onCancel={activeJobId ? () => void handleCancel() : undefined}
                cancelLabel="Batalkan"
              />
              {job && (
                <p className="mt-2 text-[11.5px] text-muted-foreground">
                  Mode {job.mode === "fast" ? "Cepat" : "Precise"} · target {job.totalSegments} potongan ×{" "}
                  {job.segmentDuration} dtk
                </p>
              )}
            </section>
          )}

          {/* Error */}
          {job?.status === "error" && (
            <section className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 p-4">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-destructive">Pemotongan gagal</p>
                <p className="mt-0.5 break-words text-[12.5px] leading-relaxed text-muted-foreground">
                  {job.error ?? "Terjadi kesalahan saat memproses video."}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCut()}
                    disabled={!file && !videoId}
                    className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
                  >
                    Coba lagi
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Hasil */}
          {phase === "done" && job?.status === "done" && job.segments.length > 0 && (
            <div ref={resultRef} className="scroll-mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-border/70 bg-panel p-4">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-foreground">{job.segments.length} bagian dibuat</p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                    Mode {job.mode === "fast" ? "Cepat" : "Precise"}
                    {job.audioOnly ? " · hasil MP3" : ""}
                    {job.rangeEnd != null ? ` · rentang ${fmtTime(job.rangeStart)}–${fmtTime(job.rangeEnd)}` : ""} · total{" "}
                    {fmtBytes(job.segments.reduce((a, s) => a + s.size, 0))} · file tersimpan sementara di server (3 jam)
                  </p>
                </div>
                <a
                  href={`/api/split/job/${job.id}/zip`}
                  download
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3.5 text-[12.5px] font-medium text-foreground transition-colors duration-150 hover:border-primary/50 hover:text-primary"
                >
                  <Package className="h-4 w-4" aria-hidden="true" />
                  Unduh Semua (ZIP)
                </a>
              </div>

              <ResultGrid>
                {visibleSegments.map((s) => (
                  <ResultCard
                    key={s.index}
                    title={`#${String(s.index + 1).padStart(2, "0")}`}
                    sub={`${fmtTime(s.startTime)}–${fmtTime(s.startTime + s.duration)} · ${fmtDur(s.duration)} · ${fmtBytes(s.size)}`}
                    previewUrl={job.audioOnly ? undefined : s.url}
                    previewKind={job.audioOnly ? "audio" : "video"}
                    badge={job.audioOnly ? "MP3" : "MP4"}
                    duration={s.duration}
                    downloadUrl={s.downloadUrl}
                    downloadName={segFileName(s)}
                    onOpen={() => setPreviewSeg(s)}
                    sendFrom="potong"
                    sendPayload={() => ({ kind: "video-url", url: s.downloadUrl, name: segFileName(s) })}
                    onDelete={() => hideSegment(s.index)}
                  />
                ))}
              </ResultGrid>
            </div>
          )}

          {/* Hasil lama saat memotong ulang: tampilkan status saja */}
          {phase === "done" && job?.status === "done" && job.segments.length === 0 && (
            <p className="rounded-2xl border border-border/70 bg-panel p-4 text-[13px] text-muted-foreground">
              Tidak ada segmen yang dihasilkan.
            </p>
          )}

          {/* Kosong — panduan singkat */}
          {!file && !videoUrl && phase === "idle" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center sm:py-16">
              <Scissors className="h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
              <p className="max-w-xs text-[13px] leading-relaxed text-muted-foreground">
                Seret video ke panel bawah — atur durasi potong, lalu{" "}
                <span className="font-medium text-foreground">Potong Video</span>.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Dialog pemutar segmen */}
      <Dialog open={previewSeg !== null} onOpenChange={(open) => !open && setPreviewSeg(null)}>
        <DialogContent className="max-w-3xl sm:rounded-2xl">
          <DialogHeader>
            <DialogTitle>Bagian #{previewSeg ? previewSeg.index + 1 : ""}</DialogTitle>
            <DialogDescription>
              {previewSeg
                ? `${fmtTime(previewSeg.startTime)} – ${fmtTime(previewSeg.startTime + previewSeg.duration)} · ${fmtDur(previewSeg.duration)} · ${fmtBytes(previewSeg.size)}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {previewSeg && job?.audioOnly ? (
            <audio src={previewSeg.url} controls autoPlay className="w-full" />
          ) : previewSeg ? (
            <video src={previewSeg.url} controls autoPlay className="aspect-video w-full rounded-xl bg-black" />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ---------- Composer melayang ---------- */}
      <Composer
        pills={
          <>
            <PillGroup label="Durasi">
              {PRESETS.map((p) => (
                <Pill key={p} active={segDur === p} onClick={() => setSegDur(p)} disabled={busy}>
                  {p}s
                </Pill>
              ))}
              <PillPopover
                label={PRESETS.includes(segDur) ? "Khusus" : `${segDur}s`}
                title="Durasi khusus per potongan"
                contentClassName="w-64"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Kurangi 1 detik"
                    disabled={busy || segDur <= 1}
                    onClick={() => setSegDur((d) => Math.max(1, d - 1))}
                    className="h-8 w-8 rounded-lg border border-border text-[15px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={segDur}
                    disabled={busy}
                    aria-label="Durasi per potongan (detik)"
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v) && v >= 1 && v <= 600) setSegDur(Math.round(v))
                      else if (e.target.value === "") setSegDur(1)
                    }}
                    className="h-8 w-20 rounded-lg border border-border bg-card text-center font-mono text-[13px] tabular-nums text-foreground outline-none transition-colors duration-150 focus:border-primary/60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <button
                    type="button"
                    aria-label="Tambah 1 detik"
                    disabled={busy || segDur >= 600}
                    onClick={() => setSegDur((d) => Math.min(600, d + 1))}
                    className="h-8 w-8 rounded-lg border border-border text-[15px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  >
                    +
                  </button>
                  <span className="text-[11px] text-muted-foreground">dtk · 1–600</span>
                </div>
              </PillPopover>
            </PillGroup>
            <PillGroup label="Mode">
              <Pill
                active={mode === "fast"}
                onClick={() => setMode("fast")}
                disabled={busy}
                title="Tanpa re-encode, presisi keyframe"
              >
                Cepat
              </Pill>
              <Pill
                active={mode === "precise"}
                onClick={() => setMode("precise")}
                disabled={busy}
                title="Re-encode, presisi frame"
              >
                Precise
              </Pill>
            </PillGroup>
            <Pill
              active={audioOnly}
              onClick={() => setAudioOnly(!audioOnly)}
              disabled={busy || noAudio}
              title={noAudio ? "Video ini tidak memiliki trek audio" : "Setiap potongan berupa file MP3"}
            >
              MP3
            </Pill>
            <Pill
              active={useRange}
              onClick={toggleRange}
              disabled={busy}
              title="Potong hanya bagian tertentu dari video"
            >
              Rentang
            </Pill>
          </>
        }
        advanced={
          <div className="space-y-2.5">
            {/* Rentang angka */}
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">Mulai (detik)</span>
                <input
                  type="number"
                  min={0}
                  max={Math.max(1, Math.floor(duration))}
                  value={rangeStart}
                  disabled={busy}
                  onChange={(e) => setRangeStart(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  className={rangeInputCls}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">Akhir (detik)</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, Math.ceil(duration))}
                  value={rangeEnd}
                  disabled={busy}
                  onChange={(e) => setRangeEnd(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
                  className={rangeInputCls}
                />
              </label>
            </div>

            {/* Slider rentang: dua handle di atas timeline mini */}
            {duration > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-muted-foreground/70">
                  <span>0:00</span>
                  <span>{fmtTime(duration)}</span>
                </div>
                <div className="relative h-8 select-none">
                  {/* track */}
                  <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
                  {/* range terpilih — di-clamp 0–100% agar tidak meluber
                      saat rentang belum valid (rangeEnd > durasi) */}
                  <div
                    className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary"
                    style={{
                      left: `${Math.max(0, Math.min(100, (rangeStart / duration) * 100))}%`,
                      width: `${Math.max(
                        0,
                        Math.min(
                          100 - Math.max(0, Math.min(100, (rangeStart / duration) * 100)),
                          (Math.max(0, rangeEnd - rangeStart) / duration) * 100,
                        ),
                      )}%`,
                    }}
                  />
                  {/* handle mulai */}
                  <input
                    type="range"
                    min={0}
                    max={Math.floor(duration)}
                    step={1}
                    value={Math.min(rangeStart, Math.floor(duration) - 1)}
                    disabled={busy}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setRangeStart(Math.min(v, rangeEnd - 1))
                    }}
                    aria-label="Atur detik awal rentang"
                    className="pv-range-thumb absolute inset-0 w-full appearance-none bg-transparent"
                  />
                  {/* handle akhir */}
                  <input
                    type="range"
                    min={1}
                    max={Math.ceil(duration)}
                    step={1}
                    value={Math.max(rangeEnd, rangeStart + 1)}
                    disabled={busy}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setRangeEnd(Math.max(v, rangeStart + 1))
                    }}
                    aria-label="Atur detik akhir rentang"
                    className="pv-range-thumb absolute inset-0 w-full appearance-none bg-transparent"
                  />
                </div>
              </div>
            )}

            {/* Tombol ambil posisi playback dari pratinjau */}
            {!previewError && duration > 0 && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const v = previewVideoRef.current
                    if (!v) return
                    const t = Math.floor(v.currentTime)
                    if (t < duration) {
                      setRangeStart(Math.max(0, Math.min(t, rangeEnd - 1)))
                      toast({
                        title: "Awal rentang diatur",
                        description: `Posisi playback saat ini: ${fmtTime(t)}.`,
                      })
                    }
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Target className="h-3.5 w-3.5" aria-hidden="true" />
                  Set Mulai ke Posisi Video
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const v = previewVideoRef.current
                    if (!v) return
                    const t = Math.floor(v.currentTime)
                    if (t > rangeStart) {
                      setRangeEnd(Math.min(t, Math.ceil(duration)))
                      toast({
                        title: "Akhir rentang diatur",
                        description: `Posisi playback saat ini: ${fmtTime(t)}.`,
                      })
                    }
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Target className="h-3.5 w-3.5" aria-hidden="true" />
                  Set Akhir ke Posisi Video
                </button>
              </div>
            )}

            {/* Validitas + estimasi */}
            <p className={cn("text-[11.5px] leading-relaxed", rangeValid ? "text-muted-foreground" : "text-amber-500")}>
              {estimateLine}
            </p>
          </div>
        }
        actions={
          busy ? (
            <button
              type="button"
              onClick={() => (phase === "uploading" ? cancelUpload() : void handleCancel())}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-destructive/40 px-3 text-[12.5px] font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10"
            >
              <Ban className="h-3.5 w-3.5" aria-hidden="true" /> Batalkan
            </button>
          ) : (
            <div className="flex items-center gap-2">
              {(file || videoUrl) && (
                <ResetConfirm
                  onConfirm={resetAll}
                  label="Reset"
                  title="Reset alat potong?"
                  description="Video terpilih & hasil akan dibersihkan dari sesi ini."
                />
              )}
              <button
                type="button"
                onClick={() => void handleCut()}
                disabled={(!file && !videoId) || (useRange && !rangeValid)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-all duration-150 hover:opacity-90 disabled:opacity-40"
              >
                <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
                {job && phase === "done" ? "Potong Ulang dengan Setelan Ini" : "Potong Video"}
              </button>
            </div>
          )
        }
      >
        {!file && !videoUrl ? (
          <DropZone
            onFiles={(files) => acceptFile(files[0] ?? null)}
            accept={ACCEPT}
            disabled={busy}
            hint={`MP4/MOV/MKV… maks ${fmtBytes(MAX_SIZE)}`}
            label="Pilih video"
          />
        ) : (
          <div className="flex items-center gap-2">
            <FileChip
              className="min-w-0 flex-1"
              name={meta?.name ?? file?.name ?? "video"}
              sub={fileChipSub}
              disabled={busy}
            />
            <button
              type="button"
              onClick={openPicker}
              disabled={busy}
              className="inline-flex h-10 shrink-0 items-center rounded-xl border border-border px-3 text-[12.5px] font-medium text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              Ganti
            </button>
          </div>
        )}
      </Composer>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Kecil-kecil                                                         */
/* ------------------------------------------------------------------ */

function EmptyHint({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/40" />
      <p className="max-w-xs text-[13px] leading-relaxed text-muted-foreground">{text}</p>
    </div>
  )
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium tabular-nums text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  )
}
