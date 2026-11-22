"use client"

// ============================================================
// Optimasi Kualitas — tool optimasi unggahan yang JUJUR & TERUKUR
// ============================================================
// Alur: Input (dropzone/Pustaka) → Preflight (metrik + peringatan) →
// Proses (Probe → Encode → Verifikasi, progres SSE, Batal) → Hasil
// (pratinjau, sebelum/sesudah, skor SSIM/PSNR, unduh, laporan PDF/JSON,
// A/B, Kirim ke…). Tanpa klaim "pasti HD" — semua angka terukur.
// ============================================================

import * as React from "react"
import {
  BadgeCheck,
  Ban,
  Check,
  CircleAlert,
  Download,
  FileSearch,
  FileVideo,
  FlaskConical,
  Gauge,
  Info,
  Layers,
  Loader2,
  Lock,
  Music2,
  RotateCcw,
  Scale,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Composer } from "@/components/studio/composer"
import { DropZone, FileChip } from "@/components/studio/drop-input"
import { Pill, PillGroup, PillPopover } from "@/components/studio/option-pills"
import { ResetConfirm } from "@/components/studio/reset-confirm"
import { RunProgress } from "@/components/studio/run-progress"
import { SegTabs } from "@/components/studio/seg-tabs"
import { SendToMenu } from "@/components/studio/send-to-menu"
import { IconAction } from "@/components/studio/result-card"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/use-toast"
import * as api from "@/lib/optimasi/api"
import type { JobDetail, JobOptions, JobState, SSEEvent } from "@/lib/optimasi/api"
import { fetchAsFile, useHandoff } from "@/lib/studio/handoff"
import { fmtBytes, fmtDur, uid } from "@/lib/studio/format"
import { useHistory } from "@/lib/studio/history"
import { cn } from "@/lib/utils"

const ACCEPT = ".mp4,.mov,.m4v,.mkv,.webm,.avi,.3gp,.ts,.mpg,.mpeg,.wmv,.flv,.mts,video/*"

type TabKey = "hasil" | "ab" | "info"
type Phase = "idle" | "ready" | "working" | "done"

const STAGES: { key: string; label: string }[] = [
  { key: "probe", label: "Probe" },
  { key: "preflight", label: "Preflight" },
  { key: "plan", label: "Rencana" },
  { key: "encode", label: "Encode" },
  { key: "verify", label: "Verifikasi" },
  { key: "report", label: "Laporan" },
]

const PRESETS: { key: JobOptions["preset"]; title: string; desc: string }[] = [
  { key: "standar", title: "Standar TikTok", desc: "H.264 High · CRF 18 · 12 Mbps · 30 fps · loudness −14 LUFS" },
  { key: "cepat", title: "Cepat", desc: "x264 veryfast · hasil cepat untuk uji kilat" },
  { key: "hemat", title: "Hemat ukuran", desc: "CRF 22 · 6 Mbps — file kecil, kualitas lebih rendah" },
  { key: "kustom", title: "Kustom", desc: "Atur sendiri di panel Lanjutan" },
]

const HOW_IT_WORKS = [
  { icon: FileSearch, title: "Probe", detail: "ffprobe + hitung frame nyata + SHA-256; deteksi VFR, tag warna, tabel sampel palsu, C2PA/AIGC." },
  { icon: ShieldCheck, title: "Preflight", detail: "Peringatan berbahasa Indonesia — tidak ada yang memblokir; keputusan tetap di tanganmu." },
  { icon: Wand2, title: "Rencana", detail: "Preset dipilih → parameter encode konkret (bisa di-override di Lanjutan)." },
  { icon: Gauge, title: "Encode", detail: "FFmpeg x264: 1080×1920 Lanczos+pad, BT.709 benar (bukan cuma ganti tag), GOP 2 detik, loudnorm 2-pass." },
  { icon: BadgeCheck, title: "Verifikasi", detail: "Dekode penuh, fps nyata = klaim, faststart, sinkron A/V, SSIM/PSNR vs sumber." },
  { icon: Scale, title: "Uji A/B", detail: "A = sumber utuh (label asal-usul tetap ada), B = hasil optimasi. Ukur sendiri efeknya di platform." },
]

/* ---------------- kecil-kecil ---------------- */

function Chip({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "good" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium tabular-nums",
        tone === "good" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        tone === "warn" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  )
}

