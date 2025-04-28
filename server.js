// Import necessary Node.js modules and external libraries
const express = require('express');
const multer = require('multer'); // Middleware for handling multipart/form-data
const fs = require('fs').promises; // File system operations with promises
const path = require('path'); // Utility for working with file and directory paths
const os = require('os'); // Utility for operating system related methods (like tmpdir)
const { exec } = require('child_process'); // For running external commands (like ffmpeg)
const util = require('util'); // Utility for Node.js internal APIs

// Promisify child_process.exec to use async/await with it
const execPromise = util.promisify(exec);

// Create an Express application instance
const app = express();
// Define the port the server will listen on. Use the PORT environment variable if available (common in hosting environments like Railway), otherwise default to 3000.
const port = process.env.PORT || 3000;

// Configure Multer for handling file uploads
// dest: Specifies the directory where uploaded files will be temporarily stored. os.tmpdir() gets the system's default temporary directory.
// .fields([...]): Configures Multer to accept specific non-contiguous fields.
// Each object in the array defines an expected field name and the maximum number of files for that field.
const upload = multer({ dest: os.tmpdir() }).fields([
    { name: 'file1', maxCount: 1 },
    { name: 'file2', maxCount: 1 },
    { name: 'file3', maxCount: 1 },
    { name: 'file4', maxCount: 1 },
    { name: 'file5', maxCount: 1 },
    { name: 'file6', maxCount: 1 }
]);

