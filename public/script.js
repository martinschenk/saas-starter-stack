// Global state
let translations = {};
let clickCount = 0;
let isProcessing = false;
let stripe = null;
let currentCheckout = null;

// Simple footer template (DRY - defined once, used everywhere)
function createFooterHTML(idPrefix = '', extraClass = '') {
    return `
        <footer class="footer ${extraClass}">
            <div class="footer-content">
                <a href="/faq.html" class="footer-link">
                    <span id="${idPrefix}faqHeadline">FAQ</span>
                </a>
                <span class="footer-separator">|</span>
                <a href="/aviso-legal" class="footer-link">
                    <span class="footer-text-desktop" id="${idPrefix}footerLegalNoticeFull">Legal Notice</span>
                    <span class="footer-text-mobile" id="${idPrefix}footerLegalNoticeShort">Legal</span>
                </a>
                <span class="footer-separator">|</span>
                <a href="/politica-privacidad" class="footer-link">
                    <span class="footer-text-desktop" id="${idPrefix}footerPrivacyPolicyFull">Privacy Policy</span>
                    <span class="footer-text-mobile" id="${idPrefix}footerPrivacyPolicyShort">Privacy</span>
                </a>
                <span class="footer-separator">|</span>
                <a href="/politica-cookies" class="footer-link">
                    <span class="footer-text-desktop" id="${idPrefix}footerCookiePolicyFull">Cookie Policy</span>
                    <span class="footer-text-mobile" id="${idPrefix}footerCookiePolicyShort">Cookies</span>
                </a>
                <span class="footer-separator">|</span>
                <a href="/terminos" class="footer-link">
                    <span class="footer-text-desktop" id="${idPrefix}footerTermsFull">Terms of Service</span>
                    <span class="footer-text-mobile" id="${idPrefix}footerTermsShort">Terms</span>
                </a>
                <span class="footer-separator">|</span>
                <select id="${idPrefix}languageSelector" class="language-selector" aria-label="Select language">
                    <option value="en">English</option>
                    <option value="de">Deutsch</option>
                    <option value="es">Español</option>
                    <option value="fr">Français</option>
                    <option value="pt">Português</option>
                </select>
                <!-- HIDDEN: Reset button (clears sessionStorage and redirects to homepage)
                <span class="footer-separator">|</span>
                <button id="${idPrefix}clearCacheButton" class="clear-button">Reset</button>
                -->
            </div>
        </footer>
    `;
}

// Inject footers into DOM
function injectFooters() {
    // Main footer
    document.body.insertAdjacentHTML('beforeend', createFooterHTML());

    // Success screen footer
    const successScreen = document.getElementById('successScreen');
    if (successScreen) {
        successScreen.insertAdjacentHTML('beforeend', createFooterHTML('success_', 'success-footer'));
    }

    // Payment selection screen footer
    const paymentSelectionScreen = document.getElementById('paymentSelectionScreen');
    if (paymentSelectionScreen) {
        paymentSelectionScreen.insertAdjacentHTML('beforeend', createFooterHTML('payment_', 'success-footer'));
    }
}

// Translate all footer instances
function translateAllFooters() {
    translateFooter('');          // Main footer
    translateFooter('success_');  // Success screen footer
    translateFooter('payment_');  // Payment selection screen footer
}

