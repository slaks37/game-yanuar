# Carena 16-Bit — Online PvP Multiplayer Kartu (2–8 Pemain)

**Carena 16-Bit** adalah game kartu multiplayer online. Server menjalankan aturan permainan dan menyimpan status meja di PostgreSQL. [Main Carena 16-Bit](https://carena-game.vercel.app/)

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
   - Browser mengambil status meja dan event terbaru dari API secara berkala. Data di PostgreSQL menyinkronkan giliran, kartu meja, chat, dan emote antar pemain.
   - Anti-Cheat Hand Protection (kartu rahasia lawan disembunyikan oleh server dari inspeksi browser).

2. **Database Neon PostgreSQL**:
   - Database name: `carena_game` (Region: Singapore `aws-ap-southeast-1`).
   - Tabel: `players`, `rooms`, `room_players`, `game_states`, `room_events`.
   - Profil pemain persisten: avatar, bingkai avatar, koin, riwayat kemenangan, dan peringkat leaderboard live.

---

## 💻 Menjalankan Secara Lokal

Siapkan database PostgreSQL khusus pengembangan. Buat file `.env` di root proyek dan isi `DATABASE_URL` dengan string koneksi database tersebut. Untuk Neon, salin string koneksi dari dashboard dan pertahankan parameter SSL-nya. Untuk PostgreSQL lokal yang berjalan tanpa TLS, tambahkan `?sslmode=disable` pada URL koneksi.

```bash
npm ci
npm run init-db
npm run dev
```

Buka [localhost:3000](http://localhost:3000/) dari dua profil browser untuk menguji mabar dengan identitas pemain yang berbeda. Jalankan `npm test` untuk menguji aturan permainan dan klien. Jalankan `npm run test:multiplayer` terhadap database uji yang sudah diinisialisasi untuk menguji alur melalui API.

## Deploy Manual ke Vercel

Proyek Vercel `carena-game` memakai deployment melalui CLI. Setelah perubahan di-push ke GitHub, jalankan langkah berikut dari checkout yang sudah diuji. Pastikan environment Production pada proyek tersebut berisi `DATABASE_URL` dan database sudah diinisialisasi.

```bash
vercel_scope='nama-scope-vercel'
vercel project inspect carena-game --scope "$vercel_scope"
candidate_url=$(vercel deploy --project carena-game --scope "$vercel_scope" --prod --skip-domain)
vercel inspect "$candidate_url" --scope "$vercel_scope"
vercel curl /api/health --deployment "$candidate_url" --scope "$vercel_scope" -- --fail --silent --show-error
```

Setelah deployment siap, health check mengembalikan `ok: true`, dan pengujian mabar berhasil, promosikan kandidat dan cek alamat publik.

```bash
vercel promote "$candidate_url" --scope "$vercel_scope"
curl --fail --silent --show-error https://carena-game.vercel.app/api/health
```
