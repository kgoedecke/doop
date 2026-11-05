# Chrome Web Store listing draft

Name: Doop Cature

Summary: Capture a page or section as editable HTML and paste it into Doop.

## Description

Bring a website into your design workflow with Doop Cature.

Select a section or capture the currently loaded page, copy the result, and paste it into a Doop canvas as an editable HTML frame. Keep the text, layout, and computed styles as a starting point for your next design.

HOW TO USE

1. Open a website and click Doop Cature in your toolbar.
2. Choose Select a section or Capture entire page.
3. Click Copy to Doop in the capture toolbar.
4. Open an editable Doop canvas and paste.

Captures are processed locally in your browser. The extension copies captured HTML to your clipboard; pasting into Doop saves it through your Doop account. Images can remain linked to their original websites.

Requires access to an editable Doop canvas. Capture fidelity varies by website. Scroll to load lazy content before capturing. Embedded frames, shadow DOM, canvas graphics, custom fonts, and virtualized offscreen content are not fully supported. Captures over 3 MB require selecting a smaller section. Chrome internal pages and Chrome Web Store pages cannot be captured.

## Single purpose

Capture user-selected website content as editable HTML for import into Doop.

## Permission justifications

- activeTab: Access only the tab where the user explicitly starts a capture, to read rendered page content and styles.
- scripting: Inject the section picker and HTML capture code into that tab after the user clicks a capture button.
- clipboardWrite: Copy the capture to the clipboard when the user clicks Copy to Doop, so it can be pasted into a Doop canvas.

Remote code: No. Executable extension code is bundled in the uploaded package.

## Release items still to verify

- Verify production Doop includes the capture paste handler.
- Complete end-to-end Chrome capture/copy/paste and undo testing.
- Upload genuine screenshots of the extension and imported result.
- Provide verified support contact and a publicly hosted privacy policy describing capture, clipboard transfer, remote asset loading, and Doop storage after paste.
- Complete dashboard privacy declarations based on the current implementation; do not assume local processing means no user-data handling.
- Confirm distribution and account details in the developer dashboard.
