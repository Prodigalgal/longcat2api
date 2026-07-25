import { config } from '../config.js';
import { launchBrowser, defaultContextOptions } from './browser.js';
import { buildLoginPageUrl } from './mykeetaClient.js';
import {
  ensureAuthProxy,
  cookiesToLongcatSession,
  isLongcatUrl,
} from './mykeetaAuthRuntime.js';
import {
  clickSubmitContinue,
  fillEmail,
  solveYodaChallenge,
  switchToEmail,
} from './mykeetaBrowserRegister.js';
import {
  isTempMailConfigured,
  listParsedMails,
  waitForCode,
} from './tempMail.js';

const SELECTORS = {
  email:
    'input[placeholder*="Email" i]:not([type="tel"]):not(.oversea-mobile-input), input[type="email"]',
  password: 'input[type="password"]',
  otp:
    'input[inputmode="numeric"], .verify-code-input input, .pc-login-verify-code-container input, input[maxlength="6"], input[maxlength="1"]',
  yoda:
    '#yodaVerify, .yoda-verify-container, .global-puzzle-main, .yoda-sudoku-wrap, .yoda-global-inference-wrapper',
};

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function emit(onLog, message) {
  console.log(`[Reauthorize] ${message}`);
  if (typeof onLog === 'function') onLog(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submit(page) {
  if (await clickSubmitContinue(page)) return true;
  const textButton = page.getByText(/^(continue|log in|sign in|submit)$/i).first();
  if (await textButton.isVisible().catch(() => false)) {
    await textButton.click({ force: true, timeout: 5000 });
    return true;
  }
  return false;
}

async function visiblePageState(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden';
    };
    const inputs = [...document.querySelectorAll('input')]
      .filter(visible)
      .map((input) => ({
        type: input.type || 'text',
        placeholder: input.placeholder || '',
        maxlength: input.maxLength,
      }));
    const buttons = [...document.querySelectorAll('button, div.submit-btn')]
      .filter(visible)
      .map((button) => (button.innerText || '').trim())
      .filter(Boolean)
      .slice(0, 8);
    return { inputs, buttons };
  }).catch(() => ({ inputs: [], buttons: [] }));
}

async function clickChoice(page, pattern) {
  const choice = page.getByText(pattern).first();
  if (!(await choice.isVisible().catch(() => false))) return false;
  await choice.click({ force: true, timeout: 5000 });
  await sleep(600);
  return true;
}

async function fillOtp(page, code) {
  const inputs = page.locator(
    '.verify-code-input input, .pc-login-verify-code-container input, input[inputmode="numeric"], input[maxlength]'
  );
  const visible = [];
  for (let index = 0; index < (await inputs.count()); index++) {
    const input = inputs.nth(index);
    if (await input.isVisible().catch(() => false)) visible.push(input);
  }
  if (visible.length === 1) {
    await visible[0].fill(String(code));
    return;
  }
  if (visible.length >= 4) {
    for (let index = 0; index < Math.min(visible.length, String(code).length); index++) {
      await visible[index].fill(String(code)[index]);
    }
    return;
  }
  throw new Error(`OTP input not found (visible=${visible.length})`);
}

async function mailboxSnapshot(mailConfig, account) {
  if (!account.mail_jwt || !isTempMailConfigured(mailConfig)) return [];
  try {
    const mails = await listParsedMails(mailConfig, account.mail_jwt, { limit: 30 });
    return mails.map((mail) => mail.id || mail.message_id).filter(Boolean);
  } catch {
    return [];
  }
}

