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



// Store previously generated words to avoid duplicates
let previousWords = [];


// New API to get Vietnamese meaning of a word
app.post('/translate-word', async (req, res) => {
  const { word } = req.body;

  if (!word) {
    return res.status(400).json({ error: 'No word provided' });
  }

  try {
    // Request only the Vietnamese word as the response, no extra phrases
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant who translates English words to Vietnamese.' },
        { role: 'user', content: `Translate the word "${word}" to Vietnamese. Respond with only the Vietnamese word.` },
      ],
      max_tokens: 10,
      temperature: 0.5,
    });

    const vietnameseTranslation = response.choices[0].message.content.trim();
    res.json({ word, vietnameseTranslation });
  } catch (error) {
    console.error('Error translating word:', error);
    res.status(500).json({ error: 'Error translating word with AI' });
  }
});



app.post('/test', (req, res) => {
  res.send('Test route works!');
});




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

    console.log(`Starting to generate a vocabulary word for the topic: ${topic}`);

    while (attempts < maxAttempts && !valid) {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an expert in English vocabulary, specializing in providing words related to specific topics.' },
          { role: 'user', content: `Provide a common word people normal use in daily life related to the topic "${topic}". Avoid generating any of these used words: [${usedWords.join(', ')}]. And never generating any of these words: A, The, Sure, One.` },
        ],
        max_tokens: 10,
        temperature: 0.5,
      });

      word = response.choices[0].message.content.trim().toLowerCase();
      word = word.split(/\s+/)[0].replace(/[^a-zA-Z]/g, '');

      console.log(`Generated word: ${word}`);

      if (!usedWords.includes(word)) {
        const validation = await validateWord(word);
        valid = validation.valid;
        englishDefinition = validation.englishDefinition;
        vietnameseDefinition = validation.vietnameseDefinition;

        if (valid) {
          usedWords.push(word);
          console.log(`Word "${word}" is valid and added to the used words list.`);
        } else {
          console.log(`Word "${word}" is not valid. Trying again...`);
        }
      } else {
        console.log(`Word "${word}" has already been used. Trying again...`);
      }

      attempts++;
    }

    if (!valid) {
      throw new Error('Failed to generate a valid and unique word after multiple attempts.');
    }

    res.json({ word, englishDefinition, vietnameseDefinition });
  } catch (error) {
    console.error('Error generating vocabulary word:', error.message);
    res.status(500).json({ error: 'Failed to generate a vocabulary word' });
  }
});

app.post('/generate-daily-talk', async (req, res) => {
  try {
    const { conversationType } = req.body; // Expecting a conversation type from the client

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { 
          role: 'system', 
          content: `You are a helpful assistant. Generate a short, daily-life conversation between two people.` 
        },
        { 
          role: 'user', 
          content: `Give me a realistic, short conversation that could happen in daily life, for example, the conversation could be Professional Conversations, Negotiations, Interviews, Debates, Counseling or Mentoring, Instructional Conversations, Conflict Resolution, Persuasive Conversations, Decision-Making Conversations.` 
        }
      ],
      max_tokens: 150,
      temperature: 0.7,
    });

    const conversation = response.choices[0].message.content.trim();
    res.json({ conversation });
  } catch (error) {
    console.error('Error generating conversation:', error);
    res.status(500).json({ error: 'Error generating conversation' });
  }
});

app.post('/converse', async (req, res) => {
  const { userInput } = req.body;

  if (!userInput) {
    return res.status(400).json({ error: 'No input provided' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a friendly and helpful assistant who engages in casual conversations.' },
        { role: 'user', content: `${userInput}` }
      ],
      max_tokens: 150,
      temperature: 0.7,
    });

    const aiResponse = response.choices[0].message.content.trim();
    res.json({ response: aiResponse });
  } catch (error) {
    console.error('Error during conversation:', error);
    res.status(500).json({ error: 'Error during conversation' });
  }
});


// Global state to track the interview process
let interviewSession = {
  questionsAsked: [],
  currentQuestionIndex: 0,
  userResponses: []
};

