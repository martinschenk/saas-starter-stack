require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { execSync } = require('child_process');
const fetch = require('node-fetch'); // For Zoho API (compatibility with Node < 18)
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// DSGVO-konformes Analytics (keine Cookies, anonymisierte IP)
const { trackPageview, getStats, cleanupOldData } = require('./analytics');

// ============================================
// ADMIN AUTHENTICATION (Session-based)
// ============================================
const adminSessions = new Map();

// Cleanup expired sessions every hour
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  for (const [sessionId, session] of adminSessions.entries()) {
    if (now - session.created > maxAge) {
      adminSessions.delete(sessionId);
    }
  }
}, 60 * 60 * 1000);

// Auth middleware
function requireAdminAuth(req, res, next) {
  const sessionId = req.cookies?.admin_session;
  if (!sessionId || !adminSessions.has(sessionId)) {
    // API calls get 401, page requests get redirect
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/admin/login');
  }
  next();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe Mode Configuration
const STRIPE_LIVE_MODE = process.env.STRIPE_LIVE_MODE === 'true';

// Select correct Stripe keys based on mode
const STRIPE_SECRET_KEY = STRIPE_LIVE_MODE
  ? process.env.STRIPE_LIVE_SECRET_KEY
  : process.env.STRIPE_TEST_SECRET_KEY;

const STRIPE_PUBLISHABLE_KEY = STRIPE_LIVE_MODE
  ? process.env.STRIPE_LIVE_PUBLISHABLE_KEY
  : process.env.STRIPE_TEST_PUBLISHABLE_KEY;

const STRIPE_WEBHOOK_SECRET = STRIPE_LIVE_MODE
  ? process.env.STRIPE_LIVE_WEBHOOK_SECRET
  : process.env.STRIPE_TEST_WEBHOOK_SECRET;

// Initialize Stripe with correct key
const stripe = require('stripe')(STRIPE_SECRET_KEY);

// Log current mode on startup
console.log(`🔧 Stripe Mode: ${STRIPE_LIVE_MODE ? '💰 LIVE' : '🧪 TEST'}`);
console.log(`🔑 Using ${STRIPE_LIVE_MODE ? 'LIVE' : 'TEST'} keys`);
if (!STRIPE_LIVE_MODE) {
  console.log(`⚠️  Remember: Set STRIPE_LIVE_MODE=true in .env to go live!`);
}

// Zoho Invoice Integration Configuration
const ZOHO_ENABLED = process.env.ZOHO_INVOICING_ENABLED === 'true';
console.log(`📋 Zoho Invoicing: ${ZOHO_ENABLED ? '✅ ENABLED' : '❌ DISABLED'}`);

// Helper function to get Gmail password from ENV or macOS Keychain
function getGmailPassword() {
  // First try environment variable (for production servers)
  if (process.env.GMAIL_APP_PASSWORD) {
    return process.env.GMAIL_APP_PASSWORD;
  }

  // Fallback to macOS Keychain (for local development)
  try {
    const password = execSync(
      'security find-generic-password -s "Gmail App Password" -a "your-email@example.com" -w 2>/dev/null',
      { encoding: 'utf8' }
    ).trim();
    return password;
  } catch (error) {
    console.error('❌ Error getting Gmail password from Keychain:', error.message);
    console.error('💡 Set GMAIL_APP_PASSWORD environment variable for production');
    return null;
  }
}

// ============================================
// ZOHO INVOICE INTEGRATION
// ============================================

// Zoho Configuration
const ZOHO_CONFIG = {
  apiBaseUrl: 'https://www.zohoapis.com/invoice/v3',
  organizationId: '579151184',
  virtualCustomerId: process.env.ZOHO_VIRTUAL_CUSTOMER_ID || null
};

// Cache for Zoho access token
let zohoAccessTokenCache = {
  token: null,
  expiresAt: 0
};

// Get Zoho credentials from Keychain or ENV
function getZohoCredentials() {
  // Try environment variables first (production)
  if (process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN) {
    return {
      clientId: process.env.ZOHO_CLIENT_ID,
      clientSecret: process.env.ZOHO_CLIENT_SECRET,
      refreshToken: process.env.ZOHO_REFRESH_TOKEN
    };
  }

  // Fallback to macOS Keychain (local development)
  try {
    const clientId = execSync('security find-generic-password -s "Zoho Client ID" -a "zoho" -w 2>/dev/null', { encoding: 'utf8' }).trim();
    const clientSecret = execSync('security find-generic-password -s "Zoho Client Secret" -a "zoho" -w 2>/dev/null', { encoding: 'utf8' }).trim();
    const refreshToken = execSync('security find-generic-password -s "Zoho Refresh Token" -a "zoho" -w 2>/dev/null', { encoding: 'utf8' }).trim();

    return { clientId, clientSecret, refreshToken };
  } catch (error) {
    console.error('❌ Error getting Zoho credentials from Keychain:', error.message);
    return null;
  }
}

// Get Zoho Access Token (with caching)
async function getZohoAccessToken() {
  // Return cached token if still valid
  if (zohoAccessTokenCache.token && Date.now() < zohoAccessTokenCache.expiresAt) {
    return zohoAccessTokenCache.token;
  }

  const credentials = getZohoCredentials();
  if (!credentials) {
    throw new Error('Zoho credentials not found');
  }

  try {
    const response = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: credentials.refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'refresh_token'
      })
    });

    if (!response.ok) {
      throw new Error(`Zoho auth failed: ${response.status}`);
    }

    const data = await response.json();

    // Cache token for 55 minutes (expires in 60)
    zohoAccessTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (55 * 60 * 1000)
    };

    return data.access_token;
  } catch (error) {
    console.error('❌ Error getting Zoho access token:', error);
    throw error;
  }
}

