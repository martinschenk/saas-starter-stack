---
title: How I Built a Production-Ready SaaS in a Weekend (and Open-Sourced It)
published: true
description: A complete SaaS starter with Stripe payments, automatic invoicing, multi-language support, and GDPR-compliant analytics. MIT licensed.
tags: saas, nodejs, stripe, opensource
cover_image: https://raw.githubusercontent.com/martinschenk/saas-starter-stack/main/screenshots/admin-dashboard.png
---

# How I Built a Production-Ready SaaS in a Weekend (and Open-Sourced It)

Every time I started a new SaaS project, I found myself rebuilding the same infrastructure:

- Payment integration
- Invoice generation
- Multi-language support
- Analytics
- Admin dashboard

After the third time, I decided to extract this foundation into a reusable starter. Today, I'm open-sourcing it.

**GitHub:** [martinschenk/saas-starter-stack](https://github.com/martinschenk/saas-starter-stack)
**Live Demo:** [allgood.click](https://allgood.click)

---

## What's Included

### 1. Stripe Payments

Complete Stripe Checkout integration with:

- One-time payments and subscriptions
- Mobile-optimized checkout (auto-detects device and switches between embedded and redirect mode)
- EU tax handling
- Webhook processing with signature verification

```javascript
// Mobile detection for optimal checkout experience
const isMobile = /iPhone|iPad|Android/i.test(userAgent) || screenWidth < 768;

const session = await stripe.checkout.sessions.create({
  ui_mode: isMobile ? 'hosted' : 'embedded',
  // ... other options
});
```

### 2. Automatic Invoicing

Zoho Invoice API integration that:

- Creates professional PDF invoices on payment
- Sends them automatically to customers
- Supports B2B with company name and VAT ID
- Works with multiple currencies

This is optional – you can disable it if you don't need invoicing.

### 3. Multi-Language Support (5 Languages)

- English, German, Spanish, French, Portuguese
- SEO-friendly URLs (`/de/`, `/es/`, `/fr/`, `/pt/`)
- Browser language auto-detection
- Stripe checkout UI localization
- Simple JSON translation files

```json
// locales/de.json
{
  "hero": {
    "title": "Mach alles gut",
    "subtitle": "Mit einem Klick"
  }
}
```

### 4. GDPR-Compliant Analytics (No Cookies!)

This was important to me. I wanted analytics without:

- Cookie consent banners
- Third-party tracking
- Personal data storage

The solution:

```javascript
// IP anonymization - last octet removed
const anonymizedIP = ip.replace(/\.\d+$/, '.0');

// No cookies, no localStorage, no fingerprinting
// Just: timestamp, anonymized IP, page, referrer, user agent
```

The admin dashboard shows:

- Daily visitor charts
- Geographic breakdown
- Device & browser stats
- Referrer tracking
- Human vs bot ratio

All data auto-deletes after 90 days.

---

## Architecture Decisions

### Why Express.js?

No magic, no opinions. Just a simple request/response cycle.

```javascript
app.get('/api/locale', (req, res) => {
  const lang = detectLanguage(req);
  const translations = require(`./locales/${lang}.json`);
  res.json({ lang, translations });
});
```

### Why SQLite?

For analytics data, SQLite is perfect:

- Zero configuration
- File-based backup (just copy the .db file)
- Fast enough for this use case
- No external database to manage

```javascript
const db = require('better-sqlite3')('./data/analytics.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS pageviews (
    id INTEGER PRIMARY KEY,
    timestamp TEXT,
    ip_hash TEXT,
    path TEXT,
    referrer TEXT,
    user_agent TEXT
  )
`);
```

### Why Vanilla JavaScript?

The frontend has no build step:

- No webpack, no bundler
- No node_modules in the frontend
- Total frontend size: ~50KB
- Works in any browser

```html
<script src="/script.js?v=2.2.0"></script>
```

Cache busting with version query strings. Simple and effective.

---

## Getting Started

```bash
# Clone the repo
git clone https://github.com/martinschenk/saas-starter-stack.git
cd saas-starter-stack

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Add your Stripe keys to .env
# STRIPE_SECRET_KEY=sk_test_...
# STRIPE_PUBLISHABLE_KEY=pk_test_...

# Start the server
npm start
```

Visit `http://localhost:3000` and you have a working SaaS.

---

## Customization

### 1. Landing Page

Edit `public/index.html` – it's just HTML. No framework required.

### 2. Translations

Add or modify files in `locales/`:

```
locales/
├── en.json
├── de.json
├── es.json
├── fr.json
└── pt.json
```

### 3. Styling

All styles in `public/style.css`. CSS custom properties for easy theming:

```css
:root {
  --primary-color: #4f46e5;
  --text-color: #1f2937;
  --background: #ffffff;
}
```

### 4. Pricing

Set in `.env`:

```
STRIPE_PRICE_EUR=499
STRIPE_PRICE_USD=499
```

---

## Deployment

Works anywhere Node.js runs:

- **Railway** – One-click deploy
- **Render** – Free tier available
- **DigitalOcean App Platform**
- **Any VPS** with PM2

```bash
# Production with PM2
pm2 start server.js --name saas-app
```

---

## What's Next?

I'm considering adding:

- [ ] Subscription management portal
- [ ] Email templates (welcome, receipt)
- [ ] More payment providers (Paddle, LemonSqueezy)
- [ ] TypeScript version

Open to suggestions – what would make this more useful for you?

---

## Links

- **GitHub:** [martinschenk/saas-starter-stack](https://github.com/martinschenk/saas-starter-stack)
- **Live Demo:** [allgood.click](https://allgood.click)
- **License:** MIT

If this helps you ship faster, that's a win. Star the repo if you find it useful!

---

*Have questions about the implementation? Drop them in the comments – happy to discuss architecture decisions or specific features.*
