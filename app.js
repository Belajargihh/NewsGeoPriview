import dotenv from "dotenv";
dotenv.config();

// ================================================
// IMPORT MODULE
// ================================================
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { z } from "zod";
// import fetch from "node-fetch";
import axios from "axios";
import * as cheerio from "cheerio";
import midtransClient from "midtrans-client";

// ================================================
// KONFIGURASI API KEY DARI .env
// ================================================
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const CUSTOM_SEARCH_API_KEY = process.env.CUSTOM_SEARCH_API_KEY;
const CUSTOM_SEARCH_CX = process.env.CUSTOM_SEARCH_CX;
const LOCATIONIQ_API_KEY = process.env.LOCATIONIQ_API_KEY;

// === TAMBAHKAN INI: KONFIGURASI MIDTRANS ===
// Ganti string di bawah dengan Server Key Sandbox Anda jika belum ada di .env
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY; 

const snap = new midtransClient.Snap({
    isProduction: false, // Set true jika sudah live production
    serverKey: MIDTRANS_SERVER_KEY
});

// ================================================
// SKEMA ANALISISx
// ================================================
const AnalisisSchema = z.object({
  lokasi_kejadian: z.string().describe("Lokasi spesifik kejadian."),
  ringkasan_interaktif: z.string().describe("Ringkasan singkat kejadian."),
});

// ================================================
// INISIALISASI MODEL GEMINI DENGAN PROMPT AMAN (ESCAPE BRACES)
// ================================================
let analysisChain;
let modelSiap = false;
try {
  const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-pro",
    apiKey: GOOGLE_API_KEY,
    temperature: 0.2,
  });

  // Parser Zod untuk output yang terstruktur
  const parser = StructuredOutputParser.fromZodSchema(AnalisisSchema);
  const formatInstructions = parser.getFormatInstructions();

  // --- Escape kurung kurawal agar tidak di-parse sebagai template ---
  const safeFormatInstructions = formatInstructions
    .replaceAll("{", "{{")
    .replaceAll("}", "}}");

  // Buat prompt sebagai array pesan (role-content objects)
  const prompt = ChatPromptTemplate.fromMessages([
    {
      role: "system",
      content: `Kamu adalah analis berita profesional dengan kemampuan memahami konteks informasi, lokasi geografis, dan latar sosial-ekonomi. Tugas Utama:
1. **Identifikasi Lokasi Kejadian** secara **sangat spesifik**:
- Sertakan **jalan**, **nama gedung**, **kelurahan**, **kecamatan**, **kota**, **provinsi**.
- Jika berita hanya menyebut kota, coba cari **detail lokasi tambahan dari konteks paragraf lain**.
- Jika ada nama tempat umum (mall, sekolah, kantor pemerintah, rumah sakit, terminal, pasar), sertakan.
- Pastikan lokasinya **dapat ditemukan di Google Maps / OpenStreetMap**.
- Jika benar-benar tidak ada, isi: "Tidak terdeteksi".
2. **Buat Ringkasan Berita yang Lengkap, Informatif, dan Tidak Membosankan**:
Tulis dalam bahasa Indonesia yang natural, jelas, runut, dan enak dibaca. Format ringkasan sebagai berikut:
**Inti Berita:** (apa yang terjadi, siapa yang terlibat, kapan dan di mana)
**Latar Belakang:** (apa penyebab atau kondisi yang melatarinya)
**Fakta Penting / Data / Kutipan Relevan:** (angka, keputusan, pernyataan, dampak langsung)
**Dampak / Konsekuensi:** (pengaruh bagi masyarakat, pemerintah, ekonomi, sosial, lingkungan, dll)
**Kesimpulan:** (penegasan inti berita dalam satu paragraf yang lugas)
Gunakan gaya bahasa yang:
- Informatif
- Tidak kaku
- Tidak terlalu panjang bertele-tele
- Tapi cukup detail agar pembaca merasa paham konteks besarnya

Instruksi output (WAJIB IKUTI): ${safeFormatInstructions}`,
    },
    {
      role: "user",
      content: "{input}",
    },
  ]);

  // Rangkai prompt → llm → parser seperti sebelumnya
  analysisChain = prompt.pipe(llm).pipe(parser);
  modelSiap = true;
  console.log(
    "✅ Model Gemini siap dengan prompt aman & stabilized (escaped braces)."
  );
} catch (err) {
  console.error("❌ Gagal inisialisasi Gemini:", err);
}

