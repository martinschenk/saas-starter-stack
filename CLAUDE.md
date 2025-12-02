# SaaS Starter Stack - Development Guidelines

## Project Structure

```
├── server.js          # Express server with all routes and Stripe webhooks
├── analytics.js       # GDPR-compliant page view tracking
├── public/            # Frontend files
│   ├── index.html     # Landing page
│   ├── success.html   # Post-payment success page
│   ├── script.js      # Frontend logic
│   ├── style.css      # Styles
│   └── admin/         # Admin dashboard
├── locales/           # Translation files (en, de, es, fr, pt)
├── data/              # SQLite database (gitignored)
└── .env               # Environment variables (gitignored)
```

## Environment Variables

See `.env.example` for all required variables:

- **Stripe Keys** - Get from dashboard.stripe.com
- **Zoho Invoice** - Optional, for auto-invoicing
- **Stats Password** - For admin dashboard access

## Local Development

```bash
# Install dependencies
npm install

# Start server
npm start

# Test Stripe webhooks locally
stripe listen --forward-to localhost:3000/webhook
```

## Security Rules

1. **Never commit secrets** - All credentials go in `.env` (gitignored)
2. **Review before commit** - Check `git diff --cached` for exposed secrets
3. **Rotate compromised keys** - If exposed, revoke immediately

## Multi-Language Support

**URL Structure:**
- `/` - English (default)
- `/de/` - German
- `/es/` - Spanish
- `/fr/` - French
- `/pt/` - Portuguese

**Adding a new language:**
1. Create `locales/xx.json` (copy from `en.json`)
2. Translate all strings
3. Add route in `server.js`

## Cache Busting

Assets are versioned with query strings:
- `script.js?v=X.X.X`
- `style.css?v=X.X.X`

Update version in `package.json` and HTML files after changes.

## Analytics Dashboard

Access at `/admin/stats` with password from `STATS_PASSWORD` env var.

**GDPR Compliance:**
- IPs anonymized (last octet removed)
- No cookies used
- No personal data stored
- Auto-cleanup after 90 days

## Deployment

Deploy to any Node.js host:
- Railway, Render, DigitalOcean, Heroku, VPS with PM2

Set environment variables on your hosting platform.

## Key Files to Customize

1. **`public/index.html`** - Landing page content
2. **`public/style.css`** - Colors, fonts, branding
3. **`locales/*.json`** - All text content
4. **`public/` images** - Favicon, logos
5. **`.env`** - Your API keys and prices

---

## About This Repository

This is the **public Open Source version** of a production SaaS application.

**Live Demo:** https://allgood.click

### Relationship to Production

This repo is synced from a private production repository. Updates are made in the private repo first, then synced here with sensitive data removed automatically.

### What's Been Sanitized

The sync process automatically removes:
- Real email addresses → `your-email@example.com`
- Zoho Tax IDs → `YOUR_ZOHO_TAX_ID_XX_PERCENT`
- Server IPs and deployment configs
- Test API keys

### Contributing

If you find issues or want to contribute:
1. Open an issue or PR in this repo
2. Changes will be reviewed and potentially merged into the private production repo

### License

MIT License - Use freely for any purpose.