// Translate a single footer instance
function translateFooter(idPrefix = '') {
    if (!translations) return;

    // Desktop texts
    const el = (id) => document.getElementById(idPrefix + id);
    if (el('faqCancelSubscription')) el('faqCancelSubscription').textContent = translations.faqCancelSubscription || 'Cancel Subscription';
    if (el('footerLegalNoticeFull')) el('footerLegalNoticeFull').textContent = translations.footerLegalNoticeFull || 'Legal Notice';
    if (el('footerPrivacyPolicyFull')) el('footerPrivacyPolicyFull').textContent = translations.footerPrivacyPolicyFull || 'Privacy Policy';
    if (el('footerCookiePolicyFull')) el('footerCookiePolicyFull').textContent = translations.footerCookiePolicyFull || 'Cookie Policy';
    if (el('footerTermsFull')) el('footerTermsFull').textContent = translations.footerTermsFull || 'Terms of Service';

    // Mobile texts
    if (el('footerLegalNoticeShort')) el('footerLegalNoticeShort').textContent = translations.footerLegalNoticeShort || 'Legal';
    if (el('footerPrivacyPolicyShort')) el('footerPrivacyPolicyShort').textContent = translations.footerPrivacyPolicyShort || 'Privacy';
    if (el('footerCookiePolicyShort')) el('footerCookiePolicyShort').textContent = translations.footerCookiePolicyShort || 'Cookies';
    if (el('footerTermsShort')) el('footerTermsShort').textContent = translations.footerTermsShort || 'Terms';

    // Clear Cache button
    if (el('clearCacheButton')) {
        el('clearCacheButton').textContent = translations.clearCacheButton || 'Clear Cache';
        el('clearCacheButton').addEventListener('click', handleClearCache);
    }

    // Language selector
    const languageSelector = el('languageSelector');
    if (languageSelector) {
        // Pre-select current language
        const currentLang = getCurrentLanguage();
        languageSelector.value = currentLang;

        // Add change event listener
        languageSelector.addEventListener('change', (e) => {
            const newLang = e.target.value;
            // Redirect to language-specific URL
            const baseUrl = window.location.origin;
            if (newLang === 'en') {
                window.location.href = baseUrl + '/';
            } else {
                window.location.href = baseUrl + '/' + newLang + '/';
            }
        });
    }
}

// DOM Elements
const elements = {
    okButton: null,
    loadingModal: null,
    successScreen: null,
    stripeModal: null,
    progressBar: null,
    continueButton: null,
    closeStripeModal: null
};

// Prevent browser from restoring scroll position
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

// Force scroll to top immediately (before DOM loads)
window.scrollTo(0, 0);

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    // Force scroll to top again after DOM loads (Chrome iOS needs this)
    window.scrollTo(0, 0);

    // Inject footer templates before anything else
    injectFooters();

    initializeElements();
    await loadTranslations();
    setupEventListeners();
    loadClickCount();

    // Initialize Stripe with publishable key from server
    await initializeStripe();
});

// Initialize Stripe with correct publishable key (test or live mode)
async function initializeStripe() {
    try {
        const response = await fetch('/api/stripe-config');
        const config = await response.json();
        stripe = Stripe(config.publishableKey);

        // Log mode for debugging
        console.log(`🔧 Stripe initialized in ${config.isLiveMode ? '💰 LIVE' : '🧪 TEST'} mode`);
    } catch (error) {
        console.error('Error initializing Stripe:', error);
        // Fallback: Show error to user - they need to configure Stripe keys
        console.error('Please configure your Stripe keys in .env file');
    }
}

// Initialize DOM element references
function initializeElements() {
    elements.okButton = document.getElementById('okButton');
    elements.loadingModal = document.getElementById('loadingModal');
    elements.successScreen = document.getElementById('successScreen');
    elements.stripeModal = document.getElementById('stripeModal');
    elements.progressBar = document.getElementById('progressBar');
    elements.continueButton = document.getElementById('continueButton');
    elements.closeStripeModal = document.getElementById('closeStripeModal');
}

// Load translations from server
async function loadTranslations() {
    try {
        // Get current language from URL path or query parameter
        const currentLang = getCurrentLanguage();
        const url = `/api/locale?lang=${currentLang}`;

        const response = await fetch(url);
        const data = await response.json();
        translations = data.translations;
        window.currentLanguage = data.lang; // Store current language globally
        updateUIWithTranslations();
    } catch (error) {
        console.error('Error loading translations:', error);
        // Use default English if loading fails
        translations = {
            buttonText: 'Make everything OK for me',
            buttonTextSecond: 'Make everything really and totally OK',
            loadingText: 'Making everything OK for you...',
            successHeadline: 'Everything is OK for you now',
            successSubtext: 'Still not really OK?\nClick again.',
            continueButton: 'CONTINUE',
            paymentModalHeadline: 'Upgrade to Premium OK',
            paymentModalText: 'Get 0% more okayness.\nOnly $1/one-time.',
            paymentButton: 'Upgrade to Premium',
            noThanksButton: 'Stay with Basic',
            legalNotice: 'Legal Notice',
            privacy: 'Privacy',
            responsible: 'Responsible: Martin Schenk'
        };
        updateUIWithTranslations();
    }
}

// Get currency based on user locale
function getCurrency() {
    const locale = navigator.language || navigator.userLanguage || 'en';
    // EUR for European countries
    if (locale.startsWith('de') || locale.startsWith('es') || locale.startsWith('fr') ||
        locale.startsWith('it') || locale.startsWith('pt') || locale.startsWith('nl') ||
        locale.startsWith('pl') || locale.startsWith('el') || locale.startsWith('fi') ||
        locale.startsWith('sv') || locale.startsWith('da') || locale.startsWith('no')) {
        return '1€';
    }
    return '$1';
}

