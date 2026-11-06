/* doop.design's own pages: the marketing site and its download page.
   Absolute on purpose: a self-hosted server has no marketing site, and the
   desktop installers are the same whichever server they connect to. */
export const DOWNLOAD_URL = 'https://doop.design/download'
/* `?site` makes the server answer `/` with the website even for a signed-in
   visitor, who would otherwise land back on the dashboard (server/marketing.ts) */
export const WEBSITE_URL = 'https://doop.design/?site'
