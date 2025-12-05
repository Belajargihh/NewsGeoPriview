import dotenv from "dotenv";
dotenv.config();

// ================================================
// 1. IMPORT MODULE
// ================================================
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module"; 
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { z } from "zod";
import axios from "axios";
import * as cheerio from "cheerio";
import midtransClient from "midtrans-client";
import admin from "firebase-admin";
import { generateNewsPDF } from "./pdfService.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ================================================
// 2. KONFIGURASI API KEY
// ================================================
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const CUSTOM_SEARCH_API_KEY = process.env.CUSTOM_SEARCH_API_KEY;
const CUSTOM_SEARCH_CX = process.env.CUSTOM_SEARCH_CX;
const LOCATIONIQ_API_KEY = process.env.LOCATIONIQ_API_KEY;
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;

// ================================================
// 3. INISIALISASI FIREBASE & MIDTRANS
// ================================================
let db;
try {
  const serviceAccount = require("./serviceAccountKey.json");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log("🔥 Firebase Admin Terhubung!");
} catch (error) {
  console.warn("⚠️ Firebase Admin skip (File key tidak ditemukan).");
}

const snap = new midtransClient.Snap({
  isProduction: false, 
  serverKey: MIDTRANS_SERVER_KEY
});

// ================================================
// 4. SETUP GEMINI AI (Gemini 1.5 Flash)
// ================================================

// 🔥 UPDATE SCHEMA: Deskripsi yang menuntut panjang & detail
const AnalisisSchema = z.object({
  lokasi_kejadian: z.string().describe("Lokasi spesifik kejadian (Jalan, Gedung, Kelurahan, Kecamatan, Kota, Provinsi)."),
  // Instruksi Zod diperjelas agar output panjang
  ringkasan_interaktif: z.string().describe("Artikel berita lengkap (Minimal 3 paragraf/300 kata). Harus mencakup kronologi, penyebab, dampak, dan kutipan jika ada."),
  
  status_validitas: z.enum(["Terpercaya", "Perlu Verifikasi", "Indikasi Hoaks"]).describe("Klasifikasi validitas berita."),
  skor_kepercayaan: z.number().min(0).max(100).describe("Skor kepercayaan 0-100 berdasarkan gaya bahasa, sumber, dan logika."),
  analisis_hoaks: z.string().describe("Penjelasan singkat mengapa berita ini valid atau terindikasi hoaks.")
});

let analysisChain;
let modelSiap = false;

try {
  const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-pro", 
    apiKey: GOOGLE_API_KEY,
    temperature: 0.2, // Sedikit dinaikkan agar lebih kreatif menulis panjang
  });

  const parser = StructuredOutputParser.fromZodSchema(AnalisisSchema);
  const formatInstructions = parser.getFormatInstructions();
  const safeFormatInstructions = formatInstructions.replaceAll("{", "{{").replaceAll("}", "}}");

  // 🔥 UPDATE PROMPT: Instruksi Jurnalisme Mendalam
  const prompt = ChatPromptTemplate.fromMessages([
    {
      role: "system",
      content: `Kamu adalah Jurnalis Senior Investigasi dan Analis Geospasial.
Tugas Utama:
1. **Identifikasi Lokasi** secara presisi.
2. **Tulis Ulang Berita secara Lengkap (Deep Dive)**:
   - JANGAN membuat ringkasan pendek 4-5 baris. Itu DILARANG.
   - Buatlah narasi yang **panjang, mendalam, dan terstruktur** (Minimal 250-300 kata).
   - Gunakan struktur berikut:
     * **Paragraf 1 (Lead)**: Inti peristiwa (5W+1H) yang memikat.
     * **Paragraf 2 (Kronologi)**: Urutan kejadian dari awal hingga akhir secara detail.
     * **Paragraf 3 (Dampak & Konteks)**: Korban jiwa, kerugian materi, respons aparat, atau kaitan dengan peristiwa lain.
3. **Analisis Validitas (Anti-Hoaks)**:
   - Cek fakta, sumber, dan logika tulisan.

Instruksi Output JSON:
${safeFormatInstructions}`
    },
    { role: "user", content: "{input}" },
  ]);

  analysisChain = prompt.pipe(llm).pipe(parser);
  modelSiap = true;
  console.log("✅ Model Gemini (1.5 Flash) Siap - Mode Jurnalis Senior.");
} catch (err) {
  console.error("❌ Gagal init Gemini:", err);
}