// Update UI elements with loaded translations
function updateUIWithTranslations() {
    updateButtonText(); // Set correct button text based on clickCount

    // Note: loadingText doesn't exist anymore in new gratis version (replaced with workingOnLabel)
    const successHeadline = document.getElementById('successHeadline');
    if (successHeadline) successHeadline.textContent = translations.successHeadline;

    const successSubtext = document.getElementById('successSubtext');
    if (successSubtext) successSubtext.innerHTML = translations.successSubtext.replace(/\n/g, '<br>');

    // Continue button now shows "Make really everything OK" instead of "CONTINUE"
    const continueButtonText = document.getElementById('continueButtonText');
    if (continueButtonText) continueButtonText.textContent = translations.buttonTextSecond;

    // ALL GOOD Badge (Gratis-Version)
    const allGoodBadge = document.getElementById('allGoodBadgeGratis');
    if (allGoodBadge && translations.allGoodBadge) {
        allGoodBadge.textContent = translations.allGoodBadge;
    }

    // Payment Selection Screen (with null checks)
    const paymentSelectionHeadline = document.getElementById('paymentSelectionHeadline');
    if (paymentSelectionHeadline) paymentSelectionHeadline.textContent = translations.paymentSelectionHeadline;

    const paymentSelectionText = document.getElementById('paymentSelectionText');
    if (paymentSelectionText) paymentSelectionText.textContent = translations.paymentSelectionText;

    const paymentButton1 = document.getElementById('paymentButton1');
    if (paymentButton1) paymentButton1.textContent = translations.paymentButton1;

    const paymentButton1Sub = document.getElementById('paymentButton1Sub');
    if (paymentButton1Sub) paymentButton1Sub.textContent = translations.paymentButton1Sub;

    const subscriptionExplainer = document.getElementById('subscriptionExplainer');
    if (subscriptionExplainer) subscriptionExplainer.textContent = translations.subscriptionExplainer;

    const paymentButton2 = document.getElementById('paymentButton2');
    if (paymentButton2) paymentButton2.textContent = translations.paymentButton2;

    const paymentButton2Sub1 = document.getElementById('paymentButton2Sub1');
    if (paymentButton2Sub1) paymentButton2Sub1.textContent = translations.paymentButton2Sub1;

    const paymentButton2Sub2 = document.getElementById('paymentButton2Sub2');
    if (paymentButton2Sub2) paymentButton2Sub2.textContent = translations.paymentButton2Sub2;

    const paymentButton3 = document.getElementById('paymentButton3');
    if (paymentButton3) paymentButton3.textContent = translations.paymentButton3;

    // Translate all footer instances (DRY - no redundant code!)
    translateAllFooters();
}

// Update button text based on click count
function updateButtonText() {
    const buttonTextElement = document.getElementById('buttonText');
    const buttonSubtextElement = document.getElementById('buttonSubtext');

    if (clickCount >= 1) {
        // After first click (when user clicks CONTINUE), show second text with subtext
        buttonTextElement.textContent = translations.buttonTextSecond || translations.buttonText;
        if (translations.buttonSubtextSecond) {
            buttonSubtextElement.textContent = translations.buttonSubtextSecond;
            buttonSubtextElement.style.display = 'block';
        }
    } else {
        // First time, show normal button text without subtext
        buttonTextElement.textContent = translations.buttonText;
        buttonSubtextElement.style.display = 'none';
    }
}

// Setup event listeners
function setupEventListeners() {
    elements.okButton.addEventListener('click', handleButtonClick);
    elements.continueButton.addEventListener('click', handleContinue);
    elements.closeStripeModal.addEventListener('click', closeStripeModal);

    // Payment Selection Screen buttons
    document.getElementById('oneTimeButton').addEventListener('click', handleOneTimePayment);
    document.getElementById('subscriptionButton').addEventListener('click', handleSubscriptionPayment);
    document.getElementById('declineButton').addEventListener('click', handleDeclinePayment);

    // Note: Clear Cache button listeners are now attached in translateFooter()
}

