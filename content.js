(() => {
  const ROOT_ID = 'usage-hud-root';
  const POLL_MS = 30_000;
  const DEBUG_PREFIX = '[usage-hud]';
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  let chatgptHeaderCache = { headers: null, cachedAt: 0 };

  const SITE_CONFIG = {
    'chatgpt.com': {
      siteName: 'ChatGPT',
      endpoints: ['/backend-api/wham/usage'],
      windowsMs: { session: 5 * HOUR_MS, weekly: 7 * DAY_MS },
      parser: parseWhamUsage
    },
    'claude.ai': {
      siteName: 'Claude',
      getEndpoints: buildClaudeEndpoints,
      windowsMs: { session: 5 * HOUR_MS, weekly: 7 * DAY_MS },
      parser: parseClaudeUsage
    }
  };

  const config = SITE_CONFIG[location.hostname];
  if (!config) return;

  debug('script-start', { host: location.hostname, href: location.href });
  if (location.hostname === 'chatgpt.com') {
    installBackgroundSnifferListener();
  }

  const ui = createHud(config);
  installHud(ui.root);
  setBars(ui, {
    session: { state: 'loading', usedPct: 0, detail: 'Loading…', elapsedPct: null },
    weekly: { state: 'loading', usedPct: 0, detail: 'Loading…', elapsedPct: null }
  });
  setDebug(ui, `Init on ${location.hostname}`);

  refresh();
  setInterval(refresh, POLL_MS);

  async function refresh() {
    const endpoints = resolveEndpoints(config);
    debug('refresh-start', { host: location.hostname, endpoints });
    const data = await fetchUsage(config, endpoints);
    setBars(ui, data);
    setDebug(ui, `Last update: ${new Date().toLocaleTimeString()}`);
    debug('refresh-done', data);
  }

  async function fetchUsage(siteConfig, endpoints) {
    let sawNotLoggedIn = false;

    for (const endpoint of endpoints) {
      try {
        const absoluteEndpoint = new URL(endpoint, location.origin).toString();
        const url = siteConfig.siteName === 'ChatGPT'
          ? absoluteEndpoint
          : `${absoluteEndpoint}${absoluteEndpoint.includes('?') ? '&' : '?'}_hudts=${Date.now()}`;
        debug('fetch-attempt', { url });

        const requestInit = await buildRequestInit(siteConfig, endpoint);
        const response = await fetch(url, requestInit);
        debug('fetch-response', { url, status: response.status, ok: response.ok });

        if (response.status === 401 || response.status === 403) {
          sawNotLoggedIn = true;
          continue;
        }

        if (!response.ok) {
          const bodySnippet = await safeReadText(response);
          debug('fetch-non-ok', { url, status: response.status, bodySnippet });
          continue;
        }

        const data = await response.json();
        debug('fetch-json', { url, keys: Object.keys(data || {}) });
        const parsed = siteConfig.parser(data, siteConfig);
        if (parsed) {
          debug('parse-success', { endpoint });
          return parsed;
        }
        debug('parse-failed', { endpoint });
      } catch (error) {
        debug('fetch-error', {
          endpoint,
          message: error?.message || String(error),
          name: error?.name || 'Error'
        });
        // Keep trying endpoint fallbacks.
      }
    }

    if (sawNotLoggedIn) {
      return {
        session: { state: 'loggedout', usedPct: 0, detail: 'not logged in', elapsedPct: null },
        weekly: { state: 'loggedout', usedPct: 0, detail: 'not logged in', elapsedPct: null }
      };
    }

    return {
      session: { state: 'error', usedPct: 0, detail: 'error', elapsedPct: null },
      weekly: { state: 'error', usedPct: 0, detail: 'error', elapsedPct: null }
    };
  }

  function parseWhamUsage(payload, siteConfig) {
    const primary = payload?.rate_limit?.primary_window;
    const secondary = payload?.rate_limit?.secondary_window;
    const sessionPct = typeof primary?.used_percent === 'number' ? primary.used_percent : null;
    const weeklyPct = typeof secondary?.used_percent === 'number' ? secondary.used_percent : null;
    const sessionReset = formatResetAt(primary?.reset_at);
    const weeklyReset = formatResetAt(secondary?.reset_at);
    const sessionElapsedPct = computeElapsedPct(primary?.reset_at, siteConfig?.windowsMs?.session);
    const weeklyElapsedPct = computeElapsedPct(secondary?.reset_at, siteConfig?.windowsMs?.weekly);

    if (sessionPct == null && weeklyPct == null) return null;

    return {
      session: {
        state: 'ok',
        usedPct: clamp(sessionPct ?? 0),
        detail: buildDetail(sessionPct, sessionReset),
        elapsedPct: sessionElapsedPct
      },
      weekly: {
        state: 'ok',
        usedPct: clamp(weeklyPct ?? 0),
        detail: buildDetail(weeklyPct, weeklyReset),
        elapsedPct: weeklyElapsedPct
      }
    };
  }

  function parseClaudeUsage(payload, siteConfig) {
    const sessionBucket = payload?.five_hour;
    const weeklyBucket = payload?.seven_day;
    const sessionPct = readClaudeUtilization(sessionBucket);
    const weeklyPct = readClaudeUtilization(weeklyBucket);
    const sessionReset = formatResetAt(sessionBucket?.resets_at);
    const weeklyReset = formatResetAt(weeklyBucket?.resets_at);
    const sessionElapsedPct = computeElapsedPct(sessionBucket?.resets_at, siteConfig?.windowsMs?.session);
    const weeklyElapsedPct = computeElapsedPct(weeklyBucket?.resets_at, siteConfig?.windowsMs?.weekly);

    if (sessionPct == null && weeklyPct == null) return null;

    return {
      session: {
        state: 'ok',
        usedPct: clamp(sessionPct ?? 0),
        detail: buildDetail(sessionPct, sessionReset),
        elapsedPct: sessionElapsedPct
      },
      weekly: {
        state: 'ok',
        usedPct: clamp(weeklyPct ?? 0),
        detail: buildDetail(weeklyPct, weeklyReset),
        elapsedPct: weeklyElapsedPct
      }
    };
  }

  function createHud(siteConfig) {
    const title = `${siteConfig.siteName} Usage HUD`;
    const links = buildHudLinks(siteConfig.siteName);
    const linksMarkup = links.length
      ? `<div class="usage-hud-links">${links
        .map((link) => `<a href="${link.href}" target="_blank" rel="noopener noreferrer">${link.label}</a>`)
        .join('')}</div>`
      : '';
    const root = document.createElement('div');
    root.id = ROOT_ID;

    root.innerHTML = `
      <div class="usage-hud-inner">
        <div class="usage-hud-main">
          <div class="usage-hud-meta">
            <div class="usage-hud-title">${title}</div>
            ${linksMarkup}
          </div>
          <div class="usage-hud-bars">
            <div class="usage-hud-row" data-kind="session">
              <div class="usage-hud-label">
                <span>Session</span>
                <span data-detail>Loading…</span>
              </div>
              <div class="usage-hud-track"><div class="usage-hud-fill"></div><div class="usage-hud-elapsed-marker" data-elapsed-marker></div></div>
            </div>
            <div class="usage-hud-row" data-kind="weekly">
              <div class="usage-hud-label">
                <span>Weekly</span>
                <span data-detail>Loading…</span>
              </div>
              <div class="usage-hud-track"><div class="usage-hud-fill"></div><div class="usage-hud-elapsed-marker" data-elapsed-marker></div></div>
            </div>
          </div>
          <button class="usage-hud-toggle" type="button" data-toggle-hud aria-label="Collapse usage HUD">−</button>
        </div>
        <div class="usage-hud-debug" data-debug>Debug pending…</div>
      </div>
    `;

    const toggle = root.querySelector('[data-toggle-hud]');
    toggle?.addEventListener('click', () => {
      const isCollapsed = root.classList.toggle('is-collapsed');
      toggle.textContent = isCollapsed ? '>>' : '−';
      toggle.setAttribute('aria-label', isCollapsed ? 'Expand usage HUD' : 'Collapse usage HUD');
      adjustPageOffset(root);
    });

    return {
      root,
      session: {
        detail: root.querySelector('[data-kind="session"] [data-detail]'),
        fill: root.querySelector('[data-kind="session"] .usage-hud-fill'),
        marker: root.querySelector('[data-kind="session"] [data-elapsed-marker]')
      },
      weekly: {
        detail: root.querySelector('[data-kind="weekly"] [data-detail]'),
        fill: root.querySelector('[data-kind="weekly"] .usage-hud-fill'),
        marker: root.querySelector('[data-kind="weekly"] [data-elapsed-marker]')
      },
      debug: root.querySelector('[data-debug]')
    };
  }

  function buildHudLinks(siteName) {
    if (siteName === 'Claude') {
      return [
        { label: 'Usage', href: 'https://claude.ai/settings/usage' },
        { label: 'Billing', href: 'https://claude.ai/settings/billing' }
      ];
    }
    if (siteName === 'ChatGPT') {
      return [
        { label: 'Usage', href: 'https://chatgpt.com/codex/cloud/settings/analytics' }
      ];
    }
    return [];
  }

  function setBars(ui, data) {
    setBar(ui.session, data.session);
    setBar(ui.weekly, data.weekly);
  }

  function setBar(target, info) {
    target.detail.textContent = info.detail;
    target.fill.style.width = `${clamp(info.usedPct)}%`;
    target.fill.classList.remove('state-error', 'state-loggedout');

    if (target.marker) {
      if (typeof info.elapsedPct === 'number') {
        target.marker.style.display = 'block';
        target.marker.style.left = `${clamp(info.elapsedPct)}%`;
      } else {
        target.marker.style.display = 'none';
      }
    }

    if (info.state === 'error') target.fill.classList.add('state-error');
    if (info.state === 'loggedout') target.fill.classList.add('state-loggedout');
  }

  function clamp(value) {
    return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  }

  function setDebug(ui, message) {
    if (!ui.debug) return;
    ui.debug.textContent = message;
  }

  function installHud(root) {
    const mount = () => {
      if (document.getElementById(ROOT_ID)) return;
      document.documentElement.prepend(root);
      adjustPageOffset(root);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }

    const ro = new ResizeObserver(() => adjustPageOffset(root));
    ro.observe(root);

    const mo = new MutationObserver(() => {
      if (!document.getElementById(ROOT_ID)) {
        mount();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function adjustPageOffset(root) {
    if (root.classList.contains('is-collapsed')) {
      document.documentElement.style.marginTop = '0px';
      return;
    }

    const h = root.getBoundingClientRect().height;
    const currentMargin = parseFloat(getComputedStyle(document.documentElement).marginTop) || 0;
    if (currentMargin < h) {
      document.documentElement.style.marginTop = `${h}px`;
    }
  }

  function debug(event, data) {
    console.log(DEBUG_PREFIX, event, data || '');
  }

  async function buildRequestInit(siteConfig, endpoint) {
    const headers = { accept: 'application/json' };

    if (siteConfig.siteName === 'ChatGPT' && endpoint === '/backend-api/wham/usage') {
      headers['OAI-Language'] = navigator.language || 'en-US';
      headers['X-OpenAI-Target-Path'] = '/backend-api/wham/usage';
      headers['X-OpenAI-Target-Route'] = '/backend-api/wham/usage';
      const sniffedHeaders = await getChatGPTWhamHeaders();
      Object.assign(headers, sniffedHeaders);
    }

    return {
      method: 'GET',
      credentials: 'include',
      headers
    };
  }

  async function getChatGPTWhamHeaders() {
    const now = Date.now();
    if (chatgptHeaderCache.headers && now - chatgptHeaderCache.cachedAt < 10_000) {
      return chatgptHeaderCache.headers;
    }

    if (typeof browser === 'undefined' || !browser.runtime?.sendMessage) {
      return {};
    }

    try {
      const response = await browser.runtime.sendMessage({ type: 'usage-hud-get-wham-headers' });
      const payload = response?.payload || {};
      const headers = {};
      if (payload.authorization) headers.Authorization = payload.authorization;
      if (payload.oai_device_id) headers['OAI-Device-Id'] = payload.oai_device_id;
      if (payload.oai_client_version) headers['OAI-Client-Version'] = payload.oai_client_version;
      if (payload.oai_client_build_number) headers['OAI-Client-Build-Number'] = payload.oai_client_build_number;
      if (payload.oai_session_id) headers['OAI-Session-Id'] = payload.oai_session_id;

      chatgptHeaderCache = { headers, cachedAt: now };
      debug('wham-headers-loaded', {
        hasAuthorization: Boolean(headers.Authorization),
        hasDeviceId: Boolean(headers['OAI-Device-Id']),
        hasClientVersion: Boolean(headers['OAI-Client-Version']),
        hasClientBuild: Boolean(headers['OAI-Client-Build-Number']),
        hasSessionId: Boolean(headers['OAI-Session-Id'])
      });
      return headers;
    } catch (error) {
      debug('wham-headers-load-error', { message: error?.message || String(error) });
      return {};
    }
  }

  function resolveEndpoints(siteConfig) {
    if (typeof siteConfig.getEndpoints === 'function') {
      return siteConfig.getEndpoints();
    }
    return siteConfig.endpoints || [];
  }

  function buildClaudeEndpoints() {
    const orgId =
      readCookie('lastActiveOrg') ||
      safeStorageGet('lastActiveOrg');

    if (orgId && /^[0-9a-f-]{36}$/i.test(orgId)) {
      return [`/api/organizations/${orgId}/usage`];
    }

    return [];
  }

  function readCookie(name) {
    const cookie = document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${name}=`));
    if (!cookie) return null;
    return decodeURIComponent(cookie.slice(name.length + 1));
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function readClaudeUtilization(bucket) {
    if (!bucket || typeof bucket !== 'object') return null;
    return typeof bucket.utilization === 'number' ? bucket.utilization : null;
  }

  function buildDetail(percent, resetLabel) {
    const prefix = `${Math.round(clamp(percent ?? 0))}% used`;
    if (!resetLabel) return prefix;
    return `${prefix} • resets at: ${resetLabel}`;
  }

  function formatResetAt(rawTs) {
    if (rawTs == null) return null;
    const date =
      typeof rawTs === 'number'
        ? new Date(rawTs * 1000)
        : new Date(rawTs);
    if (!Number.isFinite(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(date)
      .replace(',', '')
      .replace(/\s([AP]M)$/i, (_, meridiem) => meridiem.toLowerCase());
  }

  function computeElapsedPct(resetAtRaw, durationMs) {
    const resetAtMs = parseTimestampToMs(resetAtRaw);
    if (!Number.isFinite(resetAtMs) || !Number.isFinite(durationMs) || durationMs <= 0) return null;

    const remainingMs = Math.max(0, resetAtMs - Date.now());
    const elapsedRatio = 1 - (remainingMs / durationMs);
    return clamp(elapsedRatio * 100);
  }

  function parseTimestampToMs(rawTs) {
    if (rawTs == null) return null;
    const date = typeof rawTs === 'number' ? new Date(rawTs * 1000) : new Date(rawTs);
    const tsMs = date.getTime();
    return Number.isFinite(tsMs) ? tsMs : null;
  }

  async function safeReadText(response) {
    try {
      const text = await response.text();
      return (text || '').replace(/\s+/g, ' ').slice(0, 160);
    } catch {
      return '<unreadable>';
    }
  }

  function installBackgroundSnifferListener() {
    if (typeof browser === 'undefined' || !browser.runtime?.onMessage) return;
    debug('wham-sniffer-listener', { state: 'attached' });
    browser.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'usage-hud-wham-sniff') return;
      debug('sniff-wham-headers', message.payload || {});
    });
    debug('wham-sniffer-installed', { mode: 'webRequest-background' });
  }
})();