function watchAuthNetwork(page, onLog) {
  const state = {
    riskSeen: false,
    hasPassword: null,
    otpSent: false,
    passwordAccepted: false,
    lastError: '',
  };
  page.on('response', async (response) => {
    const url = response.url();
    if (!/mykeeta\.com\/api\/emaillogin\/v1\//i.test(url)) return;
    let payload = null;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return;
    }
    const error = payload?.error;
    if (/userriskcheck/i.test(url)) {
      state.riskSeen = true;
      state.hasPassword = payload?.data?.hasPassword ?? null;
      emit(onLog, `risk check hasPassword=${state.hasPassword}`);
    }
    if (/emailloginapply/i.test(url)) {
      state.otpSent = !error;
      emit(onLog, `OTP apply ${state.otpSent ? 'accepted' : `failed code=${error?.code || 'unknown'}`}`);
    }
    if (/emailpasswordlogin/i.test(url)) {
      state.passwordAccepted = !error;
      emit(
        onLog,
        `password login ${state.passwordAccepted ? 'accepted' : `failed code=${error?.code || 'unknown'}`}`
      );
    }
    if (error) state.lastError = `${error.code || ''}: ${error.message || error.type || 'error'}`;
    if ([101135, 101259].includes(Number(error?.code))) state.fatalError = state.lastError;
  });
  return state;
}

