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
  addLocal: 'Add from this computer',
  addLocalTitle: { one: 'Add {name} to this library?', other: 'Add {count} fonts from this computer?' },
  addLocalDescription:
    'Everyone this library serves gets the font, and frames that use it carry it into screenshots and exports. Fonts installed with your operating system or bought for one machine are often licensed for your use only; check the font’s licence before sharing it here. Doop does not check licences for you.',
  addLocalConfirm: 'Add fonts',
  localSkipped: {
    one: '{names} is not a single font file (TTF, OTF, WOFF or WOFF2) and was left out.',
    other: '{names} are not single font files (TTF, OTF, WOFF or WOFF2) and were left out.',
  },
  localTooLarge: {
    one: '{names} is over the 10 MB limit and was left out.',
    other: '{names} are over the 10 MB limit and were left out.',
  },
  localReadFailed: '{name} could not be read from this computer',
} as const