// Find or create Zoho customer by email
async function findOrCreateZohoCustomer(customerData) {
  console.log('👤 [ZOHO-CUSTOMER] Finding or creating customer...', customerData.email);

  try {
    const accessToken = await getZohoAccessToken();

    // 1. Search for existing customer by email
    const searchUrl = `${ZOHO_CONFIG.apiBaseUrl}/contacts?email=${encodeURIComponent(customerData.email)}`;
    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'X-com-zoho-invoice-organizationid': ZOHO_CONFIG.organizationId
      }
    });

    if (searchResponse.ok) {
      const searchResult = await searchResponse.json();
      if (searchResult.contacts && searchResult.contacts.length > 0) {
        console.log(`🔍 [ZOHO-CUSTOMER] Found ${searchResult.contacts.length} customer(s) with email ${customerData.email}`);

        // Check if any existing customer matches: Email + Name + Country
        let matchingCustomer = null;

        for (const contact of searchResult.contacts) {
          // Compare name (case-insensitive, ignore VAT ID in brackets)
          const existingNameClean = contact.contact_name.replace(/\s*\[.*?\]\s*/g, '').trim().toLowerCase();
          const newNameClean = (customerData.name || customerData.email).trim().toLowerCase();

          // Compare country from billing address
          const existingCountry = contact.billing_address?.country_code || contact.billing_address?.country || '';
          const newCountry = customerData.country || '';

          const nameMatches = existingNameClean === newNameClean;
          const countryMatches = existingCountry.toUpperCase() === newCountry.toUpperCase();

          console.log(`  🔍 Checking: ${contact.contact_name} (${existingCountry})`);
          console.log(`     Name match: ${nameMatches} | Country match: ${countryMatches}`);

          if (nameMatches && countryMatches) {
            matchingCustomer = contact;
            console.log(`  ✅ MATCH! Using existing customer: ${contact.contact_name} (${contact.contact_id})`);
            break;
          }
        }

        // If matching customer found, use it (with potential updates)
        if (matchingCustomer) {
          // Update customer based on current payment data
          const hasVat = !!customerData.vatNumber;
          const expectedSubType = hasVat ? 'business' : 'individual';
          const needsNameUpdate = hasVat && !matchingCustomer.contact_name.includes(customerData.vatNumber);
          const needsSubTypeUpdate = matchingCustomer.customer_sub_type !== expectedSubType;

          if (needsNameUpdate || needsSubTypeUpdate) {
            console.log(`📝 [ZOHO-CUSTOMER] Updating customer data...`);

            const updatePayload = {};

            // Update name with VAT ID if needed
            if (needsNameUpdate) {
              const expectedName = `${customerData.name} [${customerData.vatNumber}]`;
              updatePayload.contact_name = expectedName;

              let cleanVatNumber = customerData.vatNumber;
              cleanVatNumber = cleanVatNumber.replace(/^[A-Z]{2}/, '');
              updatePayload.company_id = cleanVatNumber;
            }

            // Always update customer_sub_type to ensure B2B vs B2C is correct
            updatePayload.customer_sub_type = expectedSubType;
            console.log(`📝 [ZOHO-CUSTOMER] Setting customer_sub_type: ${expectedSubType} (${hasVat ? 'B2B' : 'B2C'})`);

            // Update customer
            const updateResponse = await fetch(`${ZOHO_CONFIG.apiBaseUrl}/contacts/${matchingCustomer.contact_id}`, {
              method: 'PUT',
              headers: {
                'Authorization': `Zoho-oauthtoken ${accessToken}`,
                'X-com-zoho-invoice-organizationid': ZOHO_CONFIG.organizationId,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(updatePayload)
            });

            if (updateResponse.ok) {
              console.log(`✅ [ZOHO-CUSTOMER] Customer updated`);
            } else {
              console.log(`⚠️ [ZOHO-CUSTOMER] Could not update customer (continuing anyway)`);
            }
          }

          return {
            success: true,
            customer_id: matchingCustomer.contact_id,
            existing: true
          };
        }

        // No matching customer found (email exists but different name/country)
        console.log(`⚠️ [ZOHO-CUSTOMER] Email exists but name/country differs - creating new customer`);
      }
    }

    // 2. Customer not found - create new customer
    console.log('📝 [ZOHO-CUSTOMER] Customer not found, creating new...');

    // Build contact_name with VAT number in square brackets if available
    // Example: "test deutscher laden [DE123456789]"
    // Square brackets distinguish VAT IDs from Zoho auto-generated IDs in (parentheses)
    let contactName = customerData.name || customerData.email;
    if (customerData.vatNumber) {
      contactName = `${contactName} [${customerData.vatNumber}]`;
    }

    const customerPayload = {
      contact_name: contactName,
      contact_type: 'customer',
      customer_sub_type: customerData.vatNumber ? 'business' : 'individual',  // B2B vs B2C
      // Email must be in contact_persons array with is_primary_contact: true
      contact_persons: [
        {
          email: customerData.email,
          is_primary_contact: true
        }
      ]
    };

    // Add billing address if available
    if (customerData.address) {
      // Keep line1 and line2 separate (do NOT combine them)
      // Example: address="Claudio Coello 14", street2="5G"
      // IMPORTANT: Zoho uses "address" (not "street") for the main address line
      customerPayload.billing_address = {
        address: customerData.address.line1 || '',
        street2: customerData.address.line2 || '',
        city: customerData.address.city || '',
        state: customerData.address.state || '',
        zip: customerData.address.postal_code || '',
        country: customerData.address.country || ''
      };
    }

    // Add VAT number to standard fields AND custom field
    // Zoho modern templates use company_id_number and tax_id (standard fields)
    // Custom field cf_303134000000048063 kept for backward compatibility
    // Strip country prefix (ES, DE, etc.) if present
    if (customerData.vatNumber) {
      let cleanVatNumber = customerData.vatNumber;
      // Remove country prefix (e.g., "ESB84645654" -> "B84645654")
      cleanVatNumber = cleanVatNumber.replace(/^[A-Z]{2}/, '');

      // Set standard field (appears on invoice PDF automatically)
      customerPayload.company_id = cleanVatNumber;  // ID de empresa (CIF/NIF)

      // Keep custom field for backward compatibility
      customerPayload.custom_fields = [
        {
          field_id: '303134000000048063',
          value: cleanVatNumber
        }
      ];

      console.log(`🆔 [ZOHO-CUSTOMER] Setting VAT number: ${customerData.vatNumber} -> ${cleanVatNumber} (company_id + custom_field)`);
    }

    const createResponse = await fetch(`${ZOHO_CONFIG.apiBaseUrl}/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'X-com-zoho-invoice-organizationid': ZOHO_CONFIG.organizationId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(customerPayload)
    });

    if (!createResponse.ok) {
      const errorData = await createResponse.text();

      // Handle "customer already exists" error
      if (errorData.includes('ya existe') || errorData.includes('already exists')) {
        console.log('⚠️ [ZOHO-CUSTOMER] Customer name already exists, adding timestamp to name');
        // Add timestamp to make name unique
        const timestamp = Date.now().toString().slice(-6);
        customerPayload.contact_name = `${customerData.name || customerData.email} (${timestamp})`;

        // Retry with modified name
        const retryResponse = await fetch(`${ZOHO_CONFIG.apiBaseUrl}/contacts`, {
          method: 'POST',
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'X-com-zoho-invoice-organizationid': ZOHO_CONFIG.organizationId,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(customerPayload)
        });

        if (!retryResponse.ok) {
          const retryErrorData = await retryResponse.text();
          throw new Error(`Zoho customer creation error (retry): ${retryResponse.status} - ${retryErrorData}`);
        }

        const retryResult = await retryResponse.json();
        if (retryResult.code === 0) {
          console.log('✅ [ZOHO-CUSTOMER] Customer created with modified name:', retryResult.contact.contact_id);
          return {
            success: true,
            customer_id: retryResult.contact.contact_id,
            existing: false
          };
        } else {
          throw new Error(`Zoho customer error (retry): ${retryResult.message}`);
        }
      }

      throw new Error(`Zoho customer creation error: ${createResponse.status} - ${errorData}`);
    }

    const createResult = await createResponse.json();

    if (createResult.code === 0) {
      console.log('✅ [ZOHO-CUSTOMER] Customer created:', createResult.contact.contact_id);
      return {
        success: true,
        customer_id: createResult.contact.contact_id,
        existing: false
      };
    } else {
      throw new Error(`Zoho customer error: ${createResult.message}`);
    }
  } catch (error) {
    console.error('❌ [ZOHO-CUSTOMER] Error finding/creating customer:', error);
    return { success: false, error: error.message };
  }
}

// ===== ZOHO TAX CONFIGURATION =====
// Tax IDs from Zoho (retrieved via get-zoho-taxes.js)
const ZOHO_TAX_IDS = {
  IVA_21: '303134000000044019',  // Spain standard VAT 21%
  IVA_10: '303134000003174029',  // Spain reduced VAT 10%
  EXENTO_0: '303134000000205025' // 0% for Reverse Charge / Non-EU
};

// EU Countries (for VAT treatment)
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
];

// Check if country is in EU
function isEUCountry(country) {
  return EU_COUNTRIES.includes(country?.toUpperCase());
}

// NOTE: vat_treatment field is UK-ONLY and not applicable to Spain
// We don't need it - tax_id alone handles all scenarios correctly

// Get Zoho Tax ID based on tax scenario
function getZohoTaxId(invoiceData) {
  const country = invoiceData.country?.toUpperCase();
  const taxRatePercentage = invoiceData.taxRatePercentage || 0;
  const hasVatId = !!invoiceData.vatNumber;

  console.log(`🔍 [TAX] Determining tax ID for: Country=${country}, Rate=${taxRatePercentage}%, HasVAT=${hasVatId}`);

  // Scenario 1 & 2: Spain (Private or Business) - 21% IVA
  if (country === 'ES' && taxRatePercentage === 21) {
    console.log('   → Spain IVA 21%');
    return ZOHO_TAX_IDS.IVA_21;
  }

  // Spain reduced rate (10%)
  if (country === 'ES' && taxRatePercentage === 10) {
    console.log('   → Spain IVA 10%');
    return ZOHO_TAX_IDS.IVA_10;
  }

  // Scenario 4: EU B2B with valid VAT ID - 0% Reverse Charge
  if (isEUCountry(country) && country !== 'ES' && hasVatId) {
    console.log('   → EU B2B Reverse Charge (0%)');
    return ZOHO_TAX_IDS.EXENTO_0;
  }

  // Scenario 3: EU Private (B2C) - Use their country's VAT rate
  // Note: For simplicity, we're using Spain's IVA rate as fallback
  // In a full implementation, you'd map each EU country's VAT rate to a Zoho tax_id
  if (isEUCountry(country) && country !== 'ES' && !hasVatId) {
    console.log(`   → EU B2C (${country}) - Using ${taxRatePercentage}% (fallback: IVA 21%)`);
    // If Stripe calculated tax, use IVA 21% as closest match
    // TODO: Create specific tax IDs for other EU countries if needed
    if (taxRatePercentage > 0) {
      return ZOHO_TAX_IDS.IVA_21; // Fallback
    }
    return ZOHO_TAX_IDS.EXENTO_0;
  }

  // Scenario 5: Non-EU - 0% Tax
  if (!isEUCountry(country)) {
    console.log('   → Non-EU (0%)');
    return ZOHO_TAX_IDS.EXENTO_0;
  }

  // Default: 0% if no tax
  if (taxRatePercentage === 0) {
    console.log('   → No tax (0%)');
    return ZOHO_TAX_IDS.EXENTO_0;
  }

  // Fallback
  console.log(`   → Fallback: IVA 21%`);
  return ZOHO_TAX_IDS.IVA_21;
}
// ===== END TAX CONFIGURATION =====

// Create Zoho Invoice
async function createZohoInvoice(invoiceData) {
  console.log('💼 [ZOHO] Creating invoice...', invoiceData);

  try {
    const accessToken = await getZohoAccessToken();

    // 1. Find or create customer first
    const customerResult = await findOrCreateZohoCustomer({
      email: invoiceData.customerEmail,
      name: invoiceData.customerName,
      address: invoiceData.customerAddress,
      vatNumber: invoiceData.vatNumber
    });

    if (!customerResult.success) {
      throw new Error(`Customer lookup/creation failed: ${customerResult.error}`);
    }

    const customerId = customerResult.customer_id;
    console.log(`👤 [ZOHO] Using customer ID: ${customerId} (${customerResult.existing ? 'existing' : 'new'})`);

    // Build line item with tax information
    // Use discreet product name for invoices
    const isSubscription = invoiceData.paymentType === 'subscription';
    const productName = isSubscription ? 'allgood.click suscripción' : 'allgood.click servicio online';

    // SIMPLE TAX MAPPING: Stripe percentage → Zoho Tax ID
    // No country-specific logic needed - Stripe calculates everything!
    // NOTE: You need to create these tax rates in your Zoho Invoice account
    // and replace these placeholder IDs with your actual Zoho Tax IDs
    const TAX_IDS = {
      0: 'YOUR_ZOHO_TAX_ID_0_PERCENT',   // Tax 0%
      1: 'YOUR_ZOHO_TAX_ID_1_PERCENT',   // Tax 1%
      2: 'YOUR_ZOHO_TAX_ID_2_PERCENT',   // Tax 2%
      3: 'YOUR_ZOHO_TAX_ID_3_PERCENT',   // Tax 3%
      4: 'YOUR_ZOHO_TAX_ID_4_PERCENT',   // Tax 4%
      5: 'YOUR_ZOHO_TAX_ID_5_PERCENT',   // Tax 5%
      6: 'YOUR_ZOHO_TAX_ID_6_PERCENT',   // Tax 6%
      7: 'YOUR_ZOHO_TAX_ID_7_PERCENT',   // Tax 7%
      8: 'YOUR_ZOHO_TAX_ID_8_PERCENT',   // Tax 8%
      9: 'YOUR_ZOHO_TAX_ID_9_PERCENT',   // Tax 9%
      10: 'YOUR_ZOHO_TAX_ID_10_PERCENT', // Tax 10%
      11: 'YOUR_ZOHO_TAX_ID_11_PERCENT', // Tax 11%
      12: 'YOUR_ZOHO_TAX_ID_12_PERCENT', // Tax 12%
      13: 'YOUR_ZOHO_TAX_ID_13_PERCENT', // Tax 13%
      14: 'YOUR_ZOHO_TAX_ID_14_PERCENT', // Tax 14%
      15: 'YOUR_ZOHO_TAX_ID_15_PERCENT', // Tax 15%
      16: 'YOUR_ZOHO_TAX_ID_16_PERCENT', // Tax 16%
      17: 'YOUR_ZOHO_TAX_ID_17_PERCENT', // Tax 17%
      18: 'YOUR_ZOHO_TAX_ID_18_PERCENT', // Tax 18%
      19: 'YOUR_ZOHO_TAX_ID_19_PERCENT', // Tax 19%
      20: 'YOUR_ZOHO_TAX_ID_20_PERCENT', // Tax 20%
      21: 'YOUR_ZOHO_TAX_ID_21_PERCENT', // Tax 21%
      22: 'YOUR_ZOHO_TAX_ID_22_PERCENT', // Tax 22%
      23: 'YOUR_ZOHO_TAX_ID_23_PERCENT', // Tax 23%
      24: 'YOUR_ZOHO_TAX_ID_24_PERCENT', // Tax 24%
      25: 'YOUR_ZOHO_TAX_ID_25_PERCENT', // Tax 25%
      26: 'YOUR_ZOHO_TAX_ID_26_PERCENT', // Tax 26%
      27: 'YOUR_ZOHO_TAX_ID_27_PERCENT', // Tax 27%
      28: 'YOUR_ZOHO_TAX_ID_28_PERCENT', // Tax 28%
      29: 'YOUR_ZOHO_TAX_ID_29_PERCENT', // Tax 29%
      30: 'YOUR_ZOHO_TAX_ID_30_PERCENT', // Tax 30%
      // Add more if needed (31-40%)
    };

    const taxRatePercentage = invoiceData.taxRatePercentage || 0;
    const roundedTax = Math.round(taxRatePercentage);
    const taxId = TAX_IDS[roundedTax];

    if (!taxId) {
      const errorMsg = `No tax mapping for ${taxRatePercentage}% (rounded: ${roundedTax}%). Tax rates 0-40% supported.`;
      console.error(`❌ [ZOHO] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    console.log(`💰 [ZOHO] Using Tax ${roundedTax}% (ID: ${taxId}) from Stripe's ${taxRatePercentage}%`);

    // SIMPLE: Use Stripe's subtotal directly (Stripe has already calculated everything correctly!)
    // No need to calculate ourselves - Stripe is always right!
    const netAmount = invoiceData.subtotal;
    console.log(`💰 [ZOHO] Using Stripe's subtotal: ${netAmount} EUR (Tax: ${invoiceData.taxAmount} EUR, Total: ${invoiceData.amount} EUR)`);
    console.log(`📊 [ZOHO] Tax rate: ${taxRatePercentage}%`);

    // Build line item with net amount (Zoho will add tax on top)
    const lineItem = {
      name: productName,
      description: '', // Keep description empty to avoid duplication
      rate: netAmount, // Net amount (Zoho adds tax to reach total)
      quantity: 1,
      tax_id: taxId
    };

    // Set order number (número de orden) for internal tracking
    const orderType = isSubscription ? 'abo' : 'unico';
    const orderNumber = `allgood-${orderType}`;

    // Build notes in Spanish for ES invoices, German for others
    const isSpanishInvoice = invoiceData.country === 'ES';
    const paymentTypeText = isSubscription
      ? (isSpanishInvoice ? 'Suscripción mensual' : 'Monatliches Abo')
      : (isSpanishInvoice ? 'Pago único' : 'Einmalzahlung');
    const dateLabel = isSpanishInvoice ? 'Fecha' : 'Datum';

    // Prepare invoice notes with optional TEST marker
    let invoiceNotes = `Stripe Checkout Session: ${invoiceData.stripeSessionId}\nPayment Intent: ${invoiceData.paymentIntentId || 'N/A'}\nTipo: ${paymentTypeText}\n${dateLabel}: ${new Date().toLocaleString(isSpanishInvoice ? 'es-ES' : 'de-DE')}`;

    // Add TEST marker if this is a test payment
    if (invoiceData.isTestMode) {
      const testMarker = isSpanishInvoice
        ? '🧪 FACTURA DE PRUEBA - Esta es una factura de prueba de Stripe, no una transacción real.\n\n'
        : '🧪 TEST RECHNUNG - Dies ist eine Stripe-Testrechnung, keine echte Transaktion.\n\n';
      invoiceNotes = testMarker + invoiceNotes;
    }

    const invoicePayload = {
      customer_id: customerId, // Use REAL customer ID, not virtual customer
      line_items: [lineItem],
      currency_code: invoiceData.currency.toUpperCase(),
      is_inclusive_tax: false, // ✅ We send net amount, Zoho adds tax on top to reach total
      // NOTE: vat_treatment field NOT used - it's UK-only and causes errors for Spain
      // tax_id alone handles all tax scenarios (ES, EU B2B, EU B2C, Non-EU)
      reference_number: orderNumber, // número de orden: allgood-unico or allgood-abo
      notes: invoiceNotes
    };

    // place_of_supply is INDIA-ONLY for GST (state codes like TN, MH, etc.)
    // For EU/international customers, DO NOT set this field - it will cause errors
    // Zoho will use the contact's place_of_contact by default
    console.log(`🌍 [ZOHO] Customer country: ${invoiceData.country || 'N/A'} (place_of_supply not set for non-India)`);

    const response = await fetch(`${ZOHO_CONFIG.apiBaseUrl}/invoices`, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'X-com-zoho-invoice-organizationid': ZOHO_CONFIG.organizationId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(invoicePayload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Zoho API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();

    if (result.code === 0) {
      console.log('✅ [ZOHO] Invoice created:', result.invoice.invoice_number);
      return {
        success: true,
        invoice_number: result.invoice.invoice_number,
        invoice_id: result.invoice.invoice_id,
        customer_id: customerId, // Include customer ID for payment recording
        invoice_url: `https://invoice.zoho.com/app#/invoices/${result.invoice.invoice_id}`,
        data: invoiceData
      };
    } else {
      throw new Error(`Zoho error: ${result.message}`);
    }
  } catch (error) {
    console.error('❌ [ZOHO] Error creating invoice:', error);
    return { success: false, error: error.message };
  }
}

// Send Zoho invoice email to customer
async function sendZohoInvoiceEmail(invoiceId, customerEmail) {
  console.log('📧 [ZOHO-EMAIL] Sending invoice email to customer...', { invoiceId, customerEmail });

  try {
    const accessToken = await getZohoAccessToken();

    const response = await fetch(`${ZOHO_CONFIG.apiBaseUrl}/invoices/${invoiceId}/email`, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'X-com-zoho-invoice-organizationid': ZOHO_CONFIG.organizationId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to_mail_ids: [customerEmail]
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Zoho email API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();

    if (result.code === 0) {
      console.log('✅ [ZOHO-EMAIL] Invoice email sent successfully');
      return { success: true };
    } else {
      throw new Error(`Zoho email error: ${result.message}`);
    }
  } catch (error) {
    console.error('❌ [ZOHO-EMAIL] Error sending invoice email:', error);
    return { success: false, error: error.message };
  }
}

// Record payment in Zoho (mark invoice as paid)
async function recordZohoPayment(paymentData) {
  console.log('💰 [ZOHO-PAYMENT] Recording payment...', paymentData);

  try {
    const accessToken = await getZohoAccessToken();

    const paymentPayload = {
      customer_id: paymentData.customerId, // Use REAL customer ID
      payment_mode: 'creditcard', // Stripe = Credit card payment
      amount: paymentData.amount,
      date: new Date().toISOString().split('T')[0], // yyyy-mm-dd format
      reference_number: paymentData.paymentIntentId, // Stripe Payment Intent ID
      description: `Stripe Payment: ${paymentData.paymentIntentId}`,
      invoices: [
        {
          invoice_id: paymentData.invoiceId,
          amount_applied: paymentData.amount
        }
      ]
    };

    const response = await fetch(`${ZOHO_CONFIG.apiBaseUrl}/customerpayments`, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'X-com-zoho-invoice-organizationid': ZOHO_CONFIG.organizationId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentPayload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Zoho payment API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();

    if (result.code === 0) {
      console.log('✅ [ZOHO-PAYMENT] Payment recorded successfully');
      return { success: true, payment_id: result.payment.payment_id };
    } else {
      throw new Error(`Zoho payment error: ${result.message}`);
    }
  } catch (error) {
    console.error('❌ [ZOHO-PAYMENT] Error recording payment:', error);
    return { success: false, error: error.message };
  }
}

// Send green OK email for successful Zoho invoice
async function sendZohoOKEmail(invoiceInfo) {
  console.log('📧 [ZOHO-EMAIL] Sending OK email...');

  const gmailPassword = getGmailPassword();
  if (!gmailPassword) {
    console.error('❌ [ZOHO-EMAIL] Cannot send email: Gmail password not found');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: 'your-email@example.com',
      pass: gmailPassword
    }
  });

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 40px 20px;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
              <!-- Header -->
              <tr>
                <td style="background: linear-gradient(135deg, #27AE60 0%, #2ecc71 100%); padding: 40px; text-align: center; border-radius: 8px 8px 0 0;">
                  <div style="font-size: 60px; margin-bottom: 10px;">✓</div>
                  <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Rechnung automatisch erstellt</h1>
                  <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">allgood.click - Zoho Invoice</p>
                </td>
              </tr>

              <!-- Content -->
              <tr>
                <td style="padding: 40px;">
                  <div style="background-color: #f0f9f4; border-left: 4px solid #27AE60; padding: 20px; margin-bottom: 30px; border-radius: 4px;">
                    <p style="color: #27AE60; margin: 0; font-weight: 600; font-size: 18px;">✅ Alles OK - keine Aktion nötig</p>
                  </div>

                  <h2 style="color: #333; font-size: 16px; font-weight: 600; margin: 0 0 20px 0; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #27AE60; padding-bottom: 10px;">Rechnungsdetails</h2>

                  <table width="100%" cellpadding="8" cellspacing="0" style="margin-bottom: 30px;">
                    <tr>
                      <td style="color: #666; font-size: 14px; padding: 12px 0; border-bottom: 1px solid #eee;"><strong>Rechnung:</strong></td>
                      <td style="color: #333; font-size: 14px; padding: 12px 0; border-bottom: 1px solid #eee; text-align: right;"><strong>${invoiceInfo.invoice_number}</strong></td>
                    </tr>
                    <tr>
                      <td style="color: #666; font-size: 14px; padding: 12px 0; border-bottom: 1px solid #eee;">Produkt:</td>
                      <td style="color: #333; font-size: 14px; padding: 12px 0; border-bottom: 1px solid #eee; text-align: right;">${invoiceInfo.data.productName}</td>
                    </tr>
                    <tr>
                      <td style="color: #666; font-size: 14px; padding: 12px 0; border-bottom: 1px solid #eee;">Betrag:</td>
                      <td style="color: #27AE60; font-size: 16px; font-weight: 600; padding: 12px 0; border-bottom: 1px solid #eee; text-align: right;">${invoiceInfo.data.amount.toFixed(2)} ${invoiceInfo.data.currency.toUpperCase()}</td>
                    </tr>
                    <tr>
                      <td style="color: #666; font-size: 14px; padding: 12px 0; border-bottom: 1px solid #eee;">Kunde:</td>
                      <td style="color: #333; font-size: 14px; padding: 12px 0; border-bottom: 1px solid #eee; text-align: right;">${invoiceInfo.data.customerEmail}</td>
                    </tr>
                    <tr>
                      <td style="color: #666; font-size: 14px; padding: 12px 0; border-bottom: 1px solid #eee;">Typ:</td>
                      <td style="color: #333; font-size: 14px; padding: 12px 0; border-bottom: 1px solid #eee; text-align: right;">${invoiceInfo.data.paymentType === 'subscription' ? 'Monatliches Abo' : 'Einmalzahlung'}</td>
                    </tr>
                  </table>

                  <div style="text-align: center; margin: 30px 0;">
                    <a href="${invoiceInfo.invoice_url}" style="display: inline-block; background-color: #27AE60; color: white; padding: 14px 30px; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Rechnung in Zoho ansehen</a>
                  </div>

                  <div style="background-color: #f8f8f8; padding: 15px; border-radius: 4px; margin-top: 30px;">
                    <p style="color: #666; font-size: 12px; margin: 0 0 5px 0;"><strong>🔗 Stripe Session:</strong> ${invoiceInfo.data.stripeSessionId}</p>
                    ${invoiceInfo.data.paymentIntentId ? `<p style="color: #666; font-size: 12px; margin: 0;"><strong>💳 Payment Intent:</strong> ${invoiceInfo.data.paymentIntentId}</p>` : ''}
                  </div>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background-color: #f8f8f8; padding: 20px; text-align: center; border-radius: 0 0 8px 8px;">
                  <p style="color: #999; font-size: 12px; margin: 0;">Diese Email wurde automatisch generiert.</p>
                  <p style="color: #999; font-size: 12px; margin: 5px 0 0 0;">Martin Schenk S.L. - allgood.click</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  try {
    await transporter.sendMail({
      from: '"allgood.click" <your-email@example.com>',
      to: 'your-email@example.com',
      subject: `✅ Rechnung erstellt: ${invoiceInfo.invoice_number}`,
      html: htmlContent
    });

    console.log('✅ [ZOHO-EMAIL] OK email sent successfully');
    return true;
  } catch (error) {
    console.error('❌ [ZOHO-EMAIL] Error sending email:', error);
    return false;
  }
}

// Send red error email for failed Zoho invoice
async function sendZohoErrorEmail(errorInfo) {
  console.log('📧 [ZOHO-EMAIL] Sending error email...');

  const gmailPassword = getGmailPassword();
  if (!gmailPassword) return false;

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: 'your-email@example.com',
      pass: gmailPassword
    }
  });

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 40px 20px;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
              <tr>
                <td style="background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); padding: 40px; text-align: center; border-radius: 8px 8px 0 0;">
                  <div style="font-size: 60px; margin-bottom: 10px;">⚠️</div>
                  <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Rechnung konnte nicht erstellt werden</h1>
                  <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">Manuelle Aktion erforderlich</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 40px;">
                  <p style="color: #333; font-size: 16px; margin: 0 0 20px 0;">Beim Erstellen der Zoho Rechnung ist ein Fehler aufgetreten:</p>
                  <div style="background-color: #fff5f5; border-left: 4px solid #e74c3c; padding: 20px; margin-bottom: 20px; border-radius: 4px;">
                    <p style="color: #e74c3c; margin: 0; font-family: monospace; font-size: 14px; word-break: break-all;">${errorInfo.error || 'Unknown error'}</p>
                  </div>
                  ${errorInfo.stripeSessionId ? `<p style="color: #666; font-size: 14px;"><strong>Stripe Session:</strong> ${errorInfo.stripeSessionId}</p>` : ''}
                  <p style="color: #666; font-size: 14px; margin-top: 20px;">Bitte erstelle die Rechnung manuell in Zoho.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  try {
    await transporter.sendMail({
      from: '"allgood.click" <your-email@example.com>',
      to: 'your-email@example.com',
      subject: '⚠️ Zoho Rechnung Fehler - Manuelle Aktion erforderlich',
      html: htmlContent
    });

    console.log('✅ [ZOHO-EMAIL] Error email sent successfully');
    return true;
  } catch (error) {
    console.error('❌ [ZOHO-EMAIL] Error sending error email:', error);
    return false;
  }
}

