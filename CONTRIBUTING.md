# Contributing to SaaS Starter Stack

Thanks for your interest in contributing!

## How to Contribute

### Reporting Bugs

1. Check existing issues first
2. Create a new issue with:
   - Clear description of the bug
   - Steps to reproduce
   - Expected vs actual behavior
   - Your environment (Node version, OS)

### Suggesting Features

1. Open an issue with the "feature request" label
2. Describe the use case
3. Explain why this would be useful

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test locally with `npm start`
5. Commit with clear messages
6. Push and open a PR

### Code Style

- Use existing code patterns
- Keep it simple and readable
- Add comments for complex logic
- Test your changes locally

### Security

- **Never commit secrets** (API keys, passwords, tokens)
- Check `.env.example` for environment variable patterns
- Report security issues privately via email

## Development Setup

```bash
git clone https://github.com/martinschenk/saas-starter-stack.git
cd saas-starter-stack
npm install
cp .env.example .env
# Add your test keys to .env
npm start
```

## Questions?

Open an issue and we'll help you out!
