'use strict';

const Store = require('electron-store');

/**
 * Local persisted settings. The Anthropic API key lives here (on the user's
 * machine only) and is never bundled or committed.
 */
const store = new Store({
  name: 'ttn-splitter-settings',
  defaults: {
    apiKey: '',
    model: 'claude-opus-4-8',
    useAiFallback: true,
    // Confidence at/below which we escalate to the AI fallback.
    aiOnConfidence: 'low', // 'low' | 'medium' | 'never'
    lastOutputDir: '',
  },
});

function getSettings() {
  return {
    apiKey: store.get('apiKey'),
    model: store.get('model'),
    useAiFallback: store.get('useAiFallback'),
    aiOnConfidence: store.get('aiOnConfidence'),
    lastOutputDir: store.get('lastOutputDir'),
  };
}

function setSettings(partial) {
  for (const [k, v] of Object.entries(partial || {})) {
    store.set(k, v);
  }
  return getSettings();
}

module.exports = { getSettings, setSettings };
