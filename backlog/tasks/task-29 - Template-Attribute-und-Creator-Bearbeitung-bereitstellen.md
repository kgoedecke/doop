---
id: TASK-29
title: Template-Attribute und Creator-Bearbeitung bereitstellen
status: Done
assignee: []
created_date: '2026-10-23T09:51:00Z'
updated_date: '2026-11-02T10:23:00Z'
labels:
  - prowin
  - implementation
milestone: m-4
dependencies:
  - TASK-14
  - TASK-23
documentation:
  - docs/prowin/doop-fork-umsetzung.md
  - docs/prowin/bezugsdokumente-referenz.md
priority: medium
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Creator benötigen stabile, semantische HTML-Felder, damit dieselbe Vorlage später sicher durch Beraterinnen personalisiert werden kann.

Quellen: Umsetzung §§ 9.1, 9.3; Referenz R1.3–R1.4
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 data-od-id, role, label, locked, max-length und allowed-colors sind dokumentiert und vom Creator bearbeitbar.
- [x] #2 IDs sind innerhalb eines Frames eindeutig und bleiben bei Bearbeitung stabil; beim Duplizieren entstehen konfliktfreie IDs.
- [x] #3 Nur berechtigte Rollen ändern Sperren und Constraints; optionale font/size-Locks werden nicht als beschlossen vorausgesetzt.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Shared Attributmodell + Validierung + Doku
2. Creator-Feld-UI + ID-Stabilität/Duplikate (Client)
3. Schmale Server-Metadatenprüfung in updateFrame
4. Reviews pro Task + Whole-Branch-Review
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Council 30.10.2026 (Claude Opus, GPT-6.1 Sol, Muse Wonder, je high): agree-with-changes. Enge Server-Metadatenpruefung in TASK-29, voller Guard bleibt TASK-30, Beraterinnen-Sichtbarkeit TASK-31. Ruling Controller: data-od-id nur explizit umbenennbar (validiert), nie implizit; Tokenformat ohne --, z. B. prowin-ci-blau; max-length >= 1, leer = ungesetzt.

Implementierung 30.10.2026: Shared Attributmodell, Creator-Feld-UI im ElementPanel (manageLocks), schmale Server-Metadatenpruefung in actions.updateFrame (403/400), ID-Remint bei Element-Duplikat/Drawing-Transfer. Council einstimmig agree-with-changes. Gesamtsuite: 185 Dateien / 1496 Tests PASS, Typecheck PASS. Branch task/29-template-attributes, HEAD 705e477. ACs anhand Tests geprueft; Done erst nach Nutzerabnahme. Rest: TASK-30 voller Guard, TASK-31 Beraterinnen-Sicht.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Stelle Template-Felder fuer Creator bereit

- Dokumentiere und validiere die sechs Template-Attribute.
- Erhalte stabile, frame-eindeutige IDs und vergebe konfliktfreie Kopien.
- Beschraenke Sperren und Constraints auf berechtigte Creator.
- Schliesse nach ausdruecklicher Nutzerbestaetigung vom 02.11.2026.
<!-- SECTION:FINAL_SUMMARY:END -->