// ================================================
// 5. HELPER FUNCTIONS 
// ================================================

// --- A. Geocoding Pintar ---
async function hierarchicalGeocode(text) {
  if (!text || text.length < 3 || text.toLowerCase().includes("tidak terdeteksi")) return null;
  
  const cleanInput = text.replace(/di |kawasan |wilayah |daerah |sekitar /gi, "");
  console.log(`📍 Geo Input: "${cleanInput}"`);

  const fetchLoc = async (query) => {
      if (!query || query.length < 3) return null;
      let q = query.toLowerCase().includes("indonesia") ? query : `${query}, Indonesia`;
      q = q.replace(/[^\w\s,\.-]/gi, ''); 
      const url = `https://us1.locationiq.com/v1/search?key=${LOCATIONIQ_API_KEY}&q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=1&normalizeaddress=1&countrycodes=id`;
      try {
          const res = await fetch(url);
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
              return {
                  lat: parseFloat(data[0].lat),
                  lon: parseFloat(data[0].lon),
                  display_name: data[0].display_name,
                  components: data[0].address || {}
              };
          }
      } catch(e) {}
      return null;
  };

  // 1. Coba Full Text
  let result = await fetchLoc(cleanInput);
  if (result) return result;

  // 2. Coba Cari POI
  const poiKeywords = ["Taman", "Gedung", "Jalan", "Jl", "Jl.", "Pasar", "Rumah Sakit", "RSUD", "Bandara", "Pelabuhan", "Masjid", "Gereja", "Sekolah", "SD", "SMP", "Kampus", "Hotel", "SPBU", "Terminal"];
  for (const keyword of poiKeywords) {
      const regex = new RegExp(`(${keyword}\\s+[\\w\\s\\d]+?)(?:,|\\smasuk|\\sdekat|\\ssebelah|$)`, "i");
      const match = cleanInput.match(regex);
      if (match) {
          result = await fetchLoc(match[1]);
          if (result) return result;
      }
  }

  // 3. Coba Cari Level Admin
  const adminLevels = ["Kecamatan", "Distrik", "Kelurahan", "Desa", "Kabupaten", "Kota", "Provinsi"];
  for (const level of adminLevels) {
      const regex = new RegExp(`${level}\\s+([A-Za-z0-9\\s\\-]+)`, "i");
      const match = cleanInput.match(regex);
      if (match) {
          result = await fetchLoc(match[0]);
          if (result) return result;
      }
  }

  // 4. Strategi Terakhir
  const parts = cleanInput.split(/,|\./);
  if (parts.length > 1) {
      const lastPart = parts[parts.length - 1].trim();
      result = await fetchLoc(lastPart);
      if (result) return result;
  }
  return null;
}

function buildHierarchyFromComponents(components, fallbackText) {
    const h = { raw: components || {}, fallback: fallbackText };
    if(!components) return h;
    h.provinsi = components.state || components.province || components.region;
    h.kab_kota = components.city || components.county || components.town;
    h.kecamatan = components.suburb || components.district;
    return h;
}

// --- B. Search Google ---
async function searchGoogle(query, maxResults = 50) { 
  const results = [];
  const limit = Math.min(maxResults, 50); 
  const PAGE_SIZE = 10;

  for (let start = 1; start <= limit; start += PAGE_SIZE) {
      const endpoint = new URL("https://www.googleapis.com/customsearch/v1");
      endpoint.searchParams.set("key", CUSTOM_SEARCH_API_KEY);
      endpoint.searchParams.set("cx", CUSTOM_SEARCH_CX);
      endpoint.searchParams.set("q", query); 
      endpoint.searchParams.set("num", "10");
      endpoint.searchParams.set("start", start.toString());

      try {
        console.log(`🔎 Google Search: "${query}" (Page: ${start})`);
        const response = await fetch(endpoint.toString());
        
        if (!response.ok) {
            console.error("Google API Error:", response.status);
            break; 
        }

        const data = await response.json();
        if (!data.items || data.items.length === 0) break;

        results.push(...data.items.map(item => {
            let thumb = "https://placehold.co/100x80?text=News";
            if (item.pagemap?.cse_image?.length > 0) {
                thumb = item.pagemap.cse_image[0].src;
            } else if (item.pagemap?.metatags?.length > 0 && item.pagemap.metatags[0]["og:image"]) {
                thumb = item.pagemap.metatags[0]["og:image"];
            }

            return {
                judul: item.title,
                sumber: item.displayLink,
                url: item.link,
                snippet: item.snippet,
                gambar: thumb
            };
        }));
      } catch (err) {
        console.error("Search Fail:", err.message);
        break;
      }
  }
  return results;
}