// ============================================
// END ZOHO INVOICE INTEGRATION
// ============================================

// Email sending function with green/red templates
async function sendPaymentNotification(type, data, testMode = false) {
  console.log('📧 [EMAIL] Starting sendPaymentNotification...');
  console.log('📧 [EMAIL] Type:', type);
  console.log('📧 [EMAIL] Test Mode:', testMode);
  console.log('📧 [EMAIL] Data:', JSON.stringify(data, null, 2));

  const gmailPassword = getGmailPassword();

  if (!gmailPassword) {
    console.error('❌ [EMAIL] Cannot send email: Gmail password not found');
    return false;
  }

  console.log('✅ [EMAIL] Gmail password retrieved successfully');

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: 'your-email@example.com',
      pass: gmailPassword
    }
  });

  let subject, html, text;

  if (type === 'success') {
    // Green success email
    const modeLabel = testMode ? '🧪 TEST MODE' : '💰 LIVE MODE';
    const modeBadgeColor = testMode ? '#f39c12' : '#27ae60';

    // Determine payment type label
    const paymentTypeLabel = data.paymentType === 'subscription' ? 'Monats-Abo' : 'Einmalzahlung';

    subject = testMode
      ? `🧪 TEST - allgood.click - ${paymentTypeLabel} erhalten!`
      : `✅ allgood.click - ${paymentTypeLabel} erhalten!`;

    // Build subscription cancellation section if applicable
    const subscriptionSection = data.paymentType === 'subscription' ? `
      <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 20px; margin-top: 20px; border-radius: 5px;">
        <h3 style="color: #856404; margin: 0 0 10px 0; font-size: 16px;">📋 Abo-Verwaltung</h3>
        <p style="color: #856404; margin: 0 0 10px 0; font-size: 14px;">
          Du kannst dein Abo jederzeit kündigen oder deine Zahlungsmethode ändern.
        </p>
        ${data.customerId ? `
        <div style="text-align: center; margin: 15px 0;">
          <a href="https://allgood.click/manage-subscription.html?customer=${data.customerId}"
             style="display: inline-block; background-color: #ffc107; color: #000; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 14px;">
            Abo verwalten
          </a>
        </div>
        ` : ''}
        <p style="color: #856404; margin: 10px 0 0 0; font-size: 12px;">
          Oder schreib uns einfach: <a href="mailto:support@allgood.click" style="color: #856404;">support@allgood.click</a>
        </p>
      </div>
    ` : '';

    // Build billing address section if available
    let addressSection = '';
    if (data.customerAddress || data.vatNumber) {
      addressSection = '<div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0;">';
      addressSection += '<h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">📍 Rechnungsadresse</h3>';

      if (data.customerName) {
        addressSection += `<p style="font-size: 14px; color: #666; margin: 5px 0;"><strong>Name:</strong> ${data.customerName}</p>`;
      }

      if (data.customerAddress) {
        const addr = data.customerAddress;
        if (addr.line1) addressSection += `<p style="font-size: 14px; color: #666; margin: 5px 0;">${addr.line1}</p>`;
        if (addr.line2) addressSection += `<p style="font-size: 14px; color: #666; margin: 5px 0;">${addr.line2}</p>`;

        let cityLine = '';
        if (addr.postal_code) cityLine += addr.postal_code + ' ';
        if (addr.city) cityLine += addr.city;
        if (cityLine) addressSection += `<p style="font-size: 14px; color: #666; margin: 5px 0;">${cityLine}</p>`;

        if (addr.state) addressSection += `<p style="font-size: 14px; color: #666; margin: 5px 0;">${addr.state}</p>`;
        if (addr.country) addressSection += `<p style="font-size: 14px; color: #666; margin: 5px 0;">${addr.country}</p>`;
      }

      if (data.vatNumber) {
        // Determine label based on country
        const countryCode = data.customerAddress?.country || '';
        let vatLabel = 'VAT/USt-ID';
        if (countryCode === 'ES') vatLabel = 'NIF';
        else if (countryCode === 'DE') vatLabel = 'USt-ID';
        else if (countryCode === 'AT') vatLabel = 'UID';
        else if (countryCode === 'CH') vatLabel = 'CHE-Nr';

        addressSection += `<p style="font-size: 14px; color: #666; margin: 10px 0 5px 0;"><strong>${vatLabel}:</strong> ${data.vatNumber}</p>`;
      }

      addressSection += '</div>';
    }

    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); padding: 40px; border-radius: 10px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <span style="background: ${modeBadgeColor}; color: white; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px;">${modeLabel}</span>
        </div>
        <h1 style="color: white; text-align: center;">✅ Zahlung erfolgreich!</h1>
        <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 20px;">
          <p style="font-size: 18px; color: #333;"><strong>Zahlungsart:</strong> ${paymentTypeLabel}</p>
          <p style="font-size: 18px; color: #333;"><strong>Betrag:</strong> ${data.amount} ${data.currency.toUpperCase()}</p>
          <p style="font-size: 16px; color: #666;"><strong>Session ID:</strong> ${data.sessionId}</p>
          <p style="font-size: 16px; color: #666;"><strong>Email:</strong> ${data.customerEmail || 'N/A'}</p>
          <p style="font-size: 16px; color: #666;"><strong>Zeit:</strong> ${new Date().toLocaleString('de-DE')}</p>
          ${addressSection}
          ${subscriptionSection}
        </div>
        <p style="color: white; text-align: center; margin-top: 20px; font-size: 14px;">Everything is OK! 🎉</p>
      </div>
    `;
    // Build text version with address
    let textContent = `${modeLabel}\n\n✅ Zahlung erfolgreich!\n\nZahlungsart: ${paymentTypeLabel}\nBetrag: ${data.amount} ${data.currency.toUpperCase()}\nSession ID: ${data.sessionId}\nEmail: ${data.customerEmail || 'N/A'}\nZeit: ${new Date().toLocaleString('de-DE')}`;

    if (data.customerAddress || data.vatNumber) {
      textContent += '\n\n--- Rechnungsadresse ---';
      if (data.customerName) textContent += `\nName: ${data.customerName}`;
      if (data.customerAddress) {
        const addr = data.customerAddress;
        if (addr.line1) textContent += `\n${addr.line1}`;
        if (addr.line2) textContent += `\n${addr.line2}`;
        let cityLine = '';
        if (addr.postal_code) cityLine += addr.postal_code + ' ';
        if (addr.city) cityLine += addr.city;
        if (cityLine) textContent += `\n${cityLine}`;
        if (addr.state) textContent += `\n${addr.state}`;
        if (addr.country) textContent += `\n${addr.country}`;
      }
      if (data.vatNumber) {
        const countryCode = data.customerAddress?.country || '';
        let vatLabel = 'VAT/USt-ID';
        if (countryCode === 'ES') vatLabel = 'NIF';
        else if (countryCode === 'DE') vatLabel = 'USt-ID';
        else if (countryCode === 'AT') vatLabel = 'UID';
        else if (countryCode === 'CH') vatLabel = 'CHE-Nr';
        textContent += `\n${vatLabel}: ${data.vatNumber}`;
      }
    }

    text = textContent;
  } else {
    // Red error email
    const modeLabel = testMode ? '🧪 TEST MODE' : '💰 LIVE MODE';
    const modeBadgeColor = testMode ? '#f39c12' : '#27ae60';

    subject = testMode
      ? '🧪 TEST - allgood.click - Zahlungsfehler!'
      : '❌ allgood.click - Zahlungsfehler!';

    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); padding: 40px; border-radius: 10px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <span style="background: ${modeBadgeColor}; color: white; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px;">${modeLabel}</span>
        </div>
        <h1 style="color: white; text-align: center;">❌ Zahlungsfehler!</h1>
        <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 20px;">
          <p style="font-size: 18px; color: #e74c3c;"><strong>Fehler:</strong> ${data.error}</p>
          <p style="font-size: 16px; color: #666;"><strong>Payment Intent ID:</strong> ${data.paymentIntentId || 'N/A'}</p>
          <p style="font-size: 16px; color: #666;"><strong>Zeit:</strong> ${new Date().toLocaleString('de-DE')}</p>
          <pre style="background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto;">${data.details || 'Keine weiteren Details verfügbar'}</pre>
        </div>
        <p style="color: white; text-align: center; margin-top: 20px; font-size: 14px;">Something is NOT OK! 😞</p>
      </div>
    `;
    text = `${modeLabel}\n\n❌ Zahlungsfehler!\n\nFehler: ${data.error}\nPayment Intent ID: ${data.paymentIntentId || 'N/A'}\nZeit: ${new Date().toLocaleString('de-DE')}\n\nDetails:\n${data.details || 'Keine weiteren Details verfügbar'}`;
  }

  console.log('📧 [EMAIL] Preparing to send email...');
  console.log('📧 [EMAIL] Subject:', subject);
  console.log('📧 [EMAIL] To: your-email@example.com');

  try {
    console.log('📧 [EMAIL] Calling transporter.sendMail...');
    const info = await transporter.sendMail({
      from: 'allgood.click <your-email@example.com>',
      to: 'your-email@example.com',
      subject: subject,
      text: text,
      html: html
    });
    console.log('✅ [EMAIL] Email sent successfully!');
    console.log('📧 [EMAIL] MessageId:', info.messageId);
    console.log('📧 [EMAIL] Response:', info.response);
    return true;
  } catch (error) {
    console.error('❌ [EMAIL] Error sending email:', error.message);
    console.error('❌ [EMAIL] Error stack:', error.stack);
    return false;
  }
}

