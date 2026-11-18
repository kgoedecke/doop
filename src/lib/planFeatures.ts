import { FREE_FONT_FAMILIES, FREE_UPLOAD_BYTES, PRO_UPLOAD_BYTES, type PlanId } from '../../shared/billing'
import type { PlainMessageKey } from './i18n'

/**
 * What each plan offers, as the upgrade modal shows it: a short list per
 * card and the full comparison behind "Compare all features". Copy lives
 * in the `plans` catalog (and `hosted`, for the hosted-only imports and
 * exports); this file says which line goes where and what each plan gets.
 */

/** "5 MB": the upload limits are whole megabytes. */
export function formatMegabytes(bytes: number): string {
  return `${bytes / 1024 / 1024} MB`
}

/** A line on a plan's card. `uploads` takes the Pro limit as {size}. */
export type Highlight = { key: PlainMessageKey; soon?: boolean } | { uploads: number }

export const HIGHLIGHTS: Record<PlanId, readonly Highlight[]> = {
  free: [
    { key: 'plans.freeCanvases' },
    { key: 'plans.freeMcp' },
    { key: 'plans.freeAgents' },
    { key: 'plans.freeImport' },
    { key: 'plans.freeExport' },
    { key: 'plans.freeDesign' },
    { key: 'plans.freeAutomations' },
  ],
  team: [
    { key: 'plans.proWorkspace' },
    { key: 'plans.proLibrary' },
    { key: 'plans.proFonts' },
    { uploads: PRO_UPLOAD_BYTES },
    { key: 'plans.proApiKeys', soon: true },
    { key: 'plans.proSupport' },
  ],
  enterprise: [{ key: 'plans.enterpriseSso' }, { key: 'plans.enterpriseHosting' }, { key: 'plans.enterpriseTerms' }],
}

/** One plan's answer in a comparison row. */
export type Cell = boolean | 'soon' | 'unlimited' | { bytes: number } | { families: number }

export interface ComparisonRow {
  label: PlainMessageKey
  cells: Record<PlanId, Cell>
}

export interface ComparisonGroup {
  label: PlainMessageKey
  rows: readonly ComparisonRow[]
}

const everyone = { free: true, team: true, enterprise: true } as const
const paid = { free: false, team: true, enterprise: true } as const
const enterpriseOnly = { free: false, team: false, enterprise: true } as const

export const COMPARISON: readonly ComparisonGroup[] = [
  {
    label: 'plans.groupDesign',
    rows: [
      { label: 'plans.rowCanvases', cells: { free: 'unlimited', team: 'unlimited', enterprise: 'unlimited' } },
      { label: 'plans.rowComponents', cells: everyone },
      { label: 'plans.rowPrototypes', cells: everyone },
      { label: 'plans.rowReadyForDev', cells: everyone },
      { label: 'plans.rowMedia', cells: everyone },
      {
        label: 'plans.rowUploads',
        cells: {
          free: { bytes: FREE_UPLOAD_BYTES },
          team: { bytes: PRO_UPLOAD_BYTES },
          enterprise: { bytes: PRO_UPLOAD_BYTES },
        },
      },
      {
        label: 'plans.rowFonts',
        cells: { free: { families: FREE_FONT_FAMILIES }, team: 'unlimited', enterprise: 'unlimited' },
      },
    ],
  },
  {
    label: 'plans.groupAgents',
    rows: [
      { label: 'plans.rowMcp', cells: everyone },
      { label: 'plans.rowByoAgent', cells: everyone },
      { label: 'plans.rowDoopAgent', cells: everyone },
      { label: 'plans.rowAutomations', cells: everyone },
      { label: 'plans.rowApiKeys', cells: { free: false, team: 'soon', enterprise: 'soon' } },
    ],
  },
  {
    label: 'plans.groupImportExport',
    rows: [
      { label: 'plans.rowImportWeb', cells: everyone },
      { label: 'plans.rowExportFiles', cells: everyone },
    ],
  },
  {
    label: 'plans.groupCollaboration',
    rows: [
      { label: 'plans.rowMultiplayer', cells: everyone },
      { label: 'plans.rowSharing', cells: everyone },
      { label: 'plans.rowIntegrations', cells: everyone },
      { label: 'plans.rowApps', cells: everyone },
    ],
  },
  {
    label: 'plans.groupTeam',
    rows: [
      { label: 'plans.rowWorkspace', cells: paid },
      { label: 'plans.rowLibrary', cells: paid },
      { label: 'plans.rowRoles', cells: paid },
      { label: 'plans.rowBilling', cells: paid },
    ],
  },
  {
    label: 'plans.groupSupport',
    rows: [
      { label: 'plans.rowDocs', cells: everyone },
      { label: 'plans.rowPriority', cells: paid },
      { label: 'plans.rowSso', cells: enterpriseOnly },
      { label: 'plans.rowHosting', cells: enterpriseOnly },
    ],
  },
]
