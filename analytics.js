/**
 * analytics.js - DSGVO-konformes Tracking für allgood.click
 *
 * Features:
 * - Keine Cookies (kein Banner nötig)
 * - IP anonymisiert (letztes Oktett entfernt)
 * - Bot-Erkennung
 * - Browser/OS/Device Detection
 * - SQLite-Speicherung
 */

const Database = require('better-sqlite3');
const path = require('path');

// Datenbank initialisieren
const dbPath = path.join(__dirname, 'data', 'analytics.db');
const db = new Database(dbPath);

// Tabelle erstellen falls nicht existiert
db.exec(`
  CREATE TABLE IF NOT EXISTS pageviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    page TEXT,
    ip_anonymized TEXT,
    country TEXT,
    language TEXT,
    referrer TEXT,
    user_agent TEXT,
    browser TEXT,
    os TEXT,
    device_type TEXT,
    is_bot INTEGER DEFAULT 0
  )
`);

// Indizes erstellen falls nicht existiert
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_timestamp ON pageviews(timestamp);
  CREATE INDEX IF NOT EXISTS idx_page ON pageviews(page);
  CREATE INDEX IF NOT EXISTS idx_is_bot ON pageviews(is_bot);
`);

/**
 * IP anonymisieren (DSGVO-konform)
 * IPv4: 192.168.1.123 → 192.168.1.xxx
 * IPv6: 2001:0db8:85a3:... → 2001:0db8:85a3::xxx
 */
function anonymizeIP(ip) {
  if (!ip) return 'unknown';

  // IPv4
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }

  // IPv6
  const v6parts = ip.split(':');
  if (v6parts.length > 3) {
    return `${v6parts.slice(0, 3).join(':')}::xxx`;
  }

  return 'unknown';
}

/**
 * Bot-Erkennung anhand User-Agent
 */
function isBot(userAgent) {
  if (!userAgent) return true;

  const botPatterns = [
    // Suchmaschinen
    /googlebot/i, /bingbot/i, /slurp/i, /duckduckbot/i,
    /baiduspider/i, /yandexbot/i, /sogou/i, /exabot/i,
    // Social Media Crawler
    /facebookexternalhit/i, /twitterbot/i, /linkedinbot/i,
    /whatsapp/i, /telegrambot/i, /pinterest/i, /slackbot/i,
    // Generische Bot-Patterns
    /bot/i, /crawler/i, /spider/i, /crawling/i, /scraper/i,
    // Tools
    /curl/i, /wget/i, /httpie/i, /postman/i,
    // Programmiersprachen
    /python-requests/i, /python-urllib/i, /java\//i, /php\//i,
    /go-http-client/i, /ruby/i, /perl/i,
    // Headless Browser
    /headless/i, /phantom/i, /selenium/i, /puppeteer/i, /playwright/i,
    // Monitoring
    /uptimerobot/i, /pingdom/i, /statuscake/i, /gtmetrix/i,
    // SEO Tools (moz\.com statt moz wegen "Mozilla")
    /ahrefs/i, /semrush/i, /moz\.com/i, /dotbot/i, /majestic/i, /screaming/i
  ];

  return botPatterns.some(pattern => pattern.test(userAgent));
}

/**
 * Browser erkennen
 */
function detectBrowser(ua) {
  if (!ua) return 'Unknown';
  if (/edg/i.test(ua)) return 'Edge';
  if (/opr|opera/i.test(ua)) return 'Opera';
  if (/chrome/i.test(ua) && !/edg/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua) && !/chrome/i.test(ua)) return 'Safari';
  if (/firefox/i.test(ua)) return 'Firefox';
  if (/msie|trident/i.test(ua)) return 'IE';
  return 'Other';
}

/**
 * Betriebssystem erkennen
 */
function detectOS(ua) {
  if (!ua) return 'Unknown';
  if (/windows nt 10/i.test(ua)) return 'Windows 10/11';
  if (/windows/i.test(ua)) return 'Windows';
  if (/macintosh|mac os x/i.test(ua)) return 'macOS';
  if (/iphone/i.test(ua)) return 'iOS';
  if (/ipad/i.test(ua)) return 'iPadOS';
  if (/android/i.test(ua)) return 'Android';
  if (/linux/i.test(ua)) return 'Linux';
  if (/cros/i.test(ua)) return 'ChromeOS';
  return 'Other';
}

/**
 * Device-Typ erkennen
 */
function detectDevice(ua) {
  if (!ua) return 'unknown';
  if (/mobile|android.*mobile|iphone/i.test(ua)) return 'mobile';
  if (/ipad|tablet|android(?!.*mobile)/i.test(ua)) return 'tablet';
  return 'desktop';
}

/**
 * Referrer bereinigen (nur Domain)
 */
function cleanReferrer(ref) {
  if (!ref) return 'direct';
  try {
    const url = new URL(ref);
    // Eigene Domain ignorieren
    if (url.hostname.includes('allgood.click')) return 'internal';
    return url.hostname.replace('www.', '');
  } catch {
    return 'direct';
  }
}

/**
 * Pageview speichern
 */
function trackPageview(req, page) {
  try {
    const ua = req.headers['user-agent'] || '';

    // IP aus verschiedenen Quellen (Cloudflare, Nginx, direkt)
    const ip = req.headers['cf-connecting-ip']
      || req.headers['x-real-ip']
      || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.ip
      || req.connection?.remoteAddress
      || 'unknown';

    // Land aus Cloudflare Header oder Accept-Language
    const country = req.headers['cf-ipcountry']
      || extractCountryFromLang(req.headers['accept-language'])
      || 'unknown';

    // Sprache aus URL oder Accept-Language
    const langMatch = page.match(/^\/(de|es|fr|pt)\/?/);
    const language = langMatch
      ? langMatch[1]
      : req.headers['accept-language']?.split(',')[0]?.split('-')[0] || 'en';

    const stmt = db.prepare(`
      INSERT INTO pageviews (page, ip_anonymized, country, language, referrer, user_agent, browser, os, device_type, is_bot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      page,
      anonymizeIP(ip),
      country.toUpperCase(),
      language.toLowerCase(),
      cleanReferrer(req.headers.referer || req.headers.referrer),
      ua.substring(0, 500), // Limit für DB
      detectBrowser(ua),
      detectOS(ua),
      detectDevice(ua),
      isBot(ua) ? 1 : 0
    );
  } catch (error) {
    console.error('Analytics tracking error:', error.message);
  }
}