// ================================================
// LIST PROVINSI INDONESIA (Sederhana untuk matching awal)
// Digunakan untuk mendeteksi tingkat provinsi dalam teks
// ================================================
const PROVINCES = [
  "Aceh",
  "Sumatera Utara",
  "Sumatera Barat",
  "Riau",
  "Jambi",
  "Sumatera Selatan",
  "Bengkulu",
  "Lampung",
  "Bangka Belitung",
  "Kepulauan Riau",
  "DKI Jakarta",
  "Jawa Barat",
  "Banten",
  "Jawa Tengah",
  "DI Yogyakarta",
  "Jawa Timur",
  "Bali",
  "Nusa Tenggara Barat",
  "Nusa Tenggara Timur",
  "Kalimantan Barat",
  "Kalimantan Tengah",
  "Kalimantan Selatan",
  "Kalimantan Timur",
  "Kalimantan Utara",
  "Sulawesi Utara",
  "Gorontalo",
  "Sulawesi Tengah",
  "Sulawesi Selatan",
  "Sulawesi Tenggara",
  "Sulawesi Barat",
  "Maluku",
  "Maluku Utara",
  "Papua Barat",
  "Papua Barat Daya",
  "Papua",
];

function normalizeText(s) {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .replace(/[\n\t]+/g, " ")
    .trim();
}

// ================================================
// FUNGSI PENCARIAN ARTIKEL GOOGLE
// ================================================
async function searchGoogle(query, maxResults = 50) {
  const results = [];
  const PAGE_SIZE = 10; // Google max is 10 per page

  for (let start = 1; start <= maxResults; start += PAGE_SIZE) {
    const endpoint = new URL("https://www.googleapis.com/customsearch/v1");
    endpoint.searchParams.set("key", CUSTOM_SEARCH_API_KEY);
    endpoint.searchParams.set("cx", CUSTOM_SEARCH_CX);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("num", PAGE_SIZE);
    endpoint.searchParams.set("start", start);

    try {
      const response = await fetch(endpoint.toString());
      const data = await response.json();

      if (!data.items || data.items.length === 0) break;

      const mapped = data.items.map((item) => ({
        judul: item.title,
        sumber: item.displayLink,
        url: item.link,
      }));

      results.push(...mapped);

      // Jika totalResults lebih kecil dari start+PAGE_SIZE, stop
      const total = parseInt(data.searchInformation?.totalResults || "0", 10);
      if (start + PAGE_SIZE > total) break;
    } catch (err) {
      console.error("❌ Google Search gagal:", err);
      break;
    }
  }

  return results;
}

function extractPOI(text) {
  const poiKeywords = [
    "sd",
    "smp",
    "sma",
    "smk",
    "universitas",
    "kampus",
    "kampung",
    "sekolah",
    "rumah sakit",
    "rsud",
    "puskesmas",
    "bandara",
    "airport",
    "terminal",
    "pelabuhan",
    "kantor desa",
    "kantor kelurahan",
    "kelurahan",
    "kecamatan",
    "distrik",
    "masjid",
    "gereja",
    "pura",
    "vihara",
  ];
  for (const keyword of poiKeywords) {
    const regex = new RegExp(`\\b(${keyword}[\\w\\s\\-\\d]+)`, "i");
    const match = text.match(regex);
    if (match) return match[1].trim();
  }
  return null;
}

// ================================================
// GEOCODING HIERARKIS (LocationIQ + matching admin)
// - Coba geocode untuk level-level: full -> provinsi/kab/kec/kel/jalan
// - Kembalikan object dengan 'level' paling detail yang berhasil
// ================================================