function fmtBitrate(bps?: number | null): string {
  if (!bps || bps <= 0) return "—"
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`
  return `${Math.round(bps / 1000)} kbps`
}

/* ---------------- model batch ---------------- */

interface BatchItem {
  key: string
  file: File | null
  jobId: string | null
  uploadPct: number
  job: JobDetail | null
  progress: { stage: string; percent: number; eta: number; message: string } | null
  logs: string[]
  error: string | null
  ab: { a: { name: string; url: string } | null; b: { name: string; url: string } } | null
}

function newBatchItem(file: File): BatchItem {
  return { key: uid(), file, jobId: null, uploadPct: 0, job: null, progress: null, logs: [], error: null, ab: null }
}

/* ---------------- komponen utama ---------------- */

export function OptimasiTool() {
  const { toast } = useToast()
  const historyAdd = useHistory((s) => s.add)

  const [tab, setTab] = React.useState<TabKey>("hasil")
  const [phase, setPhase] = React.useState<Phase>("idle")
  const [items, setItems] = React.useState<BatchItem[]>([])
  const [opts, setOpts] = React.useState<JobOptions>(api.DEFAULT_OPTIONS)
  const [busyStart, setBusyStart] = React.useState(false)
  const [abSummary, setAbSummary] = React.useState<{ total: number; a: number; b: number; note: string } | null>(null)
  const [abNotes, setAbNotes] = React.useState<api.AbNote[]>([])
  const [abForm, setAbForm] = React.useState({ platform: "TikTok", version: "B", meta_shown: "", reach: "", note: "" })

  const sseRef = React.useRef<Map<string, () => void>>(new Map())
  const resultRef = React.useRef<HTMLDivElement>(null)

  const working = phase === "working"
  const doneCount = items.filter((i) => i.job?.state === "done").length

  /* ---------- siklus hidup ---------- */
  React.useEffect(() => {
    void api.getAbSummary().then(setAbSummary).catch(() => undefined)
    return () => {
      sseRef.current.forEach((close) => close())
      sseRef.current.clear()
    }
  }, [])

  // Scroll ke hasil saat ada yang selesai
  React.useEffect(() => {
    if (doneCount > 0) {
      const t = window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 250)
      return () => window.clearTimeout(t)
    }
  }, [doneCount])

  const patchItem = React.useCallback((key: string, patch: Partial<BatchItem> | ((it: BatchItem) => Partial<BatchItem>)) => {
    setItems((prev) =>
      prev.map((it) => (it.key === key ? { ...it, ...(typeof patch === "function" ? patch(it) : patch) } : it))
    )
  }, [])

  /* ---------- input file ---------- */
  const addFiles = React.useCallback((files: File[]) => {
    const vids = files.filter((f) => f.size > 0)
    if (vids.length === 0) return
    setItems((prev) => [...prev, ...vids.map(newBatchItem)])
    setPhase("ready")
  }, [])

  const removeItem = React.useCallback((key: string) => {
    setItems((prev) => {
      const it = prev.find((x) => x.key === key)
      if (it?.jobId) {
        api.cancelJob(it.jobId).catch(() => undefined)
        api.deleteJob(it.jobId).catch(() => undefined)
        const close = sseRef.current.get(it.jobId)
        close?.()
        sseRef.current.delete(it.jobId)
      }
      const next = prev.filter((x) => x.key !== key)
      if (next.length === 0) setPhase("idle")
      return next
    })
  }, [])

  const clearAll = React.useCallback(() => {
    sseRef.current.forEach((close) => close())
    sseRef.current.clear()
    setItems([])
    setPhase("idle")
  }, [])

  const resetAll = React.useCallback(() => {
    clearAll()
    void api
      .resetAll()
      .then(() => toast({ title: "Riwayat optimasi dibersihkan" }))
      .catch(() => undefined)
  }, [clearAll, toast])

  // Kirim-ke dari tool lain (handoff)
  React.useEffect(() => {
    let alive = true
    void (async () => {
      const p = useHandoff.getState().consume("optimasi")
      if (!p) return
      if (p.kind === "file") {
        if (alive) addFiles([p.file])
      } else if (p.kind === "video-url") {
        try {
          const f = await fetchAsFile(p.url, p.name)
          if (alive) addFiles([f])
        } catch {
          if (alive) toast({ title: "Gagal mengambil berkas", variant: "destructive" })
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [addFiles, toast])

  // dari Pustaka / Riwayat
  const historyItems = useHistory((s) => s.items)
  const libraryItems = React.useMemo(
    () =>
      historyItems.filter(
        (i): i is typeof i & { url: string } =>
          i.kind === "video" && !!i.url && !i.url.includes("/zip")
      ).slice(0, 12),
    [historyItems]
  )
  const pickFromLibrary = React.useCallback(
    async (item: { url: string; title: string; payload?: { videoUrl?: string; videoName?: string } }) => {
      const url = item.payload?.videoUrl ?? item.url
      try {
        const f = await fetchAsFile(url, item.payload?.videoName ?? `${item.title}.mp4`)
        addFiles([f])
        toast({ title: "Dari Pustaka ditambahkan", description: f.name })
      } catch {
        toast({ title: "File tidak tersedia", description: "Sumber sudah kedaluwarsa di server.", variant: "destructive" })
      }
    },
    [addFiles, toast]
  )

  /* ---------- proses ---------- */
  const handleSSE = React.useCallback(
    (key: string, jobId: string, ev: SSEEvent) => {
      if (ev.type === "progress" || ev.type === "stage") {
        patchItem(key, {
          progress: {
            stage: ev.stage ?? "",
            percent: ev.percent ?? 0,
            eta: ev.eta_seconds ?? -1,
            message: ev.message ?? "",
          },
        })
      } else if (ev.type === "log") {
        patchItem(key, (it) => ({ logs: [...it.logs.slice(-8), ev.message ?? ""] }))
      } else if (ev.type === "preflight") {
        // akan tergantikan oleh refetch detail saat done — cukup log
        patchItem(key, (it) => ({ logs: [...it.logs.slice(-8), "Preflight: siap"] }))
      } else if (ev.type === "error") {
        patchItem(key, { error: ev.message ?? "Gagal memproses" })
      }
    },
    [patchItem]
  )

  const refreshJob = React.useCallback(
    async (key: string, jobId: string) => {
      try {
        const job = await api.getJob(jobId)
        patchItem(key, { job })
        if (job.state === "done") {
          historyAdd(api.historyFromReport(job))
          setPhase("done")
        } else if (job.state === "error") {
          patchItem(key, { error: job.error || "Gagal memproses" })
        }
      } catch {
        /* abaikan — diulang poll berikutnya */
      }
    },
    [historyAdd, patchItem]
  )

  const startProcess = React.useCallback(async () => {
    const pending = items.filter((i) => !i.jobId && i.file && !i.error)
    if (pending.length === 0 || busyStart) return
    setBusyStart(true)
    setPhase("working")
    try {
      for (const item of pending) {
        if (!item.file) continue
        patchItem(item.key, { uploadPct: 0, error: null })
        let jobId = ""
        try {
          const res = await api.createJob(item.file, opts, (pct) => patchItem(item.key, { uploadPct: pct }))
          jobId = res.job_id
        } catch (err) {
          patchItem(item.key, { error: err instanceof Error ? err.message : "Upload gagal" })
          continue
        }
        patchItem(item.key, { jobId, uploadPct: 100 })
        const close = api.subscribeEvents(jobId, {
          onEvent: (ev) => handleSSE(item.key, jobId, ev),
          onEnd: () => void refreshJob(item.key, jobId),
        })
        sseRef.current.set(jobId, close)
        void refreshJob(item.key, jobId)
      }
    } finally {
      setBusyStart(false)
    }
  }, [items, busyStart, opts, patchItem, handleSSE, refreshJob])

  const cancelAll = React.useCallback(() => {
    items.forEach((i) => {
      if (i.jobId) {
        api.cancelJob(i.jobId).catch(() => undefined)
        patchItem(i.key, { progress: null })
      }
    })
    toast({ title: "Membatalkan proses…", description: "File sumber tetap utuh." })
  }, [items, patchItem, toast])

  const retryItem = React.useCallback(
    (key: string) => {
      patchItem(key, (it) => ({ error: null, job: null, jobId: null, progress: null, logs: [], ab: null }))
      setPhase("ready")
    },
    [patchItem]
  )

  const makeAB = React.useCallback(
    async (item: BatchItem) => {
      if (!item.jobId) return
      try {
        const ab = await api.makeAB(item.jobId)
        patchItem(item.key, { ab })
        toast({
          title: "2 versi siap diunduh",
          description: "A = sumber utuh · B = hasil optimasi. Efek kompresi platform belum terjamin — ukur sendiri.",
        })
        void api.getAbSummary().then(setAbSummary).catch(() => undefined)
      } catch (err) {
        toast({ title: "Gagal membuat versi A/B", description: err instanceof Error ? err.message : "Coba lagi.", variant: "destructive" })
      }
    },
    [patchItem, toast]
  )

  const submitAbNote = React.useCallback(async () => {
    const target = items.find((i) => i.job?.state === "done")?.jobId
    if (!target) {
      toast({ title: "Belum ada hasil", description: "Proses minimal satu file, lalu catat hasil ujinya." })
      return
    }
    try {
      await api.addAbNote(target, abForm)
      const notes = await api.listAbNotes(target)
      setAbNotes(notes)
      setAbForm((f) => ({ ...f, meta_shown: "", reach: "", note: "" }))
      void api.getAbSummary().then(setAbSummary).catch(() => undefined)
      toast({ title: "Catatan uji tersimpan" })
    } catch (err) {
      toast({ title: "Gagal menyimpan catatan", description: err instanceof Error ? err.message : "Coba lagi.", variant: "destructive" })
    }
  }, [items, abForm, toast])

  /* ---------------- render ---------------- */
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 pt-6">
        <SegTabs<TabKey>
          groupId="optimasi"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "hasil", label: "Hasil", count: items.length || undefined },
            { key: "ab", label: "Uji A/B" },
            { key: "info", label: "Cara kerja" },
          ]}
        />
        <span className="hidden shrink-0 text-[11.5px] tabular-nums text-muted-foreground sm:block">
          {working
            ? `${items.filter((i) => i.progress || i.uploadPct > 0 && !i.job).length} proses berjalan`
            : doneCount > 0
              ? `${doneCount} hasil siap`
              : opts.preset === "kustom"
                ? "Preset kustom"
                : PRESETS.find((p) => p.key === opts.preset)?.title ?? ""}
        </span>
      </div>

      {tab === "info" ? (
        <InfoTab />
      ) : tab === "ab" ? (
        <AbTab
          summary={abSummary}
          notes={abNotes}
          form={abForm}
          setForm={setAbForm}
          onSubmit={submitAbNote}
          hasDone={doneCount > 0}
        />
      ) : (
        <div className="flex flex-1 flex-col gap-4 pt-5">
          {/* daftar batch */}
          {items.map((it) => (
            <BatchCard
              key={it.key}
              item={it}
              onRemove={() => removeItem(it.key)}
              onRetry={() => retryItem(it.key)}
              onMakeAB={() => void makeAB(it)}
            />
          ))}

          {items.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border/60 py-10 text-center">
              <Sparkles className="h-7 w-7 text-muted-foreground/40" />
              <p className="text-[13.5px] font-medium text-foreground">Perbaiki kualitas video untuk diunggah</p>
              <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
                1080×1920 · H.264 High · warna BT.709 · audio rapi −14 LUFS · struktur file bersih.
                Semua hasil diukur dan diverifikasi — tanpa klaim &ldquo;pasti tidak dikompres&rdquo;.
              </p>
            </div>
          )}

          <div ref={resultRef} />

          {/* composer */}
          <Composer
            pills={
              <PillGroup label="Preset">
                {PRESETS.map((p) => (
                  <Pill
                    key={p.key}
                    active={opts.preset === p.key}
                    onClick={() =>
                      setOpts((o) => ({
                        ...api.presetValues(p.key, o),
                        preset: p.key,
                      }))
                    }
                    title={p.desc}
                  >
                    {p.title}
                  </Pill>
                ))}
              </PillGroup>
            }
            advanced={<AdvancedPanel opts={opts} setOpts={setOpts} />}
            actions={
              <>
                {items.length > 0 && (
                  <ResetConfirm
                    label="Reset"
                    title="Bersihkan sesi ini?"
                    description="Daftar file dihapus; hasil yang sudah selesai tetap ada di Riwayat."
                    onConfirm={clearAll}
                  />
                )}
                {working ? (
                  <button
                    type="button"
                    onClick={cancelAll}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-destructive/15 px-3 text-[12.5px] font-semibold text-destructive transition-colors hover:bg-destructive/25"
                  >
                    <Ban className="h-3.5 w-3.5" />
                    Batal
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startProcess()}
                    disabled={items.length === 0 || busyStart || items.every((i) => i.jobId || i.error)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-4 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {busyStart ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                    Proses
                  </button>
                )}
              </>
            }
          >
            {working ? (
              <div className="space-y-1.5">
                {items.map((i) => (
                  <FileChip
                    key={i.key}
                    name={i.job?.original_name ?? i.file?.name ?? "video"}
                    sub={
                      i.progress
                        ? i.progress.message || i.progress.stage
                        : i.jobId
                          ? "menunggu antrean…"
                          : i.file
                            ? fmtBytes(i.file.size)
                            : undefined
                    }
                    disabled
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                <DropZone
                  accept={ACCEPT}
                  multiple
                  disabled={working}
                  label="Seret video ke sini"
                  hint="MP4 · MOV · MKV · WebM · maks 500 MB — bisa lebih dari satu"
                  size="sm"
                  onFiles={addFiles}
                />
                {items
                  .filter((i) => !i.jobId && i.file)
                  .map((i) => (
                    <FileChip
                      key={i.key}
                      name={i.file?.name ?? "video"}
                      sub={i.file ? fmtBytes(i.file.size) : undefined}
                      onRemove={() => removeItem(i.key)}
                      disabled={working}
                    />
                  ))}
              </div>
            )}
          </Composer>
        </div>
      )}

      {/* Pustaka picker dipasang di composer area — popover terpisah */}
      {tab === "hasil" && libraryItems.length > 0 && (
        <LibraryHint items={libraryItems} onPick={pickFromLibrary} disabled={working} />
      )}
    </div>
  )
}

/* ---------------- LibraryHint ---------------- */

function LibraryHint({
  items,
  onPick,
  disabled,
}: {
  items: { id: string; url: string; title: string; sub?: string; payload?: { videoUrl?: string; videoName?: string } }[]
  onPick: (item: { url: string; title: string; payload?: { videoUrl?: string; videoName?: string } }) => void
  disabled?: boolean
}) {
  return (
    <div className="pb-2 pt-1">
      <PillPopover label="Dari Pustaka" icon={Layers} title="Pakai ulang video dari Riwayat/Pustaka tanpa upload ulang" contentClassName="w-80">
        <div className="nice-scrollbar max-h-64 space-y-1 overflow-y-auto">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(it)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent disabled:opacity-50"
            >
              <FileVideo className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-foreground">{it.title}</span>
                {it.sub && <span className="block truncate text-[11px] text-muted-foreground">{it.sub}</span>}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-2 border-t border-border/60 pt-2 text-[10.5px] leading-relaxed text-muted-foreground">
          File diambil dari server lalu diunggah ke pipeline optimasi.
        </p>
      </PillPopover>
    </div>
  )
}

/* ---------------- BatchCard ---------------- */

function BatchCard({
  item,
  onRemove,
  onRetry,
  onMakeAB,
}: {
  item: BatchItem
  onRemove: () => void
  onRetry: () => void
  onMakeAB: () => void
}) {
  const job = item.job
  const state: JobState | "uploading" | "waiting" = job?.state ?? (item.jobId ? "queued" : item.uploadPct > 0 ? "uploading" : "waiting")
  const running = state === "running" || state === "queued" || state === "uploading"
  const stageIdx = Math.max(0, STAGES.findIndex((s) => s.key === (item.progress?.stage ?? "probe")))

  return (
    <section aria-label="File dalam sesi" className="rounded-2xl border border-border/70 bg-panel p-4">
      <div className="flex items-center gap-2">
        <FileChip
          name={job?.original_name ?? item.file?.name ?? "video"}
          sub={
            job?.probe
              ? `${job.probe.width}×${job.probe.height} · ${fmtBytes(job.probe.size_bytes)}`
              : item.file
                ? fmtBytes(item.file.size)
                : undefined
          }
        />
        <div className="flex shrink-0 items-center gap-0.5">
          {state === "done" && (
            <IconAction label="Proses ulang" icon={RotateCcw} onClick={onRetry} />
          )}
          <IconAction label="Hapus" icon={Trash2} onClick={onRemove} tone="danger" />
        </div>
      </div>

      {/* upload progres */}
      {state === "uploading" && (
        <div className="mt-3">
          <RunProgress value={item.uploadPct} label={`Mengunggah… ${item.uploadPct}%`} />
        </div>
      )}

      {/* progres per tahap */}
      {running && (
        <div className="mt-3 space-y-2.5">
          <div className="flex flex-wrap items-center gap-1">
            {STAGES.map((s, idx) => (
              <span
                key={s.key}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                  idx < stageIdx && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                  idx === stageIdx && "bg-primary/15 text-primary",
                  idx > stageIdx && "bg-muted text-muted-foreground/60",
                )}
              >
                {idx < stageIdx ? "✓ " : ""}
                {s.label}
              </span>
            ))}
          </div>
          <RunProgress
            value={item.progress ? Math.min(100, item.progress.percent) : null}
            label={
              item.progress?.message ||
              (state === "uploading" ? "Mengunggah…" : state === "queued" ? "Menunggu antrean…" : "Menyiapkan…")
            }
            onCancel={undefined}
          />
          {item.progress && item.progress.eta > 0 && (
            <p className="text-[11px] tabular-nums text-muted-foreground">
              estimasi selesai ± {Math.ceil(item.progress.eta)} detik
            </p>
          )}
          {item.logs.length > 0 && (
            <div className="nice-scrollbar max-h-20 overflow-y-auto rounded-lg bg-muted/50 px-2.5 py-1.5">
              {item.logs.slice(-4).map((l, i) => (
                <p key={i} className="truncate text-[10.5px] leading-relaxed text-muted-foreground">
                  {l}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* preflight */}
      {job && job.probe && job.probe.ok && (state === "done" || job.preflight.length > 0) && (
        <PreflightCard job={job} compact={state === "running"} />
      )}

      {/* error */}
      {(state === "error" || item.error) && (
        <Alert variant="destructive" className="mt-3">
          <CircleAlert className="h-4 w-4" />
          <AlertTitle className="text-[13px]">Gagal memproses</AlertTitle>
          <AlertDescription className="text-[12px]">
            {item.error || job?.error || "Coba lagi atau gunakan file lain."}
          </AlertDescription>
          <div className="mt-2">
            <Button size="sm" variant="outline" onClick={onRetry} className="h-7 gap-1.5 text-[12px]">
              <RotateCcw className="h-3 w-3" /> Proses ulang
            </Button>
          </div>
        </Alert>
      )}

      {/* hasil */}
      {state === "done" && job && <ResultSection job={job} ab={item.ab} onMakeAB={onMakeAB} onRetry={onRetry} />}

      {/* canceled */}
      {state === "canceled" && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5">
          <Ban className="h-4 w-4 text-muted-foreground" />
          <p className="flex-1 text-[12.5px] text-muted-foreground">Proses dibatalkan — file sumber tetap utuh.</p>
          <Button size="sm" variant="outline" onClick={onRetry} className="h-7 gap-1.5 text-[12px]">
            <RotateCcw className="h-3 w-3" /> Ulangi
          </Button>
        </div>
      )}
    </section>
  )
}

/* ---------------- PreflightCard ---------------- */

function PreflightCard({ job, compact }: { job: JobDetail; compact?: boolean }) {
  const p = job.probe!
  const items = job.preflight ?? []
  const warnings = items.filter((i) => i.level === "warn")
  const infos = items.filter((i) => i.level === "info")
  const prov = p.provenance

  return (
    <div className={cn("mt-3 rounded-xl border border-border/60 bg-card p-3", compact && "opacity-90")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>{p.width}×{p.height}</Chip>
        <Chip>{Math.round(p.fps_real * 100) / 100} fps nyata{p.fps_claimed && Math.abs(p.fps_claimed - p.fps_real) > 0.5 ? ` (klaim ${Math.round(p.fps_claimed)})` : ""}</Chip>
        <Chip>{p.real_frames.toLocaleString("id-ID")} frame</Chip>
        <Chip>{fmtBitrate(p.bit_rate_video_bps)}</Chip>
        <Chip>{fmtDur(p.duration_s)}</Chip>
        <Chip>{p.codec?.toUpperCase()} {p.profile}</Chip>
        <Chip>{p.bit_depth}-bit</Chip>
        {p.audio.present ? (
          <Chip>
            <Music2 className="mr-1 inline h-3 w-3" />
            {p.audio.sample_rate} Hz {p.audio.channels === 2 ? "stereo" : `${p.audio.channels}ch`}
            {p.audio.clipping ? " · clipping!" : ""}
          </Chip>
        ) : (
          <Chip>tanpa audio</Chip>
        )}
        {p.vfr && <Chip tone="warn">VFR</Chip>}
        {p.sample_table.inflated && <Chip tone="warn">tabel sampel {p.sample_table.ratio}×</Chip>}
        {(prov.c2pa || prov.aigc) && (
          <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 text-[10px] text-primary">
            <ShieldCheck className="h-3 w-3" />
            Label asal-usul dipertahankan
          </Badge>
        )}
      </div>

      {(warnings.length > 0 || infos.length > 0) && (
        <ul className="mt-2.5 space-y-1.5">
          {[...warnings, ...infos].slice(0, compact ? 3 : 8).map((w) => (
            <li key={w.code} className="flex items-start gap-2">
              {w.level === "warn" ? (
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              ) : (
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <p className="min-w-0 text-[12px] leading-relaxed">
                <span className="font-medium text-foreground">{w.title}</span>{" "}
                <span className="text-muted-foreground">— {w.detail}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ---------------- ResultSection ---------------- */

function ResultSection({
  job,
  ab,
  onMakeAB,
  onRetry,
}: {
  job: JobDetail
  ab: BatchItem["ab"]
  onMakeAB: () => void
  onRetry: () => void
}) {
  const v = job.verify
  const rep = job.report
  const jobId = job.id
  const srcUrl = api.downloadUrl(jobId, "input")
  const outUrl = api.downloadUrl(jobId, "output")
  const prov = rep?.provenance

  return (
    <div ref={undefined} className="mt-3 space-y-3">
      {/* pratinjau sebelum/sesudah */}
      <div className="grid grid-cols-2 gap-3">
        <figure className="space-y-1.5">
          <video
            src={`${srcUrl}#t=1`}
            controls
            preload="metadata"
            playsInline
            className="aspect-[9/16] w-full rounded-xl border border-border/60 bg-black/40 object-contain"
            aria-label="Video sumber"
          />
          <figcaption className="text-center text-[11px] text-muted-foreground">
            Sebelum — {rep?.before?.resolusi ?? "—"} · {String(rep?.before?.bitrate_video ?? "—")}
          </figcaption>
        </figure>
        <figure className="space-y-1.5">
          <video
            src={`${outUrl}#t=1`}
            controls
            preload="metadata"
            playsInline
            className="aspect-[9/16] w-full rounded-xl border border-primary/40 bg-black/40 object-contain"
            aria-label="Video hasil optimasi"
          />
          <figcaption className="text-center text-[11px] font-medium text-foreground">
            Sesudah — {rep?.after?.resolusi ?? "—"} · {String(rep?.after?.bitrate_video ?? "—")}
          </figcaption>
        </figure>
      </div>

      {/* skor kualitas + ceklis */}
      {v && (
        <div className="rounded-xl border border-border/60 bg-card p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className="gap-1 bg-primary/15 text-primary">
              <BadgeCheck className="h-3 w-3" />
              {v.checks.filter((c) => c.passed).length}/{v.checks.length} verifikasi lolos
            </Badge>
            {v.metrics.ssim != null && <Chip tone="good">SSIM {v.metrics.ssim}</Chip>}
            {v.metrics.psnr != null && <Chip tone="good">PSNR {v.metrics.psnr} dB</Chip>}
            {v.audio_loudness_lufs != null && <Chip>loudness {v.audio_loudness_lufs} LUFS</Chip>}
            {v.faststart && <Chip tone="good">faststart</Chip>}
            <Chip>{rep?.after?.ukuran_file ?? fmtBytes(job.output_size)}</Chip>
          </div>
          {v.metrics.metrics_note && (
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground/80">{v.metrics.metrics_note}</p>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer text-[11.5px] font-medium text-muted-foreground hover:text-foreground">
              Rincian ceklis verifikasi
            </summary>
            <ul className="mt-1.5 space-y-1">
              {v.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2 text-[11.5px]">
                  {c.passed ? (
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  )}
                  <span className="min-w-0">
                    <span className={cn("font-medium", c.passed ? "text-foreground" : "text-destructive")}>{c.name}</span>{" "}
                    <span className="text-muted-foreground">— {c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {/* provenance reminder */}
      {(prov?.c2pa || prov?.aigc) && (
        <div className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-[12px] leading-relaxed text-foreground">
            <span className="font-semibold">Label asal-usul dipertahankan.</span>{" "}
            <span className="text-muted-foreground">
              {prov?.perlakuan ?? "Sumber tetap utuh; versi A adalah salinan byte-identik."} Saat mengunggah,
              aktifkan fitur label konten AI di platform.
            </span>
          </p>
        </div>
      )}

      {/* aksi */}
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={outUrl}
          download=""
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Download className="h-3.5 w-3.5" />
          Unduh hasil
        </a>
        <div className="flex items-center gap-1">
          <IconAction label="Unduh laporan PDF" icon={Download} href={api.reportUrl(jobId, "pdf")} download="" />
          <IconAction label="Unduh laporan JSON" icon={Download} href={api.reportUrl(jobId, "json")} download="" />
        </div>
        <button
          type="button"
          onClick={onMakeAB}
          disabled={!!ab}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground disabled:opacity-50"
        >
          <FlaskConical className="h-3.5 w-3.5" />
          {ab ? "A/B tersedia" : "Buat 2 versi untuk uji unggah"}
        </button>
        <SendToMenu
          source="optimasi"
          getPayload={(target) =>
            target === "seo"
              ? null
              : {
                  kind: "video-url",
                  url: outUrl,
                  name: `${job.original_name.replace(/\.[^.]+$/, "")}_optimasi.mp4`,
                  size: job.output_size,
                }
          }
        />
        <IconAction label="Proses ulang" icon={RotateCcw} onClick={onRetry} />
        <span className="ml-auto" />
        <p className="w-full text-[10.5px] leading-relaxed text-muted-foreground/70 sm:w-auto">
          Efek terhadap kompresi platform belum terjamin; ukur sendiri lewat Mode Uji A/B.
        </p>
      </div>

      {/* file A/B */}
      {ab && (
        <div className="space-y-1.5 rounded-xl border border-border/60 bg-card p-3">
          <p className="text-[11.5px] font-medium text-muted-foreground">Mode uji A/B — unggah keduanya ke platform, bandingkan:</p>
          {ab.a && (
            <FileChip
              name={ab.a.name}
              sub="A — sumber apa adanya (label asal-usul utuh)"
              onRemove={undefined}
            />
          )}
          <FileChip
            name={ab.b.name}
            sub="B — hasil optimasi"
            onRemove={undefined}
          />
          <div className="flex gap-2 pt-1">
            {ab.a && (
              <a href={api.BASE + `/jobs/${jobId}/download?kind=a`} download={ab.a.name} className="inline-flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2.5 text-[11.5px] font-medium text-primary hover:bg-primary/20">
                <Download className="h-3 w-3" /> Unduh A
              </a>
            )}
            <a href={api.BASE + `/jobs/${jobId}/download?kind=b`} download={ab.b.name} className="inline-flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2.5 text-[11.5px] font-medium text-primary hover:bg-primary/20">
              <Download className="h-3 w-3" /> Unduh B
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- InfoTab ---------------- */

function InfoTab() {
  return (
    <div className="space-y-3 pt-5">
      <section aria-label="Cara kerja" className="rounded-2xl border border-border/70 bg-panel p-4">
        <ol className="space-y-3">
          {HOW_IT_WORKS.map((step, i) => (
            <li key={step.title} className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
                <step.icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <p className="min-w-0 text-[13px] leading-relaxed">
                <span className="font-semibold text-foreground">
                  {i + 1}. {step.title}
                </span>{" "}
                <span className="text-muted-foreground">— {step.detail}</span>
              </p>
            </li>
          ))}
        </ol>
      </section>
      <section className="rounded-2xl border border-border/70 bg-panel p-4">
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            <span className="font-semibold text-foreground">Jaminan kejujuran.</span>{" "}
            <span className="text-muted-foreground">
              Tag encoder ditulis jujur (&ldquo;Review Picks Studio (FFmpeg x264)&rdquo;), tabel sampel selalu
              jujur (jumlah sampel = jumlah frame nyata), dan label C2PA/AIGC pada sumber tidak pernah dihapus.
            </span>
          </span>
        </p>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground/80">
          Catatan jujur: tool ini memberi sumber unggahan terbaik yang masuk akal (1080×1920, bitrate tinggi,
          warna benar, audio rapi). Platform tetap mengompres ulang setiap unggahan — efek akhirnya diukur
          sendiri lewat Mode Uji A/B.
        </p>
      </section>
    </div>
  )
}

/* ---------------- AbTab ---------------- */

function AbTab({
  summary,
  notes,
  form,
  setForm,
  onSubmit,
  hasDone,
}: {
  summary: { total: number; a: number; b: number; note: string } | null
  notes: api.AbNote[]
  form: { platform: string; version: string; meta_shown: string; reach: string; note: string }
  setForm: React.Dispatch<React.SetStateAction<{ platform: string; version: string; meta_shown: string; reach: string; note: string }>>
  onSubmit: () => void
  hasDone: boolean
}) {
  const field = "h-8 w-full rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
  return (
    <div className="space-y-4 pt-5">
      <p className="flex items-start gap-2 rounded-xl border border-border/60 bg-panel px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        {summary?.note ?? "Efek terhadap kompresi platform belum terjamin; ukur sendiri."}{" "}
        {summary && (
          <span className="shrink-0 font-medium text-foreground">
            {summary.total} catatan · A: {summary.a} · B: {summary.b}
          </span>
        )}
      </p>

      <section className="rounded-2xl border border-border/70 bg-panel p-4">
        <p className="text-[13px] font-semibold text-foreground">Catat hasil uji</p>
        <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input className={field} value={form.platform} onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value }))} placeholder="Platform" aria-label="Platform" />
          <select
            className={field}
            value={form.version}
            onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
            aria-label="Versi"
          >
            <option value="A">Versi A (sumber)</option>
            <option value="B">Versi B (optimasi)</option>
          </select>
          <input className={field} value={form.meta_shown} onChange={(e) => setForm((f) => ({ ...f, meta_shown: e.target.value }))} placeholder="Resolusi/bitrate tayang" aria-label="Resolusi atau bitrate tayang" />
          <input className={field} value={form.reach} onChange={(e) => setForm((f) => ({ ...f, reach: e.target.value }))} placeholder="Jangkauan" aria-label="Jangkauan" />
        </div>
        <textarea
          className="mt-2 w-full rounded-lg border border-border bg-card px-2.5 py-2 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
          rows={2}
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          placeholder="Catatan (mis. kualitas tampil, komentar penonton)…"
          aria-label="Catatan uji"
        />
        <div className="mt-2.5 flex justify-end">
          <button
            type="button"
            onClick={onSubmit}
            disabled={!hasDone}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Simpan catatan
          </button>
        </div>
        {!hasDone && <p className="mt-1.5 text-[11px] text-muted-foreground">Catatan ditautkan ke hasil terakhir yang selesai di tab Hasil.</p>}
      </section>

      {notes.length > 0 && (
        <section className="nice-scrollbar max-h-72 space-y-2 overflow-y-auto rounded-2xl border border-border/70 bg-panel p-3">
          {notes.map((n) => (
            <div key={n.id} className="rounded-xl border border-border/60 bg-card p-2.5">
              <div className="flex items-center gap-1.5">
                <Chip tone={n.version.toUpperCase().startsWith("B") ? "good" : "muted"}>Versi {n.version.toUpperCase()}</Chip>
                <span className="text-[11.5px] font-medium text-foreground">{n.platform || "—"}</span>
                <span className="text-[11px] text-muted-foreground">{n.meta_shown}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground/70">
                  {new Date(n.created_at * 1000).toLocaleDateString("id-ID", { day: "numeric", month: "short" })}
                </span>
              </div>
              {n.reach && <p className="mt-1 text-[11.5px] text-muted-foreground">Jangkauan: {n.reach}</p>}
              {n.note && <p className="mt-0.5 text-[11.5px] leading-relaxed text-foreground/90">{n.note}</p>}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

/* ---------------- AdvancedPanel ---------------- */

function AdvancedPanel({ opts, setOpts }: { opts: JobOptions; setOpts: React.Dispatch<React.SetStateAction<JobOptions>> }) {
  const set = (patch: Partial<JobOptions>) => setOpts((o) => ({ ...o, ...patch, preset: "kustom" }))
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">FPS</p>
        <div className="flex flex-wrap gap-1">
          {(["keep", "24", "25", "30", "60"] as const).map((f) => (
            <Pill key={f} active={opts.fps_conform === f} onClick={() => set({ fps_conform: f })}>
              {f === "keep" ? "Pertahankan" : f}
            </Pill>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">Profil output</p>
        <div className="flex flex-wrap gap-1">
          {([
            ["1080x1920", "9:16 · 1080×1920"],
            ["1080x1350", "4:5 · 1080×1350"],
            ["1080x1080", "1:1 · 1080×1080"],
            ["720x1280", "720×1280"],
            ["sumber", "Sumber"],
          ] as const).map(([key, label]) => (
            <Pill key={key} active={opts.profile === key} onClick={() => set({ profile: key })}>
              {label}
            </Pill>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">Kecepatan encode (x264)</p>
        <div className="flex flex-wrap gap-1">
          {(["slow", "medium", "fast", "veryfast"] as const).map((p) => (
            <Pill key={p} active={opts.x264_preset === p} onClick={() => set({ x264_preset: p })}>
              {p}
            </Pill>
          ))}
        </div>
        <p className="text-[10.5px] text-muted-foreground/70">slow = kualitas terbaik (paling lama) · veryfast = tercepat</p>
      </div>
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
          CRF {opts.crf} · maxrate {opts.maxrate_mbps} Mbps
        </p>
        <input
          type="range"
          min={14}
          max={30}
          step={1}
          value={opts.crf}
          onChange={(e) => set({ crf: Number(e.target.value) })}
          className="w-full accent-[var(--primary)]"
          aria-label="CRF"
        />
        <input
          type="number"
          min={1}
          max={40}
          step={0.5}
          value={opts.maxrate_mbps}
          onChange={(e) => set({ maxrate_mbps: Math.max(1, Number(e.target.value) || 12), bufsize_mbps: Math.max(2, Number(e.target.value) * 2 || 24) })}
          className="h-8 w-28 rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus:border-primary/60"
          aria-label="Maxrate Mbps"
        />
        <span className="ml-1 text-[10.5px] text-muted-foreground/70">Mbps (batas laju, buffer = 2×)</span>
      </div>
      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">Audio</p>
        <div className="flex flex-wrap gap-1">
          {[128, 160, 192].map((b) => (
            <Pill key={b} active={opts.audio_bitrate_kbps === b} onClick={() => set({ audio_bitrate_kbps: b })}>
              {b} kbps
            </Pill>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-foreground">
          <Switch checked={opts.normalize_audio} onCheckedChange={(v) => set({ normalize_audio: v })} />
          Normalisasi loudness (2-pass)
        </label>
        {opts.normalize_audio && (
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            target
            <input
              type="number"
              min={-30}
              max={-6}
              step={0.5}
              value={opts.target_lufs}
              onChange={(e) => set({ target_lufs: Math.max(-30, Math.min(-6, Number(e.target.value) || -14)) })}
              className="h-7 w-20 rounded-lg border border-border bg-card px-2 text-[12px] text-foreground outline-none focus:border-primary/60"
              aria-label="Target LUFS"
            />
            LUFS · true peak −1 dBTP
          </label>
        )}
      </div>
      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">Privasi &amp; struktur</p>
        <label className="flex items-center gap-2 text-[12.5px] text-foreground">
          <Switch checked={opts.privacy_clean} onCheckedChange={(v) => set({ privacy_clean: v })} />
          Bersihkan metadata pribadi (GPS, perangkat, komentar)
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-foreground">
          <Switch checked={opts.fix_sample_table} onCheckedChange={(v) => set({ fix_sample_table: v })} />
          Perbaiki tabel sampel palsu (encode ulang)
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-foreground">
          <Switch checked={opts.add_silent_audio} onCheckedChange={(v) => set({ add_silent_audio: v })} />
          Audio senyap bila sumber tanpa audio
        </label>
        <p className="text-[10.5px] leading-relaxed text-muted-foreground/70">
          Label C2PA/AIGC tidak pernah dihapus — hanya metadata pribadi yang dibersihkan.
        </p>
      </div>
    </div>
  )
}
