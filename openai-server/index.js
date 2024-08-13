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
    console.log(`Dictionary API response for "${word}":`, response.data);

    if (!response.data || response.data.length === 0 || !response.data[0].meanings || !response.data[0].meanings.length) {
      console.error('No valid data returned from the Dictionary API.');
      return { valid: false, englishDefinition: null, vietnameseDefinition: null };
    }

    const englishDefinition = response.data[0].meanings[0].definitions[0].definition;
    console.log(`English definition found: "${englishDefinition}"`);

    // Use OpenAI to generate a Vietnamese translation
    const translationResponse = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant who translates English text to Vietnamese.' },
        { role: 'user', content: `Translate the following English text to Vietnamese: "${englishDefinition}"` },
      ],
      max_tokens: 100,
      temperature: 0.5,  // Adjust temperature if needed for more accurate translations
    });

    const vietnameseDefinition = translationResponse.choices[0].message.content.trim();
    console.log(`Vietnamese definition generated: "${vietnameseDefinition}"`);

    return { valid: true, englishDefinition, vietnameseDefinition };
  } catch (error) {
    console.error(`Error in validateWord function for "${word}":`, error.response ? error.response.data : error.message);
    return { valid: false, englishDefinition: null, vietnameseDefinition: null };
  }
};

// Store previously generated words to avoid duplicates
let previousWords = [];

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
      return isValid.valid;
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

// Endpoint to validate a word and get its definition in both English and Vietnamese
app.post('/validate-word', async (req, res) => {
  const { word } = req.body;
  try {
    const { valid, englishDefinition, vietnameseDefinition } = await validateWord(word);
    res.json({ valid, englishDefinition, vietnameseDefinition });
  } catch (error) {
    console.error('Error validating word:', error);
    res.status(500).json({ error: 'Error validating word' });
  }
});

// Endpoint to generate a unique question for the game
app.get('/generate-question-easy-level', async (req, res) => {
  try {
    if (questionInProgress) {
      return res.status(429).json({ error: 'Question generation in progress, please wait.' });
    }

    questionInProgress = true; // Lock the question generation

    let questionGenerated = false;
    let attempts = 0;
    let parsedQuestion = {};

    // Convert previous words array to a string to include in the prompt
    const previousWordsString = previousWords.join(', ');

    while (!questionGenerated && attempts < 20) { // Increased attempt limit
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: `I need you to give me a unique word and four options where one of the options is a synonym of the word. Do not use any of these words: [${previousWordsString}]. Try to use extremely easy and common words people use in daily life. Format it as: "Word: [word], Options: [option1, option2, option3, option4], Correct Answer: [correctOption]"` }
        ],
        max_tokens: 100,
        temperature: 0.9, // Increased temperature for more diversity
        top_p: 0.95, // Adjusted top_p for varied choices
      });

      const messageContent = response.choices[0].message.content.trim();
      console.log('OpenAI response:', messageContent);

      // Regex patterns to match word, options, and correct answer
      const wordMatch = messageContent.match(/Word:\s*([^\n,]+)/);
      const optionsMatch = messageContent.match(/Options:\s*([^\]]+)/);
      const correctAnswerMatch = messageContent.match(/Correct Answer:\s*([^\n,]+)/);

      if (wordMatch && optionsMatch && correctAnswerMatch) {
        const word = wordMatch[1].trim();
        let options = optionsMatch[1].split(/,\s*/).map(option => option.replace(/^[A-D]\)\s*/, '').trim());
        const correctAnswer = correctAnswerMatch[1].replace(/^[A-D]\)\s*/, '').trim();

        // Remove the correct answer from the options array if it's included
        options = options.filter(option => option !== `Correct Answer: ${correctAnswer}`);

        parsedQuestion = { word, options, correctAnswer };

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

    if (previousWords.length > 50) {
      previousWords = [];
    }
  } catch (error) {
    console.error('Error generating question from OpenAI:', error);
    res.status(500).json({ error: 'Error generating question from AI' });
  } finally {
    questionInProgress = false; // Unlock the question generation
  }
});

