# Review Picks Studio

Web application studio untuk produksi konten video review produk TikTok: perencanaan konten berbasis AI, overlay CTA/review, merge multi-segment, reupload yang aman (C2PA/AIGC-aware), serta optimasi kualitas video dengan pipeline FFmpeg + verifikasi otomatis.

## Fitur Utama

- **Studio hash-router (1 route, 11 view)**: planner konten AI, overlay, merge, reupload, optimasi kualitas, meta/SEO tool, dan memori konten.
- **Optimizer Service** (FastAPI): pipeline 7 modul — preflight, plan, probe, encode, verify, report, runner — dengan queue dan batas resource.
- **Reupload Aman**: mempertahankan label C2PA / penanda AIGC, tanpa spoofing metadata encoder.
- **Verifikasi otomatis**: hasil encode diverifikasi (resolusi, audio, kecepatan, integritas) sebelum dilaporkan.
- **Laporan PDF**: ringkasan verifikasi optimasi siap unduh.

## Teknologi

| Layer | Teknologi |
| --- | --- |
| Frontend | Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS 4, shadcn/ui |
| Backend | Next.js API Routes + FastAPI (mini service `optimizer-service`) |
| Database | Prisma ORM 6 + SQLite (`db/custom.db`) |
| Video | FFmpeg (argumen array, tanpa shell concat) |
| Bahasa Python | uv + ruff + mypy + pytest |

## Struktur Proyek

```
src/                    # Frontend + API routes Next.js
  app/                  # Route handlers & halaman (1 route + hash-router)
  components/           # Komponen UI (shadcn/ui + studio components)
  hooks/                # Custom React hooks
  lib/                  # Logika bisnis (merge, overlay, reupload, AI)
mini-services/
  optimizer-service/    # FastAPI optimizer (uv project, port 3010)
prisma/
  schema.prisma         # Skema database (18 model)
tests/
  e2e/                  # Playwright e2e (optimasi)
public/                 # Aset statis (SVG, robots.txt)
Caddyfile               # Gateway konfigurasi (port 81)
```

## Menjalankan Proyek

### 1. Frontend + API Next.js

```bash
bun install
cp .env.example .env          # sesuaikan path database bila perlu
bunx prisma db push
bun run dev                   # http://localhost:3000
```

### 2. Optimizer Service (FastAPI)

```bash
cd mini-services/optimizer-service
uv sync                       # install dependency Python
uv run uvicorn app.main:app --host 0.0.0.0 --port 3010
```

Pastikan `ffmpeg`/`ffprobe` tersedia di PATH.

## Testing

### Python (optimizer-service)

```bash
cd mini-services/optimizer-service
# Regenerasi fixture video binary (tidak disertakan di repo)
uv run python tests/make_fixtures.py
uv run python tests/make_f6_c2pa.py
# Jalankan seluruh test suite
uv run pytest
```

> Catatan: fixture `.mp4` di `tests/fixtures/` sengaja tidak disertakan (binary, dapat diregenerasi dengan skrip di atas).

### Lint & Type

```bash
bun run lint                  # ESLint (frontend)
cd mini-services/optimizer-service
uv run ruff check .
uv run mypy app
```

## Prinsip Proyek

1. **Tidak memalsukan metadata**: label encoder, C2PA, dan penanda AIGC tidak pernah di-spoof.
2. **FFmpeg aman**: seluruh argumen dikirim sebagai array, tanpa string shell.
3. **Copywriting jujur & netral**: klaim produk mengikuti fakta input pengguna.
4. **Verifikasi sebelum klaim**: output video diverifikasi otomatis sebelum dilaporkan sukses.

## Artefak yang Tidak Disertakan

Sesuai `.gitignore`, artefak runtime berikut tidak masuk repo:

- `db/` — database SQLite runtime (berisi data pengguna)
- `storage/`, `video-data/`, `upload/`, `download/` — media & hasil kerja pengguna
- `mini-services/optimizer-service/data/` — database queue optimizer
- `mini-services/optimizer-service/tests/fixtures/*.mp4` — fixture binary (regenerable)
- `tool-results/`, `ui-shots/`, `cache/`, log
- `bun.lock` — lockfile JS dapat diregenerasi dengan `bun install` (Python side tetap reproducible via `uv.lock`)
