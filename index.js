const express = require('express');
const serverless = require('serverless-http');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const pool = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Bedrock client with direct credentials
const bedrockClient = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || 'us-east-1'
  // Using Lambda role-based credentials
});

// Helper function to retrieve chat history from the database
async function getChatHistory(userId) {
  try {
    const query = `
      SELECT id, message, is_user, created_at
      FROM messages
      WHERE user_id = $1
      ORDER BY created_at ASC
      LIMIT 10
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  } catch (error) {
    console.error('Error fetching chat history:', error);
    return [];
  }
}

// Helper function to save a message to the database
async function saveMessage(userId, message, isUser) {
  try {
    const query = `
      INSERT INTO messages (user_id, message, is_user, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING created_at
    `;
    const result = await pool.query(query, [userId, message, isUser]);
    return result.rows[0].created_at;
  } catch (error) {
    console.error('Error saving message:', error);
    return null;
  }
}

// Format history for the model
function formatConversationHistory(history) {
  return history.map(msg => ({
    role: msg.is_user ? 'user' : 'assistant', 
    content: msg.message
  }));
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, userId } = req.body;
    
    if (!message || !userId) {
      return res.status(400).json({ error: 'Message and userId are required' });
    }
    
    // Get previous chat history
    const history = await getChatHistory(userId);
    
    // Save user message
    await saveMessage(userId, message, true);
    
    // Format conversation for Bedrock
    const conversationHistory = formatConversationHistory(history);
    
    // Add current message
    conversationHistory.push({
      role: 'user',
      content: message
    });
    
    // NUST University system prompt
    const systemPrompt = "You are the official NUST (National University of Sciences and Technology) chatbot for the Islamabad campus. " +
      "Your purpose is to provide accurate information about NUST's policies, admission procedures, academic programs, campus facilities, " +
      "faculty information, student life, and other university-related matters. Always maintain a helpful, professional tone " +
      "and refer to official NUST policies. If you don't know something specific about NUST, acknowledge that limitation " +
      "and suggest where the user might find that information on the official NUST website." +
      "When asked about your purpose, say you are a chatbot that can answer questions about NUST and provide information about NUST's policies, admission procedures, academic programs, campus facilities, faculty information, student life, and other university-related matters." +
      "When user asks about anything other than NUST, say you are a chatbot that can answer questions about NUST and provide information about NUST's policies, admission procedures, academic programs, campus facilities, faculty information, student life, and other university-related matters only.";
    
    // Prepare payload for Titan model with system prompt
    let formattedHistory = '';
    if (conversationHistory && conversationHistory.length > 0) {
      formattedHistory = conversationHistory
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n\n');
      formattedHistory = `\n\n${formattedHistory}\n\n`;
    }
    
    const payload = {
      inputText: `${systemPrompt}${formattedHistory}User: ${message}\n\nAssistant:`,
      textGenerationConfig: {
        temperature: 0.7,
        topP: 0.9
      }
    };
    
    console.log('Sending to Bedrock:', payload.inputText.substring(0, 100) + '...');
    
    // Invoke Bedrock model with role-based authentication
    const command = new InvokeModelCommand({
      modelId: 'amazon.titan-text-express-v1', // Most affordable option
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload)
    });
    
    try {
      console.log('Calling Bedrock...');
      console.log('Using region:', process.env.BEDROCK_REGION || 'us-east-1');
      const response = await bedrockClient.send(command);
      console.log('Bedrock response received');
      
      // Parse the response - Titan has different response format
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      const aiResponse = responseBody.results[0].outputText.trim();

      // Clean up the response to remove any conversation formatting
      const cleanedResponse = cleanupAiResponse(aiResponse);

      console.log('AI response:', cleanedResponse);
      console.log("--------------------------------")
      
      // Save AI response to database
      const timestamp = await saveMessage(userId, cleanedResponse, false);
      
      // Return response to client
      return res.json({ 
        message: cleanedResponse,
        userId: userId,
        timestamp: timestamp
      });
    } catch (error) {
      console.error('Bedrock error details:', error.message, error.stack);
      return res.status(500).json({ 
        error: 'Error calling AI model',
        details: error.message
      });
    }
    
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    return res.status(500).json({ error: 'An error occurred while processing your request' });
  }
});

// Signup endpoint
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Check if user already exists
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    
    if (userCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    
    // Hash the password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    // Insert the new user
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, passwordHash]
    );
    
    const userId = result.rows[0].id;
    
    return res.status(201).json({ 
      message: 'User created successfully',
      userId: userId
    });
    
  } catch (error) {
    console.error('Error in signup endpoint:', error);
    return res.status(500).json({ error: 'An error occurred during signup' });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Find the user
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    
    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    return res.json({ 
      message: 'Login successful',
      userId: user.id
    });
    
  } catch (error) {
    console.error('Error in login endpoint:', error);
    return res.status(500).json({ error: 'An error occurred during login' });
  }
});

// Delete chat history endpoint
app.post('/api/chat/history/delete', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    // Delete all messages for this user
    const query = 'DELETE FROM messages WHERE user_id = $1';
    const result = await pool.query(query, [userId]);
    
    return res.json({
      message: 'Chat history deleted successfully',
      deletedCount: result.rowCount
    });
    
  } catch (error) {
    console.error('Error deleting chat history:', error);
    return res.status(500).json({ error: 'An error occurred while deleting chat history' });
  }
});

// Get chat history endpoint
app.post('/api/chat/history', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    // Get chat history
    const history = await getChatHistory(userId);
    
    // Format into the requested format
    const formattedHistory = history.map(msg => ({
      id: msg.id.toString(),
      content: msg.message,
      sender: msg.is_user ? 'user' : 'bot',
      timestamp: msg.created_at
    }));
    
    return res.json({
      history: formattedHistory
    });
    
  } catch (error) {
    console.error('Error fetching chat history:', error);
    return res.status(500).json({ error: 'An error occurred while fetching chat history' });
  }
});

// Start Express server if running locally
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Export for AWS Lambda
module.exports.handler = serverless(app);

// Helper function to clean up AI responses
function cleanupAiResponse(response) {
  // Check if response contains newlines followed by "User:" or "Assistant:" patterns
  const conversationPattern = /\n\s*(User:|Assistant:|Bot:)/i;
  
  if (conversationPattern.test(response)) {
    // Split at the first occurrence of a newline followed by User: or Assistant:
    const parts = response.split(conversationPattern);
    return parts[0].trim();
  }
  
  return response;
} 