// ================== PERBAIKAN GEOCODING ==================
// Helper: normalisasi istilah administratif & extract nama admin
function extractAdminLevels(text) {
  if (!text) return {};
  const t = text.replace(/\s+/g, " ").trim();
  // normalisasi singkatan umum (Kab., Kec., Kel., Ds.)
  const norm = t
    .replace(/\bKab(?:\.|upaten)?\b/gi, "Kabupaten")
    .replace(/\bKota\b/gi, "Kota")
    .replace(/\bKec(?:\.|amatan)?\b/gi, "Kecamatan")
    .replace(/\bDistrik\b/gi, "Kecamatan") // mapping khusus Papua
    .replace(/\bKel(?:\.|urahan)?\b/gi, "Kelurahan")
    .replace(/\bDesa\b/gi, "Desa")
    .replace(/\bProv(?:\.|insi)?\b/gi, "Provinsi");

  const out = {};
  // province
  const provMatch = norm.match(/\bProvinsi\s+([A-ZÀ-ÖØ-Ý][A-Za-z0-9\-\s]+)/i);
  if (provMatch) out.provinsi = provMatch[1].trim();
  // kabupaten / kota
  const kabMatch =
    norm.match(/\bKabupaten\s+([A-ZÀ-ÖØ-Ý][A-Za-z0-9\-\s]+)/i) ||
    norm.match(/\bKota\s+([A-ZÀ-ÖØ-Ý][A-Za-z0-9\-\s]+)/i);
  if (kabMatch) out.kab_kota = kabMatch[1].trim();
  // kecamatan / distrik
  const kecMatch = norm.match(/\bKecamatan\s+([A-ZÀ-ÖØ-Ý][A-Za-z0-9\-\s]+)/i);
  if (kecMatch) out.kecamatan = kecMatch[1].trim();
  // kelurahan / desa
  const kelMatch =
    norm.match(/\bKelurahan\s+([A-ZÀ-ÖØ-Ý][A-Za-z0-9\-\s]+)/i) ||
    norm.match(/\bDesa\s+([A-ZÀ-ÖØ-Ý][A-Za-z0-9\-\s]+)/i);
  if (kelMatch) out.kelurahan = kelMatch[1].trim();
  // jalan / area
  const jalanMatch = norm.match(
    /\b(Jalan|Jl\.?|Jln\.?|Area|Perumahan|Kompleks)\s+([A-ZÀ-ÖØ-ÝA-Za-z0-9\-\s\.]+)/i
  );
  if (jalanMatch) out.jalan = jalanMatch[0].trim();
  // raw fallback
  out.raw = text;
  return out;
}

// Verifikasi: apakah komponen hasil geocoder cocok dengan admin yang diekstrak?
function componentsMatchAdmin(components = {}, extracted = {}) {
  if (!components || !extracted) return false;
  // normalize strings lowercase
  const cmp = {};
  for (const k of Object.keys(components)) {
    if (components[k]) cmp[k] = String(components[k]).toLowerCase();
  }
  const ex = {};
  for (const k of Object.keys(extracted)) {
    if (extracted[k]) ex[k] = String(extracted[k]).toLowerCase();
  }

  // Jika provinsi ada di extracted -> pastikan provider components mencantumkan provinsi
  if (ex.provinsi) {
    const provOk =
      Object.values(cmp).some((v) => v.includes(ex.provinsi)) ||
      (cmp.state && cmp.state.includes(ex.provinsi));
    if (!provOk) return false;
  }
  // Jika kab_kota ada -> cocokkan juga (longer match)
  if (ex.kab_kota) {
    const kabOk = Object.values(cmp).some((v) => v.includes(ex.kab_kota));
    if (!kabOk) return false;
  }
  // Jika kecamatan ada -> coba cocokkan (boleh partial)
  if (ex.kecamatan) {
    const kecOk = Object.values(cmp).some((v) =>
      v.includes(ex.kecamatan.split(/\s/)[0])
    );
    if (!kecOk) {
      // bukan must-have — tapi jika provinsi/kab cocok, boleh lanjut
      // return false;
    }
  }
  // jika lolos semua cek wajib, return true
  return true;
}

