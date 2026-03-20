const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_TTL = 3600; // 1 hour
const MAX_TTL = 604800;   // 7 days
const MIN_TTL = 60;       // 1 minute

module.exports = async function (context, req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    context.res = {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
    return;
  }

  try {
    // 1. Validate API key
    const apiKey = req.query.key;
    const expectedKey = process.env.CACHE_API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      context.res = {
        status: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: { error: 'Unauthorized: Invalid or missing API key' },
      };
      return;
    }

    // 2. Validate input
    const { xml, ttl } = req.body || {};
    
    if (!xml) {
      context.res = { 
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: { error: 'xml field is required' } 
      };
      return;
    }

    const validTtl = Math.min(Math.max(ttl || DEFAULT_TTL, MIN_TTL), MAX_TTL);

    // 3. Generate blob name
    const guid = uuidv4().replace(/-/g, '');
    const blobName = `${guid}.xml`;

    // 4. Upload to blob storage using SAS URL
    const sasUrl = process.env.CACHE_SAS_URL;
    if (!sasUrl) {
      context.log.error('CACHE_SAS_URL environment variable not configured');
      context.res = {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: { error: 'Storage configuration missing' },
      };
      return;
    }

    const blobServiceClient = new BlobServiceClient(sasUrl);
    const containerClient = blobServiceClient.getContainerClient('');
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Convert XML string to buffer
    const buffer = Buffer.from(xml, 'utf-8');

    // Calculate expiry
    const expiresAt = new Date(Date.now() + validTtl * 1000).toISOString();

    // Upload with metadata
    await blockBlobClient.upload(buffer, buffer.length, {
      blobHTTPHeaders: { blobContentType: 'text/xml; charset=utf-8' },
      metadata: { expiresAt },
    });

    // 5. Return response
    context.res = {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: {
        uri: blockBlobClient.url,
        blobName,
        expiresAt,
        sizeBytes: buffer.length,
      },
    };

  } catch (error) {
    context.log.error('Cache service error:', error);
    context.res = {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: { error: error.message || 'Internal server error' },
    };
  }
};
