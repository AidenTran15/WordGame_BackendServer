const express = require('express');
const { OpenAI } = require('openai');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = 5000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());

let questionInProgress = false; // Global flag to lock question generation
let usedWords = []; // Store used words

// Adjusted rate limiting middleware
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Allow 60 requests per windowMs
  message: 'Too many requests from this IP, please try again after a minute',
});

app.use(limiter);

// Function to validate word using dictionary API and translate definition to Vietnamese using OpenAI
const validateWord = async (word) => {
  try {
    // Fetch English definition
    const response = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
    if (!response.data || response.data.length === 0 || !response.data[0].meanings || !response.data[0].meanings.length) {
      return { valid: false, englishDefinition: null, vietnameseDefinition: null };
    }

    const englishDefinition = response.data[0].meanings[0].definitions[0].definition;

    // Use OpenAI to generate a Vietnamese translation
    const translationResponse = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant who translates English text to Vietnamese.' },
        { role: 'user', content: `Translate the following English text to Vietnamese: "${englishDefinition}"` },
      ],
      max_tokens: 150,
      temperature: 0.5,
    });

    const vietnameseDefinition = translationResponse.choices[0].message.content.trim();
    return { valid: true, englishDefinition, vietnameseDefinition };
  } catch (error) {
    return { valid: false, englishDefinition: null, vietnameseDefinition: null };
  }
};

// Endpoint to generate a new word based on the last letter
app.post('/generate-word', async (req, res) => {
  const { lastLetter } = req.body;
  try {
    let newWord;
    let attempts = 0;

    const generateAndValidateWord = async () => {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant. Please provide a single English word.' },
          { role: 'user', content: `Give me a single English word that starts with the letter "${lastLetter}".` },
        ],
        max_tokens: 5,
        temperature: 0.7,
      });

      newWord = response.choices[0].message.content.trim().toLowerCase();
      newWord = newWord.split(/\s+/)[0].replace(/[^a-zA-Z]/g, '');

      return await validateWord(newWord);
    };

    let result = { valid: false };
    while (attempts < 3 && !result.valid) {
      result = await generateAndValidateWord();
      if (!usedWords.includes(newWord)) {
        usedWords.push(newWord);
        result.valid = true;
      } else {
        result.valid = false;
      }
      attempts++;
    }

    if (!result.valid) {
      throw new Error('Invalid word generated');
    }

    res.json({ word: newWord, englishDefinition: result.englishDefinition, vietnameseDefinition: result.vietnameseDefinition });
  } catch (error) {
    res.status(500).json({ error: 'Error generating a valid word' });
  }
});

// Endpoint to validate a word and get its definition in both English and Vietnamese
app.post('/validate-word', async (req, res) => {
  const { word } = req.body;
  try {
    const result = await validateWord(word);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Error validating word' });
  }
});

// Endpoint to retrieve the list of used words
app.get('/used-words', (req, res) => {
  res.json({ usedWords });
});

// Endpoint to clear the used words
app.post('/clear-used-words', (req, res) => {
  usedWords = [];
  res.json({ message: 'Used words cleared' });
});

// Endpoint to generate a vocabulary word avoiding duplicates
app.post('/generate-vocabulary-word', async (req, res) => {
  const { topic } = req.body;
  try {
    let word;
    let valid = false;
    let englishDefinition, vietnameseDefinition;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts && !valid) {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an expert in English vocabulary, specializing in providing words related to specific topics.' },
          { role: 'user', content: `Provide a word must related to the topic "${topic}". Avoid generating any of these used words: [${usedWords.join(', ')}].` },
        ],
        max_tokens: 10,
        temperature: 0.5,
      });

      word = response.choices[0].message.content.trim().toLowerCase();
      word = word.split(/\s+/)[0].replace(/[^a-zA-Z]/g, '');

      if (!usedWords.includes(word)) {
        const validation = await validateWord(word);
        valid = validation.valid;
        englishDefinition = validation.englishDefinition;
        vietnameseDefinition = validation.vietnameseDefinition;
        
        if (valid) {
          usedWords.push(word);
        }
      }

      attempts++;
    }

    if (!valid) {
      throw new Error('Failed to generate a valid and unique word.');
    }

    res.json({ word, englishDefinition, vietnameseDefinition });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate a vocabulary word' });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