/**
 * Land aus Accept-Language extrahieren (Fallback)
 */
function extractCountryFromLang(acceptLang) {
  if (!acceptLang) return null;
  const match = acceptLang.match(/[a-z]{2}-([A-Z]{2})/);
  return match ? match[1] : null;
}

/**
 * Statistiken abrufen
 */
function getStats(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  try {
    return {
      period: `${days} days`,
      generated: new Date().toISOString(),

      // Übersicht
      total: db.prepare(`SELECT COUNT(*) as count FROM pageviews WHERE timestamp > ?`).get(sinceStr).count,
      humans: db.prepare(`SELECT COUNT(*) as count FROM pageviews WHERE timestamp > ? AND is_bot = 0`).get(sinceStr).count,
      bots: db.prepare(`SELECT COUNT(*) as count FROM pageviews WHERE timestamp > ? AND is_bot = 1`).get(sinceStr).count,

      // Aufschlüsselung
      byPage: db.prepare(`
        SELECT page, COUNT(*) as count
        FROM pageviews
        WHERE timestamp > ? AND is_bot = 0
        GROUP BY page
        ORDER BY count DESC
      `).all(sinceStr),

      byCountry: db.prepare(`
        SELECT country, COUNT(*) as count
        FROM pageviews
        WHERE timestamp > ? AND is_bot = 0
        GROUP BY country
        ORDER BY count DESC
        LIMIT 15
      `).all(sinceStr),

      byLanguage: db.prepare(`
        SELECT language, COUNT(*) as count
        FROM pageviews
        WHERE timestamp > ? AND is_bot = 0
        GROUP BY language
        ORDER BY count DESC
      `).all(sinceStr),

      byBrowser: db.prepare(`
        SELECT browser, COUNT(*) as count
        FROM pageviews
        WHERE timestamp > ? AND is_bot = 0
        GROUP BY browser
        ORDER BY count DESC
      `).all(sinceStr),

      byOS: db.prepare(`
        SELECT os, COUNT(*) as count
        FROM pageviews
        WHERE timestamp > ? AND is_bot = 0
        GROUP BY os
        ORDER BY count DESC
      `).all(sinceStr),

      byDevice: db.prepare(`
        SELECT device_type, COUNT(*) as count
        FROM pageviews
        WHERE timestamp > ? AND is_bot = 0
        GROUP BY device_type
        ORDER BY count DESC
      `).all(sinceStr),

      byReferrer: db.prepare(`
        SELECT referrer, COUNT(*) as count
        FROM pageviews
        WHERE timestamp > ? AND is_bot = 0 AND referrer != 'direct' AND referrer != 'internal'
        GROUP BY referrer
        ORDER BY count DESC
        LIMIT 15
      `).all(sinceStr),

      perDay: db.prepare(`
        SELECT DATE(timestamp) as date, COUNT(*) as count
        FROM pageviews
        WHERE timestamp > ? AND is_bot = 0
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      `).all(sinceStr),

      // Top Bots (für Debugging)
      topBots: db.prepare(`
        SELECT browser, COUNT(*) as count
        FROM pageviews
        WHERE timestamp > ? AND is_bot = 1
        GROUP BY browser
        ORDER BY count DESC
        LIMIT 10
      `).all(sinceStr)
    };
  } catch (error) {
    console.error('Analytics stats error:', error.message);
    return { error: error.message };
  }
}

/**
 * Datenbank-Cleanup (ältere Daten löschen)
 */
function cleanupOldData(keepDays = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);

  const result = db.prepare(`DELETE FROM pageviews WHERE timestamp < ?`).run(cutoff.toISOString());
  console.log(`Analytics cleanup: ${result.changes} old records deleted`);
  return result.changes;
}

module.exports = {
  trackPageview,
  getStats,
  cleanupOldData,
  db
};
