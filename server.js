// Gerekli Node.js modüllerini ve harici kütüphaneleri içeri aktarın
const express = require('express');
const multer = require('multer'); // multipart/form-data'yı işlemek için Middleware
const fs = require('fs').promises; // Promise tabanlı dosya sistemi işlemleri
const path = require('path'); // Dosya ve dizin yolları ile çalışmak için yardımcı program
const os = require('os'); // İşletim sistemiyle ilgili yardımcı program (tmpdir gibi)
const { exec } = require('child_process'); // Harici komutları çalıştırmak için (ffmpeg gibi)
const util = require('util'); // Node.js dahili APIleri için yardımcı program
// p-queue kütüphanesini içe aktarın. CommonJS require kullanılırken .default eklenmelidir.
const PQueue = require('p-queue').default; // İstekleri sıraya almak için kütüphane - HATA DÜZELTMESİ BURADA (.default eklendi)


// child_process.exec'i async/await ile kullanmak için Promise'e dönüştürün
const execPromise = util.promisify(exec);

// Bir Express uygulama örneği oluşturun
const app = express();
// Sunucunun dinleyeceği portu tanımlayın. PORT ortam değişkenini kullanın (Railway gibi barındırma ortamlarında yaygın), yoksa varsayılan olarak 3000'i kullanın.
const port = process.env.PORT || 3000;

// Multerı dosya yüklemeleri için yapılandırın
// dest: Yüklenen dosyaların geçici olarak depolanacağı dizini belirtir. os.tmpdir() sistemin varsayılan geçici dizinini alır.
// .fields([...]): Multerı belirli, bitişik olmayan alanları kabul edecek şekilde yapılandırır.
// Her nesne, beklenen alan adını ve o alan için maksimum dosya sayısını tanımlar.
const upload = multer({ dest: os.tmpdir() }).fields([
    { name: 'file1', maxCount: 1 },
    { name: 'file2', maxCount: 1 },
    { name: 'file3', maxCount: 1 },
    { name: 'file4', maxCount: 1 },
    { name: 'file5', maxCount: 1 },
    { name: 'file6', maxCount: 1 }
]);

// *** Performans İçin CPU Sayısını Kullanma ve Kuyruk Yapılandırması ***
// Sistemdeki mevcut mantıksal CPU çekirdek sayısını alın.
const numCPUs = os.cpus().length;
console.log(`Sistemde ${numCPUs} CPU çekirdeği algılandı.`);

// Maksimum kaç ses işleminin (FFmpeg çalıştırma) aynı anda çalışacağını belirleyin.
// Bunu algılanan CPU çekirdek sayısına ayarlamak genellikle iyi bir başlangıç noktasıdır.
const processingQueue = new PQueue({ concurrency: numCPUs }); // Eşzamanlılık limiti CPU sayısına ayarlandı
console.log(`Ses işleme kuyruğu oluşturuldu, maksimum ${processingQueue.concurrency} işlem aynı anda çalışacak.`);