// Middleware
// IMPORTANT: Webhook endpoint needs raw body BEFORE express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));

// Regular JSON parsing for other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For form data (login)
app.use(cookieParser()); // For session cookies

// Version for cache busting (updated automatically from package.json)
const APP_VERSION = require('./package.json').version;

// Version API endpoint for frontend
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// Stripe configuration endpoint for frontend
app.get('/api/stripe-config', (req, res) => {
  res.json({
    publishableKey: STRIPE_PUBLISHABLE_KEY,
    isLiveMode: STRIPE_LIVE_MODE
  });
});

// Function to serve index.html with SEO meta tags
function serveIndexWithMeta(req, res, lang) {
  const locale = loadLocale(lang);
  const baseUrl = 'https://allgood.click';

  // Map language codes to locale codes for og:locale
  const localeMap = {
    'en': 'en_US',
    'de': 'de_DE',
    'es': 'es_ES',
    'fr': 'fr_FR',
    'pt': 'pt_BR'
  };

  // Read index.html
  const indexPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  // Generate hreflang links
  const hreflangLinks = `
    <link rel="alternate" hreflang="en" href="${baseUrl}/" />
    <link rel="alternate" hreflang="de" href="${baseUrl}/de/" />
    <link rel="alternate" hreflang="es" href="${baseUrl}/es/" />
    <link rel="alternate" hreflang="fr" href="${baseUrl}/fr/" />
    <link rel="alternate" hreflang="pt" href="${baseUrl}/pt/" />
    <link rel="alternate" hreflang="x-default" href="${baseUrl}/" />`;

  // Generate canonical URL
  const canonicalUrl = lang === 'en' ? baseUrl + '/' : baseUrl + '/' + lang + '/';

  // Replace meta tags
  html = html.replace('<html lang="en">', `<html lang="${lang}">`);
  html = html.replace(/<title>.*?<\/title>/, `<title>${locale.pageTitle}</title>`);
  html = html.replace(/<meta name="description".*?>/, `<meta name="description" content="${locale.metaDescription}">
    <meta name="keywords" content="${locale.metaKeywords}">
    <link rel="canonical" href="${canonicalUrl}">
    ${hreflangLinks}
    <meta property="og:title" content="${locale.ogTitle}">
    <meta property="og:description" content="${locale.ogDescription}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:type" content="website">
    <meta property="og:locale" content="${localeMap[lang]}">
    <meta property="og:site_name" content="allgood.click">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${locale.ogTitle}">
    <meta name="twitter:description" content="${locale.ogDescription}">`);

  res.send(html);
}

