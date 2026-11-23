# Carena 16-Bit — Online PvP Multiplayer Kartu (4–8 Pemain)

Revamped version of **Carena 16-Bit** featuring real-time online PvP multiplayer, authoritative server rules, Neon PostgreSQL database integration, and deployment to Vercel connected to `game.newsystem.space`.

---

## 🚀 Fitur Revamp PvP Online

1. **Real-Time Online PvP Multiplayer**:
   - 8 Mode Permainan Kartu:
     - 👑 **Capsa Banting** (Single, Pair, Triple, 5-Card: Straight, Flush, Full House, 4 of a Kind, Straight Flush)
     - 👹 **Setan-setan** (Cabut kartu lawan, buang pasangan otomatis, hindari kartu setan)
     - 7️⃣ **Seven Up** (Susun urutan 7 ke atas dan ke bawah pada 4 kembang)
     - 🐟 **Go Fish** (Minta kartu ke lawan untuk mengumpulkan 4 kartu kembar / Book)
     - 🤥 **Bohong-bohongan** (Bluffing dengan kartu tertutup dan tombol "🚨 Tuduh Bohong!")
     - 🎯 **4-1 (Empat Satu)** (Kumpulkan 4 kartu sekembang dengan poin mendekati/tepat 41)
     - 🍻 **Minuman (Party)** (Tarik kartu tantangan lingkaran meja seru bareng teman)
     - 🎰 **Blackjack 21** (Lawan Bandar dengan aksi Hit, Stand, dan Double)
   - Sistem Ruangan Mabar (Room Browser, Kode Unik #KRT-XXXX, Password Protection).
   - Ruang Tunggu (Lounge) dengan status "SIAP", tombol "Isi Bot" jika ingin langsung main dengan teman + AI, dan salin link undangan (`?join=KRT-XXXX`).
   - Server-Sent Events (SSE) streaming real-time + fallback polling untuk sinkronisasi turn, kartu meja, chat, dan emote.
   - Anti-Cheat Hand Protection (kartu rahasia lawan disembunyikan oleh server dari inspeksi browser).

2. **Database Neon PostgreSQL**:
   - Database name: `carena_game` (Region: Singapore `aws-ap-southeast-1`).
   - Tabel: `players`, `rooms`, `room_players`, `game_states`, `room_events`.
   - Profil pemain persisten: avatar, bingkai avatar, koin, riwayat kemenangan, dan peringkat leaderboard live.

3. **Deploy Vercel & Domain `game.newsystem.space`**:
   - Vercel Project: `carena-game` (Team: `slaks37s-projects`).
   - Production URL Vercel: `https://carena-game-dulwcig7r-slaks37s-projects.vercel.app`
   - Custom Domain: `game.newsystem.space`

---

## 🌐 Konfigurasi DNS Cloudflare untuk `game.newsystem.space`

Domain `newsystem.space` dikelola melalui nameserver Cloudflare (`melinda.ns.cloudflare.com` & `nitin.ns.cloudflare.com`).
Untuk mengarahkan subdomain `game.newsystem.space` ke Vercel:

1. Buka dashboard Cloudflare: **newsystem.space** > **DNS** > **Records**.
2. Tambahkan record CNAME:
   - **Type**: `CNAME`
   - **Name**: `game`
   - **Target**: `8dd2b9623448f801.vercel-dns-017.com` (atau `cname.vercel-dns.com`)
   - **Proxy status**: `DNS only` (Abu-abu / Gray Cloud) untuk penerbitan sertifikat SSL otomatis oleh Vercel.
3. Atau gunakan tautan Domain Connect Vercel otomatis:
   `https://vercel.com/api/v9/projects/prj_dvqup0VzMZcjFC0yggfzjtYuCTKK/domains/game.newsystem.space/domain-connect/apply?teamId=team_SCDxbr7VMTFUyI60ki7xaNmg`

---

## 💻 Menjalankan Secara Lokal

```bash
# 1. Install dependencies
npm install

# 2. Jalankan server lokal
npm run dev # atau node server.js
```
Buka browser di `http://localhost:3000`.
