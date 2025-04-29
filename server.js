// Gerekli Node.js modüllerini ve harici kütüphaneleri içeri aktarın
const express = require('express');
const multer = require('multer'); // multipart/form-data'yı işlemek için Middleware
const fs = require('fs').promises; // Promise tabanlı dosya sistemi işlemleri
const path = require('path'); // Dosya ve dizin yolları ile çalışmak için yardımcı program
const os = require('os'); // İşletim sistemiyle ilgili yardımcı program (tmpdir gibi)
const { exec } = require('child_process'); // Harici komutları çalıştırmak için (ffmpeg gibi)
const util = require('util'); // Node.js dahili API'leri için yardımcı program

// child_process.exec'i async/await ile kullanmak için Promise'e dönüştürün
const execPromise = util.promisify(exec);

// Bir Express uygulama örneği oluşturun
const app = express();
// Sunucunun dinleyeceği portu tanımlayın. PORT ortam değişkenini kullanın (Railway gibi barındırma ortamlarında yaygın), yoksa varsayılan olarak 3000'i kullanın.
const port = process.env.PORT || 3000;

// Multer'ı dosya yüklemeleri için yapılandırın
// dest: Yüklenen dosyaların geçici olarak depolanacağı dizini belirtir. os.tmpdir() sistemin varsayılan geçici dizinini alır.
// .fields([...]): Multer'ı belirli, bitişik olmayan alanları kabul edecek şekilde yapılandırır.
// Dizideki her nesne, beklenen alan adını ve o alan için maksimum dosya sayısını tanımlar.
const upload = multer({ dest: os.tmpdir() }).fields([
    { name: 'file1', maxCount: 1 },
    { name: 'file2', maxCount: 1 },
    { name: 'file3', maxCount: 1 },
    { name: 'file4', maxCount: 1 },
    { name: 'file5', maxCount: 1 },
    { name: 'file6', maxCount: 1 }
]);

