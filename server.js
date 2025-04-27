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

// Multer yapılandırması: file1'den file6'ya kadar belirli alanları kabul et
// Her alan için maxCount: 1, yani her alanda sadece 1 dosya olabilir
const upload = multer({ dest: os.tmpdir() }).fields([
    { name: 'file1', maxCount: 1 },
    { name: 'file2', maxCount: 1 },
    { name: 'file3', maxCount: 1 },
    { name: 'file4', maxCount: 1 },
    { name: 'file5', maxCount: 1 },
    { name: 'file6', maxCount: 1 }
]);

// POST /merge endpoint'i
app.post('/merge', upload, async (req, res) => { // 'upload' middleware'ini kullanıyoruz
    console.log('Merge isteği alındı.');

    // Yüklenen dosyalar req.files objesinde alan adına göre bulunur: { file1: [...], file2: [...], ... }
    const uploadedFields = req.files;

    // Gerçekten yüklenmiş ve geçerli olan dosyaların yollarını topla
    const validPaths = [];
    const uploadedFileDetails = {}; // Yüklenen dosyaların detaylarını (path, originalname, mimetype) sakla

    // Tüm geçici dosya yollarını temizlik için topla
    const allTempFilePaths = [];

    // file1'den file6'ya kadar her alanı kontrol et
    for (let i = 1; i <= 6; i++) {
        const fieldName = `file${i}`;
        // Optional chaining (?.) kullanarak alanın varlığını ve dosya dizisinin boş olmadığını kontrol et
        const fileArray = uploadedFields?.[fieldName];

        if (fileArray && fileArray.length > 0) {
            const file = fileArray[0]; // Her alanda sadece 1 dosya bekliyoruz
            validPaths.push(file.path); // Birleştirme veya gönderme için geçerli yolu kaydet
            allTempFilePaths.push(file.path); // Temizlik listesine ekle
            uploadedFileDetails[file.path] = { // Detayları daha sonra tek dosya için kullanmak üzere kaydet
                 originalname: file.originalname,
                 mimetype: file.mimetype
            };
            console.log(`Alan '${fieldName}' için dosya yüklendi: ${file.path}`);
        } else {
            console.log(`Alan '${fieldName}' için dosya yüklenmedi.`);
        }
    }

    // Temizlenecek tüm geçici dosyaların nihai listesi (liste ve çıktı dosyaları daha sonra eklenecek)
    let listFilePath = null;
    let outputFilePath = null;
    const filesToClean = [...allTempFilePaths]; // Yüklenen dosyalarla başla


    try {
        if (validPaths.length === 0) {
            // Durum: Hiç dosya yüklenmedi
            const errorMsg = "Lütfen işlenecek en az bir adet dosya yükleyin.";
            console.error(errorMsg);
            return res.status(400).send(errorMsg);

        } else if (validPaths.length === 1) {
            // Durum: Sadece bir dosya yüklendi, birleştirme yapmadan onu döndür
            console.log(`Sadece 1 dosya yüklendi, birleştirme yapılmayacak: ${validPaths[0]}`);
            const singleFilePath = validPaths[0];
            const singleFileBinary = await fs.readFile(singleFilePath);

            // Orijinal dosya adını ve mime tipini yüklenen detaylardan al
            const originalDetails = uploadedFileDetails[singleFilePath] || { originalname: 'single_audio.mp3', mimetype: 'audio/mpeg' };

            // Yanıt başlıklarını ayarla
            res.setHeader('Content-Type', originalDetails.mimetype);
            res.setHeader('Content-Disposition', `attachment; filename="${originalDetails.originalname}"`);
            res.setHeader('Content-Length', singleFileBinary.length);
            res.status(200).send(singleFileBinary);
            console.log('Tek dosya gönderildi.');

        } else {
            // Durum: 2 veya daha fazla dosya yüklendi, birleştirme yap
            console.log(`${validPaths.length} dosya yüklendi, birleştirme yapılıyor.`);
            const timestamp = Date.now();
            listFilePath = path.join(tmpDir, `n8n_service_concat_list_${timestamp}.txt`);
            outputFilePath = path.join(tmpDir, `merged_audio_${timestamp}.mp3`);

            // Birleştirme durumunda liste ve çıktı dosyasını da temizlik listesine ekle
            filesToClean.push(listFilePath, outputFilePath);

            // FFmpeg concat list dosyasını oluştur - Yalnızca GEÇERLİ yolları kullan
            const listContent = validPaths.map(filePath => `file '${filePath.replace(/\\/g, '/')}'`).join('\n');
            await fs.writeFile(listFilePath, listContent);
            console.log(`Concat list dosyası oluşturuldu: ${listFilePath}`);

            // FFmpeg birleştirme komutu
            const ffmpegCommand = `ffmpeg -y -f concat -safe 0 -i "${listFilePath.replace(/\\/g, '/')}" -c copy "${outputFilePath.replace(/\\/g, '/')}"`;
            console.log(`FFmpeg komutu çalıştırılıyor: ${ffmpegCommand}`);

            const { stdout, stderr } = await execPromise(ffmpegCommand);
            console.log('FFmpeg stdout:', stdout);
            if (stderr) { console.warn('FFmpeg stderr:', stderr); }
            console.log('FFmpeg komutu tamamlandı.');

            const outputBinary = await fs.readFile(outputFilePath);
            console.log(`Birleştirilmiş çıktı dosyası okundu: ${outputFilePath}`);

            // Yanıt başlıklarını ayarla ve birleştirilmiş dosyayı gönder
            const mergedFileName = `merged_audio_${timestamp}.mp3`;
            res.setHeader('Content-Type', 'audio/mpeg'); // Birleştirilmiş çıktının MP3 olduğunu varsayıyoruz
            res.setHeader('Content-Disposition', `attachment; filename="${mergedFileName}"`);
            res.setHeader('Content-Length', outputBinary.length);
            res.status(200).send(outputBinary);
            console.log('Birleştirilmiş dosya gönderildi.');
        }

    } catch (error) {
        console.error("İşlem sırasında hata oluştu:", error);
        // Genel bir 500 hatası döndür
        res.status(500).send("Dosyalar işlenirken bir hata oluştu.");
    } finally {
        console.log("Geçici dosyalar temizleniyor...");
        // Toplanan tüm geçici dosyaları temizle
        for (const file of filesToClean) {
            try {
                // Dosyanın null/undefined olup olmadığını kontrol et (liste/çıktı sadece merge durumunda ekleniyor olabilir)
                if (file) {
                    await fs.unlink(file);
                    console.log(`Temizlendi: ${file}`);
                }
            } catch (e) {
                 // Temizleme hatalarını yoksay (dosya zaten silinmiş veya hiç oluşturulmamış olabilir)
                 console.warn(`Temizlenemedi (muhtemelen yok): ${file}. Hata: ${e.message}`);
            }
        }
    }
});

// Sunucuyu başlat
app.listen(port, () => {
    console.log(`Ses birleştirme servisi ${port} portunda çalışıyor`);
});
