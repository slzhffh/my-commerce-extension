const { Core } = require('@adobe/aio-sdk');

let cachedToken = null;
let cachedExpiryMs = 0;

function normalizeImsTokenUrl(raw) {
  const fallback = 'https://ims-na1.adobelogin.com/ims/token/v2';
  if (!raw || typeof raw !== 'string') return fallback;

  const u = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/;+\s*$/g, '')
    .trim();
  return u || fallback;
}

/** IMS expects `scope` as comma-separated names, not a JSON array string. */
function scopeFormValue(scopesParam) {
  if (scopesParam == null) return '';
  const s = String(scopesParam).trim();
  if (!s.startsWith('[')) return s;

  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.filter(Boolean).join(',') : s;
  } catch {
    return s;
  }
}

async function getImsAccessToken(params) {
  if (cachedToken && Date.now() < cachedExpiryMs - 60_000) {
    return cachedToken;
  }

  const tokenUrl = normalizeImsTokenUrl(params.IMS_TOKEN_URL);
  const scope = scopeFormValue(params.IMS_OAUTH_S2S_SCOPES);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(params.IMS_OAUTH_S2S_CLIENT_ID || ''),
    client_secret: String(params.IMS_OAUTH_S2S_CLIENT_SECRET || ''),
    org_id: String(params.IMS_OAUTH_S2S_ORG_ID || ''),
    scope,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IMS token request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedExpiryMs = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/** SaaS (ACCS) uses `/V1/products/{sku}`; on-prem Magento uses `/rest/{store}/V1/...`. */
function catalogProductUrl(baseUrl, sku, p) {
  const b = String(baseUrl).replace(/\/$/, '');
  const encodedSku = encodeURIComponent(sku);

  if (/api\.commerce\.adobe\.com/i.test(b)) {
    let path = `${b}/V1/products/${encodedSku}`;
    const storeId = p && p.storeId != null ? String(p.storeId).trim() : '';
    if (storeId) {
      path += `?storeId=${encodeURIComponent(storeId)}`;
    }
    return path;
  }

  const storeCode = (p && p.COMMERCE_STORE_CODE) || 'default';
  return `${b}/rest/${encodeURIComponent(storeCode)}/V1/products/${encodedSku}`;
}

async function main(params) {
  const logger = Core.Logger('product-enrichment', {
    level: params.LOG_LEVEL || 'info',
  });

  try {
    const { sku } = params;
    if (!sku) {
      return {
        statusCode: 400,
        body: { error: 'Missing required parameter: sku' },
      };
    }

    const rawBase = params.COMMERCE_API_BASE_URL;
    if (!rawBase || typeof rawBase !== 'string') {
      return {
        statusCode: 400,
        body: { error: 'Missing COMMERCE_API_BASE_URL' },
      };
    }

    logger.info(`Fetching product data for SKU: ${sku}`);

    const baseUrl = rawBase.replace(/\/$/, '');
    const accessToken = await getImsAccessToken(params);
    const productUrl = catalogProductUrl(baseUrl, sku, params);

    const response = await fetch(productUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-api-key': params.IMS_OAUTH_S2S_CLIENT_ID,
        'x-gw-ims-org-id': params.IMS_OAUTH_S2S_ORG_ID,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error(`Commerce API ${response.status} ${productUrl}`);
      const body = {
        error: `Commerce API error: ${response.statusText}`,
        url: productUrl,
      };

      if (response.status === 404) {
        body.hint =
          'For ACCS (api.commerce.adobe.com) paths are /V1/products/{sku}, not /rest/.... Confirm SKU exists in this tenant; optional params.storeId for store scope.';
      }

      return {
        statusCode: response.status,
        body,
      };
    }

    const product = await response.json();
    const enrichedProduct = {
      sku: product.sku,
      name: product.name,
      price: product.price,
      sustainabilityScore: Math.floor(Math.random() * 40) + 60,
      estimatedDelivery: '3-5 business days',
      enrichedAt: new Date().toISOString(),
    };

    logger.info(`Successfully enriched product: ${sku}`);

    return {
      statusCode: 200,
      body: enrichedProduct,
    };
  } catch (error) {
    logger.error('Action failed:', error.message);
    return {
      statusCode: 500,
      body: { error: 'Internal server error', detail: error.message },
    };
  }
}

exports.main = main;