// Get current language from URL parameter or global translations object
function getCurrentLanguage() {
    // Check URL path first (e.g., /de/ -> 'de')
    const path = window.location.pathname;
    const pathLangMatch = path.match(/^\/([a-z]{2})\//);
    if (pathLangMatch) {
        return pathLangMatch[1];
    }

    // Fall back to URL parameter (for backwards compatibility)
    const urlParams = new URLSearchParams(window.location.search);
    const langParam = urlParams.get('lang');
    if (langParam) {
        return langParam;
    }

    // Fall back to detected language from translations (set during loadTranslations)
    if (window.currentLanguage) {
        return window.currentLanguage;
    }

    // Default to English (root path /)
    return 'en';
}

// Handle clear cache (reset session)
function handleClearCache() {
    sessionStorage.clear();
    localStorage.clear(); // Clear clickCount and all other localStorage data
    // Force scroll to top before redirect
    window.scrollTo(0, 0);
    // Use replace to avoid creating new history entry (prevents scroll restoration)
    window.location.replace('/');
}

// Load click count from sessionStorage
function loadClickCount() {
    const stored = sessionStorage.getItem('clickCount');
    clickCount = stored ? parseInt(stored, 10) : 0;

    // Log for debugging
    console.log('Loaded clickCount:', clickCount);
}

// Save click count to sessionStorage
function saveClickCount() {
    sessionStorage.setItem('clickCount', clickCount.toString());
}

// Handle main button click
async function handleButtonClick() {
    if (isProcessing) return;

    clickCount++;
    saveClickCount();

    if (clickCount === 1) {
        // First click: Show loading animation
        await showLoadingAnimation();
    } else {
        // Second+ click: Show payment selection screen
        showPaymentSelectionScreen();
    }
}

// Show loading animation with progress bar AND wechselnde Texte!
function showLoadingAnimation() {
    return new Promise((resolve) => {
        isProcessing = true;
        elements.loadingModal.classList.add('active');

        // Lade übersetzten Text für "Working on..." Label
        const workingOnLabel = document.getElementById('workingOnLabel');
        if (workingOnLabel && translations.workingOn) {
            workingOnLabel.textContent = translations.workingOn;
        }

        // 3 Texte (je 2 Sekunden = 6 Sekunden total) - AUS TRANSLATIONS!
        const gratisTexts = translations.loadingProblemsGratis || [
            'Fixing your problems...',
            'Installing good vibes...',
            'Calibrating happiness...'
        ];

        const problems = [
            { icon: '⚙️', text: gratisTexts[0] },
            { icon: '✨', text: gratisTexts[1] },
            { icon: '🎯', text: gratisTexts[2] }
        ];

        const duration = 6000; // 6 seconds total
        const problemInterval = 2000; // 2 seconds per text
        const startTime = Date.now();
        let currentProblemIndex = 0;
        let lastProblemChange = Date.now();

        // Get elements
        const iconElement = document.getElementById('problemIconGratis');
        const textElement = document.getElementById('problemTextGratis');

        // Set initial problem
        if (iconElement && textElement) {
            iconElement.textContent = problems[0].icon;
            textElement.textContent = problems[0].text;
        }

        // Function to change problem text with CROSSFADE
        function changeProblemText(newIndex) {
            if (!iconElement || !textElement) return;

            // Fade out
            iconElement.classList.add('fading');
            textElement.classList.add('fading');

            // Wait for fade out, then change content and fade in
            setTimeout(() => {
                iconElement.textContent = problems[newIndex].icon;
                textElement.textContent = problems[newIndex].text;

                // Fade in
                iconElement.classList.remove('fading');
                textElement.classList.remove('fading');
            }, 800); // Match CSS transition duration
        }

        const interval = setInterval(() => {
            const now = Date.now();
            const elapsed = now - startTime;
            const progress = Math.min((elapsed / duration) * 100, 100);
            elements.progressBar.style.width = `${progress}%`;

            // Change problem text every 2 seconds
            if (now - lastProblemChange >= problemInterval && currentProblemIndex < problems.length - 1) {
                currentProblemIndex++;
                lastProblemChange = now;
                changeProblemText(currentProblemIndex);
            }

            if (progress >= 100) {
                clearInterval(interval);
                setTimeout(() => {
                    elements.loadingModal.classList.remove('active');
                    showSuccessScreen();
                    isProcessing = false;
                    resolve();
                }, 300);
            }
        }, 50);
    });
}

// Show success screen with KONFETTI!
function showSuccessScreen() {
    console.log('📺 showSuccessScreen() aufgerufen!');

    elements.successScreen.classList.add('active');

    console.log('✅ successScreen hat jetzt .active Klasse');

    // Trigger Konfetti-Fontäne von unten (3 Sekunden)
    triggerConfettiFountain();
}

// Konfetti von beiden Seiten (nur für Gratis-Version)
function triggerConfettiFountain() {
    console.log('🎉 Konfetti startet!');

    // Check if confetti library is loaded
    if (typeof confetti === 'undefined') {
        console.error('❌ Confetti library not loaded!');
        return;
    }

    const duration = 3000; // 3 Sekunden
    const animationEnd = Date.now() + duration;
    const colors = ['#11998e', '#38ef7d', '#ffffff', '#ffd700'];

    let frameCount = 0;
    let canvasFixed = false;

    (function frame() {
        frameCount++;

        if (frameCount === 1) {
            console.log('🎬 Konfetti frame() Loop gestartet');
        }

        // FIX: Canvas z-index erhöhen (nur einmal) damit er ÜBER success-screen (z-index: 2000) liegt
        if (!canvasFixed) {
            const canvas = document.querySelector('canvas[style*="position: fixed"]');
            if (canvas) {
                canvas.style.zIndex = '9999';
                console.log('✅ Canvas z-index auf 9999 gesetzt - jetzt sollte Konfetti sichtbar sein!');
                canvasFixed = true;
            }
        }

        // Konfetti von LINKS
        confetti({
            particleCount: 3,
            angle: 60,
            spread: 55,
            origin: { x: 0, y: 0.6 }, // Links Mitte
            colors: colors,
            startVelocity: 30,
            gravity: 1,
            scalar: 1.5,
            ticks: 200,
            drift: 0
        });

        // Konfetti von RECHTS
        confetti({
            particleCount: 3,
            angle: 120,
            spread: 55,
            origin: { x: 1, y: 0.6 }, // Rechts Mitte
            colors: colors,
            startVelocity: 30,
            gravity: 1,
            scalar: 1.5,
            ticks: 200,
            drift: 0
        });

        if (Date.now() < animationEnd) {
            requestAnimationFrame(frame);
        } else {
            console.log('✅ Konfetti fertig!');
        }
    }());
}

// Handle continue button click
function handleContinue() {
    elements.successScreen.classList.remove('active');
    // Show payment selection screen directly
    showPaymentSelectionScreen();
}

// Close Stripe modal
function closeStripeModal() {
    elements.stripeModal.classList.remove('active');

    // Destroy current checkout instance
    if (currentCheckout) {
        currentCheckout.destroy();
        currentCheckout = null;
    }

    // Clear container
    document.getElementById('stripeCheckoutContainer').innerHTML = '';
}

// Payment Selection Screen Functions
function showPaymentSelectionScreen() {
    document.getElementById('paymentSelectionScreen').classList.add('active');
}

function hidePaymentSelectionScreen() {
    document.getElementById('paymentSelectionScreen').classList.remove('active');
}

// Handle one-time payment button
async function handleOneTimePayment() {
    const button = document.getElementById('oneTimeButton');
    const originalHTML = button.innerHTML;

    // Disable button and show loading state
    button.disabled = true;
    button.innerHTML = `<span class="option-main-text">${translations.loadingPayment || 'Loading...'}</span>`;

    try {
        // Get user-selected language (from dropdown) or browser language as fallback
        const browserLang = getCurrentLanguage();
        const isMobile = isMobileDevice();

        // Call Stripe API to create checkout session
        const response = await fetch('/create-checkout-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                language: browserLang,
                isMobile: isMobile
            })
        });

        if (!response.ok) {
            throw new Error('Failed to create checkout session');
        }

        const data = await response.json();

        // Hide payment selection screen
        hidePaymentSelectionScreen();

        // Mobile: Redirect to Stripe hosted page
        if (data.url) {
            window.location.href = data.url;
            return;
        }

        // Desktop: Show Stripe modal with embedded checkout
        elements.stripeModal.classList.add('active');

        // Destroy previous checkout if exists
        if (currentCheckout) {
            currentCheckout.destroy();
        }

        // Initialize Stripe Embedded Checkout
        currentCheckout = await stripe.initEmbeddedCheckout({
            clientSecret: data.clientSecret
        });

        // Mount the Stripe checkout form
        currentCheckout.mount('#stripeCheckoutContainer');
    } catch (error) {
        console.error('Error in handleOneTimePayment:', error);
        alert('Sorry, there was an error processing your request. Please try again.');
        // Restore button and show payment selection screen again
        showPaymentSelectionScreen();
        button.disabled = false;
        button.innerHTML = originalHTML;
    }
}