app.get('/generate-question-medium-level', async (req, res) => {
  try {
    if (questionInProgress) {
      return res.status(429).json({ error: 'Question generation in progress, please wait.' });
    }

    questionInProgress = true; // Lock the question generation

    let questionGenerated = false;
    let attempts = 0;
    let parsedQuestion = {};

    // Convert previous words array to a string to include in the prompt
    const previousWordsString = previousWords.join(', ');

    while (!questionGenerated && attempts < 20) { // Increased attempt limit
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: `I need you to give me a unique word and four options where one of the options is a synonym of the word. Do not use any of these words: [${previousWordsString}]. Try to use medium and common words people use in daily life. Format it as: "Word: [word], Options: [option1, option2, option3, option4], Correct Answer: [correctOption]"` }
        ],
        max_tokens: 100,
        temperature: 0.9, // Increased temperature for more diversity
        top_p: 0.95, // Adjusted top_p for varied choices
      });

      const messageContent = response.choices[0].message.content.trim();
      console.log('OpenAI response:', messageContent);

      // Regex patterns to match word, options, and correct answer
      const wordMatch = messageContent.match(/Word:\s*([^\n,]+)/);
      const optionsMatch = messageContent.match(/Options:\s*([^\]]+)/);
      const correctAnswerMatch = messageContent.match(/Correct Answer:\s*([^\n,]+)/);

      if (wordMatch && optionsMatch && correctAnswerMatch) {
        const word = wordMatch[1].trim();
        let options = optionsMatch[1].split(/,\s*/).map(option => option.replace(/^[A-D]\)\s*/, '').trim());
        const correctAnswer = correctAnswerMatch[1].replace(/^[A-D]\)\s*/, '').trim();

        // Remove the correct answer from the options array if it's included
        options = options.filter(option => option !== `Correct Answer: ${correctAnswer}`);

        parsedQuestion = { word, options, correctAnswer };

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

    if (previousWords.length > 50) {
      previousWords = [];
    }
  } catch (error) {
    console.error('Error generating question from OpenAI:', error);
    res.status(500).json({ error: 'Error generating question from AI' });
  } finally {
    questionInProgress = false; // Unlock the question generation
  }
});

app.get('/generate-question-hard-level', async (req, res) => {
  try {
    if (questionInProgress) {
      return res.status(429).json({ error: 'Question generation in progress, please wait.' });
    }

    questionInProgress = true; // Lock the question generation

    let questionGenerated = false;
    let attempts = 0;
    let parsedQuestion = {};

    // Convert previous words array to a string to include in the prompt
    const previousWordsString = previousWords.join(', ');

    while (!questionGenerated && attempts < 20) { // Increased attempt limit
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: `I need you to give me a unique word and four options where one of the options is a synonym of the word. Do not use any of these words: [${previousWordsString}]. Try to use really hard and common words people use in daily life. Format it as: "Word: [word], Options: [option1, option2, option3, option4], Correct Answer: [correctOption]"` }
        ],
        max_tokens: 100,
        temperature: 0.9, // Increased temperature for more diversity
        top_p: 0.95, // Adjusted top_p for varied choices
      });

      const messageContent = response.choices[0].message.content.trim();
      console.log('OpenAI response:', messageContent);

      // Regex patterns to match word, options, and correct answer
      const wordMatch = messageContent.match(/Word:\s*([^\n,]+)/);
      const optionsMatch = messageContent.match(/Options:\s*([^\]]+)/);
      const correctAnswerMatch = messageContent.match(/Correct Answer:\s*([^\n,]+)/);

      if (wordMatch && optionsMatch && correctAnswerMatch) {
        const word = wordMatch[1].trim();
        let options = optionsMatch[1].split(/,\s*/).map(option => option.replace(/^[A-D]\)\s*/, '').trim());
        const correctAnswer = correctAnswerMatch[1].replace(/^[A-D]\)\s*/, '').trim();

        // Remove the correct answer from the options array if it's included
        options = options.filter(option => option !== `Correct Answer: ${correctAnswer}`);

        parsedQuestion = { word, options, correctAnswer };

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

    if (previousWords.length > 50) {
      previousWords = [];
    }
  } catch (error) {
    console.error('Error generating question from OpenAI:', error);
    res.status(500).json({ error: 'Error generating question from AI' });
  } finally {
    questionInProgress = false; // Unlock the question generation
  }
});

// New endpoint to generate a word and definition based on the selected topic
app.post('/generate-vocabulary-word', async (req, res) => {
  const { topic } = req.body;
  
  try {
    // Use OpenAI to generate a word based on the topic
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that provides vocabulary words for specific topics.' },
        { role: 'user', content: `Give me a word related to the topic "${topic}".` },
      ],
      max_tokens: 10,
      temperature: 0.7,
    });

    let word = response.choices[0].message.content.trim().toLowerCase();

    // Validate the word and get its definition
    const { valid, englishDefinition, vietnameseDefinition } = await validateWord(word);

    if (!valid) {
      throw new Error('Generated word is not valid.');
    }

    res.json({ word, englishDefinition, vietnameseDefinition });
  } catch (error) {
    console.error('Error generating vocabulary word:', error);
    res.status(500).json({ error: 'Failed to generate vocabulary word' });
  }
});


app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