async function tryLocationIQ(query) {
  // Cek apakah query mengandung nama POI (sekolah, bandara, kantor, dll)
  const poiName = extractPOI(query);
  // Jika ada POI → gunakan POI-based search
  const searchText = poiName ? poiName : query;
  const url = `https://us1.locationiq.com/v1/search?key=${LOCATIONIQ_API_KEY}&q=${encodeURIComponent(
    searchText
  )}&format=json&addressdetails=1&limit=1&dedupe=1&normalizeaddress=1&countrycodes=id`;

  console.log("🌍 LocationIQ Query:", searchText);
  console.log("🔗 URL:", url);

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const item = data[0];
      const { lat, lon, display_name, boundingbox, address } = item;
      return {
        lat: parseFloat(lat),
        lon: parseFloat(lon),
        display_name,
        boundingbox,
        components: address || {},
        provider: "locationiq",
        nama_lengkap: display_name,
      };
    }
    return null;
  } catch (err) {
    console.warn("LocationIQ error:", err);
    return null;
  }
}

// Fungsi utama: hierarchicalGeocode (memory-friendly, deterministic)
async function hierarchicalGeocode(candidateText) {
  candidateText = normalizeText(candidateText);
  if (!candidateText) return null;
  const tried = [];
  const extracted = extractAdminLevels(candidateText);

  // Susun query paling spesifik → paling umum
  const parts = [];
  if (extracted.jalan) parts.push(extracted.jalan);
  if (extracted.kelurahan) parts.push("Kelurahan " + extracted.kelurahan);
  if (extracted.kecamatan) parts.push("Kecamatan " + extracted.kecamatan);
  if (extracted.kab_kota) parts.push("Kabupaten " + extracted.kab_kota);
  if (extracted.provinsi) parts.push("Provinsi " + extracted.provinsi);

  const queries = [];
  if (parts.length) queries.push(parts.join(", "));
  queries.push(candidateText);
  if (!candidateText.toLowerCase().includes("indonesia"))
    queries.push(candidateText + ", Indonesia");

  // 🔥 Hanya LocationIQ — no Nominatim
  for (const q of queries) {
    tried.push(q);
    const liq = await tryLocationIQ(q);
    if (liq && componentsMatchAdmin(liq.components, extracted)) {
      return { ...liq, matched_query: q, tried };
    }
  }

  // fallback terakhir
  const fallback = await tryLocationIQ(candidateText + ", Indonesia");
  if (fallback)
    return { ...fallback, matched_query: candidateText + ", Indonesia", tried };

  return { error: "not_found", tried };
}

// Deprecated wrapper: jangan menempelkan Kota Sorong statis — gunakan hierarchicalGeocode
async function geocodeLocation(locationText) {
  if (!locationText) return null;
  // gunakan hierarchicalGeocode karena lebih robust
  const result = await hierarchicalGeocode(locationText);
  if (!result || result.error) return null;
  return {
    lat: result.lat ?? null,
    lon: result.lon ?? null,
    display_name: result.nama_lengkap ?? result.matched_query ?? null,
    provider: result.provider ?? null,
    components: result.components ?? null,
    boundingbox: result.boundingbox ?? null,
  };
}

// ================================================
// EXPRESS SERVER
// ================================================
const app = express();
app.use(cors());
app.use(express.json());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index_NewsGeo.html"));
});

// ================================================
// HELPERS: build human-friendly hierarchy from geocoder components
// ================================================
function buildHierarchyFromComponents(components, fallbackText) {
  // components is provider-specific; normalize common keys
  // LocationIQ/OpenCage often has: country, state (provinsi), county (kab/kota), city, town, village, suburb, road
  const h = {
    provinsi: null,
    kab_kota: null,
    kecamatan: null,
    kelurahan: null,
    jalan: null,
    raw: components || {},
    fallback: fallbackText || null,
  };
  if (!components) return h;

  // try common keys
  h.provinsi =
    components.state || components.province || components.region || null;
  h.kab_kota =
    components.county ||
    components.city ||
    components.town ||
    components.municipality ||
    null;
  h.kecamatan =
    components.suburb ||
    components.district ||
    components.city_district ||
    null;
  h.kelurahan =
    components.village ||
    components.hamlet ||
    components.neighbourhood ||
    components.suburb ||
    null;
  h.jalan =
    components.road || components.street || components.road_reference || null;

  // fallback: try parsing fallbackText for keywords
  if (!h.provinsi) {
    for (const p of PROVINCES) {
      if (
        fallbackText &&
        fallbackText.toLowerCase().includes(p.toLowerCase())
      ) {
        h.provinsi = p;
        break;
      }
    }
  }
  return h;
}