// Success Page Preview (for testing without payment)
app.get('/success-preview', (req, res) => {
  console.log('📺 [PREVIEW] Success page preview requested');
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

// Language-specific routes (SEO-friendly URLs) - MUST be before express.static!
// Mit DSGVO-konformem Analytics Tracking
app.get('/de/', (req, res) => { trackPageview(req, '/de/'); serveIndexWithMeta(req, res, 'de'); });
app.get('/es/', (req, res) => { trackPageview(req, '/es/'); serveIndexWithMeta(req, res, 'es'); });
app.get('/fr/', (req, res) => { trackPageview(req, '/fr/'); serveIndexWithMeta(req, res, 'fr'); });
app.get('/pt/', (req, res) => { trackPageview(req, '/pt/'); serveIndexWithMeta(req, res, 'pt'); });
app.get('/', (req, res) => { trackPageview(req, '/'); serveIndexWithMeta(req, res, 'en'); });

// ============================================
// ADMIN ROUTES (Passwort-geschützt)
// ============================================

// SEO-Schutz für alle Admin-Routen
app.use('/admin', (req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Login-Seite anzeigen
app.get('/admin/login', (req, res) => {
  // Wenn bereits eingeloggt, redirect zu stats
  const sessionId = req.cookies?.admin_session;
  if (sessionId && adminSessions.has(sessionId)) {
    return res.redirect('/admin/stats');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'));
});

// Login verarbeiten
app.post('/admin/login', (req, res) => {
  const password = req.body.password;
  const correctPassword = process.env.STATS_PASSWORD;

  if (!correctPassword) {
    console.error('STATS_PASSWORD not set in .env!');
    return res.redirect('/admin/login?error=1');
  }

  if (password === correctPassword) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    adminSessions.set(sessionId, { created: Date.now() });

    res.cookie('admin_session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    console.log('Admin login successful');
    return res.redirect('/admin/stats');
  }

  console.log('Admin login failed - wrong password');
  res.redirect('/admin/login?error=1');
});

// Logout
app.get('/admin/logout', (req, res) => {
  const sessionId = req.cookies?.admin_session;
  if (sessionId) {
    adminSessions.delete(sessionId);
  }
  res.clearCookie('admin_session');
  res.redirect('/admin/login');
});

// Dashboard (geschützt)
app.get('/admin/stats', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'stats.html'));
});

// ============================================
// ANALYTICS API (Session-geschützt)
// ============================================
app.get('/api/stats', requireAdminAuth, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const stats = getStats(days);
  res.json(stats);
});

// Analytics Cleanup (manuell aufrufbar)
app.post('/api/stats/cleanup', requireAdminAuth, (req, res) => {
  const keepDays = parseInt(req.query.days) || 90;
  const deleted = cleanupOldData(keepDays);
  res.json({ success: true, deletedRecords: deleted });
});

// Serve locale files
app.use('/locales', express.static('locales'));

// Static file serving with proper cache headers
app.use(express.static('public', {
  maxAge: '1h',
  setHeaders: function(res, path) {
    if (path.endsWith('.html')) {
      // HTML files: no cache (always fresh)
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');

      // success.html: Prevent search engine indexing
      if (path.endsWith('success.html')) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }
    } else if (path.endsWith('.css') || path.endsWith('.js')) {
      // CSS/JS files: cache for 1 hour (use version query string)
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else if (path.match(/\.(jpg|jpeg|png|gif|ico|svg)$/)) {
      // Images: cache for 30 days
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    }
  }
}));

// Helper function to detect language from Accept-Language header
function detectLanguage(acceptLanguageHeader) {
  if (!acceptLanguageHeader) return 'en';

  // Parse Accept-Language header (e.g., "de-DE,de;q=0.9,en;q=0.8")
  const languages = acceptLanguageHeader.split(',')
    .map(lang => lang.split(';')[0].trim().split('-')[0].toLowerCase());

  // Supported languages
  const supportedLanguages = ['de', 'en', 'es', 'fr', 'pt'];

  // Find first supported language
  for (const lang of languages) {
    if (supportedLanguages.includes(lang)) {
      return lang;
    }
  }

  return 'en'; // Default fallback
}

// Helper function to detect country from Accept-Language header
function detectCountry(acceptLanguageHeader) {
  if (!acceptLanguageHeader) return null;

  // Parse Accept-Language header (e.g., "de-DE,de;q=0.9,en-US;q=0.8")
  // Extract country code from locale (e.g., "de-DE" → "DE", "en-US" → "US")
  const locales = acceptLanguageHeader.split(',')
    .map(lang => lang.split(';')[0].trim());

  for (const locale of locales) {
    const parts = locale.split('-');
    if (parts.length === 2) {
      // Return uppercase country code (DE, US, ES, AR, etc.)
      return parts[1].toUpperCase();
    }
  }

  return null; // No country code found
}

// Helper function to load locale file
function loadLocale(lang) {
  try {
    const localePath = path.join(__dirname, 'locales', `${lang}.json`);
    const localeData = fs.readFileSync(localePath, 'utf8');
    return JSON.parse(localeData);
  } catch (error) {
    console.error(`Error loading locale ${lang}:`, error);
    // Fallback to English
    const localePath = path.join(__dirname, 'locales', 'en.json');
    const localeData = fs.readFileSync(localePath, 'utf8');
    return JSON.parse(localeData);
  }
}

// Helper function to get currency and locale based on country and language
function getCurrencyAndLocale(lang, country) {
  // ===== CURRENCY STRATEGY (Country-based) =====
  // We use the customer's COUNTRY (from Accept-Language header) to determine currency.
  // Examples:
  //   - "de-DE" (German-Germany) → EUR
  //   - "en-US" (English-USA) → USD
  //   - "en-GB" (English-UK) → EUR
  //   - "es-ES" (Spanish-Spain) → EUR
  //   - "es-AR" (Spanish-Argentina) → USD
  //
  // Strategy:
  //   - All European countries → EUR (simplifies tax & accounting)
  //   - Rest of world → USD
  // ===== END STRATEGY =====

  // List of countries that use EUR (or we charge in EUR for simplicity)
  const eurCountries = [
    // EU-27 (European Union members)
    'AT', // Austria
    'BE', // Belgium
    'BG', // Bulgaria
    'HR', // Croatia
    'CY', // Cyprus
    'CZ', // Czech Republic
    'DK', // Denmark
    'EE', // Estonia
    'FI', // Finland
    'FR', // France
    'DE', // Germany
    'GR', // Greece
    'HU', // Hungary
    'IE', // Ireland
    'IT', // Italy
    'LV', // Latvia
    'LT', // Lithuania
    'LU', // Luxembourg
    'MT', // Malta
    'NL', // Netherlands
    'PL', // Poland
    'PT', // Portugal
    'RO', // Romania
    'SK', // Slovakia
    'SI', // Slovenia
    'ES', // Spain
    'SE', // Sweden

    // Non-EU European countries (we charge in EUR for simplicity)
    'GB', // United Kingdom
    'CH', // Switzerland
    'NO', // Norway
    'IS', // Iceland
    'LI', // Liechtenstein
    'MC', // Monaco
    'VA', // Vatican
    'AD', // Andorra
    'SM', // San Marino
  ];

  // If we have a country code and it's in our EUR list, use EUR
  if (country && eurCountries.includes(country)) {
    return {
      currency: 'eur',
      locale: lang, // Use detected language for Stripe UI
      amount: parseInt(process.env.PRICE_ONETIME_EUR || '499') // From .env (default: 4.99 EUR)
    };
  }

  // If we have a country code and it's NOT in EUR list, use USD
  if (country) {
    return {
      currency: 'usd',
      locale: 'en', // English locale for USD
      amount: parseInt(process.env.PRICE_ONETIME_USD || '499') // From .env (default: 4.99 USD)
    };
  }

  // Fallback: No country code available, use language-based detection
  // (This handles cases where Accept-Language is just "en" without country)
  const europeanLanguages = ['de', 'es', 'fr', 'it', 'nl', 'pt', 'pl', 'el', 'fi', 'sv', 'da', 'cs', 'sk', 'sl', 'et', 'lv', 'lt', 'mt', 'ga', 'ro', 'bg', 'hu', 'hr'];

  if (europeanLanguages.includes(lang)) {
    return {
      currency: 'eur',
      locale: lang,
      amount: parseInt(process.env.PRICE_ONETIME_EUR || '499') // From .env (default: 4.99 EUR)
    };
  }

  // Final fallback: Unknown language/country → EUR (we're EU-based)
  return {
    currency: 'eur',
    locale: 'en',
    amount: parseInt(process.env.PRICE_ONETIME_EUR || '499') // From .env (default: 4.99 EUR)
  };
}

// API endpoint to get translations
app.get('/api/locale', (req, res) => {
  // Support manual language selection via ?lang= parameter, fallback to browser detection
  const lang = req.query.lang || detectLanguage(req.headers['accept-language']);
  const locale = loadLocale(lang);
  res.json({ lang, translations: locale });
});

// Test language endpoint
app.get('/test-language', (req, res) => {
  const lang = req.query.lang || detectLanguage(req.headers['accept-language']);
  const locale = loadLocale(lang);
  res.json({
    detectedLanguage: lang,
    translations: locale
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Debug endpoint to check language and country detection
app.get('/debug/language', (req, res) => {
  const acceptLanguageHeader = req.headers['accept-language'];
  const detectedLang = detectLanguage(acceptLanguageHeader);
  const detectedCountry = detectCountry(acceptLanguageHeader);
  const { currency, locale, amount } = getCurrencyAndLocale(detectedLang, detectedCountry);
  const translations = loadLocale(detectedLang);

  res.json({
    'Accept-Language Header': acceptLanguageHeader,
    'Detected Language': detectedLang,
    'Detected Country': detectedCountry,
    'Currency': currency,
    'Locale': locale,
    'Amount': amount,
    'Product Name': translations.stripeProductName,
    'Product Description': translations.stripeProductDescription
  });
});

// Create Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    // Get language and mobile flag from request body
    const browserLanguage = req.body?.language;
    const isMobile = req.body?.isMobile || false;
    console.log('🔍 [CHECKOUT] Browser language from body:', browserLanguage);
    console.log('🔍 [CHECKOUT] Is mobile device:', isMobile);
    console.log('🔍 [CHECKOUT] Accept-Language header:', req.headers['accept-language']);

    // Use user-selected language for Stripe UI, but detect country from header for currency
    // IMPORTANT: Country detection uses Accept-Language header (for EUR/USD decision)
    // Language for Stripe UI uses user selection from dropdown (if available)
    const acceptLanguageHeader = req.headers['accept-language'];
    const lang = browserLanguage ? detectLanguage(browserLanguage) : detectLanguage(acceptLanguageHeader);
    const country = detectCountry(acceptLanguageHeader);

    console.log('🔍 [CHECKOUT] Detected language:', lang);
    console.log('🔍 [CHECKOUT] Detected country:', country);
    const { currency, locale, amount } = getCurrencyAndLocale(lang, country);
    console.log('🔍 [CHECKOUT] Currency/Locale:', { currency, locale, amount });
    const translations = loadLocale(lang);
    console.log('🔍 [CHECKOUT] Product name:', translations.stripeProductName);

    const baseUrl = req.headers.origin || 'http://localhost:3000';

    // Common session parameters
    const sessionParams = {
      locale: locale, // Set Stripe UI language
      payment_method_types: ['card'],

      // ===== STRIPE CUSTOMER RECEIPTS =====
      // Customer receipts are sent automatically when:
      // 1. Dashboard setting is enabled: https://dashboard.stripe.com/settings/emails
      //    → Enable "Successful payments" under "Customer emails"
      // 2. Stripe will then automatically send receipt to customer_details.email
      //    (the email entered during checkout)
      // Note: We DO NOT use invoice_creation here because:
      //    - We generate proper invoices via Zoho (with F-numbers)
      //    - Stripe Invoice PDFs would confuse customers (duplicate invoices)
      //    - Stripe Receipt PDF is sufficient for payment confirmation
      // ===== END CUSTOMER RECEIPTS =====

      // ===== STRIPE TAX CONFIGURATION =====
      // Enable automatic_tax for correct tax calculation (same as subscriptions)
      // This ensures Stripe calculates tax correctly for invoice_creation
      automatic_tax: {
        enabled: true  // Enable Stripe Tax for automatic tax calculation
      },
      billing_address_collection: 'required',  // Collect address for tax calculation
      tax_id_collection: {
        enabled: true  // Allow B2B customers to enter VAT number
      },
      customer_creation: 'always',  // Create customer for metadata
      // Enable invoice_creation to get tax data via Invoice API (same as subscriptions)
      // This allows webhook to use identical code for both payment types
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: 'Payment for allgood.click service',
          metadata: {
            source: 'allgood-one-time-payment'
          }
        }
      },
      // NOTE: Stripe will NOT auto-send invoice PDF - we send only Zoho PDF
      // ===== END TAX CONFIGURATION =====

      line_items: [
        {
          price_data: {
            currency: currency,
            product_data: {
              name: translations.stripeProductName || 'Make it REALLY okay',
              description: translations.stripeProductDescription || 'Premium reality adjustment service',
              tax_code: 'txcd_10000000'  // Digital services tax code
            },
            unit_amount: amount,
            tax_behavior: 'inclusive'  // Price includes tax (4.99€ total)
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: {
        language: lang,
        currency: currency
      }
    };

    // Always use hosted mode (redirects to Stripe-hosted page)
    // This works on all devices and is simpler to handle
    console.log('🔗 [CHECKOUT] Creating HOSTED checkout session (full-page redirect)');
    const session = await stripe.checkout.sessions.create({
      ...sessionParams,
      ui_mode: 'hosted',
      success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&lang=${lang}`,
      cancel_url: `${baseUrl}/`, // Return to homepage on cancel
    });

    // Return URL for redirect
    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create Stripe Subscription Checkout Session
app.post('/create-subscription-session', async (req, res) => {
  try {
    // Get language and mobile flag from request body
    const browserLanguage = req.body?.language;
    const isMobile = req.body?.isMobile || false;
    console.log('🔍 [SUBSCRIPTION] Browser language from body:', browserLanguage);
    console.log('🔍 [SUBSCRIPTION] Is mobile device:', isMobile);

    // Use user-selected language for Stripe UI, but detect country from header for currency
    // IMPORTANT: Country detection uses Accept-Language header (for EUR/USD decision)
    // Language for Stripe UI uses user selection from dropdown (if available)
    const acceptLanguageHeader = req.headers['accept-language'];
    const lang = browserLanguage ? detectLanguage(browserLanguage) : detectLanguage(acceptLanguageHeader);
    const country = detectCountry(acceptLanguageHeader);

    console.log('🔍 [SUBSCRIPTION] Detected language:', lang);
    console.log('🔍 [SUBSCRIPTION] Detected country:', country);
    const { currency, locale, amount } = getCurrencyAndLocale(lang, country);

    // Subscription price: Configured via ENV variables (PRICE_SUBSCRIPTION_EUR/USD)
    const subscriptionAmount = currency === 'eur'
      ? parseInt(process.env.PRICE_SUBSCRIPTION_EUR || '999')
      : parseInt(process.env.PRICE_SUBSCRIPTION_USD || '999');
    console.log('🔍 [SUBSCRIPTION] Currency/Locale:', { currency, locale, amount: subscriptionAmount });

    const translations = loadLocale(lang);
    console.log('🔍 [SUBSCRIPTION] Product name:', translations.stripeProductName);

    const baseUrl = req.headers.origin || 'http://localhost:3000';

    // Subscriptions always use hosted mode (redirect to Stripe)
    console.log('📱 [SUBSCRIPTION] Creating HOSTED subscription checkout session');
    const session = await stripe.checkout.sessions.create({
      locale: locale,
      payment_method_types: ['card'],

      // ===== STRIPE TAX CONFIGURATION =====
      automatic_tax: {
        enabled: true  // Enable Stripe Tax for automatic tax calculation
      },
      billing_address_collection: 'required',  // Collect address for tax calculation
      tax_id_collection: {
        enabled: true  // Allow B2B customers to enter VAT number
      },
      // NOTE: For subscriptions, customer + invoice are created automatically
      // customer_creation and invoice_creation are ONLY for mode: 'payment'
      // ===== END TAX CONFIGURATION =====

      line_items: [
        {
          price_data: {
            currency: currency,
            product_data: {
              name: `${translations.stripeProductName} - Weekly`,
              description: translations.subscriptionStripeDesc,
              tax_code: 'txcd_10000000'  // Digital services tax code
            },
            unit_amount: subscriptionAmount,
            tax_behavior: 'inclusive',  // Price includes tax (9.99€ total)
            recurring: {
              interval: 'month',
              interval_count: 1
            }
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      metadata: {
        language: lang,
        currency: currency,
        subscription_type: 'weekly_ok'
      },
      ui_mode: 'hosted',
      success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&lang=${lang}`,
      cancel_url: `${baseUrl}/`,
    });

    // Return URL for redirect
    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating subscription session:', error);
    res.status(500).json({ error: 'Failed to create subscription session' });
  }
});

// Create Stripe Customer Portal session
app.post('/create-portal-session', async (req, res) => {
  try {
    const { customerId } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID is required' });
    }

    console.log('🔐 [PORTAL] Creating customer portal session for:', customerId);

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${req.protocol}://${req.get('host')}/`,
    });

    console.log('✅ [PORTAL] Portal session created:', session.url);
    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ [PORTAL] Error creating portal session:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Send Magic Link for subscription management
app.post('/send-portal-link', async (req, res) => {
  try {
    const { email, locale } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Map language to Stripe-supported locale
    const stripeLocales = ['de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt', 'zh'];
    const stripeLocale = stripeLocales.includes(locale) ? locale : 'auto';

    console.log('🔐 [MAGIC-LINK] Looking up customer with email:', email);

    // Find customer by email
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      console.log('❌ [MAGIC-LINK] No customer found with email:', email);
      return res.status(404).json({ error: 'No active subscriptions found for this email' });
    }

    const customer = customers.data[0];
    console.log('✅ [MAGIC-LINK] Customer found:', customer.id);

    // Check if customer has active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      console.log('❌ [MAGIC-LINK] No active subscriptions for customer:', customer.id);
      return res.status(400).json({ error: 'No active subscriptions found for this email' });
    }

    console.log('📧 [MAGIC-LINK] Creating billing portal session...');

    // Create portal session for customer with locale
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: `${req.protocol}://${req.get('host')}/`,
      locale: stripeLocale
    });
    console.log('🌐 [MAGIC-LINK] Using locale:', stripeLocale);

    console.log('✅ [MAGIC-LINK] Portal session created:', portalSession.url);

    // Return the portal URL for immediate redirect
    res.json({
      success: true,
      url: portalSession.url
    });

  } catch (error) {
    console.error('❌ [MAGIC-LINK] Error:', error);
    res.status(500).json({ error: 'Failed to send magic link. Please try again.' });
  }
});