// Endpoint to start the interview session
app.post('/start-interview', async (req, res) => {
  try {
    interviewSession = {
      questionsAsked: [],
      currentQuestionIndex: 0,
      userResponses: []
    };
    
    const firstQuestion = await generateInterviewQuestion();
    res.json({ question: firstQuestion });
  } catch (error) {
    console.error('Error starting interview:', error);
    res.status(500).json({ error: 'Failed to start interview' });
  }
});

// Function to generate an interview question
const generateInterviewQuestion = async () => {
  const interviewQuestions = [
    "Tell me about yourself.",
    "Why do you want this job?",
    "What are your greatest strengths?",
    "What are your weaknesses?",
    "Where do you see yourself in 5 years?",
    // Add more questions as needed
  ];

  const question = interviewQuestions[interviewSession.currentQuestionIndex];
  interviewSession.questionsAsked.push(question);
  return question;
};

// Endpoint to submit an interview answer
app.post('/submit-interview-answer', async (req, res) => {
  const { answer } = req.body;

  if (!answer) {
    return res.status(400).json({ error: 'No answer provided' });
  }

  try {
    interviewSession.userResponses.push(answer);

    // Check if the interview should end after 5 questions
    if (interviewSession.currentQuestionIndex >= 4) { // After 5th question
      const feedback = await generateInterviewFeedback();
      return res.json({ feedback });
    } else {
      // Move to the next question
      interviewSession.currentQuestionIndex++;
      const nextQuestion = await generateInterviewQuestion();
      res.json({ question: nextQuestion });
    }
  } catch (error) {
    console.error('Error submitting interview answer:', error);
    res.status(500).json({ error: 'Error submitting interview answer' });
  }
});


// Function to generate feedback after the interview
const generateInterviewFeedback = async () => {
  const userResponses = interviewSession.userResponses.join(" ");
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: 'You are an expert interviewer providing detailed, constructive feedback. The feedback must include strengths, specific areas of improvement, and actionable recommendations for improvement.' },
      { role: 'user', content: `Provide detailed feedback on the following interview responses. 
      Divide the feedback into the following JSON format with "summary", "strengths", 
      "improvementAreas", and "recommendations". Make the feedback specific with clear suggestions for improvement. 
      Interview responses: "${userResponses}"` }
    ],
    max_tokens: 300,
    temperature: 0.7,
  });

  // Try to remove code block formatting and parse the JSON response
  let feedbackContent = response.choices[0].message.content.trim();

  // Remove ```json or ``` if present
  if (feedbackContent.startsWith("```")) {
    feedbackContent = feedbackContent.replace(/```json|```/g, '');
  }

  let feedback;
  try {
    feedback = JSON.parse(feedbackContent);
  } catch (error) {
    console.error('Error parsing feedback JSON:', error);
    // If parsing fails, return a generic feedback structure
    feedback = {
      summary: "Unable to parse detailed feedback. Here is a general review.",
      strengths: [],
      improvementAreas: [],
      recommendations: "Review your responses and aim to provide more concise and direct answers."
    };
  }

  return feedback;
};


app.post('/friendly-conversation', async (req, res) => {
  const { userInput } = req.body;

  if (!userInput) {
    return res.status(400).json({ error: 'No input provided' });
  }

  try {
    const messages = [
      { role: 'system', content: 'You are a friendly and conversational AI named Aiden. Start a friendly conversation, ask about their day, plans, favorite things, and respond in a friendly and casual tone.' },
      { role: 'assistant', content: 'Hello, my name is Aiden, I\'m 22 years old, I just graduated with a Bachelor of IT at RMIT. Nice to meet you! Can you introduce yourself?' },
      { role: 'user', content: userInput }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      max_tokens: 150,
      temperature: 0.8,
    });

    const aiResponse = response.choices[0].message.content.trim();
    res.json({ response: aiResponse });
  } catch (error) {
    console.error('Error during Friendly AI conversation:', error);
    res.status(500).json({ error: 'Error during Friendly AI conversation' });
  }
});






app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
