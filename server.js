const express = require('express');
const multer = require('multer'); // Dosya yüklemelerini işlemek için middleware
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

const app = express();
const port = process.env.PORT || 3000; // Railway genellikle PORT environment değişkenini kullanır

// ... (önceki importlar ve ayarlamalar aynı) ...

// Dosyaları geçici olarak saklamak için multer yapılandırması
// **Limit kaldırıldı:** upload.array('files', 2) yerine upload.array('files')
const upload = multer({ dest: os.tmpdir() });

// POST /merge endpoint'i - **Şimdi kaç dosya gelirse gelsin 'files' alan adıyla hepsini kabul eder**
app.post('/merge', upload.array('files'), async (req, res) => {
    console.log('Merge isteği alındı.');

    const inputFiles = req.files; // Gelen tüm dosyalar burada bir dizi olarak bulunur

    // **Dosya sayısı kontrolü değiştirildi:** Şimdi en az bir dosya kontrolü yapıyoruz
    if (!inputFiles || inputFiles.length === 0) {
        const errorMsg = "Lütfen en az bir adet MP3 dosyası yükleyin.";
        console.error(errorMsg);
        return res.status(400).send(errorMsg);
    }
    // Tam olarak 2 dosya olma zorunluluğu kalktı

    const tmpDir = os.tmpdir();
    const timestamp = Date.now();
    const listFilePath = path.join(tmpDir, `n8n_service_concat_list_${timestamp}.txt`);
    const outputFileName = `merged_audio_${timestamp}.mp3`;
    const outputFilePath = path.join(tmpDir, outputFileName);

    // Temizlenecek tüm geçici dosyalar: Yüklenenler, liste dosyası ve çıktı dosyası
    const filesToClean = inputFiles.map(f => f.path).concat([listFilePath, outputFilePath]);

    try {
        // **FFmpeg concat list dosyasını oluştur - Gelen her dosya için bir satır**
        // inputFiles dizisindeki her dosyanın yolunu alıp 'file ' ile başlayan bir satır oluştur
        const listContent = inputFiles.map(file => `file '${file.path.replace(/\\/g, '/')}'`).join('\n');
        await fs.writeFile(listFilePath, listContent);
        console.log(`Concat list dosyası oluşturuldu: ${listFilePath}`);

        // FFmpeg birleştirme komutu aynı kalır
        const ffmpegCommand = `ffmpeg -y -f concat -safe 0 -i "${listFilePath.replace(/\\/g, '/')}" -c copy "${outputFilePath.replace(/\\/g, '/')}"`;

        console.log(`FFmpeg komutu çalıştırılıyor: ${ffmpegCommand}`);
        const { stdout, stderr } = await execPromise(ffmpegCommand);
        console.log('FFmpeg stdout:', stdout);
        if (stderr) { console.warn('FFmpeg stderr:', stderr); }
        console.log('FFmpeg komutu tamamlandı.');

        const outputBinary = await fs.readFile(outputFilePath);
        console.log(`Birleştirilmiş çıktı dosyası okundu: ${outputFilePath}`);

        // Yanıt başlıklarını ayarla ve dosyayı gönder
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
        res.setHeader('Content-Length', outputBinary.length);
        res.status(200).send(outputBinary);
        console.log('Birleştirilmiş dosya gönderildi.');

    } catch (error) {
        console.error("İşlem sırasında hata oluştu:", error);
        // Hata durumunda detaylı bilgi göndermek yerine jenerik bir mesaj daha iyi olabilir
        res.status(500).send("Dosyalar işlenirken bir hata oluştu.");
    } finally {
        console.log("Geçici dosyalar temizleniyor...");
        // Tüm geçici dosyaları temizle
        for (const file of filesToClean) {
            try {
                await fs.unlink(file);
                console.log(`Temizlendi: ${file}`);
            } catch (e) {
                 console.warn(`Temizlenemedi (muhtemelen yok): ${file}. Hata: ${e.message}`);
            }
        }
    }
});
// Sunucuyu başlat
app.listen(port, () => {
    console.log(`Ses birleştirme servisi ${port} portunda çalışıyor`);
});