// ================================================
// CLEANER & PARSER KHUSUS TRIBUNNEWS
// ================================================
function cleanArticleText(text) {
  return text
    .replace(/ADVERTISEMENT/gi, "")
    .replace(/BACA JUGA:.+?(\.|\n)/gi, "")
    .replace(/Artikel ini telah tayang.+/gi, "")
    .replace(/Tulis komentar Anda.+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Helper untuk URL relatif → absolut
function resolveImageUrl(src, baseUrl) {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return src;
  }
}

// Ambil byline dan paragraf dari HTML Tribunnews
function parseTribunnewsContent(html) {
  // Ambil byline: "TRIBUNMANOKWARI.COM, MANOKWARI"
  const bylineMatch = html.match(/TRIBUN[A-Z]+\.\w+,\s*([A-Z\s]+)/i);
  const lokasiByline = bylineMatch ? bylineMatch[1].trim() : "";

  // Ambil beberapa paragraf isi artikel
  const paragraphs = Array.from(html.matchAll(/<p[^>]*>(.*?)<\/p>/gis))
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(
      (p) => p.length > 40 && !/ADVERTISEMENT|BACA JUGA|Tulis komentar/i.test(p)
    )
    .slice(0, 6);

  return { lokasiByline, isi: paragraphs.join(" ") };
}

// ==============================
// FUNGSI EKSTRAKSI GAMBAR DARI HALAMAN
// ==============================
async function extractImagesFromHTML(url, html = null) {
  try {
    if (!html) {
      const response = await fetch(url);
      html = await response.text();
    }

    const imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
    const images = [];
    let match;

    while ((match = imgRegex.exec(html)) !== null) {
      if (
        match[1].includes("logo") ||
        match[1].includes("icon") ||
        match[1].endsWith(".svg")
      )
        continue;

      let absoluteUrl = match[1];
      if (absoluteUrl.startsWith("//")) absoluteUrl = "https:" + absoluteUrl;
      else if (absoluteUrl.startsWith("/")) {
        const base = new URL(url);
        absoluteUrl = base.origin + absoluteUrl;
      }

      images.push(absoluteUrl);
    }

    return images.slice(0, 5);
  } catch (err) {
    console.error("Gagal ekstrak gambar:", err);
    return [];
  }
}

// ================================================
// ENDPOINT ANALISIS BERDASARKAN URL BERITA
// ================================================
app.post("/api/analyze", async (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: "URL tidak boleh kosong." });
  if (!modelSiap) return res.status(500).json({ error: "Model belum siap." });

  try {
    // ===== 1) Ambil konten halaman =====
    const response = await fetch(url, {
      headers: { "User-Agent": "News-Geo-App/1.0 (your_email@example.com)" },
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => "");
      console.error("Fetch halaman gagal:", response.status, txt);

      return res.status(502).json({
        error: `Gagal mengambil halaman (status ${response.status}).`,
      });
    }

    const html = await response.text();

    // ===== 2) Ekstrak gambar dari berita =====
    const gambarPendukung = extractImagesFromHTML(html, url);

    // ===== 3) Ambil judul =====
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const judul = titleMatch ? titleMatch[1] : "Tidak ditemukan";

    // ===== 4) Ambil meta description =====
    const descMatch =
      html.match(/<meta name="description" content="(.*?)"/i) ||
      html.match(/<meta property="og:description" content="(.*?)"/i);

    const deskripsi = descMatch ? descMatch[1] : judul;

    // ===== 5) Ambil isi paragraf =====
    let lokasiByline = "";
    let fullText = "";
    let firstPara = "";

    if (url.includes("tribunnews.com")) {
      console.log("📰 Mode Tribunnews aktif");

      const parsed = parseTribunnewsContent(html);

      lokasiByline = parsed.lokasiByline;
      fullText = cleanArticleText(parsed.isi);
      firstPara = parsed.isi.split(".").slice(0, 1).join(".").trim() || "";
    } else {
      const paragraphs = Array.from(html.matchAll(/<p[^>]*>(.*?)<\/p>/gis))
        .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
        .filter((p) => p.length > 40)
        .slice(0, 4);

      fullText = cleanArticleText(paragraphs.join(" "));
      firstPara = paragraphs.length > 0 ? paragraphs[0] : "";
    }

    // ===== 6) Siapkan teks analisis untuk LLM =====
    const teksAnalisis =
      `${judul}. ${lokasiByline}. ${deskripsi}. ` +
      `${fullText}. Tolong identifikasi lokasi kejadian (jalan / kecamatan / kabupaten / provinsi) dan buat ringkasan interaktif.`;

    // ===== 7) Panggil LLM =====
    let analisis = {};
    try {
      const raw = await analysisChain.invoke({ input: teksAnalisis });

      if (
        !raw ||
        typeof raw !== "object" ||
        (!raw.lokasi_kejadian && !raw.ringkasan_interaktif)
      ) {
        console.warn("Format LLM tidak sesuai:", raw);

        analisis = {
          lokasi_kejadian: raw?.lokasi_kejadian || "Tidak terdeteksi",
          ringkasan_interaktif:
            raw?.ringkasan_interaktif ||
            (typeof raw === "string" ? raw : judul),
          _raw: raw,
        };
      } else {
        analisis = {
          lokasi_kejadian: raw.lokasi_kejadian ?? "Tidak terdeteksi",
          ringkasan_interaktif: raw.ringkasan_interaktif ?? judul,
          _raw: raw,
        };
      }
    } catch (err) {
      console.error("LLM error:", err);

      analisis = {
        lokasi_kejadian: "Tidak terdeteksi",
        ringkasan_interaktif: judul,
        _raw_error: String(err),
      };
    }

    // ===== 8) Geocoding =====
    let koordinat = null;

    try {
      koordinat = await hierarchicalGeocode(analisis.lokasi_kejadian);

      if (koordinat && typeof koordinat === "object") {
        koordinat.lat = koordinat.lat ?? null;
        koordinat.lon = koordinat.lon ?? null;
        koordinat.nama_lengkap =
          koordinat.nama_lengkap ?? koordinat.display_name ?? null;
      }
    } catch (e) {
      console.warn("Geocoding error:", e);
    }

    const lokasi_hirarki = buildHierarchyFromComponents(
      koordinat?.components || {},
      analisis.lokasi_kejadian
    );

    // ===== 9) KIRIM RESPON LENGKAP KE FRONTEND =====
    res.json({
      sumber_url: url,
      judul_berita: judul,
      deskripsi: deskripsi,
      first_paragraph: firstPara,

      lokasi_kejadian: analisis.lokasi_kejadian,
      ringkasan_interaktif: analisis.ringkasan_interaktif,
      analisis_raw: analisis._raw ?? analisis._raw_error ?? null,

      koordinat,
      lokasi_hirarki,

      // konsisten memakai satu nama
      gambar_pendukung: gambarPendukung ?? [],

      raw_html_excerpt: html.slice(0, 1200),
    });
  } catch (err) {
    console.error("❌ Kesalahan:", err);

    res.status(500).json({
      error: "Gagal menganalisis URL.",
      detail: String(err),
    });
  }
});