// --- C. Image Extractor & Scraper ---
async function extractContentAndImages(url) {
    try {
        const { data } = await axios.get(url, { 
            headers: { 
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }, 
            timeout: 5000 
        });

        const $ = cheerio.load(data);
        const images = [];
        $("img").each((i, el) => {
            let src = $(el).attr("src");
            if(src && !src.includes("icon") && !src.includes("logo") && src.length > 20) {
                if(src.startsWith("//")) src = "https:" + src;
                images.push(src);
            }
        });

        $("script, style, nav, footer, header, iframe, .ads, .advertisement").remove(); 
        let text = $("article").text() || $(".content").text() || $("body").text();
        text = text.replace(/\s+/g, " ").slice(0, 3000);

        return { text, images: [...new Set(images)].slice(0, 5) };

    } catch (e) { 
        console.warn(`⚠️ Scraping diblokir/gagal (${url}): ${e.message}`);
        return { text: "", images: [] }; 
    }
}

// ================================================
// 6. EXPRESS APP SETUP
// ================================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ================================================
// 7. ENDPOINTS (API)
// ================================================

// --- A. Endpoint Utama (Search) ---
app.post("/api/analyze", async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Query kosong" });

    try {
        // Prompt untuk search awal tidak perlu terlalu panjang
        const promptInput = `${query}\n\nIdentifikasi lokasi dan ringkas singkat (1 paragraf).`;
        const [analisis, artikel] = await Promise.all([
            modelSiap ? analysisChain.invoke({ input: promptInput }).catch(()=>({})) : {},
            searchGoogle(query, 10) 
        ]);

        let geo = null;
        if (analisis.lokasi_kejadian) {
            geo = await hierarchicalGeocode(analisis.lokasi_kejadian);
        }

        res.json({
            lokasi_kejadian: analisis.lokasi_kejadian || "Tidak terdeteksi",
            ringkasan_interaktif: analisis.ringkasan_interaktif || "Ringkasan belum tersedia",
            status_validitas: analisis.status_validitas || "Perlu Verifikasi",
            skor_kepercayaan: analisis.skor_kepercayaan || 50,
            koordinat: geo,
            lokasi_hirarki: buildHierarchyFromComponents(geo?.components, analisis.lokasi_kejadian),
            artikel_terkait: artikel, 
            gambar_pendukung: [] 
        });

    } catch (err) {
        console.error("API Error:", err);
        res.status(500).json({ error: "Gagal memproses permintaan" });
    }
});

