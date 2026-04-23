const DEBUG_PREFIX = '[usage-hud-bg]';
let latestWhamHeaders = null;
console.log(DEBUG_PREFIX, 'background-start');

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const normalized = new Map(
      (details.requestHeaders || []).map((h) => [h.name.toLowerCase(), h.value || ''])
    );

    const auth = normalized.get('authorization') || '';
    const candidateHeaders = {
      authorization: auth || null,
      oai_device_id: normalized.get('oai-device-id') || null,
      oai_client_version: normalized.get('oai-client-version') || null,
      oai_client_build_number: normalized.get('oai-client-build-number') || null,
      oai_session_id: normalized.get('oai-session-id') || null
    };
    const hasUsefulAuthHeaders = Boolean(
      candidateHeaders.authorization ||
      candidateHeaders.oai_device_id ||
      candidateHeaders.oai_client_version ||
      candidateHeaders.oai_client_build_number ||
      candidateHeaders.oai_session_id
    );
    if (hasUsefulAuthHeaders) {
      latestWhamHeaders = { ...(latestWhamHeaders || {}), ...candidateHeaders };
    }

    const payload = {
      source: 'webRequest',
      url: details.url,
      method: details.method,
      tabId: details.tabId,
      authorization_preview: auth ? `${auth.slice(0, 24)}…` : null,
      authorization_length: auth.length || 0,
      oai_device_id: normalized.get('oai-device-id') || null,
      oai_client_version: normalized.get('oai-client-version') || null,
      oai_client_build_number: normalized.get('oai-client-build-number') || null,
      oai_session_id: normalized.get('oai-session-id') || null,
      x_openai_target_path: normalized.get('x-openai-target-path') || null,
      x_openai_target_route: normalized.get('x-openai-target-route') || null
    };

    console.log(DEBUG_PREFIX, 'wham-headers', payload);

    if (typeof details.tabId === 'number' && details.tabId >= 0) {
      browser.tabs.sendMessage(details.tabId, {
        type: 'usage-hud-wham-sniff',
        payload
      }).catch(() => {});
      return;
    }

    browser.tabs.query({ url: 'https://chatgpt.com/*' }).then((tabs) => {
      tabs.forEach((tab) => {
        if (typeof tab.id !== 'number') return;
        browser.tabs.sendMessage(tab.id, {
          type: 'usage-hud-wham-sniff',
          payload
        }).catch(() => {});
      });
    }).catch(() => {});
  },
  { urls: ['https://chatgpt.com/backend-api/*'] },
  ['requestHeaders']
);

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'usage-hud-get-wham-headers') return undefined;
  return Promise.resolve({ payload: latestWhamHeaders || {} });
});
