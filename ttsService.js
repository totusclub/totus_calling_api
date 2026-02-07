// backend/ttsService.js
//
// Google Cloud Text-to-Speech service
// Synthesizes speech from text using Google Cloud TTS API

const fs = require('fs');
const util = require('util');
const path = require('path');
const textToSpeech = require('@google-cloud/text-to-speech');

// Google Cloud JSON key path
const keyFilename = path.join(__dirname, 'totus-voice-ac1464f87501.json');

// Initialize Google Cloud TTS client
const client = new textToSpeech.TextToSpeechClient({
  keyFilename: keyFilename,
});

const writeFile = util.promisify(fs.writeFile);

/**
 * Synthesize speech from text using Google Cloud TTS
 * @param {string} text - Text to synthesize
 * @param {Object} options - Optional configuration
 * @param {string} options.languageCode - Language code (default: 'ru-RU')
 * @param {string} options.ssmlGender - Voice gender: 'FEMALE' | 'MALE' | 'NEUTRAL' (default: 'FEMALE')
 * @param {string} options.audioEncoding - Audio encoding: 'MP3' | 'LINEAR16' | 'OGG_OPUS' (default: 'MP3')
 * @param {string} options.voiceName - Specific voice name (optional)
 * @returns {Promise<Buffer>} - Audio content as Buffer
 */
async function synthesizeSpeech(text, options = {}) {
    const textRemoveSymbole= text.replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '').trim();
  try {
    const {
      languageCode = 'ru-RU',
      ssmlGender = 'FEMALE',
      audioEncoding = 'MP3',
      voiceName = 'ru-RU-Chirp3-HD-Aoede'
    } = options;

    const request = {
      input: { text: textRemoveSymbole },
      voice: {
        languageCode: languageCode,
        ssmlGender: ssmlGender,
      },
      audioConfig: { audioEncoding: audioEncoding },
    };

    // Add specific voice name if provided
    if (voiceName) {
      request.voice.name = voiceName;
    }

    console.log('[TTS] Synthesizing speech:', {
      textLength: textRemoveSymbole.length,
      languageCode,
      ssmlGender,
      audioEncoding,
      voiceName: voiceName || 'default',
    });

    const [response] = await client.synthesizeSpeech(request);

    if (!response.audioContent) {
      throw new Error('No audio content received from Google Cloud TTS');
    }

    console.log('[TTS] ✅ Speech synthesized successfully, audio size:', response.audioContent.length, 'bytes');

    return response.audioContent;
  } catch (error) {
    console.error('[TTS] ❌ Error synthesizing speech:', error);
    throw error;
  }
}

/**
 * Synthesize speech and save to file
 * @param {string} text - Text to synthesize
 * @param {string} outputPath - Output file path (default: 'output.mp3')
 * @param {Object} options - Optional configuration (same as synthesizeSpeech)
 * @returns {Promise<string>} - Path to saved file
 */
async function synthesizeSpeechToFile(text, outputPath = 'output.mp3', options = {}) {
  try {
    const audioContent = await synthesizeSpeech(text, options);
    
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    await writeFile(outputPath, audioContent, 'binary');
    console.log('[TTS] ✅ Audio content written to file:', outputPath);
    
    return outputPath;
  } catch (error) {
    console.error('[TTS] ❌ Error writing audio to file:', error);
    throw error;
  }
}

module.exports = {
  synthesizeSpeech,
  synthesizeSpeechToFile,
};