// Stripe webhook endpoint
app.post('/webhook', async (req, res) => {
  console.log('🎯 [WEBHOOK] Received webhook request');
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
    console.log('✅ [WEBHOOK] Signature verified successfully');
    console.log('🎯 [WEBHOOK] Event type:', event.type);
  } catch (err) {
    console.error('❌ [WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      console.log('💰 [WEBHOOK] Processing checkout.session.completed');
      const session = event.data.object;
      const isTestMode = !event.livemode; // Stripe provides livemode flag
      console.log('💰 [WEBHOOK] Payment successful:', {
        sessionId: session.id,
        customerEmail: session.customer_email,
        amount: session.amount_total,
        language: session.metadata.language,
        testMode: isTestMode
      });

      // Send success email notification with customer details
      console.log('📧 [WEBHOOK] Calling sendPaymentNotification...');

      // Extract customer address and VAT from customer_details
      const customerAddress = session.customer_details?.address || null;
      const customerName = session.customer_details?.name || null;
      const taxIds = session.customer_details?.tax_ids || [];
      const vatNumber = taxIds.length > 0 ? taxIds[0].value : null;

      const emailResult = await sendPaymentNotification('success', {
        amount: (session.amount_total / 100).toFixed(2),
        currency: session.currency || 'usd',
        sessionId: session.id,
        customerEmail: session.customer_details?.email || session.customer_email,
        customerName: customerName,
        customerAddress: customerAddress,
        vatNumber: vatNumber,
        paymentType: session.mode, // 'payment' or 'subscription'
        customerId: session.customer // Stripe customer ID for portal access
      }, isTestMode);
      console.log('📧 [WEBHOOK] Email result:', emailResult);

      // Create Zoho Invoice for both TEST and LIVE payments
      console.log(`💼 [WEBHOOK] Creating Zoho invoice (${event.livemode ? 'LIVE' : 'TEST'} mode)...`);
      try {
        // Retrieve full session with line_items and tax data
        const fullSession = await stripe.checkout.sessions.retrieve(
          session.id,
          { expand: ['line_items', 'line_items.data.taxes', 'customer', 'total_details.breakdown', 'invoice'] }
        );

        let taxAmount = 0;
        let taxRatePercentage = 0;
        let subtotalAmount = 0;

        // Tax data is in the invoice for BOTH subscriptions and one-time payments (with invoice_creation)
        if (fullSession.invoice) {
          console.log(`📄 [WEBHOOK] ${fullSession.mode === 'subscription' ? 'Subscription' : 'Payment'} detected - retrieving invoice for tax data...`);

          // Get invoice (could be object if expanded, or string ID)
          let invoice;
          if (typeof fullSession.invoice === 'string') {
            // Invoice ID - need to retrieve it
            // Note: Can only expand 4 levels max, so we expand tax_amounts and retrieve tax_rate separately
            invoice = await stripe.invoices.retrieve(fullSession.invoice, {
              expand: ['lines.data.tax_amounts']
            });
          } else {
            // Already expanded as object
            invoice = fullSession.invoice;
          }

          // Extract tax from invoice
          taxAmount = invoice.tax || 0;

          // CRITICAL: Check for Reverse Charge FIRST (before any calculations)
          // EU B2B with VAT ID = Stripe sets tax rate but amount_tax = 0
          if (taxAmount === 0) {
            console.log(`⚠️ [WEBHOOK] Reverse Charge detected - tax amount is 0`);
            taxRatePercentage = 0;
            subtotalAmount = invoice.total; // For Reverse Charge: subtotal = total (no tax)
            console.log(`💰 [WEBHOOK] Reverse Charge: Using invoice total as subtotal: ${invoice.total / 100} EUR`);
          } else {
            // Normal tax calculation (B2C or non-EU)
            // Extract tax rate and NET amount from invoice line items
            const invoiceLineTaxAmounts = invoice.lines?.data[0]?.tax_amounts || [];
            console.log(`🔍 [WEBHOOK] Invoice tax_amounts:`, JSON.stringify(invoiceLineTaxAmounts, null, 2));

            if (invoiceLineTaxAmounts.length > 0) {
              const taxAmountData = invoiceLineTaxAmounts[0];

              // Get tax rate (needed for NET calculation)
              if (taxAmountData.tax_rate) {
                if (typeof taxAmountData.tax_rate === 'string') {
                  // Need to retrieve tax rate separately
                  const taxRate = await stripe.taxRates.retrieve(taxAmountData.tax_rate);
                  taxRatePercentage = taxRate.percentage || 0;
                  console.log(`💸 [WEBHOOK] Retrieved tax rate ${taxRate.id}: ${taxRatePercentage}%`);
                } else {
                  // Already an object
                  taxRatePercentage = taxAmountData.tax_rate.percentage || 0;
                  console.log(`💸 [WEBHOOK] Tax rate object: ${taxRatePercentage}%`);
                }
              }

              // CRITICAL: For tax-inclusive pricing, calculate NET = Total / (1 + rate%)
              // This method gives PERFECT results with NO rounding errors!
              // Example: 999 / (1 + 0.20) = 999 / 1.20 = 832.5 cents = 8.325 EUR ✓
              if (taxAmountData.inclusive && taxRatePercentage > 0) {
                // Tax-inclusive: NET = Total / (1 + tax_rate%)
                const netInCentsFloat = (invoice.total * 100) / (100 + taxRatePercentage);
                subtotalAmount = Math.round(netInCentsFloat);
                console.log(`💰 [WEBHOOK] Tax-inclusive: NET = Total ${invoice.total} / (1 + ${taxRatePercentage}%) = ${subtotalAmount} cents = ${subtotalAmount / 100} EUR`);
              } else {
                // Non-inclusive tax: use invoice subtotal
                subtotalAmount = invoice.subtotal || 0;
              }
            } else {
              // No tax amounts - fallback to invoice subtotal
              subtotalAmount = invoice.subtotal || 0;
            }
          }

          console.log('📄 [WEBHOOK] Invoice tax data:', {
            subtotal: subtotalAmount / 100,
            tax: taxAmount / 100,
            total: invoice.total / 100,
            taxRatePercentage: taxRatePercentage + '%'
          });
        } else {
          // FALLBACK: For payments without invoice (should not happen with invoice_creation enabled)
          console.warn('⚠️ [WEBHOOK] No invoice found - using session data (fallback). Check if invoice_creation is enabled!');
          taxAmount = fullSession.total_details?.amount_tax || 0;

          // CRITICAL: Check for Reverse Charge FIRST (before any calculations)
          if (taxAmount === 0) {
            console.log(`⚠️ [WEBHOOK] Reverse Charge detected - tax amount is 0`);
            taxRatePercentage = 0;
            subtotalAmount = fullSession.amount_total; // For Reverse Charge: subtotal = total (no tax)
            console.log(`💰 [WEBHOOK] Reverse Charge: Using session total as subtotal: ${fullSession.amount_total / 100} EUR`);
          } else {
            // Normal tax calculation
            // Extract tax rate and inclusive flag from line items
            const lineItemTaxes = fullSession.line_items?.data[0]?.taxes || [];
            console.log(`🔍 [WEBHOOK] Session line item taxes:`, JSON.stringify(lineItemTaxes, null, 2));

            let isInclusive = false;
            if (lineItemTaxes.length > 0) {
              const taxData = lineItemTaxes[0];
              const taxRate = taxData.rate;
              taxRatePercentage = taxRate ? (taxRate.percentage || 0) : 0;
              isInclusive = taxRate ? (taxRate.inclusive || false) : false;

              console.log(`💸 [WEBHOOK] Tax rate: ${taxRatePercentage}%, inclusive: ${isInclusive}`);

              // CRITICAL: For tax-inclusive pricing, calculate NET = Total / (1 + rate%)
              // This method gives PERFECT results with NO rounding errors!
              // Example: 999 / (1 + 0.20) = 999 / 1.20 = 832.5 cents = 8.325 EUR ✓
              if (isInclusive && taxRatePercentage > 0) {
                // Tax-inclusive: NET = Total / (1 + tax_rate%)
                const netInCentsFloat = (fullSession.amount_total * 100) / (100 + taxRatePercentage);
                subtotalAmount = Math.round(netInCentsFloat);
                console.log(`💰 [WEBHOOK] One-time tax-inclusive: NET = Total ${fullSession.amount_total} / (1 + ${taxRatePercentage}%) = ${subtotalAmount} cents = ${subtotalAmount / 100} EUR`);
              } else {
                // Non-inclusive tax: use amount_total
                subtotalAmount = fullSession.amount_total || 0;
              }
            } else {
              // No tax data - fallback to amount_total
              subtotalAmount = fullSession.amount_total || 0;
            }
          }

          console.log('📄 [WEBHOOK] Session tax data:', {
            subtotal: subtotalAmount / 100,
            tax: taxAmount / 100,
            total: fullSession.amount_total / 100,
            taxRatePercentage: taxRatePercentage + '%',
            inclusive: isInclusive
          });
        }

        const country = fullSession.customer_details?.address?.country || null;
        const taxIds = fullSession.customer_details?.tax_ids || [];
        const vatNumber = taxIds.length > 0 ? taxIds[0].value : null;
        const taxExempt = fullSession.customer_details?.tax_exempt || 'none';

        console.log('💰 [WEBHOOK] Tax Data Extracted:', {
          country,
          subtotal: subtotalAmount / 100,
          taxAmount: taxAmount / 100,
          total: fullSession.amount_total / 100,
          vatNumber,
          taxExempt,
          taxRatePercentage: taxRatePercentage + '%'
        });

        // Extract dynamic invoice data from Stripe (with tax information)
        const invoiceData = {
          amount: fullSession.amount_total / 100,
          subtotal: subtotalAmount / 100,
          taxAmount: taxAmount / 100,
          currency: fullSession.currency,
          // Use discreet product name (same as Zoho invoice)
          productName: fullSession.mode === 'subscription' ? 'allgood.click suscripción' : 'allgood.click servicio online',
          customerEmail: fullSession.customer_details?.email || fullSession.customer_email,
          customerName: fullSession.customer_details?.name || null,
          customerAddress: fullSession.customer_details?.address || null,
          country: country,
          vatNumber: vatNumber,
          taxExempt: taxExempt,
          taxRatePercentage: taxRatePercentage,
          paymentType: fullSession.mode, // 'payment' or 'subscription'
          stripeSessionId: fullSession.id,
          paymentIntentId: fullSession.payment_intent,
          isTestMode: !event.livemode // Stripe's livemode flag (false = test, true = live)
        };

        console.log('💼 [ZOHO] Invoice data prepared:', invoiceData);

        // Only create Zoho invoice if enabled
        if (ZOHO_ENABLED) {
          try {
            // Create invoice in Zoho
            const invoiceResult = await createZohoInvoice(invoiceData);

            if (invoiceResult.success) {
              console.log('✅ [ZOHO] Invoice created successfully:', invoiceResult.invoice_number);

              // Send invoice email to customer (also changes status to "sent")
              console.log('📧 [ZOHO] Sending invoice email to customer...');
              const emailResult = await sendZohoInvoiceEmail(invoiceResult.invoice_id, invoiceData.customerEmail);
              if (!emailResult.success) {
                console.warn('⚠️ [ZOHO] Email sending failed, but continuing:', emailResult.error);
              }

              // Record payment (mark invoice as paid)
              console.log('💰 [ZOHO] Recording payment...');
              const paymentResult = await recordZohoPayment({
                invoiceId: invoiceResult.invoice_id,
                customerId: invoiceResult.customer_id, // Pass real customer ID
                amount: invoiceData.amount,
                paymentIntentId: invoiceData.paymentIntentId
              });
              if (!paymentResult.success) {
                console.error('❌ [ZOHO] Payment recording failed:', paymentResult.error);
                // Continue anyway - invoice is created and sent
              }

              // Send green OK email to Martin
              await sendZohoOKEmail(invoiceResult);
            } else {
              console.error('❌ [ZOHO] Invoice creation failed:', invoiceResult.error);
              // Send red error email
              await sendZohoErrorEmail({
                error: invoiceResult.error,
                stripeSessionId: session.id,
                customerEmail: session.customer_email,
                amount: session.amount_total / 100,
                currency: session.currency
              });
            }
          } catch (error) {
            console.error('❌ [ZOHO] Unexpected error during invoice creation:', error);
            // Send error email
            await sendZohoErrorEmail({
              error: error.message,
              stripeSessionId: session.id,
              customerEmail: session.customer_email,
              amount: session.amount_total / 100,
              currency: session.currency
            });
          }
        } else {
          console.log('⏭️  [ZOHO] Invoicing disabled - skipping invoice creation');
        }
      } catch (error) {
        console.error('❌ [WEBHOOK] Error processing invoice data:', error);
      }
      break;

    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('PaymentIntent was successful:', paymentIntent.id);
      break;

    case 'payment_intent.payment_failed':
      const failedPayment = event.data.object;
      const isTestModeFailed = !event.livemode;
      console.error('Payment failed:', failedPayment.id);

      // Send error email notification
      await sendPaymentNotification('error', {
        error: failedPayment.last_payment_error?.message || 'Payment failed',
        paymentIntentId: failedPayment.id,
        details: JSON.stringify(failedPayment.last_payment_error || {}, null, 2)
      }, isTestModeFailed);
      break;

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

// Legal pages routing (without .html extension)
app.get('/aviso-legal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'aviso-legal.html'));
});

app.get('/politica-privacidad', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'politica-privacidad.html'));
});

app.get('/politica-cookies', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'politica-cookies.html'));
});

app.get('/terminos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminos.html'));
});

// Redirect old manage-subscription URL to FAQ
app.get('/manage-subscription.html', (req, res) => {
  res.redirect(301, '/faq.html');
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📝 Health check: http://localhost:${PORT}/health`);
  console.log(`🌍 Test language: http://localhost:${PORT}/test-language?lang=de`);
  console.log(`💳 Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? 'TEST' : 'LIVE'}`);
});
