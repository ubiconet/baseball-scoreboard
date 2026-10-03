/**
 * GameChanger Selenium Session — adapted from BaseballScout proven implementation.
 *
 * Handles the initial login flow only:
 *   1. Launch headless Chrome
 *   2. Navigate to web.gc.com/login
 *   3. Inject network interceptor (hooks fetch + XHR to capture /auth response)
 *   4. Enter email → password → detect/handle 2FA
 *   5. Extract auth tokens (access, refresh, clientId) from captured response
 *
 * After login, tokens are persisted to the scoreboard row and Selenium is no
 * longer needed — all ongoing API access uses the REST client in
 * gamechanger-api-helper.ts.
 */

import { Builder, By, until, type WebDriver } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { createHash } from 'crypto';

export interface GameChangerCredentials {
  email: string;
  password: string;
  verificationCode?: string; // 2FA code, supplied on second call if needed
}

interface CapturedAuth {
  type: string;
  access: { data: string } | string;
  refresh: { data: string } | string;
}

/**
 * JS injected into the browser page to intercept /auth responses.
 * Captures the token response (access + refresh) into window.__gcAuthResponse.
 */
const INTERCEPTOR_JS = `
  if (!window.__gcInterceptorInstalled) {
    const matchAuth = (url) => url && url.includes('api.team-manager.gc.com/auth');
    const capture = (data) => {
      if (data && data.type === 'token' && data.access && data.refresh) {
        window.__gcAuthResponse = data;
        console.log('[gc] Captured auth response (access + refresh tokens)');
      }
    };
    // Hook fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      return originalFetch.apply(this, args).then(async (response) => {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (matchAuth(url)) {
          try { capture(await response.clone().json()); } catch (e) {}
        }
        return response;
      });
    };
    // Hook XHR
    const originalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('load', function() {
        if (matchAuth(this.responseURL)) {
          try { capture(JSON.parse(this.responseText)); } catch (e) {}
        }
      });
      return originalXHRSend.apply(this, args);
    };
    window.__gcInterceptorInstalled = true;
    console.log('[gc] Network interceptor installed');
  }
`;

export class GameChangerSession {
  private driver: WebDriver | null = null;
  public credentials: GameChangerCredentials;
  private deviceId: string;
  private authToken: string | null = null;
  private refreshToken: string | null = null;
  private clientId: string | null = null;

