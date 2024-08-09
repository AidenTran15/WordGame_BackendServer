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

// Adjusted rate limiting middleware
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Allow 60 requests per windowMs
  message: 'Too many requests from this IP, please try again after a minute',
});

app.use(limiter);

// Function to validate word using dictionary API
const validateWord = async (word) => {
  try {
    const response = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
    console.log(`Validation response for word "${word}":`, response.data); // Add logging
    return response.status === 200;
  } catch (error) {
    console.error(`Validation failed for word "${word}":`, error.response ? error.response.data : error.message);
    return false;
  }
};

// Store previously generated words to avoid duplicates
let previousWords = [];

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
          { role: 'user', content: `Give me a single English word that starts with the letter "${lastLetter}".` }
        ],
        max_tokens: 5,
        temperature: 0.7, // Adding temperature to generate diverse responses
      });

      newWord = response.choices[0].message.content.trim().toLowerCase();

      // Remove any surrounding quotes
      if (newWord.startsWith('"') && newWord.endsWith('"')) {
        newWord = newWord.substring(1, newWord.length - 1);
      }

      // Extract the first word and remove any non-alphabetic characters
      newWord = newWord.split(/\s+/)[0].replace(/[^a-zA-Z]/g, '');

      const isValid = await validateWord(newWord);
      return isValid;
    };

    let isValid = false;
    while (attempts < 3 && !isValid) { // Reduce the retry limit to 3
      isValid = await generateAndValidateWord();
      if (!previousWords.includes(newWord)) {
        previousWords.push(newWord);
        isValid = true;
      } else {
        isValid = false;
      }
      attempts++;
    }

    if (!isValid) {
      throw new Error('Invalid word generated');
    }

    res.json({ word: newWord });
  } catch (error) {
    console.error('Error fetching next word from OpenAI:', error); // Log the error to the console
    res.status(500).json({ error: 'Error fetching next word from AI' });
  }
});

app.post('/validate-word', async (req, res) => {
  const { word } = req.body;
  try {
    const isValid = await validateWord(word);
    res.json({ valid: isValid });
  } catch (error) {
    console.error('Error validating word:', error);
    res.status(500).json({ error: 'Error validating word' });
  }
});

app.get('/generate-question', async (req, res) => {
  try {
    let questionGenerated = false;
    let attempts = 0;
    let parsedQuestion = {};

    while (!questionGenerated && attempts < 10) { // Limit to 10 attempts to avoid infinite loop
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Give me a word and four options where one of the options is a synonym of the word. Format it as: "Word: [word], Options: [option1, option2, option3, option4], Correct Answer: [correctOption]"' }
        ],
        max_tokens: 100,
        temperature: 0.7,
      });

      const messageContent = response.choices[0].message.content.trim();
      console.log('OpenAI response:', messageContent); // Log the full response

      // Regex patterns to match word, options, and correct answer
      const wordMatch = messageContent.match(/Word:\s*([^\n,]+)/);
      const optionsMatch = messageContent.match(/Options:\s*([^\]]+)/);
      const correctAnswerMatch = messageContent.match(/Correct Answer:\s*([^\n,]+)/);

      if (wordMatch && optionsMatch && correctAnswerMatch) {
        const word = wordMatch[1].trim();
        let options = optionsMatch[1].split(/,\s*/).map(option => option.replace(/^[A-D]\)\s*/, '').trim());
        const correctAnswer = correctAnswerMatch[1].replace(/^[A-D]\)\s*/, '').trim();

        parsedQuestion = { word, options, correctAnswer };

        // Check if this word is a duplicate
        const isDuplicateWord = previousWords.includes(word);

        if (!isDuplicateWord) {
          previousWords.push(word);
          questionGenerated = true;
        }
      }

      attempts++;
    }

    if (questionGenerated) {
      res.json(parsedQuestion);
    } else {
      console.error('Failed to generate a unique question');
      res.status(500).json({ error: 'Failed to generate a unique question' });
    }
  } catch (error) {
    console.error('Error generating question from OpenAI:', error);
    res.status(500).json({ error: 'Error generating question from AI' });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});