const { BlobServiceClient, generateBlobSASQueryParameters, StorageSharedKeyCredential } = require('@azure/storage-blob');
const fetch = require('node-fetch');
require('dotenv').config();

// Constants for rate limiting and file size
const MAX_DAILY_SUBMISSIONS = 35;
const MAX_VIDEO_SIZE_BYTES = 350 * 1024 * 1024; // 350 MB in bytes

// In-memory submission tracking (can be replaced with Redis for distributed systems)
const submissionTracker = {};

function isRateLimitExceeded(email) {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;

  // Initialize user tracking if not exists
  if (!submissionTracker[email]) {
    submissionTracker[email] = {
      hourlySubmissions: [],
      dailySubmissions: []
    };
  }

  const userTracker = submissionTracker[email];

  // Clean up old submissions
  userTracker.hourlySubmissions = userTracker.hourlySubmissions.filter(time => now - time < oneHour);
  userTracker.dailySubmissions = userTracker.dailySubmissions.filter(time => now - time < oneDay);

  // Check hourly limit (3 submissions per hour)
  if (userTracker.hourlySubmissions.length >= 3) {
    return {
      exceeded: true, 
      message: 'You can only submit 3 clips per hour. Please try again later.'
    };
  }

  // Check daily limit (35 submissions per day)
  if (userTracker.dailySubmissions.length >= MAX_DAILY_SUBMISSIONS) {
    return {
      exceeded: true, 
      message: `You can only submit ${MAX_DAILY_SUBMISSIONS} clips per day. Please try again tomorrow.`
    };
  }

  // If not exceeded, record the submission
  userTracker.hourlySubmissions.push(now);
  userTracker.dailySubmissions.push(now);

  return { exceeded: false };
}

exports.handler = async (event) => {
  // Validate request method
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      body: JSON.stringify({ message: 'Method Not Allowed' }) 
    };
  }

  try { 
    // Parse incoming payload
    let formData;
    try {
      formData = JSON.parse(event.body);
    } catch (parseError) {
      console.error('JSON Parsing Error:', parseError);
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          message: 'Invalid JSON payload', 
          error: parseError.message 
        })
      };
    }

    // Validate email is present
    if (!formData.email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          message: 'Email is required for rate limiting' 
        })
      };
    }

    // Check rate limit
    const rateLimitCheck = isRateLimitExceeded(formData.email);
    if (rateLimitCheck.exceeded) {
      return {
        statusCode: 429, // Too Many Requests
        body: JSON.stringify({ 
          message: rateLimitCheck.message 
        })
      };
    }

    // Validate agreements
    if (!formData.exclusiveAgreement || !formData.clipGuidelines) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          message: 'You must agree to the exclusive agreement and clip guidelines' 
        })
      };
    }

    // Validate submission method (file upload or clip link)
    const hasFileUpload = formData.fileBase64 && formData.fileBase64 !== 'null';
    const hasClipLink = formData.clip_link && formData.clip_link !== 'null';

    // Validate file size if file upload is present
    if (hasFileUpload) {
      // Decode base64 and check file size
      const fileBuffer = Buffer.from(formData.fileBase64, 'base64');
      
      if (fileBuffer.length > MAX_VIDEO_SIZE_BYTES) {
        return {
          statusCode: 400,
          body: JSON.stringify({ 
            message: `File size exceeds maximum limit of ${MAX_VIDEO_SIZE_BYTES / (1024 * 1024)} MB`, 
            maxSizeBytes: MAX_VIDEO_SIZE_BYTES
          })
        };
      }
    }

    if (!hasFileUpload && !hasClipLink) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          message: 'You must upload a clip or provide a link', 
          requiredFields: ['fileBase64 or clip_link']
        })
      };
    }

        // If file upload is present, process Azure Blob Storage upload
        let blobUrl = null;
        if (hasFileUpload) {
          // Azure Blob Storage Upload Logic
          const blobServiceClient = BlobServiceClient.fromConnectionString(
            process.env.AZURE_STORAGE_CONNECTION_STRING
          );
          const containerClient = blobServiceClient.getContainerClient(
            process.env.AZURE_CONTAINER
          );
    
          // Generate unique blob name
          const sanitizedFileName = (formData.fileName || 'unnamed_clip')
            .replace(/[^a-zA-Z0-9.-]/g, '_')
            .substring(0, 100);
          const blobName = `${Date.now()}_${sanitizedFileName}`;
          const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
          // Convert base64 to buffer
          const fileBuffer = Buffer.from(formData.fileBase64, 'base64');
          
          // Upload to Azure Blob Storage
          await blockBlobClient.upload(fileBuffer, fileBuffer.length);
    
          // Generate SAS Token
          blobUrl = await generateSASToken(blobName);
        }
    
        // Use clip link if no file upload
        const submissionUrl = hasFileUpload ? blobUrl : formData.clip_link;
    
        // Send Telegram Notification
        try {
          await sendTelegramNotification(submissionUrl, formData);
        } catch (telegramError) {
          console.error('Telegram Notification Error:', telegramError);
        }
    
        return {
          statusCode: 200,
          body: JSON.stringify({ 
            message: 'Submission successful', 
            submissionUrl: submissionUrl 
          })
        };
    
      } catch (error) {
        console.error('Unexpected Error:', error);
        return {
          statusCode: 500,
          body: JSON.stringify({ 
            message: 'Unexpected server error', 
            error: error.message 
          })
        };
      }
    };    

