const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs-extra");
const path = require("path");
const { promisify } = require("util");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const libre = require("libreoffice-convert");
const libreConvert = promisify(libre.convert);
const cron = require("node-cron");

// Express uygulamasını oluştur
const app = express();
const port = process.env.PORT || 3001;

// CORS ayarları (cross-origin isteklere izin ver)
app.use(cors());

// JSON body parser
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

// Dosya yükleme için multer ayarları
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage: storage });

let lastConvertedPdf = {
  path: null,
  filename: null,
};
const convertedPdfs = new Map();
function generatePdfId() {
  return Date.now() + "-" + Math.random().toString(36).substring(2, 15);
}

function cleanupOldFiles() {
  console.log("clenup başladı");
  const outputDir = path.join(__dirname, "outputs");
  fs.readdir(outputDir, (err, files) => {
    if (err) {
      console.error("Klasör okunamadı:", err);
      return;
    }

    const now = Date.now();
    files.forEach((file) => {
      // .gitkeep dosyasını atla

      if (file === ".gitkeep") return;

      const filePath = path.join(outputDir, file);
      fs.stat(filePath, (err, stats) => {
        console.log("file path okundu");
        if (err) {
          console.error(`Dosya durumu okunamadı: ${file}`, err);
          return;
        }

        // 1 saatten eski dosyaları temizle (3600000 ms)
        const fileAge = now - stats.mtimeMs;
        if (fileAge > 1000000) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(`Dosya silinemedi: ${file}`, err);
            } else {
              console.log(`Eski dosya temizlendi: ${file}`);
            }
          });
        }
      });
    });
  });
}

// Her saat başı temizlik yap
setInterval(cleanupOldFiles, 1000000); // 1 saat

// Başlangıçta da bir temizlik yap
cleanupOldFiles();

// Ana sayfa endpoint'i
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.post("/convert-word2pdf", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Dosya yüklenemedi" });
    }

    const inputPath = req.file.path;
    const outputFilename = req.file.originalname.replace(".docx", ".pdf");
    const outputPath = path.join("outputs", `${Date.now()}.pdf`);
    const pdfId = generatePdfId();

    console.log("Dönüştürülecek dosya: ", inputPath);

    // DOCX buffer'ını oku
    const docxBuffer = fs.readFileSync(inputPath);

    // PDF'e dönüştür
    const pdfBuffer = await libreConvert(docxBuffer, ".pdf", undefined);

    // Dosyayı kaydet
    fs.writeFileSync(outputPath, pdfBuffer);

    console.log("PDF oluşturuldu: ", outputPath);

    // PDF bilgilerini sakla
    convertedPdfs.set(pdfId, {
      path: outputPath,
      filename: outputFilename,
      createdAt: Date.now(),
    });

    // Otomatik temizleme için 15 dakika sonra zamanlayıcı ayarla
    setTimeout(() => {
      if (convertedPdfs.has(pdfId)) {
        const pdfInfo = convertedPdfs.get(pdfId);
        try {
          if (fs.existsSync(pdfInfo.path)) {
            fs.unlinkSync(pdfInfo.path);
          }
          convertedPdfs.delete(pdfId);
          console.log(`PDF ${pdfId} otomatik olarak temizlendi`);
        } catch (err) {
          console.error(`PDF ${pdfId} temizleme hatası:`, err);
        }
      }
    }, 15 * 60 * 1000); // 15 dakika

    // Dosya yolunu ve adını döndür
    res.json({
      success: true,
      message: "PDF oluşturuldu",
      downloadUrl: `/download-pdf/${pdfId}`,
      filename: outputFilename,
      pdfId: pdfId,
    });

    // Giriş dosyasını temizle
    setTimeout(() => {
      try {
        fs.unlinkSync(inputPath);
        console.log("Giriş dosyası temizlendi");
      } catch (err) {
        console.error("Dosya temizleme hatası:", err);
      }
    }, 1000);
  } catch (error) {
    console.error("Dönüştürme hatası:", error);
    res.status(500).json({
      error: "Dönüştürme sırasında bir hata oluştu: " + error.message,
    });
  }
});

// Belirli bir PDF'i indirme endpoint'i
app.get("/download-pdf/:pdfId", (req, res) => {
  const pdfId = req.params.pdfId;

  if (!convertedPdfs.has(pdfId)) {
    return res
      .status(404)
      .send("PDF bulunamadı veya süresi doldu. Lütfen yeniden dönüştürün.");
  }

  const pdfInfo = convertedPdfs.get(pdfId);
  console.log("PDF indiriliyor:", pdfInfo.path);

  res.download(pdfInfo.path, pdfInfo.filename, (err) => {
    if (err) {
      console.error("İndirme hatası:", err);
    }
    // İndirme tamamlandığında hemen silmiyoruz
    // Böylece kullanıcı tekrar indirmek isterse erişebilir
  });
});

