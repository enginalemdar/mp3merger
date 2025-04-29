const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const PQueue = require('p-queue').default;

const execPromise = util.promisify(exec);
const app = express();
const port = process.env.PORT || 3000;

const upload = multer({ dest: os.tmpdir() }).fields([
  { name: 'file1', maxCount: 1 },
  { name: 'file2', maxCount: 1 },
  { name: 'file3', maxCount: 1 },
  { name: 'file4', maxCount: 1 },
  { name: 'file5', maxCount: 1 },
  { name: 'file6', maxCount: 1 }
]);

const processingQueue = new PQueue({ concurrency: os.cpus().length });

app.post('/merge', upload, async (req, res) => {
  await processingQueue.add(() => processAudioTask(req, res));
});

async function processAudioTask(req, res) {
  const timestamp = Date.now();
  const silenceDuration = parseFloat(req.body.silenceDuration) || 1;
  const targetLufs = parseFloat(req.body.targetLufs) || -16;
  const outputFilename = (req.body.outputFilename || `merged_${timestamp}.mp3`).replace(/[^a-zA-Z0-9_\-.]/g, '');

  const uploadedFields = req.files;
  const validFiles = [];
  const allTempPaths = [];

  for (let i = 1; i <= 6; i++) {
    const fieldName = `file${i}`;
    const fileArray = uploadedFields?.[fieldName];
    if (fileArray?.[0]) {
      validFiles.push({ field: fieldName, path: fileArray[0].path });
      allTempPaths.push(fileArray[0].path);
    }
  }

  if (validFiles.length === 0) {
    return res.status(400).send('En az bir dosya yüklemelisiniz.');
  }

  const tmpDir = os.tmpdir();
  const outputPath = path.join(tmpDir, `output_${timestamp}.mp3`);
  allTempPaths.push(outputPath);

  try {
    const ffmpegInputs = [];
    const filterInputs = [];
    let filterComplexParts = [];
    let indexOffset = 0;

    // Sessizlik stream'i daima ilk sırada (0. input)
    ffmpegInputs.push(`-f lavfi -i aevalsrc=0:s=44100:d=${silenceDuration}`);
    indexOffset = 1;

    // Dosyaları ffmpeg -i input listesine ekle
    validFiles.forEach(f => {
      ffmpegInputs.push(`-i "${f.path}"`);
    });

    // Filter chain oluşturuluyor
    const streams = [];
    validFiles.forEach((f, i) => {
      const inputIdx = i + indexOffset;
      const tag = `[in${i}]`;
      filterComplexParts.push(`[${inputIdx}:a]aresample=44100${tag}`);
      streams.push(tag);

      // Eğer bu file1'den sonra gelen ilk dosya ise sessizlik ekle
      if (f.field === 'file1' && validFiles.length > i + 1) {
        streams.push(`[0:a]`); // sessizlik stream'i [0:a]
      }
    });

    const concatCount = streams.length;
    filterComplexParts.push(`${streams.join('')}concat=n=${concatCount}:v=0:a=1[a]`);
    filterComplexParts.push(`[a]loudnorm=I=${targetLufs}:TP=-1.0:LRA=11[out]`);

    const ffmpegCommand = `ffmpeg -y ${ffmpegInputs.join(' ')} -filter_complex "${filterComplexParts.join(',')}" -map "[out]" -c:a libmp3lame -b:a 192k "${outputPath}"`;

    console.log(`[${timestamp}] FFmpeg komutu: ${ffmpegCommand}`);
    const { stdout, stderr } = await execPromise(ffmpegCommand);
    if (stderr) console.warn(stderr);

    const fileBuffer = await fs.readFile(outputPath);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.status(200).send(fileBuffer);

  } catch (error) {
    console.error(`[${timestamp}] Hata:`, error);
    if (!res.headersSent) {
      res.status(500).send('İşlem sırasında bir hata oluştu.');
    }
  } finally {
    for (const file of allTempPaths) {
      try { await fs.unlink(file); } catch (_) {}
    }
  }
}

app.listen(port, () => {
  console.log(`Sunucu ${port} portunda çalışıyor...`);
});
