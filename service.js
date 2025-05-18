const { Service } = require("node-windows");
const path = require("path");

// Servis yapılandırması
const svc = new Service({
  name: "DOCX-PDF Dönüştürme Servisi",
  description: "Word şablonlarını PDF'e dönüştüren microservice",
  script: path.join(__dirname, "server.js"),
  nodeOptions: [],
  // env: { // Çevresel değişkenler
  //   PORT: 3001
  // },
  workingDirectory: __dirname,
  allowServiceLogon: true,
});

// Olayları dinle
svc.on("install", () => {
  svc.start();
  console.log("Servis başarıyla kuruldu ve başlatıldı.");
});

svc.on("uninstall", () => {
  console.log("Servis kaldırıldı.");
});

svc.on("error", (err) => {
  console.error("Servis hatası:", err);
});

// Servisi kur
svc.install();