// ================================================
// ENDPOINT UTAMA
// ================================================
app.post("/api/analyze", async (req, res) => {
  const query = req.body.query;
  if (!query)
    return res.status(400).json({ error: "Query tidak boleh kosong." });
  if (!modelSiap) return res.status(500).json({ error: "Model belum siap." });

  try {
    const promptInput = `${query}\n\nTolong identifikasi LOKASI kejadian (seakurat mungkin) dan ringkasan.`;

    const [analisis, artikel] = await Promise.all([
      analysisChain.invoke({ input: promptInput }),
      searchGoogle(query),
    ]);

    // ===== FIX: Jika lokasi "Tidak terdeteksi", jangan kirim ke geocoder =====
    const lokasiText = analisis.lokasi_kejadian || "";
    let geo = null;

    if (
      lokasiText.trim() !== "" &&
      !lokasiText.toLowerCase().includes("tidak terdeteksi")
    ) {
      geo = await hierarchicalGeocode(lokasiText);
    }

    const hierarchy = buildHierarchyFromComponents(
      geo?.components || {},
      lokasiText
    );

    // ===== FIX: Ambil gambar dari Google Search result =====
    const gambarPendukung = [];
    for (const art of artikel) {
      const imgs = await extractImagesFromHTML(art.url);
      gambarPendukung.push(...imgs);
    }

    res.json({
      lokasi_kejadian: analisis.lokasi_kejadian,
      ringkasan_interaktif: analisis.ringkasan_interaktif,
      koordinat: geo,
      lokasi_hirarki: hierarchy,
      artikel_terkait: artikel,
      gambar_pendukung: gambarPendukung.slice(0, 10), // maks 10 gambar
    });
  } catch (err) {
    console.error("❌ Kesalahan:", err);
    res.status(500).json({ error: "Analisis gagal." });
  }
});