// Handle subscription payment button
async function handleSubscriptionPayment() {
    const button = document.getElementById('subscriptionButton');
    const originalHTML = button.innerHTML;

    // Disable button and show loading state
    button.disabled = true;
    button.innerHTML = `<span class="option-main-text">${translations.loadingPayment || 'Loading...'}</span>`;

    try {
        // Get user-selected language (from dropdown) or browser language as fallback
        const browserLang = getCurrentLanguage();
        const isMobile = isMobileDevice();

        const response = await fetch('/create-subscription-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                language: browserLang,
                isMobile: isMobile
            })
        });

        if (!response.ok) {
            throw new Error('Failed to create subscription session');
        }

        const data = await response.json();

        // Redirect to Stripe Checkout (subscriptions always use hosted checkout)
        if (data.url) {
            // Redirect directly - keep screen visible to avoid flash
            window.location.href = data.url;
        }
    } catch (error) {
        console.error('Error creating subscription session:', error);
        alert('Sorry, there was an error processing your request. Please try again.');
        // Restore button on error
        button.disabled = false;
        button.innerHTML = originalHTML;
    }
}

// Handle decline payment button
function handleDeclinePayment() {
    hidePaymentSelectionScreen();
    // Reset to beginning - user can play for free again
    clickCount = 0;
    saveClickCount();
    // Update button text back to first version
    updateButtonText();
}

