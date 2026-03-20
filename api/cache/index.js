const { BlockBlobClient } = require('@azure/storage-blob');
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

    // 2. Validate input (accept both JSON and form-urlencoded)
    let xml, ttl;
    
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      // JSON format (BC sends {"Xml": "...", "Ttl": 3600})
      xml = req.body.Xml || req.body.xml;
      ttl = req.body.Ttl || req.body.ttl;
    } else {
      // Form-urlencoded fallback
      xml = req.body?.xml;
      ttl = req.body?.ttl;
    }
    
    if (!xml) {
      context.res = { 
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: { error: 'Xml field is required' } 
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

    try {
      // Parse the SAS URL to extract base URL and query parameters
      // Expected format: https://account.blob.core.windows.net/container?sv=...&sig=...
      const sasUrlObj = new URL(sasUrl);
      const containerPath = sasUrlObj.pathname.replace(/^\//, '').replace(/\/$/, '');
      const baseUrl = `${sasUrlObj.protocol}//${sasUrlObj.host}/${containerPath}`;
      const sasQuery = sasUrlObj.search;
      
      // Construct full blob URL with SAS token
      const blobUrlWithSas = `${baseUrl}/${blobName}${sasQuery}`;
      
      // Create BlockBlobClient directly with the full URL
      const blockBlobClient = new BlockBlobClient(blobUrlWithSas);

      // Convert XML string to buffer
      const buffer = Buffer.from(xml, 'utf-8');

      // Calculate expiry
      const expiresAt = new Date(Date.now() + validTtl * 1000).toISOString();

      // Upload with metadata
      await blockBlobClient.upload(buffer, buffer.length, {
        blobHTTPHeaders: { blobContentType: 'text/xml; charset=utf-8' },
        metadata: { expiresAt },
      });

      // Construct the public URL (without SAS parameters for response)
      const publicUrl = `${baseUrl}/${blobName}`;

      // 5. Return response
      context.res = {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: {
          uri: publicUrl,
          blobName,
          expiresAt,
          sizeBytes: buffer.length,
        },
      };
    } catch (urlError) {
      context.log.error('SAS URL error:', urlError.message, urlError.stack);
      context.res = {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: { 
          error: 'Failed to upload to storage',
          details: 'Check that CACHE_SAS_URL is a valid blob container SAS URL',
        },
      };
      return;
    }

  } catch (error) {
    context.log.error('Cache service error:', error);
    context.res = {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: { error: error.message || 'Internal server error' },
    };
  }
};
