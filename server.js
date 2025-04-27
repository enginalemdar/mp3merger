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

// Dosyaları geçici olarak saklamak için multer yapılandırması
// os.tmpdir() sistemi geçici dizinini kullanır
const upload = multer({ dest: os.tmpdir() });

// POST /merge endpoint'i
// 'files' alan adıyla en fazla 2 dosya bekliyoruz
app.post('/merge', upload.array('files', 2), async (req, res) => {
    console.log('Merge isteği alındı.');

    // Multer yüklenen dosyaları req.files dizisine koyar
    const inputFiles = req.files;

    if (!inputFiles || inputFiles.length !== 2) {
        // Eğer 2 dosya yüklenmediyse hata döndür
        const errorMsg = "Lütfen tam olarak 2 adet MP3 dosyası yükleyin.";
        console.error(errorMsg);
        // Yüklenen geçici dosyaları temizle
        if (inputFiles) {
             for (const file of inputFiles) {
                try { await fs.unlink(file.path); } catch (e) { console.warn(`Temp file cleanup failed: ${file.path}`, e); }
            }
        }
        return res.status(400).send(errorMsg);
    }

    const inputFile1Path = inputFiles[0].path;
    const inputFile2Path = inputFiles[1].path;

    const tmpDir = os.tmpdir();
    const timestamp = Date.now();
    const listFilePath = path.join(tmpDir, `n8n_service_concat_list_${timestamp}.txt`);
    const outputFileName = `merged_audio_${timestamp}.mp3`;
    const outputFilePath = path.join(tmpDir, outputFileName);

    // Temizlenecek tüm geçici dosyalar
    const filesToClean = [inputFile1Path, inputFile2Path, listFilePath, outputFilePath];

    try {
        // FFmpeg concat list dosyasını oluştur
        // Dosya yollarını 'file ' komutu ile listeleyin
        const listContent = `file '${inputFile1Path.replace(/\\/g, '/')}'\nfile '${inputFile2Path.replace(/\\/g, '/')}'`; // Windows yolları için ters eğik çizgileri düzelt
        await fs.writeFile(listFilePath, listContent);
        console.log(`Concat list dosyası oluşturuldu: ${listFilePath}`);

        // FFmpeg birleştirme komutunu oluştur
        // -y: Çıktı varsa üzerine yaz
        // -f concat: concat demuxer kullan
        // -safe 0: Liste dosyasındaki güvenli olmayan yollara izin ver
        // -i "${listFilePath}": Girdi olarak listeyi kullan
        // -c copy: Kodekleri kopyala (hızlı ve kayıpsız)
        const ffmpegCommand = `ffmpeg -y -f concat -safe 0 -i "${listFilePath.replace(/\\/g, '/')}" -c copy "${outputFilePath.replace(/\\/g, '/')}"`;

        console.log(`FFmpeg komutu çalıştırılıyor: ${ffmpegCommand}`);
        // FFmpeg komutunu çalıştırın
        const { stdout, stderr } = await execPromise(ffmpegCommand);

        console.log('FFmpeg stdout:', stdout);
        if (stderr) {
             // FFmpeg genellikle bilgiyi stderr'a yazar, her zaman hata değildir
            console.warn('FFmpeg stderr:', stderr);
        }
        console.log('FFmpeg komutu tamamlandı.');

        // Birleştirilmiş dosyayı oku
        const outputBinary = await fs.readFile(outputFilePath);
        console.log(`Birleştirilmiş çıktı dosyası okundu: ${outputFilePath}`);


        // Yanıt başlıklarını ayarla
        res.setHeader('Content-Type', 'audio/mpeg'); // Veya 'audio/mp3'
        res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`); // Dosya adını belirle
        res.setHeader('Content-Length', outputBinary.length);

        // Birleştirilmiş dosyayı yanıt olarak gönder
        res.status(200).send(outputBinary);
        console.log('Birleştirilmiş dosya gönderildi.');

    } catch (error) {
        console.error("İşlem sırasında hata oluştu:", error);
        res.status(500).send(`Dosyalar işlenirken hata oluştu: ${error.message}`);
    } finally {
        // Tüm geçici dosyaları temizle
        console.log("Geçici dosyalar temizleniyor...");
        for (const file of filesToClean) {
            try {
                await fs.unlink(file);
                console.log(`Temizlendi: ${file}`);
            } catch (e) {
                // Temizleme hatalarını yoksay
                console.warn(`Temizlenemedi (muhtemelen yok): ${file}. Hata: ${e.message}`);
            }
        }
    }
});

// Sunucuyu başlat
app.listen(port, () => {
    console.log(`Ses birleştirme servisi ${port} portunda çalışıyor`);
});