// Detect if user is on mobile device
function isMobileDevice() {
    // Check screen width (mobile if < 768px)
    const isMobileScreen = window.innerWidth < 768;

    // Check user agent for mobile keywords
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent.toLowerCase());

    // Check for touch support
    const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

    return isMobileScreen || isMobileUA || isTouchDevice;
}

// Check URL parameters on page load (for redirects from Stripe)
(function checkURLParams() {
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session_id');

    if (sessionId) {
        // User returned from successful payment
        // The success.html page will handle this
        return;
    }
})();

// Language Suggestion Banner
(async function checkLanguageSuggestion() {
    // Check if user already dismissed the banner in this session
    if (sessionStorage.getItem('languageBannerDismissed')) {
        return;
    }

    // Get browser language
    const browserLang = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    const browserLangCode = browserLang.split('-')[0]; // 'de-DE' -> 'de'

    // Get current page language
    const currentLang = getCurrentLanguage();

    // Supported languages
    const supportedLangs = ['en', 'de', 'es', 'fr', 'pt'];

    // If browser language is supported and different from current page language
    if (supportedLangs.includes(browserLangCode) && browserLangCode !== currentLang) {
        // Load translations for browser language
        try {
            const response = await fetch(`/api/locale?lang=${browserLangCode}`);
            const data = await response.json();
            const browserLangTranslations = data.translations;

            // Show banner with suggestion text in browser's language
            const banner = document.getElementById('languageBanner');
            const bannerText = document.getElementById('languageBannerText');
            const bannerLink = document.getElementById('languageBannerLink');
            const bannerClose = document.getElementById('languageBannerClose');

            if (banner && bannerText && bannerLink && bannerClose) {
                // Set text in browser's language
                bannerText.textContent = browserLangTranslations.languageSuggestion || '';
                bannerLink.textContent = browserLangTranslations.switchToLanguage || '';

                // Set link to browser's language URL
                const targetUrl = browserLangCode === 'en' ? '/' : `/${browserLangCode}/`;
                bannerLink.href = targetUrl;

                // Show banner
                banner.style.display = 'block';

                // Auto-hide after 10 seconds
                setTimeout(() => {
                    if (banner.style.display === 'block') {
                        banner.style.display = 'none';
                        sessionStorage.setItem('languageBannerDismissed', 'true');
                    }
                }, 10000); // 10 seconds

                // Close button handler
                bannerClose.addEventListener('click', () => {
                    banner.style.display = 'none';
                    sessionStorage.setItem('languageBannerDismissed', 'true');
                });

                // Link click handler
                bannerLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    sessionStorage.setItem('languageBannerDismissed', 'true');
                    window.location.href = targetUrl;
                });
            }
        } catch (error) {
            console.error('Error loading language suggestion:', error);
        }
    }
})();