// Dosyaları birleştirmek için POST uç noktasını tanımlayın
// Bu uç nokta, sunucunun temel URL'sine göre /merge olacaktır.
// 'upload' middleware'i, async işleyici çalışmadan önce gelen multipart/form-data'yı işleyecektir.
app.post('/merge', upload, async (req, res) => {
    console.log('Merge isteği alındı.');

    // req.body, dosya alanlarının yanı sıra diğer metin alanlarını (Multer fields() kullandığında) içerir
    const outputFilenameFromRequest = req.body.outputFilename; // İstekten gelen çıktı dosya adı alanı
    console.log('İstenen çıktı dosya adı:', outputFilenameFromRequest);

    // req.files, anahtarların alan adları olduğu bir nesneyi (file1, file2 vb.)
    // ve değerlerin o alan için yüklenen dosya nesnelerini içeren diziler olduğu bir nesneyi içerir.
    const uploadedFields = req.files;

    // Gerçekten yüklenmiş ve geçerli olan dosya yollarını depolamak için dizi
    const validPaths = [];
    // Yüklenen dosyaların ayrıntılarını (orijinal adı ve mime türü gibi), geçici yollarına göre eşleyerek depolamak için nesne.
    const uploadedFileDetails = {};

    // Temizleme için TÜM yüklenen geçici dosya yollarını toplamak için dizi.
    const allTempFilePaths = [];

    // Sırayı korumak için beklenen alan adları (file1'den file6'ya) üzerinde döngü yapın
    for (let i = 1; i <= 6; i++) {
        const fieldName = `file${i}`;
        // Alanın gönderilmemesi durumunda isteğe bağlı zincirleme (?.) kullanarak mevcut alanın dosya dizisine erişin.
        const fileArray = uploadedFields?.[fieldName];

        // Dosya dizisinin var olup olmadığını ve en az bir dosya içerip içermediğini kontrol edin (maxCount 1 olduğu için 0 veya 1 eleman içerecektir).
        if (fileArray && fileArray.length > 0) {
            const file = fileArray[0]; // Diziden tek dosya nesnesini alın
            validPaths.push(file.path); // İşlenecek dosya listesine geçici yolu ekleyin (birleştirilecek veya tek olarak döndürülecek)
            allTempFilePaths.push(file.path); // Daha sonra temizlemek için listeye geçici yolu ekleyin
            uploadedFileDetails[file.path] = { // Geçici yola göre eşlenmiş orijinal ayrıntıları depolayın
                originalname: file.originalname,
                mimetype: file.mimetype
            };
            console.log(`Alan '${fieldName}' için dosya yüklendi (Sıra: ${validPaths.length}): ${file.path}, Original: ${file.originalname}`);
        } else {
            console.log(`Alan '${fieldName}' için dosya yüklenmedi.`);
        }
    }

    // Temizlenmesi gereken tüm geçici dosyaların yollarını tutmak için dizi.
    // Yüklenen tüm geçici dosyalarla başlayın.
    let normalizedOutputFilePath = null; // Nihai normalize edilmiş çıktı dosyasının yolunu tutmak için değişken
    const filesToClean = [...allTempFilePaths]; // Yüklenen dosya yolları dizisini kopyalayın

    // Sistemin geçici dizin yolunu alın.
    const tmpDir = os.tmpdir();

    try {
        if (validPaths.length === 0) {
            // Durum 1: Hiçbir dosya başarıyla yüklenmedi
            const errorMsg = "Lütfen işlenecek en az bir adet dosya yükleyin.";
            console.error(errorMsg);
            // 400 Bad Request yanıtı döndürün
            return res.status(400).send(errorMsg);

        } else if (validPaths.length === 1) {
            // Durum 2: Tam olarak bir dosya yüklendi. Normalize ettikten sonra doğrudan döndürün.
            console.log(`Sadece 1 dosya yüklendi, normalize ediliyor: ${validPaths[0]}`);
            const singleFilePath = validPaths[0];
            const timestamp = Date.now();
            // Geçici dizindeki normalize edilmiş çıktı dosyası için yolu tanımlayın
            normalizedOutputFilePath = path.join(tmpDir, `normalized_audio_${timestamp}.mp3`);
            filesToClean.push(normalizedOutputFilePath); // Çıktı dosyasını temizleme listesine ekleyin

            // loudnorm filtresini kullanarak tek dosyayı normalize edin, MP3 olarak çıktı alın
            // İşletim sisteminden bağımsız olarak FFmpeg komutu için posix yolları kullanın
            // loudnorm I değeri -16'ya düşürüldü
            const normalizeCommand = `ffmpeg -y -i "${singleFilePath.replace(/\\/g, '/')}" -filter:a loudnorm=I=-16:TP=-1.0:LRA=11 -c:a libmp3lame -b:a 192k "${normalizedOutputFilePath.replace(/\\/g, '/')}"`; // MP3 için bitrate eklendi
            console.log(`FFmpeg normalize komutu çalıştırılıyor: ${normalizeCommand}`);
            const { stdout, stderr } = await execPromise(normalizeCommand);
            console.log('FFmpeg normalize stdout:', stdout);
            if (stderr) { console.warn('FFmpeg normalize stderr:', stderr); }
            console.log('FFmpeg normalize komutu tamamlandı.');

            // Normalize edilmiş dosyanın ikili içeriğini okuyun
            const singleFileBinary = await fs.readFile(normalizedOutputFilePath);

            // Geçici yolu kullanarak orijinal ayrıntıları (adı, mime türü) alın
            const originalDetails = uploadedFileDetails[singleFilePath] || { originalname: 'single_audio.mp3' };

            // Çıktı dosya adını belirle: İstekten gelen adı kullan veya varsayılanı oluştur
            let finalFilename;
            if (outputFilenameFromRequest && typeof outputFilenameFromRequest === 'string') {
                // İstenen adı kullan, basitçe güvenli hale getir ve .mp3 uzantısını ekle/koru
                finalFilename = outputFilenameFromRequest.replace(/[^a-zA-Z0-9_\-.]/g, '') || 'normalized_audio'; // İzin verilmeyen karakterleri kaldır
                if (!finalFilename.toLowerCase().endsWith('.mp3')) {
                    finalFilename += '.mp3';
                }
            } else {
                // İstenen ad yoksa varsayılanı kullan
                finalFilename = `normalized_${originalDetails.originalname}`;
                // Varsayılan adda da .mp3 yoksa ekle
                if (!finalFilename.toLowerCase().endsWith('.mp3')) {
                    finalFilename += '.mp3';
                }
            }


            // Dosya indirme için HTTP yanıt başlıklarını ayarlayın
            res.setHeader('Content-Type', 'audio/mpeg'); // MP3 olarak yeniden kodladığımız için MP3 olarak ayarlayın
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`); // İndirme için bir dosya adı önerin
            res.setHeader('Content-Length', singleFileBinary.length); // İçerik uzunluğunu ayarlayın

            // Normalize edilmiş dosyanın ikili içeriğini 200 OK durumuyla gönderin
            res.status(200).send(singleFileBinary);
            console.log(`Normalize edilmiş tek dosya gönderildi. Ad: ${finalFilename}`);

        } else {
            // Durum 3: 2 veya daha fazla dosya yüklendi. FFmpeg concat filtresi + sessizlik + normalizasyon ile birleştirmeye devam edin.
            console.log(`${validPaths.length} dosya yüklendi, ilk dosya sonrası 1sn sessizlik eklenip birleştirme ve normalizasyon yapılıyor.`);
            const timestamp = Date.now(); // Benzersiz dosya adları için bir zaman damgası kullanın

            // Geçici dizindeki nihai normalize edilmiş ve birleştirilmiş çıktı dosyası için yolu tanımlayın
            normalizedOutputFilePath = path.join(tmpDir, `normalized_merged_audio_${timestamp}.mp3`);
            filesToClean.push(normalizedOutputFilePath); // Çıktı dosyasını temizleme listesine ekleyin

            // --- Sessizlik içeren concat filtresini kullanarak FFmpeg komutunu oluşturun ---
            // Her dosya için giriş argümanlarını (-i "yol") oluşturun
            const inputArgs = validPaths.map(filePath => `-i "${filePath.replace(/\\/g, '/')}"`).join(' ');

            // 1 saniye sessizlik kaynağı: aevalsrc=0:s=SampleRate:d=Duration
            // Yaygın bir örnekleme hızı kullanılıyor (44100). Loudnorm yeniden örneklemeyi halletmeli.
            const silenceFilterSource = `aevalsrc=0:s=44100:d=1[silence_out];`; // 1s sessizlik üretir, çıktıyı [silence_out] olarak etiketler

            // İlk ses girişinden [0:a] sonra sessizliği içeren concat filtresi için giriş eşlemesini oluşturun
            // Concat'a girişler şunlar olacaktır: [0:a], [silence_out], [1:a], [2:a], ...
            const concatInputPads = [
                '[0:a]', // İlk ses girişi
                '[silence_out]', // aevalsrc'den gelen sessizlik çıktısı
                ...validPaths.slice(1).map((_, index) => `[${index + 1}:a]`) // Kalan ses girişleri ([1:a], [2:a], ...)
            ].join('');

            // Concat filtresine toplam giriş sayısı = ses dosyası sayısı + 1 (sessizlik için)
            const totalConcatInputs = validPaths.length + 1;

            // Concat filtresini oluşturun: N+1 giriş alır, 0 video, 1 ses çıktı verir, sesi [a] olarak etiketler
            const concatFilter = `${concatInputPads}concat=n=${totalConcatInputs}:v=0:a=1[a];`;

            // Loudnorm filtresini oluşturun: [a] girişini alır, loudnorm uygular, çıktıyı [out] olarak etiketler
            // loudnorm I değeri -16'ya düşürüldü
            const loudnormFilter = '[a]loudnorm=I=-16:TP=-1.0:LRA=11[out]'; // Standart loudnorm parametreleri (I değeri değiştirildi)

            // Tüm filtreleri filter_complex dizesinde birleştirin
            const filterComplex = `${silenceFilterSource}${concatFilter}${loudnormFilter}`;

            // Her şeyi nihai FFmpeg komutunda birleştirin
            // -y: Çıktı dosyasının üzerine sormadan yaz
            // -map "[out]": "[out]" olarak etiketlenen çıktı akışını (loudnorm sonucu) çıktı dosyasına eşle
            // -c:a libmp3lame: Sesi libmp3lame kullanarak MP3'e yeniden kodla (güvenilir çıktı formatı)
            // -b:a 192k: Ses bit hızını 192kbps olarak ayarla (MP3 ses için yaygın bir ayar)
            const ffmpegCommand = `ffmpeg -y ${inputArgs} -filter_complex "${filterComplex}" -map "[out]" -c:a libmp3lame -b:a 192k "${normalizedOutputFilePath.replace(/\\/g, '/')}"`;

            console.log(`FFmpeg birleştirme (1sn sessizlik) ve normalizasyon komutu çalıştırılıyor: ${ffmpegCommand}`);

            // FFmpeg komutunu çalıştırın
            const { stdout, stderr } = await execPromise(ffmpegCommand);
            console.log('FFmpeg stdout:', stdout);
            if (stderr) { console.warn('FFmpeg stderr:', stderr); }
            console.log('FFmpeg birleştirme ve normalizasyon komutu tamamlandı.');

            // Nihai çıktı dosyasının ikili içeriğini okuyun
            const outputBinary = await fs.readFile(normalizedOutputFilePath);
            console.log(`Birleştirilmiş ve normalize edilmiş çıktı dosyası okundu: ${normalizedOutputFilePath}`);

            // Çıktı dosya adını belirle: İstekten gelen adı kullan veya varsayılanı oluştur
            let finalFilename;
            if (outputFilenameFromRequest && typeof outputFilenameFromRequest === 'string') {
                // İstenen adı kullan, basitçe güvenli hale getir ve .mp3 uzantısını ekle/koru
                finalFilename = outputFilenameFromRequest.replace(/[^a-zA-Z0-9_\-.]/g, '') || 'merged_audio'; // İzin verilmeyen karakterleri kaldır
                if (!finalFilename.toLowerCase().endsWith('.mp3')) {
                    finalFilename += '.mp3';
                }
            } else {
                // İstenen ad yoksa varsayılanı kullan
                finalFilename = `merged_audio_${timestamp}.mp3`;
            }


            // Nihai çıktı dosyası için indirme adı olarak ayarlanacak dosya adını tanımlayın.
            res.setHeader('Content-Type', 'audio/mpeg'); // Çıktı MP3
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`); // Belirlenen adı kullan
            res.setHeader('Content-Length', outputBinary.length);

            // Nihai dosyanın ikili içeriğini 200 OK durumuyla gönderin
            res.status(200).send(outputBinary);
            console.log(`Birleştirilmiş ve normalize edilmiş dosya gönderildi. Ad: ${finalFilename}`);
        }

    } catch (error) {
        // try bloğunda oluşan herhangi bir hatayı yakalayın (dosya işlemleri, FFmpeg yürütme vb.)
        console.error("İşlem sırasında hata oluştu:", error);
        // Hata mesajıyla birlikte 500 Internal Server Error yanıtı gönderin
        // Üretim ortamında, daha genel bir mesaj göndermek ve belirli hatayı sunucu tarafında kaydetmek isteyebilirsiniz
        res.status(500).send(`Dosyalar işlenirken bir hata oluştu: ${error.message}`);
    } finally {
        // Bu blok, try bloğunun başarılı olup olmamasından veya catch bloğunun yürütülmesinden bağımsız olarak çalışır.
        // Geçici dosyaların temizlenmesini sağlamak için burada kullanılır.
        console.log("Geçici dosyalar temizleniyor...");
        for (const file of filesToClean) {
            try {
                // Dosya yolunun geçerli olup olmadığını kontrol edin (null veya undefined değil)
                if (file) {
                    await fs.unlink(file); // Dosyayı silmeye çalışın
                    console.log(`Temizlendi: ${file}`);
                }
            } catch (e) {
                // Bir dosya için temizleme başarısız olursa bir uyarı kaydet (örneğin, önceki bir hata nedeniyle dosya mevcut olmayabilir)
                console.warn(`Temizlenemedi (muhtemelen yok): ${file}. Hata: ${e.message}`);
            }
        }
        console.log("Geçici dosyalar temizleme tamamlandı.");
    }
});

// Express sunucusunu başlatın ve tanımlanan portta dinlemesini sağlayın.
app.listen(port, () => {
    console.log(`Ses birleştirme servisi ${port} portunda çalışıyor`);
});
