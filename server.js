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

// Express uygulamasını oluştur
const app = express();
const port = process.env.PORT || 3001;

// CORS ayarları (cross-origin isteklere izin ver)
app.use(cors());

// JSON body parser
app.use(express.json());

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

// Ana sayfa endpoint'i
app.get("/", (req, res) => {
  res.send("DOCX-PDF Dönüştürme Servisi Çalışıyor");
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