app.post("/api/extract-images", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL kosong" });

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const $ = cheerio.load(response.data);

    // Kumpulkan semua <img>
    let images = [];
    $("img").each((i, img) => {
      let src = $(img).attr("src");

      if (!src) return;
      if (src.startsWith("//")) src = "https:" + src;

      // Filter gambar kecil (logo, ikon)
      if (src.includes("logo") || src.includes("icon")) return;
      if (src.length < 10) return;

      images.push(src);
    });

    images = [...new Set(images)]; // Unique

    res.json({ images });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Gagal mengambil gambar" });
  }
});

app.get("/api/highlights", (req, res) => {
  res.json({
    status: "ok",
    highlights: [
      {
        judul: "Contoh Berita 1",
        sumber: "Detik",
        url: "https://example.com",
      },
      {
        judul: "Contoh Berita 2",
        sumber: "Kompas",
        url: "https://example.com",
      },
    ],
  });
});

// ================================================
// ENDPOINT MIDTRANS PAYMENT
// ================================================
app.post("/api/create-transaction", async (req, res) => {
    try {
        const { uid, email, name } = req.body;

        // Validasi input sederhana
        if (!uid || !email) {
            return res.status(400).json({ error: "Data user tidak lengkap" });
        }

        // Buat Order ID unik (Contoh: PREMIUM-TIMESTAMP-UID)
        // UID dipotong sedikit agar tidak kepanjangan
        const orderId = `PREM-${new Date().getTime()}-${uid.substring(0, 5)}`;

        const parameter = {
            transaction_details: {
                order_id: orderId,
                gross_amount: 50000, // Harga Rp 50.000
                finish: "http://localhost:5000/search.html"
            },
            customer_details: {
                first_name: name || "User",
                email: email
            },
            item_details: [{
                id: 'PREMIUM_PLAN',
                price: 50000,
                quantity: 1,
                name: "NewsGeo Premium Plan"
            }]
        };

        // Minta Token ke Midtrans
        const transaction = await snap.createTransaction(parameter);
        const transactionToken = transaction.token;

        console.log(`✅ Token Midtrans dibuat untuk: ${email}`);
        res.json({ token: transactionToken });

    } catch (error) {
        console.error("❌ Gagal membuat transaksi Midtrans:", error);
        res.status(500).json({ error: error.message });
    }
});

// ================================================
// EXPORT UNTUK VERCEL (KODE BARU)
// ================================================
const port = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`🚀 Server berjalan di http://localhost:${port}`);
    });
}

export default app;
