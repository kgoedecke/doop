if (!navigator.platform.includes('Mac')) document.getElementById('paste-key').textContent = 'Ctrl V'
for (const mode of ['section', 'page']) {
  document.getElementById(mode).addEventListener('click', async () => {
    const status = document.getElementById('status')
    const buttons = document.querySelectorAll('button')
    buttons.forEach((button) => {
      button.disabled = true
    })
    status.dataset.error = 'false'
    status.textContent = 'Opening capture…'
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id || !/^https?:/.test(tab.url || ''))
        throw new Error('Open a regular website first. Chrome internal pages cannot be captured.')
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] })
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (mode) => window.__doopCapture(mode),
        args: [mode],
      })
      window.close()
    } catch (error) {
      status.dataset.error = 'true'
      status.textContent = error.message
      buttons.forEach((button) => {
        button.disabled = false
      })
    }
  })
}
