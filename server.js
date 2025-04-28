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

    // Loop through the expected field names (file1 to file6)
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
            console.log(`Alan '${fieldName}' için dosya yüklendi: ${file.path}, Original: ${file.originalname}`);
        } else {
            console.log(`Alan '${fieldName}' için dosya yüklenmedi.`);
        }
    }

    // Array to hold paths of all temporary files that need cleaning up (uploaded files, list file, output file).
    // Start with all the uploaded temporary files.
    let listFilePath = null; // Variable to hold the path of the concat list file (only created during merge)
    let outputFilePath = null; // Variable to hold the path of the merged output file (only created during merge)
    let normalizedOutputFilePath = null; // Variable to hold the path of the normalized output file
    const filesToClean = [...allTempFilePaths]; // Clone the array of uploaded file paths

    // *** IMPORTANT: Declare tmpDir within the scope of this async function ***
    // This line fixes the ReferenceError. It gets the system's temporary directory path.
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
            normalizedOutputFilePath = path.join(tmpDir, `normalized_audio_${timestamp}.mp3`);
            filesToClean.push(normalizedOutputFilePath);

            // Normalize the single file
            const normalizeCommand = `ffmpeg -y -i "${singleFilePath.replace(/\\/g, '/')}" -filter:a loudnorm "${normalizedOutputFilePath.replace(/\\/g, '/')}"`;
            console.log(`FFmpeg normalize komutu çalıştırılıyor: ${normalizeCommand}`);
            await execPromise(normalizeCommand);

            // Read the binary content of the normalized file
            const singleFileBinary = await fs.readFile(normalizedOutputFilePath);

            // Get the original details (name, mime type) using the temporary path
            const originalDetails = uploadedFileDetails[singleFilePath] || { originalname: 'single_audio.mp3', mimetype: 'audio/mpeg' };

            // Set HTTP response headers for file download
            res.setHeader('Content-Type', originalDetails.mimetype); // Set the MIME type
            res.setHeader('Content-Disposition', `attachment; filename="${originalDetails.originalname}"`); // Suggest a filename for download
            res.setHeader('Content-Length', singleFileBinary.length); // Set the content length

            // Send the binary content of the normalized file with a 200 OK status
            res.status(200).send(singleFileBinary);
            console.log('Normalize edilmiş tek dosya gönderildi.');

        } else {
            // Case 3: 2 or more files were uploaded. Proceed with merging using FFmpeg.
            console.log(`${validPaths.length} dosya yüklendi, birleştirme yapılıyor.`);
            const timestamp = Date.now(); // Use a timestamp for unique filenames

            // Define paths for the FFmpeg concat list file, merged output file, and normalized output file in the temporary directory
            listFilePath = path.join(tmpDir, `n8n_service_concat_list_${timestamp}.txt`);
            outputFilePath = path.join(tmpDir, `merged_audio_${timestamp}.mp3`);
            normalizedOutputFilePath = path.join(tmpDir, `normalized_merged_audio_${timestamp}.mp3`);

            // Add the list, output, and normalized file paths to the cleanup list
            filesToClean.push(listFilePath, outputFilePath, normalizedOutputFilePath);

            // Create the content for the FFmpeg concat demuxer list file.
            const listContent = validPaths.map(filePath => `file '${filePath.replace(/\\/g, '/')}'`).join('\n');
            await fs.writeFile(listFilePath, listContent);
            console.log(`Concat list dosyası oluşturuldu: ${listFilePath}`);

            // Construct the FFmpeg command to concatenate the files
            const ffmpegCommand = `ffmpeg -y -f concat -safe 0 -i "${listFilePath.replace(/\\/g, '/')}" -c copy "${outputFilePath.replace(/\\/g, '/')}"`;
            console.log(`FFmpeg komutu çalıştırılıyor: ${ffmpegCommand}`);

            // Execute the FFmpeg command
            const { stdout, stderr } = await execPromise(ffmpegCommand);
            console.log('FFmpeg stdout:', stdout);
            if (stderr) { console.warn('FFmpeg stderr:', stderr); }
            console.log('FFmpeg komutu tamamlandı.');

            // Now normalize the merged output
            const normalizeCommand = `ffmpeg -y -i "${outputFilePath.replace(/\\/g, '/')}" -filter:a loudnorm "${normalizedOutputFilePath.replace(/\\/g, '/')}"`;
            console.log(`FFmpeg normalize komutu çalıştırılıyor: ${normalizeCommand}`);
            await execPromise(normalizeCommand);
            console.log('Normalize işlemi tamamlandı.');

            // Read the binary content of the normalized merged output file
            const outputBinary = await fs.readFile(normalizedOutputFilePath);
            console.log(`Normalize edilmiş çıktı dosyası okundu: ${normalizedOutputFilePath}`);

            // Define the filename for the normalized merged output file when sent as a download.
            const mergedFileName = `merged_audio_${timestamp}.mp3`;
            res.setHeader('Content-Type', 'audio/mpeg'); // Assuming the output is always MP3
            res.setHeader('Content-Disposition', `attachment; filename="${mergedFileName}"`);
            res.setHeader('Content-Length', outputBinary.length);

            // Send the binary content of the normalized merged file with a 200 OK status
            res.status(200).send(outputBinary);
            console.log('Birleştirilmiş ve normalize edilmiş dosya gönderildi.');
        }

    } catch (error) {
        // Catch any errors that occurred during the try block (file ops, FFmpeg execution etc.)
        console.error("İşlem sırasında hata oluştu:", error);
        res.status(500).send("Dosyalar işlenirken bir hata oluştu.");
    } finally {
        // This block runs regardless of whether the try block succeeded or the catch block was executed.
        // It's used here to ensure temporary files are cleaned up.
        console.log("Geçici dosyalar temizleniyor...");
        for (const file of filesToClean) {
            try {
                if (file) {
                    await fs.unlink(file);
                    console.log(`Temizlendi: ${file}`);
                }
            } catch (e) {
                console.warn(`Temizlenemedi (muhtemelen yok): ${file}. Hata: ${e.message}`);
            }
        }
    }
});

// Start the Express server and make it listen on the defined port.
app.listen(port, () => {
    console.log(`Ses birleştirme servisi ${port} portunda çalışıyor`);
});