// Define the POST endpoint for merging files
// This endpoint will be /merge relative to the server's base URL.
// 'upload' middleware will process the incoming multipart/form-data before the async handler runs.
app.post('/merge', upload, async (req, res) => {
    console.log('Merge isteği alındı.');

    // req.files contains an object where keys are the field names (file1, file2 etc.)
    // and values are arrays containing the file object(s) uploaded for that field.
    const uploadedFields = req.files;

    // Array to store the file paths for files that were actually uploaded and are valid
    const validPaths = [];
    // Object to store details (like original name and mime type) of the uploaded files, mapped by their temporary path.
    const uploadedFileDetails = {};

    // Array to collect the temporary file paths of ALL uploaded files for cleanup.
    const allTempFilePaths = [];

    // Loop through the expected field names (file1 to file6) to preserve order
    for (let i = 1; i <= 6; i++) {
        const fieldName = `file${i}`;
        // Access the file array for the current field using optional chaining (?.) in case the field wasn't sent.
        const fileArray = uploadedFields?.[fieldName];

        // Check if the file array exists and contains at least one file (since maxCount is 1, it will have 0 or 1 element).
        if (fileArray && fileArray.length > 0) {
            const file = fileArray[0]; // Get the single file object from the array
            validPaths.push(file.path); // Add the temporary path to the list of files to be processed (merged or returned single)
            allTempFilePaths.push(file.path); // Add the temporary path to the list for cleanup later
            uploadedFileDetails[file.path] = { // Store original details mapped by the temp path
                originalname: file.originalname,
                mimetype: file.mimetype
            };
            console.log(`Alan '${fieldName}' için dosya yüklendi (Sıra: ${validPaths.length}): ${file.path}, Original: ${file.originalname}`);
        } else {
            console.log(`Alan '${fieldName}' için dosya yüklenmedi.`);
        }
    }

    // Array to hold paths of all temporary files that need cleaning up.
    // Start with all the uploaded temporary files.
    let normalizedOutputFilePath = null; // Variable to hold the path of the final normalized output file
    const filesToClean = [...allTempFilePaths]; // Clone the array of uploaded file paths

    // Get the system's temporary directory path.
    const tmpDir = os.tmpdir();

    try {
        if (validPaths.length === 0) {
            // Case 1: No files were successfully uploaded
            const errorMsg = "Lütfen işlenecek en az bir adet dosya yükleyin.";
            console.error(errorMsg);
            // Return a 400 Bad Request response
            return res.status(400).send(errorMsg);

        } else if (validPaths.length === 1) {
            // Case 2: Exactly one file was uploaded. Return it directly after normalizing.
            console.log(`Sadece 1 dosya yüklendi, normalize ediliyor: ${validPaths[0]}`);
            const singleFilePath = validPaths[0];
            const timestamp = Date.now();
            // Define the path for the normalized output file in the temporary directory
            normalizedOutputFilePath = path.join(tmpDir, `normalized_audio_${timestamp}.mp3`);
            filesToClean.push(normalizedOutputFilePath); // Add output file to cleanup list

            // Normalize the single file using loudnorm filter, output as MP3
            // Use posix paths for FFmpeg command regardless of OS
            const normalizeCommand = `ffmpeg -y -i "${singleFilePath.replace(/\\/g, '/')}" -filter:a loudnorm -c:a libmp3lame -b:a 192k "${normalizedOutputFilePath.replace(/\\/g, '/')}"`; // Added bitrate for MP3
            console.log(`FFmpeg normalize komutu çalıştırılıyor: ${normalizeCommand}`);
            const { stdout, stderr } = await execPromise(normalizeCommand);
            console.log('FFmpeg normalize stdout:', stdout);
            if (stderr) { console.warn('FFmpeg normalize stderr:', stderr); }
            console.log('FFmpeg normalize komutu tamamlandı.');

            // Read the binary content of the normalized file
            const singleFileBinary = await fs.readFile(normalizedOutputFilePath);

            // Get the original details (name, mime type) using the temporary path
            const originalDetails = uploadedFileDetails[singleFilePath] || { originalname: 'single_audio.mp3' };

            // Set HTTP response headers for file download
            res.setHeader('Content-Type', 'audio/mpeg'); // Set to MP3 as we re-encode to MP3
            res.setHeader('Content-Disposition', `attachment; filename="normalized_${originalDetails.originalname}"`); // Suggest a filename for download
            res.setHeader('Content-Length', singleFileBinary.length); // Set the content length

            // Send the binary content of the normalized file with a 200 OK status
            res.status(200).send(singleFileBinary);
            console.log('Normalize edilmiş tek dosya gönderildi.');

        } else {
            // Case 3: 2 or more files were uploaded. Proceed with merging using FFmpeg concat filter + silence + normalization.
            console.log(`${validPaths.length} dosya yüklendi, ilk dosya sonrası 1sn sessizlik eklenip birleştirme ve normalizasyon yapılıyor.`);
            const timestamp = Date.now(); // Use a timestamp for unique filenames

            // Define the path for the final normalized and merged output file in the temporary directory
            normalizedOutputFilePath = path.join(tmpDir, `normalized_merged_audio_${timestamp}.mp3`);
            filesToClean.push(normalizedOutputFilePath); // Add output file to cleanup list

            // --- Construct the FFmpeg command using concat filter with silence ---
            // Build the input arguments (-i "path") for each file
            const inputArgs = validPaths.map(filePath => `-i "${filePath.replace(/\\/g, '/')}"`).join(' ');

            // 1 second silence source: aevalsrc=0:s=SampleRate:d=Duration
            // Using a common sample rate like 44100 or 48000. Loudnorm should handle resampling.
            // Let's use 44100 as a common default.
            const silenceFilterSource = `aevalsrc=0:s=44100:d=1[silence_out];`; // Generates 1s silence, labels output as [silence_out]

            // Build the input mapping for the concat filter, including silence after the first audio input [0:a]
            // Inputs to concat will be [0:a], [silence_out], [1:a], [2:a], ...
            const concatInputPads = [
                '[0:a]', // First audio input
                '[silence_out]', // Silence output from aevalsrc
                ...validPaths.slice(1).map((_, index) => `[${index + 1}:a]`) // Remaining audio inputs ([1:a], [2:a], ...)
            ].join('');

            // Total number of inputs to the concat filter = number of audio files + 1 (for silence)
            const totalConcatInputs = validPaths.length + 1;

            // Build the concat filter: take N+1 inputs, output 0 video, 1 audio, label audio as [a]
            const concatFilter = `${concatInputPads}concat=n=${totalConcatInputs}:v=0:a=1[a];`;

            // Build the loudnorm filter: take [a] input, apply loudnorm, label output as [out]
             const loudnormFilter = '[a]loudnorm=I=-14:TP=-1.0:LRA=11[out]'; // Standard loudnorm parameters

            // Combine all filters into the filter_complex string
            const filterComplex = `${silenceFilterSource}${concatFilter}${loudnormFilter}`;

            // Combine everything into the final FFmpeg command
            // -y: Overwrite output file without asking
            // -map "[out]": Map the output stream labeled "[out]" (result of loudnorm) to the output file
            // -c:a libmp3lame: Re-encode audio to MP3 using libmp3lame (reliable output format)
            // -b:a 192k: Set audio bitrate to 192kbps (a common setting for MP3 audio)
            const ffmpegCommand = `ffmpeg -y ${inputArgs} -filter_complex "${filterComplex}" -map "[out]" -c:a libmp3lame -b:a 192k "${normalizedOutputFilePath.replace(/\\/g, '/')}"`;

            console.log(`FFmpeg birleştirme (1sn sessizlik) ve normalizasyon komutu çalıştırılıyor: ${ffmpegCommand}`);

            // Execute the FFmpeg command
            const { stdout, stderr } = await execPromise(ffmpegCommand);
            console.log('FFmpeg stdout:', stdout);
            if (stderr) { console.warn('FFmpeg stderr:', stderr); }
            console.log('FFmpeg birleştirme ve normalizasyon komutu tamamlandı.');

            // Read the binary content of the final output file
            const outputBinary = await fs.readFile(normalizedOutputFilePath);
            console.log(`Birleştirilmiş ve normalize edilmiş çıktı dosyası okundu: ${normalizedOutputFilePath}`);

            // Define the filename for the final output file when sent as a download.
            const mergedFileName = `merged_audio_${timestamp}.mp3`;
            res.setHeader('Content-Type', 'audio/mpeg'); // Output is MP3
            res.setHeader('Content-Disposition', `attachment; filename="${mergedFileName}"`);
            res.setHeader('Content-Length', outputBinary.length);

            // Send the binary content of the final file with a 200 OK status
            res.status(200).send(outputBinary);
            console.log('Birleştirilmiş ve normalize edilmiş dosya gönderildi.');
        }

    } catch (error) {
        // Catch any errors that occurred during the try block (file ops, FFmpeg execution etc.)
        console.error("İşlem sırasında hata oluştu:", error);
        // Send a 500 Internal Server Error response with the error message
        // In a production environment, you might want to send a more generic message and log the specific error server-side
        res.status(500).send(`Dosyalar işlenirken bir hata oluştu: ${error.message}`);
    } finally {
        // This block runs regardless of whether the try block succeeded or the catch block was executed.
        // It's used here to ensure temporary files are cleaned up.
        console.log("Geçici dosyalar temizleniyor...");
        for (const file of filesToClean) {
            try {
                // Check if the file path is valid (not null or undefined)
                if (file) {
                    await fs.unlink(file); // Attempt to delete the file
                    console.log(`Temizlendi: ${file}`);
                }
            } catch (e) {
                // Log a warning if cleanup fails for a file (e.g., file might not exist due to a previous error)
                console.warn(`Temizlenemedi (muhtemelen yok): ${file}. Hata: ${e.message}`);
            }
        }
        console.log("Geçici dosyalar temizleme tamamlandı.");
    }
});

// Start the Express server and make it listen on the defined port.
app.listen(port, () => {
    console.log(`Ses birleştirme servisi ${port} portunda çalışıyor`);
});