async function collectSession(page, context, deadline) {
  if (!isLongcatUrl(page.url())) {
    await page
      .waitForURL((url) => isLongcatUrl(url.toString()), {
        timeout: Math.min(120000, Math.max(15000, deadline - Date.now())),
      })
      .catch(() => {});
  }
  if (!isLongcatUrl(page.url())) {
    await page.goto('https://longcat.chat/', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
  }
  await sleep(2500);
  let session = cookiesToLongcatSession(await context.cookies());
  if (!session.passport_token) {
    await page.goto('https://longcat.chat/t', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await sleep(2500);
    session = cookiesToLongcatSession(await context.cookies());
  }
  if (!session.passport_token) throw new Error('login completed without passport_token_key');
  return session;
}

async function reauthorizeOnce(
  account,
  { onLog, timeoutMs = envInt('LONGCAT2API_REAUTHORIZE_TIMEOUT_MS', 420000) } = {}
) {
  if (!account?.email) throw new Error('reauthorization requires account email');
  if (!account.password && !account.mail_jwt) {
    throw new Error('reauthorization requires saved password or mailbox token');
  }

  const mailConfig = config.getTempMail();
  const ignoredMailIds = await mailboxSnapshot(mailConfig, account);
  const proxyUrl = await ensureAuthProxy({ onLog });
  const launched = await launchBrowser({
    headless: process.env.LONGCAT2API_REGISTER_HEADLESS !== '0',
    proxyUrl,
  });
  const { browser, engine, close } = launched;
  const context = await browser.newContext(defaultContextOptions({ engine }));
  const page = await context.newPage();
  const authState = watchAuthNetwork(page, onLog);
  const deadline = Date.now() + timeoutMs;
  let passwordSubmitted = false;
  let otpSubmitted = false;
  let emailAdvanceAttempts = 0;
  let lastEmailAdvanceAt = 0;
  let lastDiagnosticAt = 0;

  page.setDefaultTimeout(envInt('LONGCAT2API_REG_ACTION_MS', 45000));
  page.setDefaultNavigationTimeout(envInt('LONGCAT2API_REG_GOTO_MS', 120000));

  try {
    emit(onLog, `starting email=${account.email} engine=${engine}`);
    await page.goto(buildLoginPageUrl(), {
      waitUntil: 'domcontentloaded',
      timeout: envInt('LONGCAT2API_REG_GOTO_MS', 120000),
    });
    await sleep(envInt('LONGCAT2API_REG_H5GUARD_MS', 8000));
    await switchToEmail(page, onLog);
    await fillEmail(page, account.email, onLog);
    await submit(page);
    emailAdvanceAttempts++;
    lastEmailAdvanceAt = Date.now();

    while (Date.now() < deadline) {
      if (authState.fatalError) throw new Error(`passport denied: ${authState.fatalError}`);
      if (isLongcatUrl(page.url())) {
        const session = await collectSession(page, context, deadline);
        emit(onLog, `success token=${session.passport_token.slice(0, 8)}...`);
        return { ok: true, ...session, engine };
      }

      const yoda = page.locator(SELECTORS.yoda).first();
      if (await yoda.isVisible().catch(() => false)) {
        const result = await solveYodaChallenge(page, onLog);
        if (!result.handled) throw new Error(result.error || 'Yoda verification failed');
        await submit(page);
        await sleep(1200);
        continue;
      }

      const body = await page.locator('body').innerText().catch(() => '');
      if (/incorrect password|invalid password|password is incorrect/i.test(body)) {
        passwordSubmitted = true;
        await clickChoice(
          page,
          /verification code|email code|log in with code|forgot password/i
        );
      }

      const password = page.locator(SELECTORS.password).first();
      if (!passwordSubmitted && account.password && (await password.isVisible().catch(() => false))) {
        await password.fill(account.password);
        passwordSubmitted = true;
        emit(onLog, 'submitting saved password');
        await submit(page);
        await sleep(1200);
        continue;
      }

      const otp = page.locator(SELECTORS.otp).first();
      if (!otpSubmitted && (await otp.isVisible().catch(() => false))) {
        if (!account.mail_jwt || !isTempMailConfigured(mailConfig)) {
          throw new Error('login requires OTP but mailbox access is unavailable');
        }
        if (!authState.otpSent) {
          await clickChoice(page, /send code|resend|get code|continue/i);
          await submit(page);
          await sleep(1500);
          if (!authState.otpSent) {
            emit(onLog, 'OTP input visible but emailloginapply not observed; waiting for send action');
            continue;
          }
        }
        const code = await waitForCode(mailConfig, account.mail_jwt, {
          timeout: Math.min(
            Math.max(30000, deadline - Date.now() - 30000),
            (Number(mailConfig.otp_timeout) || 240) * 1000
          ),
          pollInterval: 3000,
          ignoreMailIds: ignoredMailIds,
        });
        await page.locator(SELECTORS.otp).first().waitFor({ state: 'visible', timeout: 15000 });
        await fillOtp(page, code);
        otpSubmitted = true;
        emit(onLog, 'submitting fresh email OTP');
        await submit(page);
        await sleep(1200);
        continue;
      }

      const emailVisible = await page.locator(SELECTORS.email).first().isVisible().catch(() => false);
      if (
        emailVisible &&
        authState.riskSeen &&
        !authState.otpSent &&
        emailAdvanceAttempts < 3 &&
        Date.now() - lastEmailAdvanceAt >= 3000
      ) {
        await fillEmail(page, account.email, onLog);
        await submit(page);
        emailAdvanceAttempts++;
        lastEmailAdvanceAt = Date.now();
        emit(onLog, `advancing email form after risk check (${emailAdvanceAttempts}/3)`);
        await sleep(1200);
        continue;
      }

      if (Date.now() - lastDiagnosticAt >= 30000) {
        const state = await visiblePageState(page);
        emit(onLog, `waiting page state=${JSON.stringify(state)}`);
        lastDiagnosticAt = Date.now();
      }

      if (!passwordSubmitted && account.password) {
        await clickChoice(page, /continue with password|log in with password/i);
      }
      if (!otpSubmitted && account.mail_jwt) {
        await clickChoice(page, /verification code|email code|log in with code/i);
      }
      await sleep(800);
    }
    throw new Error(`reauthorization timeout at ${page.url()}`);
  } finally {
    await context.close().catch(() => {});
    await close().catch(() => {});
  }
}

export async function reauthorizeAccount(account, options = {}) {
  const attempts = Math.max(
    1,
    Math.min(4, Number(process.env.LONGCAT2API_REAUTHORIZE_ATTEMPTS || 3))
  );
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      emit(options.onLog, `browser attempt ${attempt}/${attempts}`);
      return await reauthorizeOnce(account, options);
    } catch (error) {
      lastError = error;
      emit(options.onLog, `attempt ${attempt}/${attempts} failed: ${error.message}`);
    }
  }
  throw lastError || new Error('reauthorization failed');
}