// *** Ses işleme mantığının tamamını içeren asenkron fonksiyon ***
// Bu fonksiyon, bir kuyruk görevi olarak çalışacak ve kendisine verilen Express yanıt nesnesini (res) kullanarak yanıtı gönderecek.
// req ve res nesneleri doğrudan bu fonksiyona aktarılır.
async function processAudioTask(req, res) {
    // Her istek için benzersiz bir zaman damgası oluşturun, logları takip etmek için faydalı olur.
    const timestamp = Date.now();
    console.log(`[${timestamp}] İşlem kuyruktan alındı, başlıyor.`);

    // İstekten gelen parametreleri al (Multerdan sonra req.body dolu gelir)
    const outputFilenameFromRequest = req.body.outputFilename;
    // silenceDuration ve targetLufs parametrelerini al, geçerli sayı değilse varsayılanı kullan
    const silenceDuration = parseFloat(req.body.silenceDuration) || 1; // BURADA DOĞRU YAZILMIŞ
    const targetLufs = parseFloat(req.body.targetLufs) || -16;

    console.log(`[${timestamp}] İstek Parametreleri: Çıktı Adı: ${outputFilenameFromRequest || '(Belirtilmedi)'}, Sessizlik: ${silenceDuration}sn, Hedef LUFS: ${targetLufs}`);


    const uploadedFields = req.files; // Multerın işlediği dosya alanları
    const validPaths = []; // İşlenecek geçerli dosya yollarının sıralı listesi (Multer geçici yolları)
    const uploadedFileDetails = {}; // Orijinal dosya bilgilerini saklar (geçici yola göre eşlenmiş)
    const allTempFilePaths = []; // Temizlik için tüm geçici yollar (Multerın oluşturduğu)

    // Multerın oluşturduğu geçici dosya yollarını topla ve sıralamayı koru
    for (let i = 1; i <= 6; i++) {
        const fieldName = `file${i}`;
        // Alanın gönderilmemesi durumunda isteğe bağlı zincirleme (?.) kullanarak mevcut alanın dosya dizisine erişin.
        const fileArray = uploadedFields?.[fieldName];

        if (fileArray && fileArray.length > 0) {
            const file = fileArray[0]; // maxCount 1 olduğu için dizi 1 elemanlı olacaktır
            validPaths.push(file.path); // İşlenecek dosya listesine geçici yolu ekle
            allTempFilePaths.push(file.path); // Temizlik için listeye ekle (finally bloğunda silinecek)
            uploadedFileDetails[file.path] = { // Orijinal bilgileri sakla (metadata veya indirme adı için)
                originalname: file.originalname,
                mimetype: file.mimetype
            };
             console.log(`[${timestamp}] Alan '${fieldName}' için dosya yüklendi (Sıra: ${validPaths.length}): ${file.path}, Original: ${file.originalname}`);
        } else {
             console.log(`[${timestamp}] Alan '${fieldName}' için dosya yüklenmedi.`);
        }
    }

    let normalizedOutputFilePath = null; // FFmpeg'in oluşturacağı çıktı dosyasının yolu
    // Temizlik listesi: Başlangıçta sadece Multerın oluşturduğu geçici dosyalar var.
    // İşlem sırasında FFmpeg'in oluşturacağı çıktı dosyası da bu listeye eklenecek.
    const filesToClean = [...allTempFilePaths];
    const tmpDir = os.tmpdir(); // Sistem geçici dizini


    try {
        if (validPaths.length === 0) {
            const errorMsg = "Lütfen işlenecek en az bir adet dosya yükleyin.";
            console.error(`[${timestamp}] Hata: ${errorMsg}`);
            // Hata yanıtı gönder. Yanıt daha önce gönderilmemişse emin ol.
            if (!res.headersSent) {
                return res.status(400).send(errorMsg);
            } else {
                console.warn(`[${timestamp}] Hata oluştu ancak yanıt zaten gönderilmişti. İstek ID: ${timestamp}`);
                return; // Yanıt gönderildiği için fonksiyondan çık
            }


        } else if (validPaths.length === 1) {
            // Durum 1: Sadece 1 dosya yüklendi. Birleştirme yok, sadece normalize et.
            console.log(`[${timestamp}] Sadece 1 dosya yüklendi, normalize ediliyor: ${validPaths[0]}`);
            const singleFilePath = validPaths[0];
            // Normalize edilmiş çıktı dosyasının yolunu belirle
            normalizedOutputFilePath = path.join(tmpDir, `normalized_audio_${timestamp}.mp3`);
            filesToClean.push(normalizedOutputFilePath); // Oluşacak çıktı dosyasını temizlik listesine ekle

            // FFmpeg komutu: Tek dosyayı loudnorm filtresi ile normalize et ve MP3'e kodla
            // -y: çıktı dosyasının üzerine sormadan yaz
            // -i: girdi dosyası
            // -filter:a: ses filtresi (loudnorm)
            // -c:a: ses kodeği (libmp3lame)
            // -b:a: ses bit hızı
            // -preset ultrafast: En yüksek kodlama hızı için (kaliteden ödün verebilir) - çıktıdan önce olmalı
            // -threads numCPUs: Mevcut tüm CPU çekirdeklerini kullan - çıktıdan önce olmalı
            const normalizeCommand = `ffmpeg -y -i "${singleFilePath.replace(/\\/g, '/')}" -filter:a loudnorm=I=${targetLufs}:TP=-1.0:LRA=11 -c:a libmp3lame -b:a 192k -preset ultrafast -threads ${numCPUs} "${normalizedOutputFilePath.replace(/\\/g, '/')}"`;
            console.log(`[${timestamp}] FFmpeg normalize komutu çalıştırılıyor: ${normalizeCommand}`);
            const { stdout, stderr } = await execPromise(normalizeCommand); // FFmpeg komutunu çalıştır ve bekle
            console.log(`[${timestamp}] FFmpeg normalize stdout:`, stdout);
            if (stderr) { console.warn(`[${timestamp}] FFmpeg normalize stderr:`, stderr); }
            console.log(`[${timestamp}] FFmpeg normalize komutu tamamlandı.`);

            // Oluşan normalized çıktı dosyasını oku
            const singleFileBinary = await fs.readFile(normalizedOutputFilePath);
            const originalDetails = uploadedFileDetails[singleFilePath] || { originalname: 'single_audio.mp3' };

            // İndirme için çıktı dosya adını belirle: İstekten gelen adı kullan veya varsayılanı oluştur
            let finalFilename;
            if (outputFilenameFromRequest && typeof outputFilenameFromRequest === 'string' && outputFilenameFromRequest.trim().length > 0) {
                 // İstekten gelen adı kullan, basitçe güvenli hale getir ve .mp3 uzantısını ekle/koru
                finalFilename = outputFilenameFromRequest.trim().replace(/[^a-zA-Z0-9_\-.]/g, '') || 'normalized_audio'; // İzin verilmeyen karakterleri kaldır, boş kalırsa varsayılan
                 if (!finalFilename.toLowerCase().endsWith('.mp3')) {
                    finalFilename += '.mp3';
                }
            } else {
                 // İstenen ad yoksa varsayılanı kullan (orijinal ad + normalized_)
                finalFilename = `normalized_${originalDetails.originalname}`;
                 // Varsayılan adda da .mp3 yoksa ekle
                if (!finalFilename.toLowerCase().endsWith('.mp3')) {
                    finalFilename += '.mp3';
                }
            }

            // HTTP başlıklarını ayarla ve normalize edilmiş dosyayı yanıt olarak gönder
            res.setHeader('Content-Type', 'audio/mpeg'); // Çıktı MP3
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`); // İndirme adı
            res.setHeader('Content-Length', singleFileBinary.length);

            res.status(200).send(singleFileBinary); // Dosya içeriğini gönder
            console.log(`[${timestamp}] Normalize edilmiş tek dosya gönderildi. Ad: ${finalFilename}`);

        } else {
            // Durum 2: 2 veya daha fazla dosya yüklendi (Intro + TTS'ler). Birleştirme ve normalizasyon yap.
            console.log(`[${timestamp}] ${validPaths.length} dosya yüklendi, birleştirme ve normalizasyon yapılıyor.`);

            // Birleştirilmiş/normalize edilmiş çıktı dosyasının yolunu belirle
            normalizedOutputFilePath = path.join(tmpDir, `normalized_merged_audio_${timestamp}.mp3`);
            filesToClean.push(normalizedOutputFilePath); // Oluşacak çıktı dosyasını temizlik listesine ekle

            // --- FFmpeg komutunu oluşturun: Intro -> TTS1 -> Silence -> TTS2 -> Silence ... ---
            // Her dosya için giriş argümanlarını (-i "yol") oluşturun
            const inputArgs = validPaths.map(filePath => `-i "${filePath.replace(/\\/g, '/')}"`).join(' ');

            // *** FFmpeg filter_complex dizesini oluştur ***
            let filterComplex;
            let concatInputPads = ''; // Concat filtresine girdi olarak verilecek pad'lerin listesi
            let totalConcatInputs; // Concat'ın 'n' parametresi

            // Hedef örnekleme hızını 44100 Hz yapıyoruz. Kanal düzeni için apan'ı kaldırıyoruz, concat'ın denemesini bekliyoruz.
            const targetSampleRate = 44100;
            // const targetChannelLayout = 'stereo'; // Bu artık kullanılmıyor

            // 1. Tüm girdi ses akışlarını hedef örnekleme hızına dönüştüren filtreleri tanımla
            // Her girdi [i:a] -> aresample -> [in_i]
            // *** apan=c=stereo kaldırıldı *** -- Bu satırda hala apan var! Hata burada!
            const resampleFilters = validPaths.map((_, i) => `[${i}:a]aresample=${targetSampleRate},apan=c=${targetChannelLayout}[in${i}]`).join(';');

            // Sessizlik akışını tanımla (hedef örnekleme hızında, varsayılan mono)
            // aevalsrc -> [silence]
            // *** apan=c=stereo kaldırıldı, etiket [silence] olarak değiştirildi karışmaması için *** -- Bu satırda da apan var! Hata burada!
            const silenceFilterSource = `aevalsrc=0:s=${targetSampleRate}:d=${silenceDuration}[silence_raw];[silence_raw]apan=c=${targetChannelLayout}[silence_final];`;


            if (validPaths.length === 2) {
                 // Sadece 2 dosya (Intro + TTS1): Sessizliğe gerek yok, sadece resample edilmiş girdileri birleştir ve normalize et.
                 // Concat'a sadece resample edilmiş girdi pad'leri ([in0], [in1]) gider.
                 concatInputPads = '[in0][in1]';
                 totalConcatInputs = 2; // Concat'ın 2 girişi var

                 const concatFilter = `${concatInputPads}concat=n=${totalConcatInputs}:v=0:a=1[a];`; // Concact filtresi
                 const loudnormFilter = `[a]loudnorm=I=${targetLufs}:TP=-1.0:LRA=11[out]`; // Loudnorm filtresi
                 // filter_complex: Tüm resample filtreleri -> concat -> loudnorm
                 filterComplex = `${resampleFilters};${concatFilter}${loudnormFilter}`;

                 console.log(`[${timestamp}] Filter Complex (2 dosya, resampled, sessizliksiz): ${filterComplex}`);

            } else { // validPaths.length > 2 (Intro + TTS1 + TTS2 + ...): Sessizlik gerekli
                 // Concat girişleri: [in0][in1] (resample edilmiş Intro + TTS1)
                 // ardından kalan resample edilmiş TTSler arasına [silence_final][in_i] ekle
                 concatInputPads = '[in0][in1]';
                 for (let i = 2; i < validPaths.length; i++) {
                     concatInputPads += `[silence_final][in${i}]`; // Sessizlik akışı -> Sonraki resample edilmiş TTS akışı (index i)
                 }

                 // Concat filtresine toplam giriş sayısı = Resample edilmiş audio akış sayısı + Eklenen sessizlik akışı sayısı
                 // Eklenen sessizlik akışı sayısı = validPaths.length >= 2 ise (validPaths.length - 2)
                 const numberOfSilenceInputs = validPaths.length - 2;
                 totalConcatInputs = validPaths.length + numberOfSilenceInputs; // Toplam giriş sayısı = Resample edilmiş audio akışları + Sessizlik akışları

                 const concatFilter = `${concatInputPads}concat=n=${totalConcatInputs}:v=0:a=1[a];`; // Concact filtresi
                 const loudnormFilter = `[a]loudnorm=I=${targetLufs}:TP=-1.0:LRA=11[out]`; // Loudnorm filtresi
                 // filter_complex: Sessizlik kaynağı ve dönüşümü -> Tüm resample filtreleri -> concat -> loudnorm
                 filterComplex = `${silenceFilterSource}${resampleFilters};${concatFilter}${loudnormFilter}`; // Semicolon bağımsız zincirleri ayırır

                 console.log(`[${timestamp}] Filter Complex (>2 dosya, resampled, sessizlik dahil): ${filterComplex}`);
            }

            // --- Nihai FFmpeg komutunu oluştur ---
            // -y: çıktı dosyasının üzerine sormadan yaz
            // -i [girdiler]: tüm girdi dosyaları
            // -filter_complex: yukarıda oluşturulan dizeyi kullan
            // -map "[out]": filter_complex çıktısını (`[out]` olarak etiketlenen) çıktı dosyasına eşle
            // -c:a libmp3lame: ses kodeği (MP3)
            // -b:a 192k: ses bit hızı
            // -preset ultrafast: En yüksek kodlama hızı için (kaliteden ödün verebilir) - çıktıdan önce olmalı
            // -threads numCPUs: Mevcut tüm CPU çekirdeklerini kullan - çıktıdan önce olmalı
            const ffmpegCommand = `ffmpeg -y ${inputArgs} -filter_complex "${filterComplex}" -map "[out]" -c:a libmp3lame -b:a 192k -preset ultrafast -threads ${numCPUs} "${normalizedOutputFilePath.replace(/\\/g, '/')}"`;

            console.log(`[${timestamp}] FFmpeg komutu çalıştırılıyor: ${ffmpegCommand}`);

            // FFmpeg komutunu çalıştır ve bekle
            const { stdout, stderr } = await execPromise(ffmpegCommand);
            console.log(`[${timestamp}] FFmpeg stdout:`, stdout);
            if (stderr) { console.warn(`[${timestamp}] FFmpeg stderr:`, stderr); }
            console.log(`[${timestamp}] FFmpeg birleştirme ve normalizasyon komutu tamamlandı.`);

            // Oluşan birleştirilmiş/normalize edilmiş çıktı dosyasını oku
            const outputBinary = await fs.readFile(normalizedOutputFilePath);
            console.log(`[${timestamp}] Birleştirilmiş ve normalize edilmiş çıktı dosyası okundu: ${normalizedOutputFilePath}`);

            // İndirme için çıktı dosya adını belirle: İstekten gelen adı kullan veya varsayılanı oluştur
            let finalFilename;
            if (outputFilenameFromRequest && typeof outputFilenameFromRequest === 'string' && outputFilenameFromRequest.trim().length > 0) {
                 // İstekten gelen adı kullan, basitçe güvenli hale getir ve .mp3 uzantısını ekle/koru
                finalFilename = outputFilenameFromRequest.trim().replace(/[^a-zA-Z0-9_\-.]/g, '') || 'merged_audio'; // İzin verilmeyen karakterleri kaldır, boş kalırsa varsayılan
                 if (!finalFilename.toLowerCase().endsWith('.mp3')) {
                    finalFilename += '.mp3';
                }
            } else {
                // İstenen ad yoksa varsayılanı kullan (merged_audio_timestamp)
                finalFilename = `merged_audio_${timestamp}.mp3`;
            }

            // HTTP başlıklarını ayarla ve birleştirilmiş/normalize edilmiş dosyayı yanıt olarak gönder
            res.setHeader('Content-Type', 'audio/mpeg'); // Çıktı MP3
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`); // İndirme adı
            res.setHeader('Content-Length', outputBinary.length);

            res.status(200).send(outputBinary); // Dosya içeriğini gönder
            console.log(`[${timestamp}] Birleştirilmiş ve normalize edilmiş dosya gönderildi. Ad: ${finalFilename}`);
        }

    } catch (error) {
        // *** Hata Yakalama ve Yanıt Gönderme ***
        // İşlem sırasında bir hata oluşursa burası çalışır (FFmpeg hatası, dosya okuma hatası vb.).
        console.error(`[${timestamp}] İşlem sırasında hata oluştu:`, error);
        // Yanıt daha önce gönderilmemişse (örneğin, bir hata yanıtı veya başarılı yanıt zaten gönderilmişse), hata yanıtı gönder.
        // Bu kontrol, aynı isteğe birden fazla kez yanıt gönderilmesini önler.
        if (!res.headersSent) {
             // Kullanıcıya genel bir hata mesajı gönder. Detayları loglamak daha güvenlidir.
             // error objesi FFmpeg stderr çıktısını içerebilir (error.stderr)
             res.status(500).send(`Dosyalar işlenirken bir hata oluştu. Lütfen yüklediğiniz dosyaları kontrol edin veya farklı ayarlar deneyin.`);
             // Debug için hatanın detayını göndermek isterseniz (dikkatli kullanın!):
             // FFmpeg çıktısını görmek hatanın sebebini anlamada çok yardımcı olur.
             // res.status(500).send(`Dosyalar işlenirken bir hata oluştu: ${error.message}. FFmpeg stderr: ${error.stderr}`);
        } else {
             console.warn(`[${timestamp}] İşlem hatası oluştu ancak yanıt zaten gönderilmişti. İstek ID: ${timestamp}`);
        }


    } finally {
        // *** Geçici Dosyaları Temizleme ***
        // try veya catch bloğu tamamlandıktan sonra (işlem başarılı veya başarısız olsa da) burası her zaman çalışır.
        console.log(`[${timestamp}] Geçici dosyalar temizleniyor...`);
        // filesToClean listesindeki her dosya için silme işlemi yap
        for (const file of filesToClean) {
            try {
                // Dosya yolunun geçerli olup olmadığını kontrol edin.
                if (file) {
                    // Dosyayı silmeye çalış. await kullanıyoruz.
                    // Silme işlemi dosya mevcut değilse veya izin yoksa hata fırlatacaktır.
                    await fs.unlink(file);
                    console.log(`[${timestamp}] Temizlendi: ${file}`);
                } else {
                     console.log(`[${timestamp}] Tanımsız geçici dosya yolu atlandı.`);
                }
            } catch (e) {
                // Silme işlemi hata verirse (dosya yoksa, izin yoksa vb.) logla ama devam et.
                // Dosyanın zaten silinmiş olması ('ENOENT' hatası) yaygın bir durumdur (örn: önceki bir hata dosyanın oluşturulmasını engellemiş olabilir).
                if (e.code === 'ENOENT') { // 'ENOENT' hatası dosyanın mevcut olmadığı anlamına gelir
                     console.log(`[${timestamp}] Geçici dosya zaten yoktu veya silinmişti: ${file}`);
                } else {
                    console.warn(`[${timestamp}] Geçici dosya temizlenemedi (perm hatası veya başka sebep): ${file}. Hata: ${e.message}`);
                }
            }
        }
        console.log(`[${timestamp}] Geçici dosyalar temizleme tamamlandı.`);
        console.log(`[${timestamp}] İşlem tamamlandı. İstek ID: ${timestamp}`);
    }
}