// Eski endpoint'i geri uyumluluk için tut
app.get("/download-last-pdf", (req, res) => {
  // Son eklenen PDF'i bulmaya çalış
  if (convertedPdfs.size === 0) {
    return res.status(404).send("Henüz dönüştürülmüş PDF bulunamadı.");
  }

  // En son eklenen PDF'i al
  let lastPdfId = null;
  let lastTimestamp = 0;

  for (const [id, info] of convertedPdfs.entries()) {
    if (info.createdAt > lastTimestamp) {
      lastTimestamp = info.createdAt;
      lastPdfId = id;
    }
  }

  if (!lastPdfId) {
    return res.status(404).send("PDF bulunamadı.");
  }

  // Yeni endpoint'e yönlendir
  res.redirect(`/download-pdf/${lastPdfId}`);
});
// Template kullanarak PDF oluşturma endpoint'i
app.post("/generate-pdf", upload.single("template"), async (req, res) => {
  try {
    // Şablon dosyası ve data kontrol
    if (!req.file) {
      return res.status(400).send("Şablon dosyası yüklenemedi");
    }

    // JSON verisi gövdeden veya form-data'dan alınabilir
    let data;
    try {
      data = req.body.data ? JSON.parse(req.body.data) : req.body;
    } catch (err) {
      return res.status(400).send("Geçersiz JSON verisi");
    }

    const templatePath = req.file.path;

    console.log("Şablon dosyası: ", templatePath);
    console.log("Veriler: ", JSON.stringify(data, null, 2));

    // Şablonu oku
    const templateContent = fs.readFileSync(templatePath);
    const zip = new PizZip(templateContent);

    // Docxtemplater ile doldur
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: {
        start: "{{",
        end: "}}",
      },
    });

    // Düzleştirilmiş veri yapısı oluştur (iç içe veriler için)
    const flatData = {};

    // Basit verileri ekle
    Object.keys(data).forEach((key) => {
      if (typeof data[key] !== "object" || data[key] === null) {
        flatData[key] = data[key];
      }
    });

    // İç içe verileri düzleştir
    Object.keys(data).forEach((key) => {
      if (typeof data[key] === "object" && data[key] !== null) {
        Object.keys(data[key]).forEach((subKey) => {
          flatData[`${key}_${subKey}`] = data[key][subKey];
        });
      }
    });

    // Ana veri ve düzleştirilmiş veriyi birleştir
    const combinedData = { ...data, ...flatData };

    // Veriyi şablona uygula
    doc.setData(combinedData);

    try {
      // Belgeyi render et
      doc.render();
    } catch (error) {
      console.error("Render hatası:", error);
      if (error.properties && error.properties.errors) {
        const errorMessages = error.properties.errors
          .map((e) => `${e.properties?.explanation || e.message}`)
          .join(", ");

        return res.status(400).send(`Şablon hatası: ${errorMessages}`);
      }
      throw error;
    }

    // Doldurulmuş DOCX dosyasını oluştur
    const filledDocx = doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    // Geçici dosya yolları
    const filledDocxPath = path.join("uploads", `filled_${Date.now()}.docx`);
    const outputPdfPath = path.join("outputs", `output_${Date.now()}.pdf`);

    // Doldurulmuş DOCX'i kaydet
    fs.writeFileSync(filledDocxPath, filledDocx);

    console.log("Doldurulmuş DOCX oluşturuldu: ", filledDocxPath);

    try {
      // LibreOffice ile PDF'e dönüştür
      const pdfBuffer = await libreConvert(filledDocx, ".pdf", undefined);

      // PDF'i kaydet
      fs.writeFileSync(outputPdfPath, pdfBuffer);

      console.log("PDF oluşturuldu: ", outputPdfPath);

      // PDF'i kullanıcıya gönder
      res.download(outputPdfPath, "document.pdf", () => {
        // Geçici dosyaları temizle
        setTimeout(() => {
          try {
            fs.unlinkSync(templatePath);
            fs.unlinkSync(filledDocxPath);
            fs.unlinkSync(outputPdfPath);
            console.log("Geçici dosyalar temizlendi");
          } catch (err) {
            console.error("Dosya temizleme hatası:", err);
          }
        }, 1000);
      });
    } catch (err) {
      console.error("LibreOffice dönüştürme hatası:", err);
      res.status(500).send("PDF dönüştürme hatası: " + err.message);
    }
  } catch (error) {
    console.error("Genel hata:", error);
    res.status(500).send("Bir hata oluştu: " + error.message);
  }
});

// Basit PDF dönüştürme endpoint'i
app.post("/convert-pdf", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("Dosya yüklenemedi");
    }

    const inputPath = req.file.path;
    const outputPath = path.join("outputs", `${Date.now()}.pdf`);

    console.log("Dönüştürülecek dosya: ", inputPath);

    // DOCX buffer'ını oku
    const docxBuffer = fs.readFileSync(inputPath);

    // PDF'e dönüştür
    const pdfBuffer = await libreConvert(docxBuffer, ".pdf", undefined);

    // Dosyayı kaydet
    fs.writeFileSync(outputPath, pdfBuffer);

    console.log("PDF oluşturuldu: ", outputPath);

    // PDF'i indir
    res.download(outputPath, "document.pdf", () => {
      // Geçici dosyaları temizle
      setTimeout(() => {
        try {
          fs.unlinkSync(inputPath);
          fs.unlinkSync(outputPath);
          console.log("Geçici dosyalar temizlendi");
        } catch (err) {
          console.error("Dosya temizleme hatası:", err);
        }
      }, 1000);
    });
  } catch (error) {
    console.error("Dönüştürme hatası:", error);
    res
      .status(500)
      .send("Dönüştürme sırasında bir hata oluştu: " + error.message);
  }
});

// Sunucuyu başlat
app.listen(port, () => {
  console.log(`PDF servisi ${port} portunda çalışıyor`);
  console.log(`http://localhost:${port}`);
});
