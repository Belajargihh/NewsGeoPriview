import PDFDocument from "pdfkit";

/**
 * Fungsi untuk membuat PDF Berita Sederhana (Hanya Judul & Ringkasan)
 */
export const generateNewsPDF = (data, res) => {
  const doc = new PDFDocument({ margin: 50 });

  // Pipe langsung ke response
  doc.pipe(res);

  // 1. Header
  doc
    .fontSize(10)
    .fillColor("grey")
    .text("NewsGeo Report", { align: "right" })
    .moveDown();

  doc
    .moveTo(50, 70)
    .lineTo(550, 70)
    .strokeColor("#aaaaaa")
    .stroke();
  
  doc.moveDown(2);

  // 2. Judul Berita
  doc
    .fontSize(20)
    .font("Helvetica-Bold")
    .fillColor("#2c3e50")
    .text(data.judul, { width: 500, align: "left" });
  
  doc.moveDown(1.5);

  // --- BAGIAN FOTO & LOKASI DIHAPUS ---

  // 3. Ringkasan
  doc
    .fontSize(14)
    .font("Helvetica-Bold")
    .fillColor("black")
    .text("Ringkasan Analisis AI:");
  
  doc.moveDown(0.5);

  const cleanSummary = data.ringkasan ? data.ringkasan.replace(/<br\s*\/?>/gi, "\n") : "Ringkasan tidak tersedia.";

  doc
    .fontSize(12)
    .font("Helvetica")
    .fillColor("#34495e")
    .text(cleanSummary, {
      align: "justify",
      lineGap: 5
    });

  doc.moveDown(2);

  // 4. Footer Link
  doc
    .fontSize(10)
    .fillColor("blue")
    .text("Sumber Asli: ", { continued: true })
    .text(data.url, { link: data.url, underline: true });

  doc
    .fontSize(8)
    .fillColor("grey")
    .text(
      `Dicetak otomatis oleh NewsGeo pada ${new Date().toLocaleString("id-ID")}`,
      50,
      doc.page.height - 50,
      { align: "center" }
    );

  doc.end();
};