// --- B. Endpoint Detail (Detail + Peta + VALIDASI HOAKS + LONG FORM) ---
app.post("/api/analyze-url", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL kosong" });

    try {
        console.log(`📖 Menganalisis (Long Form): ${url}`);
        
        const { text, images } = await extractContentAndImages(url);
        
        let inputUntukAI = "";
        if (text && text.length > 100) {
            inputUntukAI = `ISI BERITA: ${text}\nURL: ${url}`;
        } else {
            inputUntukAI = `Konten berita tidak dapat diakses (diblokir). 
            Tolong analisis berdasarkan URL ini saja: ${url}
            Cobalah tebak lokasi dan buat narasi mendalam tentang topik yang ada di URL tersebut.`;
        }

        // 🔥 PROMPT KHUSUS DETAIL: Minta format panjang
        const teksAnalisis = `${inputUntukAI}. 
        Tugas: 
        1. Identifikasi lokasi spesifik.
        2. TULIS ARTIKEL/RINGKASAN YANG PANJANG DAN MENDALAM (Minimal 3-4 Paragraf). Jelaskan kronologi, penyebab, dan dampak secara rinci.
        3. Cek validitas (hoaks/valid).`;
        
        const analisis = await analysisChain.invoke({ input: teksAnalisis });

        const geo = await hierarchicalGeocode(analisis.lokasi_kejadian);

        res.json({
            judul_berita: "Detail Berita",
            lokasi_kejadian: analisis.lokasi_kejadian,
            ringkasan_interaktif: analisis.ringkasan_interaktif,
            status_validitas: analisis.status_validitas,
            skor_kepercayaan: analisis.skor_kepercayaan,
            analisis_hoaks: analisis.analisis_hoaks,
            
            koordinat: geo,
            gambar_pendukung: images
        });

    } catch (err) {
        console.error("Detail Error:", err.message);
        res.json({
            judul_berita: "Gagal Memuat",
            lokasi_kejadian: "Tidak terdeteksi",
            ringkasan_interaktif: "Maaf, terjadi kesalahan teknis saat menganalisis berita.",
            status_validitas: "Perlu Verifikasi",
            skor_kepercayaan: 0,
            analisis_hoaks: "Gagal menganalisis.",
            koordinat: null,
            gambar_pendukung: []
        });
    }
});

// --- C. Endpoint Highlights (CACHE) ---
let highlightCache = null;
let lastHighlightTime = 0;
const CACHE_DURATION = 15 * 60 * 1000; 

app.get("/api/highlights", async (req, res) => {
    const now = Date.now();
    if (highlightCache && (now - lastHighlightTime < CACHE_DURATION)) {
        return res.json(highlightCache);
    }
    try {
        console.log("🔄 Fetching Highlights...");
        const artikel = await searchGoogle("Berita Terkini Indonesia", 20); 
        const responseData = { status: "ok", highlights: artikel };
        if (artikel.length > 0) {
            highlightCache = responseData;
            lastHighlightTime = now;
        }
        res.json(responseData);
    } catch (e) {
        if(highlightCache) return res.json(highlightCache);
        res.status(500).json({ error: "Gagal load highlight" });
    }
});

app.post("/api/extract-images", async (req, res) => {
    const { images } = await extractContentAndImages(req.body.url);
    res.json({ images });
});

// --- ENDPOINT GENERATE PDF ---
app.post("/api/generate-pdf", (req, res) => {
    const { judul, lokasi, ringkasan, url } = req.body;
    if (!judul) return res.status(400).send("Data tidak lengkap");

    const filename = `Report-${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    generateNewsPDF({ judul, lokasi, ringkasan, url }, res);
});

// ================================================
// 8. PAYMENT ENDPOINTS
// ================================================
app.post("/api/create-transaction", async (req, res) => {
    try {
        const { uid, email, name } = req.body;
        if (!uid || !email) return res.status(400).json({ error: "Data kurang" });
        const orderId = `PREM-${Date.now()}-${uid}`;
        const parameter = {
            transaction_details: { order_id: orderId, gross_amount: 50000 },
            customer_details: { first_name: name || "User", email: email },
            item_details: [{ id: 'PREM', price: 50000, quantity: 1, name: "Premium" }]
        };
        const transaction = await snap.createTransaction(parameter);
        res.json({ token: transaction.token });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/midtrans-notification", async (req, res) => {
    try {
        const notif = req.body;
        const statusResponse = await snap.transaction.notification(notif);
        const { order_id, transaction_status, fraud_status } = statusResponse;
        let isSuccess = (transaction_status === 'capture' && fraud_status === 'accept') || transaction_status === 'settlement';

        if (isSuccess && db) {
            const parts = order_id.split("-");
            const uid = parts.slice(2).join("-");
            if (uid) {
                await db.collection("users").doc(uid).set({
                    isPremium: true,
                    role: 'premium',
                    premiumSince: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                console.log(`✅ User ${uid} PREMIUM ACTIVATED`);
            }
        }
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

// ================================================
// 9. START SERVER
// ================================================
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 Server Berjalan di http://localhost:${port}`);
});