// *** Birleştirme POST Uç Noktası ***
// Bu handler sadece gelen isteği kabul eder, Multer ile dosyaları/alanları işler
// ve asıl CPU/I/O yoğun işleme görevini kuyruğa ekler.
// Asıl işleme ve yanıt gönderme `processAudioTask` içinde gerçekleşir.
app.post('/merge', upload, async (req, res) => {
    console.log('Merge isteği alındı, kuyruğa ekleniyor.');

    // İstek işleme görevini (processAudioTask fonksiyonunu) bir lambda/arrow fonksiyonu içine sarmalayarak kuyruğa ekleyin.
    // Bu şekilde `processAudioTask` fonksiyonu hemen çalıştırılmaz, sadece kuyruğa eklenir.
    // Kuyruk, `concurrency` limitine uygun olduğunda bu sarmalanmış fonksiyonu çalıştıracaktır.
    // `await processingQueue.add(...)` satırı, bu Express handler'ının, görevin kuyrukta işlenip **tamamlanmasını** beklemesini sağlar.
    // Eğer beklemek istemiyorsanız (örneğin "işleminiz kuyruğa eklendi, daha sonra kontrol edin" gibi bir yanıt hemen göndermek isterseniz), `await` kullanmazsınız ve buradan hemen bir yanıt dönersiniz.
    // Ancak şu anki senaryoda, işlem bitince doğrudan dosyayı indirtmek istediğimiz için handler'ın beklemesi gerekiyor.
    try {
        // Görevi kuyruğa ekle ve tamamlanmasını bekle
        await processingQueue.add(() => processAudioTask(req, res));
        // Görev (processAudioTask) tamamlandığında zaten yanıtı (res.send vb.) göndermiş olacaktır.
        // Bu satıra ulaşıldığında yanıt zaten gönderilmiş demektir.
        console.log('Merge isteği kuyrukta işlendi ve yanıt gönderildi.');

    } catch (error) {
        // Bu catch blokları genellikle kuyrukla ilgili nadir hataları veya görevin eklenmesi sırasında oluşabilecek hataları yakalar.
        // İşlem (FFmpeg çalıştırma vb.) sırasında oluşan hatalar `processAudioTask` içindeki catchte yakalanır ve orası yanıtı gönderir.
         console.error('Kuyruk yönetimi sırasında beklenmedik hata:', error);
         if (!res.headersSent) {
             res.status(500).send('İşlem kuyruğa eklenirken veya yönetilirken bir hata oluştu.');
         }
    }
});

// Sunucuyu başlat
app.listen(port, () => {
    console.log(`Ses birleştirme servisi ${port} portunda çalışıyor`);
    const numCPUs = os.cpus().length; // Sunucu başlarken CPU sayısını tekrar logla
    console.log(`Sistemde ${numCPUs} CPU çekirdeği algılandı.`);
    console.log(`Ses işleme kuyruğu ${processingQueue.concurrency} concurrency ile çalışıyor.`);
});
