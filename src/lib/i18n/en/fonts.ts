/** The font library card (Settings → Fonts, Workspace → Fonts). */
export const fonts = {
  title: 'Fonts',
  descriptionWorkspace: 'Brand fonts for every canvas in this workspace.',
  descriptionPersonal: 'Your own fonts, for the canvases in your personal space.',
  descriptionRest:
    'They show up in the Design panel’s font menu, and agents designing on those canvases are told to use them. A frame that uses one carries the font with it, so screenshots and exports render it too.',
  upload: 'Upload',
  uploadButton: 'Upload fonts',
  uploading: 'Uploading…',
  chooseFiles: 'Choose font files',
  loading: 'Loading…',
  emptyTitle: 'No fonts yet',
  emptyPersonal:
    'Upload your font files, or drop them on this card, and they show up in the Design panel’s font menu on your personal canvases. TTF, OTF, WOFF and WOFF2 files up to 10 MB each, one style per file.',
  emptyWorkspace:
    'Upload your brand’s font files, or drop them on this card, and everyone in the workspace gets them in the Design panel’s font menu. TTF, OTF, WOFF and WOFF2 files up to 10 MB each, one style per file.',
  fileRules: 'TTF, OTF, WOFF or WOFF2, up to 10 MB each',
  dropNotFonts: 'Only TTF, OTF, WOFF and WOFF2 files can be added here.',
  families: { one: '{count} family', other: '{count} families' },
  files: { one: '{count} file', other: '{count} files' },
  summary: '{families}, {files}',
  preview: 'The quick brown fox jumps over the lazy dog',
  removeFace: 'Remove {family} {face}',
  removeTitle: 'Remove {family} {face}?',
  removeDescription:
    'It leaves the font menu and agents stop being offered it. Frames that already use it keep rendering it.',
  removeFamily: 'Remove family',
  removeFamilyTitle: { one: 'Remove {family}?', other: 'Remove {family} and its {count} styles?' },
  removeFamilyDescription:
    'Every style of it leaves the font menu and agents stop being offered it. Frames that already use it keep rendering it.',
  remove: 'Remove',
  loadFailed: 'The font library could not be loaded',
  uploadFailed: 'upload failed',
  tooLarge: '{name} is over the 10 MB limit',
  removeFailed: 'That font could not be removed',
} as const