  constructor(credentials: GameChangerCredentials, deviceId?: string) {
    this.credentials = credentials;
    // Device ID must be stable per-user so GameChanger remembers the device
    // and doesn't prompt for 2FA every login
    this.deviceId =
      deviceId ||
      createHash('md5')
        .update(`${credentials.email}-scoreboard-gamechanger`)
        .digest('hex');
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Return the auth tokens captured by the most recent login() / continue2FA()
   * call, or null if login hasn't completed yet. Used by the route layer to
   * persist tokens to the scoreboard row.
   */
  getAuth(): {
    authToken: string | null;
    refreshToken: string | null;
    clientId: string | null;
    deviceId: string;
  } | null {
    if (!this.authToken || !this.refreshToken) return null;
    return {
      authToken: this.authToken,
      refreshToken: this.refreshToken,
      clientId: this.clientId,
      deviceId: this.deviceId,
    };
  }
  getAuthToken(): string | null {
    return this.authToken;
  }
  getRefreshToken(): string | null {
    return this.refreshToken;
  }
  getClientId(): string | null {
    return this.clientId;
  }

  /** Launch headless Chrome with anti-detection flags. */
  async init(): Promise<void> {
    console.log('[gc-session] Initializing headless Chrome...');

    const options = new chrome.Options();
    options.addArguments(
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=1920,1080',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );

    this.driver = await new Builder()
      .forBrowser('chrome')
      .setChromeOptions(options)
      .build();

    await this.driver.manage().setTimeouts({
      implicit: 10000,
      pageLoad: 30000,
      script: 15000,
    });

    console.log('[gc-session] Browser session initialized');
  }

  /**
   * Read window.__gcAuthResponse and extract tokens + clientId.
   * The JWT payload's `cid` field is the clientId.
   */
  private async extractAuthToken(): Promise<void> {
    if (!this.driver) return;

    const authData = (await this.driver.executeScript(
      'return window.__gcAuthResponse || null;'
    )) as CapturedAuth | null;

    if (!authData) {
      console.warn('[gc-session] No auth response captured');
      return;
    }

    // Store the full response as authToken (API helper expects JSON string)
    this.authToken = JSON.stringify(authData);

    // Extract refresh token
    this.refreshToken =
      typeof authData.refresh === 'object' ? authData.refresh.data : authData.refresh;

    // Decode JWT to extract clientId
    const accessToken = typeof authData.access === 'object' ? authData.access.data : authData.access;
    try {
      const jwtParts = accessToken.split('.');
      if (jwtParts.length === 3) {
        let base64 = jwtParts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4 !== 0) base64 += '=';
        const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
        if (payload.cid) {
          this.clientId = payload.cid;
          console.log(`[gc-session] Extracted clientId from JWT: ${this.clientId}`);
        }
      }
    } catch (e) {
      console.warn('[gc-session] Failed to decode JWT for clientId:', e);
    }

    console.log(
      `[gc-session] Tokens extracted — refresh: ${!!this.refreshToken}, clientId: ${!!this.clientId}`
    );
  }

  /**
   * Perform login. Throws VERIFICATION_CODE_REQUIRED if 2FA is needed —
   * the caller should then prompt the user and call continue2FA().
   */
  async login(): Promise<boolean> {
    if (!this.driver) throw new Error('Session not initialized. Call init() first.');

    console.log('[gc-session] Navigating to login page...');
    await this.driver.get('https://web.gc.com/login');
    try {
      await this.driver.wait(until.titleContains('GameChanger'), 10000);
    } catch {
      // Title might not contain GameChanger immediately — continue anyway
    }

    // Inject interceptor BEFORE any login action
    console.log('[gc-session] Injecting network interceptor...');
    await this.driver.executeScript(INTERCEPTOR_JS);

    // STEP 1: email
    console.log('[gc-session] Entering email...');
    const emailField = await this.driver.wait(
      until.elementLocated(
        By.css('input[type="email"], input[name="email"], #email')
      ),
      10000
    );
    await emailField.clear();
    await emailField.sendKeys(this.credentials.email);

    const continueButton = await this.driver.findElement(
      By.css('button[type="button"], .Button__gc-blue, button.Button__filled, button[data-testid="sign-in-button"]')
    );
    await continueButton.click();

    // STEP 2: wait for password page
    await this.driver.sleep(2000);

    // Check for 2FA code field
    const codeFields = await this.driver.findElements(
      By.css('input[name="code"], input[placeholder*="code" i], input[placeholder*="verification" i]')
    );

    if (codeFields.length > 0) {
      console.log('[gc-session] 2FA verification code required');
      if (!this.credentials.verificationCode?.trim()) {
        const err = new Error(
          'VERIFICATION_CODE_REQUIRED: GameChanger requires a verification code sent to your email'
        );
        err.name = 'VERIFICATION_CODE_REQUIRED';
        throw err;
      }
      // Code provided — enter it
      await codeFields[0].clear();
      await codeFields[0].sendKeys(this.credentials.verificationCode);
      console.log('[gc-session] Verification code entered');
    }

    // Enter password (always required)
    console.log('[gc-session] Entering password...');
    const passwordField = await this.driver.wait(
      until.elementLocated(
        By.css('input[type="password"], input[name="password"], #password')
      ),
      10000
    );
    await passwordField.clear();
    await passwordField.sendKeys(this.credentials.password);

    // Submit
    const submitButton = await this.driver.findElement(
      By.css('button[type="submit"], button.Button__filled, button[data-testid="sign-in-button"]')
    );
    await submitButton.click();
    console.log('[gc-session] Login submitted');

    return this.waitForLoginSuccess();
  }

  /**
   * Continue a 2FA-challenged login. Assumes the browser is still on the 2FA page
   * from a previous login() call that threw VERIFICATION_CODE_REQUIRED.
   */
  async continue2FA(): Promise<boolean> {
    if (!this.driver) throw new Error('Session not initialized.');

    console.log('[gc-session] Continuing 2FA authentication...');

    // Interceptor should still be installed from login() — re-inject just in case
    await this.driver.executeScript(INTERCEPTOR_JS);

    const codeField = await this.driver.findElement(
      By.css('input[name="code"], input[placeholder*="code" i], input[placeholder*="verification" i]')
    );
    await codeField.clear();
    await codeField.sendKeys(this.credentials.verificationCode!);

    // Re-enter password (GC shows it on the 2FA page)
    const passwordFields = await this.driver.findElements(
      By.css('input[type="password"], input[name="password"], #password')
    );
    if (passwordFields.length > 0) {
      await passwordFields[0].clear();
      await passwordFields[0].sendKeys(this.credentials.password);
    }

    const submitButton = await this.driver.findElement(
      By.css('button[type="submit"], button.Button__filled, button[data-testid="sign-in-button"]')
    );
    await submitButton.click();
    console.log('[gc-session] 2FA form submitted');

    return this.waitForLoginSuccess();
  }

  /** Wait for post-login page load + capture tokens. */
  private async waitForLoginSuccess(): Promise<boolean> {
    if (!this.driver) return false;

    // Wait for redirect away from login page (up to 15s)
    try {
      await this.driver.wait(async () => {
        const url = await this.driver!.getCurrentUrl();
        return !url.includes('/login') && !url.includes('login');
      }, 15000);
    } catch {
      // Fall through — we'll still try to extract tokens
    }

    // Give the SPA a moment to fire its auth requests
    await this.driver.sleep(2000);

    await this.extractAuthToken();
    const success = !!this.authToken && !!this.refreshToken;
    console.log(`[gc-session] Login ${success ? 'succeeded' : 'failed — tokens not captured'}`);
    return success;
  }

  async close(): Promise<void> {
    if (this.driver) {
      try {
        await this.driver.quit();
      } catch {
        // ignore
      }
      this.driver = null;
    }
  }
}
