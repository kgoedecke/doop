# Doop Cature

Load this directory in Chrome at `chrome://extensions` → Developer mode → Load unpacked. No build or API key required.

1. Open the website you want to capture and click Doop Cature.
2. Choose **Capture entire page** or **Select a section**, then click an element on the page. Escape cancels selection.
3. Click **Copy to Doop** in the page banner.
4. Open an editable Doop canvas and paste. The capture becomes an editable HTML frame, centered in the viewport, with undo support.

Captures run locally and use only temporary access to the active tab. The extension does not send data to a server. Pasting into Doop saves the HTML using your existing signed-in session. Review sensitive page content before sharing a canvas. Form values are excluded.

This initial version snapshots the currently loaded DOM and computed styles. Scroll through lazy-loaded pages before capturing. External images and CSS image URLs remain remote references; offline assets, web fonts, generated pseudo-elements, shadow DOM, canvas pixels, embedded frames, and virtualized offscreen content are not preserved. Very large captures are rejected with a smaller-section suggestion. Chrome internal pages and the Chrome Web Store cannot be injected into. Browser layout fidelity varies, especially for fixed elements and isolated sections whose layout depends on ancestors.

The extension is ready for unpacked development installation. Production deployment of the paste handler, store publication, and broad cross-site visual QA remain release work.