async function generateSASToken(blobName) {
  // Extract account key from connection string
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const accountKeyMatch = connectionString.match(/AccountKey=([^;]+)/);
  
  if (!accountKeyMatch) {
    throw new Error('Could not extract account key from connection string');
  }
  
  const accountKey = accountKeyMatch[1];

  const sharedKeyCredential = new StorageSharedKeyCredential(
    process.env.AZURE_STORAGE_ACCOUNT, 
    accountKey
  );

  const blobServiceClient = new BlobServiceClient(
    `https://${process.env.AZURE_STORAGE_ACCOUNT}.blob.core.windows.net`, 
    sharedKeyCredential
  );
  
  const containerClient = blobServiceClient.getContainerClient(process.env.AZURE_CONTAINER);
  const blobClient = containerClient.getBlobClient(blobName);

  const expiresOn = new Date();
  expiresOn.setMinutes(expiresOn.getMinutes() + 30); // Token valid for 30 minutes

  const sasOptions = {
    expiresOn,
    permissions: "r" // Read permission
  };

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: process.env.AZURE_CONTAINER,
      blobName: blobName,
      permissions: "r",
      expiresOn: expiresOn
    }, 
    sharedKeyCredential
  ).toString();

  return `${blobClient.url}?${sasToken}`;
}


async function sendTelegramNotification(submissionUrl, formData) {
  // Helper function to escape HTML special characters
  const escapeHtml = (unsafe) => {
    if (unsafe === null || unsafe === undefined) return 'N/A';
    return unsafe.toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  // Helper function to format values with HTML escaping
  const formatValue = (value, defaultValue = 'N/A') => {
    if (value === null || value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'string' && value.trim() === '') return defaultValue;
    return escapeHtml(value);
  };

  // Determine submission type
  const isFileUpload = submissionUrl.includes('blob.core.windows.net');
  const videoLinkText = isFileUpload ? 'Uploaded Video' : 'Submitted Video Link';

  const message = `
🔥 Clip Submission 🔥

👤 <b>Personal Information:</b>
• First Name: ${formatValue(formData.first_name)}
• Last Name: ${formatValue(formData.last_name)}
• Email: ${formatValue(formData.email)}

📍 <b>Location Details:</b>
• Filming Location: ${formatValue(formData.location)}

🎥 <b>Clip Metadata:</b>
• Clip Name: ${formatValue(formData.fileName)}
• ${videoLinkText}: ${escapeHtml(submissionUrl)}

📝 <b>Description:</b>
• Clip Link: ${formatValue(formData.clip_link)}
• Description: ${formatValue(formData.description)}

🏷️ <b>Credit Information:</b>
• Wants Credit: ${formData.wants_credit ? 'Yes' : 'No'}
• Recorder Name: ${formatValue(formData.recorder_name)}
• Credit Platform: ${formatValue(formData.credit_platform)}
• Credit Handle: ${formatValue(formData.credit_handle)}

💰 <b>Payment Details:</b>
• PayPal Email: ${formatValue(formData.paypal_email)}

✅ <b>Compliance & Consent:</b>
• Exclusive Agreement: ${formData.exclusiveAgreement ? 'Yes' : 'No'}
• Clip Guidelines Accepted: ${formData.clipGuidelines ? 'Yes' : 'No'}
• Age Verified: ${formData.age_verified ? 'Yes' : 'No'}
• Commercial Rights: ${formData.commercial_rights ? 'Yes' : 'No'}

🕒 <b>Submission Timestamp:</b> ${new Date().toISOString()}
`;

  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML', // Changed from Markdown to HTML
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: isFileUpload ? 'Download Video' : 'Open Video Link',
                url: submissionUrl
              }
            ]
          ]
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API Error: ${errorText}`);
    }

    console.log('Message sent to Telegram successfully');
  } catch (error) {
    console.error('Telegram Notification Error:', error);
    // Log the full error details for debugging
    console.error('Full Error:', JSON.stringify(error, null, 2));
  }
}